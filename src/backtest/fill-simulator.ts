/**
 * FillSimulator -- simulates trade fills with slippage and fee calculation.
 *
 * Fill price = next-bar open adjusted by slippage in basis points,
 * clamped to the candle's [low, high] range.
 * Fees calculated at configurable maker/taker rates.
 * All math uses Decimal precision.
 */

import { d } from '../core/decimal.js';
import type Decimal from 'decimal.js';
import type { Candle } from '../core/types.js';
import type { Signal } from '../strategies/types.js';
import type { SimulatedFill } from './types.js';

export interface FillSimulatorConfig {
  slippageBps: number;
  feeTierMaker: number;
  feeTierTaker: number;
  assumeTaker: boolean;
}

export class FillSimulator {
  private readonly slippageBps: Decimal;
  private readonly feeRate: Decimal;

  constructor(config: FillSimulatorConfig) {
    this.slippageBps = d(config.slippageBps);
    this.feeRate = d(config.assumeTaker ? config.feeTierTaker : config.feeTierMaker);
  }

  /**
   * Simulate a fill for the given signal on the fill candle.
   *
   * @param signal - The trading signal that triggered the order
   * @param fillCandle - The next bar (where the fill actually occurs)
   * @param quantity - How much to buy/sell
   * @returns SimulatedFill with adjusted price, fee, and all fields
   */
  simulate(signal: Signal, fillCandle: Candle, quantity: Decimal): SimulatedFill {
    const open = d(fillCandle.open);
    const low = d(fillCandle.low);
    const high = d(fillCandle.high);
    const bpsFactor = this.slippageBps.div(10000);

    // Apply slippage: buys get worse (higher) price, sells get worse (lower) price
    const isBuy = signal.direction === 'long';
    let fillPrice: Decimal;

    if (isBuy) {
      fillPrice = open.mul(d(1).plus(bpsFactor));
    } else {
      fillPrice = open.mul(d(1).minus(bpsFactor));
    }

    // Clamp fill price within candle's [low, high] range
    if (fillPrice.lt(low)) fillPrice = low;
    if (fillPrice.gt(high)) fillPrice = high;

    // Fee = quantity * fillPrice * feeRate
    const fee = quantity.mul(fillPrice).mul(this.feeRate);

    return {
      signal,
      fillPrice,
      fillTimestamp: fillCandle.timestamp,
      fee,
      quantity,
      side: isBuy ? 'buy' : 'sell',
    };
  }
}
