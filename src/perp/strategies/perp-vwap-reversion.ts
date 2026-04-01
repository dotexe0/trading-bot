/**
 * Perp VWAP Reversion Strategy
 *
 * A scalping strategy that fades extreme price deviations from the
 * volume-weighted typical price (VWTP). Enters long when price is N
 * standard deviations below VWTP, enters short when price is N SDs above
 * VWTP. Closes when price reverts to the mean (Z-score crosses zero),
 * when the time stop fires, or when the price-based stop-loss is triggered.
 *
 * Perp-specific features:
 * 1. NO regime filter — activates in any market condition.
 * 2. Funding rate adjustment: when funding rate strongly opposes direction,
 *    confidence is reduced by up to 50%.
 * 3. Tournament-safe: when fundingRateProvider returns null, no adjustment applied.
 * 4. Price-based stop-loss via stopLossPct param (default 0.5%).
 * 5. restorePosition() for engine restart recovery.
 */

import type { Candle, TradingPair, Timeframe } from '../../core/types.js';
import type { IndicatorConfig } from '../../indicators/types.js';
import { IndicatorEngine } from '../../indicators/engine.js';
import type { IStrategy, Signal } from '../../strategies/types.js';

interface PerpVwapReversionParams {
  /** Rolling window for VWTP calculation (default 15). */
  vwapPeriod: number;
  /** Z-score entry threshold (default 1.5). */
  zScoreThreshold: number;
  /** Time stop candle count (default 8). */
  maxHoldCandles: number;
  /** Price-based stop-loss as fraction of entry VWTP (default 0.005 = 0.5%). */
  stopLossPct: number;
  /** Funding rate threshold above which confidence is reduced (absolute value). */
  fundingThreshold: number;
  /**
   * Synchronous callback returning the current funding rate.
   * Returns null in tournament/paper mode (no adjustment applied).
   */
  fundingRateProvider: () => number | null;
}

export class PerpVwapReversionStrategy implements IStrategy {
  readonly name = 'perp-vwap-reversion';
  readonly minCandles: number;
  readonly requiredIndicators: IndicatorConfig[];

  private readonly engine = new IndicatorEngine();
  private readonly vwapPeriod: number;
  private readonly zScoreThreshold: number;
  private readonly maxHoldCandles: number;
  private readonly _stopLossPct: number;
  private readonly fundingThreshold: number;
  private readonly fundingRateProvider: () => number | null;

  // ── Position state (mutable — tracks open position across candle calls) ──
  private _openDirection: 'long' | 'short' | null = null;
  private _entryLevel: number = 0;  // VWTP value at entry
  private _candlesHeld: number = 0;

  constructor(config: PerpVwapReversionParams) {
    this.vwapPeriod = config.vwapPeriod;
    this.zScoreThreshold = config.zScoreThreshold;
    this.maxHoldCandles = config.maxHoldCandles;
    this._stopLossPct = config.stopLossPct;
    this.fundingThreshold = config.fundingThreshold;
    this.fundingRateProvider = config.fundingRateProvider;
    // Need at least vwapPeriod candles + 1 current candle
    this.minCandles = this.vwapPeriod + 1;
    this.requiredIndicators = [
      { name: 'SMA', period: this.vwapPeriod },
      { name: 'SD', period: this.vwapPeriod },
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

    const lastCandle = candles[candles.length - 1];
    const currentClose = parseFloat(lastCandle.close);
    const timestamp = lastCandle.timestamp;

    // 2. Compute VWTP (volume-weighted typical price) over last vwapPeriod candles
    const recent = candles.slice(-this.vwapPeriod);
    let sumPriceVol = 0;
    let sumVol = 0;
    for (const c of recent) {
      const tp = (parseFloat(c.high) + parseFloat(c.low) + parseFloat(c.close)) / 3;
      const vol = parseFloat(c.volume);
      sumPriceVol += tp * vol;
      sumVol += vol;
    }
    const vwtp = sumVol > 0 ? sumPriceVol / sumVol : parseFloat(recent[recent.length - 1].close);

    // 3. Compute standard deviation of close prices over vwapPeriod using IndicatorEngine
    const sdResult = this.engine.compute({ name: 'SD', period: this.vwapPeriod }, candles);
    const sdValues = sdResult.values as number[];
    if (sdValues.length === 0) return [];
    const sd = sdValues[sdValues.length - 1];

    // Guard: if SD is zero (all prices identical), return []
    if (sd === 0) return [];

    // 4. Compute Z-score
    const zScore = (currentClose - vwtp) / sd;

    // ── 5. EXIT CHECK — before entry check ────────────────────────────────
    if (this._openDirection !== null) {
      this._candlesHeld++;

      // 5a. Price-based stop-loss (checked FIRST, before mean reversion and time stop)
      const longStopLoss =
        this._openDirection === 'long' &&
        (this._entryLevel - currentClose) / this._entryLevel > this._stopLossPct;
      const shortStopLoss =
        this._openDirection === 'short' &&
        (currentClose - this._entryLevel) / this._entryLevel > this._stopLossPct;

      if (longStopLoss || shortStopLoss) {
        const capturedEntry = this._entryLevel;
        const capturedDir = this._openDirection;
        this._openDirection = null;
        this._entryLevel = 0;
        this._candlesHeld = 0;
        return [{
          strategyName: this.name,
          pair,
          timeframe,
          timestamp,
          direction: 'close',
          confidence: 1,
          reasoning: `StopLoss: loss exceeds ${(this._stopLossPct * 100).toFixed(1)}%. dir=${capturedDir}, entryLevel=${capturedEntry.toFixed(4)}, close=${currentClose.toFixed(4)}`,
        }];
      }

      // 5b. Mean reversion exit: Z-score crosses back through zero
      const meanReversionExit =
        (this._openDirection === 'long' && zScore >= 0) ||
        (this._openDirection === 'short' && zScore <= 0);

      // 5c. Time stop
      const timeStop = this._candlesHeld >= this.maxHoldCandles;

      if (meanReversionExit || timeStop) {
        const reason = timeStop && !meanReversionExit ? 'TimeStop' : 'MeanReversion';
        const capturedEntry = this._entryLevel;
        const capturedDir = this._openDirection;
        this._openDirection = null;
        this._entryLevel = 0;
        this._candlesHeld = 0;
        return [{
          strategyName: this.name,
          pair,
          timeframe,
          timestamp,
          direction: 'close',
          confidence: 1,
          reasoning: `${reason}: dir=${capturedDir}, close=${currentClose.toFixed(4)}, vwtp=${vwtp.toFixed(4)}, zScore=${zScore.toFixed(4)}`,
        }];
      }

      // Position open, no exit triggered → hold
      return [];
    }

    // ── 6. ENTRY CHECK — only when no open position ────────────────────────

    const fundingRate = this.fundingRateProvider();

    // 6a. LONG entry: Z-score < -zScoreThreshold (price below VWTP by N SDs)
    if (zScore < -this.zScoreThreshold) {
      const rawConfidence = Math.min(Math.abs(zScore) / (this.zScoreThreshold * 2), 1);
      const { confidence, fundingNote } = this._applyFundingAdjustment(rawConfidence, 'long', fundingRate);
      const baseReasoning = `VwapLong: zScore=${zScore.toFixed(4)}, vwtp=${vwtp.toFixed(4)}, close=${currentClose.toFixed(4)}, threshold=${this.zScoreThreshold}`;
      this._openDirection = 'long';
      this._entryLevel = vwtp;
      this._candlesHeld = 0;
      return [{
        strategyName: this.name,
        pair,
        timeframe,
        timestamp,
        direction: 'long',
        confidence,
        reasoning: fundingNote ? `${baseReasoning}. ${fundingNote}` : baseReasoning,
      }];
    }

    // 6b. SHORT entry: Z-score > +zScoreThreshold (price above VWTP by N SDs)
    if (zScore > this.zScoreThreshold) {
      const rawConfidence = Math.min(Math.abs(zScore) / (this.zScoreThreshold * 2), 1);
      const { confidence, fundingNote } = this._applyFundingAdjustment(rawConfidence, 'short', fundingRate);
      const baseReasoning = `VwapShort: zScore=${zScore.toFixed(4)}, vwtp=${vwtp.toFixed(4)}, close=${currentClose.toFixed(4)}, threshold=${this.zScoreThreshold}`;
      this._openDirection = 'short';
      this._entryLevel = vwtp;
      this._candlesHeld = 0;
      return [{
        strategyName: this.name,
        pair,
        timeframe,
        timestamp,
        direction: 'short',
        confidence,
        reasoning: fundingNote ? `${baseReasoning}. ${fundingNote}` : baseReasoning,
      }];
    }

    return [];
  }

  /**
   * Restore in-memory position state after an engine restart.
   * Called by PaperPerpEngine.start() when re-hydrating an open session from DB.
   * _candlesHeld resets to 0 — gives the restored position the full maxHoldCandles window.
   */
  restorePosition(direction: 'long' | 'short', entryPrice: string): void {
    this._openDirection = direction;
    this._entryLevel = parseFloat(entryPrice);
    this._candlesHeld = 0;
  }

  /**
   * Applies funding rate adjustment to raw confidence.
   * Returns adjusted confidence (clamped to [0.01, 1.0]) and optional funding note.
   *
   * Logic:
   * - For 'long': if fundingRate > fundingThreshold → reduce confidence
   * - For 'short': if fundingRate < -fundingThreshold → reduce confidence
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
