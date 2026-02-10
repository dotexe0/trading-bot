/**
 * Risk management configuration with Zod validation.
 *
 * Provides a schema with sensible defaults for position sizing,
 * stop-losses, drawdown limits, and circuit breakers.
 */

import { z } from 'zod';
import type { RiskConfig } from './types.js';

// ── Zod schema ───────────────────────────────────────────────────────

export const riskConfigSchema = z.object({
  /** Position sizing method */
  sizingMethod: z
    .enum(['kelly', 'half-kelly', 'fixed-fraction'])
    .default('half-kelly'),

  /** Kelly fraction multiplier (0.5 = half-Kelly) */
  kellyFraction: z.number().min(0.1).max(1.0).default(0.5),

  /** Fixed-fraction percentage of equity per trade */
  fixedFractionPct: z.number().min(0.001).max(0.5).default(0.02),

  /** Maximum position size as percentage of equity */
  maxPositionPct: z.number().min(0.01).max(0.5).default(0.25),

  /** Minimum number of trades before Kelly criterion is used */
  minTradesForKelly: z.number().int().min(1).default(30),

  /** Stop-loss configuration */
  stopLoss: z
    .object({
      type: z.enum(['fixed', 'trailing']).default('fixed'),
      percentage: z.number().min(0.001).max(0.5).default(0.05),
    })
    .default({ type: 'fixed' as const, percentage: 0.05 }),

  /** Maximum portfolio drawdown before circuit breaker triggers */
  maxDrawdownPct: z.number().min(0.01).max(0.5).default(0.15),

  /** Maximum daily loss before circuit breaker triggers */
  maxDailyLossPct: z.number().min(0.005).max(0.2).default(0.05),

  /** Maximum total exposure as percentage of equity */
  maxExposurePct: z.number().min(0.1).max(1.0).default(0.95),

  /** Maximum number of concurrent open positions */
  maxPositionCount: z.number().int().min(1).max(20).default(4),

  /** Cooldown period after circuit breaker triggers (ms) */
  circuitBreakerCooldownMs: z.number().int().min(0).default(0),
});

// ── Parse function ───────────────────────────────────────────────────

/**
 * Parse and validate a raw risk config.
 * Throws on invalid input with descriptive error messages.
 * Returns a fully defaulted RiskConfig when called with `{}`.
 */
export function parseRiskConfig(raw: unknown): RiskConfig {
  const result = riskConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map(
      (i) => `${i.path.join('.')}: ${i.message}`,
    );
    throw new Error(`Invalid risk config: ${issues.join('; ')}`);
  }
  return result.data;
}
