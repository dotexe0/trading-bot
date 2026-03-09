/**
 * Tests for PerpPositionManager.
 *
 * IntxClient and PerpStateStore are fully mocked — no real DB or network calls.
 * Tests validate:
 *  1. openPosition() — persistOrder before placeOrder, logs liq price, emits positionOpened, createSession called with full PerpSession
 *  2. closePosition() — placeOrder with closeOnly:true and flipped side, emits positionClosed, currentSession becomes null
 *  3. Emergency close trigger — liq distance < threshold emits emergencyClose event
 *  4. Guard: openPosition() throws when session already open
 *  5. Guard: closePosition() throws when no session open
 *  6. start() liquidation distance event — above threshold emits liquidationDistance, no emergency close
 *  7. stop() — removes bound markPrice listener, events after stop don't trigger handler
 *  8. Emergency close flag reset — _emergencyCloseInProgress is false after successful close
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PerpPositionManager } from '../position-manager.js';
import type { IntxClient } from '../intx-client.js';
import type { PerpStateStore } from '../perp-state-store.js';
import type { IntxConfig } from '../config.js';
import type { IntxMarkPriceEvent } from '../types.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<IntxConfig> = {}): IntxConfig {
  return {
    enabled: true,
    apiKey: 'key',
    apiSecret: 'secret',
    apiPassphrase: 'pass',
    portfolioId: 'port-1',
    testnet: false,
    liquidationSafetyThresholdPct: 5.0,
    defaultMaintenanceMarginRate: '0.0333',
    ...overrides,
  };
}

function makeIntxClient(): IntxClient {
  const emitter = new EventEmitter();
  const mockPlaceOrder = vi.fn().mockResolvedValue({
    orderId: 'exchange-order-1',
    status: 'FILLED',
    execQty: '0.1',
    avgPrice: '50000',
    fee: '0.5',
  });
  const mockCancelOrder = vi.fn().mockResolvedValue(undefined);
  return Object.assign(emitter, {
    placeOrder: mockPlaceOrder,
    cancelOrder: mockCancelOrder,
  }) as unknown as IntxClient;
}

function makeStateStore(): PerpStateStore {
  return {
    createSession: vi.fn(),
    getOpenSession: vi.fn().mockReturnValue(null),
    updateSession: vi.fn(),
    persistOrder: vi.fn(),
    getOrderByClientId: vi.fn().mockReturnValue(null),
    getPendingOrders: vi.fn().mockReturnValue([]),
    close: vi.fn(),
  } as unknown as PerpStateStore;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('PerpPositionManager', () => {
  let intxClient: IntxClient & EventEmitter & { placeOrder: ReturnType<typeof vi.fn>; cancelOrder: ReturnType<typeof vi.fn> };
  let stateStore: PerpStateStore & { createSession: ReturnType<typeof vi.fn>; persistOrder: ReturnType<typeof vi.fn>; updateSession: ReturnType<typeof vi.fn> };
  let manager: PerpPositionManager;
  let config: IntxConfig;

  beforeEach(() => {
    intxClient = makeIntxClient() as any;
    stateStore = makeStateStore() as any;
    config = makeConfig();
    manager = new PerpPositionManager({ intxClient, stateStore, config });
  });

  // ── Test 1: openPosition ───────────────────────────────────────────
  describe('openPosition()', () => {
    it('calls persistOrder BEFORE placeOrder and creates session with correct fields', async () => {
      const callOrder: string[] = [];
      (stateStore.persistOrder as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callOrder.push('persistOrder');
      });
      (intxClient.placeOrder as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        callOrder.push('placeOrder');
        return { orderId: 'ex-1', status: 'FILLED', execQty: '0.1', avgPrice: '50000', fee: '0.5' };
      });

      const positionOpened = vi.fn();
      manager.on('positionOpened', positionOpened);

      const session = await manager.openPosition({
        instrument: 'BTC-PERP',
        direction: 'long',
        size: '0.1',
        leverage: 10,
        entryPrice: '50000',
      });

      // persistOrder must be called first (at least once before placeOrder)
      const firstPersist = callOrder.indexOf('persistOrder');
      const firstPlace = callOrder.indexOf('placeOrder');
      expect(firstPersist).toBeLessThan(firstPlace);

      // placeOrder called without closeOnly
      expect(intxClient.placeOrder).toHaveBeenCalledWith(
        expect.objectContaining({ instrument: 'BTC-PERP', side: 'BUY', orderType: 'MARKET' }),
      );
      expect(intxClient.placeOrder).not.toHaveBeenCalledWith(
        expect.objectContaining({ closeOnly: true }),
      );

      // positionOpened emitted
      expect(positionOpened).toHaveBeenCalledOnce();

      // session returned with liquidationPrice
      expect(session.liquidationPrice).toBeDefined();
      expect(parseFloat(session.liquidationPrice)).toBeCloseTo(46665, 0);

      // createSession called with full PerpSession
      expect(stateStore.createSession).toHaveBeenCalledOnce();
      const passedSession = (stateStore.createSession as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(passedSession).toMatchObject({
        id: expect.any(String),
        openedAt: expect.any(Number),
        status: 'open',
        instrument: 'BTC-PERP',
        direction: 'long',
      });
    });

    it('throws when a position is already open', async () => {
      // Open first position
      await manager.openPosition({
        instrument: 'BTC-PERP',
        direction: 'long',
        size: '0.1',
        leverage: 10,
        entryPrice: '50000',
      });

      // Attempt to open second
      await expect(
        manager.openPosition({
          instrument: 'BTC-PERP',
          direction: 'short',
          size: '0.1',
          leverage: 10,
          entryPrice: '50000',
        }),
      ).rejects.toThrow('Position already open for this instrument');
    });
  });

  // ── Test 2: closePosition ──────────────────────────────────────────
  describe('closePosition()', () => {
    it('sends closeOnly:true with flipped side, emits positionClosed, currentSession becomes null', async () => {
      // Open first
      await manager.openPosition({
        instrument: 'BTC-PERP',
        direction: 'long',
        size: '0.1',
        leverage: 10,
        entryPrice: '50000',
      });
      (intxClient.placeOrder as ReturnType<typeof vi.fn>).mockResolvedValue({
        orderId: 'close-ex-1',
        status: 'FILLED',
        execQty: '0.1',
        avgPrice: '51000',
        fee: '0.5',
      });

      const positionClosed = vi.fn();
      manager.on('positionClosed', positionClosed);

      const closed = await manager.closePosition();

      // placeOrder called with closeOnly:true and SELL (flipped from long BUY)
      expect(intxClient.placeOrder).toHaveBeenLastCalledWith(
        expect.objectContaining({ closeOnly: true, side: 'SELL' }),
      );

      // positionClosed emitted
      expect(positionClosed).toHaveBeenCalledOnce();

      // currentSession is null
      expect(manager.getCurrentSession()).toBeNull();
      expect(manager.isPositionOpen()).toBe(false);

      // returned closed session
      expect(closed.status).toBe('closed');
    });

    it('throws when no position is open', async () => {
      await expect(manager.closePosition()).rejects.toThrow('No open position to close');
    });
  });

  // ── Test 3: Emergency close trigger ───────────────────────────────
  describe('emergency close', () => {
    it('emits emergencyClose and closes position when distance < threshold', async () => {
      const emergencyConfig = makeConfig({ liquidationSafetyThresholdPct: 10 });
      const localManager = new PerpPositionManager({
        intxClient,
        stateStore,
        config: emergencyConfig,
      });
      localManager.start();

      await localManager.openPosition({
        instrument: 'BTC-PERP',
        direction: 'long',
        size: '0.1',
        leverage: 10,
        entryPrice: '50000',
      });

      // liqPrice ≈ 46665 for long 10x, 0.0333 MMR
      // Mark price at 47000 → distance = (47000 - 46665) / 47000 * 100 ≈ 0.71% < 10% threshold
      const emergencyCloseFn = vi.fn();
      localManager.on('emergencyClose', emergencyCloseFn);

      const markPriceEvt: IntxMarkPriceEvent = {
        instrument: 'BTC-PERP',
        markPrice: '47000',
        indexPrice: '47000',
        timestamp: Date.now(),
        isStale: false,
      };
      intxClient.emit('markPrice', markPriceEvt);

      // Wait for async emergency close
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(emergencyCloseFn).toHaveBeenCalledOnce();
      localManager.stop();
    });
  });

  // ── Test 6: Liquidation distance event above threshold ─────────────
  describe('start() / liquidation distance event', () => {
    it('emits liquidationDistance without triggering emergency close when above threshold', async () => {
      manager.start();

      await manager.openPosition({
        instrument: 'BTC-PERP',
        direction: 'long',
        size: '0.1',
        leverage: 10,
        entryPrice: '50000',
      });

      // mark at 50000 → distance well above 5% threshold
      const distEvent = vi.fn();
      manager.on('liquidationDistance', distEvent);
      const emergencyCloseFn = vi.fn();
      manager.on('emergencyClose', emergencyCloseFn);

      const evt: IntxMarkPriceEvent = {
        instrument: 'BTC-PERP',
        markPrice: '50000',
        indexPrice: '50000',
        timestamp: Date.now(),
        isStale: false,
      };
      intxClient.emit('markPrice', evt);

      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(distEvent).toHaveBeenCalledOnce();
      expect(emergencyCloseFn).not.toHaveBeenCalled();
      manager.stop();
    });
  });

  // ── Test 7: stop() removes bound listener ─────────────────────────
  describe('stop()', () => {
    it('removes the bound markPrice listener so events after stop do not trigger handler', async () => {
      manager.start();

      await manager.openPosition({
        instrument: 'BTC-PERP',
        direction: 'long',
        size: '0.1',
        leverage: 10,
        entryPrice: '50000',
      });

      const distEvent = vi.fn();
      manager.on('liquidationDistance', distEvent);

      manager.stop();

      // Emit markPrice after stop — should not trigger
      const evt: IntxMarkPriceEvent = {
        instrument: 'BTC-PERP',
        markPrice: '50000',
        indexPrice: '50000',
        timestamp: Date.now(),
        isStale: false,
      };
      intxClient.emit('markPrice', evt);

      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(distEvent).not.toHaveBeenCalled();
    });
  });

  // ── Test 8: Emergency close flag reset ────────────────────────────
  describe('_emergencyCloseInProgress flag reset', () => {
    it('resets _emergencyCloseInProgress to false after successful emergency close', async () => {
      const emergencyConfig = makeConfig({ liquidationSafetyThresholdPct: 10 });
      const localManager = new PerpPositionManager({
        intxClient,
        stateStore,
        config: emergencyConfig,
      });
      localManager.start();

      await localManager.openPosition({
        instrument: 'BTC-PERP',
        direction: 'long',
        size: '0.1',
        leverage: 10,
        entryPrice: '50000',
      });

      const evt: IntxMarkPriceEvent = {
        instrument: 'BTC-PERP',
        markPrice: '47000',
        indexPrice: '47000',
        timestamp: Date.now(),
        isStale: false,
      };
      intxClient.emit('markPrice', evt);

      // Wait for the async emergency close to complete
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Flag must be reset to false
      expect((localManager as any)._emergencyCloseInProgress).toBe(false);

      localManager.stop();
    });
  });
});
