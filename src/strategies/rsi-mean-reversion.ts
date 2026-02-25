/**
 * RSI Mean-Reversion Strategy
 *
 * Generates signals when RSI enters extreme zones (oversold/overbought).
 * RSI below oversold threshold = long signal (expect bounce up).
 * RSI above overbought threshold = short signal (expect pullback).
 * Confidence increases the deeper RSI goes into the extreme zone.
 */

import type { Candle, TradingPair, Timeframe } from '../core/types.js';
import type { IndicatorConfig } from '../indicators/types.js';
import { IndicatorEngine } from '../indicators/engine.js';
import type { MarketRegime } from '../regime/types.js';
import type { IStrategy, Signal } from './types.js';

interface RsiMeanReversionParams {
  period: number;
  oversoldThreshold: number;
  overboughtThreshold: number;
}

export class RsiMeanReversionStrategy implements IStrategy {
  readonly name = 'rsi-mean-reversion';
  readonly minCandles: number;
  readonly requiredIndicators: IndicatorConfig[];

  private readonly engine = new IndicatorEngine();
  private readonly period: number;
  private readonly oversoldThreshold: number;
  private readonly overboughtThreshold: number;

  constructor(config: RsiMeanReversionParams) {
    this.period = config.period;
    this.oversoldThreshold = config.oversoldThreshold;
    this.overboughtThreshold = config.overboughtThreshold;
    this.minCandles = this.period + 2;
    this.requiredIndicators = [{ name: 'RSI', period: this.period }];
  }

  evaluate(
    candles: Candle[],
    pair: TradingPair,
    timeframe: Timeframe,
    _additionalCandles?: Map<Timeframe, Candle[]>,
    _regime?: MarketRegime,
  ): Signal[] {
    if (candles.length < this.minCandles) return [];

    const result = this.engine.compute({ name: 'RSI', period: this.period }, candles);
    const values = result.values as number[];

    if (values.length < 1) return [];

    const currentRsi = values[values.length - 1];
    const signals: Signal[] = [];
    const timestamp = candles[candles.length - 1].timestamp;

    // Oversold -> long signal
    if (currentRsi <= this.oversoldThreshold) {
      const rawConfidence = (this.oversoldThreshold - currentRsi) / this.oversoldThreshold;
      const confidence = Math.round(Math.min(Math.max(rawConfidence, 0), 1) * 100) / 100;
      signals.push({
        strategyName: this.name,
        pair,
        timeframe,
        timestamp,
        direction: 'long',
        confidence,
        reasoning: `RSI(${this.period})=${currentRsi.toFixed(1)} below oversold threshold ${this.oversoldThreshold}`,
      });
    }

    // Overbought -> short signal
    if (currentRsi >= this.overboughtThreshold) {
      const rawConfidence = (currentRsi - this.overboughtThreshold) / (100 - this.overboughtThreshold);
      const confidence = Math.round(Math.min(Math.max(rawConfidence, 0), 1) * 100) / 100;
      signals.push({
        strategyName: this.name,
        pair,
        timeframe,
        timestamp,
        direction: 'short',
        confidence,
        reasoning: `RSI(${this.period})=${currentRsi.toFixed(1)} above overbought threshold ${this.overboughtThreshold}`,
      });
    }

    return signals;
  }
}
