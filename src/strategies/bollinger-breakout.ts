/**
 * Bollinger Bands Breakout Strategy
 *
 * Generates signals when price breaks above/below Bollinger Bands.
 * In breakout mode: upper break = long (momentum chase), lower break = short.
 * In mean-reversion mode: upper break = short (expect reversion), lower break = long.
 * Confidence based on %B (how far past the band the price has moved).
 */

import type { Candle, TradingPair, Timeframe } from '../core/types.js';
import type { IndicatorConfig, BollingerBandsPoint } from '../indicators/types.js';
import { IndicatorEngine } from '../indicators/engine.js';
import type { IStrategy, Signal } from './types.js';

interface BollingerBreakoutParams {
  period: number;
  stdDev: number;
  breakoutMode: boolean;
}

export class BollingerBreakoutStrategy implements IStrategy {
  readonly name = 'bollinger-breakout';
  readonly minCandles: number;
  readonly requiredIndicators: IndicatorConfig[];

  private readonly engine = new IndicatorEngine();
  private readonly period: number;
  private readonly stdDev: number;
  private readonly breakoutMode: boolean;

  constructor(config: BollingerBreakoutParams) {
    this.period = config.period;
    this.stdDev = config.stdDev;
    this.breakoutMode = config.breakoutMode;
    this.minCandles = this.period + 1;
    this.requiredIndicators = [
      { name: 'BollingerBands', period: this.period, stdDev: this.stdDev },
    ];
  }

  evaluate(
    candles: Candle[],
    pair: TradingPair,
    timeframe: Timeframe,
    _additionalCandles?: Map<Timeframe, Candle[]>,
  ): Signal[] {
    if (candles.length < this.minCandles) return [];

    const result = this.engine.compute(
      { name: 'BollingerBands', period: this.period, stdDev: this.stdDev },
      candles,
    );
    const bbValues = result.values as BollingerBandsPoint[];

    if (bbValues.length === 0) return [];

    const bb = bbValues[bbValues.length - 1];
    const close = parseFloat(candles[candles.length - 1].close);

    const signals: Signal[] = [];
    const timestamp = candles[candles.length - 1].timestamp;

    let direction: 'long' | 'short' | null = null;
    let rawConfidence = 0;

    if (close > bb.upper) {
      // Price above upper band
      direction = this.breakoutMode ? 'long' : 'short';
      rawConfidence = Math.abs(bb.pb - 1) / 0.5;
    } else if (close < bb.lower) {
      // Price below lower band
      direction = this.breakoutMode ? 'short' : 'long';
      rawConfidence = Math.abs(bb.pb) / 0.5;
    }

    if (direction !== null) {
      const confidence = Math.round(Math.min(Math.max(rawConfidence, 0), 1) * 100) / 100;
      signals.push({
        strategyName: this.name,
        pair,
        timeframe,
        timestamp,
        direction,
        confidence,
        reasoning: `Price ${this.breakoutMode ? 'broke' : 'touched'} ${close > bb.upper ? 'upper' : 'lower'} Bollinger Band. Close=${close.toFixed(2)}, Upper=${bb.upper.toFixed(2)}, Lower=${bb.lower.toFixed(2)}, %B=${bb.pb.toFixed(3)}`,
      });
    }

    return signals;
  }
}
