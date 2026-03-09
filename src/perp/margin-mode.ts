/**
 * Margin mode mapping for Coinbase FCM perpetual futures positions.
 *
 * NOTE: Coinbase FCM has NO setMarginMode API. 'isolated' vs 'cross' here are
 * bot-internal risk semantics:
 *   - 'isolated' (VOLATILE): enforces a tight per-trade max-loss cap — the bot
 *     will hard-close the position at the configured perpMaxLossPct threshold.
 *   - 'cross' (TRENDING/RANGING): uses portfolio-wide margin accounting — the bot
 *     allows wider stop distances based on strategy ATR multiples.
 *
 * Usage: call getMarginMode() alongside computeLeverage() before opening a position
 * so the risk gate and stop-loss logic can apply the correct enforcement policy.
 */

import { MarketRegime } from '../regime/types.js';

/**
 * Bot-internal margin mode classification.
 *   - 'isolated': tight per-trade loss cap (used in VOLATILE regime)
 *   - 'cross':    portfolio-wide margin (used in TRENDING / RANGING regimes)
 */
export type MarginMode = 'isolated' | 'cross';

/**
 * Determine the margin mode for a new position based on market regime.
 *
 * @param regime - Current market regime classification.
 * @returns 'isolated' for VOLATILE; 'cross' for TRENDING and RANGING.
 */
export function getMarginMode(regime: MarketRegime): MarginMode {
  return regime === MarketRegime.VOLATILE ? 'isolated' : 'cross';
}
