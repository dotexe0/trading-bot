/**
 * TournamentRunner -- orchestrates walk-forward validation across all
 * registered strategies, producing a ranked leaderboard sorted by
 * out-of-sample Sharpe ratio.
 */

import crypto from 'node:crypto';
import { createModuleLogger } from '../core/logger.js';
import type { Candle } from '../core/types.js';
import type { BacktestConfig, Trade } from '../backtest/types.js';
import type { WalkForwardRunner, WalkForwardResult } from '../backtest/walk-forward.js';
import type { StrategyRegistry } from '../strategies/registry.js';
import type { TournamentConfig } from './config.js';
import type { TournamentResult, LeaderboardEntry, RegimeLeaderboards, RegimeLeaderboardEntry } from './types.js';
import type { PerformanceMetrics, MetricsCalculator } from '../backtest/metrics.js';
import { MonteCarloEngine } from '../montecarlo/monte-carlo-engine.js';
import { RegimeClassifier } from '../regime/classifier.js';
import { MarketRegime } from '../regime/types.js';
import { MIN_REGIME_TRADES } from './constants.js';

const log = createModuleLogger('tournament-runner');

interface EntryAccumulator {
  entry: LeaderboardEntry;
  validateTrades: Trade[];
  validateCandleCount: number;
}

export class TournamentRunner {
  private readonly walkForwardRunner: WalkForwardRunner;
  private readonly registry: StrategyRegistry;
  private readonly metricsCalculator: MetricsCalculator;
  private readonly classifier = new RegimeClassifier();

  constructor(deps: {
    walkForwardRunner: WalkForwardRunner;
    registry: StrategyRegistry;
    metricsCalculator: MetricsCalculator;
  }) {
    this.walkForwardRunner = deps.walkForwardRunner;
    this.registry = deps.registry;
    this.metricsCalculator = deps.metricsCalculator;
  }

  /**
   * Run a tournament: evaluate each strategy via walk-forward validation
   * and produce a ranked leaderboard.
   */
  async run(
    config: TournamentConfig,
    candles: Candle[],
  ): Promise<TournamentResult> {
    const strategyConfigs = config.strategyConfigs
      ? config.strategyConfigs
      : this.getDefaultStrategyConfigs();

    log.info(
      {
        strategies: strategyConfigs.length,
        pair: config.pair,
        timeframe: config.timeframe,
        startMs: config.startMs,
        endMs: config.endMs,
      },
      'Tournament starting',
    );

    const startTime = Date.now();
    const precomputedRegimes = this.classifier.classifyAll(candles);
    const accumulators: EntryAccumulator[] = [];

    for (const stratConfig of strategyConfigs) {
      const strategyName =
        (stratConfig as Record<string, unknown>).strategy as string ?? 'unknown';

      // Build BacktestConfig from tournament config + strategy config
      const backtestConfig: BacktestConfig = {
        pair: config.pair,
        timeframe: config.timeframe,
        startMs: config.startMs,
        endMs: config.endMs,
        initialCapital: config.initialCapital,
        slippageBps: config.slippageBps,
        feeTierMaker: config.feeTierMaker,
        feeTierTaker: config.feeTierTaker,
        strategyConfig: stratConfig as Record<string, unknown>,
        assumeTaker: true,
        positionSizePct: 0.95,
        allowShorts: true,
      };

      const wfResult: WalkForwardResult = this.walkForwardRunner.run(
        backtestConfig,
        config.walkForward,
        candles,
        undefined,
        precomputedRegimes,
      );

      // Compute average IS Sharpe across all windows
      const avgIsSharpe = this.computeAvgIsSharpe(wfResult);
      const oosSharpe = wfResult.aggregateValidateMetrics.sharpeRatio;

      // Robustness ratio: OOS / IS (detects overfitting)
      const robustnessRatio =
        avgIsSharpe !== 0 ? oosSharpe / avgIsSharpe : 0;

      // Compute average IS metrics (use first window's train metrics as representative)
      const isMetrics = this.computeAvgIsMetrics(wfResult);

      const validateCandleCount = wfResult.windows.reduce((sum, w) => {
        return sum + candles.filter(
          (c) => c.timestamp >= w.window.validateStart && c.timestamp < w.window.validateEnd,
        ).length;
      }, 0);

      accumulators.push({
        entry: {
          rank: 0, // assigned after sort
          strategyName,
          strategyConfig: stratConfig as Record<string, unknown>,
          oosMetrics: wfResult.aggregateValidateMetrics,
          isMetrics,
          robustnessRatio,
          windowCount: wfResult.windows.length,
          disqualified: false,       // set in ranking phase
          disqualifyReason: null,    // set in ranking phase
        },
        validateTrades: wfResult.validateTrades,
        validateCandleCount,
      });

      // Optional MC post-processing: run MC on last OOS window result
      if (config.monteCarlo?.enabled) {
        const mcEngine = new MonteCarloEngine({
          iterations: config.monteCarlo.iterations,
          minTrades: config.monteCarlo.minTrades,
        });

        const lastWindow = wfResult.windows[wfResult.windows.length - 1];
        if (lastWindow && lastWindow.validateResult.trades.length >= config.monteCarlo.minTrades) {
          const entry = accumulators[accumulators.length - 1].entry;
          try {
            const mcResult = mcEngine.run(lastWindow.validateResult, strategyName);
            entry.mcResult = mcResult;

            // Composite score: blend OOS Sharpe with MC worst-case (p5) Sharpe
            const w = config.monteCarlo.rankingWeight;
            entry.mcAdjustedScore =
              (1 - w) * entry.oosMetrics.sharpeRatio +
              w * mcResult.sharpeDistribution.p5;

            log.info(
              {
                strategy: strategyName,
                mcP5Sharpe: mcResult.sharpeDistribution.p5.toFixed(4),
                mcAdjustedScore: entry.mcAdjustedScore.toFixed(4),
              },
              'MC simulation complete for strategy',
            );
          } catch (err) {
            log.warn(
              { strategy: strategyName, error: (err as Error).message },
              'MC skipped for strategy',
            );
          }
        }
      }

      log.info(
        {
          strategy: strategyName,
          oosSharpe: oosSharpe.toFixed(4),
          robustnessRatio: robustnessRatio.toFixed(4),
          windows: wfResult.windows.length,
        },
        'Strategy evaluation complete',
      );

      // Yield event loop between strategies
      await new Promise((r) => setImmediate(r));
    }

    // Extract entries from accumulators for sorting
    const entries = accumulators.map((a) => a.entry);

    // Mark disqualified entries:
    // 1. robustness < 0 means IS and OOS point in opposite directions — statistical fluke
    // 2. totalTrades === 0 means strategy never traded — no edge to validate
    for (const entry of entries) {
      if (entry.oosMetrics.totalTrades === 0) {
        entry.disqualified = true;
        entry.disqualifyReason = 'No OOS trades — strategy never traded';
      } else if (entry.robustnessRatio < 0) {
        entry.disqualified = true;
        entry.disqualifyReason =
          `IS/OOS direction mismatch (robustness ${entry.robustnessRatio.toFixed(2)})`;
      } else {
        entry.disqualified = false;
        entry.disqualifyReason = null;
      }
    }

    // Quality filter: disqualify strategies below metric thresholds
    const qf = config.qualityFilters;
    if (qf) {
      for (const entry of entries) {
        if (entry.disqualified) continue; // already disqualified by robustness

        const reasons: string[] = [];
        if (qf.minSortino > 0 && entry.oosMetrics.sortinoRatio < qf.minSortino) {
          reasons.push(`Sortino ${entry.oosMetrics.sortinoRatio.toFixed(2)} < ${qf.minSortino}`);
        }
        if (qf.minCalmar > 0 && entry.oosMetrics.calmarRatio < qf.minCalmar) {
          reasons.push(`Calmar ${entry.oosMetrics.calmarRatio.toFixed(2)} < ${qf.minCalmar}`);
        }
        if (qf.minProfitFactor > 0 && entry.oosMetrics.profitFactor.toNumber() < qf.minProfitFactor) {
          reasons.push(`PF ${entry.oosMetrics.profitFactor.toFixed(2)} < ${qf.minProfitFactor}`);
        }
        if (reasons.length > 0) {
          entry.disqualified = true;
          entry.disqualifyReason = reasons.join('; ');
        }
      }
    }

    const qualified = entries.filter((e) => !e.disqualified);
    const disqualifiedEntries = entries.filter((e) => e.disqualified);

    const sortFn = config.monteCarlo?.enabled
      ? (a: LeaderboardEntry, b: LeaderboardEntry) => {
          const scoreA = a.mcAdjustedScore ?? a.oosMetrics.sharpeRatio;
          const scoreB = b.mcAdjustedScore ?? b.oosMetrics.sharpeRatio;
          return scoreB - scoreA;
        }
      : (a: LeaderboardEntry, b: LeaderboardEntry) =>
          b.oosMetrics.sharpeRatio - a.oosMetrics.sharpeRatio;

    if (qualified.length === 0) {
      // All strategies disqualified — fall back to IS Sharpe ranking across all entries
      log.warn(
        { strategies: entries.map((e) => e.strategyName) },
        'All strategies disqualified by robustness filter — falling back to IS Sharpe ranking',
      );
      entries.sort((a, b) => b.isMetrics.sharpeRatio - a.isMetrics.sharpeRatio);
    } else {
      qualified.sort(sortFn);
      disqualifiedEntries.sort(sortFn);
      entries.length = 0;
      entries.push(...qualified, ...disqualifiedEntries);
    }

    // Assign ranks
    for (let i = 0; i < entries.length; i++) {
      entries[i].rank = i + 1;
    }

    // Build regime leaderboards (accumulators order preserved; sort is on entries copy)
    const regimeLeaderboards = this.buildRegimeLeaderboards(
      accumulators,
      precomputedRegimes,
      entries[0],
    );

    const durationMs = Date.now() - startTime;

    const result: TournamentResult = {
      id: crypto.randomUUID(),
      config,
      leaderboard: entries,
      runTimestamp: startTime,
      durationMs,
      strategiesEvaluated: strategyConfigs.length,
      regimeLeaderboards,
    };

    log.info(
      {
        durationMs,
        strategies: strategyConfigs.length,
        topStrategy: entries[0]?.strategyName ?? 'none',
        topSharpe: entries[0]?.oosMetrics.sharpeRatio.toFixed(4) ?? 'N/A',
      },
      'Tournament complete',
    );

    return result;
  }

  /**
   * Build default strategy configs from registry -- one entry per registered strategy.
   */
  private getDefaultStrategyConfigs(): Record<string, unknown>[] {
    return this.registry.list().map((name) => ({ strategy: name }));
  }

  /**
   * Compute average in-sample Sharpe ratio across all walk-forward windows.
   */
  private computeAvgIsSharpe(wfResult: WalkForwardResult): number {
    if (wfResult.windows.length === 0) return 0;
    const sum = wfResult.windows.reduce(
      (acc, w) => acc + w.trainMetrics.sharpeRatio,
      0,
    );
    return sum / wfResult.windows.length;
  }

  /**
   * Get representative IS metrics. Uses the last window's train metrics
   * as a reasonable proxy for in-sample performance.
   */
  private computeAvgIsMetrics(wfResult: WalkForwardResult): PerformanceMetrics {
    if (wfResult.windows.length === 0) {
      return wfResult.aggregateValidateMetrics; // fallback to OOS
    }
    return wfResult.windows[wfResult.windows.length - 1].trainMetrics;
  }

  /**
   * Build per-regime leaderboards from strategy accumulators.
   *
   * @param accumulators - Per-strategy entries with their OOS trades
   * @param precomputedRegimes - Full-series regime map from classifyAll()
   * @param fallbackEntry - Overall leaderboard winner (rank 1)
   * @returns RegimeLeaderboards or undefined when regime data is unavailable
   */
  private buildRegimeLeaderboards(
    accumulators: EntryAccumulator[],
    precomputedRegimes: Map<number, MarketRegime>,
    fallbackEntry: LeaderboardEntry | undefined,
  ): RegimeLeaderboards | undefined {
    if (precomputedRegimes.size === 0 || accumulators.length === 0) return undefined;
    if (!fallbackEntry) return undefined;

    const regimeArrays: Record<MarketRegime, RegimeLeaderboardEntry[]> = {
      [MarketRegime.TRENDING]: [],
      [MarketRegime.RANGING]: [],
      [MarketRegime.VOLATILE]: [],
    };

    for (const acc of accumulators) {
      const breakdown = this.metricsCalculator.calculateRegimeBreakdown(
        precomputedRegimes,
        acc.validateTrades,
        acc.validateCandleCount,
      );

      for (const bd of breakdown) {
        if (bd.tradeCount < MIN_REGIME_TRADES) continue;
        regimeArrays[bd.regime].push({
          rank: 0,
          strategyName: acc.entry.strategyName,
          strategyConfig: acc.entry.strategyConfig,
          regimeSharpeRatio: bd.sharpeRatio,
          regimeWinRate: bd.winRate,
          regimeTradeCount: bd.tradeCount,
          overallOosSharpe: acc.entry.oosMetrics.sharpeRatio,
        });
      }
    }

    for (const regime of Object.values(MarketRegime)) {
      regimeArrays[regime].sort((a, b) => b.regimeSharpeRatio - a.regimeSharpeRatio);
      regimeArrays[regime].forEach((e, i) => {
        e.rank = i + 1;
      });
    }

    return {
      [MarketRegime.TRENDING]: regimeArrays[MarketRegime.TRENDING],
      [MarketRegime.RANGING]: regimeArrays[MarketRegime.RANGING],
      [MarketRegime.VOLATILE]: regimeArrays[MarketRegime.VOLATILE],
      fallbackEntry,
    };
  }
}
