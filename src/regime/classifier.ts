/**
 * RegimeClassifier -- classifies the current market regime from candle history.
 *
 * Uses ADX(14) for trend detection and ATR(14) relative to its rolling average
 * for volatility detection. A 5-candle smoothing window prevents whipsaw.
 */

import type { Candle } from '../core/types.js';
import { IndicatorEngine } from '../indicators/engine.js';
import type { ADXPoint } from '../indicators/types.js';
import { MarketRegime } from './types.js';
import {
  ADX_TREND_THRESHOLD,
  ATR_VOLATILE_MULTIPLIER,
  ATR_ROLLING_AVERAGE_PERIOD,
  REGIME_SMOOTHING_WINDOW,
  MIN_REGIME_CANDLES,
} from './constants.js';

export class RegimeClassifier {
  private readonly engine = new IndicatorEngine();

  /**
   * Classify the current market regime from candle history.
   *
   * Returns undefined if there are insufficient candles (< MIN_REGIME_CANDLES).
   * Applies a 5-candle smoothing window: regime only changes when 5 consecutive
   * raw labels agree.
   *
   * @param candles - Historical candles sorted ascending by timestamp
   * @returns MarketRegime enum value, or undefined if insufficient data
   */
  classify(candles: Candle[]): MarketRegime | undefined {
    if (candles.length < MIN_REGIME_CANDLES) {
      return undefined;
    }

    // Compute ADX(14) and ATR(14) over all candles
    const adxResult = this.engine.compute({ name: 'ADX', period: 14 }, candles);
    const atrResult = this.engine.compute({ name: 'ATR', period: 14 }, candles);

    const adxValues = adxResult.values as ADXPoint[];
    const atrValues = atrResult.values as number[];

    if (adxValues.length === 0 || atrValues.length === 0) {
      return undefined;
    }

    // Compute raw labels for all candle positions where both ADX and ATR have values.
    // The arrays may be different lengths due to different warm-up periods, so we
    // align from the end (latest candle).
    const rawLabels: MarketRegime[] = [];

    // Number of aligned positions = min of both arrays lengths
    const alignedCount = Math.min(adxValues.length, atrValues.length);

    for (let i = 0; i < alignedCount; i++) {
      // Index from the end: 0 = most recent, alignedCount-1 = oldest in the aligned window
      const adxPoint = adxValues[adxValues.length - 1 - i];
      const atrIndex = atrValues.length - 1 - i;
      const atrValue = atrValues[atrIndex];

      // Guard: ADX must be defined
      if (adxPoint.adx === undefined) {
        rawLabels.push(MarketRegime.RANGING);
        continue;
      }

      // Compute the rolling average of ATR using the ATR_ROLLING_AVERAGE_PERIOD values
      // BEFORE the current position (exclusive of current, historical data only).
      // This avoids lookahead bias.
      const atrHistoryStart = Math.max(0, atrIndex - ATR_ROLLING_AVERAGE_PERIOD);
      const atrHistorySlice = atrValues.slice(atrHistoryStart, atrIndex);

      if (atrHistorySlice.length === 0) {
        rawLabels.push(MarketRegime.RANGING);
        continue;
      }

      const atrRollingAvg =
        atrHistorySlice.reduce((sum, v) => sum + v, 0) / atrHistorySlice.length;

      rawLabels.push(this.classifyRaw(adxPoint.adx, atrValue, atrRollingAvg));
    }

    // rawLabels[0] = most recent, rawLabels[N-1] = oldest
    // Reverse to process from oldest to newest for the smoother
    const labelsOldToNew = rawLabels.slice().reverse();

    // Apply smoothing: walk from oldest to newest, updating currentRegime only
    // when the last REGIME_SMOOTHING_WINDOW labels all agree.
    let currentRegime = MarketRegime.RANGING;

    for (let i = REGIME_SMOOTHING_WINDOW - 1; i < labelsOldToNew.length; i++) {
      const window = labelsOldToNew.slice(i - (REGIME_SMOOTHING_WINDOW - 1), i + 1);
      const allSame = window.every((l) => l === window[0]);
      if (allSame) {
        currentRegime = window[0];
      }
    }

    return currentRegime;
  }

  /**
   * Classify a single raw data point into a market regime.
   *
   * Priority: TRENDING (ADX dominates) > VOLATILE (ATR spike) > RANGING (default).
   */
  private classifyRaw(
    adxValue: number,
    atrValue: number,
    atrRollingAvg: number,
  ): MarketRegime {
    if (adxValue > ADX_TREND_THRESHOLD) {
      return MarketRegime.TRENDING;
    }
    if (atrValue > ATR_VOLATILE_MULTIPLIER * atrRollingAvg) {
      return MarketRegime.VOLATILE;
    }
    return MarketRegime.RANGING;
  }
}
