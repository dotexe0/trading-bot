/**
 * BasisTradeStrategy
 *
 * Generates signals from the Z-score of a rolling basis series.
 * Basis = markPrice - indexPrice at each sample.
 *
 * The rolling basis samples are provided by a basisProvider closure — not
 * computed from candles (candles don't carry mark/index price). The provider
 * returns a recent window of (markPrice - indexPrice) samples, or null in
 * tournament/backtest mode.
 *
 * Z-score = (lastBasis - mean(series)) / SD(series)
 * LONG when Z-score < -threshold (basis statistically compressed — expect reversion up).
 * SHORT when Z-score > +threshold (basis statistically elevated — expect reversion down).
 *
 * Guard conditions (all return [] without throwing):
 * - basisProvider returns null → tournament/backtest mode, no live data
 * - fewer than period samples returned → insufficient history
 * - SD of basis series = 0 → constant series (e.g. all zeros from indexPrice===markPrice)
 *
 * FCM reality: indexPrice === markPrice in current FCM ticker (intx-client.ts line 163).
 * The basis is always 0, SD is always 0, and this strategy always returns [].
 * It is wired correctly for when/if FCM adds a real index_price field.
 *
 * No regime filter: basis arbitrage is regime-agnostic (statistical spread reversion).
 *
 * Satisfies: STRAT-02
 */

import type { Candle, TradingPair, Timeframe } from '../../core/types.js';
import type { IndicatorConfig } from '../../indicators/types.js';
import type { IStrategy, Signal } from '../../strategies/types.js';

interface BasisTradeParams {
  /** Rolling window for basis Z-score computation. Default: 20 */
  period: number;
  /** Z-score magnitude threshold for signal generation. Default: 1.5 */
  threshold: number;
  /**
   * Returns recent basis samples as an array (markPrice - indexPrice for each event),
   * or null in tournament mode when no live mark price data is available.
   * When the returned array has fewer than `period` entries, the strategy returns [].
   */
  basisProvider: () => number[] | null;
}

export class BasisTradeStrategy implements IStrategy {
  readonly name = 'basis-trade';
  readonly minCandles: number;
  readonly requiredIndicators: IndicatorConfig[] = [];

  private readonly period: number;
  private readonly threshold: number;
  private readonly basisProvider: () => number[] | null;

  constructor(params: BasisTradeParams) {
    this.period = params.period;
    this.threshold = params.threshold;
    this.basisProvider = params.basisProvider;
    this.minCandles = this.period + 1;
  }

  evaluate(
    candles: Candle[],
    pair: TradingPair,
    timeframe: Timeframe,
    _additionalCandles?: Map<Timeframe, Candle[]>,
    _regime?: unknown,
  ): Signal[] {
    // Guard 1: candle length (IStrategy contract)
    if (candles.length < this.minCandles) return [];

    // Guard 2: basis provider — null in tournament/backtest mode
    const basisSamples = this.basisProvider();
    if (basisSamples === null) return [];

    // Guard 3: insufficient history
    if (basisSamples.length < this.period) return [];

    // Use the most recent `period` samples
    const window = basisSamples.slice(-this.period);

    // Compute mean and SD inline (matches PerpMeanReversionStrategy pattern)
    const mean = window.reduce((sum, v) => sum + v, 0) / window.length;
    const variance = window.reduce((sum, v) => sum + (v - mean) ** 2, 0) / window.length;
    const sd = Math.sqrt(variance);

    // Guard 4: SD = 0 (constant series — e.g. all-zero basis when indexPrice === markPrice)
    if (sd === 0) return [];

    const lastBasis = window[window.length - 1];
    const zScore = (lastBasis - mean) / sd;

    const signals: Signal[] = [];
    const timestamp = candles[candles.length - 1].timestamp;

    if (zScore < -this.threshold) {
      const rawConfidence = Math.min(Math.abs(zScore) / (this.threshold * 2), 1);
      const confidence = Math.round(Math.min(Math.max(rawConfidence, 0.01), 1) * 100) / 100;
      signals.push({
        strategyName: this.name,
        pair,
        timeframe,
        timestamp,
        direction: 'long',
        confidence,
        reasoning: `BasisTrade: Z-score=${zScore.toFixed(3)} < -${this.threshold}. Basis=${lastBasis.toFixed(4)}, mean=${mean.toFixed(4)}, SD=${sd.toFixed(4)}`,
      });
    } else if (zScore > this.threshold) {
      const rawConfidence = Math.min(Math.abs(zScore) / (this.threshold * 2), 1);
      const confidence = Math.round(Math.min(Math.max(rawConfidence, 0.01), 1) * 100) / 100;
      signals.push({
        strategyName: this.name,
        pair,
        timeframe,
        timestamp,
        direction: 'short',
        confidence,
        reasoning: `BasisTrade: Z-score=${zScore.toFixed(3)} > +${this.threshold}. Basis=${lastBasis.toFixed(4)}, mean=${mean.toFixed(4)}, SD=${sd.toFixed(4)}`,
      });
    }

    return signals;
  }
}
