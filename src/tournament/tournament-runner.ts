/**
 * TournamentRunner -- orchestrates walk-forward validation across all
 * registered strategies, producing a ranked leaderboard sorted by
 * out-of-sample Sharpe ratio.
 */

import crypto from 'node:crypto';
import { createModuleLogger } from '../core/logger.js';
import type { Candle } from '../core/types.js';
import type { BacktestConfig } from '../backtest/types.js';
import type { WalkForwardRunner, WalkForwardResult } from '../backtest/walk-forward.js';
import type { StrategyRegistry } from '../strategies/registry.js';
import type { TournamentConfig } from './config.js';
import type { TournamentResult, LeaderboardEntry } from './types.js';
import type { PerformanceMetrics } from '../backtest/metrics.js';
import { MonteCarloEngine } from '../montecarlo/monte-carlo-engine.js';

const log = createModuleLogger('tournament-runner');

export class TournamentRunner {
  private readonly walkForwardRunner: WalkForwardRunner;
  private readonly registry: StrategyRegistry;

  constructor(deps: {
    walkForwardRunner: WalkForwardRunner;
    registry: StrategyRegistry;
  }) {
    this.walkForwardRunner = deps.walkForwardRunner;
    this.registry = deps.registry;
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
    const entries: LeaderboardEntry[] = [];

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
      );

      // Compute average IS Sharpe across all windows
      const avgIsSharpe = this.computeAvgIsSharpe(wfResult);
      const oosSharpe = wfResult.aggregateValidateMetrics.sharpeRatio;

      // Robustness ratio: OOS / IS (detects overfitting)
      const robustnessRatio =
        avgIsSharpe !== 0 ? oosSharpe / avgIsSharpe : 0;

      // Compute average IS metrics (use first window's train metrics as representative)
      const isMetrics = this.computeAvgIsMetrics(wfResult);

      entries.push({
        rank: 0, // assigned after sort
        strategyName,
        strategyConfig: stratConfig as Record<string, unknown>,
        oosMetrics: wfResult.aggregateValidateMetrics,
        isMetrics,
        robustnessRatio,
        windowCount: wfResult.windows.length,
      });

      // Optional MC post-processing: run MC on last OOS window result
      if (config.monteCarlo?.enabled) {
        const mcEngine = new MonteCarloEngine({
          iterations: config.monteCarlo.iterations,
          minTrades: config.monteCarlo.minTrades,
        });

        const lastWindow = wfResult.windows[wfResult.windows.length - 1];
        if (lastWindow && lastWindow.validateResult.trades.length >= config.monteCarlo.minTrades) {
          const entry = entries[entries.length - 1];
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

    // Sort by mcAdjustedScore when MC is enabled, otherwise by OOS Sharpe
    if (config.monteCarlo?.enabled) {
      entries.sort((a, b) => {
        const scoreA = a.mcAdjustedScore ?? a.oosMetrics.sharpeRatio;
        const scoreB = b.mcAdjustedScore ?? b.oosMetrics.sharpeRatio;
        return scoreB - scoreA;
      });
    } else {
      entries.sort((a, b) => b.oosMetrics.sharpeRatio - a.oosMetrics.sharpeRatio);
    }

    // Assign ranks
    for (let i = 0; i < entries.length; i++) {
      entries[i].rank = i + 1;
    }

    const durationMs = Date.now() - startTime;

    const result: TournamentResult = {
      id: crypto.randomUUID(),
      config,
      leaderboard: entries,
      runTimestamp: startTime,
      durationMs,
      strategiesEvaluated: strategyConfigs.length,
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
}
