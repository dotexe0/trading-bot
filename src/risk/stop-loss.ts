/**
 * Stop-loss tracker for individual positions.
 *
 * Supports fixed stops (remain at initial level) and trailing stops
 * (ratchet with favorable price movement). Checks candle LOW for longs
 * and candle HIGH for shorts to avoid false misses on wicks.
 */

import { d, Decimal } from '../core/decimal.js';
import type { StopLossConfig } from './types.js';

export class StopLossTracker {
  private readonly config: StopLossConfig;
  private readonly direction: 'long' | 'short';
  private highWaterMark: Decimal;
  private stopPrice: Decimal;

  /**
   * Create a stop-loss tracker for a position.
   *
   * @param config - Stop-loss type and percentage
   * @param entryPrice - Price at which the position was entered
   * @param direction - Position direction (long or short)
   */
  constructor(
    config: StopLossConfig,
    entryPrice: Decimal,
    direction: 'long' | 'short',
  ) {
    this.config = config;
    this.direction = direction;
    this.highWaterMark = entryPrice;
    this.stopPrice = this.calculateStopPrice(entryPrice);
  }

  /**
   * Check if the stop-loss is triggered by the given candle.
   *
   * For trailing stops, updates the high water mark before checking.
   * Uses candle LOW for longs and candle HIGH for shorts.
   *
   * @param candle - Candle data with low, high, close as strings
   * @returns Whether triggered and the current stop price
   */
  check(candle: {
    low: string;
    high: string;
    close: string;
  }): { triggered: boolean; stopPrice: Decimal } {
    const candleLow = d(candle.low);
    const candleHigh = d(candle.high);

    // For trailing stops, update high water mark if price moved favorably
    if (this.config.type === 'trailing') {
      if (this.direction === 'long' && candleHigh.gt(this.highWaterMark)) {
        this.highWaterMark = candleHigh;
        this.stopPrice = this.calculateStopPrice(this.highWaterMark);
      } else if (
        this.direction === 'short' &&
        candleLow.lt(this.highWaterMark)
      ) {
        this.highWaterMark = candleLow;
        this.stopPrice = this.calculateStopPrice(this.highWaterMark);
      }
    }

    // Check trigger: longs check LOW, shorts check HIGH
    let triggered: boolean;
    if (this.direction === 'long') {
      triggered = candleLow.lte(this.stopPrice);
    } else {
      triggered = candleHigh.gte(this.stopPrice);
    }

    return { triggered, stopPrice: this.stopPrice };
  }

  /**
   * Get the current stop price level.
   */
  getStopPrice(): Decimal {
    return this.stopPrice;
  }

  /**
   * Calculate stop price from a reference price.
   * Long: referencePrice * (1 - percentage)
   * Short: referencePrice * (1 + percentage)
   */
  private calculateStopPrice(referencePrice: Decimal): Decimal {
    if (this.direction === 'long') {
      return referencePrice.mul(d(1).minus(this.config.percentage));
    } else {
      return referencePrice.mul(d(1).plus(this.config.percentage));
    }
  }
}
