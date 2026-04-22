/**
 * Perp Mean Reversion Strategy
 *
 * Generates signals when price deviates significantly from its rolling mean,
 * measured in standard deviation units (Z-score).
 * Z-score below -threshold = long signal (price statistically cheap, expect reversion up).
 * Z-score above +threshold = short signal (price statistically expensive, expect reversion down).
 *
 * Perp-specific differences from ZScoreMeanReversionStrategy:
 * 1. Regime filter: suppressed in TRENDING (fights the trend), reduced confidence in VOLATILE.
 * 2. Funding rate adjustment: when funding rate strongly opposes direction,
 *    confidence is reduced by up to 50%.
 * 3. tournament-safe: when fundingRateProvider returns null, no adjustment applied.
 *
 * Uses rolling SMA + SD from IndicatorEngine for causal computation (no lookahead).
 */

import type { Candle, TradingPair, Timeframe } from '../../core/types.js';
import type { IndicatorConfig } from '../../indicators/types.js';
import { IndicatorEngine } from '../../indicators/engine.js';
import { MarketRegime } from '../../regime/types.js';
import type { IStrategy, Signal } from '../../strategies/types.js';

interface PerpMeanReversionParams {
  period: number;
  threshold: number;
  /** Max candles to hold before forcing close (time stop). Default: 12. */
  maxHoldCandles?: number;
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
  private readonly maxHoldCandles: number;
  private readonly fundingThreshold: number;
  private readonly fundingRateProvider: () => number | null;

  // ── Position state (mutable — tracks open position across candle calls) ──
  private _openDirection: 'long' | 'short' | null = null;
  private _candlesHeld: number = 0;

  constructor(config: PerpMeanReversionParams) {
    this.period = config.period;
    this.threshold = config.threshold;
    this.maxHoldCandles = config.maxHoldCandles ?? 12;
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
    regime?: MarketRegime,
  ): Signal[] {
    // 1. Length guard
    if (candles.length < this.minCandles) return [];

    // 2. Regime filter: suppress mean-reversion in TRENDING (fights the trend)
    if (regime === MarketRegime.TRENDING) return [];

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
    const timestamp = candles[candles.length - 1].timestamp;

    // 5b. Time stop: close position if held too long (mean-reversion edge decays)
    if (this._openDirection !== null) {
      this._candlesHeld++;

      // Mean reversion exit: Z-score crosses zero (reverted to mean)
      const reverted =
        (this._openDirection === 'long' && zScore >= 0) ||
        (this._openDirection === 'short' && zScore <= 0);
      const timeStop = this._candlesHeld >= this.maxHoldCandles;

      if (reverted || timeStop) {
        const reason = timeStop && !reverted ? 'TimeStop' : 'MeanReverted';
        this._openDirection = null;
        this._candlesHeld = 0;
        return [{
          strategyName: this.name,
          pair,
          timeframe,
          timestamp,
          direction: 'close',
          confidence: 1,
          reasoning: `${reason}: Z-score=${zScore.toFixed(3)}, close=${close.toFixed(2)}, held=${this._candlesHeld} candles`,
        }];
      }

      // Position open, no exit triggered → hold
      return [];
    }

    const signals: Signal[] = [];

    // 6. Get funding rate once (synchronous, tournament-safe)
    const fundingRate = this.fundingRateProvider();

    // Regime confidence scale: reduce in VOLATILE to reflect higher uncertainty
    const regimeScale = regime === MarketRegime.VOLATILE ? 0.7 : 1.0;

    // 7. LONG signal: price statistically cheap (below mean by threshold SDs)
    if (zScore < -this.threshold) {
      const rawConfidence = (Math.abs(zScore) / (this.threshold * 2)) * regimeScale;
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
      this._openDirection = 'long';
      this._candlesHeld = 0;
    }

    // 8. SHORT signal: price statistically expensive (above mean by threshold SDs)
    if (zScore > this.threshold && this._openDirection === null) {
      const rawConfidence = (Math.abs(zScore) / (this.threshold * 2)) * regimeScale;
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
      this._openDirection = 'short';
      this._candlesHeld = 0;
    }

    return signals;
  }

  /**
   * Restore in-memory position state after an engine restart.
   * Called by PerpTradingEngine.start() when re-hydrating an open session from DB.
   */
  restorePosition(direction: 'long' | 'short', _entryPrice: string): void {
    this._openDirection = direction;
    this._candlesHeld = 0;
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
