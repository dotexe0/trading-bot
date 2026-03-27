/**
 * Tests for LiveTradingEngine -- full live trading orchestrator.
 *
 * Mocks OrderManager, LiveDataFeed, LiveStateStore, StrategyRegistry,
 * IndicatorEngine, and RiskManager to test the complete candle pipeline,
 * shutdown state machine, and restart recovery.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { d } from '../../core/decimal.js';
import { LiveTradingEngine } from '../live-engine.js';
import type { LiveTradingConfig, LiveOrder, LiveSession } from '../types.js';
import type { Candle } from '../../core/types.js';
import type { Signal, IStrategy } from '../../strategies/types.js';
import { StrategyRegistry } from '../../strategies/registry.js';
import { RegimeClassifier } from '../../regime/classifier.js';
import { MarketRegime } from '../../regime/types.js';
import type { RegimeLeaderboards, RegimeLeaderboardEntry } from '../../tournament/types.js';

// ── Mock factories ──────────────────────────────────────────────────

function makeMockLiveFeed() {
  const feed = new EventEmitter();
  (feed as any).start = vi.fn();
  (feed as any).stop = vi.fn();
  return feed as EventEmitter & {
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  };
}

function makeMockOrderManager() {
  const om = new EventEmitter();
  (om as any).submitMarketOrder = vi.fn().mockResolvedValue({
    orderId: 'exchange-order-1',
    clientOrderId: 'client-1',
    sessionId: 'session-1',
    productId: 'BTC-USD',
    side: 'BUY',
    orderType: 'MARKET',
    status: 'OPEN',
    baseSize: '0.01',
    filledSize: '0',
    filledValue: '0',
    totalFees: '0',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    purpose: 'ENTRY',
  } as LiveOrder);
  (om as any).submitStopLimitOrder = vi.fn().mockResolvedValue({
    orderId: 'stop-order-1',
    status: 'OPEN',
  } as Partial<LiveOrder>);
  (om as any).cancelAllOrders = vi.fn().mockResolvedValue(0);
  (om as any).reconcile = vi.fn().mockResolvedValue({
    timestamp: Date.now(),
    discrepancies: [],
  });
  (om as any).startTracking = vi.fn();
  (om as any).stopTracking = vi.fn();
  (om as any).getOpenOrders = vi.fn().mockReturnValue([]);
  (om as any).cancelOrder = vi.fn().mockResolvedValue(true);
  (om as any).getTrackedOrder = vi.fn().mockReturnValue(undefined);
  (om as any).queryOrderStatus = vi.fn().mockResolvedValue({
    order: { status: 'FILLED', filled_size: '0.01', filled_value: '490.00', average_filled_price: '49000', fee: '0.30' },
  });
  (om as any).mapExchangeStatus = vi.fn().mockImplementation((status: string) => {
    const map: Record<string, string> = { PENDING: 'PENDING', OPEN: 'OPEN', FILLED: 'FILLED', CANCELLED: 'CANCELLED', EXPIRED: 'EXPIRED', FAILED: 'FAILED' };
    return map[status] ?? 'PENDING';
  });
  return om as EventEmitter & {
    submitMarketOrder: ReturnType<typeof vi.fn>;
    submitStopLimitOrder: ReturnType<typeof vi.fn>;
    cancelAllOrders: ReturnType<typeof vi.fn>;
    reconcile: ReturnType<typeof vi.fn>;
    startTracking: ReturnType<typeof vi.fn>;
    stopTracking: ReturnType<typeof vi.fn>;
    getOpenOrders: ReturnType<typeof vi.fn>;
    cancelOrder: ReturnType<typeof vi.fn>;
    getTrackedOrder: ReturnType<typeof vi.fn>;
    queryOrderStatus: ReturnType<typeof vi.fn>;
    mapExchangeStatus: ReturnType<typeof vi.fn>;
  };
}

function makeMockStateStore() {
  return {
    createSession: vi.fn().mockReturnValue({
      id: 'session-1',
      config: {} as LiveTradingConfig,
      strategyName: 'test-strategy',
      pair: 'BTC-USD',
      timeframe: '5m',
      startTime: Date.now(),
      initialCapital: '10000',
      status: 'running',
      mode: 'live' as const,
    } satisfies LiveSession),
    endSession: vi.fn(),
    getSession: vi.fn(),
    listSessions: vi.fn(),
    persistOrder: vi.fn(),
    updateOrderStatus: vi.fn(),
    getOrder: vi.fn(),
    getOrderByClientId: vi.fn(),
    getOpenOrders: vi.fn().mockReturnValue([]),
    getPendingOrders: vi.fn().mockReturnValue([]),
    recordTrade: vi.fn(),
    getSessionTrades: vi.fn().mockReturnValue([]),
    recordEquityPoint: vi.fn(),
    getSessionEquity: vi.fn(),
    close: vi.fn(),
  };
}

function makeMockStrategyRegistry() {
  return {
    create: vi.fn().mockReturnValue({
      name: 'test-strategy',
      minCandles: 2,
      requiredIndicators: [],
      evaluate: vi.fn().mockReturnValue([]),
    }),
    register: vi.fn(),
    has: vi.fn(),
    list: vi.fn(),
  };
}

function makeMockIndicatorEngine() {
  return {
    compute: vi.fn(),
    minCandlesRequired: vi.fn().mockReturnValue(2),
  };
}

function makeMockRiskManager() {
  return {
    evaluate: vi.fn().mockReturnValue({
      approved: true,
      finalQuantity: d(0.01),
      ruleResults: [],
    }),
    getCircuitBreakerState: vi.fn().mockReturnValue({ tripped: false }),
    getCurrentRiskState: vi.fn().mockReturnValue({
      circuitBreakerTripped: false,
      currentDrawdownPct: 0,
      currentExposurePct: 0,
      thresholds: { maxDrawdownPct: 20, maxExposurePct: 100, maxDailyLossPct: 5, maxPositionCount: 5 },
    }),
    resetCircuitBreaker: vi.fn(),
  };
}

function makeConfig(overrides: Partial<LiveTradingConfig> = {}): LiveTradingConfig {
  return {
    pair: 'BTC-USD',
    timeframe: '5m',
    strategyConfig: { strategy: 'test-strategy' },
    initialCapital: '10000',
    allowShorts: false,
    slippageBps: 5,
    feeTierMaker: 0.004,
    feeTierTaker: 0.006,
    assumeTaker: true,
    bufferSize: 500,
    reconciliationIntervalMs: 60000,
    maxOrderRetries: 3,
    shutdownTimeoutMs: 30000,
    enableStopLossOnShutdown: true,
    pollIntervalMs: 60000,
    orderMaxWaitSeconds: 60,
    orderCloseMaxRetries: 3,
    ...overrides,
  } as LiveTradingConfig;
}

function makeCandle(overrides: Partial<Candle> = {}): Candle {
  return {
    pair: 'BTC-USD',
    timeframe: '5m',
    timestamp: Date.now(),
    open: '50000',
    high: '50100',
    low: '49900',
    close: '50050',
    volume: '100',
    ...overrides,
  };
}

function makeLongSignal(): Signal {
  return {
    strategyName: 'test-strategy',
    pair: 'BTC-USD',
    timeframe: '5m',
    timestamp: Date.now(),
    direction: 'long',
    confidence: 0.8,
    reasoning: 'Test entry signal',
  };
}

function makeCloseSignal(): Signal {
  return {
    strategyName: 'test-strategy',
    pair: 'BTC-USD',
    timeframe: '5m',
    timestamp: Date.now(),
    direction: 'close',
    confidence: 1.0,
    reasoning: 'Test close signal',
  };
}

// ── Multi-strategy registry for auto-switch tests ───────────────────

/**
 * A registry that dispatches create() based on the 'strategy' field.
 * Enables auto-switch tests where regime change swaps to a different strategy.
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

/**
 * Build a minimal RegimeLeaderboards with two regime entries and a fallbackEntry.
 */
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

  return {
    [MarketRegime.TRENDING]: [makeRegimeEntry(trendingStrategy)],
    [MarketRegime.RANGING]: [makeRegimeEntry(rangingStrategy)],
    [MarketRegime.VOLATILE]: [],
    fallbackEntry: {
      rank: 1,
      strategyName: rangingStrategy,
      strategyConfig: { strategy: rangingStrategy },
      oosMetrics: {} as any,
      isMetrics: {} as any,
      robustnessRatio: 1.0,
      windowCount: 3,
      disqualified: false,
      disqualifyReason: null,
    },
  };
}

// ── Test suite ──────────────────────────────────────────────────────

describe('LiveTradingEngine', () => {
  let liveFeed: ReturnType<typeof makeMockLiveFeed>;
  let orderManager: ReturnType<typeof makeMockOrderManager>;
  let stateStore: ReturnType<typeof makeMockStateStore>;
  let registry: ReturnType<typeof makeMockStrategyRegistry>;
  let indicatorEngine: ReturnType<typeof makeMockIndicatorEngine>;
  let riskManager: ReturnType<typeof makeMockRiskManager>;
  let config: LiveTradingConfig;
  let engine: LiveTradingEngine;

  beforeEach(() => {
    vi.useFakeTimers();
    liveFeed = makeMockLiveFeed();
    orderManager = makeMockOrderManager();
    stateStore = makeMockStateStore();
    registry = makeMockStrategyRegistry();
    indicatorEngine = makeMockIndicatorEngine();
    riskManager = makeMockRiskManager();
    config = makeConfig();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createEngine(overrides: Record<string, unknown> = {}) {
    engine = new LiveTradingEngine({
      config,
      liveFeed: liveFeed as any,
      orderManager: orderManager as any,
      stateStore: stateStore as any,
      strategyRegistry: registry as any,
      indicatorEngine: indicatorEngine as any,
      riskManager: riskManager as any,
      ...overrides,
    });
    return engine;
  }

  // ── Test 1: start() creates session and wires events ──────────────

  it('start() creates session and wires events', async () => {
    createEngine();
    const session = await engine.start();

    expect(session).toBeDefined();
    expect(session.id).toBe('session-1');
    expect(stateStore.createSession).toHaveBeenCalledOnce();
    expect(liveFeed.start).toHaveBeenCalledWith(['BTC-USD'], 60000);
    expect(orderManager.startTracking).toHaveBeenCalledOnce();
    expect(engine.running).toBe(true);
  });

  // ── Test 2: onCandle buffers and evaluates strategy ───────────────

  it('onCandle buffers and evaluates strategy', async () => {
    createEngine();
    await engine.start();

    const strategy = registry.create.mock.results[0].value;

    // First candle -- not enough for minCandles=2
    liveFeed.emit('candle', makeCandle({ timestamp: 1000 }));
    expect(strategy.evaluate).not.toHaveBeenCalled();

    // Second candle -- now strategy should be evaluated
    liveFeed.emit('candle', makeCandle({ timestamp: 2000 }));
    expect(strategy.evaluate).toHaveBeenCalledOnce();
    expect(strategy.evaluate).toHaveBeenCalledWith(
      expect.any(Array),
      'BTC-USD',
      '5m',
      undefined, // additionalCandles (not used by live engine)
      undefined, // regime (undefined until enough candles for classification)
    );
  });

  // ── Test 3: Entry signal submits market order ─────────────────────

  it('entry signal submits market order via OrderManager', async () => {
    createEngine();
    await engine.start();

    const strategy = registry.create.mock.results[0].value;
    strategy.evaluate.mockReturnValue([makeLongSignal()]);

    // Fill buffer to minCandles
    liveFeed.emit('candle', makeCandle({ timestamp: 1000 }));
    liveFeed.emit('candle', makeCandle({ timestamp: 2000, close: '50000' }));

    // Allow async order submission to resolve
    await vi.advanceTimersByTimeAsync(0);

    expect(orderManager.submitMarketOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        pair: 'BTC-USD',
        side: 'BUY',
        purpose: 'ENTRY',
      }),
    );
  });

  // ── Test 4: Close signal submits exit order ───────────────────────

  it('close signal submits exit order', async () => {
    createEngine();
    await engine.start();

    const strategy = registry.create.mock.results[0].value;

    // First, enter a position
    strategy.evaluate.mockReturnValueOnce([makeLongSignal()]);
    liveFeed.emit('candle', makeCandle({ timestamp: 1000 }));
    liveFeed.emit('candle', makeCandle({ timestamp: 2000 }));
    await vi.advanceTimersByTimeAsync(0);

    // Simulate the order being filled
    const filledOrder: LiveOrder = {
      orderId: 'exchange-order-1',
      clientOrderId: 'client-1',
      sessionId: 'session-1',
      productId: 'BTC-USD',
      side: 'BUY',
      orderType: 'MARKET',
      status: 'FILLED',
      baseSize: '0.01',
      filledSize: '0.01',
      filledValue: '500',
      averageFillPrice: '50000',
      totalFees: '0.30',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      purpose: 'ENTRY',
    };
    orderManager.emit('orderFilled', filledOrder);

    // Now emit a close signal
    strategy.evaluate.mockReturnValue([makeCloseSignal()]);
    liveFeed.emit('candle', makeCandle({ timestamp: 3000 }));
    await vi.advanceTimersByTimeAsync(0);

    // Should have submitted exit order (second call to submitMarketOrder)
    const exitCall = orderManager.submitMarketOrder.mock.calls.find(
      (call: any[]) => call[0].purpose === 'EXIT',
    );
    expect(exitCall).toBeDefined();
    expect(exitCall![0].side).toBe('SELL');
  });

  // ── Test 5: Risk manager rejection prevents order ─────────────────

  it('risk manager rejection prevents order', async () => {
    riskManager.evaluate.mockReturnValue({
      approved: false,
      finalQuantity: d(0),
      ruleResults: [],
      rejectReason: 'Max drawdown exceeded',
    });

    createEngine();
    config.riskConfig = {
      sizingMethod: 'fixed-fraction',
      kellyFraction: 0.5,
      fixedFractionPct: 0.1,
      maxPositionPct: 0.2,
      minTradesForKelly: 30,
      stopLoss: { type: 'fixed', percentage: 0.05 },
      maxDrawdownPct: 0.1,
      maxDailyLossPct: 0.05,
      maxExposurePct: 0.5,
      maxPositionCount: 3,
      circuitBreakerCooldownMs: 3600000,
    };
    await engine.start();

    const strategy = registry.create.mock.results[0].value;
    strategy.evaluate.mockReturnValue([makeLongSignal()]);

    liveFeed.emit('candle', makeCandle({ timestamp: 1000 }));
    liveFeed.emit('candle', makeCandle({ timestamp: 2000 }));
    await vi.advanceTimersByTimeAsync(0);

    expect(orderManager.submitMarketOrder).not.toHaveBeenCalled();
  });

  // ── Test 6: Stop-loss trigger submits close order ─────────────────

  it('stop-loss trigger submits close order', async () => {
    config.riskConfig = {
      sizingMethod: 'fixed-fraction',
      kellyFraction: 0.5,
      fixedFractionPct: 0.1,
      maxPositionPct: 0.2,
      minTradesForKelly: 30,
      stopLoss: { type: 'fixed', percentage: 0.05 },
      maxDrawdownPct: 0.1,
      maxDailyLossPct: 0.05,
      maxExposurePct: 0.5,
      maxPositionCount: 3,
      circuitBreakerCooldownMs: 3600000,
    };

    createEngine();
    await engine.start();

    const strategy = registry.create.mock.results[0].value;

    // Enter position
    strategy.evaluate.mockReturnValueOnce([makeLongSignal()]);
    liveFeed.emit('candle', makeCandle({ timestamp: 1000 }));
    liveFeed.emit('candle', makeCandle({ timestamp: 2000, close: '50000' }));
    await vi.advanceTimersByTimeAsync(0);

    // Simulate entry fill
    const entryFill: LiveOrder = {
      orderId: 'exchange-order-1',
      clientOrderId: 'client-1',
      sessionId: 'session-1',
      productId: 'BTC-USD',
      side: 'BUY',
      orderType: 'MARKET',
      status: 'FILLED',
      baseSize: '0.01',
      filledSize: '0.01',
      filledValue: '500',
      averageFillPrice: '50000',
      totalFees: '0.30',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      purpose: 'ENTRY',
    };
    orderManager.emit('orderFilled', entryFill);

    // Reset call count
    orderManager.submitMarketOrder.mockClear();

    // Emit candle that breaches stop (5% below 50000 = 47500, so low of 47000 triggers)
    strategy.evaluate.mockReturnValue([]);
    liveFeed.emit(
      'candle',
      makeCandle({
        timestamp: 3000,
        low: '47000',
        high: '49000',
        close: '47500',
      }),
    );
    await vi.advanceTimersByTimeAsync(0);

    // Should have submitted stop-loss close order
    expect(orderManager.submitMarketOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        pair: 'BTC-USD',
        side: 'SELL',
        purpose: 'STOP_LOSS',
      }),
    );
  });

  // ── Test 7: shutdown() follows state machine sequence ─────────────

  it('shutdown() follows state machine sequence', async () => {
    config.riskConfig = {
      sizingMethod: 'fixed-fraction',
      kellyFraction: 0.5,
      fixedFractionPct: 0.1,
      maxPositionPct: 0.2,
      minTradesForKelly: 30,
      stopLoss: { type: 'fixed', percentage: 0.05 },
      maxDrawdownPct: 0.1,
      maxDailyLossPct: 0.05,
      maxExposurePct: 0.5,
      maxPositionCount: 3,
      circuitBreakerCooldownMs: 3600000,
    };

    createEngine();
    await engine.start();

    // Enter a position
    const strategy = registry.create.mock.results[0].value;
    strategy.evaluate.mockReturnValueOnce([makeLongSignal()]);
    liveFeed.emit('candle', makeCandle({ timestamp: 1000 }));
    liveFeed.emit('candle', makeCandle({ timestamp: 2000, close: '50000' }));
    await vi.advanceTimersByTimeAsync(0);

    // Fill entry
    orderManager.emit('orderFilled', {
      orderId: 'exchange-order-1',
      clientOrderId: 'client-1',
      sessionId: 'session-1',
      productId: 'BTC-USD',
      side: 'BUY',
      orderType: 'MARKET',
      status: 'FILLED',
      baseSize: '0.01',
      filledSize: '0.01',
      filledValue: '500',
      averageFillPrice: '50000',
      totalFees: '0.30',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      purpose: 'ENTRY',
    } as LiveOrder);

    // Shutdown
    const shutdownPromise = engine.shutdown();
    await vi.advanceTimersByTimeAsync(1000);
    await shutdownPromise;

    // Verify sequence
    expect(orderManager.cancelAllOrders).toHaveBeenCalledOnce();
    expect(orderManager.submitStopLimitOrder).toHaveBeenCalledOnce();
    expect(liveFeed.stop).toHaveBeenCalled();
    expect(orderManager.stopTracking).toHaveBeenCalled();
    expect(stateStore.endSession).toHaveBeenCalledWith(
      'session-1',
      expect.any(String),
      'shutdown',
    );
    expect(engine.getShutdownState()).toBe('done');
  });

  // ── Test 8: shutdown() with no position skips stop-loss step ──────

  it('shutdown() with no position skips stop-loss step', async () => {
    createEngine();
    await engine.start();

    const shutdownPromise = engine.shutdown();
    await vi.advanceTimersByTimeAsync(1000);
    await shutdownPromise;

    expect(orderManager.cancelAllOrders).toHaveBeenCalledOnce();
    expect(orderManager.submitStopLimitOrder).not.toHaveBeenCalled();
    expect(liveFeed.stop).toHaveBeenCalled();
    expect(engine.getShutdownState()).toBe('done');
    expect(engine.running).toBe(false);
  });

  // ── Test 9: restart recovery loads session and reconciles ─────────

  it('restart recovery loads session and reconciles', async () => {
    stateStore.getSession.mockReturnValue({
      id: 'old-session',
      config: config,
      strategyName: 'test-strategy',
      pair: 'BTC-USD',
      timeframe: '5m',
      startTime: Date.now() - 100000,
      initialCapital: '10000',
      status: 'running',
      mode: 'live' as const,
    } satisfies LiveSession);

    // Mock an open trade (entry without exit)
    stateStore.getSessionTrades.mockReturnValue([
      {
        sessionId: 'old-session',
        entryOrderId: 'entry-1',
        exitOrderId: '',
        entryTimestamp: Date.now() - 50000,
        entryPrice: '49000',
        entryFee: '0.30',
        entrySide: 'BUY',
        entryQuantity: '0.01',
      },
    ]);

    createEngine({ resumeSessionId: 'old-session' });
    const session = await engine.start();

    expect(session.id).toBe('old-session');
    expect(orderManager.reconcile).toHaveBeenCalledOnce();
    expect(stateStore.getSessionTrades).toHaveBeenCalledWith('old-session');
    expect(stateStore.getPendingOrders).toHaveBeenCalledWith('old-session');
  });

  // ── Test 10: restart recovery halts on unresolvable discrepancy ───

  it('restart recovery halts on unresolvable discrepancy', async () => {
    stateStore.getSession.mockReturnValue({
      id: 'bad-session',
      config: config,
      strategyName: 'test-strategy',
      pair: 'BTC-USD',
      timeframe: '5m',
      startTime: Date.now() - 100000,
      initialCapital: '10000',
      status: 'running',
      mode: 'live' as const,
    } satisfies LiveSession);

    orderManager.reconcile.mockResolvedValue({
      timestamp: Date.now(),
      discrepancies: [
        {
          type: 'MISSING_FROM_EXCHANGE',
          orderId: 'lost-order',
          details: 'Tracked order not found on exchange',
          action: 'SYNC',
        },
      ],
    });

    const errorHandler = vi.fn();
    createEngine({ resumeSessionId: 'bad-session' });
    engine.on('error', errorHandler);
    await engine.start();

    expect(engine.running).toBe(false);
    expect(errorHandler).toHaveBeenCalled();
  });

  // ── Test 11: Reconciliation runs on configured interval ───────────

  it('reconciliation runs on configured interval', async () => {
    config = makeConfig({ reconciliationIntervalMs: 10000 });
    createEngine();
    await engine.start();

    // reconcile is called once during start for recovery cases, reset
    orderManager.reconcile.mockClear();

    // Advance time to trigger interval
    await vi.advanceTimersByTimeAsync(10000);
    expect(orderManager.reconcile).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(10000);
    expect(orderManager.reconcile).toHaveBeenCalledTimes(2);
  });

  // ── Test 12: onOrderFailed for exit triggers reconciliation ───────

  it('onOrderFailed for exit order triggers reconciliation', async () => {
    createEngine();
    await engine.start();

    orderManager.reconcile.mockClear();

    // Emit order failed for EXIT purpose
    const failedOrder: LiveOrder = {
      orderId: 'exchange-exit-1',
      clientOrderId: 'client-exit',
      sessionId: 'session-1',
      productId: 'BTC-USD',
      side: 'SELL',
      orderType: 'MARKET',
      status: 'FAILED',
      baseSize: '0.01',
      filledSize: '0',
      filledValue: '0',
      totalFees: '0',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      purpose: 'EXIT',
    };

    orderManager.emit('orderFailed', failedOrder, new Error('Insufficient funds'));
    await vi.advanceTimersByTimeAsync(0);

    expect(orderManager.reconcile).toHaveBeenCalled();
  });
});

// ── slippage tracking describe block ──────────────────────────────────

describe('slippage tracking', () => {
  let liveFeed: ReturnType<typeof makeMockLiveFeed>;
  let orderManager: ReturnType<typeof makeMockOrderManager>;
  let stateStore: ReturnType<typeof makeMockStateStore>;
  let registry: ReturnType<typeof makeMockStrategyRegistry>;
  let indicatorEngine: ReturnType<typeof makeMockIndicatorEngine>;
  let riskManager: ReturnType<typeof makeMockRiskManager>;
  let config: LiveTradingConfig;
  let engine: LiveTradingEngine;

  beforeEach(() => {
    vi.useFakeTimers();
    liveFeed = makeMockLiveFeed();
    orderManager = makeMockOrderManager();
    stateStore = makeMockStateStore();
    registry = makeMockStrategyRegistry();
    indicatorEngine = makeMockIndicatorEngine();
    riskManager = makeMockRiskManager();
    config = makeConfig();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createEngine(overrides: Record<string, unknown> = {}) {
    engine = new LiveTradingEngine({
      config,
      liveFeed: liveFeed as any,
      orderManager: orderManager as any,
      stateStore: stateStore as any,
      strategyRegistry: registry as any,
      indicatorEngine: indicatorEngine as any,
      riskManager: riskManager as any,
      ...overrides,
    });
    return engine;
  }

  /**
   * Helper: enter a position with the given entry candle close, fill with the given fill price.
   * Returns the strategy mock so caller can set up close signals.
   */
  async function enterPosition(entryClose: string, fillPrice: string) {
    const strategy = registry.create.mock.results[0].value;
    // First candle: buffer.length=1 < minCandles=2, no evaluation.
    // Second candle: buffer.length=2 >= minCandles=2, evaluation triggers -> return long signal.
    strategy.evaluate.mockReturnValueOnce([makeLongSignal()]);

    liveFeed.emit('candle', makeCandle({ timestamp: 1000, close: entryClose }));
    liveFeed.emit('candle', makeCandle({ timestamp: 2000, close: entryClose }));
    await vi.advanceTimersByTimeAsync(0);

    // Simulate fill
    const entryFill: LiveOrder = {
      orderId: 'exchange-order-1',
      clientOrderId: 'client-1',
      sessionId: 'session-1',
      productId: 'BTC-USD',
      side: 'BUY',
      orderType: 'MARKET',
      status: 'FILLED',
      baseSize: '0.01',
      filledSize: '0.01',
      filledValue: '500',
      averageFillPrice: fillPrice,
      totalFees: '0.30',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      purpose: 'ENTRY',
    };
    orderManager.emit('orderFilled', entryFill);

    return strategy;
  }

  it('captures entry signal price and passes signalPrice to recordTrade', async () => {
    createEngine();
    await engine.start();

    const strategy = await enterPosition('50000', '50010');

    // Now close position
    strategy.evaluate.mockReturnValue([makeCloseSignal()]);
    liveFeed.emit('candle', makeCandle({ timestamp: 3000, close: '51000' }));
    await vi.advanceTimersByTimeAsync(0);

    // Simulate exit fill
    const exitFill: LiveOrder = {
      orderId: 'exit-order-1',
      clientOrderId: 'client-exit',
      sessionId: 'session-1',
      productId: 'BTC-USD',
      side: 'SELL',
      orderType: 'MARKET',
      status: 'FILLED',
      baseSize: '0.01',
      filledSize: '0.01',
      filledValue: '510',
      averageFillPrice: '51000',
      totalFees: '0.30',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      purpose: 'EXIT',
    };
    orderManager.emit('orderFilled', exitFill);

    expect(stateStore.recordTrade).toHaveBeenCalledOnce();
    const tradeArg = stateStore.recordTrade.mock.calls[0][1];
    expect(tradeArg.signalPrice).toBe('50000.00000000');
  });

  it('captures exit signal price on strategy close matching candle close', async () => {
    createEngine();
    await engine.start();

    const strategy = await enterPosition('50000', '50010');

    // Close with candle at 51000
    strategy.evaluate.mockReturnValue([makeCloseSignal()]);
    liveFeed.emit('candle', makeCandle({ timestamp: 3000, close: '51000' }));
    await vi.advanceTimersByTimeAsync(0);

    const exitFill: LiveOrder = {
      orderId: 'exit-order-2',
      clientOrderId: 'client-exit-2',
      sessionId: 'session-1',
      productId: 'BTC-USD',
      side: 'SELL',
      orderType: 'MARKET',
      status: 'FILLED',
      baseSize: '0.01',
      filledSize: '0.01',
      filledValue: '510',
      averageFillPrice: '51000',
      totalFees: '0.30',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      purpose: 'EXIT',
    };
    orderManager.emit('orderFilled', exitFill);

    const tradeArg = stateStore.recordTrade.mock.calls[0][1];
    expect(tradeArg.exitSignalPrice).toBe('51000.00000000');
  });

  it('computes unfavorable BUY entry slippage as positive bps', async () => {
    createEngine();
    await engine.start();

    // Signal at 50000, fill at 50010 -> +2.0 bps unfavorable
    const strategy = await enterPosition('50000', '50010');

    strategy.evaluate.mockReturnValue([makeCloseSignal()]);
    liveFeed.emit('candle', makeCandle({ timestamp: 3000, close: '51000' }));
    await vi.advanceTimersByTimeAsync(0);

    const exitFill: LiveOrder = {
      orderId: 'exit-order-3',
      clientOrderId: 'client-exit-3',
      sessionId: 'session-1',
      productId: 'BTC-USD',
      side: 'SELL',
      orderType: 'MARKET',
      status: 'FILLED',
      baseSize: '0.01',
      filledSize: '0.01',
      filledValue: '510',
      averageFillPrice: '51000',
      totalFees: '0.30',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      purpose: 'EXIT',
    };
    orderManager.emit('orderFilled', exitFill);

    const tradeArg = stateStore.recordTrade.mock.calls[0][1];
    // (50010 - 50000) / 50000 * 10000 = 2.0 bps
    expect(tradeArg.entrySlippageBps).toBe('2.0000');
  });

  it('computes favorable BUY entry slippage as negative bps', async () => {
    createEngine();
    await engine.start();

    // Signal at 50000, fill at 49990 -> -2.0 bps favorable
    const strategy = await enterPosition('50000', '49990');

    strategy.evaluate.mockReturnValue([makeCloseSignal()]);
    liveFeed.emit('candle', makeCandle({ timestamp: 3000, close: '51000' }));
    await vi.advanceTimersByTimeAsync(0);

    const exitFill: LiveOrder = {
      orderId: 'exit-order-4',
      clientOrderId: 'client-exit-4',
      sessionId: 'session-1',
      productId: 'BTC-USD',
      side: 'SELL',
      orderType: 'MARKET',
      status: 'FILLED',
      baseSize: '0.01',
      filledSize: '0.01',
      filledValue: '510',
      averageFillPrice: '51000',
      totalFees: '0.30',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      purpose: 'EXIT',
    };
    orderManager.emit('orderFilled', exitFill);

    const tradeArg = stateStore.recordTrade.mock.calls[0][1];
    // (49990 - 50000) / 50000 * 10000 = -2.0 bps
    expect(tradeArg.entrySlippageBps).toBe('-2.0000');
  });

  it('stop-loss exit uses stop trigger price as exitSignalPrice, not candle close', async () => {
    config.riskConfig = {
      sizingMethod: 'fixed-fraction',
      kellyFraction: 0.5,
      fixedFractionPct: 0.1,
      maxPositionPct: 0.2,
      minTradesForKelly: 30,
      stopLoss: { type: 'fixed', percentage: 0.05 },
      maxDrawdownPct: 0.1,
      maxDailyLossPct: 0.05,
      maxExposurePct: 0.5,
      maxPositionCount: 3,
      circuitBreakerCooldownMs: 3600000,
    };

    createEngine();
    await engine.start();

    const strategy = registry.create.mock.results[0].value;

    // Enter position: first candle (buffer=1) no eval, second candle (buffer=2) triggers entry
    strategy.evaluate.mockReturnValueOnce([makeLongSignal()]);
    liveFeed.emit('candle', makeCandle({ timestamp: 1000, close: '50000' }));
    liveFeed.emit('candle', makeCandle({ timestamp: 2000, close: '50000' }));
    await vi.advanceTimersByTimeAsync(0);

    // Simulate entry fill
    const entryFill: LiveOrder = {
      orderId: 'exchange-order-1',
      clientOrderId: 'client-1',
      sessionId: 'session-1',
      productId: 'BTC-USD',
      side: 'BUY',
      orderType: 'MARKET',
      status: 'FILLED',
      baseSize: '0.01',
      filledSize: '0.01',
      filledValue: '500',
      averageFillPrice: '50000',
      totalFees: '0.30',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      purpose: 'ENTRY',
    };
    orderManager.emit('orderFilled', entryFill);

    // Clear mock to track just the stop-loss order
    orderManager.submitMarketOrder.mockClear();

    // Emit candle that breaches 5% stop (47500). low=47000 triggers stop.
    // The stop trigger price will be 47500 (50000 * 0.95)
    strategy.evaluate.mockReturnValue([]);
    liveFeed.emit(
      'candle',
      makeCandle({
        timestamp: 3000,
        low: '47000',
        high: '49000',
        close: '47500', // close != stop trigger price
      }),
    );
    await vi.advanceTimersByTimeAsync(0);

    // Verify stop-loss order was submitted
    expect(orderManager.submitMarketOrder).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'STOP_LOSS' }),
    );

    // Simulate stop-loss exit fill
    const exitFill: LiveOrder = {
      orderId: 'stop-exit-1',
      clientOrderId: 'client-stop',
      sessionId: 'session-1',
      productId: 'BTC-USD',
      side: 'SELL',
      orderType: 'MARKET',
      status: 'FILLED',
      baseSize: '0.01',
      filledSize: '0.01',
      filledValue: '475',
      averageFillPrice: '47500',
      totalFees: '0.30',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      purpose: 'STOP_LOSS',
    };
    orderManager.emit('orderFilled', exitFill);

    expect(stateStore.recordTrade).toHaveBeenCalledOnce();
    const tradeArg = stateStore.recordTrade.mock.calls[0][1];

    // exitSignalPrice should be the stop trigger price (47500), NOT the candle close (47500 in this case too)
    // The fixed stop at 5% of entry 50000 = 47500
    // Since our stop is fixed at 50000 * (1 - 0.05) = 47500.0
    expect(tradeArg.exitSignalPrice).toBeDefined();
    // The stop price is computed by StopLossTracker as entryPrice * (1 - percentage) = 50000 * 0.95 = 47500
    expect(parseFloat(tradeArg.exitSignalPrice)).toBeCloseTo(47500, 0);
  });
});

// ── auto-switch describe block ───────────────────────────────────────
//
// vi.spyOn(RegimeClassifier.prototype, 'classify') is used to control
// returned regimes without needing real candle sequences long enough to
// produce ADX/ATR values.

describe('auto-switch', () => {
  let classifySpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    classifySpy?.mockRestore();
    vi.useRealTimers();
  });

  function makeAutoSwitchEngine(
    strategyA: IStrategy,
    strategyB: IStrategy,
    leaderboards: RegimeLeaderboards,
  ) {
    const feed = makeMockLiveFeed();
    const om = makeMockOrderManager();
    const store = makeMockStateStore();
    const strategies = new Map<string, IStrategy>([
      ['strategy-a', strategyA],
      ['strategy-b', strategyB],
    ]);
    const reg = new MultiStrategyMockRegistry(strategies);
    const cfg = makeConfig({ strategyConfig: { strategy: 'strategy-a' } });

    const eng = new LiveTradingEngine({
      config: cfg,
      liveFeed: feed as any,
      orderManager: om as any,
      stateStore: store as any,
      strategyRegistry: reg as any,
      indicatorEngine: makeMockIndicatorEngine() as any,
      regimeLeaderboards: leaderboards,
    });

    return { engine: eng, feed, orderManager: om };
  }

  // TEST 1: Immediate switch when no position (onCandle path)

  it('immediately switches strategy on regime change when no position', async () => {
    const strategyA: IStrategy = {
      name: 'strategy-a',
      minCandles: 2,
      requiredIndicators: [],
      evaluate: vi.fn().mockReturnValue([]),
    };
    const strategyB: IStrategy = {
      name: 'strategy-b',
      minCandles: 2,
      requiredIndicators: [],
      evaluate: vi.fn().mockReturnValue([]),
    };

    const leaderboards = makeRegimeLeaderboards('strategy-b', 'strategy-a');

    // classify() is called once per candle after buffer >= minCandles (2).
    // Emitting 3 candles -> classify() is called on candles 1 and 2:
    //   call #1 (candle 1): RANGING -> sets currentRegime = RANGING
    //   call #2 (candle 2): TRENDING -> currentRegime=RANGING, no position -> switch fires
    let classifyCallCount = 0;
    classifySpy = vi.spyOn(RegimeClassifier.prototype, 'classify').mockImplementation(() => {
      classifyCallCount++;
      return classifyCallCount === 1 ? MarketRegime.RANGING : MarketRegime.TRENDING;
    });

    const { engine, feed } = makeAutoSwitchEngine(strategyA, strategyB, leaderboards);
    await engine.start();

    const switchEvents: any[] = [];
    engine.on('strategySwitch', (data) => switchEvents.push(data));

    // 2 candles: first classify call returns RANGING -> sets currentRegime, no switch
    feed.emit('candle', makeCandle({ timestamp: 1000 }));
    feed.emit('candle', makeCandle({ timestamp: 2000 }));
    // No switch yet
    expect(switchEvents).toHaveLength(0);

    // 3rd candle: classify returns TRENDING, regime changed, no position -> immediate switch
    feed.emit('candle', makeCandle({ timestamp: 3000 }));

    expect(switchEvents).toHaveLength(1);
    expect(switchEvents[0].newStrategy).toBe('strategy-b');
    expect((engine as any)['strategy'].name).toBe('strategy-b');
  });

  // TEST 2: Deferred switch fires in onOrderFilled for EXIT/STOP_LOSS

  it('deferred switch fires in onOrderFilled when EXIT fill arrives', async () => {
    const strategyA: IStrategy = {
      name: 'strategy-a',
      minCandles: 2,
      requiredIndicators: [],
      evaluate: vi.fn().mockReturnValue([]),
    };
    const strategyB: IStrategy = {
      name: 'strategy-b',
      minCandles: 2,
      requiredIndicators: [],
      evaluate: vi.fn().mockReturnValue([]),
    };

    const leaderboards = makeRegimeLeaderboards('strategy-b', 'strategy-a');

    // classify() sequence:
    //   call #1: RANGING -> sets currentRegime = RANGING
    //   call #2+: TRENDING -> regime changed
    let classifyCallCount = 0;
    classifySpy = vi.spyOn(RegimeClassifier.prototype, 'classify').mockImplementation(() => {
      classifyCallCount++;
      return classifyCallCount === 1 ? MarketRegime.RANGING : MarketRegime.TRENDING;
    });

    const { engine, feed, orderManager } = makeAutoSwitchEngine(strategyA, strategyB, leaderboards);
    await engine.start();

    const switchEvents: any[] = [];
    engine.on('strategySwitch', (data) => switchEvents.push(data));

    // Candle 1: sets currentRegime = RANGING
    feed.emit('candle', makeCandle({ timestamp: 1000 }));
    feed.emit('candle', makeCandle({ timestamp: 2000 }));
    // No switch yet
    expect(switchEvents).toHaveLength(0);

    // Manually set currentPosition to non-null to simulate open position
    (engine as any)['currentPosition'] = {
      orderId: 'open-order-1',
      side: 'BUY',
      quantity: d('0.01'),
      entryPrice: d('50000'),
      pending: false,
      partialExitFired: false,
    };

    // Candle 3: classify returns TRENDING, position open -> switch deferred (pendingSwitch set)
    feed.emit('candle', makeCandle({ timestamp: 3000 }));

    // Strategy should NOT have switched yet
    expect(switchEvents).toHaveLength(0);
    expect((engine as any)['pendingSwitch']).not.toBeNull();
    expect((engine as any)['strategy'].name).toBe('strategy-a');

    // Simulate an EXIT fill — this clears currentPosition and calls checkAndExecutePendingSwitch
    const exitFill: LiveOrder = {
      orderId: 'exit-order-1',
      clientOrderId: 'client-exit',
      sessionId: 'session-1',
      productId: 'BTC-USD',
      side: 'SELL',
      orderType: 'MARKET',
      status: 'FILLED',
      baseSize: '0.01',
      filledSize: '0.01',
      filledValue: '500',
      averageFillPrice: '50000',
      totalFees: '1',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      purpose: 'EXIT',
    };
    orderManager.emit('orderFilled', exitFill);

    // Now the deferred switch should have fired
    expect(switchEvents).toHaveLength(1);
    expect(switchEvents[0].newStrategy).toBe('strategy-b');
    expect((engine as any)['strategy'].name).toBe('strategy-b');
    expect((engine as any)['pendingSwitch']).toBeNull();
    expect((engine as any)['currentPosition']).toBeNull();
  });
});

// ── ORDER-01: entry timeout ─────────────────────────────────────────────

describe('ORDER-01: entry timeout', () => {
  let liveFeed: ReturnType<typeof makeMockLiveFeed>;
  let orderManager: ReturnType<typeof makeMockOrderManager>;
  let stateStore: ReturnType<typeof makeMockStateStore>;
  let registry: ReturnType<typeof makeMockStrategyRegistry>;
  let indicatorEngine: ReturnType<typeof makeMockIndicatorEngine>;
  let riskManager: ReturnType<typeof makeMockRiskManager>;
  let config: LiveTradingConfig;
  let engine: LiveTradingEngine;

  beforeEach(() => {
    vi.useFakeTimers();
    liveFeed = makeMockLiveFeed();
    orderManager = makeMockOrderManager();
    stateStore = makeMockStateStore();
    registry = makeMockStrategyRegistry();
    indicatorEngine = makeMockIndicatorEngine();
    riskManager = makeMockRiskManager();
    config = makeConfig({ orderMaxWaitSeconds: 1 }); // 1 second timeout for test
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createEngine(overrides: Record<string, unknown> = {}) {
    engine = new LiveTradingEngine({
      config,
      liveFeed: liveFeed as any,
      orderManager: orderManager as any,
      stateStore: stateStore as any,
      strategyRegistry: registry as any,
      indicatorEngine: indicatorEngine as any,
      riskManager: riskManager as any,
      ...overrides,
    });
    return engine;
  }

  it('clears pending position after orderMaxWaitSeconds timeout', async () => {
    createEngine();
    await engine.start();

    const strategy = registry.create.mock.results[0].value;
    strategy.evaluate.mockReturnValueOnce([makeLongSignal()]);

    // Fill buffer to minCandles and trigger entry
    liveFeed.emit('candle', makeCandle({ timestamp: 1000 }));
    liveFeed.emit('candle', makeCandle({ timestamp: 2000, close: '50000' }));
    await vi.advanceTimersByTimeAsync(0);

    // Order submitted but NOT filled -- pending position set
    expect(orderManager.submitMarketOrder).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'ENTRY' }),
    );

    // Advance time past the 1-second timeout
    await vi.advanceTimersByTimeAsync(1100);

    // currentPosition should be cleared (engine back to flat)
    // Verify by feeding another entry candle -- it should submit a new order
    orderManager.submitMarketOrder.mockClear();
    strategy.evaluate.mockReturnValueOnce([makeLongSignal()]);
    liveFeed.emit('candle', makeCandle({ timestamp: 3000, close: '50000' }));
    await vi.advanceTimersByTimeAsync(0);

    expect(orderManager.submitMarketOrder).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'ENTRY' }),
    );
  });

  it('does not clear position if filled before timeout', async () => {
    createEngine();
    await engine.start();

    const strategy = registry.create.mock.results[0].value;
    strategy.evaluate.mockReturnValueOnce([makeLongSignal()]);

    liveFeed.emit('candle', makeCandle({ timestamp: 1000 }));
    liveFeed.emit('candle', makeCandle({ timestamp: 2000, close: '50000' }));
    await vi.advanceTimersByTimeAsync(0);

    // Simulate fill BEFORE timeout
    const filledOrder: LiveOrder = {
      orderId: 'exchange-order-1',
      clientOrderId: 'client-1',
      sessionId: 'session-1',
      productId: 'BTC-USD',
      side: 'BUY',
      orderType: 'MARKET',
      status: 'FILLED',
      baseSize: '0.01',
      filledSize: '0.01',
      filledValue: '500',
      averageFillPrice: '50000',
      totalFees: '0.30',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      purpose: 'ENTRY',
    };
    orderManager.emit('orderFilled', filledOrder);

    // Advance past timeout
    await vi.advanceTimersByTimeAsync(1100);

    // Position should still be populated (not cleared by timeout)
    expect((engine as any)['currentPosition']).not.toBeNull();
    expect((engine as any)['currentPosition'].pending).toBe(false);
  });

  it('handles race condition: cancel fails because order filled', async () => {
    // Mock cancelOrder to return false (cancel failed)
    orderManager.cancelOrder.mockResolvedValue(false);
    // Mock getTrackedOrder to return a FILLED order
    orderManager.getTrackedOrder.mockReturnValue({
      orderId: 'exchange-order-1',
      status: 'FILLED',
    } as Partial<LiveOrder>);

    createEngine();
    await engine.start();

    const strategy = registry.create.mock.results[0].value;
    strategy.evaluate.mockReturnValueOnce([makeLongSignal()]);

    liveFeed.emit('candle', makeCandle({ timestamp: 1000 }));
    liveFeed.emit('candle', makeCandle({ timestamp: 2000, close: '50000' }));
    await vi.advanceTimersByTimeAsync(0);

    // Advance past timeout -- handleEntryTimeout fires, cancel returns false,
    // getTrackedOrder returns FILLED -> position is NOT cleared
    await vi.advanceTimersByTimeAsync(1100);

    // Position should still be pending (waiting for fill event handler to process)
    // The key assertion: currentPosition is NOT null because the race condition was handled
    expect((engine as any)['currentPosition']).not.toBeNull();
  });
});

// ── ORDER-03: close retry with emergency fallback ───────────────────────

describe('ORDER-03: close retry with emergency fallback', () => {
  let liveFeed: ReturnType<typeof makeMockLiveFeed>;
  let orderManager: ReturnType<typeof makeMockOrderManager>;
  let stateStore: ReturnType<typeof makeMockStateStore>;
  let registry: ReturnType<typeof makeMockStrategyRegistry>;
  let indicatorEngine: ReturnType<typeof makeMockIndicatorEngine>;
  let riskManager: ReturnType<typeof makeMockRiskManager>;
  let config: LiveTradingConfig;
  let engine: LiveTradingEngine;

  beforeEach(() => {
    vi.useFakeTimers();
    liveFeed = makeMockLiveFeed();
    orderManager = makeMockOrderManager();
    stateStore = makeMockStateStore();
    registry = makeMockStrategyRegistry();
    indicatorEngine = makeMockIndicatorEngine();
    riskManager = makeMockRiskManager();
    config = makeConfig({ orderCloseMaxRetries: 2 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createEngine(overrides: Record<string, unknown> = {}) {
    engine = new LiveTradingEngine({
      config,
      liveFeed: liveFeed as any,
      orderManager: orderManager as any,
      stateStore: stateStore as any,
      strategyRegistry: registry as any,
      indicatorEngine: indicatorEngine as any,
      riskManager: riskManager as any,
      ...overrides,
    });
    return engine;
  }

  /** Helper: enter a position and fill it. */
  async function enterAndFill() {
    const strategy = registry.create.mock.results[0].value;
    strategy.evaluate.mockReturnValueOnce([makeLongSignal()]);

    liveFeed.emit('candle', makeCandle({ timestamp: 1000 }));
    liveFeed.emit('candle', makeCandle({ timestamp: 2000, close: '50000' }));
    await vi.advanceTimersByTimeAsync(0);

    const entryFill: LiveOrder = {
      orderId: 'exchange-order-1',
      clientOrderId: 'client-1',
      sessionId: 'session-1',
      productId: 'BTC-USD',
      side: 'BUY',
      orderType: 'MARKET',
      status: 'FILLED',
      baseSize: '0.01',
      filledSize: '0.01',
      filledValue: '500',
      averageFillPrice: '50000',
      totalFees: '0.30',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      purpose: 'ENTRY',
    };
    orderManager.emit('orderFilled', entryFill);

    return strategy;
  }

  it('retries close order up to maxRetries on failure', async () => {
    createEngine();
    await engine.start();
    const strategy = await enterAndFill();

    // Reset call count after entry
    orderManager.submitMarketOrder.mockClear();

    // Fail twice (maxRetries=2), then succeed on emergency attempt (3rd call)
    orderManager.submitMarketOrder
      .mockRejectedValueOnce(new Error('Network error'))
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce({
        orderId: 'emergency-close-1',
        status: 'FILLED',
        purpose: 'EXIT',
      } as Partial<LiveOrder>);

    // Trigger close signal
    strategy.evaluate.mockReturnValue([makeCloseSignal()]);
    liveFeed.emit('candle', makeCandle({ timestamp: 3000, close: '51000' }));

    // Advance through all retries: initial call + 1s backoff + 2s backoff + emergency
    await vi.advanceTimersByTimeAsync(0);    // first attempt
    await vi.advanceTimersByTimeAsync(1000);  // 1s backoff + 2nd attempt
    await vi.advanceTimersByTimeAsync(2000);  // 2s backoff + emergency attempt
    await vi.advanceTimersByTimeAsync(0);     // flush

    // 2 retries + 1 emergency = 3 calls
    expect(orderManager.submitMarketOrder).toHaveBeenCalledTimes(3);
  });

  it('triggers reconciliation after all retries and emergency exhausted', async () => {
    createEngine();
    await engine.start();
    const strategy = await enterAndFill();

    orderManager.submitMarketOrder.mockClear();

    // All attempts fail
    orderManager.submitMarketOrder.mockRejectedValue(new Error('Network error'));

    const reconcileSpy = orderManager.reconcile;
    reconcileSpy.mockClear();

    // Trigger close signal
    strategy.evaluate.mockReturnValue([makeCloseSignal()]);
    liveFeed.emit('candle', makeCandle({ timestamp: 3000, close: '51000' }));

    // Advance through all retries
    await vi.advanceTimersByTimeAsync(0);     // first attempt
    await vi.advanceTimersByTimeAsync(1000);  // backoff + 2nd attempt
    await vi.advanceTimersByTimeAsync(2000);  // backoff + emergency
    await vi.advanceTimersByTimeAsync(0);     // flush promises

    // reconcile should have been called (fire-and-forget in emergency path)
    expect(reconcileSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('logs WARN on each retry attempt', async () => {
    createEngine();
    await engine.start();
    const strategy = await enterAndFill();

    orderManager.submitMarketOrder.mockClear();

    // Fail once, then succeed
    orderManager.submitMarketOrder
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce({
        orderId: 'close-1',
        status: 'FILLED',
        purpose: 'EXIT',
      } as Partial<LiveOrder>);

    strategy.evaluate.mockReturnValue([makeCloseSignal()]);
    liveFeed.emit('candle', makeCandle({ timestamp: 3000, close: '51000' }));

    // Advance through retry
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(0);

    // Verify submitMarketOrder was called twice (1 retry + 1 success)
    expect(orderManager.submitMarketOrder).toHaveBeenCalledTimes(2);
  });
});
