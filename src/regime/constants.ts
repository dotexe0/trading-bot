/**
 * Classification thresholds for regime detection.
 *
 * All values are based on research recommendations and locked user decisions.
 */

/** ADX threshold above which market is classified as TRENDING (locked decision). */
export const ADX_TREND_THRESHOLD = 25;

/** ATR multiplier: if current ATR > ATR_VOLATILE_MULTIPLIER * rollingAvg, regime is VOLATILE (locked decision). */
export const ATR_VOLATILE_MULTIPLIER = 1.5;

/** Number of historical ATR values used to compute the rolling average for volatility detection. */
export const ATR_ROLLING_AVERAGE_PERIOD = 20;

/**
 * Number of consecutive raw regime labels that must agree to trigger a regime change.
 * Smoothing prevents whipsaw from transient market conditions (locked decision).
 */
export const REGIME_SMOOTHING_WINDOW = 5;

/**
 * Minimum number of candles required to produce a regime classification.
 *
 * Binding constraint derivation:
 *   - ATR(14) offset = 14 candles (warm-up)
 *   - Need ATR_ROLLING_AVERAGE_PERIOD=20 ATR values for rolling avg
 *   - Total: 14 + 20 = 34 candles
 *   - ADX(14) warm-up = 28 candles, plus 4 for smoothing window-1 = 32 < 34
 *   - So 34 is the binding constraint.
 */
export const MIN_REGIME_CANDLES = 34;
