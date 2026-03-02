/**
 * Types for the ExitConfigOptimizer module.
 *
 * Defines grid search parameters, optimized exit results,
 * and optimizer configuration.
 */

import type { ExitConfig } from '../risk/exit-logic/types.js';

// ── Grid Search Types ──────────────────────────────────────────────

/** Specification for the grid search parameter space. */
export interface GridSpec {
  /** ATR multiples for stop distance and trail distance */
  atrMultiples: number[];
  /** Trailing stop activation percentages (decimal, e.g., 0.02 = 2%) */
  trailActivatePcts: number[];
  /** Partial exit profit target percentages (decimal) */
  partialTargetPcts: number[];
  /** Max candles held before time exit (must be integers) */
  maxCandlesHeld: number[];
}

// ── Optimized Result Types ─────────────────────────────────────────

/** Result of an optimization run for a specific strategy+config. */
export interface OptimizedExitParams {
  /** Strategy name (e.g., 'sma-crossover') */
  strategyName: string;
  /** SHA-256 hash of strategy config (excluding exits block) */
  strategyConfigHash: string;
  /** The best exit configuration found */
  exitConfig: ExitConfig;
  /** Out-of-sample profit factor of the best combo */
  profitFactor: number;
  /** Timestamp when this optimization was performed */
  searchedAt: number;
}

// ── Optimizer Configuration ────────────────────────────────────────

/** Configuration for the optimizer itself. */
export interface OptimizerConfig {
  /** Grid of exit parameter values to search */
  grid: GridSpec;
  /** Skip combos with fewer validate trades than this floor (default 5) */
  minTradesFloor: number;
}
