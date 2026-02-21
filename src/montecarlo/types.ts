/**
 * Monte Carlo simulation types and configuration schema.
 *
 * Defines MonteCarloConfig (Zod-validated), MonteCarloResult,
 * and PercentileDistribution for MC trade-sequence shuffling.
 */

import { z } from 'zod';
import type { BacktestConfig } from '../backtest/types.js';

// -- Zod schema for MonteCarloConfig -----------------------------------------

export const monteCarloConfigSchema = z.object({
  /** Number of MC iterations (shuffle + replay cycles) */
  iterations: z.number().int().min(100).max(100000).default(1000),
  /** Minimum trades required to run MC (rejects backtests with fewer) */
  minTrades: z.number().int().min(5).max(100).default(15),
});

/** Validated MonteCarloConfig type (inferred from Zod schema). */
export type MonteCarloConfig = z.infer<typeof monteCarloConfigSchema>;

/**
 * Parse and validate a raw Monte Carlo config.
 * Throws on invalid input with descriptive error messages.
 */
export function parseMonteCarloConfig(raw: unknown): MonteCarloConfig {
  const result = monteCarloConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map(
      (i) => `${i.path.join('.')}: ${i.message}`,
    );
    throw new Error(`Invalid Monte Carlo config: ${issues.join('; ')}`);
  }
  return result.data;
}

// -- Result types ------------------------------------------------------------

/** Percentile distribution for a single metric across MC iterations. */
export interface PercentileDistribution {
  /** 5th percentile (worst-case) */
  p5: number;
  /** 25th percentile */
  p25: number;
  /** 50th percentile (median) */
  p50: number;
  /** 75th percentile */
  p75: number;
  /** 95th percentile (best-case) */
  p95: number;
  /** Arithmetic mean across all iterations */
  mean: number;
  /** Standard deviation across all iterations */
  stdDev: number;
}

/** Complete result from a Monte Carlo simulation run. */
export interface MonteCarloResult {
  /** Unique identifier (UUID) */
  id: string;
  /** Name of the strategy that was evaluated */
  strategyName: string;
  /** Number of MC iterations performed */
  iterations: number;
  /** Number of trades in the original backtest */
  tradeCount: number;
  /** Initial capital as string (Decimal precision) */
  initialCapital: string;
  /** Distribution of Sharpe ratio across iterations */
  sharpeDistribution: PercentileDistribution;
  /** Distribution of max drawdown (%) across iterations */
  maxDrawdownDistribution: PercentileDistribution;
  /** Distribution of total return across iterations */
  totalReturnDistribution: PercentileDistribution;
  /** Sharpe ratio from the original (unshuffled) backtest */
  originalSharpe: number;
  /** Max drawdown (%) from the original backtest */
  originalMaxDrawdownPct: number;
  /** Total return from the original backtest */
  originalTotalReturn: number;
  /** Unix ms timestamp when this result was created */
  createdAt: number;
  /** The backtest config that produced the original trades */
  backtestConfig: BacktestConfig;
}
