/**
 * MonteCarloEngine -- shuffles a completed backtest's trade PnL sequence
 * N times (Fisher-Yates), reconstructs synthetic equity curves, computes
 * metrics per iteration, and extracts percentile distributions.
 *
 * Uses pnlPct (percentage returns) for equity reconstruction to correctly
 * handle compounding under different orderings. Sharpe ratio is computed
 * from per-trade returns (not daily-resampled) for synthetic MC equity curves.
 *
 * All hot-loop arithmetic uses native Number (no Decimal in the simulation).
 */

import crypto from 'node:crypto';
import {
  shuffle,
  quantile,
  mean,
  standardDeviation,
} from 'simple-statistics';
import type { BacktestResult } from '../backtest/types.js';
import { MetricsCalculator } from '../backtest/metrics.js';
import type {
  MonteCarloConfig,
  MonteCarloResult,
  PercentileDistribution,
} from './types.js';

/** Per-iteration metrics collected during the simulation. */
interface IterationMetrics {
  totalReturn: number;
  maxDrawdownPct: number;
  sharpeRatio: number;
}

export class MonteCarloEngine {
  private readonly config: MonteCarloConfig;

  constructor(config: MonteCarloConfig) {
    this.config = config;
  }

  /**
   * Run Monte Carlo simulation on a completed backtest result.
   *
   * @param backtestResult - Completed backtest with trades
   * @param strategyName - Name of the strategy being evaluated
   * @returns MonteCarloResult with percentile distributions
   * @throws Error if trade count is below minTrades
   */
  run(backtestResult: BacktestResult, strategyName: string): MonteCarloResult {
    const trades = backtestResult.trades;

    // 1. Validate trade count
    if (trades.length < this.config.minTrades) {
      throw new Error(
        `Insufficient trades (${trades.length}) for Monte Carlo simulation. ` +
          `Minimum required: ${this.config.minTrades}`,
      );
    }

    // 2. Pre-extract pnlPct values as native numbers (once, for performance).
    //    pnlPct is stored as percentage (e.g., 2.0 = 2%), so divide by 100
    //    to get the ratio for equity reconstruction.
    const pnlPctRatios = trades.map((t) => t.pnlPct.toNumber() / 100);
    const initialCapital = Number(backtestResult.config.initialCapital);

    // 3. Compute original metrics using MetricsCalculator
    const metricsCalc = new MetricsCalculator();
    const originalMetrics = metricsCalc.calculate(
      backtestResult,
      backtestResult.config.initialCapital,
    );

    // 4. Run N iterations
    const sharpes: number[] = [];
    const drawdowns: number[] = [];
    const returns: number[] = [];

    for (let i = 0; i < this.config.iterations; i++) {
      // Fisher-Yates shuffle (simple-statistics returns a NEW array)
      const shuffled = shuffle(pnlPctRatios);
      const metrics = this.replayShuffled(shuffled, initialCapital);

      sharpes.push(metrics.sharpeRatio);
      drawdowns.push(metrics.maxDrawdownPct);
      returns.push(metrics.totalReturn);
    }

    // 5. Extract percentile distributions
    return {
      id: crypto.randomUUID(),
      strategyName,
      iterations: this.config.iterations,
      tradeCount: trades.length,
      initialCapital: backtestResult.config.initialCapital,
      sharpeDistribution: this.extractDistribution(sharpes),
      maxDrawdownDistribution: this.extractDistribution(drawdowns),
      totalReturnDistribution: this.extractDistribution(returns),
      originalSharpe: originalMetrics.sharpeRatio,
      originalMaxDrawdownPct: originalMetrics.maxDrawdownPct.toNumber(),
      originalTotalReturn: originalMetrics.totalReturn.toNumber(),
      createdAt: Date.now(),
      backtestConfig: backtestResult.config,
    };
  }

  /**
   * Replay a shuffled sequence of pnlPct ratios to compute iteration metrics.
   *
   * Uses equity *= (1 + pnlPctRatio) for each trade to correctly model
   * compounding under different orderings (see Pitfall 1 in research).
   *
   * Sharpe is computed from per-trade returns (not daily-resampled),
   * since synthetic MC curves lack meaningful timestamps (Pitfall 2).
   */
  private replayShuffled(
    pnlPctRatios: number[],
    initialCapital: number,
  ): IterationMetrics {
    let equity = initialCapital;
    let peak = equity;
    let maxDD = 0;

    for (const pct of pnlPctRatios) {
      equity *= 1 + pct;
      if (equity > peak) peak = equity;
      const dd = peak > 0 ? (peak - equity) / peak : 0;
      if (dd > maxDD) maxDD = dd;
    }

    const totalReturn = (equity - initialCapital) / initialCapital;

    // Sharpe from per-trade returns (non-annualized).
    // Since all iterations have the same number of trades,
    // annualization is a constant multiplier that doesn't affect
    // relative ranking. We use mean/stddev directly.
    const m = mean(pnlPctRatios);
    const sd = standardDeviation(pnlPctRatios);
    const sharpe = sd > 0 ? m / sd : 0;

    return { totalReturn, maxDrawdownPct: maxDD, sharpeRatio: sharpe };
  }

  /**
   * Extract percentile distribution from an array of metric values.
   * simple-statistics.quantile() sorts internally, so no pre-sort needed.
   */
  private extractDistribution(values: number[]): PercentileDistribution {
    return {
      p5: quantile(values, 0.05),
      p25: quantile(values, 0.25),
      p50: quantile(values, 0.5),
      p75: quantile(values, 0.75),
      p95: quantile(values, 0.95),
      mean: mean(values),
      stdDev: standardDeviation(values),
    };
  }
}
