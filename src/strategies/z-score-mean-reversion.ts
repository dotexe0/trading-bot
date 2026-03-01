/**
 * Z-Score Mean Reversion Strategy
 *
 * Generates signals when price deviates significantly from its rolling mean,
 * measured in standard deviation units (Z-score).
 * Z-score below -threshold = long signal (price statistically cheap, expect reversion up).
 * Z-score above +threshold = short signal (price statistically expensive, expect reversion down).
 * Activates only in RANGING markets to avoid fighting trends.
 * Uses rolling SMA + SD from IndicatorEngine for causal computation (no lookahead).
 */

import type { Candle, TradingPair, Timeframe } from '../core/types.js';
import type { IndicatorConfig } from '../indicators/types.js';
import { IndicatorEngine } from '../indicators/engine.js';
import { MarketRegime } from '../regime/types.js';
import type { IStrategy, Signal } from './types.js';

interface ZScoreMeanReversionParams {
  period: number;
  threshold: number;
}

export class ZScoreMeanReversionStrategy implements IStrategy {
  readonly name = 'z-score-mean-reversion';
  readonly minCandles: number;
  readonly requiredIndicators: IndicatorConfig[];

  private readonly engine = new IndicatorEngine();
  private readonly period: number;
  private readonly threshold: number;

  constructor(config: ZScoreMeanReversionParams) {
    this.period = config.period;
    this.threshold = config.threshold;
    this.minCandles = this.period + 1;
    this.requiredIndicators = [
      { name: 'SMA', period: this.period },
      { name: 'SD', period: this.period },
    ];
  }

  evaluate(
    candles: Candle[],
    pair: TradingPair,
    timeframe: Timeframe,
    _additionalCandles?: Map<Timeframe, Candle[]>,
    regime?: MarketRegime,
  ): Signal[] {
    if (candles.length < this.minCandles) return [];

    // Regime filter: only generate signals in RANGING markets
    if (regime !== undefined && regime !== MarketRegime.RANGING) {
      return [];
    }

    const smaResult = this.engine.compute({ name: 'SMA', period: this.period }, candles);
    const sdResult = this.engine.compute({ name: 'SD', period: this.period }, candles);
    const smaValues = smaResult.values as number[];
    const sdValues = sdResult.values as number[];

    if (smaValues.length === 0 || sdValues.length === 0) return [];

    const close = parseFloat(candles[candles.length - 1].close);
    const mean = smaValues[smaValues.length - 1];
    const sd = sdValues[sdValues.length - 1];

    // Constant prices -> sd=0 -> Z-score undefined, skip
    if (sd === 0) return [];

    const zScore = (close - mean) / sd;
    const signals: Signal[] = [];
    const timestamp = candles[candles.length - 1].timestamp;

    // BUY signal: price statistically cheap (below mean by threshold SDs)
    if (zScore < -this.threshold) {
      const rawConfidence = Math.abs(zScore) / (this.threshold * 2);
      const confidence = Math.round(Math.min(Math.max(rawConfidence, 0), 1) * 100) / 100;
      signals.push({
        strategyName: this.name,
        pair,
        timeframe,
        timestamp,
        direction: 'long',
        confidence,
        reasoning: `Z-score=${zScore.toFixed(3)} below -${this.threshold} threshold. Close=${close.toFixed(2)}, SMA(${this.period})=${mean.toFixed(2)}, SD=${sd.toFixed(4)}`,
      });
    }

    // SELL signal: price statistically expensive (above mean by threshold SDs)
    if (zScore > this.threshold) {
      const rawConfidence = Math.abs(zScore) / (this.threshold * 2);
      const confidence = Math.round(Math.min(Math.max(rawConfidence, 0), 1) * 100) / 100;
      signals.push({
        strategyName: this.name,
        pair,
        timeframe,
        timestamp,
        direction: 'short',
        confidence,
        reasoning: `Z-score=${zScore.toFixed(3)} above +${this.threshold} threshold. Close=${close.toFixed(2)}, SMA(${this.period})=${mean.toFixed(2)}, SD=${sd.toFixed(4)}`,
      });
    }

    return signals;
  }
}
