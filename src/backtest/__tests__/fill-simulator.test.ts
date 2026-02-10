/**
 * FillSimulator tests -- slippage, fee calculation, Decimal precision.
 */

import { describe, it, expect } from 'vitest';
import { FillSimulator } from '../fill-simulator.js';
import { d, Decimal } from '../../core/decimal.js';
import type { Candle } from '../../core/types.js';
import type { Signal } from '../../strategies/types.js';

function makeCandle(overrides: Partial<Candle> = {}): Candle {
  return {
    pair: 'BTC-USD',
    timeframe: '1h',
    timestamp: 1000000,
    open: '50000',
    high: '51000',
    low: '49000',
    close: '50500',
    volume: '100',
    ...overrides,
  };
}

function makeSignal(direction: 'long' | 'short' | 'close'): Signal {
  return {
    strategyName: 'test-strategy',
    pair: 'BTC-USD',
    timeframe: '1h',
    timestamp: 999000,
    direction,
    confidence: 0.8,
    reasoning: 'test signal',
  };
}

describe('FillSimulator', () => {
  const defaultConfig = {
    slippageBps: 5,
    feeTierMaker: 0.0035,
    feeTierTaker: 0.0075,
    assumeTaker: true,
  };

  it('buy fill applies positive slippage to open price', () => {
    const sim = new FillSimulator(defaultConfig);
    const candle = makeCandle({ open: '50000' });
    const fill = sim.simulate(makeSignal('long'), candle, d(1));

    // Slippage: 50000 * (1 + 5/10000) = 50000 * 1.0005 = 50025
    expect(fill.fillPrice.toNumber()).toBeCloseTo(50025, 2);
    expect(fill.side).toBe('buy');
  });

  it('sell fill applies negative slippage to open price', () => {
    const sim = new FillSimulator(defaultConfig);
    const candle = makeCandle({ open: '50000' });
    const fill = sim.simulate(makeSignal('short'), candle, d(1));

    // Slippage: 50000 * (1 - 5/10000) = 50000 * 0.9995 = 49975
    expect(fill.fillPrice.toNumber()).toBeCloseTo(49975, 2);
    expect(fill.side).toBe('sell');
  });

  it('fill price clamped within candle [low, high]', () => {
    const sim = new FillSimulator({
      ...defaultConfig,
      slippageBps: 100, // 1% slippage -- extreme
    });

    // Buy: open=50000, slippage=1% -> 50500, but high=50200 -> clamped to 50200
    const candle = makeCandle({ open: '50000', high: '50200', low: '49800' });
    const buyFill = sim.simulate(makeSignal('long'), candle, d(1));
    expect(buyFill.fillPrice.toNumber()).toBe(50200);

    // Sell: open=50000, slippage=-1% -> 49500, but low=49800 -> clamped to 49800
    const sellFill = sim.simulate(makeSignal('short'), candle, d(1));
    expect(sellFill.fillPrice.toNumber()).toBe(49800);
  });

  it('fee calculated correctly with taker rate', () => {
    const sim = new FillSimulator(defaultConfig);
    const candle = makeCandle({ open: '50000' });
    const fill = sim.simulate(makeSignal('long'), candle, d(2));

    // Fee = quantity * fillPrice * takerRate = 2 * 50025 * 0.0075
    const expectedFee = d(2).mul(fill.fillPrice).mul(d(0.0075));
    expect(fill.fee.toFixed(8)).toBe(expectedFee.toFixed(8));
  });

  it('fee calculated correctly with maker rate when assumeTaker=false', () => {
    const sim = new FillSimulator({ ...defaultConfig, assumeTaker: false });
    const candle = makeCandle({ open: '50000' });
    const fill = sim.simulate(makeSignal('long'), candle, d(2));

    // Fee = quantity * fillPrice * makerRate = 2 * 50025 * 0.0035
    const expectedFee = d(2).mul(fill.fillPrice).mul(d(0.0035));
    expect(fill.fee.toFixed(8)).toBe(expectedFee.toFixed(8));
  });

  it('zero slippage returns exact open price', () => {
    const sim = new FillSimulator({ ...defaultConfig, slippageBps: 0 });
    const candle = makeCandle({ open: '50000' });

    const buyFill = sim.simulate(makeSignal('long'), candle, d(1));
    expect(buyFill.fillPrice.toNumber()).toBe(50000);

    const sellFill = sim.simulate(makeSignal('short'), candle, d(1));
    expect(sellFill.fillPrice.toNumber()).toBe(50000);
  });

  it('all values are Decimal instances (not native numbers)', () => {
    const sim = new FillSimulator(defaultConfig);
    const candle = makeCandle();
    const fill = sim.simulate(makeSignal('long'), candle, d(1));

    expect(fill.fillPrice).toBeInstanceOf(Decimal);
    expect(fill.fee).toBeInstanceOf(Decimal);
    expect(fill.quantity).toBeInstanceOf(Decimal);
  });

  it('populates all SimulatedFill fields correctly', () => {
    const sim = new FillSimulator(defaultConfig);
    const signal = makeSignal('long');
    const candle = makeCandle({ timestamp: 5000000 });
    const fill = sim.simulate(signal, candle, d(0.5));

    expect(fill.signal).toBe(signal);
    expect(fill.fillTimestamp).toBe(5000000);
    expect(fill.quantity.toNumber()).toBe(0.5);
    expect(fill.side).toBe('buy');
  });
});
