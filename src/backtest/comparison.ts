/**
 * StrategyComparator -- runs multiple strategies on identical data and
 * ranks them side-by-side by various metrics.
 *
 * Enables informed strategy selection by comparing Sharpe, return,
 * and profit factor across strategy configurations.
 */

import type { Candle, TradingPair, Timeframe } from '../core/types.js';
import type { BacktestConfig, BacktestResult } from './types.js';
import type { BacktestEngine } from './engine.js';
import type { MetricsCalculator, PerformanceMetrics } from './metrics.js';

// ── Types ─────────────────────────────────────────────────────────────

/** A single strategy's backtest results with metrics. */
export interface ComparisonEntry {
  strategyConfig: Record<string, unknown>;
  strategyName: string;
  metrics: PerformanceMetrics;
  result: BacktestResult;
}

/** Complete comparison report with multiple rankings. */
export interface ComparisonReport {
  entries: ComparisonEntry[];
  rankedBySharpe: ComparisonEntry[];
  rankedByReturn: ComparisonEntry[];
  rankedByProfitFactor: ComparisonEntry[];
  dateRange: { startMs: number; endMs: number };
  pair: TradingPair;
  timeframe: Timeframe;
}

// ── StrategyComparator ────────────────────────────────────────────────

export class StrategyComparator {
  private readonly engine: BacktestEngine;
  private readonly metricsCalculator: MetricsCalculator;

  constructor(deps: { engine: BacktestEngine; metricsCalculator: MetricsCalculator }) {
    this.engine = deps.engine;
    this.metricsCalculator = deps.metricsCalculator;
  }

  /**
   * Compare multiple strategy configurations on identical candle data.
   *
   * @param strategyConfigs - Array of strategy config objects to compare
   * @param baseConfig - Base backtest config (without strategyConfig)
   * @param candles - Historical candles (same data for all strategies)
   * @param additionalCandlesMap - Optional multi-TF candles
   * @returns ComparisonReport with entries ranked by multiple criteria
   */
  compare(
    strategyConfigs: Record<string, unknown>[],
    baseConfig: Omit<BacktestConfig, 'strategyConfig'>,
    candles: Candle[],
    additionalCandlesMap?: Map<Timeframe, Candle[]>,
  ): ComparisonReport {
    const entries: ComparisonEntry[] = [];

    for (const strategyConfig of strategyConfigs) {
      const fullConfig: BacktestConfig = {
        ...baseConfig,
        strategyConfig,
      };

      const result = this.engine.run(fullConfig, candles, additionalCandlesMap);
      const metrics = this.metricsCalculator.calculate(result, baseConfig.initialCapital);

      entries.push({
        strategyConfig,
        strategyName: (strategyConfig.strategy as string) || 'unknown',
        metrics,
        result,
      });
    }

    // Sort by Sharpe ratio (descending)
    const rankedBySharpe = [...entries].sort(
      (a, b) => b.metrics.sharpeRatio - a.metrics.sharpeRatio,
    );

    // Sort by total return (descending)
    const rankedByReturn = [...entries].sort(
      (a, b) => b.metrics.totalReturn.minus(a.metrics.totalReturn).toNumber(),
    );

    // Sort by profit factor (descending)
    const rankedByProfitFactor = [...entries].sort(
      (a, b) => b.metrics.profitFactor.minus(a.metrics.profitFactor).toNumber(),
    );

    return {
      entries,
      rankedBySharpe,
      rankedByReturn,
      rankedByProfitFactor,
      dateRange: {
        startMs: baseConfig.startMs,
        endMs: baseConfig.endMs,
      },
      pair: baseConfig.pair,
      timeframe: baseConfig.timeframe,
    };
  }
}
