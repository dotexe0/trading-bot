/**
 * Leverage sizing for Coinbase FCM perpetual futures positions.
 *
 * NOTE: Coinbase FCM has NO setLeverage API. The `leverage` value computed here
 * controls how much notional the bot requests relative to available margin —
 * it is a bot-internal sizing multiplier, not an exchange-side lever setting.
 *
 * Usage: call computeLeverage() before opening a position to determine effective
 * leverage given current regime, signal conviction, and configured limits.
 */

import { MarketRegime } from '../regime/types.js';

/**
 * Leverage configuration embedded in FcmConfig.
 * Specifies regime-specific leverage targets and global caps.
 */
export interface LeverageConfig {
  /** Hard ceiling on leverage regardless of regime or conviction. */
  maxLeverageCap: number;
  /** Fallback leverage when regime is unrecognized (should not occur in practice). */
  defaultLeverage: number;
  /** Per-regime target leverage before conviction scaling. */
  leverageByRegime: {
    VOLATILE: number;
    TRENDING: number;
    RANGING: number;
  };
}

/**
 * Compute effective leverage for a new position.
 *
 * Algorithm:
 *   base      = leverageByRegime[regime] ?? defaultLeverage
 *   conviction = clamp(conviction, 0, 1)
 *   raw       = base * conviction
 *   result    = clamp(round(raw), 1, maxLeverageCap)
 *
 * @param regime    - Current market regime classification.
 * @param conviction - Signal conviction in [0, 1]. Values outside range are clamped.
 * @param config    - Leverage configuration from FcmConfig.
 * @returns Integer leverage in [1, maxLeverageCap].
 */
export function computeLeverage(
  regime: MarketRegime,
  conviction: number,
  config: LeverageConfig,
): number {
  const base = config.leverageByRegime[regime] ?? config.defaultLeverage;
  const clampedConviction = Math.max(0, Math.min(1, conviction));
  const raw = base * clampedConviction;
  return Math.max(1, Math.min(Math.round(raw), config.maxLeverageCap));
}
