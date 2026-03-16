/**
 * Tests for PaperTradingEngine.
 *
 * Uses a mock LiveDataFeed (EventEmitter) and mock SessionStore.
 * Uses real FillSimulator and PortfolioTracker for accurate financial math.
 * Uses MockStrategyRegistry to bypass Zod validation for test strategies.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
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
import { RegimeClassifier } from '../../regime/classifier.js';
import { MarketRegime } from '../../regime/types.js';
import type { RegimeLeaderboards, RegimeLeaderboardEntry } from '../../tournament/types.js';

// ── Logger mock for entry-signal tests ────────────────────────────────
const { mockLogInfo } = vi.hoisted(() => {
  const mockLogInfo = vi.fn();
  return { mockLogInfo };
});
vi.mock('../../core/logger.js', () => ({
  createModuleLogger: () => ({
    info: mockLogInfo,
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  }),
}));

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

/**
 * A registry that dispatches create() based on the 'strategy' field of the
 * raw config. Enables auto-switch tests where regime change swaps to a
 * different named strategy.
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

/**
 * Build a minimal RegimeLeaderboards with two regime entries and a fallbackEntry.
 *
 * @param trendingStrategy - strategy name for TRENDING regime winner
 * @param rangingStrategy - strategy name for RANGING regime winner
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
    },
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

// ── Auto-switch tests ─────────────────────────────────────────────────
//
// These tests validate the five behavioral requirements of the regime
// auto-switching state machine (LIVE-01 through LIVE-05).
//
// Each test constructs a fresh engine with a fresh MockLiveDataFeed and
// a MultiStrategyMockRegistry that returns different IStrategy instances
// based on the strategy name embedded in the regime leaderboard config.
//
// vi.spyOn(RegimeClassifier.prototype, 'classify') is used to control
// returned regimes without needing real candle sequences long enough to
// produce ADX/ATR values.

describe('auto-switch', () => {
  let classifySpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    classifySpy?.mockRestore();
  });

  /**
   * Build a fresh engine wired for auto-switch tests.
   *
   * @param strategyA - the initial "strategy-a" IStrategy instance
   * @param strategyB - the "strategy-b" IStrategy instance that regime switch selects
   * @param regimeLeaderboards - the leaderboard to inject
   */
  function makeAutoSwitchEngine(
    strategyA: IStrategy,
    strategyB: IStrategy,
    regimeLeaderboards: RegimeLeaderboards,
  ) {
    const feed = new MockLiveDataFeed();
    const store = createMockSessionStore();
    const strategies = new Map<string, IStrategy>([
      ['strategy-a', strategyA],
      ['strategy-b', strategyB],
    ]);
    const reg = new MultiStrategyMockRegistry(strategies);
    const indEngine = new IndicatorEngine();
    const cfg = makeConfig({
      strategyConfig: { strategy: 'strategy-a' },
    });

    const engine = new PaperTradingEngine({
      config: cfg,
      liveFeed: feed as any,
      sessionStore: store as any,
      strategyRegistry: reg,
      indicatorEngine: indEngine,
      regimeLeaderboards,
    });

    return { engine, feed, store };
  }

  // LIVE-01: Immediate switch when portfolio is flat ──────────────────

  it('LIVE-01: immediately switches strategy on regime change when portfolio is flat', async () => {
    const strategyA: IStrategy = {
      name: 'strategy-a',
      minCandles: 3,
      requiredIndicators: [],
      evaluate: () => [],
    };
    const strategyB: IStrategy = {
      name: 'strategy-b',
      minCandles: 3,
      requiredIndicators: [],
      evaluate: () => [],
    };

    const leaderboards = makeRegimeLeaderboards('strategy-b', 'strategy-a');

    // classify() is called once per candle after buffer reaches minCandles (3).
    // Emitting 4 candles -> classify() is called on candles 2 and 3:
    //   classify call #1 (candle 2): RANGING -> sets currentRegime = RANGING
    //   classify call #2 (candle 3): TRENDING -> currentRegime=RANGING, portfolio flat -> switch fires
    let classifyCallCount = 0;
    classifySpy = vi.spyOn(RegimeClassifier.prototype, 'classify').mockImplementation(() => {
      classifyCallCount++;
      return classifyCallCount === 1 ? MarketRegime.RANGING : MarketRegime.TRENDING;
    });

    const { engine, feed } = makeAutoSwitchEngine(strategyA, strategyB, leaderboards);
    await engine.start();

    const switchEvents: any[] = [];
    engine.on('strategySwitch', (data) => switchEvents.push(data));

    // Emit 3 candles — only candle 2 triggers classify (returns RANGING)
    // currentRegime is set to RANGING; no switch because RANGING == RANGING (no change)
    for (let i = 0; i < 3; i++) {
      feed.emitCandle(makeCandle('50000', i));
    }
    // No switch yet
    expect(switchEvents).toHaveLength(0);

    // Emit 4th candle — classify returns TRENDING, currentRegime=RANGING
    // Portfolio is flat -> immediate switch fires
    feed.emitCandle(makeCandle('50000', 3));

    expect(switchEvents).toHaveLength(1);
    expect(switchEvents[0].newStrategy).toBe('strategy-b');
  });

  // LIVE-02: Deferred switch when position is open ───────────────────

  it('LIVE-02: defers strategy switch until open position closes', async () => {
    // Strategy-a enters on buffer[2] (candle index 2) and closes on candle 4.
    // classify() call sequence (only called when buffer >= minCandles=3):
    //   call #1 (candle 2): RANGING -> currentRegime=RANGING, entry fires
    //   call #2 (candle 3): TRENDING -> RANGING!=TRENDING, position open -> pendingSwitch set
    //   call #3 (candle 4): TRENDING -> TRENDING==TRENDING (no new switch), close signal fires
    //       -> processCloseSignal -> checkAndExecutePendingSwitch -> switch executes

    const entryA: IStrategy = {
      name: 'strategy-a',
      minCandles: 3,
      requiredIndicators: [],
      evaluate: (candles) => {
        const idx = candles.length - 1;
        if (idx === 2) return [makeLongSignal(idx)]; // enter on 3rd candle (buffer[2])
        if (idx === 4) return [makeCloseSignal(idx)]; // close on 5th candle
        return [];
      },
    };

    const strategyB: IStrategy = {
      name: 'strategy-b',
      minCandles: 3,
      requiredIndicators: [],
      evaluate: () => [],
    };

    const leaderboards = makeRegimeLeaderboards('strategy-b', 'strategy-a');

    let classifyCallCount = 0;
    classifySpy = vi.spyOn(RegimeClassifier.prototype, 'classify').mockImplementation(() => {
      classifyCallCount++;
      // call 1: RANGING (sets currentRegime, entry fires)
      // call 2+: TRENDING (triggers deferred switch, then holds)
      return classifyCallCount === 1 ? MarketRegime.RANGING : MarketRegime.TRENDING;
    });

    const feed2 = new MockLiveDataFeed();
    const store2 = createMockSessionStore();
    const strategies2 = new Map<string, IStrategy>([
      ['strategy-a', entryA],
      ['strategy-b', strategyB],
    ]);
    const reg2 = new MultiStrategyMockRegistry(strategies2);
    const engine2 = new PaperTradingEngine({
      config: makeConfig({ strategyConfig: { strategy: 'strategy-a' } }),
      liveFeed: feed2 as any,
      sessionStore: store2 as any,
      strategyRegistry: reg2,
      indicatorEngine: new IndicatorEngine(),
      regimeLeaderboards: leaderboards,
    });
    await engine2.start();

    const switchEvents2: any[] = [];
    engine2.on('strategySwitch', (data) => switchEvents2.push(data));

    // Candles 0-2: RANGING — enters position on candle 2 (3rd candle fills buffer)
    for (let i = 0; i < 3; i++) {
      feed2.emitCandle(makeCandle('50000', i));
    }
    // No switch yet (no regime change, just warm-up)
    expect(switchEvents2).toHaveLength(0);

    // Candle 3: TRENDING — switch detected but position open -> deferred (pendingSwitch set)
    feed2.emitCandle(makeCandle('50000', 3));
    // Still no switch
    expect(switchEvents2).toHaveLength(0);

    // Candle 4: TRENDING continued — close signal fires from entryA.evaluate,
    // processCloseSignal flattens portfolio, checkAndExecutePendingSwitch executes
    feed2.emitCandle(makeCandle('50000', 4));

    expect(switchEvents2).toHaveLength(1);
    expect(switchEvents2[0].newStrategy).toBe('strategy-b');
  });

  // LIVE-03: Cooldown throttles second switch ────────────────────────

  it('LIVE-03: cooldown window prevents a second strategy switch within 10 candles', async () => {
    // Leaderboards: TRENDING -> strategy-b, RANGING -> strategy-a
    // Note: for this test both strategies can be simple no-ops (no position opened)
    const strategyA: IStrategy = {
      name: 'strategy-a',
      minCandles: 3,
      requiredIndicators: [],
      evaluate: () => [],
    };
    const strategyB: IStrategy = {
      name: 'strategy-b',
      minCandles: 3,
      requiredIndicators: [],
      evaluate: () => [],
    };

    const leaderboards = makeRegimeLeaderboards('strategy-b', 'strategy-a');

    // classify() is called once per candle after buffer.length >= 3.
    // Emitting 15 candles (0-14) -> classify called 13 times (candles 2-14).
    //
    // Call sequence:
    //   #1  (candle 2):  RANGING  -> currentRegime=RANGING
    //   #2  (candle 3):  TRENDING -> RANGING!=TRENDING, cooldown=0 -> switch #1, cooldown=10
    //   #3  (candle 4):  RANGING  -> cooldown 10->9, blocked; currentRegime=RANGING
    //   #4  (candle 5):  RANGING  -> cooldown 9->8, RANGING==RANGING, blocked
    //   ...                          (regime stays RANGING, no change, cooldown counting)
    //   #12 (candle 13): RANGING  -> cooldown 1->0
    //   #13 (candle 14): TRENDING -> cooldown=0, RANGING!=TRENDING -> switch #2
    let classifyCallCount = 0;
    classifySpy = vi.spyOn(RegimeClassifier.prototype, 'classify').mockImplementation(() => {
      classifyCallCount++;
      if (classifyCallCount === 1) return MarketRegime.RANGING;  // warm-up
      if (classifyCallCount === 2) return MarketRegime.TRENDING; // switch #1
      if (classifyCallCount <= 12) return MarketRegime.RANGING;  // in cooldown
      return MarketRegime.TRENDING;                              // switch #2 (cooldown expired)
    });

    const { engine, feed } = makeAutoSwitchEngine(strategyA, strategyB, leaderboards);
    await engine.start();

    const switchEvents: any[] = [];
    engine.on('strategySwitch', (data) => switchEvents.push(data));

    // Emit candles 0-3: classify calls 1 and 2 fire (RANGING then TRENDING)
    for (let i = 0; i < 4; i++) {
      feed.emitCandle(makeCandle('50000', i));
    }
    // Switch #1 fires on candle 3
    expect(switchEvents).toHaveLength(1);
    expect(switchEvents[0].newStrategy).toBe('strategy-b');

    // Emit candles 4-12 (classify calls 3-11, all RANGING, cooldown 9->1)
    // No new switch should fire
    for (let i = 4; i < 13; i++) {
      feed.emitCandle(makeCandle('50000', i));
    }
    expect(switchEvents).toHaveLength(1);

    // Emit candle 13 (classify call 12, RANGING, cooldown 1->0) -- still no switch
    feed.emitCandle(makeCandle('50000', 13));
    expect(switchEvents).toHaveLength(1);

    // Emit candle 14 (classify call 13, TRENDING, cooldown=0) -> switch #2 fires
    feed.emitCandle(makeCandle('50000', 14));
    expect(switchEvents).toHaveLength(2);
    expect(switchEvents[1].newStrategy).toBe('strategy-b');
  });

  // LIVE-04: First undefined->known transition does NOT switch ────────

  it('LIVE-04: first undefined-to-known regime transition does not trigger a strategy switch', async () => {
    const strategyA: IStrategy = {
      name: 'strategy-a',
      minCandles: 3,
      requiredIndicators: [],
      evaluate: () => [],
    };
    const strategyB: IStrategy = {
      name: 'strategy-b',
      minCandles: 3,
      requiredIndicators: [],
      evaluate: () => [],
    };

    const leaderboards = makeRegimeLeaderboards('strategy-b', 'strategy-a');

    // classify() is called on candles 2 and 3 (first two calls after buffer fills).
    // Spy sequence:
    //   call #1 (candle 2): undefined -> currentRegime stays undefined
    //   call #2 (candle 3): TRENDING  -> guard: currentRegime !== undefined FAILS -> no switch
    //
    // This is the undefined->known transition guard (LIVE-04).
    let classifyCallCount = 0;
    classifySpy = vi.spyOn(RegimeClassifier.prototype, 'classify').mockImplementation(() => {
      classifyCallCount++;
      return classifyCallCount === 1 ? undefined : MarketRegime.TRENDING;
    });

    const { engine, feed } = makeAutoSwitchEngine(strategyA, strategyB, leaderboards);
    await engine.start();

    const switchEvents: any[] = [];
    engine.on('strategySwitch', (data) => switchEvents.push(data));

    // Emit 4 candles:
    //   candles 0,1: buffer < minCandles, classify not called
    //   candle 2:    classify call #1 -> undefined, currentRegime stays undefined
    //   candle 3:    classify call #2 -> TRENDING, but guard fails (currentRegime===undefined)
    for (let i = 0; i < 4; i++) {
      feed.emitCandle(makeCandle('50000', i));
    }

    // No switch: guard `currentRegime !== undefined` blocks the undefined->TRENDING transition
    expect(switchEvents).toHaveLength(0);
  });

  // LIVE-05: exitManager cleared on strategy switch ──────────────────

  it('LIVE-05: exitManager is null after strategy switch (no state transfer across strategies)', async () => {
    // Strategy-a enters a position and then closes it.
    // After close, a regime change fires executeStrategySwitch.
    // We verify that the NEXT entry after the switch creates a fresh exitManager
    // (i.e., the one from the previous strategy was not transferred).
    //
    // Observable proxy: after switch, emit entry candle -> if exitManager was
    // transferred we'd have duplicate exit tracking. We verify via 'orderFilled'
    // events that only one entry fill occurs (no spurious exits from stale exitManager).

    let strategyACallCount = 0;
    const strategyA: IStrategy = {
      name: 'strategy-a',
      minCandles: 3,
      requiredIndicators: [],
      evaluate: (candles) => {
        strategyACallCount++;
        const idx = candles.length - 1;
        if (idx === 2) return [makeLongSignal(idx)]; // enter on 3rd candle
        if (idx === 3) return [makeCloseSignal(idx)]; // close on 4th candle
        return [];
      },
    };
    const strategyB: IStrategy = {
      name: 'strategy-b',
      minCandles: 3,
      requiredIndicators: [],
      evaluate: () => [],
    };

    const leaderboards = makeRegimeLeaderboards('strategy-b', 'strategy-a');

    // classify() call sequence:
    //   call #1 (candle 2): RANGING -> currentRegime=RANGING, entry fires (exitManager created)
    //   call #2 (candle 3): RANGING -> close fires, portfolio flat; no pending switch (no regime change)
    //   call #3 (candle 4): TRENDING -> RANGING!=TRENDING, portfolio flat -> switch fires immediately
    //       (executeStrategySwitch sets exitManager=null as part of LIVE-05)
    let classifyCallCount = 0;
    classifySpy = vi.spyOn(RegimeClassifier.prototype, 'classify').mockImplementation(() => {
      classifyCallCount++;
      return classifyCallCount <= 2 ? MarketRegime.RANGING : MarketRegime.TRENDING;
    });

    // Use exits config to ensure ExitLogicManager is created on entry
    const exitStrategyConfig: Record<string, unknown> = {
      strategy: 'strategy-a',
      exits: {
        trailing: { enabled: true, activateAfterPct: 0.01, trailAtrMultiple: 2.0 },
      },
    };

    const feed = new MockLiveDataFeed();
    const store = createMockSessionStore();
    const strategies = new Map<string, IStrategy>([
      ['strategy-a', strategyA],
      ['strategy-b', strategyB],
    ]);
    const reg = new MultiStrategyMockRegistry(strategies);
    const engine = new PaperTradingEngine({
      config: makeConfig({ strategyConfig: exitStrategyConfig }),
      liveFeed: feed as any,
      sessionStore: store as any,
      strategyRegistry: reg,
      indicatorEngine: new IndicatorEngine(),
      regimeLeaderboards: leaderboards,
    });
    await engine.start();

    const switchEvents: any[] = [];
    engine.on('strategySwitch', (data) => switchEvents.push(data));

    const fills: any[] = [];
    engine.on('orderFilled', (data) => fills.push(data));

    // Candles 0-3: enter on 2, close on 3 (RANGING regime throughout)
    for (let i = 0; i < 4; i++) {
      feed.emitCandle(makeCandle('50000', i));
    }

    // At this point position is flat, no switch yet (still RANGING from classify)
    expect(switchEvents).toHaveLength(0);

    // Candle 4: TRENDING — portfolio is flat -> immediate switch
    feed.emitCandle(makeCandle('50000', 4));

    expect(switchEvents).toHaveLength(1);
    expect(switchEvents[0].newStrategy).toBe('strategy-b');

    // Verify: the fills array has exactly one ENTRY and one EXIT from the
    // strategy-a position (no spurious exit from a stale exitManager post-switch)
    const entryFills = fills.filter((f) => f.purpose === 'ENTRY');
    const exitFills = fills.filter((f) => f.purpose === 'EXIT');
    expect(entryFills).toHaveLength(1);
    expect(exitFills).toHaveLength(1);
  });
});

// ── Entry-signal logging tests ─────────────────────────────────────────

describe('entry-signal logging', () => {
  let liveFeed: MockLiveDataFeed;
  let sessionStore: ReturnType<typeof createMockSessionStore>;
  let strategy: ConfigurableStrategy;
  let registry: MockStrategyRegistry;
  let indicatorEngine: IndicatorEngine;
  let config: PaperTradingConfig;

  beforeEach(() => {
    mockLogInfo.mockClear();
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

  it('logs INFO entry-signal on long signal', async () => {
    const engine = createEngine();
    await engine.start();

    // Queue a long signal on the 3rd candle
    strategy.queueSignals([makeLongSignal(2)]);

    for (let i = 0; i < 3; i++) {
      liveFeed.emitCandle(makeCandle('50000', i));
    }

    // Find the entry-signal log call
    const entrySignalCall = mockLogInfo.mock.calls.find(
      (call) => call[0]?.event === 'entry-signal',
    );
    expect(entrySignalCall).toBeDefined();
    expect(entrySignalCall![0]).toMatchObject({
      event: 'entry-signal',
      direction: 'long',
      strategyName: 'test-strategy',
      instrument: 'BTC-USD',
    });
    expect(entrySignalCall![0].confidence).toBeTruthy();
    expect(entrySignalCall![0].timestamp).toBeTruthy();
    expect(entrySignalCall![1]).toBe('Entry signal received');
  });

  it('does not log entry-signal on close signal', async () => {
    const engine = createEngine();
    await engine.start();

    // Enter a position first
    strategy.queueSignals([makeLongSignal(2)]);
    for (let i = 0; i < 3; i++) {
      liveFeed.emitCandle(makeCandle('50000', i));
    }

    // Clear the mock to isolate close signal behavior
    mockLogInfo.mockClear();

    // Now queue a close signal
    strategy.queueSignals([makeCloseSignal(3)]);
    liveFeed.emitCandle(makeCandle('51000', 3));

    // Verify no entry-signal log was produced for the close signal
    const entrySignalCall = mockLogInfo.mock.calls.find(
      (call) => call[0]?.event === 'entry-signal',
    );
    expect(entrySignalCall).toBeUndefined();
  });
});
