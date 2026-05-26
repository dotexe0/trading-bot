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
    /**
     * Edge floor: minimum out-of-sample Sharpe a strategy must clear to be
     * deployable. Strategies at or below this are disqualified ("hold cash").
     * Default 0 = require demonstrated positive out-of-sample expectancy.
     */
    minOosSharpe: z.number().default(0),
    /**
     * Whether short entries are allowed in evaluation. Spot (Coinbase) cannot
     * short, so spot tournaments must set this false to match live execution.
     * Perp can short — default true.
     */
    allowShorts: z.boolean().default(true),
    /** What to do with winning strategies */
    activationMode: z.enum(['paper', 'live', 'none']).default('none'),
    /** Optional explicit strategy configs (overrides registry defaults) */
    strategyConfigs: z.array(z.record(z.string(), z.unknown())).optional(),
    /** Optional Monte Carlo configuration for MC-adjusted ranking */
    monteCarlo: z
      .object({
        enabled: z.boolean().default(false),
        iterations: z.number().int().min(100).max(100000).default(1000),
        minTrades: z.number().int().min(5).max(100).default(15),
        /** Weight of MC p5 Sharpe in composite score (0-1). Default 0.3 = 30% MC, 70% OOS Sharpe */
        rankingWeight: z.number().min(0).max(1).default(0.3),
      })
      .optional(),
    /** Quality filter thresholds -- strategies below any threshold are disqualified */
    qualityFilters: z
      .object({
        /** Minimum OOS Sortino ratio. Default 0 (non-negative). */
        minSortino: z.number().default(0),
        /** Minimum OOS Calmar ratio. Default 0.5. */
        minCalmar: z.number().min(0).default(0.5),
        /** Minimum OOS profit factor. Default 1.1. */
        minProfitFactor: z.number().min(0).default(1.1),
      })
      .optional(),
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
