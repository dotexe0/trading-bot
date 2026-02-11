/**
 * Live trading configuration with Zod validation.
 *
 * Provides a schema with sensible defaults for live trading sessions.
 * Follows the same pattern as paper/config.ts.
 */

import { z } from 'zod';
import { DEFAULT_FEE_MAKER, DEFAULT_FEE_TAKER } from '../backtest/types.js';
import { riskConfigSchema } from '../risk/config.js';

// ── Zod schema ───────────────────────────────────────────────────────

export const liveConfigSchema = z.object({
  /** Trading pair */
  pair: z.enum(['BTC-USD', 'ETH-USD']),

  /** Candle timeframe */
  timeframe: z.enum(['1m', '5m', '15m', '1h', '4h', '1D']),

  /** Strategy configuration (opaque key-value, validated by strategy registry) */
  strategyConfig: z.record(z.string(), z.unknown()),

  /** Initial capital as string for decimal precision */
  initialCapital: z.string().default('10000'),

  /** Whether to allow short positions */
  allowShorts: z.boolean().default(false),

  /** Slippage in basis points (0-100) */
  slippageBps: z.number().min(0).max(100).default(5),

  /** Maker fee rate */
  feeTierMaker: z.number().min(0).max(0.1).default(DEFAULT_FEE_MAKER),

  /** Taker fee rate */
  feeTierTaker: z.number().min(0).max(0.1).default(DEFAULT_FEE_TAKER),

  /** Whether to assume taker fees (market orders) */
  assumeTaker: z.boolean().default(true),

  /** Sliding window size for candle buffer */
  bufferSize: z.number().int().min(50).max(2000).default(500),

  /** Optional risk management configuration */
  riskConfig: riskConfigSchema.optional(),

  /** How often to reconcile with exchange (ms) */
  reconciliationIntervalMs: z.number().int().min(10000).default(60000),

  /** Max retry count for failed order submissions */
  maxOrderRetries: z.number().int().min(0).default(3),

  /** Max time for graceful shutdown (ms) */
  shutdownTimeoutMs: z.number().int().min(5000).default(30000),

  /** Whether to place stop-loss orders during shutdown */
  enableStopLossOnShutdown: z.boolean().default(true),

  /** REST fallback polling interval in milliseconds */
  pollIntervalMs: z.number().int().min(1000).default(60000),
});

// ── Parse function ───────────────────────────────────────────────────

/**
 * Parse and validate a raw live trading config.
 * Throws on invalid input with descriptive error messages.
 */
export function parseLiveConfig(
  raw: unknown,
): z.infer<typeof liveConfigSchema> {
  const result = liveConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map(
      (i) => `${i.path.join('.')}: ${i.message}`,
    );
    throw new Error(`Invalid live trading config: ${issues.join('; ')}`);
  }
  return result.data;
}
