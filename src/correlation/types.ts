/**
 * Correlation module types and configuration schema.
 *
 * Exports:
 * - CorrelationSnapshot: result of a single correlation computation
 * - correlationConfigSchema: Zod schema for correlation config
 * - CorrelationConfig: inferred type from schema
 * - daysToCandles: utility to convert a day count to candle count given a timeframe
 */

import { z } from 'zod';
import { TIMEFRAME_MINUTES } from '../core/types.js';
import type { Timeframe } from '../core/types.js';

// ---------------------------------------------------------------------------
// CorrelationSnapshot
// ---------------------------------------------------------------------------

/**
 * The result of a single Pearson correlation computation between BTC and ETH
 * log-returns over a rolling window.
 */
export interface CorrelationSnapshot {
  /** Pearson r between BTC and ETH log-returns, in [-1, 1] */
  correlation: number;
  /** Number of log-returns used in this computation (aligned candles - 1) */
  windowSize: number;
  /** Unix millisecond timestamp of the most recent candle in the window */
  timestamp: number;
}

// ---------------------------------------------------------------------------
// CorrelationConfig Zod schema
// ---------------------------------------------------------------------------

export const correlationConfigSchema = z.object({
  /**
   * Rolling window size in candles (NOT days).
   * Caller converts days to candles based on the session timeframe.
   * Minimum 30 candles; default 720 (= 30 days at 1h candles).
   */
  windowCandles: z.number().int().min(30).default(720),

  /** Whether correlation-aware sizing is enabled (default true). */
  enabled: z.boolean().default(true),
});

/** Validated CorrelationConfig type (inferred from Zod schema). */
export type CorrelationConfig = z.infer<typeof correlationConfigSchema>;

// ---------------------------------------------------------------------------
// daysToCandles utility
// ---------------------------------------------------------------------------

/**
 * Convert a number of days to a candle count for the given timeframe.
 *
 * Uses TIMEFRAME_MINUTES from src/core/types.ts. Falls back to 60-minute
 * candles (1h) for unknown timeframe strings.
 *
 * Examples:
 *   daysToCandles(30, '1h')  → 720
 *   daysToCandles(30, '4h')  → 180
 *   daysToCandles(30, '1D')  → 30
 */
export function daysToCandles(days: number, timeframe: string): number {
  const minutesPerCandle =
    TIMEFRAME_MINUTES[timeframe as Timeframe] ?? 60;
  return Math.ceil((days * 24 * 60) / minutesPerCandle);
}
