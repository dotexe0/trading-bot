/**
 * FundingRateArbitrageStrategy
 *
 * Generates directional carry signals from the implied funding rate:
 *   impliedRate = (markPrice - indexPrice) / indexPrice
 *
 * LONG when impliedRate < -threshold (longs receive funding — favorable carry).
 * SHORT when impliedRate > +threshold (shorts receive funding — favorable carry).
 *
 * Regime gate: RANGING and VOLATILE only. Returns [] in TRENDING regime.
 * Also returns [] when regime is undefined (conservative).
 *
 * Tournament safety: When tournamentMode=true OR markPriceProvider returns null,
 * always returns [] (this strategy is live-only).
 *
 * FCM reality: indexPrice === markPrice in current FCM ticker channel
 * (src/perp/intx-client.ts line 163). The implied rate is always 0 at present,
 * meaning this strategy consistently returns []. It is wired correctly for
 * when/if FCM adds a distinct index_price field.
 *
 * Division guard: if indexPrice is '0', returns [] to avoid Infinity/NaN.
 *
 * Satisfies: STRAT-01
 */

import type { Candle, TradingPair, Timeframe } from '../../core/types.js';
import type { IndicatorConfig } from '../../indicators/types.js';
import type { IStrategy, Signal } from '../../strategies/types.js';
import { MarketRegime } from '../../regime/types.js';
import { d } from '../../core/decimal.js';

interface FundingRateArbParams {
  /** Minimum absolute implied rate to generate a signal. Default: 0.0005 */
  threshold: number;
  /**
   * Synchronous callback returning current {markPrice, indexPrice} from latest
   * IntxMarkPriceEvent, or null in tournament mode.
   */
  markPriceProvider: () => { markPrice: string; indexPrice: string } | null;
  /**
   * Tournament-mode flag. When true, always returns [].
   * Set to true in createPerpRegistry(). Set to false in createLivePerpRegistry().
   */
  tournamentMode: boolean;
}

export class FundingRateArbitrageStrategy implements IStrategy {
  readonly name = 'funding-rate-arb';
  readonly minCandles = 1;
  readonly requiredIndicators: IndicatorConfig[] = [];

  private readonly threshold: number;
  private readonly markPriceProvider: () => { markPrice: string; indexPrice: string } | null;
  private readonly tournamentMode: boolean;

  constructor(params: FundingRateArbParams) {
    this.threshold = params.threshold;
    this.markPriceProvider = params.markPriceProvider;
    this.tournamentMode = params.tournamentMode;
  }

  evaluate(
    candles: Candle[],
    pair: TradingPair,
    timeframe: Timeframe,
    _additionalCandles?: Map<Timeframe, Candle[]>,
    regime?: MarketRegime,
  ): Signal[] {
    // Guard 1: tournament mode — live-only strategy
    if (this.tournamentMode) return [];

    // Guard 2: regime gate — RANGING and VOLATILE only; undefined → conservative skip
    if (regime === undefined || regime === MarketRegime.TRENDING) return [];

    // Guard 3: candle length (IStrategy contract)
    if (candles.length < this.minCandles) return [];

    // Guard 4: mark price provider
    const markData = this.markPriceProvider();
    if (markData === null) return [];

    const { markPrice, indexPrice } = markData;
    const indexD = d(indexPrice);

    // Guard 5: zero indexPrice → division would produce Infinity/NaN
    if (indexD.isZero()) return [];

    const markD = d(markPrice);
    const impliedRate = markD.minus(indexD).div(indexD).toNumber();

    // Guard 6: no divergence (indexPrice === markPrice case — current FCM reality)
    // impliedRate will be exactly 0; neither threshold branch fires
    const signals: Signal[] = [];
    const timestamp = candles[candles.length - 1].timestamp;

    if (impliedRate < -this.threshold) {
      // Longs receive funding — favorable carry for long position
      const rawConfidence = Math.min(Math.abs(impliedRate) / (this.threshold * 2), 1);
      const confidence = Math.round(Math.min(Math.max(rawConfidence, 0.01), 1) * 100) / 100;
      signals.push({
        strategyName: this.name,
        pair,
        timeframe,
        timestamp,
        direction: 'long',
        confidence,
        reasoning: `FundingRateArb: impliedRate=${impliedRate.toFixed(6)} < -${this.threshold} (longs receive funding). markPrice=${markPrice}, indexPrice=${indexPrice}`,
      });
    } else if (impliedRate > this.threshold) {
      // Shorts receive funding — favorable carry for short position
      const rawConfidence = Math.min(Math.abs(impliedRate) / (this.threshold * 2), 1);
      const confidence = Math.round(Math.min(Math.max(rawConfidence, 0.01), 1) * 100) / 100;
      signals.push({
        strategyName: this.name,
        pair,
        timeframe,
        timestamp,
        direction: 'short',
        confidence,
        reasoning: `FundingRateArb: impliedRate=${impliedRate.toFixed(6)} > +${this.threshold} (shorts receive funding). markPrice=${markPrice}, indexPrice=${indexPrice}`,
      });
    }

    return signals;
  }
}
