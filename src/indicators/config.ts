/**
 * Zod schemas for indicator configuration validation.
 *
 * Each indicator has a schema that validates its parameters.
 * The top-level `indicatorConfigSchema` is a discriminated union on `name`.
 */

import { z } from 'zod';
import { IndicatorConfigError } from '../core/errors.js';
import type { IndicatorConfig } from './types.js';

// ── Per-indicator schemas ────────────────────────────────────────────

const period = z.number().int().positive().min(2);

const smaSchema = z.object({
  name: z.literal('SMA'),
  period,
});

const emaSchema = z.object({
  name: z.literal('EMA'),
  period,
});

const rsiSchema = z.object({
  name: z.literal('RSI'),
  period,
});

const macdSchema = z
  .object({
    name: z.literal('MACD'),
    fastPeriod: z.number().int().positive().default(12),
    slowPeriod: z.number().int().positive().default(26),
    signalPeriod: z.number().int().positive().default(9),
  })
  .refine((d) => d.fastPeriod < d.slowPeriod, {
    message: 'fastPeriod must be less than slowPeriod',
  });

const bollingerBandsSchema = z.object({
  name: z.literal('BollingerBands'),
  period,
  stdDev: z.number().positive().default(2),
});

const stochasticSchema = z.object({
  name: z.literal('Stochastic'),
  period,
  signalPeriod: z.number().int().positive().min(1).default(3),
});

const atrSchema = z.object({
  name: z.literal('ATR'),
  period,
});

const adxSchema = z.object({
  name: z.literal('ADX'),
  period,
});

// ── Discriminated union ──────────────────────────────────────────────

export const indicatorConfigSchema = z.discriminatedUnion('name', [
  smaSchema,
  emaSchema,
  rsiSchema,
  macdSchema,
  bollingerBandsSchema,
  stochasticSchema,
  atrSchema,
  adxSchema,
]);

// ── Public helpers ───────────────────────────────────────────────────

/**
 * Parse and validate a raw indicator config object.
 * Throws `IndicatorConfigError` on invalid input.
 */
export function parseIndicatorConfig(raw: unknown): IndicatorConfig {
  const result = indicatorConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map(
      (i) => `${i.path.join('.')}: ${i.message}`,
    );
    throw new IndicatorConfigError(
      `Invalid indicator config: ${issues.join('; ')}`,
      issues,
    );
  }
  return result.data as IndicatorConfig;
}

/**
 * Validate an array of raw indicator configs.
 * Throws on the first invalid config.
 */
export function validateIndicatorConfigs(configs: unknown[]): IndicatorConfig[] {
  return configs.map((c) => parseIndicatorConfig(c));
}

/**
 * Return the minimum number of candles required for the given indicator config.
 */
export function minCandlesRequired(config: IndicatorConfig): number {
  switch (config.name) {
    case 'SMA':
    case 'EMA':
      return config.period;
    case 'RSI':
      return config.period + 1;
    case 'MACD':
      return config.slowPeriod + config.signalPeriod - 1;
    case 'BollingerBands':
      return config.period;
    case 'Stochastic':
      return config.period + config.signalPeriod - 1;
    case 'ATR':
      return config.period + 1;
    case 'ADX':
      return config.period * 2;
  }
}
