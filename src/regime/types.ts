/**
 * Market regime types for regime-aware strategy filtering.
 */

/** Market regime classification produced by RegimeClassifier. */
export enum MarketRegime {
  /** Strong directional trend (ADX > 25). Trend-following strategies perform best. */
  TRENDING = 'TRENDING',
  /** Low volatility, sideways price action. Mean-reversion strategies perform best. */
  RANGING = 'RANGING',
  /** High volatility relative to recent history (ATR > 1.5x avg). Most strategies reduce exposure. */
  VOLATILE = 'VOLATILE',
}
