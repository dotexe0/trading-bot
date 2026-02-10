/**
 * PortfolioTracker tests -- state machine, round-trip trades, Decimal math.
 */

import { describe, it, expect } from 'vitest';
import { PortfolioTracker } from '../portfolio.js';
import { d, ZERO, Decimal } from '../../core/decimal.js';
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

describe('PortfolioTracker', () => {
  it('initial state: cash = initialCapital, position = 0, no trades', () => {
    const pt = new PortfolioTracker('10000');
    const state = pt.getState();

    expect(state.cashBalance.toNumber()).toBe(10000);
    expect(state.position.isZero()).toBe(true);
    expect(state.trades).toHaveLength(0);
    expect(pt.isFlat()).toBe(true);
  });

  it('long fill deducts cost from cash, sets positive position', () => {
    const pt = new PortfolioTracker('10000');
    const fill = makeFill('long', 50000, 0.1, 37.5);

    pt.applyFill(fill);
    const state = pt.getState();

    // Cost = 0.1 * 50000 + 37.5 = 5037.5
    expect(state.cashBalance.toNumber()).toBe(10000 - 5037.5);
    expect(state.position.toNumber()).toBe(0.1);
    expect(pt.isLong()).toBe(true);
    expect(pt.isFlat()).toBe(false);
  });

  it('close after long creates round-trip trade with correct PnL', () => {
    const pt = new PortfolioTracker('10000');

    // Entry: buy 0.1 BTC at 50000, fee=37.5
    pt.applyFill(makeFill('long', 50000, 0.1, 37.5, 1000000));

    // Exit: sell 0.1 BTC at 55000, fee=41.25
    pt.applyFill(makeFill('close', 55000, 0.1, 41.25, 2000000));

    expect(pt.isFlat()).toBe(true);
    const trades = pt.trades;
    expect(trades).toHaveLength(1);

    const trade = trades[0];
    // PnL = exit proceeds - entry cost
    // exit proceeds = 0.1 * 55000 - 41.25 = 5458.75
    // entry cost = 0.1 * 50000 + 37.5 = 5037.5
    // PnL = 5458.75 - 5037.5 = 421.25
    expect(trade.pnl.toNumber()).toBe(421.25);
    expect(trade.holdingPeriodMs).toBe(1000000);
  });

  it('short fill when flat sets negative position', () => {
    const pt = new PortfolioTracker('10000');
    const fill = makeFill('short', 50000, 0.1, 37.5);

    pt.applyFill(fill);
    const state = pt.getState();

    // Proceeds = 0.1 * 50000 - 37.5 = 4962.5
    expect(state.cashBalance.toNumber()).toBe(10000 + 4962.5);
    expect(state.position.toNumber()).toBe(-0.1);
    expect(pt.isShort()).toBe(true);
  });

  it('close after short creates trade with correct PnL (profit when price drops)', () => {
    const pt = new PortfolioTracker('10000');

    // Entry: short 0.1 BTC at 50000, fee=37.5
    pt.applyFill(makeFill('short', 50000, 0.1, 37.5, 1000000));

    // Exit: buy back 0.1 BTC at 45000, fee=33.75
    pt.applyFill(makeFill('close', 45000, 0.1, 33.75, 2000000));

    expect(pt.isFlat()).toBe(true);
    const trades = pt.trades;
    expect(trades).toHaveLength(1);

    const trade = trades[0];
    // entry proceeds = 0.1 * 50000 - 37.5 = 4962.5
    // exit cost = 0.1 * 45000 + 33.75 = 4533.75
    // PnL = 4962.5 - 4533.75 = 428.75
    expect(trade.pnl.toNumber()).toBe(428.75);
  });

  it('reversal (long->short) creates one trade and opens new position', () => {
    const pt = new PortfolioTracker('10000');

    // Open long
    pt.applyFill(makeFill('long', 50000, 0.1, 37.5, 1000000));
    expect(pt.isLong()).toBe(true);

    // Signal short (reversal): closes long + opens short
    pt.applyFill(makeFill('short', 52000, 0.1, 39, 2000000));

    expect(pt.isShort()).toBe(true);
    expect(pt.trades).toHaveLength(1);
    expect(pt.trades[0].exitFill.fillPrice.toNumber()).toBe(52000);
  });

  it('duplicate direction ignored', () => {
    const pt = new PortfolioTracker('10000');

    pt.applyFill(makeFill('long', 50000, 0.1, 37.5));
    const cashAfterFirst = pt.getState().cashBalance;

    // Another long signal -- should be ignored
    pt.applyFill(makeFill('long', 51000, 0.1, 38.25));
    expect(pt.getState().cashBalance.eq(cashAfterFirst)).toBe(true);
    expect(pt.getState().position.toNumber()).toBe(0.1);
  });

  it('equity calculation correct for long, short, and flat positions', () => {
    const pt = new PortfolioTracker('10000');
    const price = d(50000);

    // Flat: equity = cash = 10000
    expect(pt.equity(price).toNumber()).toBe(10000);

    // Long 0.1 BTC at 50000, fee=0 for simplicity
    pt.applyFill(makeFill('long', 50000, 0.1, 0));
    // Cash = 10000 - 5000 = 5000, position = 0.1
    // Equity at 50000 = 5000 + 0.1 * 50000 = 10000
    expect(pt.equity(d(50000)).toNumber()).toBe(10000);
    // Equity at 55000 = 5000 + 0.1 * 55000 = 10500
    expect(pt.equity(d(55000)).toNumber()).toBe(10500);
  });

  it('peak equity tracks correctly for drawdown', () => {
    const pt = new PortfolioTracker('10000');

    // Open long, then close at profit
    pt.applyFill(makeFill('long', 50000, 0.1, 0, 1000000));
    pt.applyFill(makeFill('close', 55000, 0.1, 0, 2000000));

    const state = pt.getState();
    // Peak should be updated after the profitable close
    expect(state.peakEquity.gte(d(10000))).toBe(true);
  });

  it('all financial values are Decimal (not Number)', () => {
    const pt = new PortfolioTracker('10000');
    const state = pt.getState();

    expect(state.cashBalance).toBeInstanceOf(Decimal);
    expect(state.position).toBeInstanceOf(Decimal);
    expect(state.avgEntryPrice).toBeInstanceOf(Decimal);
    expect(state.totalFees).toBeInstanceOf(Decimal);
    expect(state.peakEquity).toBeInstanceOf(Decimal);
    expect(pt.equity(d(50000))).toBeInstanceOf(Decimal);
  });

  it('close on flat position is a no-op', () => {
    const pt = new PortfolioTracker('10000');
    pt.applyFill(makeFill('close', 50000, 0.1, 0));

    expect(pt.isFlat()).toBe(true);
    expect(pt.trades).toHaveLength(0);
    expect(pt.getState().cashBalance.toNumber()).toBe(10000);
  });
});
