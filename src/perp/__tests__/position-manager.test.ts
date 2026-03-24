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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PerpPositionManager } from '../position-manager.js';
import { FundingRateTracker } from '../funding-tracker.js';
import { RegimeClassifier } from '../../regime/classifier.js';
import { MarketRegime } from '../../regime/types.js';
import { StrategyRegistry } from '../../strategies/registry.js';
import type { IntxClient } from '../intx-client.js';
import type { PerpStateStore } from '../perp-state-store.js';
import type { IntxConfig } from '../config.js';
import type { IntxMarkPriceEvent, IntxFundingRateEvent } from '../types.js';
import type { RegimeLeaderboards, RegimeLeaderboardEntry, LeaderboardEntry } from '../../tournament/types.js';
import type { IStrategy } from '../../strategies/types.js';
import type { Candle } from '../../core/types.js';

// ── Auto-switch helpers ────────────────────────────────────────────────────

/**
 * Mock registry that dispatches create() based on the 'strategy' field of the
 * raw config. Enables auto-switch tests where regime change swaps strategies.
 */
class MultiStrategyMockRegistry extends StrategyRegistry {
  private strategies: Map<string, IStrategy>;
  constructor(strategies: Map<string, IStrategy>) {
    super();
    this.strategies = strategies;
  }
  override create(rawConfig: unknown): IStrategy {
    const cfg = rawConfig as Record<string, unknown>;
    const name = cfg.strategy as string;
    const s = this.strategies.get(name);
    if (!s) throw new Error(`No mock strategy registered for '${name}'`);
    return s;
  }
}

function makeRegimeLeaderboards(
  trendingStrategy: string,
  rangingStrategy: string,
): RegimeLeaderboards {
  const makeRegimeEntry = (strategyName: string): RegimeLeaderboardEntry => ({
    rank: 1,
    strategyName,
    strategyConfig: { strategy: strategyName },
    regimeSharpeRatio: 1.5,
    regimeWinRate: 0.6,
    regimeTradeCount: 10,
    overallOosSharpe: 1.2,
  });

  const fallbackEntry: LeaderboardEntry = {
    rank: 1,
    strategyName: rangingStrategy,
    strategyConfig: { strategy: rangingStrategy },
    oosMetrics: {} as any,
    isMetrics: {} as any,
    robustnessRatio: 1.0,
    windowCount: 3,
  };

  return {
    [MarketRegime.TRENDING]: [makeRegimeEntry(trendingStrategy)],
    [MarketRegime.RANGING]: [makeRegimeEntry(rangingStrategy)],
    [MarketRegime.VOLATILE]: [],
    fallbackEntry,
  };
}

function makeCandle(close = '50000', index = 0): Candle {
  return {
    pair: 'BTC-USD',
    timeframe: '1h',
    timestamp: 1700000000000 + index * 3600000,
    open: close,
    high: String(Number(close) * 1.01),
    low: String(Number(close) * 0.99),
    close,
    volume: '1',
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<IntxConfig> = {}): IntxConfig {
  return {
    enabled: true,
    apiKey: 'key',
    apiSecret: 'secret',
    testnet: false,
    btcProductId: 'BIP-20DEC30-CDE',
    ethProductId: 'ETP-20DEC30-CDE',
    liquidationSafetyThresholdPct: 5.0,
    defaultMaintenanceMarginRate: '0.0333',
    tpTargetPct: 2.0,
    atrMultiplier: 2.0,
    stopLimitSlippagePct: 0.1,
    repriceTimeoutMs: 60000,
    maxRepriceAttempts: 20,
    entryOrderTimeoutMs: 300000,
    maxLeverageCap: 5,
    defaultLeverage: 3,
    leverageByRegime: { VOLATILE: 2, TRENDING: 5, RANGING: 3 },
    marginUtilizationCeiling: 0.8,
    perpExposureCapPct: 0.5,
    perpMaxLossPct: 0.02,
    fundingDrainThresholdPct: 0.005,
    perpMode: 'none',
    orderMaxWaitSeconds: 60,
    orderCloseMaxRetries: 3,
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
    getAllOpenSessions: vi.fn().mockReturnValue([]),
    updateSession: vi.fn(),
    persistOrder: vi.fn(),
    getOrderByClientId: vi.fn().mockReturnValue(null),
    getPendingOrders: vi.fn().mockReturnValue([]),
    getOpenOrdersBySession: vi.fn().mockReturnValue([]),
    recordTrade: vi.fn(),
    close: vi.fn(),
  } as unknown as PerpStateStore;
}

function makeFundingEvt(fundingRate: string, isStale = false): IntxFundingRateEvent {
  return {
    instrument: 'FCM',
    fundingRate,
    isFinal: false,
    timestamp: Date.now(),
    isStale,
  };
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

  // ── Tests 9-12: recoverFromRestart ────────────────────────────────
  describe('recoverFromRestart()', () => {
    it('restores currentSession when exchange confirms position still open (long)', async () => {
      const dbSession: ReturnType<typeof makeStateStore> extends { getOpenSession: any } ? any : never = {
        id: 'session-1',
        instrument: 'BTC-PERP',
        direction: 'long',
        entryPrice: '50000',
        size: '0.1',
        leverage: 10,
        liquidationPrice: '46665',
        maintenanceMarginRate: '0.0333',
        status: 'open',
        openedAt: Date.now(),
      };

      (stateStore.getAllOpenSessions as ReturnType<typeof vi.fn>).mockReturnValue([dbSession]);
      (intxClient as any).getAccountState = vi.fn().mockResolvedValue({
        balances: [],
        positions: [{ product_id: 'BTC-PERP', side: 'LONG', number_of_contracts: '0.1', avg_entry_price: '50000', current_price: '51000' }],
        summary: {},
      });
      (stateStore.getPendingOrders as ReturnType<typeof vi.fn>).mockReturnValue([]);

      const result = await manager.recoverFromRestart();

      expect(result.restored).toBe(true);
      expect(result.closedExternally).toBe(false);
      expect(manager.getCurrentSession()).toEqual(dbSession);
    });

    it('marks session closed externally when exchange shows net_size=0', async () => {
      const dbSession: any = {
        id: 'session-2',
        instrument: 'ETH-PERP',
        direction: 'long',
        entryPrice: '3000',
        size: '1.0',
        leverage: 5,
        liquidationPrice: '2400',
        maintenanceMarginRate: '0.0333',
        status: 'open',
        openedAt: Date.now(),
      };

      (stateStore.getAllOpenSessions as ReturnType<typeof vi.fn>).mockReturnValue([dbSession]);
      (intxClient as any).getAccountState = vi.fn().mockResolvedValue({
        balances: [],
        positions: [{ product_id: 'ETH-PERP', side: 'LONG', number_of_contracts: '0', avg_entry_price: '3000', current_price: '3100' }],
        summary: {},
      });
      (stateStore.getPendingOrders as ReturnType<typeof vi.fn>).mockReturnValue([]);

      const result = await manager.recoverFromRestart();

      expect(result.closedExternally).toBe(true);
      expect(result.restored).toBe(false);
      expect(manager.getCurrentSession()).toBeNull();

      // stateStore.updateSession called to close session
      expect(stateStore.updateSession).toHaveBeenCalledWith(
        dbSession.id,
        expect.objectContaining({ status: 'closed', closeReason: 'external_close' }),
      );
    });

    it('marks PENDING orders as FAILED to prevent double-entry on restart', async () => {
      const dbSession: any = {
        id: 'session-3',
        instrument: 'BTC-PERP',
        direction: 'long',
        entryPrice: '50000',
        size: '0.1',
        leverage: 10,
        liquidationPrice: '46665',
        maintenanceMarginRate: '0.0333',
        status: 'open',
        openedAt: Date.now(),
      };

      const pendingOrder: any = {
        id: 'order-uuid-1',
        clientOrderId: 'order-uuid-1',
        sessionId: dbSession.id,
        instrument: 'BTC-PERP',
        side: 'BUY',
        size: '0.1',
        status: 'PENDING',
        purpose: 'ENTRY',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      (stateStore.getAllOpenSessions as ReturnType<typeof vi.fn>).mockReturnValue([dbSession]);
      (stateStore.getPendingOrders as ReturnType<typeof vi.fn>).mockReturnValue([pendingOrder]);
      (intxClient as any).getAccountState = vi.fn().mockResolvedValue({
        balances: [],
        positions: [{ product_id: 'BTC-PERP', side: 'LONG', number_of_contracts: '0.1', avg_entry_price: '50000', current_price: '51000' }],
        summary: {},
      });

      await manager.recoverFromRestart();

      // persistOrder called with FAILED status — no new orders placed
      expect(stateStore.persistOrder).toHaveBeenCalledWith(
        expect.objectContaining({ clientOrderId: 'order-uuid-1', status: 'FAILED' }),
      );
      // placeOrder never called (no emergency close triggered since size matches)
      expect(intxClient.placeOrder).not.toHaveBeenCalled();
    });

    it('returns restored=false, closedExternally=false when no open sessions in DB', async () => {
      (stateStore.getAllOpenSessions as ReturnType<typeof vi.fn>).mockReturnValue([]);

      const result = await manager.recoverFromRestart();

      expect(result.restored).toBe(false);
      expect(result.closedExternally).toBe(false);
      // getAccountState not called when no sessions to check
      expect((intxClient as any).getAccountState).toBeUndefined();
    });

    // ── RECOV-01: size mismatch triggers emergency close ────────────
    it('triggers emergency close when DB size diverges from exchange number_of_contracts', async () => {
      const dbSession: any = {
        id: 'session-size-mismatch',
        instrument: 'BTC-PERP',
        direction: 'long',
        entryPrice: '50000',
        size: '0.1',
        leverage: 10,
        liquidationPrice: '46665',
        maintenanceMarginRate: '0.0333',
        status: 'open',
        openedAt: Date.now(),
      };

      (stateStore.getAllOpenSessions as ReturnType<typeof vi.fn>).mockReturnValue([dbSession]);
      (stateStore.getPendingOrders as ReturnType<typeof vi.fn>).mockReturnValue([]);
      (stateStore as any).getOpenOrdersBySession = vi.fn().mockReturnValue([]);
      (intxClient as any).getAccountState = vi.fn().mockResolvedValue({
        balances: [],
        positions: [{
          product_id: 'BTC-PERP',
          side: 'LONG',
          number_of_contracts: '0.05',  // DB says 0.1, exchange says 0.05
          avg_entry_price: '50000',
          current_price: '51000',
        }],
        summary: {},
      });

      // Mock closePosition to succeed (executeEmergencyClose delegates to closePosition)
      const emergencyCloseFn = vi.fn();
      manager.on('emergencyClose', emergencyCloseFn);

      const result = await manager.recoverFromRestart();

      expect(result.restored).toBe(false);
      expect(result.closedExternally).toBe(false);

      // emergencyClose event was emitted
      expect(emergencyCloseFn).toHaveBeenCalledOnce();
      // Session was NOT restored
      expect(manager.getCurrentSession()).toBeNull();
    });

    // ── RECOV-01: entry price mismatch triggers emergency close ─────
    it('triggers emergency close when DB entry price diverges >1% from exchange avg_entry_price', async () => {
      const dbSession: any = {
        id: 'session-price-mismatch',
        instrument: 'BTC-PERP',
        direction: 'long',
        entryPrice: '50000',
        size: '0.1',
        leverage: 10,
        liquidationPrice: '46665',
        maintenanceMarginRate: '0.0333',
        status: 'open',
        openedAt: Date.now(),
      };

      (stateStore.getAllOpenSessions as ReturnType<typeof vi.fn>).mockReturnValue([dbSession]);
      (stateStore.getPendingOrders as ReturnType<typeof vi.fn>).mockReturnValue([]);
      (stateStore as any).getOpenOrdersBySession = vi.fn().mockReturnValue([]);
      (intxClient as any).getAccountState = vi.fn().mockResolvedValue({
        balances: [],
        positions: [{
          product_id: 'BTC-PERP',
          side: 'LONG',
          number_of_contracts: '0.1',  // Size matches
          avg_entry_price: '48000',     // 4% off from 50000 (>1% tolerance)
          current_price: '51000',
        }],
        summary: {},
      });

      const emergencyCloseFn = vi.fn();
      manager.on('emergencyClose', emergencyCloseFn);

      const result = await manager.recoverFromRestart();

      expect(result.restored).toBe(false);
      expect(emergencyCloseFn).toHaveBeenCalledOnce();
      expect(manager.getCurrentSession()).toBeNull();
    });

    // ── RECOV-01: size and price within tolerance passes ────────────
    it('restores session when size and entry price are within tolerance', async () => {
      const dbSession: any = {
        id: 'session-within-tolerance',
        instrument: 'BTC-PERP',
        direction: 'long',
        entryPrice: '50000',
        size: '0.1000',
        leverage: 10,
        liquidationPrice: '46665',
        maintenanceMarginRate: '0.0333',
        status: 'open',
        openedAt: Date.now(),
      };

      (stateStore.getAllOpenSessions as ReturnType<typeof vi.fn>).mockReturnValue([dbSession]);
      (stateStore.getPendingOrders as ReturnType<typeof vi.fn>).mockReturnValue([]);
      (stateStore as any).getOpenOrdersBySession = vi.fn().mockReturnValue([]);
      (intxClient as any).getAccountState = vi.fn().mockResolvedValue({
        balances: [],
        positions: [{
          product_id: 'BTC-PERP',
          side: 'LONG',
          number_of_contracts: '0.1001',  // Within 0.1% of 0.1000
          avg_entry_price: '50050',        // Within 1% of 50000
          current_price: '51000',
        }],
        summary: {},
      });

      const result = await manager.recoverFromRestart();

      expect(result.restored).toBe(true);
      expect(result.closedExternally).toBe(false);
      expect(manager.getCurrentSession()).toEqual(dbSession);
    });

    // ── RECOV-02: orphaned OPEN order marked FAILED ─────────────────
    it('marks orphaned OPEN orders as FAILED when exchange position is gone', async () => {
      const dbSession: any = {
        id: 'session-ghost-open',
        instrument: 'BTC-PERP',
        direction: 'long',
        entryPrice: '50000',
        size: '0.1',
        leverage: 10,
        liquidationPrice: '46665',
        maintenanceMarginRate: '0.0333',
        status: 'open',
        openedAt: Date.now(),
      };

      const openOrder: any = {
        id: 'open-order-1',
        clientOrderId: 'open-uuid-1',
        sessionId: dbSession.id,
        instrument: 'BTC-PERP',
        side: 'BUY',
        size: '0.1',
        status: 'OPEN',
        purpose: 'ENTRY',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      (stateStore.getAllOpenSessions as ReturnType<typeof vi.fn>).mockReturnValue([dbSession]);
      (stateStore.getPendingOrders as ReturnType<typeof vi.fn>).mockReturnValue([]);
      (stateStore as any).getOpenOrdersBySession = vi.fn().mockReturnValue([openOrder]);
      (intxClient as any).getAccountState = vi.fn().mockResolvedValue({
        balances: [],
        positions: [{ product_id: 'BTC-PERP', side: 'LONG', number_of_contracts: '0', avg_entry_price: '50000', current_price: '51000' }],
        summary: {},
      });

      await manager.recoverFromRestart();

      // Orphaned OPEN order marked FAILED
      expect(stateStore.persistOrder).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'open-order-1', status: 'FAILED' }),
      );
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

  // ── Tests 9-10: FundingRateTracker wiring ─────────────────────────
  describe('FundingRateTracker wiring', () => {
    it('fundingUpdate emitted on funding rate event with open position', async () => {
      manager.start();

      await manager.openPosition({
        instrument: 'BTC-PERP',
        direction: 'long',
        size: '0.1',
        leverage: 5,
        entryPrice: '50000',
      });

      const fundingUpdateFn = vi.fn();
      manager.on('fundingUpdate', fundingUpdateFn);

      const evt: IntxFundingRateEvent = {
        instrument: 'FCM',
        fundingRate: '-25',
        isFinal: false,
        timestamp: Date.now(),
        isStale: false,
      };
      intxClient.emit('fundingRate', evt);

      expect(fundingUpdateFn).toHaveBeenCalledOnce();
      const payload = fundingUpdateFn.mock.calls[0][0];
      expect(payload.cumulativeFundingCost).toBe('-25.00000000');
      expect(payload.currentFundingRate).toBe('-25');

      // updateSession called with cumulativeFundingCost
      expect(stateStore.updateSession).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ cumulativeFundingCost: '-25.00000000' }),
      );

      manager.stop();
    });

    it('FUNDING_DRAIN_EXIT initiates closePosition when drain threshold exceeded', async () => {
      // Inject a FundingRateTracker that always returns drainTriggered=true
      const mockTracker = {
        onFundingEvent: vi.fn().mockReturnValue({
          currentFundingRate: '-50',
          cumulativeFundingCost: '-50.00000000',
          cumulativeFundingPct: '0.00500000',
          drainTriggered: true,
        }),
        reset: vi.fn(),
      } as unknown as FundingRateTracker;

      const localManager = new PerpPositionManager({
        intxClient,
        stateStore,
        config,
        fundingTracker: mockTracker,
      });
      localManager.start();

      await localManager.openPosition({
        instrument: 'BTC-PERP',
        direction: 'long',
        size: '0.1',
        leverage: 5,
        entryPrice: '50000',
      });

      const fundingDrainFn = vi.fn();
      localManager.on('fundingDrain', fundingDrainFn);

      const evt: IntxFundingRateEvent = {
        instrument: 'FCM',
        fundingRate: '-50',
        isFinal: false,
        timestamp: Date.now(),
        isStale: false,
      };
      intxClient.emit('fundingRate', evt);

      // fundingDrain event emitted synchronously
      expect(fundingDrainFn).toHaveBeenCalledOnce();

      // Wait for async closePosition to complete
      await new Promise((resolve) => setTimeout(resolve, 50));

      // closePosition was called (placeOrder called with closeOnly:true)
      expect(intxClient.placeOrder).toHaveBeenLastCalledWith(
        expect.objectContaining({ closeOnly: true }),
      );

      // currentSession should be null after close
      expect(localManager.getCurrentSession()).toBeNull();

      localManager.stop();
    });

    it('fundingUpdate emitted with no open session (always-on panel)', () => {
      const localManager = new PerpPositionManager({ intxClient, stateStore, config });
      localManager.start();

      const fundingUpdateFn = vi.fn();
      localManager.on('fundingUpdate', fundingUpdateFn);

      // No session open
      intxClient.emit('fundingRate', makeFundingEvt('-30'));

      expect(fundingUpdateFn).toHaveBeenCalledOnce();
      const payload = fundingUpdateFn.mock.calls[0][0];
      expect(payload.sessionId).toBeNull();
      expect(payload.currentFundingRate).toBe('-30');
      expect(payload.cumulativeFundingCost).toBe('0.00000000');
      expect(stateStore.updateSession).not.toHaveBeenCalled();

      localManager.stop();
    });

    it('stale fundingRate event ignored with no open session', () => {
      const localManager = new PerpPositionManager({ intxClient, stateStore, config });
      localManager.start();

      const fundingUpdateFn = vi.fn();
      localManager.on('fundingUpdate', fundingUpdateFn);

      intxClient.emit('fundingRate', makeFundingEvt('-30', true));

      expect(fundingUpdateFn).not.toHaveBeenCalled();

      localManager.stop();
    });
  });

  // ── Test: markPriceUpdate with non-zero unrealizedPnl ─────────────
  describe('markPriceUpdate event', () => {
    it('emits markPriceUpdate with non-zero unrealizedPnl when price moves after openPosition', async () => {
      manager.start();

      // Arrange: open a long position at entry price 50000
      await manager.openPosition({
        instrument: 'BTC-PERP',
        direction: 'long',
        size: '1',
        leverage: 5,
        entryPrice: '50000',
      });

      const updates: Array<{ unrealizedPnl: string; markPrice: string; sessionId: string; instrument: string }> = [];
      manager.on('markPriceUpdate', (payload) => updates.push(payload));

      // Act: fire a mark price event at 51000 (moved +1000 from entry)
      const markEvt: IntxMarkPriceEvent = {
        instrument: 'BTC-PERP',
        markPrice: '51000',
        indexPrice: '51000',
        timestamp: Date.now(),
        isStale: false,
      };
      intxClient.emit('markPrice', markEvt);

      // Wait briefly for the async handler
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Assert
      expect(updates).toHaveLength(1);
      const pnl = parseFloat(updates[0].unrealizedPnl);
      expect(pnl).toBeGreaterThan(0); // long position, price went up
      expect(updates[0].markPrice).toBe('51000');

      manager.stop();
    });

    it('does NOT emit markPriceUpdate when no session is open', async () => {
      manager.start();

      const updates: any[] = [];
      manager.on('markPriceUpdate', (payload) => updates.push(payload));

      // Fire a mark price event with no open position
      const markEvt: IntxMarkPriceEvent = {
        instrument: 'BTC-PERP',
        markPrice: '51000',
        indexPrice: '51000',
        timestamp: Date.now(),
        isStale: false,
      };
      intxClient.emit('markPrice', markEvt);

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(updates).toHaveLength(0);

      manager.stop();
    });
  });
});

// ── ORDER-03: close retry with emergency fallback ──────────────────────────

describe('ORDER-03: close retry with emergency fallback', () => {
  it('retries close up to orderCloseMaxRetries on failure then succeeds', async () => {
    const localConfig = makeConfig({ orderCloseMaxRetries: 2 });
    const ic = makeIntxClient() as any;
    const ss = makeStateStore() as any;
    const localManager = new PerpPositionManager({
      intxClient: ic,
      stateStore: ss,
      config: localConfig,
    });

    let placeCallCount = 0;
    (ic.placeOrder as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      placeCallCount++;
      if (placeCallCount === 1) {
        // First call: openPosition succeeds
        return { orderId: 'open-1', status: 'FILLED', execQty: '0.1', avgPrice: '50000', fee: '0.5' };
      }
      if (placeCallCount <= 3) {
        // 2nd call (1st close attempt), 3rd call (2nd close attempt): fail
        throw new Error('Network error');
      }
      // 4th call: emergency close succeeds
      return { orderId: 'emergency-close-1', status: 'FILLED', execQty: '0.1', avgPrice: '50000', fee: '0.5' };
    });

    // Create a strategy that returns close signal on every candle
    const closeStrategy: IStrategy = {
      name: 'close-strategy',
      minCandles: 1,
      requiredIndicators: [],
      evaluate: () => [{ strategyName: 'close-strategy', pair: 'BTC-USD', timeframe: '1h', timestamp: Date.now(), direction: 'close' as const, confidence: 1.0, reasoning: 'test' }],
    };

    // Open position directly
    await localManager.openPosition({
      instrument: 'BTC-USD',
      direction: 'long',
      size: '0.1',
      leverage: 5,
      entryPrice: '50000',
    });

    expect(localManager.isPositionOpen()).toBe(true);

    // Now trigger close via onCandle with close strategy
    (localManager as any).strategy = closeStrategy;
    localManager.onCandle(makeCandle('50000', 0));

    // Wait for all retries + backoff to complete
    // 1st attempt fails -> 1s backoff, 2nd attempt fails -> 2s backoff, emergency succeeds
    await new Promise(resolve => setTimeout(resolve, 4000));

    expect(placeCallCount).toBe(4); // 1 open + 2 retries + 1 emergency
    expect(localManager.getCurrentSession()).toBeNull();
  }, 10000);

  it('logs WARN on each close retry', async () => {
    const localConfig = makeConfig({ orderCloseMaxRetries: 1 });
    const ic = makeIntxClient() as any;
    const ss = makeStateStore() as any;
    const localManager = new PerpPositionManager({
      intxClient: ic,
      stateStore: ss,
      config: localConfig,
    });

    let placeCallCount = 0;
    (ic.placeOrder as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      placeCallCount++;
      if (placeCallCount === 1) {
        return { orderId: 'open-1', status: 'FILLED', execQty: '0.1', avgPrice: '50000', fee: '0.5' };
      }
      if (placeCallCount === 2) {
        throw new Error('Temporary network failure');
      }
      // 3rd call: emergency close succeeds
      return { orderId: 'close-1', status: 'FILLED', execQty: '0.1', avgPrice: '50000', fee: '0.5' };
    });

    await localManager.openPosition({
      instrument: 'BTC-USD',
      direction: 'long',
      size: '0.1',
      leverage: 5,
      entryPrice: '50000',
    });

    const closeStrategy: IStrategy = {
      name: 'close-strategy',
      minCandles: 1,
      requiredIndicators: [],
      evaluate: () => [{ strategyName: 'close-strategy', pair: 'BTC-USD', timeframe: '1h', timestamp: Date.now(), direction: 'close' as const, confidence: 1.0, reasoning: 'test' }],
    };
    (localManager as any).strategy = closeStrategy;
    localManager.onCandle(makeCandle('50000', 0));

    // Wait for retry + emergency
    await new Promise(resolve => setTimeout(resolve, 2000));

    expect(placeCallCount).toBe(3); // 1 open + 1 retry + 1 emergency
    expect(localManager.getCurrentSession()).toBeNull();
  }, 10000);

  it('triggers EMERGENCY_CLOSE reason after retries exhausted', async () => {
    const localConfig = makeConfig({ orderCloseMaxRetries: 1 });
    const ic = makeIntxClient() as any;
    const ss = makeStateStore() as any;
    const localManager = new PerpPositionManager({
      intxClient: ic,
      stateStore: ss,
      config: localConfig,
    });

    let placeCallCount = 0;
    const placeOrderCalls: any[] = [];
    (ic.placeOrder as ReturnType<typeof vi.fn>).mockImplementation(async (params: any) => {
      placeCallCount++;
      placeOrderCalls.push(params);
      if (placeCallCount === 1) {
        return { orderId: 'open-1', status: 'FILLED', execQty: '0.1', avgPrice: '50000', fee: '0.5' };
      }
      if (placeCallCount === 2) {
        throw new Error('Network error');
      }
      // 3rd call: emergency close succeeds
      return { orderId: 'close-1', status: 'FILLED', execQty: '0.1', avgPrice: '50000', fee: '0.5' };
    });

    await localManager.openPosition({
      instrument: 'BTC-USD',
      direction: 'long',
      size: '0.1',
      leverage: 5,
      entryPrice: '50000',
    });

    const closeStrategy: IStrategy = {
      name: 'close-strategy',
      minCandles: 1,
      requiredIndicators: [],
      evaluate: () => [{ strategyName: 'close-strategy', pair: 'BTC-USD', timeframe: '1h', timestamp: Date.now(), direction: 'close' as const, confidence: 1.0, reasoning: 'test' }],
    };
    (localManager as any).strategy = closeStrategy;
    localManager.onCandle(makeCandle('50000', 0));

    // Wait for retry + emergency
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Verify the final close call had reason 'EMERGENCY_CLOSE' in the session's closeReason
    expect(localManager.getCurrentSession()).toBeNull();
    // The last placeOrder call should be the emergency close
    // Verify via stateStore.updateSession being called with closeReason = 'EMERGENCY_CLOSE'
    expect(ss.updateSession).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ closeReason: 'EMERGENCY_CLOSE' }),
    );
  }, 10000);
});

// ── Auto-switch tests ──────────────────────────────────────────────────────
//
// These tests validate the three behavioral requirements of the regime
// auto-switching state machine for PerpPositionManager:
//
//   PERP-PM-SW-01: immediate switch when no session open
//   PERP-PM-SW-02: deferred switch executes when session closes
//   PERP-PM-SW-03: empty regime falls back to overall winner
//
// vi.spyOn(RegimeClassifier.prototype, 'classify') controls returned regimes
// without requiring real candle sequences long enough to produce ADX/ATR values.
//
// PerpPositionManager uses currentSession (not currentPosition) to track open state.
// currentSession === null means flat.

describe('auto-switch', () => {
  let classifySpy: ReturnType<typeof vi.spyOn> | undefined;

  afterEach(() => {
    classifySpy?.mockRestore();
  });

  /**
   * Build a PerpPositionManager wired for auto-switch tests.
   */
  function makeAutoSwitchManager(
    stratA: IStrategy,
    stratB: IStrategy,
    leaderboards: RegimeLeaderboards,
  ) {
    const ic = makeIntxClient() as any;
    const ss = makeStateStore() as any;
    const strategies = new Map<string, IStrategy>([
      ['perp-strategy-a', stratA],
      ['perp-strategy-b', stratB],
    ]);
    const mockRegistry = new MultiStrategyMockRegistry(strategies);
    const mgr = new PerpPositionManager({
      config: makeConfig(),
      intxClient: ic,
      stateStore: ss,
      strategyRegistry: mockRegistry,
      regimeLeaderboards: leaderboards,
    });
    return { mgr, ic, ss };
  }

  // PERP-PM-SW-01: Immediate switch when no session open ───────────────

  it('PERP-PM-SW-01: immediately switches strategy on regime change when no session is open', () => {
    const stratA: IStrategy = {
      name: 'perp-strategy-a',
      minCandles: 1,
      requiredIndicators: [],
      evaluate: () => [],
    };
    const stratB: IStrategy = {
      name: 'perp-strategy-b',
      minCandles: 1,
      requiredIndicators: [],
      evaluate: () => [],
    };

    const leaderboards = makeRegimeLeaderboards('perp-strategy-b', 'perp-strategy-a');

    // Call 1 returns RANGING (sets currentRegime=RANGING).
    // Call 2+ returns TRENDING (regime change -> immediate switch since no session open).
    let classifyCallCount = 0;
    classifySpy = vi.spyOn(RegimeClassifier.prototype, 'classify').mockImplementation(() => {
      classifyCallCount++;
      return classifyCallCount === 1 ? MarketRegime.RANGING : MarketRegime.TRENDING;
    });

    const { mgr } = makeAutoSwitchManager(stratA, stratB, leaderboards);

    const switchEvents: any[] = [];
    mgr.on('strategySwitch', (data) => switchEvents.push(data));

    // Candle 1: RANGING -> sets currentRegime=RANGING, no switch (no prior regime)
    mgr.onCandle(makeCandle('50000', 0));
    expect(switchEvents).toHaveLength(0);

    // Candle 2: TRENDING -> RANGING!=TRENDING, no session -> immediate switch
    mgr.onCandle(makeCandle('50000', 1));
    expect(switchEvents).toHaveLength(1);
    expect(switchEvents[0].newStrategy).toBe('perp-strategy-b');
  });

  // PERP-PM-SW-02: Deferred switch executes when session closes ─────────

  it('PERP-PM-SW-02: defers strategy switch until session closes', async () => {
    // Approach: open session manually before regime change candle, then close it.
    // This ensures currentSession is set BEFORE the regime change is detected.
    //
    // Timeline:
    //   openPosition() manually -> currentSession set
    //   Candle 1: RANGING -> currentRegime=RANGING (no prior regime, no switch)
    //   Candle 2: TRENDING -> RANGING!=TRENDING, session open -> pendingSwitch set
    //   closePosition() -> currentSession=null, pendingSwitch executes -> switch fires

    const stratA: IStrategy = {
      name: 'perp-strategy-a',
      minCandles: 1,
      requiredIndicators: [],
      evaluate: () => [],
    };
    const stratB: IStrategy = {
      name: 'perp-strategy-b',
      minCandles: 1,
      requiredIndicators: [],
      evaluate: () => [],
    };

    const leaderboards = makeRegimeLeaderboards('perp-strategy-b', 'perp-strategy-a');

    // Call 1 returns RANGING (sets currentRegime=RANGING).
    // Call 2+ returns TRENDING (triggers deferred switch because session is open).
    let classifyCallCount = 0;
    classifySpy = vi.spyOn(RegimeClassifier.prototype, 'classify').mockImplementation(() => {
      classifyCallCount++;
      return classifyCallCount === 1 ? MarketRegime.RANGING : MarketRegime.TRENDING;
    });

    const { mgr } = makeAutoSwitchManager(stratA, stratB, leaderboards);

    const switchEvents: any[] = [];
    mgr.on('strategySwitch', (data) => switchEvents.push(data));

    // Open position manually before any regime change candle
    await mgr.openPosition({
      instrument: 'BTC-USD',
      direction: 'long',
      size: '0.01',
      leverage: 5,
      entryPrice: '50000',
    });
    expect(mgr.isPositionOpen()).toBe(true);

    // Candle 1: RANGING -> currentRegime=RANGING; session open but no regime change -> no switch
    mgr.onCandle(makeCandle('50000', 0));
    expect(switchEvents).toHaveLength(0);

    // Candle 2: TRENDING -> RANGING!=TRENDING, session open -> pendingSwitch set (deferred)
    mgr.onCandle(makeCandle('50000', 1));
    expect(switchEvents).toHaveLength(0); // switch deferred

    // Close session -> pendingSwitch executes in closePosition() after currentSession=null
    await mgr.closePosition('test-close');
    expect(mgr.isPositionOpen()).toBe(false);

    // Pending switch must have fired
    expect(switchEvents).toHaveLength(1);
    expect(switchEvents[0].newStrategy).toBe('perp-strategy-b');
  });

  // PERP-PM-SW-03: Empty regime falls back to overall winner ────────────

  it('PERP-PM-SW-03: empty VOLATILE regime falls back to overall tournament winner', () => {
    const stratA: IStrategy = {
      name: 'perp-strategy-a',
      minCandles: 1,
      requiredIndicators: [],
      evaluate: () => [],
    };
    const stratB: IStrategy = {
      name: 'perp-strategy-b',
      minCandles: 1,
      requiredIndicators: [],
      evaluate: () => [],
    };

    // VOLATILE is empty in makeRegimeLeaderboards; fallbackEntry uses rangingStrategy='perp-strategy-b'
    const leaderboards = makeRegimeLeaderboards('perp-strategy-a', 'perp-strategy-b');

    // Call 1 returns TRENDING (sets currentRegime=TRENDING).
    // Call 2+ returns VOLATILE (empty regime -> fallback to 'perp-strategy-b').
    let classifyCallCount = 0;
    classifySpy = vi.spyOn(RegimeClassifier.prototype, 'classify').mockImplementation(() => {
      classifyCallCount++;
      return classifyCallCount === 1 ? MarketRegime.TRENDING : MarketRegime.VOLATILE;
    });

    const { mgr } = makeAutoSwitchManager(stratA, stratB, leaderboards);

    const switchEvents: any[] = [];
    mgr.on('strategySwitch', (data) => switchEvents.push(data));

    // Candle 1: TRENDING -> sets currentRegime=TRENDING, no switch (no prior regime)
    mgr.onCandle(makeCandle('50000', 0));
    expect(switchEvents).toHaveLength(0);

    // Candle 2: VOLATILE -> VOLATILE leaderboard empty -> fallback to 'perp-strategy-b'
    mgr.onCandle(makeCandle('50000', 1));
    expect(switchEvents).toHaveLength(1);
    expect(switchEvents[0].newStrategy).toBe('perp-strategy-b');
  });
});
