/**
 * Perp Momentum Strategy
 *
 * Generates signals when price breaks above/below the prior N-candle
 * resistance/support level with volume confirmation.
 * LONG: current HIGH exceeds prior N-candle highest AND volume >= volumeMultiplier x rolling average.
 * SHORT: current LOW falls below prior N-candle lowest AND volume >= volumeMultiplier x rolling average.
 *
 * Perp-specific differences from MomentumBreakoutStrategy:
 * 1. NO regime filter — perp strategies activate in any market condition.
 * 2. Funding rate adjustment: when funding rate strongly opposes direction,
 *    confidence is reduced by up to 50%.
 * 3. tournament-safe: when fundingRateProvider returns null, no adjustment applied.
 *
 * Uses prior-candle approach: Highest/Lowest computed on candles.slice(0, -1)
 * to avoid the tautology where Highest(all) always >= currentHigh.
 */

import type { Candle, TradingPair, Timeframe } from '../../core/types.js';
import type { IndicatorConfig } from '../../indicators/types.js';
import { IndicatorEngine } from '../../indicators/engine.js';
import { extractVolumes } from '../../indicators/adapters.js';
import type { IStrategy, Signal } from '../../strategies/types.js';

interface PerpMomentumParams {
  breakoutWindow: number;
  volumeWindow: number;
  volumeMultiplier: number;
  /** Funding rate threshold above which confidence is reduced (absolute value). */
  fundingThreshold: number;
  /**
   * Synchronous callback returning the current funding rate.
   * Returns null in tournament/paper mode (no adjustment applied).
   */
  fundingRateProvider: () => number | null;
  /** Max candles to hold a position before forcing close (time stop). Default: 20. */
  maxHoldCandles?: number;
}

export class PerpMomentumStrategy implements IStrategy {
  readonly name = 'perp-momentum';
  readonly minCandles: number;
  readonly requiredIndicators: IndicatorConfig[];

  private readonly engine = new IndicatorEngine();
  private readonly breakoutWindow: number;
  private readonly volumeWindow: number;
  private readonly volumeMultiplier: number;
  private readonly fundingThreshold: number;
  private readonly fundingRateProvider: () => number | null;
  private readonly maxHoldCandles: number;

  // ── Position state (mutable — tracks open position across candle calls) ──
  private _openDirection: 'long' | 'short' | null = null;
  private _entryLevel: number = 0;   // resistanceLevel for long, supportLevel for short
  private _candlesHeld: number = 0;

  constructor(config: PerpMomentumParams) {
    this.breakoutWindow = config.breakoutWindow;
    this.volumeWindow = config.volumeWindow;
    this.volumeMultiplier = config.volumeMultiplier;
    this.fundingThreshold = config.fundingThreshold;
    this.fundingRateProvider = config.fundingRateProvider;
    this.maxHoldCandles = config.maxHoldCandles ?? 20;
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
    _regime?: unknown,
  ): Signal[] {
    // 1. Length guard
    if (candles.length < this.minCandles) return [];

    // 2. No regime filter — perp strategies activate in all market conditions

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
    const volumes = extractVolumes(candles);
    const recentVolumes = volumes.slice(-this.volumeWindow);
    const avgVolume = recentVolumes.reduce((sum, v) => sum + v, 0) / recentVolumes.length;
    const currentVolume = volumes[volumes.length - 1];
    const volumeConfirmed = currentVolume >= avgVolume * this.volumeMultiplier;
    if (!volumeConfirmed) return [];

    // 8. Read last candle high and low
    const lastCandle = candles[candles.length - 1];
    const currentHigh = parseFloat(lastCandle.high);
    const currentLow = parseFloat(lastCandle.low);

    const signals: Signal[] = [];
    const timestamp = lastCandle.timestamp;

    // 9. Get funding rate once (synchronous, tournament-safe)
    const fundingRate = this.fundingRateProvider();

    // 10. LONG signal: current high breaks above prior resistance
    if (currentHigh > resistanceLevel) {
      const rawConfidence = Math.min((currentHigh - resistanceLevel) / resistanceLevel * 20, 1);
      const { confidence, fundingNote } = this._applyFundingAdjustment(
        rawConfidence,
        'long',
        fundingRate,
      );
      const baseReasoning = `Breakout above ${this.breakoutWindow}-candle high ${resistanceLevel.toFixed(2)}. High=${currentHigh.toFixed(2)}, Volume=${currentVolume.toFixed(0)} (${(currentVolume / avgVolume).toFixed(2)}x avg)`;
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

    // 11. SHORT signal: current low breaks below prior support
    if (currentLow < supportLevel) {
      const rawConfidence = Math.min((supportLevel - currentLow) / supportLevel * 20, 1);
      const { confidence, fundingNote } = this._applyFundingAdjustment(
        rawConfidence,
        'short',
        fundingRate,
      );
      const baseReasoning = `Breakdown below ${this.breakoutWindow}-candle low ${supportLevel.toFixed(2)}. Low=${currentLow.toFixed(2)}, Volume=${currentVolume.toFixed(0)} (${(currentVolume / avgVolume).toFixed(2)}x avg)`;
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
