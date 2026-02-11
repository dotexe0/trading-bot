/**
 * Tests for PaperTradingEngine.
 *
 * Uses a mock LiveDataFeed (EventEmitter) and mock SessionStore.
 * Uses real FillSimulator and PortfolioTracker for accurate financial math.
 * Uses MockStrategyRegistry to bypass Zod validation for test strategies.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { d, ZERO } from '../../core/decimal.js';
import { PaperTradingEngine } from '../paper-engine.js';
import type { PaperTradingConfig, PaperSession, PaperTradingResult } from '../types.js';
import type { Candle } from '../../core/types.js';
import type { Signal, IStrategy } from '../../strategies/types.js';
import { StrategyRegistry } from '../../strategies/registry.js';
import { IndicatorEngine } from '../../indicators/engine.js';
import { RiskManager } from '../../risk/risk-manager.js';
import type { RiskConfig } from '../../risk/types.js';

// ── Mock LiveDataFeed ─────────────────────────────────────────────────

class MockLiveDataFeed extends EventEmitter {
  started = false;
  stopped = false;

  start(_pairs: string[], _pollMs?: number): void {
    this.started = true;
  }

  stop(): void {
    this.stopped = true;
  }

  // Override on/emit for typed events (match LiveDataFeed interface)
  override on(event: string, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  emitCandle(candle: Candle): void {
    this.emit('candle', candle);
  }
}

// ── Mock SessionStore ─────────────────────────────────────────────────

function createMockSessionStore() {
  const trades: any[] = [];
  const equityPoints: any[] = [];
  let sessionId = 'test-session-001';

  return {
    createSession: vi.fn((_config: PaperTradingConfig, strategyName: string): PaperSession => ({
      id: sessionId,
      config: _config,
      strategyName,
      pair: _config.pair,
      timeframe: _config.timeframe,
      startTime: Date.now(),
      initialCapital: _config.initialCapital,
      status: 'running' as const,
    })),
    endSession: vi.fn(),
    recordTrade: vi.fn((sid: string, trade: any) => {
      trades.push(trade);
    }),
    recordEquityPoint: vi.fn((sid: string, ts: number, equity: any) => {
      equityPoints.push({ timestamp: ts, equity });
    }),
    getResult: vi.fn((): PaperTradingResult => ({
      session: {
        id: sessionId,
        config: makeConfig(),
        strategyName: 'test-strategy',
        pair: 'BTC-USD',
        timeframe: '1m',
        startTime: Date.now(),
        initialCapital: '10000',
        status: 'stopped',
      },
      trades,
      equityCurve: equityPoints.map((ep) => ({
        timestamp: ep.timestamp,
        equity: ep.equity,
      })),
      finalEquity: equityPoints.length > 0
        ? equityPoints[equityPoints.length - 1].equity
        : d('10000'),
      totalFees: ZERO,
    })),
    _trades: trades,
    _equityPoints: equityPoints,
  };
}

// ── Mock Strategy ────────────────────────────────────────────────────

class ConfigurableStrategy implements IStrategy {
  name = 'test-strategy';
  minCandles = 3;
  requiredIndicators = [];
  private signalQueue: Signal[][] = [];
  evaluateCallCount = 0;

  /** Queue signals to return on successive evaluate() calls. */
  queueSignals(...signalSets: Signal[][]): void {
    this.signalQueue.push(...signalSets);
  }

  evaluate(candles: Candle[], pair: string, timeframe: string): Signal[] {
    this.evaluateCallCount++;
    if (this.signalQueue.length > 0) {
      return this.signalQueue.shift()!;
    }
    return [];
  }
}

// ── MockStrategyRegistry ─────────────────────────────────────────────

class MockStrategyRegistry extends StrategyRegistry {
  private mockStrategy: IStrategy;
  constructor(strategy: IStrategy) {
    super();
    this.mockStrategy = strategy;
  }
  override create(_rawConfig: unknown): IStrategy {
    return this.mockStrategy;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<PaperTradingConfig> = {}): PaperTradingConfig {
  return {
    pair: 'BTC-USD',
    timeframe: '1m',
    strategyConfig: { strategy: 'test-strategy' },
    initialCapital: '10000',
    slippageBps: 5,
    feeTierMaker: 0.0035,
    feeTierTaker: 0.0075,
    assumeTaker: true,
    allowShorts: true,
    bufferSize: 500,
    pollIntervalMs: 60000,
    ...overrides,
  };
}

function makeCandle(
  close: string,
  index: number,
  overrides: Partial<Candle> = {},
): Candle {
  return {
    pair: 'BTC-USD',
    timeframe: '1m',
    timestamp: 1700000000000 + index * 60000,
    open: close,
    high: String(Number(close) * 1.01),
    low: String(Number(close) * 0.99),
    close,
    volume: '100',
    ...overrides,
  };
}

function makeLongSignal(index: number): Signal {
  return {
    strategyName: 'test-strategy',
    pair: 'BTC-USD',
    timeframe: '1m',
    timestamp: 1700000000000 + index * 60000,
    direction: 'long',
    confidence: 0.8,
    reasoning: 'Test long signal',
  };
}

function makeCloseSignal(index: number): Signal {
  return {
    strategyName: 'test-strategy',
    pair: 'BTC-USD',
    timeframe: '1m',
    timestamp: 1700000000000 + index * 60000,
    direction: 'close',
    confidence: 0.8,
    reasoning: 'Test close signal',
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('PaperTradingEngine', () => {
  let liveFeed: MockLiveDataFeed;
  let sessionStore: ReturnType<typeof createMockSessionStore>;
  let strategy: ConfigurableStrategy;
  let registry: MockStrategyRegistry;
  let indicatorEngine: IndicatorEngine;
  let config: PaperTradingConfig;

  beforeEach(() => {
    liveFeed = new MockLiveDataFeed();
    sessionStore = createMockSessionStore();
    strategy = new ConfigurableStrategy();
    registry = new MockStrategyRegistry(strategy);
    indicatorEngine = new IndicatorEngine();
    config = makeConfig();
  });

  function createEngine(overrides: any = {}) {
    return new PaperTradingEngine({
      config: overrides.config ?? config,
      liveFeed: liveFeed as any,
      sessionStore: sessionStore as any,
      strategyRegistry: registry,
      indicatorEngine,
      ...overrides,
    });
  }

  it('processes candle through strategy and records equity point', async () => {
    const engine = createEngine();
    await engine.start();

    // Emit enough candles to trigger strategy evaluation (minCandles = 3)
    for (let i = 0; i < 3; i++) {
      liveFeed.emitCandle(makeCandle('50000', i));
    }

    // Equity is only recorded once buffer reaches minCandles (3rd candle onward)
    expect(sessionStore.recordEquityPoint).toHaveBeenCalledTimes(1);
    expect(strategy.evaluateCallCount).toBe(1); // Only after 3rd candle
  });

  it('buffers candles and waits for minCandles before evaluating', async () => {
    const engine = createEngine();
    await engine.start();

    // Emit only 2 candles (minCandles = 3)
    liveFeed.emitCandle(makeCandle('50000', 0));
    liveFeed.emitCandle(makeCandle('50100', 1));

    expect(strategy.evaluateCallCount).toBe(0);
    // Equity NOT recorded when below minCandles
    expect(sessionStore.recordEquityPoint).toHaveBeenCalledTimes(0);
  });

  it('enforces buffer size limit (sliding window)', async () => {
    const smallBufferConfig = makeConfig({ bufferSize: 100 });
    const engine = createEngine({ config: smallBufferConfig });
    await engine.start();

    // Emit 110 candles
    for (let i = 0; i < 110; i++) {
      liveFeed.emitCandle(makeCandle(String(50000 + i), i));
    }

    // Buffer should never exceed 100
    const bufferSize = engine.getBufferSize('BTC-USD:1m');
    expect(bufferSize).toBe(100);
  });

  it('simulates fill with slippage and fees on entry signal', async () => {
    const engine = createEngine();
    await engine.start();

    // Queue a long signal on the 3rd candle
    strategy.queueSignals([makeLongSignal(2)]);

    for (let i = 0; i < 3; i++) {
      liveFeed.emitCandle(makeCandle('50000', i));
    }

    // After entry, the equity should differ from initial (fee was charged)
    const lastEquityCall = sessionStore.recordEquityPoint.mock.calls.at(-1);
    expect(lastEquityCall).toBeDefined();
    const recordedEquity = lastEquityCall![2];
    // Equity should be close to initial capital but not exact (due to slippage + fee)
    // The fill uses close price as base, with 5bps slippage + 0.75% fee
    expect(recordedEquity.lt(d('10000'))).toBe(true);
  });

  it('applies risk manager when provided', async () => {
    const riskConfig: RiskConfig = {
      sizingMethod: 'fixed-fraction',
      kellyFraction: 0.5,
      fixedFractionPct: 0.02,
      maxPositionPct: 0.25,
      minTradesForKelly: 30,
      stopLoss: { type: 'fixed', percentage: 0.05 },
      maxDrawdownPct: 0.15,
      maxDailyLossPct: 0.05,
      maxExposurePct: 0.95,
      maxPositionCount: 4,
      circuitBreakerCooldownMs: 0,
    };

    const riskManager = new RiskManager(riskConfig);
    const evaluateSpy = vi.spyOn(riskManager, 'evaluate');

    const engine = createEngine({
      config: makeConfig({ riskConfig }),
      riskManager,
    });
    await engine.start();

    // Queue a long signal
    strategy.queueSignals([makeLongSignal(2)]);

    for (let i = 0; i < 3; i++) {
      liveFeed.emitCandle(makeCandle('50000', i));
    }

    // Risk manager should have been called
    expect(evaluateSpy).toHaveBeenCalled();
    const context = evaluateSpy.mock.calls[0][0];
    expect(context.signal.direction).toBe('long');
    expect(context.currentEquity.gt(ZERO)).toBe(true);
  });

  it('handles stop-loss trigger', async () => {
    const riskConfig: RiskConfig = {
      sizingMethod: 'fixed-fraction',
      kellyFraction: 0.5,
      fixedFractionPct: 0.02,
      maxPositionPct: 0.25,
      minTradesForKelly: 30,
      stopLoss: { type: 'fixed', percentage: 0.05 }, // 5% stop
      maxDrawdownPct: 0.50,
      maxDailyLossPct: 0.50,
      maxExposurePct: 0.95,
      maxPositionCount: 4,
      circuitBreakerCooldownMs: 0,
    };

    const riskManager = new RiskManager(riskConfig);

    const engine = createEngine({
      config: makeConfig({ riskConfig }),
      riskManager,
    });
    await engine.start();

    // Entry signal on 3rd candle
    strategy.queueSignals([makeLongSignal(2)]);
    for (let i = 0; i < 3; i++) {
      liveFeed.emitCandle(makeCandle('50000', i));
    }

    // Now emit a candle that breaches the stop (5% below entry = 47500)
    // The stop is at 50000 * 0.95 = 47500. Low must be <= 47500.
    strategy.queueSignals([]); // no signal on this candle
    liveFeed.emitCandle(makeCandle('46000', 3, {
      low: '46000',
      high: '49000',
    }));

    // Stop-loss should have recorded a trade
    expect(sessionStore.recordTrade).toHaveBeenCalled();
  });

  it('force-closes position on stop()', async () => {
    const engine = createEngine();
    await engine.start();

    // Open a position
    strategy.queueSignals([makeLongSignal(2)]);
    for (let i = 0; i < 3; i++) {
      liveFeed.emitCandle(makeCandle('50000', i));
    }

    // Stop the engine -- should force-close
    const result = await engine.stop();

    // endSession should be called
    expect(sessionStore.endSession).toHaveBeenCalled();
    // recordTrade should be called (force-close creates a trade)
    expect(sessionStore.recordTrade).toHaveBeenCalled();
    // Result should be returned
    expect(result).toBeDefined();
    expect(result.session).toBeDefined();
  });

  it('records trades to session store', async () => {
    const engine = createEngine();
    await engine.start();

    // Entry on candle 3
    strategy.queueSignals([makeLongSignal(2)]);
    for (let i = 0; i < 3; i++) {
      liveFeed.emitCandle(makeCandle('50000', i));
    }

    // Exit on candle 4
    strategy.queueSignals([makeCloseSignal(3)]);
    liveFeed.emitCandle(makeCandle('51000', 3));

    // Trade should be recorded
    expect(sessionStore.recordTrade).toHaveBeenCalled();
    const tradeArg = sessionStore.recordTrade.mock.calls[0][1];
    expect(tradeArg.entryFill).toBeDefined();
    expect(tradeArg.exitFill).toBeDefined();
    expect(tradeArg.pnl).toBeDefined();
  });

  it('stop() returns PaperTradingResult', async () => {
    const engine = createEngine();
    await engine.start();

    // Emit some candles (no signals)
    for (let i = 0; i < 5; i++) {
      liveFeed.emitCandle(makeCandle('50000', i));
    }

    const result = await engine.stop();

    expect(result.session).toBeDefined();
    expect(result.session.id).toBe('test-session-001');
    expect(result.trades).toBeDefined();
    expect(result.equityCurve).toBeDefined();
    expect(result.finalEquity).toBeDefined();
    expect(result.totalFees).toBeDefined();
  });

  it('skips short signals when allowShorts is false', async () => {
    const noShortsConfig = makeConfig({ allowShorts: false });
    const engine = createEngine({ config: noShortsConfig });
    await engine.start();

    const shortSignal: Signal = {
      strategyName: 'test-strategy',
      pair: 'BTC-USD',
      timeframe: '1m',
      timestamp: 1700000000000 + 2 * 60000,
      direction: 'short',
      confidence: 0.8,
      reasoning: 'Test short signal',
    };

    strategy.queueSignals([shortSignal]);
    for (let i = 0; i < 3; i++) {
      liveFeed.emitCandle(makeCandle('50000', i));
    }

    // No trade should be recorded (short was skipped)
    expect(sessionStore.recordTrade).not.toHaveBeenCalled();
  });
});
