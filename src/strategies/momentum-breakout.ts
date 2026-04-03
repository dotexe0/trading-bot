/**
 * Momentum Breakout Strategy
 *
 * Generates signals when price breaks above/below the prior N-candle
 * resistance/support level with volume confirmation.
 * BUY: current HIGH exceeds prior N-candle highest AND volume >= 1.5x rolling average.
 * SELL: current LOW falls below prior N-candle lowest AND volume >= 1.5x rolling average.
 * Activates only in TRENDING markets (momentum strategy, not mean reversion).
 *
 * Uses prior-candle approach: Highest/Lowest computed on candles.slice(0, -1)
 * to avoid the tautology where Highest(all) always >= currentHigh.
 * Volume SMA is computed inline (extractVolumes) rather than via engine.compute('SMA')
 * which uses extractCloses().
 */

import type { Candle, TradingPair, Timeframe } from '../core/types.js';
import type { IndicatorConfig } from '../indicators/types.js';
import { IndicatorEngine } from '../indicators/engine.js';
import { extractVolumes } from '../indicators/adapters.js';
import { MarketRegime } from '../regime/types.js';
import type { IStrategy, Signal } from './types.js';

interface MomentumBreakoutParams {
  breakoutWindow: number;
  volumeWindow: number;
  volumeMultiplier: number;
}

export class MomentumBreakoutStrategy implements IStrategy {
  readonly name = 'momentum-breakout';
  readonly minCandles: number;
  readonly requiredIndicators: IndicatorConfig[];

  private readonly engine = new IndicatorEngine();
  private readonly breakoutWindow: number;
  private readonly volumeWindow: number;
  private readonly volumeMultiplier: number;

  constructor(config: MomentumBreakoutParams) {
    this.breakoutWindow = config.breakoutWindow;
    this.volumeWindow = config.volumeWindow;
    this.volumeMultiplier = config.volumeMultiplier;
    // Needs enough candles for BOTH Highest/Lowest AND volume SMA.
    // The +1 is required so priorCandles = candles.slice(0, -1) has at least breakoutWindow candles.
    this.minCandles = Math.max(this.breakoutWindow, this.volumeWindow) + 1;
    this.requiredIndicators = [
      { name: 'Highest', period: this.breakoutWindow },
      { name: 'Lowest', period: this.breakoutWindow },
    ];
  }

  evaluate(
    candles: Candle[],
    pair: TradingPair,
    timeframe: Timeframe,
    _additionalCandles?: Map<Timeframe, Candle[]>,
    regime?: MarketRegime,
  ): Signal[] {
    // 1. Length guard
    if (candles.length < this.minCandles) return [];

    // 2. Regime filter: only generate signals in TRENDING markets
    if (regime !== undefined && regime !== MarketRegime.TRENDING) {
      return [];
    }

    // 3. Build priorCandles — exclude current candle so Highest/Lowest gives
    //    the prior N-candle resistance/support level
    const priorCandles = candles.slice(0, -1);

    // 4. Guard: ensure priorCandles has enough data for breakoutWindow
    if (priorCandles.length < this.breakoutWindow) return [];

    // 5. Compute Highest and Lowest on prior candles
    const highestResult = this.engine.compute(
      { name: 'Highest', period: this.breakoutWindow },
      priorCandles,
    );
    const lowestResult = this.engine.compute(
      { name: 'Lowest', period: this.breakoutWindow },
      priorCandles,
    );

    // 6. Extract last values as resistance and support levels
    const highestValues = highestResult.values as number[];
    const lowestValues = lowestResult.values as number[];
    if (highestValues.length === 0 || lowestValues.length === 0) return [];

    const resistanceLevel = highestValues[highestValues.length - 1];
    const supportLevel = lowestValues[lowestValues.length - 1];

    // 7. Volume SMA inline (DO NOT use engine.compute('SMA') — it uses extractCloses)
    // Use prior candles only for avg — exclude current candle to avoid self-dilution
    // when current volume is abnormally high or low (partial in-progress candle).
    const volumes = extractVolumes(candles);
    const priorVolumes = volumes.slice(-(this.volumeWindow + 1), -1);
    const avgVolume = priorVolumes.reduce((sum, v) => sum + v, 0) / priorVolumes.length;
    const currentVolume = volumes[volumes.length - 1];
    const volumeConfirmed = currentVolume >= avgVolume * this.volumeMultiplier;
    if (!volumeConfirmed) return [];

    // 8. Read last candle high and low
    const lastCandle = candles[candles.length - 1];
    const currentHigh = parseFloat(lastCandle.high);
    const currentLow = parseFloat(lastCandle.low);

    const signals: Signal[] = [];
    const timestamp = lastCandle.timestamp;

    // 9. BUY signal: current high breaks above prior resistance
    if (currentHigh > resistanceLevel) {
      const rawConfidence = Math.min((currentHigh - resistanceLevel) / resistanceLevel * 20, 1);
      const confidence = Math.round(Math.min(Math.max(rawConfidence, 0.1), 1) * 100) / 100;
      signals.push({
        strategyName: this.name,
        pair,
        timeframe,
        timestamp,
        direction: 'long',
        confidence,
        reasoning: `Breakout above ${this.breakoutWindow}-candle high ${resistanceLevel.toFixed(2)}. High=${currentHigh.toFixed(2)}, Volume=${currentVolume.toFixed(0)} (${(currentVolume / avgVolume).toFixed(2)}x avg)`,
      });
    }

    // 10. SELL signal: current low breaks below prior support
    if (currentLow < supportLevel) {
      const rawConfidence = Math.min((supportLevel - currentLow) / supportLevel * 20, 1);
      const confidence = Math.round(Math.min(Math.max(rawConfidence, 0.1), 1) * 100) / 100;
      signals.push({
        strategyName: this.name,
        pair,
        timeframe,
        timestamp,
        direction: 'short',
        confidence,
        reasoning: `Breakdown below ${this.breakoutWindow}-candle low ${supportLevel.toFixed(2)}. Low=${currentLow.toFixed(2)}, Volume=${currentVolume.toFixed(0)} (${(currentVolume / avgVolume).toFixed(2)}x avg)`,
      });
    }

    return signals;
  }
}
