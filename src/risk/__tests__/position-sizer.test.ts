/**
 * Tests for PositionSizer -- Kelly criterion and fixed-fraction sizing.
 */

import { describe, it, expect } from 'vitest';
import { d, ZERO } from '../../core/decimal.js';
import { parseRiskConfig } from '../config.js';
import { PositionSizer } from '../position-sizer.js';
import type { StrategyStats } from '../types.js';

/** Helper to create strategy stats */
function makeStats(overrides: Partial<{
  totalTrades: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
}>): StrategyStats {
  return {
    totalTrades: overrides.totalTrades ?? 100,
    winRate: d(overrides.winRate ?? 0.6),
    avgWin: d(overrides.avgWin ?? 0.03),
    avgLoss: d(overrides.avgLoss ?? 0.02),
  };
}

describe('PositionSizer', () => {
  describe('half-Kelly (default)', () => {
    it('calculates correct half-Kelly size with 60% win rate and 1.5:1 ratio', () => {
      const config = parseRiskConfig({});
      const sizer = new PositionSizer(config);

      // W=0.6, R=0.03/0.02=1.5
      // Kelly = 0.6 - 0.4/1.5 = 0.6 - 0.2667 = 0.3333
      // Half-Kelly = 0.3333 * 0.5 = 0.1667
      const stats = makeStats({ winRate: 0.6, avgWin: 0.03, avgLoss: 0.02 });
      const result = sizer.calculate(d(10000), d(50000), stats);

      expect(result.method).toBe('half-kelly');
      expect(result.rawKellyPct.toFixed(4)).toBe('0.3333');
      expect(result.appliedPct.toFixed(4)).toBe('0.1667');
      // quantity = equity * appliedPct / price
      const expectedQty = d(10000).mul(result.appliedPct).div(d(50000));
      expect(result.quantity.toFixed(10)).toBe(expectedQty.toFixed(10));
      expect(result.cappedBy).toBeUndefined();
    });
  });

  describe('full Kelly', () => {
    it('caps at maxPositionPct when full Kelly exceeds cap', () => {
      const config = parseRiskConfig({
        sizingMethod: 'kelly',
        kellyFraction: 1.0,
      });
      const sizer = new PositionSizer(config);

      // Kelly = 0.3333, full Kelly * 1.0 = 0.3333 > 0.25 cap
      const stats = makeStats({ winRate: 0.6, avgWin: 0.03, avgLoss: 0.02 });
      const result = sizer.calculate(d(10000), d(50000), stats);

      expect(result.method).toBe('kelly');
      expect(result.rawKellyPct.toFixed(4)).toBe('0.3333');
      expect(result.appliedPct.toFixed(2)).toBe('0.25');
      expect(result.cappedBy).toBe('maxPositionPct');
      // quantity = 10000 * 0.25 / 50000 = 0.05
      const expectedQty = d(10000).mul(d(0.25)).div(d(50000));
      expect(result.quantity.eq(expectedQty)).toBe(true);
    });
  });

  describe('fixed-fraction', () => {
    it('calculates correct fixed-fraction size', () => {
      const config = parseRiskConfig({ sizingMethod: 'fixed-fraction' });
      const sizer = new PositionSizer(config);

      // 2% of 10000 = 200, quantity = 200/50000 = 0.004
      const result = sizer.calculate(d(10000), d(50000), null);

      expect(result.method).toBe('fixed-fraction');
      expect(result.appliedPct.toNumber()).toBe(0.02);
      expect(result.quantity.toFixed(3)).toBe('0.004');
      expect(result.rawKellyPct.eq(ZERO)).toBe(true);
      expect(result.cappedBy).toBeUndefined();
    });
  });

  describe('fallback behavior', () => {
    it('falls back to fixed-fraction when trades < minTradesForKelly', () => {
      const config = parseRiskConfig({});
      const sizer = new PositionSizer(config);

      const stats = makeStats({ totalTrades: 20 }); // < 30 default
      const result = sizer.calculate(d(10000), d(50000), stats);

      expect(result.method).toBe('fixed-fraction');
    });

    it('falls back to fixed-fraction when stats is null', () => {
      const config = parseRiskConfig({});
      const sizer = new PositionSizer(config);

      const result = sizer.calculate(d(10000), d(50000), null);

      expect(result.method).toBe('fixed-fraction');
      expect(result.appliedPct.toNumber()).toBe(0.02);
    });

    it('falls back to fixed-fraction when avgLoss is zero', () => {
      const config = parseRiskConfig({});
      const sizer = new PositionSizer(config);

      const stats = makeStats({ avgLoss: 0 });
      const result = sizer.calculate(d(10000), d(50000), stats);

      expect(result.method).toBe('fixed-fraction');
    });

    it('falls back to fixed-fraction when winRate is zero', () => {
      const config = parseRiskConfig({});
      const sizer = new PositionSizer(config);

      const stats = makeStats({ winRate: 0 });
      const result = sizer.calculate(d(10000), d(50000), stats);

      expect(result.method).toBe('fixed-fraction');
    });
  });

  describe('edge cases', () => {
    it('clamps negative Kelly to zero (losing strategy)', () => {
      const config = parseRiskConfig({
        sizingMethod: 'kelly',
        kellyFraction: 1.0,
        minTradesForKelly: 1,
      });
      const sizer = new PositionSizer(config);

      // W=0.2, R=0.01/0.05=0.2
      // Kelly = 0.2 - 0.8/0.2 = 0.2 - 4.0 = -3.8
      const stats = makeStats({
        totalTrades: 50,
        winRate: 0.2,
        avgWin: 0.01,
        avgLoss: 0.05,
      });
      const result = sizer.calculate(d(10000), d(50000), stats);

      expect(result.method).toBe('kelly');
      expect(result.rawKellyPct.isNeg()).toBe(true);
      expect(result.appliedPct.eq(ZERO)).toBe(true);
      expect(result.quantity.eq(ZERO)).toBe(true);
      expect(result.cappedBy).toBe('negative-kelly');
    });

    it('handles exact zero Kelly (breakeven strategy)', () => {
      const config = parseRiskConfig({
        sizingMethod: 'kelly',
        kellyFraction: 1.0,
        minTradesForKelly: 1,
      });
      const sizer = new PositionSizer(config);

      // W=0.5, R=0.02/0.02=1.0
      // Kelly = 0.5 - 0.5/1.0 = 0.0
      const stats = makeStats({
        totalTrades: 50,
        winRate: 0.5,
        avgWin: 0.02,
        avgLoss: 0.02,
      });
      const result = sizer.calculate(d(10000), d(50000), stats);

      expect(result.appliedPct.eq(ZERO)).toBe(true);
      expect(result.quantity.eq(ZERO)).toBe(true);
    });
  });
});
