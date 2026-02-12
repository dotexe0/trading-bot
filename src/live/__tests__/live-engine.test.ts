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
import type { Signal } from '../../strategies/types.js';

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
  return om as EventEmitter & {
    submitMarketOrder: ReturnType<typeof vi.fn>;
    submitStopLimitOrder: ReturnType<typeof vi.fn>;
    cancelAllOrders: ReturnType<typeof vi.fn>;
    reconcile: ReturnType<typeof vi.fn>;
    startTracking: ReturnType<typeof vi.fn>;
    stopTracking: ReturnType<typeof vi.fn>;
    getOpenOrders: ReturnType<typeof vi.fn>;
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
