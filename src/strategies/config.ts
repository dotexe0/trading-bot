/**
 * Zod schemas for strategy configuration validation.
 *
 * Each strategy has a schema that validates its parameters.
 * The top-level `strategyConfigSchema` is a discriminated union on `strategy`.
 */

import { z } from 'zod';
import { StrategyConfigError } from '../core/errors.js';
import { exitConfigSchema } from '../risk/exit-logic/config.js';

// -- Per-strategy schemas -------------------------------------------------
// Pattern: z.object({...}).merge(exitConfigSchema).refine(...)
// The .merge() adds the exits block, then .refine() validates strategy params.

const smaCrossoverSchema = z
  .object({
    strategy: z.literal('sma-crossover'),
    fastPeriod: z.number().int().positive().default(10),
    slowPeriod: z.number().int().positive().default(20),
  })
  .merge(exitConfigSchema)
  .refine((d) => d.fastPeriod < d.slowPeriod, {
    message: 'fastPeriod must be less than slowPeriod',
  });

const rsiMeanReversionSchema = z
  .object({
    strategy: z.literal('rsi-mean-reversion'),
    period: z.number().int().positive().default(14),
    oversoldThreshold: z.number().min(0).max(100).default(30),
    overboughtThreshold: z.number().min(0).max(100).default(70),
  })
  .merge(exitConfigSchema)
  .refine((d) => d.oversoldThreshold < d.overboughtThreshold, {
    message: 'oversoldThreshold must be less than overboughtThreshold',
  });

const macdMomentumSchema = z
  .object({
    strategy: z.literal('macd-momentum'),
    fastPeriod: z.number().int().positive().default(12),
    slowPeriod: z.number().int().positive().default(26),
    signalPeriod: z.number().int().positive().default(9),
  })
  .merge(exitConfigSchema)
  .refine((d) => d.fastPeriod < d.slowPeriod, {
    message: 'fastPeriod must be less than slowPeriod',
  });

const bollingerBreakoutSchema = z
  .object({
    strategy: z.literal('bollinger-breakout'),
    period: z.number().int().positive().default(20),
    stdDev: z.number().positive().default(2),
    breakoutMode: z.boolean().default(true),
  })
  .merge(exitConfigSchema);

const zScoreMeanReversionSchema = z
  .object({
    strategy: z.literal('z-score-mean-reversion'),
    period: z.number().int().positive().default(20),
    threshold: z.number().positive().default(1.5),
  })
  .merge(exitConfigSchema);

const multiTimeframeTrendSchema = z
  .object({
    strategy: z.literal('multi-timeframe-trend'),
    trendTimeframe: z.enum(['1h', '4h', '1D']).default('4h'),
    trendEmaPeriod: z.number().int().positive().default(50),
    entryEmaPeriod: z.number().int().positive().default(20),
    atrPeriod: z.number().int().positive().default(14),
  })
  .merge(exitConfigSchema);

// -- Discriminated union --------------------------------------------------

export const strategyConfigSchema = z.discriminatedUnion('strategy', [
  smaCrossoverSchema,
  rsiMeanReversionSchema,
  macdMomentumSchema,
  bollingerBreakoutSchema,
  zScoreMeanReversionSchema,
  multiTimeframeTrendSchema,
]);

// -- Inferred type --------------------------------------------------------

export type StrategyConfig = z.infer<typeof strategyConfigSchema>;

// -- Public helpers -------------------------------------------------------

/**
 * Parse and validate a raw strategy config object.
 * Throws `StrategyConfigError` on invalid input.
 */
export function parseStrategyConfig(raw: unknown): StrategyConfig {
  const result = strategyConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map(
      (i) => `${i.path.join('.')}: ${i.message}`,
    );
    throw new StrategyConfigError(
      `Invalid strategy config: ${issues.join('; ')}`,
      issues,
    );
  }
  return result.data;
}

/**
 * Validate an array of raw strategy configs.
 * Throws on the first invalid config.
 */
export function validateStrategyConfigs(configs: unknown[]): StrategyConfig[] {
  return configs.map((c) => parseStrategyConfig(c));
}
