/**
 * FeeConfig — thin value object carrying the FCM taker/maker fee rates.
 *
 * Fetched once at startup via IntxClient.fetchFeeConfig() and passed by
 * reference to all downstream subsystems (tournament runner, risk gate).
 * Never persisted to SQLite — a single number with a well-known fallback.
 */

/** FCM promotional taker rate (used as fallback when API fetch fails). */
export const FCM_FALLBACK_TAKER_RATE = 0.0003;

/** FCM promotional maker rate (0 for post-only limit orders). */
export const FCM_FALLBACK_MAKER_RATE = 0.0000;

/**
 * FeeConfig value object.
 *
 * takerFeeRate  — FCM taker fee as a decimal (e.g. 0.0003 = 0.03%)
 * makerFeeRate  — FCM maker fee as a decimal (e.g. 0.0000 = free for post-only)
 * source        — 'api' if fetched from getTransactionSummary, 'fallback' if defaults used
 */
export interface FeeConfig {
  takerFeeRate: number;
  makerFeeRate: number;
  source: 'api' | 'fallback';
}

/** Default FeeConfig used when the API call fails or returns a malformed response. */
export const DEFAULT_FEE_CONFIG: FeeConfig = {
  takerFeeRate: FCM_FALLBACK_TAKER_RATE,
  makerFeeRate: FCM_FALLBACK_MAKER_RATE,
  source: 'fallback',
};
