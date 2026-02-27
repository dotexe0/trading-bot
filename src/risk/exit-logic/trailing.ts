/**
 * TrailingProfitExit (EXIT-01).
 *
 * A trailing stop that activates only after price has moved in profit
 * by a configurable percentage (activateAfterPct). Once activated, it
 * tracks the high-water mark (best price) and sets a trailing stop at
 * HWM - (trailAtrMultiple * ATR) for longs, or HWM + (trailAtrMultiple * ATR)
 * for shorts.
 *
 * Key behaviors:
 * - Does NOT exit on the activation candle (allows momentum to continue).
 * - HWM never moves backward — only updates when price improves.
 * - Always produces full_exit (fraction=1), never partial.
 * - When currentAtr is null: skips HWM/stop update but still checks existing
 *   stop for breach. Does not activate if not yet active (cannot compute distance).
 */

import { d, Decimal, ZERO } from '../../core/decimal.js';
import type { TrailingExitConfig, ExitAction } from './types.js';

export class TrailingProfitExit {
  private readonly config: TrailingExitConfig;
  private readonly entryPrice: Decimal;
  private readonly direction: 'long' | 'short';

  private highWaterMark: Decimal | null = null;
  private trailingStopPrice: Decimal | null = null;

  constructor(
    config: TrailingExitConfig,
    entryPrice: Decimal,
    direction: 'long' | 'short',
  ) {
    this.config = config;
    this.entryPrice = entryPrice;
    this.direction = direction;
  }

  /**
   * Check the current candle against the trailing stop.
   *
   * @param candle - Candle OHLC data (strings)
   * @param currentAtr - Current ATR value, or null if insufficient data
   * @returns ExitAction: full_exit if trailing stop breached, none otherwise
   */
  check(
    candle: { high: string; low: string; close: string },
    currentAtr: Decimal | null,
  ): ExitAction {
    const candleHigh = d(candle.high);
    const candleLow = d(candle.low);

    // ── Not yet activated ──────────────────────────────────
    if (this.trailingStopPrice === null) {
      // Cannot activate without ATR (need it to compute trail distance)
      if (currentAtr === null) {
        return this.noneAction(candle.close);
      }

      // Check if activation threshold is reached
      const activated = this.checkActivation(candleHigh, candleLow);
      if (!activated) {
        return this.noneAction(candle.close);
      }

      // Set initial HWM and trailing stop
      this.initializeTrail(candleHigh, candleLow, currentAtr);

      // Do NOT exit on the activation candle
      return this.noneAction(candle.close);
    }

    // ── Already activated ──────────────────────────────────

    // Update HWM and stop only if ATR is available
    if (currentAtr !== null) {
      this.updateTrail(candleHigh, candleLow, currentAtr);
    }

    // Check for stop breach (always, even with null ATR)
    if (this.isBreached(candleHigh, candleLow)) {
      return {
        type: 'full_exit',
        fillPrice: this.trailingStopPrice,
        fraction: d(1),
        reason: 'trailing_stop',
      };
    }

    return this.noneAction(candle.close);
  }

  /**
   * Get the current trailing stop price, or null if not yet activated.
   */
  getTrailingStopPrice(): Decimal | null {
    return this.trailingStopPrice;
  }

  // ── Private helpers ────────────────────────────────────────────────

  private checkActivation(candleHigh: Decimal, candleLow: Decimal): boolean {
    const threshold = d(this.config.activateAfterPct);

    if (this.direction === 'long') {
      // For long: (candleHigh - entry) / entry >= threshold
      const returnPct = candleHigh.minus(this.entryPrice).div(this.entryPrice);
      return returnPct.gte(threshold);
    } else {
      // For short: (entry - candleLow) / entry >= threshold
      const returnPct = this.entryPrice.minus(candleLow).div(this.entryPrice);
      return returnPct.gte(threshold);
    }
  }

  private initializeTrail(
    candleHigh: Decimal,
    candleLow: Decimal,
    currentAtr: Decimal,
  ): void {
    const multiple = d(this.config.trailAtrMultiple);

    if (this.direction === 'long') {
      this.highWaterMark = candleHigh;
      this.trailingStopPrice = candleHigh.minus(multiple.mul(currentAtr));
    } else {
      this.highWaterMark = candleLow;
      this.trailingStopPrice = candleLow.plus(multiple.mul(currentAtr));
    }
  }

  private updateTrail(
    candleHigh: Decimal,
    candleLow: Decimal,
    currentAtr: Decimal,
  ): void {
    const multiple = d(this.config.trailAtrMultiple);

    if (this.direction === 'long') {
      // HWM only moves up
      if (candleHigh.gt(this.highWaterMark!)) {
        this.highWaterMark = candleHigh;
        this.trailingStopPrice = candleHigh.minus(multiple.mul(currentAtr));
      }
    } else {
      // For short, HWM tracks the lowest low (best for shorts)
      if (candleLow.lt(this.highWaterMark!)) {
        this.highWaterMark = candleLow;
        this.trailingStopPrice = candleLow.plus(multiple.mul(currentAtr));
      }
    }
  }

  private isBreached(candleHigh: Decimal, candleLow: Decimal): boolean {
    if (this.direction === 'long') {
      // Long: low breaches stop (falls to or below)
      return candleLow.lte(this.trailingStopPrice!);
    } else {
      // Short: high breaches stop (rises to or above)
      return candleHigh.gte(this.trailingStopPrice!);
    }
  }

  private noneAction(close: string): ExitAction {
    return {
      type: 'none',
      fillPrice: d(close),
      fraction: ZERO,
      reason: '',
    };
  }
}
