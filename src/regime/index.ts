/**
 * Regime detection module.
 *
 * Exports: MarketRegime enum, RegimeClassifier, and all threshold constants.
 */

export { MarketRegime } from './types.js';
export { RegimeClassifier } from './classifier.js';
export { RegimeStore } from './regime-store.js';
export {
  ADX_TREND_THRESHOLD,
  ATR_VOLATILE_MULTIPLIER,
  ATR_ROLLING_AVERAGE_PERIOD,
  REGIME_SMOOTHING_WINDOW,
  MIN_REGIME_CANDLES,
} from './constants.js';
