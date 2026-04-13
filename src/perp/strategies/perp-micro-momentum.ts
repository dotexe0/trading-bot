/**
 * Perp Micro-Momentum Strategy
 *
 * A scalping strategy based on EMA crossovers with volume surge and RSI
 * confirmation. Designed for 1m-5m candle scalping with tight time stops
 * and price-based stop-losses.
 *
 * LONG: fast EMA crosses above slow EMA (golden cross) + volume surge
 *       + RSI between 40-70 (not overbought).
 * SHORT: fast EMA crosses below slow EMA (death cross) + volume surge
 *        + RSI between 30-60 (not oversold).
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
import { extractVolumes } from '../../indicators/adapters.js';
import type { IStrategy, Signal } from '../../strategies/types.js';

interface PerpMicroMomentumParams {
  /** Fast EMA period (default 5). */
  fastEmaPeriod: number;
  /** Slow EMA period (default 12). */
  slowEmaPeriod: number;
  /** RSI period for overbought/oversold filter (default 7). */
  rsiPeriod: number;
  /** Volume averaging window (default 5). */
  volumeWindow: number;
  /** Volume surge threshold (default 1.5). */
  volumeMultiplier: number;
  /** Time stop — max candles to hold (default 8). */
  maxHoldCandles: number;
  /** Price-based stop-loss as fraction of entry close (default 0.005 = 0.5%). */
  stopLossPct: number;
  /** Funding rate threshold above which confidence is reduced (absolute value). */
  fundingThreshold: number;
  /**
   * Synchronous callback returning the current funding rate.
   * Returns null in tournament/paper mode (no adjustment applied).
   */
  fundingRateProvider: () => number | null;
}

export class PerpMicroMomentumStrategy implements IStrategy {
  readonly name = 'perp-micro-momentum';
  readonly minCandles: number;
  readonly requiredIndicators: IndicatorConfig[];

  private readonly engine = new IndicatorEngine();
  private readonly fastEmaPeriod: number;
  private readonly slowEmaPeriod: number;
  private readonly rsiPeriod: number;
  private readonly volumeWindow: number;
  private readonly volumeMultiplier: number;
  private readonly maxHoldCandles: number;
  private readonly _stopLossPct: number;
  private readonly fundingThreshold: number;
  private readonly fundingRateProvider: () => number | null;

  // ── Position state (mutable — tracks open position across candle calls) ──
  private _openDirection: 'long' | 'short' | null = null;
  private _entryLevel: number = 0;    // close price at entry
  private _candlesHeld: number = 0;

  constructor(config: PerpMicroMomentumParams) {
    this.fastEmaPeriod = config.fastEmaPeriod;
    this.slowEmaPeriod = config.slowEmaPeriod;
    this.rsiPeriod = config.rsiPeriod;
    this.volumeWindow = config.volumeWindow;
    this.volumeMultiplier = config.volumeMultiplier;
    this.maxHoldCandles = config.maxHoldCandles;
    this._stopLossPct = config.stopLossPct;
    this.fundingThreshold = config.fundingThreshold;
    this.fundingRateProvider = config.fundingRateProvider;
    // Need 2 EMA values for crossover detection (current + prior)
    this.minCandles = Math.max(this.slowEmaPeriod, this.rsiPeriod, this.volumeWindow) + 2;
    this.requiredIndicators = [
      { name: 'EMA', period: this.fastEmaPeriod },
      { name: 'EMA', period: this.slowEmaPeriod },
      { name: 'RSI', period: this.rsiPeriod },
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

    // 2. Compute EMA and RSI
    const fastEmaResult = this.engine.compute({ name: 'EMA', period: this.fastEmaPeriod }, candles);
    const slowEmaResult = this.engine.compute({ name: 'EMA', period: this.slowEmaPeriod }, candles);
    const rsiResult = this.engine.compute({ name: 'RSI', period: this.rsiPeriod }, candles);

    const fastEmaValues = fastEmaResult.values as number[];
    const slowEmaValues = slowEmaResult.values as number[];
    const rsiValues = rsiResult.values as number[];

    if (fastEmaValues.length < 2 || slowEmaValues.length < 2 || rsiValues.length === 0) return [];

    const currFast = fastEmaValues[fastEmaValues.length - 1];
    const prevFast = fastEmaValues[fastEmaValues.length - 2];
    const currSlow = slowEmaValues[slowEmaValues.length - 1];
    const prevSlow = slowEmaValues[slowEmaValues.length - 2];
    const currRsi = rsiValues[rsiValues.length - 1];

    // 3. Volume gate: compute average over volumeWindow, check currentVolume >= avg * multiplier
    const volumes = extractVolumes(candles);
    const recentVols = volumes.slice(-this.volumeWindow);
    const avgVolume = recentVols.reduce((sum, v) => sum + v, 0) / recentVols.length;
    const currentVolume = volumes[volumes.length - 1];
    const volumeSurge = currentVolume >= avgVolume * this.volumeMultiplier;

    // ── 4. EXIT CHECK — before entry check ────────────────────────────────
    if (this._openDirection !== null) {
      this._candlesHeld++;

      // 4a. Price-based stop-loss (checked FIRST)
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

      // 4b. Reversal crossover exit
      const reversalExit =
        (this._openDirection === 'long' && currFast < currSlow) ||
        (this._openDirection === 'short' && currFast > currSlow);

      // 4c. Time stop
      const timeStop = this._candlesHeld >= this.maxHoldCandles;

      if (reversalExit || timeStop) {
        const reason = timeStop && !reversalExit ? 'TimeStop' : 'ReversalCross';
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
          reasoning: `${reason}: dir=${capturedDir}, close=${currentClose.toFixed(4)}, fastEMA=${currFast.toFixed(4)}, slowEMA=${currSlow.toFixed(4)}`,
        }];
      }

      // Position open, no exit triggered → hold
      return [];
    }

    // ── 5. ENTRY CHECK — only when no open position ────────────────────────

    // Volume must be confirmed for entry
    if (!volumeSurge) return [];

    const fundingRate = this.fundingRateProvider();

    // 5a. Golden cross: prevFast <= prevSlow && currFast > currSlow
    if (prevFast <= prevSlow && currFast > currSlow) {
      // RSI filter for long: must be between 40 and 70 (not overbought)
      if (currRsi >= 40 && currRsi <= 70) {
        const rawConfidence = Math.min(Math.abs(currFast - currSlow) / currSlow * 100, 1);
        const { confidence, fundingNote } = this._applyFundingAdjustment(rawConfidence, 'long', fundingRate);
        const baseReasoning = `GoldenCross: fastEMA=${currFast.toFixed(4)}>slowEMA=${currSlow.toFixed(4)}, RSI=${currRsi.toFixed(1)}, vol=${currentVolume.toFixed(0)} (${(currentVolume / avgVolume).toFixed(2)}x), close=${currentClose.toFixed(4)}`;
        this._openDirection = 'long';
        this._entryLevel = currentClose;
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
    }

    // 5b. Death cross: prevFast >= prevSlow && currFast < currSlow
    if (prevFast >= prevSlow && currFast < currSlow) {
      // RSI filter for short: must be between 30 and 60 (not oversold)
      if (currRsi >= 30 && currRsi <= 60) {
        const rawConfidence = Math.min(Math.abs(currFast - currSlow) / currSlow * 100, 1);
        const { confidence, fundingNote } = this._applyFundingAdjustment(rawConfidence, 'short', fundingRate);
        const baseReasoning = `DeathCross: fastEMA=${currFast.toFixed(4)}<slowEMA=${currSlow.toFixed(4)}, RSI=${currRsi.toFixed(1)}, vol=${currentVolume.toFixed(0)} (${(currentVolume / avgVolume).toFixed(2)}x), close=${currentClose.toFixed(4)}`;
        this._openDirection = 'short';
        this._entryLevel = currentClose;
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
    }

    return [];
  }

  /**
   * Restore in-memory position state after an engine restart.
   * Called by PerpTradingEngine.start() when re-hydrating an open session from DB.
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
