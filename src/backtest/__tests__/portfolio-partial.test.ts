/**
 * PortfolioTracker.applyPartialClose() tests -- TDD RED phase.
 *
 * Tests partial position closing: fractional quantity trades,
 * PnL computation, cash balance updates, and position state.
 */

import { describe, it, expect } from 'vitest';
import { PortfolioTracker } from '../portfolio.js';
import { d, Decimal } from '../../core/decimal.js';
import type { SimulatedFill } from '../types.js';
import type { Signal } from '../../strategies/types.js';

function makeSignal(direction: 'long' | 'short' | 'close'): Signal {
  return {
    strategyName: 'test',
    pair: 'BTC-USD',
    timeframe: '1h',
    timestamp: 1000000,
    direction,
    confidence: 0.8,
    reasoning: 'test',
  };
}

function makeFill(
  direction: 'long' | 'short' | 'close',
  price: number,
  quantity: number,
  fee: number = 0,
  timestamp: number = 1000000,
): SimulatedFill {
  return {
    signal: makeSignal(direction),
    fillPrice: d(price),
    fillTimestamp: timestamp,
    fee: d(fee),
    quantity: d(quantity),
    side: direction === 'long' ? 'buy' : 'sell',
  };
}

describe('PortfolioTracker.applyPartialClose', () => {
  it('records a Trade with correct fractional quantity and positive PnL for long', () => {
    const pt = new PortfolioTracker('10000');
    // Open long: 10 units at price=100, no fee
    pt.applyFill(makeFill('long', 100, 10, 0, 1000000));

    // Partial close: fill at 110, fraction=0.5 => close 5 units
    const fill = makeFill('close', 110, 10, 0, 2000000);
    const trade = pt.applyPartialClose(fill, d(0.5));

    expect(trade).not.toBeNull();
    // Trade quantity should be 5 (half of 10)
    expect(trade!.exitFill.quantity.toNumber()).toBe(5);
    // PnL = (110 - 100) * 5 - 0 fee = 50
    expect(trade!.pnl.toNumber()).toBe(50);
  });

  it('leaves remaining position open with unchanged avgEntryPrice', () => {
    const pt = new PortfolioTracker('10000');
    pt.applyFill(makeFill('long', 100, 10, 0, 1000000));

    const fill = makeFill('close', 110, 10, 0, 2000000);
    pt.applyPartialClose(fill, d(0.5));

    const state = pt.getState();
    // Position should be 5 (half remains)
    expect(state.position.toNumber()).toBe(5);
    // avgEntryPrice should still be 100
    expect(state.avgEntryPrice.toNumber()).toBe(100);
    // Should not be flat
    expect(pt.isFlat()).toBe(false);
    expect(pt.isLong()).toBe(true);
  });

  it('returns null when portfolio is flat', () => {
    const pt = new PortfolioTracker('10000');
    const fill = makeFill('close', 110, 10, 0, 2000000);
    const trade = pt.applyPartialClose(fill, d(0.5));
    expect(trade).toBeNull();
  });

  it('closes full position when fraction is 1.0', () => {
    const pt = new PortfolioTracker('10000');
    pt.applyFill(makeFill('long', 100, 10, 0, 1000000));

    const fill = makeFill('close', 110, 10, 0, 2000000);
    const trade = pt.applyPartialClose(fill, d(1.0));

    expect(trade).not.toBeNull();
    expect(trade!.exitFill.quantity.toNumber()).toBe(10);
    // Position should be flat
    expect(pt.isFlat()).toBe(true);
  });

  it('increases cash balance by closingQuantity * fillPrice - fee for long close', () => {
    const pt = new PortfolioTracker('10000');
    // Open long: 10 @ 100, fee=5 => cost=1005, cash=8995
    pt.applyFill(makeFill('long', 100, 10, 5, 1000000));
    const cashBefore = pt.getState().cashBalance.toNumber();

    // Partial close: 50% at 110, fee=2 => proceeds = 5*110 - 2 = 548
    const fill = makeFill('close', 110, 10, 2, 2000000);
    pt.applyPartialClose(fill, d(0.5));

    const cashAfter = pt.getState().cashBalance.toNumber();
    // Cash should increase by (5 * 110 - 2) = 548
    expect(cashAfter - cashBefore).toBe(548);
  });

  it('handles two sequential partial closes correctly', () => {
    const pt = new PortfolioTracker('10000');
    pt.applyFill(makeFill('long', 100, 10, 0, 1000000));

    // First partial close: 50% => close 5 of 10
    const fill1 = makeFill('close', 110, 10, 0, 2000000);
    pt.applyPartialClose(fill1, d(0.5));
    expect(pt.getState().position.toNumber()).toBe(5);

    // Second partial close: 50% of remaining => close 2.5 of 5
    const fill2 = makeFill('close', 120, 10, 0, 3000000);
    pt.applyPartialClose(fill2, d(0.5));
    expect(pt.getState().position.toNumber()).toBe(2.5);

    // avgEntryPrice stays 100 throughout
    expect(pt.getState().avgEntryPrice.toNumber()).toBe(100);
  });

  it('handles short position partial close correctly', () => {
    const pt = new PortfolioTracker('10000');
    // Open short: 10 @ 100, no fee => proceeds=1000, cash=11000, position=-10
    pt.applyFill(makeFill('short', 100, 10, 0, 1000000));
    expect(pt.getState().position.toNumber()).toBe(-10);

    // Partial close: 50% at 90 (profit for short), no fee
    // closing 5 of 10 short => buying back 5
    const fill = makeFill('close', 90, 10, 0, 2000000);
    const trade = pt.applyPartialClose(fill, d(0.5));

    expect(trade).not.toBeNull();
    // Position goes from -10 to -5
    expect(pt.getState().position.toNumber()).toBe(-5);
    // PnL for short: (100 - 90) * 5 - 0 = 50
    expect(trade!.pnl.toNumber()).toBe(50);
    // avgEntryPrice stays 100
    expect(pt.getState().avgEntryPrice.toNumber()).toBe(100);
  });
});
