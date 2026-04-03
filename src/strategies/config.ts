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

const momentumBreakoutSchema = z
  .object({
    strategy: z.literal('momentum-breakout'),
    breakoutWindow: z.number().int().positive().default(10),
    volumeWindow: z.number().int().positive().default(10),
    volumeMultiplier: z.number().positive().default(1.5),
  })
  .merge(exitConfigSchema);
// No .refine() -- breakoutWindow, volumeWindow, volumeMultiplier have no cross-field constraints

// -- Perp strategy schemas ------------------------------------------------
// NOTE: fundingRateProvider is a runtime-injected callback and is NOT part of
// the Zod schema (not serializable). Only scalar config params are stored here.

const perpMomentumSchema = z
  .object({
    strategy: z.literal('perp-momentum'),
    breakoutWindow: z.number().int().positive().default(20),
    volumeWindow: z.number().int().positive().default(20),
    volumeMultiplier: z.number().positive().default(1.5),
    fundingThreshold: z.number().positive().default(0.01),
  })
  .merge(exitConfigSchema);

const perpMeanReversionSchema = z
  .object({
    strategy: z.literal('perp-mean-reversion'),
    period: z.number().int().positive().default(20),
    threshold: z.number().positive().default(1.5),
    fundingThreshold: z.number().positive().default(0.01),
  })
  .merge(exitConfigSchema);

// NOTE: markPriceProvider, basisProvider, and tournamentMode are runtime-injected
// callbacks/flags — NOT part of Zod schemas (not serializable). Only scalar config
// params are stored here, matching the pattern for perpMomentumSchema and
// perpMeanReversionSchema.

const fundingRateArbSchema = z
  .object({
    strategy: z.literal('funding-rate-arb'),
    threshold: z.number().positive().default(0.0005),
  })
  .merge(exitConfigSchema);

const basisTradeSchema = z
  .object({
    strategy: z.literal('basis-trade'),
    period: z.number().int().positive().default(20),
    threshold: z.number().positive().default(1.5),
  })
  .merge(exitConfigSchema);

// -- Scalping perp strategy schemas ---------------------------------------
// NOTE: fundingRateProvider is a runtime-injected callback and is NOT part of
// the Zod schema (not serializable). Only scalar config params are stored here.

const perpVwapReversionSchema = z
  .object({
    strategy: z.literal('perp-vwap-reversion'),
    vwapPeriod: z.number().int().positive().default(15),
    zScoreThreshold: z.number().positive().default(1.5),
    maxHoldCandles: z.number().int().positive().default(8),
    stopLossPct: z.number().positive().max(0.05).default(0.005),
    fundingThreshold: z.number().positive().default(0.01),
  })
  .merge(exitConfigSchema);

const perpMicroMomentumSchema = z
  .object({
    strategy: z.literal('perp-micro-momentum'),
    fastEmaPeriod: z.number().int().positive().default(5),
    slowEmaPeriod: z.number().int().positive().default(12),
    rsiPeriod: z.number().int().positive().default(7),
    volumeWindow: z.number().int().positive().default(5),
    volumeMultiplier: z.number().positive().default(1.5),
    maxHoldCandles: z.number().int().positive().default(8),
    stopLossPct: z.number().positive().max(0.05).default(0.005),
    fundingThreshold: z.number().positive().default(0.01),
  })
  .merge(exitConfigSchema)
  .refine((d) => d.fastEmaPeriod < d.slowEmaPeriod, {
    message: 'fastEmaPeriod must be less than slowEmaPeriod',
  });

// -- Discriminated union --------------------------------------------------

export const strategyConfigSchema = z.discriminatedUnion('strategy', [
  smaCrossoverSchema,
  rsiMeanReversionSchema,
  macdMomentumSchema,
  bollingerBreakoutSchema,
  zScoreMeanReversionSchema,
  multiTimeframeTrendSchema,
  momentumBreakoutSchema,
  perpMomentumSchema,
  perpMeanReversionSchema,
  fundingRateArbSchema,
  basisTradeSchema,
  perpVwapReversionSchema,
  perpMicroMomentumSchema,
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
