/**
 * Tests for TournamentRunner -- verifies strategy evaluation,
 * leaderboard ranking, and robustness ratio calculation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { d, ZERO } from '../../core/decimal.js';
import type { PerformanceMetrics } from '../../backtest/metrics.js';
import type { WalkForwardResult, WalkForwardWindowResult } from '../../backtest/walk-forward.js';
import type { BacktestResult, BacktestConfig } from '../../backtest/types.js';
import type { Candle } from '../../core/types.js';
import type { TournamentConfig } from '../config.js';
import { TournamentRunner } from '../tournament-runner.js';
import { RegimeClassifier } from '../../regime/classifier.js';
import { MarketRegime } from '../../regime/types.js';

// ── Helpers ────────────────────────────────────────────────────────

function makeMetrics(overrides: Partial<PerformanceMetrics> = {}): PerformanceMetrics {
  return {
    totalReturn: d('0.1'),
    cagr: d('0.05'),
    sharpeRatio: 1.5,
    maxDrawdown: d('100'),
    maxDrawdownPct: d('0.01'),
    winRate: d('0.6'),
    profitFactor: d('1.5'),
    totalTrades: 10,
    totalFees: d('5'),
    fundingCost: ZERO,
    avgTradeReturn: d('0.01'),
    bestTrade: d('50'),
    worstTrade: d('-30'),
    ...overrides,
  };
}

function makeWfResult(
  oosSharpe: number,
  isSharpes: number[],
): WalkForwardResult {
  const windows: WalkForwardWindowResult[] = isSharpes.map((isSharpe, i) => ({
    window: {
      trainStart: i * 1000,
      trainEnd: (i + 1) * 1000,
      validateStart: (i + 1) * 1000,
      validateEnd: (i + 2) * 1000,
    },
    trainMetrics: makeMetrics({ sharpeRatio: isSharpe }),
    validateMetrics: makeMetrics({ sharpeRatio: oosSharpe }),
    trainResult: {} as BacktestResult,
    validateResult: {} as BacktestResult,
  }));

  return {
    windows,
    aggregateValidateMetrics: makeMetrics({ sharpeRatio: oosSharpe }),
    config: { trainWindowMs: 1000, validateWindowMs: 1000, stepMs: 1000 },
    validateTrades: [],
  };
}

function makeTournamentConfig(overrides: Partial<TournamentConfig> = {}): TournamentConfig {
  return {
    pair: 'BTC-USD',
    timeframe: '1h',
    startMs: 1000,
    endMs: 100000,
    walkForward: {
      trainWindowMs: 50000,
      validateWindowMs: 25000,
      stepMs: 25000,
    },
    initialCapital: '10000',
    slippageBps: 5,
    feeTierMaker: 0.0035,
    feeTierTaker: 0.0075,
    topN: 3,
    activationMode: 'none',
    ...overrides,
  };
}

const dummyCandles: Candle[] = [
  { pair: 'BTC-USD', timeframe: '1h', timestamp: 1000, open: '100', high: '110', low: '90', close: '105', volume: '10' },
];

// ── Tests ──────────────────────────────────────────────────────────

describe('TournamentRunner', () => {
  let mockWfRunner: { run: ReturnType<typeof vi.fn> };
  let mockRegistry: { list: ReturnType<typeof vi.fn> };
  let mockMetricsCalculator: { calculateRegimeBreakdown: ReturnType<typeof vi.fn> };
  let runner: TournamentRunner;

  beforeEach(() => {
    mockWfRunner = {
      run: vi.fn(),
    };
    mockRegistry = {
      list: vi.fn().mockReturnValue(['sma-crossover', 'rsi-mean-reversion', 'macd-momentum']),
    };
    mockMetricsCalculator = {
      calculateRegimeBreakdown: vi.fn().mockReturnValue([]),
    };
    runner = new TournamentRunner({
      walkForwardRunner: mockWfRunner as any,
      registry: mockRegistry as any,
      metricsCalculator: mockMetricsCalculator as any,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs all registered strategies and produces leaderboard', async () => {
    mockWfRunner.run.mockReturnValue(makeWfResult(1.5, [1.5]));

    const config = makeTournamentConfig();
    const result = await runner.run(config, dummyCandles);

    expect(result.leaderboard).toHaveLength(3);
    expect(result.strategiesEvaluated).toBe(3);
    expect(mockWfRunner.run).toHaveBeenCalledTimes(3);
  });

  it('sorts strategies by OOS Sharpe descending', async () => {
    mockWfRunner.run
      .mockReturnValueOnce(makeWfResult(0.5, [1.0])) // sma-crossover: worst
      .mockReturnValueOnce(makeWfResult(2.5, [2.0])) // rsi-mean-reversion: best
      .mockReturnValueOnce(makeWfResult(1.0, [1.5])); // macd-momentum: middle

    const config = makeTournamentConfig();
    const result = await runner.run(config, dummyCandles);

    expect(result.leaderboard[0].strategyName).toBe('rsi-mean-reversion');
    expect(result.leaderboard[0].oosMetrics.sharpeRatio).toBe(2.5);
    expect(result.leaderboard[0].rank).toBe(1);

    expect(result.leaderboard[1].strategyName).toBe('macd-momentum');
    expect(result.leaderboard[1].oosMetrics.sharpeRatio).toBe(1.0);
    expect(result.leaderboard[1].rank).toBe(2);

    expect(result.leaderboard[2].strategyName).toBe('sma-crossover');
    expect(result.leaderboard[2].oosMetrics.sharpeRatio).toBe(0.5);
    expect(result.leaderboard[2].rank).toBe(3);
  });

  it('calculates robustness ratio correctly (OOS / IS)', async () => {
    // OOS Sharpe = 1.2, IS Sharpe avg = (2.0 + 2.4) / 2 = 2.2
    // Robustness = 1.2 / 2.2 = 0.5454...
    mockWfRunner.run.mockReturnValue(makeWfResult(1.2, [2.0, 2.4]));
    mockRegistry.list.mockReturnValue(['test-strategy']);

    const config = makeTournamentConfig();
    const result = await runner.run(config, dummyCandles);

    const entry = result.leaderboard[0];
    expect(entry.robustnessRatio).toBeCloseTo(1.2 / 2.2, 4);
  });

  it('returns robustness ratio 0 when IS Sharpe is 0', async () => {
    mockWfRunner.run.mockReturnValue(makeWfResult(1.5, [0, 0]));
    mockRegistry.list.mockReturnValue(['test-strategy']);

    const config = makeTournamentConfig();
    const result = await runner.run(config, dummyCandles);

    expect(result.leaderboard[0].robustnessRatio).toBe(0);
  });

  it('uses custom strategyConfigs when provided', async () => {
    mockWfRunner.run.mockReturnValue(makeWfResult(1.0, [1.0]));

    const customConfigs = [
      { strategy: 'sma-crossover', fastPeriod: 5, slowPeriod: 15 },
      { strategy: 'rsi-mean-reversion', period: 7 },
    ];

    const config = makeTournamentConfig({ strategyConfigs: customConfigs });
    const result = await runner.run(config, dummyCandles);

    expect(result.leaderboard).toHaveLength(2);
    expect(result.strategiesEvaluated).toBe(2);
    // Should NOT call registry.list when custom configs provided
    expect(mockRegistry.list).not.toHaveBeenCalled();
  });

  it('passes correct BacktestConfig to walk-forward runner', async () => {
    mockWfRunner.run.mockReturnValue(makeWfResult(1.0, [1.0]));
    mockRegistry.list.mockReturnValue(['sma-crossover']);

    const config = makeTournamentConfig({
      pair: 'ETH-USD',
      timeframe: '15m',
      initialCapital: '5000',
      slippageBps: 10,
    });
    await runner.run(config, dummyCandles);

    const backtestConfig = mockWfRunner.run.mock.calls[0][0] as BacktestConfig;
    expect(backtestConfig.pair).toBe('ETH-USD');
    expect(backtestConfig.timeframe).toBe('15m');
    expect(backtestConfig.initialCapital).toBe('5000');
    expect(backtestConfig.slippageBps).toBe(10);
    expect(backtestConfig.strategyConfig).toEqual({ strategy: 'sma-crossover' });
  });

  it('includes tournament metadata in result', async () => {
    mockWfRunner.run.mockReturnValue(makeWfResult(1.0, [1.0]));

    const config = makeTournamentConfig();
    const result = await runner.run(config, dummyCandles);

    expect(result.id).toBeTruthy();
    expect(result.config).toBe(config);
    expect(result.runTimestamp).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.strategiesEvaluated).toBe(3);
  });

  it('handles empty registry gracefully', async () => {
    mockRegistry.list.mockReturnValue([]);

    const config = makeTournamentConfig();
    const result = await runner.run(config, dummyCandles);

    expect(result.leaderboard).toHaveLength(0);
    expect(result.strategiesEvaluated).toBe(0);
  });

  it('records window count from walk-forward result', async () => {
    mockWfRunner.run.mockReturnValue(makeWfResult(1.5, [1.0, 1.2, 1.4]));
    mockRegistry.list.mockReturnValue(['test-strategy']);

    const config = makeTournamentConfig();
    const result = await runner.run(config, dummyCandles);

    expect(result.leaderboard[0].windowCount).toBe(3);
  });

  it('tournament without MC config produces entries without mcResult', async () => {
    mockWfRunner.run.mockReturnValue(makeWfResult(1.5, [1.5]));
    mockRegistry.list.mockReturnValue(['test-strategy']);

    // No monteCarlo config -- default behavior
    const config = makeTournamentConfig();
    const result = await runner.run(config, dummyCandles);

    expect(result.leaderboard).toHaveLength(1);
    expect(result.leaderboard[0].mcResult).toBeUndefined();
    expect(result.leaderboard[0].mcAdjustedScore).toBeUndefined();
  });
});

// ── Regime leaderboard tests ────────────────────────────────────────

describe('TournamentRunner regime leaderboards', () => {
  let mockWfRunner: { run: ReturnType<typeof vi.fn> };
  let mockRegistry: { list: ReturnType<typeof vi.fn> };
  let mockMetricsCalculator: { calculateRegimeBreakdown: ReturnType<typeof vi.fn> };
  let runner: TournamentRunner;

  beforeEach(() => {
    mockWfRunner = { run: vi.fn() };
    mockRegistry = { list: vi.fn().mockReturnValue(['test-strategy']) };
    mockMetricsCalculator = {
      calculateRegimeBreakdown: vi.fn().mockReturnValue([]),
    };
    runner = new TournamentRunner({
      walkForwardRunner: mockWfRunner as any,
      registry: mockRegistry as any,
      metricsCalculator: mockMetricsCalculator as any,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('regimeLeaderboards is defined when classifyAll returns non-empty map', async () => {
    vi.spyOn(RegimeClassifier.prototype, 'classifyAll').mockReturnValue(
      new Map([[1000, MarketRegime.TRENDING]]),
    );
    mockWfRunner.run.mockReturnValue(makeWfResult(1.5, [1.5]));
    mockMetricsCalculator.calculateRegimeBreakdown.mockReturnValue([]);

    const config = makeTournamentConfig();
    const result = await runner.run(config, dummyCandles);

    expect(result.regimeLeaderboards).toBeDefined();
    expect(result.regimeLeaderboards).toHaveProperty('TRENDING');
    expect(result.regimeLeaderboards).toHaveProperty('RANGING');
    expect(result.regimeLeaderboards).toHaveProperty('VOLATILE');
  });

  it('selects correct winner for TRENDING regime', async () => {
    mockRegistry.list.mockReturnValue(['stratA', 'stratB']);
    vi.spyOn(RegimeClassifier.prototype, 'classifyAll').mockReturnValue(
      new Map([[1000, MarketRegime.TRENDING]]),
    );
    mockWfRunner.run
      .mockReturnValueOnce(makeWfResult(2.0, [2.0]))
      .mockReturnValueOnce(makeWfResult(1.0, [1.0]));

    // Per-strategy: stratA gets sharpe 2.0, stratB gets sharpe 1.0 for TRENDING
    mockMetricsCalculator.calculateRegimeBreakdown
      .mockReturnValueOnce([
        { regime: MarketRegime.TRENDING, tradeCount: 5, sharpeRatio: 2.0, winRate: 0.6, timePct: 0.3 },
      ])
      .mockReturnValueOnce([
        { regime: MarketRegime.TRENDING, tradeCount: 4, sharpeRatio: 1.0, winRate: 0.5, timePct: 0.3 },
      ]);

    const config = makeTournamentConfig({ strategyConfigs: [
      { strategy: 'stratA' },
      { strategy: 'stratB' },
    ] });
    const result = await runner.run(config, dummyCandles);

    expect(result.regimeLeaderboards!.TRENDING[0].strategyName).toBe('stratA');
    expect(result.regimeLeaderboards!.TRENDING[0].regimeSharpeRatio).toBe(2.0);
  });

  it('excludes strategies with fewer than MIN_REGIME_TRADES (3) OOS trades', async () => {
    vi.spyOn(RegimeClassifier.prototype, 'classifyAll').mockReturnValue(
      new Map([[1000, MarketRegime.TRENDING]]),
    );
    mockWfRunner.run.mockReturnValue(makeWfResult(1.5, [1.5]));
    // tradeCount 2 < MIN_REGIME_TRADES 3 — should be excluded
    mockMetricsCalculator.calculateRegimeBreakdown.mockReturnValue([
      { regime: MarketRegime.TRENDING, tradeCount: 2, sharpeRatio: 3.0, winRate: 0.7, timePct: 0.2 },
    ]);

    const config = makeTournamentConfig();
    const result = await runner.run(config, dummyCandles);

    expect(result.regimeLeaderboards!.TRENDING).toHaveLength(0);
    expect(result.regimeLeaderboards!.fallbackEntry).toBeDefined();
  });

  it('fallbackEntry equals overall leaderboard winner', async () => {
    mockRegistry.list.mockReturnValue(['stratA', 'stratB']);
    vi.spyOn(RegimeClassifier.prototype, 'classifyAll').mockReturnValue(
      new Map([[1000, MarketRegime.TRENDING]]),
    );
    // stratA has higher OOS Sharpe (2.0) so it should be rank 1 and the fallback
    mockWfRunner.run
      .mockReturnValueOnce(makeWfResult(2.0, [2.0]))
      .mockReturnValueOnce(makeWfResult(1.0, [1.0]));

    // All regimes have tradeCount < MIN_REGIME_TRADES — all arrays empty
    mockMetricsCalculator.calculateRegimeBreakdown.mockReturnValue([
      { regime: MarketRegime.TRENDING, tradeCount: 1, sharpeRatio: 3.0, winRate: 0.7, timePct: 0.2 },
    ]);

    const config = makeTournamentConfig({ strategyConfigs: [
      { strategy: 'stratA' },
      { strategy: 'stratB' },
    ] });
    const result = await runner.run(config, dummyCandles);

    expect(result.regimeLeaderboards!.TRENDING).toHaveLength(0);
    expect(result.regimeLeaderboards!.fallbackEntry.strategyName).toBe('stratA');
  });

  describe('disqualification filter', () => {
    it('ranks disqualified (negative robustness) strategy below qualified ones even if OOS Sharpe is higher', async () => {
      // qualified: IS=2.0, OOS=1.5 → robustness=0.75 (positive, qualifies)
      // disqualified: IS=-1.0, OOS=3.0 → robustness=-3.0 (negative, disqualified despite higher OOS)
      mockWfRunner.run
        .mockReturnValueOnce(makeWfResult(1.5, [2.0]))   // qualified
        .mockReturnValueOnce(makeWfResult(3.0, [-1.0])); // disqualified

      mockRegistry.list.mockReturnValue(['qualified-strat', 'disqualified-strat']);

      const config = makeTournamentConfig();
      const result = await runner.run(config, dummyCandles);

      expect(result.leaderboard[0].strategyName).toBe('qualified-strat');
      expect(result.leaderboard[0].disqualified).toBe(false);
      expect(result.leaderboard[0].rank).toBe(1);

      expect(result.leaderboard[1].strategyName).toBe('disqualified-strat');
      expect(result.leaderboard[1].disqualified).toBe(true);
      expect(result.leaderboard[1].disqualifyReason).toMatch(/IS\/OOS direction mismatch/);
      expect(result.leaderboard[1].rank).toBe(2);
    });

    it('falls back to IS Sharpe ranking when all strategies are disqualified', async () => {
      // strat-a: IS=-1.0, OOS=2.0 → robustness=-2.0, disqualified
      // strat-b: IS=-0.5, OOS=1.0 → robustness=-2.0, disqualified but higher IS Sharpe
      mockWfRunner.run
        .mockReturnValueOnce(makeWfResult(2.0, [-1.0]))  // strat-a
        .mockReturnValueOnce(makeWfResult(1.0, [-0.5])); // strat-b

      mockRegistry.list.mockReturnValue(['strat-a', 'strat-b']);

      const config = makeTournamentConfig();
      const result = await runner.run(config, dummyCandles);

      // strat-b has higher IS Sharpe (-0.5 > -1.0) so ranks first in fallback
      expect(result.leaderboard[0].strategyName).toBe('strat-b');
      expect(result.leaderboard[1].strategyName).toBe('strat-a');
      // Both are still marked disqualified
      expect(result.leaderboard[0].disqualified).toBe(true);
      expect(result.leaderboard[1].disqualified).toBe(true);
    });
  });
});
