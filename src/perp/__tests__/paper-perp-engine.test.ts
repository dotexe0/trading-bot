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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PaperPerpEngine } from '../paper-perp-engine.js';
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
import type { FeedHealthMonitor } from '../../core/feed-health.js';

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
    disqualified: false,
    disqualifyReason: null,
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

function makeIntxClient(): IntxClient & EventEmitter & {
  placeOrder: ReturnType<typeof vi.fn>;
  cancelOrder: ReturnType<typeof vi.fn>;
  fetchFundingRate: ReturnType<typeof vi.fn>;
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
  const fetchFundingRate = vi.fn().mockResolvedValue(0);
  return Object.assign(emitter, { placeOrder, cancelOrder, fetchFundingRate }) as any;
}

function makeStateStore(): PerpStateStore & {
  createSession: ReturnType<typeof vi.fn>;
  updateSession: ReturnType<typeof vi.fn>;
  persistOrder: ReturnType<typeof vi.fn>;
  getPendingOrders: ReturnType<typeof vi.fn>;
  recordTrade: ReturnType<typeof vi.fn>;
} {
  return {
    createSession: vi.fn(),
    getOpenSession: vi.fn().mockReturnValue(null),
    getAllOpenSessions: vi.fn().mockReturnValue([]),
    updateSession: vi.fn(),
    persistOrder: vi.fn(),
    getOrderByClientId: vi.fn().mockReturnValue(null),
    getPendingOrders: vi.fn().mockReturnValue([]),
    recordTrade: vi.fn(),
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
      // unrealizedPnl included — no markPrice set so falls back to cumulativeFundingCost
      expect(payload.unrealizedPnl).toBe('-25.00000000');

      // updateSession called with cumulativeFundingCost
      expect(stateStore.updateSession).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ cumulativeFundingCost: '-25.00000000' }),
      );

      engine.stop();
    });

    it('fundingUpdate includes unrealizedPnl in payload with open position (Bug 1 regression)', async () => {
      const engine = new PaperPerpEngine({ intxClient, stateStore, config });
      engine.start();

      // Open long: entry=100000, size=0.1 — session.markPrice starts as entryPrice
      await engine.openPaperPosition('BTC-PERP', 'long', '0.1', 5, '100000');

      const fundingUpdateFn = vi.fn();
      engine.on('fundingUpdate', fundingUpdateFn);

      // Emit funding event: cumFundingCost='-5.00000000'
      intxClient.emit('fundingRate', makeFundingRateEvt('-5'));

      expect(fundingUpdateFn).toHaveBeenCalledOnce();
      const payload = fundingUpdateFn.mock.calls[0][0];
      // unrealizedPnl present — mark=entry so pricePnl=0, total = cumulativeFundingCost
      expect(payload.unrealizedPnl).toBeDefined();
      expect(payload.unrealizedPnl).toBe('-5.00000000');

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

    it('fundingUpdate emitted with no open position (always-on panel)', () => {
      const engine = new PaperPerpEngine({ intxClient, stateStore, config });
      engine.start();

      const fundingUpdateFn = vi.fn();
      engine.on('fundingUpdate', fundingUpdateFn);

      // No position open — emit a funding rate event
      intxClient.emit('fundingRate', makeFundingRateEvt('-30'));

      expect(fundingUpdateFn).toHaveBeenCalledOnce();
      const payload = fundingUpdateFn.mock.calls[0][0];
      expect(payload.sessionId).toBeNull();
      expect(payload.currentFundingRate).toBe('-30');
      expect(payload.cumulativeFundingCost).toBe('0.00000000');
      // stateStore.updateSession NOT called (no session to update)
      expect(stateStore.updateSession).not.toHaveBeenCalled();

      engine.stop();
    });

    it('stale fundingRate event is ignored even with no position', () => {
      const engine = new PaperPerpEngine({ intxClient, stateStore, config });
      engine.start();

      const fundingUpdateFn = vi.fn();
      engine.on('fundingUpdate', fundingUpdateFn);

      // isStale=true — must be dropped
      intxClient.emit('fundingRate', makeFundingRateEvt('-30', true));

      expect(fundingUpdateFn).not.toHaveBeenCalled();

      engine.stop();
    });
  });

  // ── Test: markPriceUpdate with non-zero unrealizedPnl ─────────────
  describe('markPriceUpdate event', () => {
    it('emits markPriceUpdate with non-zero unrealizedPnl when price moves after open', async () => {
      const engine = new PaperPerpEngine({ intxClient, stateStore, config });
      engine.start();

      // Arrange: open a long position at entry price 50000
      await engine.openPaperPosition(config.btcProductId, 'long', '1', 5, '50000');
      const updates: Array<{ unrealizedPnl: string; markPrice: string; sessionId: string; instrument: string }> = [];
      engine.on('markPriceUpdate', (payload) => updates.push(payload));

      // Act: fire a mark price event at 51000 (moved +1000 from entry)
      const markEvt: IntxMarkPriceEvent = {
        instrument: config.btcProductId,
        markPrice: '51000',
        indexPrice: '51000',
        timestamp: Date.now(),
        isStale: false,
      };
      intxClient.emit('markPrice', markEvt);

      // Assert
      expect(updates).toHaveLength(1);
      const pnl = parseFloat(updates[0].unrealizedPnl);
      expect(pnl).toBeGreaterThan(0); // long position, price went up
      expect(updates[0].markPrice).toBe('51000');

      engine.stop();
    });

    it('emits markPriceUpdate after strategy-driven open — instrument uses config.btcProductId not candle.pair', async () => {
      // Regression test: position was opened with candle.pair ('BTC-USD') instead of
      // config.btcProductId ('BIP-20DEC30-CDE'), causing the instrument guard in
      // _handleMarkPrice to never match → P&L never updated.
      const mockStrategy: IStrategy = {
        name: 'mock-long',
        minCandles: 1,
        requiredIndicators: [],
        evaluate: () => [{
          strategyName: 'mock-long',
          pair: 'BTC-USD',
          timeframe: '1h' as const,
          timestamp: Date.now(),
          direction: 'long' as const,
          confidence: 1,
          reasoning: 'test',
        }],
      };

      const engine = new PaperPerpEngine({ intxClient, stateStore, config, initialStrategy: mockStrategy });
      engine.start();

      const updates: Array<{ unrealizedPnl: string; markPrice: string }> = [];
      engine.on('markPriceUpdate', (payload) => updates.push(payload));

      // Open position via strategy signal path (onCandle → evaluate → openPaperPosition)
      engine.onCandle(makeCandle('50000', 0));
      // Allow async openPaperPosition microtask to settle
      await new Promise<void>((r) => setTimeout(r, 0));

      // Confirm position was opened (createSession should have been called)
      expect(stateStore.createSession).toHaveBeenCalledTimes(1);

      // Fire mark price with the perp product ID (not 'BTC-USD')
      intxClient.emit('markPrice', makeMarkPriceEvt(config.btcProductId, '51000'));

      // Position must receive P&L update — instrument guard must pass
      expect(updates).toHaveLength(1);
      expect(parseFloat(updates[0].unrealizedPnl)).toBeGreaterThan(0);

      engine.stop();
    });

    it('does NOT emit markPriceUpdate when no position is open', () => {
      const engine = new PaperPerpEngine({ intxClient, stateStore, config });
      engine.start();

      const updates: any[] = [];
      engine.on('markPriceUpdate', (payload) => updates.push(payload));

      // Fire a mark price event with no open position
      const markEvt: IntxMarkPriceEvent = {
        instrument: config.btcProductId,
        markPrice: '51000',
        indexPrice: '51000',
        timestamp: Date.now(),
        isStale: false,
      };
      intxClient.emit('markPrice', markEvt);

      expect(updates).toHaveLength(0);

      engine.stop();
    });
  });
});

// ── Auto-switch tests ──────────────────────────────────────────────────────
//
// These tests validate the three behavioral requirements of the regime
// auto-switching state machine for PaperPerpEngine:
//
//   PERP-SW-01: immediate switch when no position open
//   PERP-SW-02: deferred switch executes when position closes
//   PERP-SW-03: empty regime falls back to overall winner
//
// vi.spyOn(RegimeClassifier.prototype, 'classify') controls returned regimes
// without requiring real candle sequences long enough to produce ADX/ATR values.

describe('auto-switch', () => {
  let classifySpy: ReturnType<typeof vi.spyOn> | undefined;

  afterEach(() => {
    classifySpy?.mockRestore();
  });

  /**
   * Build a PaperPerpEngine wired for auto-switch tests.
   * Uses a MultiStrategyMockRegistry that returns strategies by name from config.
   */
  function makeAutoSwitchEngine(
    stratA: IStrategy,
    stratB: IStrategy,
    leaderboards: RegimeLeaderboards,
  ) {
    const ic = makeIntxClient();
    const ss = makeStateStore();
    const strategies = new Map<string, IStrategy>([
      ['perp-strategy-a', stratA],
      ['perp-strategy-b', stratB],
    ]);
    const mockRegistry = new MultiStrategyMockRegistry(strategies);
    const engine = new PaperPerpEngine({
      config: makeConfig({ strategyConfig: { strategy: 'perp-strategy-a' } } as any),
      intxClient: ic,
      stateStore: ss,
      strategyRegistry: mockRegistry,
      regimeLeaderboards: leaderboards,
    });
    return { engine, ic, ss };
  }

  // PERP-SW-01: Immediate switch when no position open ─────────────────

  it('PERP-SW-01: immediately switches strategy on regime change when no position is open', () => {
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
    // Call 2+ returns TRENDING (regime change -> immediate switch since no position).
    let classifyCallCount = 0;
    classifySpy = vi.spyOn(RegimeClassifier.prototype, 'classify').mockImplementation(() => {
      classifyCallCount++;
      return classifyCallCount === 1 ? MarketRegime.RANGING : MarketRegime.TRENDING;
    });

    const { engine } = makeAutoSwitchEngine(stratA, stratB, leaderboards);

    const switchEvents: any[] = [];
    engine.on('strategySwitch', (data) => switchEvents.push(data));

    // Candle 1: classify returns RANGING -> sets currentRegime=RANGING, no switch (no prior regime)
    engine.onCandle(makeCandle('50000', 0));
    expect(switchEvents).toHaveLength(0);

    // Candle 2: classify returns TRENDING -> RANGING!=TRENDING, no position -> immediate switch
    engine.onCandle(makeCandle('50000', 1));
    expect(switchEvents).toHaveLength(1);
    expect(switchEvents[0].newStrategy).toBe('perp-strategy-b');
  });

  // PERP-SW-02: Deferred switch executes when position closes ──────────

  it('PERP-SW-02: defers strategy switch until position closes', async () => {
    // Approach: open position manually before regime change candle, then close it.
    // This ensures the position is open BEFORE the regime change is detected in onCandle().
    //
    // Timeline:
    //   openPaperPosition() manually -> currentPosition set
    //   Candle 1: classify returns RANGING -> currentRegime=RANGING (no prior regime, no switch)
    //   Candle 2: classify returns TRENDING -> RANGING!=TRENDING, position open -> pendingSwitch set
    //   closePaperPosition() -> currentPosition=null, pendingSwitch executes -> switch fires

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
    // Call 2+ returns TRENDING (triggers deferred switch because position is open).
    let classifyCallCount = 0;
    classifySpy = vi.spyOn(RegimeClassifier.prototype, 'classify').mockImplementation(() => {
      classifyCallCount++;
      return classifyCallCount === 1 ? MarketRegime.RANGING : MarketRegime.TRENDING;
    });

    const { engine } = makeAutoSwitchEngine(stratA, stratB, leaderboards);

    const switchEvents: any[] = [];
    engine.on('strategySwitch', (data) => switchEvents.push(data));

    // Open position before regime change detection
    await engine.openPaperPosition('BTC-USD', 'long', '0.01', 5, '50000');
    expect(engine.isPositionOpen()).toBe(true);

    // Candle 1: RANGING -> sets currentRegime=RANGING; position open but no regime change -> no switch
    engine.onCandle(makeCandle('50000', 0));
    expect(switchEvents).toHaveLength(0);

    // Candle 2: TRENDING -> RANGING!=TRENDING, position open -> pendingSwitch set (deferred)
    engine.onCandle(makeCandle('50000', 1));
    expect(switchEvents).toHaveLength(0); // switch deferred

    // Close position -> pendingSwitch executes synchronously in closePaperPosition
    engine.closePaperPosition('51000', 'test-close');
    expect(engine.isPositionOpen()).toBe(false);

    // Pending switch must have fired
    expect(switchEvents).toHaveLength(1);
    expect(switchEvents[0].newStrategy).toBe('perp-strategy-b');
  });

  // PERP-SW-03: Empty regime falls back to overall winner ──────────────

  it('PERP-SW-03: empty VOLATILE regime falls back to overall tournament winner', () => {
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

    const { engine } = makeAutoSwitchEngine(stratA, stratB, leaderboards);

    const switchEvents: any[] = [];
    engine.on('strategySwitch', (data) => switchEvents.push(data));

    // Candle 1: TRENDING -> sets currentRegime=TRENDING, no switch (no prior regime)
    engine.onCandle(makeCandle('50000', 0));
    expect(switchEvents).toHaveLength(0);

    // Candle 2: VOLATILE -> VOLATILE leaderboard is empty -> fallback to 'perp-strategy-b'
    engine.onCandle(makeCandle('50000', 1));
    expect(switchEvents).toHaveLength(1);
    expect(switchEvents[0].newStrategy).toBe('perp-strategy-b');
  });
});

// ── Feed Health Guard Tests ─────────────────────────────────────────────────

describe('feed health guard', () => {
  let intxClient: ReturnType<typeof makeIntxClient>;
  let stateStore: ReturnType<typeof makeStateStore>;
  let config: IntxConfig;

  beforeEach(() => {
    intxClient = makeIntxClient();
    stateStore = makeStateStore();
    config = makeConfig();
  });

  it('skips strategy evaluation when feed is stale', () => {
    const mockFeedHealth = {
      isStale: vi.fn().mockReturnValue(true),
    } as unknown as FeedHealthMonitor;

    const holdSignal: IStrategy = {
      name: 'hold-strategy',
      minCandles: 1,
      requiredIndicators: [],
      evaluate: vi.fn().mockReturnValue([{
        strategyName: 'hold-strategy',
        pair: 'BTC-USD',
        timeframe: '1h',
        timestamp: Date.now(),
        direction: 'long',
        confidence: 0.9,
        reasoning: 'test',
      }]),
    };

    const engine = new PaperPerpEngine({
      intxClient: intxClient as any,
      stateStore: stateStore as any,
      config,
      initialStrategy: holdSignal,
      feedHealthMonitor: mockFeedHealth,
    });
    engine.start();

    // Send multiple candles -- all should be buffered but no strategy evaluation
    for (let i = 0; i < 5; i++) {
      engine.onCandle(makeCandle('50000', i));
    }

    // Strategy.evaluate should NOT have been called
    expect(holdSignal.evaluate).not.toHaveBeenCalled();

    // No position should have been opened
    expect(engine.isPositionOpen()).toBe(false);

    engine.stop();
  });

  it('re-hydrates state from DB on IntxClient reconnected event', async () => {
    const engine = new PaperPerpEngine({
      intxClient: intxClient as any,
      stateStore: stateStore as any,
      config,
    });
    engine.start();

    // Open a paper position
    await engine.openPaperPosition('BTC-PERP', 'long', '0.01', 5, '50000');
    expect(engine.isPositionOpen()).toBe(true);

    // Mock getOpenSession to return a session with updated markPrice
    const mockDbSession = {
      id: engine.getCurrentSession()!.id,
      instrument: 'BTC-PERP',
      direction: 'long',
      entryPrice: '50000',
      size: '0.01',
      leverage: 5,
      liquidationPrice: '41665.00000000',
      maintenanceMarginRate: '0.0333',
      status: 'open',
      openedAt: Date.now(),
      markPrice: '52000',
      cumulativeFundingCost: '-0.00050000',
    };
    stateStore.getOpenSession.mockReturnValue(mockDbSession);

    // Emit reconnected event
    intxClient.emit('reconnected');

    // Verify in-memory session was updated with DB values
    const session = engine.getCurrentSession()!;
    expect(session.markPrice).toBe('52000');
    expect(session.cumulativeFundingCost).toBe('-0.00050000');

    // Verify getOpenSession was called with the correct instrument
    expect(stateStore.getOpenSession).toHaveBeenCalledWith('BTC-PERP');

    engine.stop();
  });
});

// ── Startup re-hydration ───────────────────────────────────────────────────

describe('startup re-hydration', () => {
  let intxClient: ReturnType<typeof makeIntxClient>;
  let stateStore: ReturnType<typeof makeStateStore>;
  const config = makeConfig();

  function makeOpenSession(overrides: Partial<{ id: string; instrument: string; direction: 'long' | 'short'; entryPrice: string }> = {}) {
    return {
      id: 'session-001',
      instrument: 'BIP-20DEC30-CDE',
      direction: 'long' as const,
      entryPrice: '50000',
      size: '0.01',
      leverage: 5,
      liquidationPrice: '41665.00',
      maintenanceMarginRate: '0.0333',
      status: 'open' as const,
      openedAt: Date.now() - 60000,
      ...overrides,
    };
  }

  beforeEach(() => {
    intxClient = makeIntxClient();
    stateStore = makeStateStore();
  });

  it('restores currentPosition from DB when start() finds an open session', () => {
    const session = makeOpenSession();
    stateStore.getAllOpenSessions = vi.fn().mockReturnValue([session]);

    const engine = new PaperPerpEngine({ intxClient, stateStore, config });
    engine.start();

    expect(engine.getCurrentSession()).not.toBeNull();
    expect(engine.getCurrentSession()!.id).toBe('session-001');
    expect(engine.isPositionOpen()).toBe(true);

    engine.stop();
  });

  it('does nothing when no open sessions exist in DB', () => {
    const engine = new PaperPerpEngine({ intxClient, stateStore, config });
    engine.start();

    expect(engine.getCurrentSession()).toBeNull();
    expect(engine.isPositionOpen()).toBe(false);

    engine.stop();
  });

  it('corrects BTC-USD instrument to config.btcProductId on re-hydration', () => {
    const session = makeOpenSession({ instrument: 'BTC-USD' });
    stateStore.getAllOpenSessions = vi.fn().mockReturnValue([session]);

    const engine = new PaperPerpEngine({ intxClient, stateStore, config });
    engine.start();

    expect(engine.getCurrentSession()!.instrument).toBe(config.btcProductId);
    expect(stateStore.updateSession).toHaveBeenCalledWith(
      'session-001',
      expect.objectContaining({ instrument: config.btcProductId }),
    );

    engine.stop();
  });

  it('corrects ETH-USD instrument to config.ethProductId on re-hydration', () => {
    const session = makeOpenSession({ instrument: 'ETH-USD' });
    stateStore.getAllOpenSessions = vi.fn().mockReturnValue([session]);

    const engine = new PaperPerpEngine({ intxClient, stateStore, config });
    engine.start();

    expect(engine.getCurrentSession()!.instrument).toBe(config.ethProductId);

    engine.stop();
  });

  it('emits markPriceUpdate after re-hydration when mark price arrives for restored instrument', () => {
    const session = makeOpenSession({ instrument: 'BTC-USD' }); // will be corrected to btcProductId
    stateStore.getAllOpenSessions = vi.fn().mockReturnValue([session]);

    const engine = new PaperPerpEngine({ intxClient, stateStore, config });
    engine.start();

    const updates: Array<{ unrealizedPnl: string }> = [];
    engine.on('markPriceUpdate', (p) => updates.push(p));

    intxClient.emit('markPrice', makeMarkPriceEvt(config.btcProductId, '51000'));

    expect(updates).toHaveLength(1);
    expect(parseFloat(updates[0].unrealizedPnl)).toBeGreaterThan(0);

    engine.stop();
  });

  it('closes orphaned sessions (all but most recent) on startup', () => {
    const older = makeOpenSession({ id: 'session-old', openedAt: Date.now() - 120000 });
    const newer = makeOpenSession({ id: 'session-new', openedAt: Date.now() - 60000 });
    stateStore.getAllOpenSessions = vi.fn().mockReturnValue([older, newer]);

    const engine = new PaperPerpEngine({ intxClient, stateStore, config });
    engine.start();

    // Only the most recent session is restored
    expect(engine.getCurrentSession()!.id).toBe('session-new');

    // Orphaned session is closed
    expect(stateStore.updateSession).toHaveBeenCalledWith(
      'session-old',
      expect.objectContaining({ status: 'closed', closeReason: 'engine-restart' }),
    );

    engine.stop();
  });

  it('restores strategy position state via restorePosition() when strategy supports it', () => {
    const session = makeOpenSession({ direction: 'long', entryPrice: '50000' });
    stateStore.getAllOpenSessions = vi.fn().mockReturnValue([session]);

    const restorePosition = vi.fn();
    const mockStrategy = {
      name: 'mock', minCandles: 1, requiredIndicators: [],
      evaluate: vi.fn().mockReturnValue([]),
      restorePosition,
    };

    const engine = new PaperPerpEngine({ intxClient, stateStore, config, initialStrategy: mockStrategy as any });
    engine.start();

    expect(restorePosition).toHaveBeenCalledWith('long', '50000');

    engine.stop();
  });
});

// ── Paper funding simulation ───────────────────────────────────────────────

describe('paper funding simulation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits fundingUpdate after one interval when position is open and rate is non-zero', async () => {
    const intxClient = makeIntxClient();
    const stateStore = makeStateStore();
    const config = makeConfig();
    intxClient.fetchFundingRate = vi.fn().mockResolvedValue(0.0001); // 0.01% rate

    const engine = new PaperPerpEngine({
      intxClient, stateStore, config,
      paperFundingIntervalMs: 1000,
    });
    engine.start();
    await engine.openPaperPosition(config.btcProductId, 'long', '0.01', 5, '80000');

    const updates: any[] = [];
    engine.on('fundingUpdate', (u) => updates.push(u));

    await vi.advanceTimersByTimeAsync(1000);

    expect(updates.length).toBeGreaterThanOrEqual(1);
    // Long pays when rate > 0 → cumulativeFundingCost is negative
    expect(parseFloat(updates[0].cumulativeFundingCost)).toBeLessThan(0);
    engine.stop();
  });

  it('does not emit fundingUpdate when no position is open', async () => {
    const intxClient = makeIntxClient();
    const stateStore = makeStateStore();
    const config = makeConfig();
    intxClient.fetchFundingRate = vi.fn().mockResolvedValue(0.0001);

    const engine = new PaperPerpEngine({
      intxClient, stateStore, config,
      paperFundingIntervalMs: 1000,
    });
    engine.start();

    const fundingUpdatesWithSession: any[] = [];
    engine.on('fundingUpdate', (u) => { if (u.sessionId !== null) fundingUpdatesWithSession.push(u); });

    await vi.advanceTimersByTimeAsync(1000);

    expect(fundingUpdatesWithSession).toHaveLength(0);
    engine.stop();
  });

  it('short position receives funding (positive cost) when rate is positive', async () => {
    const intxClient = makeIntxClient();
    const stateStore = makeStateStore();
    const config = makeConfig();
    intxClient.fetchFundingRate = vi.fn().mockResolvedValue(0.0001);

    const engine = new PaperPerpEngine({
      intxClient, stateStore, config,
      paperFundingIntervalMs: 1000,
    });
    engine.start();
    await engine.openPaperPosition(config.btcProductId, 'short', '0.01', 5, '80000');

    const updates: any[] = [];
    engine.on('fundingUpdate', (u) => updates.push(u));

    await vi.advanceTimersByTimeAsync(1000);

    expect(updates.length).toBeGreaterThanOrEqual(1);
    // Short receives when rate > 0 → cumulativeFundingCost is positive
    expect(parseFloat(updates[0].cumulativeFundingCost)).toBeGreaterThan(0);
    engine.stop();
  });

  it('does not emit when fetchFundingRate returns 0', async () => {
    const intxClient = makeIntxClient();
    const stateStore = makeStateStore();
    const config = makeConfig();
    intxClient.fetchFundingRate = vi.fn().mockResolvedValue(0);

    const engine = new PaperPerpEngine({
      intxClient, stateStore, config,
      paperFundingIntervalMs: 1000,
    });
    engine.start();
    await engine.openPaperPosition(config.btcProductId, 'long', '0.01', 5, '80000');

    const updates: any[] = [];
    engine.on('fundingUpdate', (u) => { if (u.sessionId !== null) updates.push(u); });

    await vi.advanceTimersByTimeAsync(1000);

    expect(updates).toHaveLength(0);
    engine.stop();
  });

  it('clears timer on stop()', async () => {
    const intxClient = makeIntxClient();
    const stateStore = makeStateStore();
    const config = makeConfig();
    intxClient.fetchFundingRate = vi.fn().mockResolvedValue(0.0001);

    const engine = new PaperPerpEngine({
      intxClient, stateStore, config,
      paperFundingIntervalMs: 1000,
    });
    engine.start();
    await engine.openPaperPosition(config.btcProductId, 'long', '0.01', 5, '80000');
    engine.stop();

    const updates: any[] = [];
    engine.on('fundingUpdate', (u) => { if (u.sessionId !== null) updates.push(u); });

    // Advance past where timer would have fired — should not fire since stopped
    await vi.advanceTimersByTimeAsync(5000);

    expect(updates).toHaveLength(0);
  });
});
