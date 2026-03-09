/**
 * Perp Mean Reversion Strategy
 *
 * Generates signals when price deviates significantly from its rolling mean,
 * measured in standard deviation units (Z-score).
 * Z-score below -threshold = long signal (price statistically cheap, expect reversion up).
 * Z-score above +threshold = short signal (price statistically expensive, expect reversion down).
 *
 * Perp-specific differences from ZScoreMeanReversionStrategy:
 * 1. NO regime filter — perp strategies activate in any market condition.
 * 2. Funding rate adjustment: when funding rate strongly opposes direction,
 *    confidence is reduced by up to 50%.
 * 3. tournament-safe: when fundingRateProvider returns null, no adjustment applied.
 *
 * Uses rolling SMA + SD from IndicatorEngine for causal computation (no lookahead).
 */

import type { Candle, TradingPair, Timeframe } from '../../core/types.js';
import type { IndicatorConfig } from '../../indicators/types.js';
import { IndicatorEngine } from '../../indicators/engine.js';
import type { IStrategy, Signal } from '../../strategies/types.js';

interface PerpMeanReversionParams {
  period: number;
  threshold: number;
  /** Funding rate threshold above which confidence is reduced (absolute value). */
  fundingThreshold: number;
  /**
   * Synchronous callback returning the current funding rate.
   * Returns null in tournament/paper mode (no adjustment applied).
   */
  fundingRateProvider: () => number | null;
}

export class PerpMeanReversionStrategy implements IStrategy {
  readonly name = 'perp-mean-reversion';
  readonly minCandles: number;
  readonly requiredIndicators: IndicatorConfig[];

  private readonly engine = new IndicatorEngine();
  private readonly period: number;
  private readonly threshold: number;
  private readonly fundingThreshold: number;
  private readonly fundingRateProvider: () => number | null;

  constructor(config: PerpMeanReversionParams) {
    this.period = config.period;
    this.threshold = config.threshold;
    this.fundingThreshold = config.fundingThreshold;
    this.fundingRateProvider = config.fundingRateProvider;
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
    _regime?: unknown,
  ): Signal[] {
    // 1. Length guard
    if (candles.length < this.minCandles) return [];

    // 2. No regime filter — perp strategies activate in all market conditions

    // 3. Compute SMA and SD using IndicatorEngine
    const smaResult = this.engine.compute({ name: 'SMA', period: this.period }, candles);
    const sdResult = this.engine.compute({ name: 'SD', period: this.period }, candles);
    const smaValues = smaResult.values as number[];
    const sdValues = sdResult.values as number[];

    if (smaValues.length === 0 || sdValues.length === 0) return [];

    // 4. Take last close, mean, and SD
    const close = parseFloat(candles[candles.length - 1].close);
    const mean = smaValues[smaValues.length - 1];
    const sd = sdValues[sdValues.length - 1];

    // 5. Constant prices → sd=0 → Z-score undefined, skip
    if (sd === 0) return [];

    const zScore = (close - mean) / sd;
    const signals: Signal[] = [];
    const timestamp = candles[candles.length - 1].timestamp;

    // 6. Get funding rate once (synchronous, tournament-safe)
    const fundingRate = this.fundingRateProvider();

    // 7. LONG signal: price statistically cheap (below mean by threshold SDs)
    if (zScore < -this.threshold) {
      const rawConfidence = Math.abs(zScore) / (this.threshold * 2);
      const { confidence, fundingNote } = this._applyFundingAdjustment(
        rawConfidence,
        'long',
        fundingRate,
      );
      const baseReasoning = `Z-score=${zScore.toFixed(3)} below -${this.threshold} threshold. Close=${close.toFixed(2)}, SMA(${this.period})=${mean.toFixed(2)}, SD=${sd.toFixed(4)}`;
      signals.push({
        strategyName: this.name,
        pair,
        timeframe,
        timestamp,
        direction: 'long',
        confidence,
        reasoning: fundingNote ? `${baseReasoning}. ${fundingNote}` : baseReasoning,
      });
    }

    // 8. SHORT signal: price statistically expensive (above mean by threshold SDs)
    if (zScore > this.threshold) {
      const rawConfidence = Math.abs(zScore) / (this.threshold * 2);
      const { confidence, fundingNote } = this._applyFundingAdjustment(
        rawConfidence,
        'short',
        fundingRate,
      );
      const baseReasoning = `Z-score=${zScore.toFixed(3)} above +${this.threshold} threshold. Close=${close.toFixed(2)}, SMA(${this.period})=${mean.toFixed(2)}, SD=${sd.toFixed(4)}`;
      signals.push({
        strategyName: this.name,
        pair,
        timeframe,
        timestamp,
        direction: 'short',
        confidence,
        reasoning: fundingNote ? `${baseReasoning}. ${fundingNote}` : baseReasoning,
      });
    }

    return signals;
  }

  /**
   * Applies funding rate adjustment to raw confidence.
   * Returns adjusted confidence (clamped to [0.01, 1.0]) and optional funding note.
   *
   * Logic:
   * - For 'long': if fundingRate >= fundingThreshold → reduce confidence
   * - For 'short': if fundingRate <= -fundingThreshold → reduce confidence
   * - adjustment = Math.min(|fundingRate| / fundingThreshold, 0.5)
   * - adjustedConfidence = rawConfidence * (1 - adjustment)
   */
  private _applyFundingAdjustment(
    rawConfidence: number,
    direction: 'long' | 'short',
    fundingRate: number | null,
  ): { confidence: number; fundingNote: string | null } {
    if (fundingRate === null) {
      const confidence = Math.round(Math.min(Math.max(rawConfidence, 0.01), 1) * 100) / 100;
      return { confidence, fundingNote: null };
    }

    const opposes =
      (direction === 'long' && fundingRate >= this.fundingThreshold) ||
      (direction === 'short' && fundingRate <= -this.fundingThreshold);

    if (!opposes) {
      const confidence = Math.round(Math.min(Math.max(rawConfidence, 0.01), 1) * 100) / 100;
      return { confidence, fundingNote: null };
    }

    const adjustment = Math.min(Math.abs(fundingRate) / this.fundingThreshold, 0.5);
    const adjustedRaw = rawConfidence * (1 - adjustment);
    const confidence = Math.round(Math.min(Math.max(adjustedRaw, 0.01), 1) * 100) / 100;
    const fundingNote = `FundingAdj: rate=${fundingRate.toFixed(4)} reduced confidence by ${(adjustment * 100).toFixed(0)}%`;
    return { confidence, fundingNote };
  }
}
