/**
 * ATR-based dynamic stop (EXIT-04).
 *
 * Computes a fixed stop price at position open based on ATR value:
 *   Long:  stop = entryPrice - (atrMultiple * ATR)
 *   Short: stop = entryPrice + (atrMultiple * ATR)
 *
 * The stop does NOT trail -- it is set once at entry. Trailing is EXIT-01's job.
 * When ATR is null (insufficient candles), falls back to a percentage-based stop
 * using atrMultiple * 0.01 * entryPrice as a rough proxy.
 *
 * Triggers on candle low (long) or candle high (short) breach, matching
 * the pattern in src/risk/stop-loss.ts.
 */

import { d, Decimal } from '../../core/decimal.js';
import type { AtrStopConfig, ExitAction } from './types.js';

export class AtrDynamicStop {
  private readonly stopPrice: Decimal;
  private readonly direction: 'long' | 'short';

  /**
   * Create an ATR-based dynamic stop for a position.
   *
   * @param config - ATR stop configuration (atrPeriod, atrMultiple)
   * @param entryPrice - Price at which the position was entered
   * @param direction - Position direction (long or short)
   * @param currentAtr - Current ATR value, or null if insufficient data
   */
  constructor(
    config: AtrStopConfig,
    entryPrice: Decimal,
    direction: 'long' | 'short',
    currentAtr: Decimal | null,
  ) {
    this.direction = direction;

    // Calculate the stop distance
    let stopDistance: Decimal;
    if (currentAtr !== null) {
      // Normal: use ATR * multiple
      stopDistance = currentAtr.mul(d(config.atrMultiple));
    } else {
      // Fallback: percentage-based proxy when ATR is unavailable
      stopDistance = d(config.atrMultiple).mul(d(0.01)).mul(entryPrice);
    }

    // Calculate stop price based on direction
    if (direction === 'long') {
      this.stopPrice = entryPrice.minus(stopDistance);
    } else {
      this.stopPrice = entryPrice.plus(stopDistance);
    }
  }

  /**
   * Check if the stop is triggered by the given candle.
   *
   * Uses candle LOW for longs (lte) and candle HIGH for shorts (gte),
   * consistent with StopLossTracker.
   *
   * @param candle - Candle data with low, high, close as strings
   * @returns ExitAction: full_exit if triggered, none otherwise
   */
  check(candle: { low: string; high: string; close: string }): ExitAction {
    const candleLow = d(candle.low);
    const candleHigh = d(candle.high);

    let triggered: boolean;
    if (this.direction === 'long') {
      triggered = candleLow.lte(this.stopPrice);
    } else {
      triggered = candleHigh.gte(this.stopPrice);
    }

    if (triggered) {
      return {
        type: 'full_exit',
        fillPrice: this.stopPrice,
        fraction: d(1),
        reason: 'atr_stop',
      };
    }

    return {
      type: 'none',
      fillPrice: d(candle.close),
      fraction: d(0),
      reason: '',
    };
  }

  /**
   * Get the current stop price level.
   */
  getStopPrice(): Decimal {
    return this.stopPrice;
  }
}
