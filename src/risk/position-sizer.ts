/**
 * Position sizing calculator using Kelly criterion and fixed-fraction methods.
 *
 * Kelly criterion optimizes position size based on historical win rate and
 * win/loss ratio. Falls back to fixed-fraction when insufficient trade history
 * exists. All positions are capped at maxPositionPct of equity.
 */

import { d, ZERO, Decimal } from '../core/decimal.js';
import type { RiskConfig, StrategyStats, PositionSizeResult } from './types.js';

export class PositionSizer {
  private readonly config: RiskConfig;
  private readonly maxPositionPct: Decimal;
  private readonly fixedFractionPct: Decimal;
  private readonly kellyFraction: Decimal;

  constructor(config: RiskConfig) {
    this.config = config;
    this.maxPositionPct = d(config.maxPositionPct);
    this.fixedFractionPct = d(config.fixedFractionPct);
    this.kellyFraction = d(config.kellyFraction);
  }

  /**
   * Calculate position size given current equity, price, and strategy stats.
   *
   * @param equity - Current portfolio equity
   * @param price - Expected fill price
   * @param stats - Strategy statistics (null if no history)
   * @param correlationScalar - Optional correlation discount in [0, 1].
   *   Applied AFTER confidence scaling. When < 1, reduces the position
   *   by multiplying appliedPct by the scalar. When undefined or >= 1,
   *   behavior is identical to v1.0 (zero regression).
   * @param confidence - Optional signal confidence in [0, 1].
   *   Scales position size: appliedPct *= floor + (1 - floor) * confidence.
   *   Applied AFTER Kelly/fixed-fraction, BEFORE correlation discount.
   * @param atr - Optional ATR value for volatility-targeted sizing.
   *   When volatilitySizing is enabled and ATR is provided, base size is
   *   computed as (equity * riskPct) / (ATR * atrMultiple).
   * @returns Position size result with method, percentages, and quantity
   */
  calculate(
    equity: Decimal,
    price: Decimal,
    stats: StrategyStats | null,
    correlationScalar?: Decimal,
    confidence?: number,
    atr?: Decimal,
  ): PositionSizeResult {
    let baseResult: PositionSizeResult;

    // Volatility-targeted sizing: risk a fixed % of equity per trade
    // Position size = (equity * riskPct) / (ATR * atrMultiple)
    if (this.config.volatilitySizing && atr && atr.gt(ZERO)) {
      const riskPct = d(this.config.riskPerTradePct ?? 0.01);
      const atrMultiple = d(this.config.atrStopMultiple ?? 2.0);
      const stopDistance = atr.mul(atrMultiple);
      const riskAmount = equity.mul(riskPct);
      let quantity = riskAmount.div(stopDistance);
      let appliedPct = quantity.mul(price).div(equity);
      let cappedBy: string | undefined;

      if (appliedPct.gt(this.maxPositionPct)) {
        appliedPct = this.maxPositionPct;
        quantity = equity.mul(appliedPct).div(price);
        cappedBy = 'maxPositionPct';
      }

      baseResult = {
        method: 'fixed-fraction',
        rawKellyPct: ZERO,
        appliedPct,
        quantity,
        cappedBy,
      };
    } else if (this.config.sizingMethod === 'fixed-fraction') {
      baseResult = this.fixedFraction(equity, price);
    } else if (!this.canUseKelly(stats)) {
      // Kelly or half-kelly -- fall back when insufficient stats
      baseResult = this.fixedFraction(equity, price);
    } else {
      // stats is guaranteed non-null here by canUseKelly
      baseResult = this.kelly(equity, price, stats!);
    }

    // Apply confidence scaling AFTER Kelly/fixed-fraction, BEFORE correlation.
    // Scale formula: appliedPct *= floor + (1 - floor) * confidence
    // At confidence=1.0, scale=1.0 (no reduction). At confidence=0, scale=floor.
    if (confidence !== undefined && confidence >= 0 && confidence <= 1) {
      const floor = this.config.confidenceFloor ?? 0.3;
      if (floor < 1) {
        const scale = d(floor + (1 - floor) * confidence);
        const appliedPct = baseResult.appliedPct.mul(scale);
        const quantity = equity.mul(appliedPct).div(price);
        baseResult = {
          ...baseResult,
          appliedPct,
          quantity,
          cappedBy: baseResult.cappedBy ?? 'confidenceScaled',
        };
      }
    }

    // Apply correlation discount AFTER confidence scaling.
    // Only fires when scalar is provided AND strictly less than 1.
    if (
      correlationScalar !== undefined &&
      correlationScalar.lt(d(1)) &&
      correlationScalar.gte(ZERO)
    ) {
      const appliedPct = baseResult.appliedPct.mul(correlationScalar);
      const quantity = equity.mul(appliedPct).div(price);
      return {
        ...baseResult,
        appliedPct,
        quantity,
        cappedBy: 'correlationDiscount',
      };
    }

    return baseResult;
  }

  /**
   * Check whether Kelly criterion can be used with the given stats.
   */
  private canUseKelly(stats: StrategyStats | null): boolean {
    if (stats === null) return false;
    if (stats.totalTrades < this.config.minTradesForKelly) return false;
    if (stats.avgLoss.isZero()) return false;
    if (stats.winRate.isZero()) return false;
    return true;
  }

  /**
   * Kelly criterion sizing: f* = W - (1-W) / R
   * where W = win rate, R = avgWin / avgLoss
   */
  private kelly(
    equity: Decimal,
    price: Decimal,
    stats: StrategyStats,
  ): PositionSizeResult {
    const W = stats.winRate;
    const R = stats.avgWin.div(stats.avgLoss);
    const oneMinusW = d(1).minus(W);

    // Raw Kelly: f* = W - (1-W) / R
    const rawKelly = W.minus(oneMinusW.div(R));

    // Report method based on config
    const method = this.config.sizingMethod as 'kelly' | 'half-kelly';

    // If Kelly is zero or negative, don't bet
    if (rawKelly.lte(ZERO)) {
      return {
        method,
        rawKellyPct: rawKelly,
        appliedPct: ZERO,
        quantity: ZERO,
        cappedBy: rawKelly.isNeg() ? 'negative-kelly' : undefined,
      };
    }

    // Apply Kelly fraction (0.5 for half-kelly, 1.0 for full kelly, etc.)
    let appliedPct = rawKelly.mul(this.kellyFraction);
    let cappedBy: string | undefined;

    // Cap at maxPositionPct
    if (appliedPct.gt(this.maxPositionPct)) {
      appliedPct = this.maxPositionPct;
      cappedBy = 'maxPositionPct';
    }

    const dollarSize = equity.mul(appliedPct);
    const quantity = dollarSize.div(price);

    return {
      method,
      rawKellyPct: rawKelly,
      appliedPct,
      quantity,
      cappedBy,
    };
  }

  /**
   * Fixed-fraction sizing: use a flat percentage of equity.
   */
  private fixedFraction(equity: Decimal, price: Decimal): PositionSizeResult {
    let appliedPct = this.fixedFractionPct;
    let cappedBy: string | undefined;

    if (appliedPct.gt(this.maxPositionPct)) {
      appliedPct = this.maxPositionPct;
      cappedBy = 'maxPositionPct';
    }

    const dollarSize = equity.mul(appliedPct);
    const quantity = dollarSize.div(price);

    return {
      method: 'fixed-fraction',
      rawKellyPct: ZERO,
      appliedPct,
      quantity,
      cappedBy,
    };
  }
}
