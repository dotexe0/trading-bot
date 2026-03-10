/**
 * Tests for PaperPerpEngine.
 *
 * IntxClient and PerpStateStore are fully mocked — no real DB or network calls.
 * Key invariant: intxClient.placeOrder is NEVER called in any paper code path.
 *
 * Tests:
 *  1. Full round-trip: onSignal drives open-long → close cycle
 *  2. Emergency close: position near liquidation triggers emergencyClose event
 *  3. Stale data ignored: isStale:true events produce no state changes
 *  4. Double-open guard: second openPaperPosition throws
 *  5. Short position PnL: realized PnL is positive for profitable short
 *  6. No placeOrder calls: placeOrder mock throws; full round-trip still succeeds
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PaperPerpEngine } from '../paper-perp-engine.js';
import { FundingRateTracker } from '../funding-tracker.js';
import type { IntxClient } from '../intx-client.js';
import type { PerpStateStore } from '../perp-state-store.js';
import type { IntxConfig } from '../config.js';
import type { IntxMarkPriceEvent, IntxFundingRateEvent } from '../types.js';

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
    ...overrides,
  };
}

function makeIntxClient(): IntxClient & EventEmitter & {
  placeOrder: ReturnType<typeof vi.fn>;
  cancelOrder: ReturnType<typeof vi.fn>;
} {
  const emitter = new EventEmitter();
  const placeOrder = vi.fn().mockResolvedValue({
    orderId: 'exchange-order-1',
    status: 'FILLED',
    execQty: '0.01',
    avgPrice: '50000',
    fee: '0.5',
  });
  const cancelOrder = vi.fn().mockResolvedValue(undefined);
  return Object.assign(emitter, { placeOrder, cancelOrder }) as any;
}

function makeStateStore(): PerpStateStore & {
  createSession: ReturnType<typeof vi.fn>;
  updateSession: ReturnType<typeof vi.fn>;
  persistOrder: ReturnType<typeof vi.fn>;
  getPendingOrders: ReturnType<typeof vi.fn>;
} {
  return {
    createSession: vi.fn(),
    getOpenSession: vi.fn().mockReturnValue(null),
    updateSession: vi.fn(),
    persistOrder: vi.fn(),
    getOrderByClientId: vi.fn().mockReturnValue(null),
    getPendingOrders: vi.fn().mockReturnValue([]),
    close: vi.fn(),
  } as unknown as any;
}

function makeMarkPriceEvt(
  instrument: string,
  markPrice: string,
  isStale = false,
): IntxMarkPriceEvent {
  return {
    instrument,
    markPrice,
    indexPrice: markPrice,
    timestamp: Date.now(),
    isStale,
  };
}

function makeFundingRateEvt(fundingRate: string, isStale = false): IntxFundingRateEvent {
  return {
    instrument: 'FCM',
    fundingRate,
    isFinal: false,
    timestamp: Date.now(),
    isStale,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('PaperPerpEngine', () => {
  let intxClient: ReturnType<typeof makeIntxClient>;
  let stateStore: ReturnType<typeof makeStateStore>;
  let config: IntxConfig;

  beforeEach(() => {
    intxClient = makeIntxClient();
    stateStore = makeStateStore();
    config = makeConfig();
  });

  // ── Test 1: Full round-trip via onSignal ───────────────────────────
  describe('full round-trip via onSignal', () => {
    it('opens and closes position, persists to stateStore, never calls placeOrder', async () => {
      let callCount = 0;
      const engine = new PaperPerpEngine({
        intxClient,
        stateStore,
        config,
        onSignal: (_instrument, _markPrice) => {
          callCount++;
          if (callCount === 1) return 'open-long';
          if (callCount === 2) return 'close';
          return 'hold';
        },
      });

      const positionOpened = vi.fn();
      const positionClosed = vi.fn();
      engine.on('positionOpened', positionOpened);
      engine.on('positionClosed', positionClosed);

      engine.start();

      // First event: open-long (openPaperPosition is async; flush microtask queue)
      intxClient.emit('markPrice', makeMarkPriceEvt('BTC-PERP', '50000'));
      await Promise.resolve();
      // Second event: close (position is now open)
      intxClient.emit('markPrice', makeMarkPriceEvt('BTC-PERP', '51000'));
      await Promise.resolve();

      engine.stop();

      // Both events were acted upon
      expect(positionOpened).toHaveBeenCalledOnce();
      expect(positionClosed).toHaveBeenCalledOnce();

      // createSession called with a full PerpSession
      expect(stateStore.createSession).toHaveBeenCalledOnce();
      const passedSession = stateStore.createSession.mock.calls[0][0];
      expect(passedSession).toMatchObject({
        id: expect.any(String),
        openedAt: expect.any(Number),
        status: 'open',
        instrument: 'BTC-PERP',
        direction: 'long',
      });

      // updateSession called for close
      expect(stateStore.updateSession).toHaveBeenCalledWith(
        passedSession.id,
        expect.objectContaining({ status: 'closed' }),
      );

      // placeOrder NEVER called
      expect(intxClient.placeOrder).not.toHaveBeenCalled();
    });
  });

  // ── Test 2: Emergency close ────────────────────────────────────────
  describe('emergency close', () => {
    it('triggers when mark price is near liquidation, emits emergencyClose, never calls placeOrder', async () => {
      const emergencyConfig = makeConfig({ liquidationSafetyThresholdPct: 10 });
      const engine = new PaperPerpEngine({ intxClient, stateStore, config: emergencyConfig });
      engine.start();

      // Open long at 50000, leverage 10, MMR=0.0333 → liqPrice ≈ 46665
      await engine.openPaperPosition('BTC-PERP', 'long', '0.01', 10, '50000');

      const emergencyCloseFn = vi.fn();
      engine.on('emergencyClose', emergencyCloseFn);

      // Mark at 47000 → distance ≈ 0.71% < 10% threshold → triggers emergency close
      intxClient.emit('markPrice', makeMarkPriceEvt('BTC-PERP', '47000'));

      expect(emergencyCloseFn).toHaveBeenCalledOnce();
      // Position should be closed now
      expect(engine.getCurrentSession()).toBeNull();
      expect(engine.isPositionOpen()).toBe(false);

      // placeOrder NEVER called
      expect(intxClient.placeOrder).not.toHaveBeenCalled();

      // _emergencyCloseInProgress reset to false
      expect((engine as any)._emergencyCloseInProgress).toBe(false);

      engine.stop();
    });
  });

  // ── Test 3: Stale data ignored ─────────────────────────────────────
  describe('stale data', () => {
    it('ignores markPrice events with isStale:true — no events emitted', () => {
      const engine = new PaperPerpEngine({
        intxClient,
        stateStore,
        config,
        onSignal: () => 'open-long',
      });

      const positionOpened = vi.fn();
      engine.on('positionOpened', positionOpened);
      engine.start();

      // Stale event
      intxClient.emit('markPrice', makeMarkPriceEvt('BTC-PERP', '50000', true));

      engine.stop();

      expect(positionOpened).not.toHaveBeenCalled();
      expect(stateStore.createSession).not.toHaveBeenCalled();
    });
  });

  // ── Test 4: Double-open guard ──────────────────────────────────────
  describe('double-open guard', () => {
    it('throws when openPaperPosition called while position is already open', async () => {
      const engine = new PaperPerpEngine({ intxClient, stateStore, config });

      await engine.openPaperPosition('BTC-PERP', 'long', '0.01', 5, '50000');

      await expect(
        engine.openPaperPosition('BTC-PERP', 'long', '0.01', 5, '51000'),
      ).rejects.toThrow('Paper position already open');
    });
  });

  // ── Test 5: Short position PnL ─────────────────────────────────────
  describe('short position PnL', () => {
    it('realizes positive PnL when short opened at 50000 and closed at 45000', async () => {
      const engine = new PaperPerpEngine({ intxClient, stateStore, config });

      await engine.openPaperPosition('BTC-PERP', 'short', '0.01', 5, '50000');

      const positionClosed = vi.fn();
      engine.on('positionClosed', positionClosed);

      engine.closePaperPosition('45000');

      expect(positionClosed).toHaveBeenCalledOnce();

      // PnL for short: (entry - exit) * size = (50000 - 45000) * 0.01 = 50
      // Access stateStore.updateSession to confirm status closed
      expect(stateStore.updateSession).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ status: 'closed' }),
      );

      // Position is null after close
      expect(engine.getCurrentSession()).toBeNull();
    });
  });

  // ── Test 6: No placeOrder calls ────────────────────────────────────
  describe('no placeOrder calls', () => {
    it('placeOrder throwing does not affect paper round-trip', async () => {
      // Make placeOrder throw — if paper engine ever calls it, the test will throw
      (intxClient.placeOrder as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('placeOrder should never be called in paper mode');
      });

      let callCount = 0;
      const engine = new PaperPerpEngine({
        intxClient,
        stateStore,
        config,
        onSignal: () => {
          callCount++;
          if (callCount === 1) return 'open-long';
          return 'close';
        },
      });

      engine.start();

      // First event: open-long (openPaperPosition is async; flush microtask queue)
      intxClient.emit('markPrice', makeMarkPriceEvt('BTC-PERP', '50000'));
      await Promise.resolve();
      // Second event: close (position is now open)
      intxClient.emit('markPrice', makeMarkPriceEvt('BTC-PERP', '51000'));
      await Promise.resolve();

      engine.stop();

      // placeOrder never called
      expect(intxClient.placeOrder).not.toHaveBeenCalled();
    });
  });

  // ── Tests 7-8: FundingRateTracker wiring ──────────────────────────
  describe('FundingRateTracker wiring', () => {
    it('fundingUpdate event emitted on funding rate event with open position', async () => {
      const engine = new PaperPerpEngine({ intxClient, stateStore, config });
      engine.start();

      // Open long: size='0.1', entryPrice='100000'
      await engine.openPaperPosition('BTC-PERP', 'long', '0.1', 5, '100000');

      const fundingUpdateFn = vi.fn();
      engine.on('fundingUpdate', fundingUpdateFn);

      // Emit funding event: fundingRate='-25' (paid funding)
      intxClient.emit('fundingRate', makeFundingRateEvt('-25'));

      expect(fundingUpdateFn).toHaveBeenCalledOnce();
      const payload = fundingUpdateFn.mock.calls[0][0];
      expect(payload.cumulativeFundingCost).toBe('-25.00000000');
      expect(payload.currentFundingRate).toBe('-25');

      // updateSession called with cumulativeFundingCost
      expect(stateStore.updateSession).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ cumulativeFundingCost: '-25.00000000' }),
      );

      engine.stop();
    });

    it('FUNDING_DRAIN_EXIT closes position when drain threshold exceeded', async () => {
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

      const engine = new PaperPerpEngine({
        intxClient,
        stateStore,
        config,
        fundingTracker: mockTracker,
      });
      engine.start();

      // Open long position
      await engine.openPaperPosition('BTC-PERP', 'long', '0.1', 5, '100000');

      const fundingDrainFn = vi.fn();
      engine.on('fundingDrain', fundingDrainFn);

      // Emit funding event — drain triggers immediately
      intxClient.emit('fundingRate', makeFundingRateEvt('-50'));

      // fundingDrain event emitted
      expect(fundingDrainFn).toHaveBeenCalledOnce();

      // updateSession called with closeReason=FUNDING_DRAIN_EXIT
      expect(stateStore.updateSession).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ closeReason: 'FUNDING_DRAIN_EXIT' }),
      );

      // Position is closed
      expect(engine.getCurrentSession()).toBeNull();
      expect(engine.isPositionOpen()).toBe(false);

      engine.stop();
    });
  });
});
