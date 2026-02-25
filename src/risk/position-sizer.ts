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
   *   Applied AFTER all other sizing caps. When < 1, reduces the position
   *   by multiplying appliedPct by the scalar. When undefined or >= 1,
   *   behavior is identical to v1.0 (zero regression).
   * @returns Position size result with method, percentages, and quantity
   */
  calculate(
    equity: Decimal,
    price: Decimal,
    stats: StrategyStats | null,
    correlationScalar?: Decimal,
  ): PositionSizeResult {
    let baseResult: PositionSizeResult;

    if (this.config.sizingMethod === 'fixed-fraction') {
      baseResult = this.fixedFraction(equity, price);
    } else if (!this.canUseKelly(stats)) {
      // Kelly or half-kelly -- fall back when insufficient stats
      baseResult = this.fixedFraction(equity, price);
    } else {
      // stats is guaranteed non-null here by canUseKelly
      baseResult = this.kelly(equity, price, stats!);
    }

    // Apply correlation discount AFTER all other sizing caps.
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
