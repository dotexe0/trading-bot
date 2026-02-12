/**
 * Tournament configuration Zod schema and parser.
 *
 * Validates tournament parameters including walk-forward settings,
 * fee tiers, activation mode, and strategy overrides.
 */

import { z } from 'zod';
import { walkForwardConfigSchema } from '../backtest/walk-forward.js';
import { DEFAULT_FEE_MAKER, DEFAULT_FEE_TAKER } from '../backtest/types.js';

// ── Zod Schema ────────────────────────────────────────────────────────

export const tournamentConfigSchema = z
  .object({
    /** Trading pair to evaluate */
    pair: z.enum(['BTC-USD', 'ETH-USD']),
    /** Candle timeframe */
    timeframe: z.enum(['1m', '5m', '15m', '1h', '4h', '1D']),
    /** Start of evaluation period (Unix ms) */
    startMs: z.number().int().positive(),
    /** End of evaluation period (Unix ms) */
    endMs: z.number().int().positive(),
    /** Walk-forward validation configuration */
    walkForward: walkForwardConfigSchema,
    /** Initial capital for each strategy backtest */
    initialCapital: z.string().default('10000'),
    /** Slippage in basis points */
    slippageBps: z.number().min(0).max(100).default(5),
    /** Maker fee rate */
    feeTierMaker: z.number().min(0).max(0.1).default(DEFAULT_FEE_MAKER),
    /** Taker fee rate */
    feeTierTaker: z.number().min(0).max(0.1).default(DEFAULT_FEE_TAKER),
    /** Number of top strategies to consider for activation */
    topN: z.number().int().min(1).max(10).default(3),
    /** What to do with winning strategies */
    activationMode: z.enum(['paper', 'live', 'none']).default('none'),
    /** Optional explicit strategy configs (overrides registry defaults) */
    strategyConfigs: z.array(z.record(z.string(), z.unknown())).optional(),
  })
  .refine((d) => d.startMs < d.endMs, {
    message: 'startMs must be less than endMs',
    path: ['startMs'],
  });

// ── Inferred Type ─────────────────────────────────────────────────────

/** Validated tournament configuration (inferred from Zod schema). */
export type TournamentConfig = z.infer<typeof tournamentConfigSchema>;

// ── Parser ────────────────────────────────────────────────────────────

/**
 * Parse and validate a raw tournament config.
 * Throws on invalid input with descriptive error messages.
 */
export function parseTournamentConfig(raw: unknown): TournamentConfig {
  const result = tournamentConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map(
      (i) => `${i.path.join('.')}: ${i.message}`,
    );
    throw new Error(`Invalid tournament config: ${issues.join('; ')}`);
  }
  return result.data;
}
