/**
 * Tournament constants.
 */

/**
 * Minimum OOS trades in a regime required to include a strategy on the regime leaderboard.
 * Regimes naturally cover a fraction of time (e.g. 20%), so trade counts are sparse.
 * Intentionally lower than the optimizer's MIN_TRADES_FLOOR (5).
 */
export const MIN_REGIME_TRADES = 3;
