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
import { TournamentRunner, selectDeployableEntries } from '../tournament-runner.js';
import type { LeaderboardEntry } from '../types.js';
import { RegimeClassifier } from '../../regime/classifier.js';
import { MarketRegime } from '../../regime/types.js';

// ── Helpers ────────────────────────────────────────────────────────

function makeMetrics(overrides: Partial<PerformanceMetrics> = {}): PerformanceMetrics {
  return {
    totalReturn: d('0.1'),
    cagr: d('0.05'),
    sharpeRatio: 1.5,
    sortinoRatio: 0,
    calmarRatio: 0,
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
    minOosSharpe: 0,
    allowShorts: true,
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

  it('forwards allowShorts=false from tournament config to backtest config (spot)', async () => {
    mockWfRunner.run.mockReturnValue(makeWfResult(1.0, [1.0]));
    mockRegistry.list.mockReturnValue(['sma-crossover']);

    const config = makeTournamentConfig({ allowShorts: false });
    await runner.run(config, dummyCandles);

    const backtestConfig = mockWfRunner.run.mock.calls[0][0] as BacktestConfig;
    expect(backtestConfig.allowShorts).toBe(false);
  });

  it('defaults allowShorts=true (perp keeps shorting)', async () => {
    mockWfRunner.run.mockReturnValue(makeWfResult(1.0, [1.0]));
    mockRegistry.list.mockReturnValue(['perp-mean-reversion']);

    const config = makeTournamentConfig({ allowShorts: true });
    await runner.run(config, dummyCandles);

    const backtestConfig = mockWfRunner.run.mock.calls[0][0] as BacktestConfig;
    expect(backtestConfig.allowShorts).toBe(true);
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

  it('excludes a regime entry whose regime Sharpe is negative (edge floor)', async () => {
    vi.spyOn(RegimeClassifier.prototype, 'classifyAll').mockReturnValue(
      new Map([[1000, MarketRegime.TRENDING]]),
    );
    mockWfRunner.run.mockReturnValue(makeWfResult(1.5, [1.5])); // qualifies overall
    // Enough regime trades, but the regime-specific Sharpe is negative → not deployable.
    mockMetricsCalculator.calculateRegimeBreakdown.mockReturnValue([
      { regime: MarketRegime.TRENDING, tradeCount: 5, sharpeRatio: -0.8, winRate: 0.3, timePct: 0.3 },
    ]);

    const config = makeTournamentConfig();
    const result = await runner.run(config, dummyCandles);

    expect(result.regimeLeaderboards!.TRENDING).toHaveLength(0);
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
    it('ranks disqualified (negative OOS) strategy below qualified ones even if IS Sharpe is higher', async () => {
      // qualified: IS=2.0, OOS=1.5 → positive OOS edge, qualifies
      // disqualified: IS=3.0, OOS=-1.0 → overfit (great in-sample, loses out-of-sample) → disqualified
      mockWfRunner.run
        .mockReturnValueOnce(makeWfResult(1.5, [2.0]))    // qualified
        .mockReturnValueOnce(makeWfResult(-1.0, [3.0]));  // overfit loser

      mockRegistry.list.mockReturnValue(['qualified-strat', 'overfit-strat']);

      const config = makeTournamentConfig();
      const result = await runner.run(config, dummyCandles);

      expect(result.leaderboard[0].strategyName).toBe('qualified-strat');
      expect(result.leaderboard[0].disqualified).toBe(false);
      expect(result.leaderboard[0].rank).toBe(1);

      expect(result.leaderboard[1].strategyName).toBe('overfit-strat');
      expect(result.leaderboard[1].disqualified).toBe(true);
      expect(result.leaderboard[1].disqualifyReason).toMatch(/edge floor|OOS Sharpe/i);
      expect(result.leaderboard[1].rank).toBe(2);
    });

    it('KEEPS an IS-negative but OOS-positive strategy (it generalizes to unseen data)', async () => {
      // The whole point of walk-forward is out-of-sample performance. A strategy
      // that lost in training but WON in validation is a desirable generalizer,
      // not a fluke to discard. (This was the bug: perp-mean-reversion got thrown out.)
      mockWfRunner.run.mockReturnValue(makeWfResult(2.5, [-3.0])); // IS=-3.0, OOS=+2.5
      mockRegistry.list.mockReturnValue(['generalizer']);

      const config = makeTournamentConfig();
      const result = await runner.run(config, dummyCandles);

      expect(result.leaderboard[0].strategyName).toBe('generalizer');
      expect(result.leaderboard[0].disqualified).toBe(false);
      expect(result.leaderboard[0].disqualifyReason).toBeNull();
    });

    it('disqualifies strategy with 0 OOS trades', async () => {
      // zero-trade: OOS=0, totalTrades=0 → disqualified (never traded)
      // real-strat: IS=2.0, OOS=1.5 → positive OOS edge, qualifies
      const zeroTradeResult = makeWfResult(0, [0]);
      zeroTradeResult.aggregateValidateMetrics.totalTrades = 0;
      mockWfRunner.run
        .mockReturnValueOnce(zeroTradeResult)           // zero-trade
        .mockReturnValueOnce(makeWfResult(1.5, [2.0])); // real-strat

      mockRegistry.list.mockReturnValue(['zero-trade', 'real-strat']);

      const config = makeTournamentConfig();
      const result = await runner.run(config, dummyCandles);

      // real-strat should be rank 1 (qualified), zero-trade should be rank 2 (disqualified)
      expect(result.leaderboard[0].strategyName).toBe('real-strat');
      expect(result.leaderboard[0].disqualified).toBe(false);
      expect(result.leaderboard[0].rank).toBe(1);

      expect(result.leaderboard[1].strategyName).toBe('zero-trade');
      expect(result.leaderboard[1].disqualified).toBe(true);
      expect(result.leaderboard[1].disqualifyReason).toMatch(/No OOS trades/);
      expect(result.leaderboard[1].rank).toBe(2);
    });

    it('does NOT fall back to a deployable winner when every strategy has non-positive OOS (hold cash)', async () => {
      // Both strategies lose out-of-sample. The old code fell back to IN-SAMPLE
      // Sharpe ranking and deployed the most overfit loser anyway. Correct behavior:
      // every entry stays disqualified and ranking is by OOS (not IS), so consumers
      // hold cash instead of deploying a known loser.
      mockWfRunner.run
        .mockReturnValueOnce(makeWfResult(-1.0, [3.0]))  // strat-a: huge IS, OOS=-1.0
        .mockReturnValueOnce(makeWfResult(-0.5, [0.2])); // strat-b: small IS, OOS=-0.5 (less bad OOS)

      mockRegistry.list.mockReturnValue(['strat-a', 'strat-b']);

      const config = makeTournamentConfig();
      const result = await runner.run(config, dummyCandles);

      // Ranked by OOS (−0.5 > −1.0), NOT by IS Sharpe (which would put strat-a first).
      expect(result.leaderboard[0].strategyName).toBe('strat-b');
      expect(result.leaderboard[1].strategyName).toBe('strat-a');
      // Nothing is deployable.
      expect(result.leaderboard.every((e) => e.disqualified)).toBe(true);
      expect(result.leaderboard[0].disqualified).toBe(true);
    });
  });

  describe('edge floor', () => {
    it('disqualifies a strategy with positive trades but OOS Sharpe of exactly 0', async () => {
      mockWfRunner.run.mockReturnValue(makeWfResult(0, [1.0])); // OOS=0, has trades
      mockRegistry.list.mockReturnValue(['flat-strat']);

      const config = makeTournamentConfig();
      const result = await runner.run(config, dummyCandles);

      expect(result.leaderboard[0].disqualified).toBe(true);
      expect(result.leaderboard[0].disqualifyReason).toMatch(/edge floor|OOS Sharpe/i);
    });

    it('disqualifies a strategy with negative OOS Sharpe even though it traded', async () => {
      mockWfRunner.run.mockReturnValue(makeWfResult(-1.88, [1.0])); // the deployed -1.88 case
      mockRegistry.list.mockReturnValue(['losing-strat']);

      const config = makeTournamentConfig();
      const result = await runner.run(config, dummyCandles);

      expect(result.leaderboard[0].disqualified).toBe(true);
      expect(result.leaderboard[0].disqualifyReason).toMatch(/edge floor|OOS Sharpe/i);
    });

    it('respects a custom minOosSharpe floor', async () => {
      // OOS=0.3 passes the default floor (0) but fails a stricter floor of 0.5.
      mockWfRunner.run.mockReturnValue(makeWfResult(0.3, [0.3]));
      mockRegistry.list.mockReturnValue(['marginal-strat']);

      const config = makeTournamentConfig({ minOosSharpe: 0.5 } as Partial<TournamentConfig>);
      const result = await runner.run(config, dummyCandles);

      expect(result.leaderboard[0].disqualified).toBe(true);
    });
  });

  describe('quality filter disqualification', () => {
    it('disqualifies strategy with low profitFactor', async () => {
      const wfResult = makeWfResult(1.5, [1.5]);
      wfResult.aggregateValidateMetrics = makeMetrics({
        sharpeRatio: 1.5,
        profitFactor: d('0.9'),
        sortinoRatio: 1.0,
        calmarRatio: 1.0,
      });
      mockWfRunner.run.mockReturnValue(wfResult);
      mockRegistry.list.mockReturnValue(['low-pf-strat']);

      const config = makeTournamentConfig({
        qualityFilters: { minProfitFactor: 1.1, minSortino: 0, minCalmar: 0 },
      });
      const result = await runner.run(config, dummyCandles);

      expect(result.leaderboard[0].disqualified).toBe(true);
      expect(result.leaderboard[0].disqualifyReason).toContain('PF');
    });

    it('disqualifies strategy with negative Sortino', async () => {
      const wfResult = makeWfResult(1.5, [1.5]);
      wfResult.aggregateValidateMetrics = makeMetrics({
        sharpeRatio: 1.5,
        sortinoRatio: -0.5,
        calmarRatio: 1.0,
        profitFactor: d('2.0'),
      });
      mockWfRunner.run.mockReturnValue(wfResult);
      mockRegistry.list.mockReturnValue(['neg-sortino-strat']);

      const config = makeTournamentConfig({
        qualityFilters: { minSortino: 0.1, minCalmar: 0, minProfitFactor: 0 },
      });
      const result = await runner.run(config, dummyCandles);

      expect(result.leaderboard[0].disqualified).toBe(true);
      expect(result.leaderboard[0].disqualifyReason).toContain('Sortino');
    });

    it('disqualifies strategy with low Calmar', async () => {
      const wfResult = makeWfResult(1.5, [1.5]);
      wfResult.aggregateValidateMetrics = makeMetrics({
        sharpeRatio: 1.5,
        calmarRatio: 0.3,
        sortinoRatio: 1.0,
        profitFactor: d('2.0'),
      });
      mockWfRunner.run.mockReturnValue(wfResult);
      mockRegistry.list.mockReturnValue(['low-calmar-strat']);

      const config = makeTournamentConfig({
        qualityFilters: { minCalmar: 0.5, minSortino: 0, minProfitFactor: 0 },
      });
      const result = await runner.run(config, dummyCandles);

      expect(result.leaderboard[0].disqualified).toBe(true);
      expect(result.leaderboard[0].disqualifyReason).toContain('Calmar');
    });

    it('does not disqualify strategy meeting all thresholds', async () => {
      const wfResult = makeWfResult(1.5, [1.5]);
      wfResult.aggregateValidateMetrics = makeMetrics({
        sharpeRatio: 1.5,
        profitFactor: d('1.5'),
        sortinoRatio: 1.0,
        calmarRatio: 1.0,
      });
      mockWfRunner.run.mockReturnValue(wfResult);
      mockRegistry.list.mockReturnValue(['good-strat']);

      const config = makeTournamentConfig({
        qualityFilters: { minProfitFactor: 1.1, minSortino: 0.1, minCalmar: 0.5 },
      });
      const result = await runner.run(config, dummyCandles);

      expect(result.leaderboard[0].disqualified).toBe(false);
    });

    it('all-zero thresholds disable filtering', async () => {
      const wfResult = makeWfResult(1.5, [1.5]);
      wfResult.aggregateValidateMetrics = makeMetrics({
        sharpeRatio: 1.5,
        profitFactor: d('0.5'),
        sortinoRatio: -2.0,
        calmarRatio: -1.0,
      });
      mockWfRunner.run.mockReturnValue(wfResult);
      mockRegistry.list.mockReturnValue(['terrible-strat']);

      const config = makeTournamentConfig({
        qualityFilters: { minSortino: 0, minCalmar: 0, minProfitFactor: 0 },
      });
      const result = await runner.run(config, dummyCandles);

      expect(result.leaderboard[0].disqualified).toBe(false);
    });

    it('omitted qualityFilters means no quality filtering', async () => {
      const wfResult = makeWfResult(1.5, [1.5]);
      wfResult.aggregateValidateMetrics = makeMetrics({
        sharpeRatio: 1.5,
        profitFactor: d('0.5'),
        sortinoRatio: -2.0,
        calmarRatio: -1.0,
      });
      mockWfRunner.run.mockReturnValue(wfResult);
      mockRegistry.list.mockReturnValue(['terrible-strat']);

      // No qualityFilters in config
      const config = makeTournamentConfig();
      const result = await runner.run(config, dummyCandles);

      // Should not be disqualified by quality filters (robustness is fine: 1.5/1.5 = 1.0)
      expect(result.leaderboard[0].disqualified).toBe(false);
    });
  });

  it('forwards additionalCandlesMap to walk-forward runner', async () => {
    mockWfRunner.run.mockReturnValue(makeWfResult(1.5, [1.5]));
    mockRegistry.list.mockReturnValue(['test-strategy']);

    const htfCandles: Candle[] = [
      { pair: 'BTC-USD', timeframe: '4h', timestamp: 1000, open: '100', high: '110', low: '90', close: '105', volume: '10' },
    ];
    const additionalCandles = new Map([['4h' as const, htfCandles]]);

    const config = makeTournamentConfig();
    await runner.run(config, dummyCandles, additionalCandles);

    // Verify additionalCandlesMap was passed (4th argument to walkForwardRunner.run)
    expect(mockWfRunner.run).toHaveBeenCalledWith(
      expect.any(Object),  // backtestConfig
      expect.any(Object),  // walkForward
      dummyCandles,        // candles
      additionalCandles,   // additionalCandlesMap — NOT undefined
      expect.any(Object),  // precomputedRegimes
    );
  });
});

// ── selectDeployableEntries ─────────────────────────────────────────

describe('selectDeployableEntries', () => {
  function entry(name: string, disqualified: boolean): LeaderboardEntry {
    return {
      rank: 0,
      strategyName: name,
      strategyConfig: { strategy: name },
      oosMetrics: makeMetrics(),
      isMetrics: makeMetrics(),
      robustnessRatio: 1,
      windowCount: 1,
      disqualified,
      disqualifyReason: disqualified ? 'test' : null,
    };
  }

  it('returns only non-disqualified entries, preserving order', () => {
    const board = [
      entry('a', false),
      entry('b', true),
      entry('c', false),
    ];
    const deployable = selectDeployableEntries(board);
    expect(deployable.map((e) => e.strategyName)).toEqual(['a', 'c']);
  });

  it('returns an empty array when every entry is disqualified (hold cash)', () => {
    const board = [entry('a', true), entry('b', true)];
    expect(selectDeployableEntries(board)).toEqual([]);
  });

  it('returns an empty array for an empty leaderboard', () => {
    expect(selectDeployableEntries([])).toEqual([]);
  });
});
