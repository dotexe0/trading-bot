/**
 * SMA Crossover Strategy
 *
 * Generates signals when a fast SMA crosses above or below a slow SMA.
 * Bullish crossover (fast crosses above slow) = long signal.
 * Bearish crossover (fast crosses below slow) = short signal.
 */

import type { Candle, TradingPair, Timeframe } from '../core/types.js';
import type { IndicatorConfig } from '../indicators/types.js';
import { IndicatorEngine } from '../indicators/engine.js';
import { MarketRegime } from '../regime/types.js';
import type { IStrategy, Signal } from './types.js';

interface SmaCrossoverParams {
  fastPeriod: number;
  slowPeriod: number;
}

export class SmaCrossoverStrategy implements IStrategy {
  readonly name = 'sma-crossover';
  readonly minCandles: number;
  readonly requiredIndicators: IndicatorConfig[];

  private readonly engine = new IndicatorEngine();
  private readonly fastPeriod: number;
  private readonly slowPeriod: number;

  constructor(config: SmaCrossoverParams) {
    this.fastPeriod = config.fastPeriod;
    this.slowPeriod = config.slowPeriod;
    this.minCandles = this.slowPeriod + 1;
    this.requiredIndicators = [
      { name: 'SMA', period: this.fastPeriod },
      { name: 'SMA', period: this.slowPeriod },
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

    const fastResult = this.engine.compute(
      { name: 'SMA', period: this.fastPeriod },
      candles,
    );
    const slowResult = this.engine.compute(
      { name: 'SMA', period: this.slowPeriod },
      candles,
    );

    const fastValues = fastResult.values as number[];
    const slowValues = slowResult.values as number[];

    if (fastValues.length < 2 || slowValues.length < 2) return [];

    // Read current and previous from end of each array
    const currFast = fastValues[fastValues.length - 1];
    const prevFast = fastValues[fastValues.length - 2];
    const currSlow = slowValues[slowValues.length - 1];
    const prevSlow = slowValues[slowValues.length - 2];

    const signals: Signal[] = [];
    const spreadPct = Math.abs(currFast - currSlow) / currSlow * 100;
    const confidence = Math.round(Math.min(Math.max(spreadPct, 0), 1) * 100) / 100;
    const timestamp = candles[candles.length - 1].timestamp;

    // Bullish crossover: fast crosses above slow
    if (prevFast <= prevSlow && currFast > currSlow) {
      signals.push({
        strategyName: this.name,
        pair,
        timeframe,
        timestamp,
        direction: 'long',
        confidence,
        reasoning: `SMA(${this.fastPeriod}) crossed above SMA(${this.slowPeriod}). Fast=${currFast.toFixed(2)}, Slow=${currSlow.toFixed(2)}, Spread=${spreadPct.toFixed(3)}%`,
      });
    }

    // Bearish crossover: fast crosses below slow
    if (prevFast >= prevSlow && currFast < currSlow) {
      signals.push({
        strategyName: this.name,
        pair,
        timeframe,
        timestamp,
        direction: 'short',
        confidence,
        reasoning: `SMA(${this.fastPeriod}) crossed below SMA(${this.slowPeriod}). Fast=${currFast.toFixed(2)}, Slow=${currSlow.toFixed(2)}, Spread=${spreadPct.toFixed(3)}%`,
      });
    }

    return signals;
  }
}
