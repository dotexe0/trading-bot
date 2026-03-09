import { describe, it, expect } from 'vitest';
import { d } from '../../core/decimal.js';
import { calcLiquidationPrice, calcLiquidationDistance } from '../liquidation-calc.js';

describe('calcLiquidationPrice', () => {
  it('computes long liquidation price at 10x leverage', () => {
    // liqPrice = 50000 * (1 - 1/10 + 0.0333) = 50000 * (1 - 0.1 + 0.0333) = 50000 * 0.9333 = 46665
    const result = calcLiquidationPrice(d(50000), 10, 'long', d('0.0333'));
    expect(result.toNumber()).toBeCloseTo(46665, 0);
  });

  it('computes short liquidation price at 10x leverage', () => {
    // liqPrice = 50000 * (1 + 1/10 - 0.0333) = 50000 * (1 + 0.1 - 0.0333) = 50000 * 1.0667 = 53335
    const result = calcLiquidationPrice(d(50000), 10, 'short', d('0.0333'));
    expect(result.toNumber()).toBeCloseTo(53335, 0);
  });

  it('returns positive liq distance for long when mark > liq (safe)', () => {
    // mark 50000 > liq 46665 → distance positive
    const liqPrice = calcLiquidationPrice(d(50000), 10, 'long', d('0.0333'));
    const distance = calcLiquidationDistance(d(50000), liqPrice, 'long');
    expect(distance.toNumber()).toBeGreaterThan(0);
  });

  it('returns negative liq distance for long when mark < liq (past liquidation)', () => {
    // mark 40000 < liq 46665 → distance negative
    const liqPrice = calcLiquidationPrice(d(50000), 10, 'long', d('0.0333'));
    const distance = calcLiquidationDistance(d(40000), liqPrice, 'long');
    expect(distance.toNumber()).toBeLessThan(0);
  });

  it('returns positive liq distance for short when mark < liq (safe)', () => {
    // short: mark 50000 < liq 53335 → distance positive
    const liqPrice = calcLiquidationPrice(d(50000), 10, 'short', d('0.0333'));
    const distance = calcLiquidationDistance(d(50000), liqPrice, 'short');
    expect(distance.toNumber()).toBeGreaterThan(0);
  });

  it('formula consistency: 1x leverage long gives liq near mm adjustment', () => {
    // liqPrice = entryPrice * (1 - 1/1 + mmr) = entryPrice * mmr
    // e.g. entry 50000, mmr 0.0333 → liqPrice ≈ 50000 * 0.0333 = 1665
    const result = calcLiquidationPrice(d(50000), 1, 'long', d('0.0333'));
    const expected = d(50000).mul(d('0.0333'));
    expect(result.toFixed(4)).toBe(expected.toFixed(4));
  });
});
