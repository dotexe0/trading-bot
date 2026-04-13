/**
 * Exit logic configuration with Zod validation.
 *
 * Provides a schema with sensible defaults for all four exit types:
 * trailing stop, partial exit, time-based exit, and ATR-dynamic stop.
 *
 * The exitConfigSchema is designed to be merged into strategy schemas
 * via .merge(exitConfigSchema) to add an optional exits block.
 */

import { z } from 'zod';
import type { ExitConfig } from './types.js';

// ── Default values ──────────────────────────────────────────────────

const TRAILING_DEFAULTS = {
  enabled: false,
  activateAfterPct: 0.02,
  trailAtrMultiple: 2.0,
} as const;

const PARTIAL_DEFAULTS = {
  enabled: false,
  profitTargetPct: 0.03,
  closeFraction: 0.5,
} as const;

const TIME_DEFAULTS = {
  enabled: false,
  maxCandlesHeld: 20,
  pnlThresholdPct: 0.0,
} as const;

const ATR_STOP_DEFAULTS = {
  enabled: false,
  atrPeriod: 14,
  atrMultiple: 2.0,
} as const;

// ── Sub-schemas ─────────────────────────────────────────────────────

const trailingExitSchema = z
  .object({
    enabled: z.boolean().default(TRAILING_DEFAULTS.enabled),
    activateAfterPct: z.number().min(0).max(1.0).default(TRAILING_DEFAULTS.activateAfterPct),
    trailAtrMultiple: z.number().positive().default(TRAILING_DEFAULTS.trailAtrMultiple),
  })
  .default(TRAILING_DEFAULTS);

const partialExitSchema = z
  .object({
    enabled: z.boolean().default(PARTIAL_DEFAULTS.enabled),
    profitTargetPct: z.number().min(0).max(1.0).default(PARTIAL_DEFAULTS.profitTargetPct),
    closeFraction: z.number().min(0.01).max(1.0).default(PARTIAL_DEFAULTS.closeFraction),
  })
  .default(PARTIAL_DEFAULTS);

const timeExitSchema = z
  .object({
    enabled: z.boolean().default(TIME_DEFAULTS.enabled),
    maxCandlesHeld: z.number().int().positive().default(TIME_DEFAULTS.maxCandlesHeld),
    pnlThresholdPct: z.number().default(TIME_DEFAULTS.pnlThresholdPct),
  })
  .default(TIME_DEFAULTS);

const atrMultipleByRegimeSchema = z
  .object({
    TRENDING: z.number().positive().optional(),
    RANGING: z.number().positive().optional(),
    VOLATILE: z.number().positive().optional(),
  })
  .optional();

const atrStopSchema = z
  .object({
    enabled: z.boolean().default(ATR_STOP_DEFAULTS.enabled),
    atrPeriod: z.number().int().positive().default(ATR_STOP_DEFAULTS.atrPeriod),
    atrMultiple: z.number().positive().default(ATR_STOP_DEFAULTS.atrMultiple),
    atrMultipleByRegime: atrMultipleByRegimeSchema,
  })
  .default(ATR_STOP_DEFAULTS);

// ── Main exit config schema ─────────────────────────────────────────

/**
 * Exit configuration schema (merge-compatible).
 *
 * Shape: z.object({ exits: z.object({ trailing, partial, time, atrStop }).default(...) })
 *
 * This schema can be merged into strategy schemas:
 *   strategySchema.merge(exitConfigSchema).refine(...)
 *
 * The `exits` field defaults to a fully-disabled config when not provided.
 */
export const exitConfigSchema = z.object({
  exits: z
    .object({
      trailing: trailingExitSchema,
      partial: partialExitSchema,
      time: timeExitSchema,
      atrStop: atrStopSchema,
    })
    .default({
      trailing: TRAILING_DEFAULTS,
      partial: PARTIAL_DEFAULTS,
      time: TIME_DEFAULTS,
      atrStop: ATR_STOP_DEFAULTS,
    }),
});

// ── Parse function ──────────────────────────────────────────────────

/**
 * Parse and validate a raw exit config.
 * Throws on invalid input with descriptive error messages.
 * Returns a fully defaulted ExitConfig when called with `{}`.
 */
export function parseExitConfig(raw: unknown): ExitConfig {
  const result = exitConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map(
      (i) => `${i.path.join('.')}: ${i.message}`,
    );
    throw new Error(`Invalid exit config: ${issues.join('; ')}`);
  }
  return result.data;
}
