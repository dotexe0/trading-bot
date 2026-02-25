/**
 * Multi-Timeframe Trend Strategy
 *
 * Combines a higher timeframe EMA trend filter with a lower timeframe
 * entry EMA for aligned trend-following signals.
 * Long signal: higher TF bullish AND entry TF bullish.
 * Short signal: higher TF bearish AND entry TF bearish.
 * No signal when timeframes conflict (no alignment).
 */

import type { Candle, TradingPair, Timeframe } from '../core/types.js';
import type { IndicatorConfig } from '../indicators/types.js';
import { IndicatorEngine } from '../indicators/engine.js';
import { MarketRegime } from '../regime/types.js';
import type { IStrategy, Signal } from './types.js';

interface MultiTimeframeTrendParams {
  trendTimeframe: string;
  trendEmaPeriod: number;
  entryEmaPeriod: number;
  atrPeriod: number;
}

export class MultiTimeframeTrendStrategy implements IStrategy {
  readonly name = 'multi-timeframe-trend';
  readonly minCandles: number;
  readonly requiredIndicators: IndicatorConfig[];

  private readonly engine = new IndicatorEngine();
  private readonly trendTimeframe: Timeframe;
  private readonly trendEmaPeriod: number;
  private readonly entryEmaPeriod: number;
  private readonly atrPeriod: number;

  constructor(config: MultiTimeframeTrendParams) {
    this.trendTimeframe = config.trendTimeframe as Timeframe;
    this.trendEmaPeriod = config.trendEmaPeriod;
    this.entryEmaPeriod = config.entryEmaPeriod;
    this.atrPeriod = config.atrPeriod;
    this.minCandles = Math.max(this.trendEmaPeriod, this.entryEmaPeriod) + 1;
    this.requiredIndicators = [
      { name: 'EMA', period: this.entryEmaPeriod },
      { name: 'ATR', period: this.atrPeriod },
    ];
  }

  evaluate(
    candles: Candle[],
    pair: TradingPair,
    timeframe: Timeframe,
    additionalCandles?: Map<Timeframe, Candle[]>,
    regime?: MarketRegime,
  ): Signal[] {
    if (candles.length < this.minCandles) return [];

    // Regime filter: only generate signals in TRENDING markets (per user decision)
    if (regime !== undefined && regime !== MarketRegime.TRENDING) {
      return [];
    }

    // Check additionalCandles for higher TF data
    if (!additionalCandles || !additionalCandles.has(this.trendTimeframe)) {
      return [];
    }

    const higherTfCandles = additionalCandles.get(this.trendTimeframe)!;
    if (higherTfCandles.length < this.trendEmaPeriod) return [];

    // Compute higher TF EMA
    const trendEmaResult = this.engine.compute(
      { name: 'EMA', period: this.trendEmaPeriod },
      higherTfCandles,
    );
    const trendEmaValues = trendEmaResult.values as number[];
    if (trendEmaValues.length === 0) return [];

    // Compute entry TF EMA
    const entryEmaResult = this.engine.compute(
      { name: 'EMA', period: this.entryEmaPeriod },
      candles,
    );
    const entryEmaValues = entryEmaResult.values as number[];
    if (entryEmaValues.length === 0) return [];

    // Get latest values
    const trendEma = trendEmaValues[trendEmaValues.length - 1];
    const trendClose = parseFloat(higherTfCandles[higherTfCandles.length - 1].close);
    const entryEma = entryEmaValues[entryEmaValues.length - 1];
    const entryClose = parseFloat(candles[candles.length - 1].close);

    // Determine trend direction
    const higherTfBullish = trendClose > trendEma;
    const higherTfBearish = trendClose < trendEma;
    const entryBullish = entryClose > entryEma;
    const entryBearish = entryClose < entryEma;

    const signals: Signal[] = [];
    const timestamp = candles[candles.length - 1].timestamp;

    let direction: 'long' | 'short' | null = null;

    if (higherTfBullish && entryBullish) {
      direction = 'long';
    } else if (higherTfBearish && entryBearish) {
      direction = 'short';
    }

    if (direction === null) return [];

    // Calculate confidence from trend strength + entry alignment
    const trendStrength = Math.abs(trendClose - trendEma) / trendEma;
    const entryStrength = Math.abs(entryClose - entryEma) / entryEma;
    const rawConfidence = (trendStrength + entryStrength) * 50;
    const confidence = Math.round(Math.min(Math.max(rawConfidence, 0), 1) * 100) / 100;

    signals.push({
      strategyName: this.name,
      pair,
      timeframe,
      timestamp,
      direction,
      confidence,
      reasoning: `Multi-TF trend aligned ${direction}. ${this.trendTimeframe} EMA(${this.trendEmaPeriod}): price ${trendClose > trendEma ? 'above' : 'below'} (${trendClose.toFixed(2)} vs ${trendEma.toFixed(2)}). Entry EMA(${this.entryEmaPeriod}): ${entryClose.toFixed(2)} vs ${entryEma.toFixed(2)}`,
    });

    return signals;
  }
}
