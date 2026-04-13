/**
 * MACD Momentum Strategy
 *
 * Generates signals when MACD line crosses above/below the signal line.
 * Bullish crossover (MACD crosses above signal) = long signal.
 * Bearish crossover (MACD crosses below signal) = short signal.
 * Confidence is based on histogram magnitude relative to recent history.
 */

import type { Candle, TradingPair, Timeframe } from '../core/types.js';
import type { IndicatorConfig, MACDPoint } from '../indicators/types.js';
import { IndicatorEngine } from '../indicators/engine.js';
import { MarketRegime } from '../regime/types.js';
import type { IStrategy, Signal } from './types.js';

interface MacdMomentumParams {
  fastPeriod: number;
  slowPeriod: number;
  signalPeriod: number;
}

export class MacdMomentumStrategy implements IStrategy {
  readonly name = 'macd-momentum';
  readonly minCandles: number;
  readonly requiredIndicators: IndicatorConfig[];

  private readonly engine = new IndicatorEngine();
  private readonly fastPeriod: number;
  private readonly slowPeriod: number;
  private readonly signalPeriod: number;

  constructor(config: MacdMomentumParams) {
    this.fastPeriod = config.fastPeriod;
    this.slowPeriod = config.slowPeriod;
    this.signalPeriod = config.signalPeriod;
    this.minCandles = this.slowPeriod + this.signalPeriod;
    this.requiredIndicators = [
      {
        name: 'MACD',
        fastPeriod: this.fastPeriod,
        slowPeriod: this.slowPeriod,
        signalPeriod: this.signalPeriod,
      },
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

    // Regime filter: only generate signals in TRENDING markets (per user decision)
    if (regime !== undefined && regime !== MarketRegime.TRENDING) {
      return [];
    }

    const result = this.engine.compute(
      {
        name: 'MACD',
        fastPeriod: this.fastPeriod,
        slowPeriod: this.slowPeriod,
        signalPeriod: this.signalPeriod,
      },
      candles,
    );
    const points = result.values as MACDPoint[];

    // Find last 2 valid points (where MACD and signal are both defined)
    const validPoints: MACDPoint[] = [];
    for (let i = points.length - 1; i >= 0 && validPoints.length < 2; i--) {
      const p = points[i];
      if (p.MACD !== undefined && p.signal !== undefined) {
        validPoints.unshift(p);
      }
    }

    if (validPoints.length < 2) return [];

    const prev = validPoints[0];
    const curr = validPoints[1];

    // Guard: ensure all values are defined (TypeScript narrowing)
    if (
      prev.MACD === undefined ||
      prev.signal === undefined ||
      curr.MACD === undefined ||
      curr.signal === undefined
    ) {
      return [];
    }

    const signals: Signal[] = [];
    const timestamp = candles[candles.length - 1].timestamp;

    // Calculate confidence from histogram magnitude relative to recent history
    const recentPoints = points.slice(-10);
    let maxAbsHistogram = 0;
    for (const p of recentPoints) {
      const absH = Math.abs(p.histogram ?? 0);
      if (absH > maxAbsHistogram) maxAbsHistogram = absH;
    }
    const rawConfidence =
      maxAbsHistogram === 0
        ? 0.3
        : Math.abs(curr.histogram ?? 0) / maxAbsHistogram;
    const confidence = Math.round(Math.min(Math.max(rawConfidence, 0), 1) * 100) / 100;

    // Bullish crossover: MACD crosses above signal
    if (prev.MACD <= prev.signal && curr.MACD > curr.signal) {
      signals.push({
        strategyName: this.name,
        pair,
        timeframe,
        timestamp,
        direction: 'long',
        confidence,
        reasoning: `MACD crossed above signal. MACD=${curr.MACD.toFixed(2)}, Signal=${curr.signal.toFixed(2)}, Histogram=${(curr.histogram ?? 0).toFixed(2)}`,
      });
    }

    // Bearish crossover: MACD crosses below signal
    if (prev.MACD >= prev.signal && curr.MACD < curr.signal) {
      signals.push({
        strategyName: this.name,
        pair,
        timeframe,
        timestamp,
        direction: 'short',
        confidence,
        reasoning: `MACD crossed below signal. MACD=${curr.MACD.toFixed(2)}, Signal=${curr.signal.toFixed(2)}, Histogram=${(curr.histogram ?? 0).toFixed(2)}`,
      });
    }

    return signals;
  }
}
