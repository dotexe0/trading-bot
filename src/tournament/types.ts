/**
 * Tournament types -- interfaces for tournament execution, leaderboard,
 * and strategy activation records.
 *
 * TournamentConfig is inferred from the Zod schema in config.ts.
 */

import type { PerformanceMetrics } from '../backtest/metrics.js';

// Re-export TournamentConfig from config module (Zod-inferred)
export type { TournamentConfig } from './config.js';

/** A single entry on the tournament leaderboard. */
export interface LeaderboardEntry {
  /** Position on the leaderboard (1-indexed) */
  rank: number;
  /** Name of the strategy (e.g. 'sma-crossover') */
  strategyName: string;
  /** Full strategy config used in evaluation */
  strategyConfig: Record<string, unknown>;
  /** Out-of-sample (validation) performance metrics */
  oosMetrics: PerformanceMetrics;
  /** In-sample (training) performance metrics */
  isMetrics: PerformanceMetrics;
  /** OOS Sharpe / IS Sharpe -- detects overfitting (< 0.5 = suspect) */
  robustnessRatio: number;
  /** Number of walk-forward windows evaluated */
  windowCount: number;
}

/** Complete result from a tournament run. */
export interface TournamentResult {
  /** Unique tournament identifier */
  id: string;
  /** Configuration used for this tournament */
  config: import('./config.js').TournamentConfig;
  /** Ranked leaderboard of evaluated strategies */
  leaderboard: LeaderboardEntry[];
  /** Unix ms timestamp when tournament was run */
  runTimestamp: number;
  /** Duration of tournament execution in milliseconds */
  durationMs: number;
  /** Number of strategies evaluated */
  strategiesEvaluated: number;
}

/** Record of a strategy activated for paper or live trading. */
export interface ActivationRecord {
  /** Tournament that produced this activation */
  tournamentId: string;
  /** Strategy name */
  strategyName: string;
  /** Full strategy config */
  strategyConfig: Record<string, unknown>;
  /** Rank in tournament leaderboard */
  rank: number;
  /** Out-of-sample Sharpe ratio at activation time */
  oosSharpe: number;
  /** Trading mode ('paper' or 'live') */
  activationMode: 'paper' | 'live';
  /** Paper/live session ID if started, null if pending */
  sessionId: string | null;
  /** Unix ms timestamp when activated */
  activatedAt: number;
  /** Unix ms timestamp when deactivated, null if still active */
  deactivatedAt: number | null;
}
