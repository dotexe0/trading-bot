/**
 * TrailingProfitExit tests -- TDD RED phase.
 *
 * Tests EXIT-01: Trailing profit stop that activates after a configurable
 * profit threshold, then trails price using ATR-based distance.
 */

import { describe, it, expect } from 'vitest';
import { TrailingProfitExit } from '../trailing.js';
import { d } from '../../../core/decimal.js';

describe('TrailingProfitExit', () => {
  const defaultConfig = {
    enabled: true,
    activateAfterPct: 0.02,
    trailAtrMultiple: 2.0,
  };

  describe('dormant phase — long positions', () => {
    it('returns none when price has not reached activation threshold', () => {
      // entry=100, activateAfterPct=0.02 → need +2% (high >= 102)
      // Candle high=101.5 (+1.5%) → not enough
      const trail = new TrailingProfitExit(defaultConfig, d(100), 'long');
      const result = trail.check(
        { high: '101.5', low: '99', close: '101' },
        d(1),
      );
      expect(result.type).toBe('none');
      expect(trail.getTrailingStopPrice()).toBeNull();
    });

    it('activates at exact threshold but does not exit on activation candle', () => {
      // entry=100, activateAfterPct=0.02 → activation at high=102 (exactly +2%)
      // ATR=1.0, multiple=2.0 → trailingStop = 102 - 2*1.0 = 100
      const trail = new TrailingProfitExit(defaultConfig, d(100), 'long');
      const result = trail.check(
        { high: '102', low: '99', close: '101.5' },
        d(1),
      );
      expect(result.type).toBe('none'); // No exit on activation candle
      expect(trail.getTrailingStopPrice()).not.toBeNull();
      expect(trail.getTrailingStopPrice()!.toNumber()).toBe(100);
    });
  });

  describe('active phase — long positions', () => {
    it('updates HWM and trailing stop as price rises', () => {
      // Activate: entry=100, high=102, ATR=1.0, multiple=2.0
      // → HWM=102, trailingStop=100
      const trail = new TrailingProfitExit(defaultConfig, d(100), 'long');
      trail.check({ high: '102', low: '99', close: '101.5' }, d(1));

      // Next candle: high=104, low=101, ATR=1.0
      // → HWM=104, trailingStop = 104 - 2*1 = 102
      const result = trail.check(
        { high: '104', low: '101', close: '103' },
        d(1),
      );
      expect(result.type).toBe('none');
      expect(trail.getTrailingStopPrice()!.toNumber()).toBe(102);
    });

    it('returns none when low stays above trailing stop', () => {
      const trail = new TrailingProfitExit(defaultConfig, d(100), 'long');
      trail.check({ high: '102', low: '99', close: '101.5' }, d(1));
      trail.check({ high: '104', low: '101', close: '103' }, d(1));

      // trailingStop=102, candle low=101.9 (not breached, 101.9 > 102 is false but 101.9 < 102 is true)
      // Wait: 101.9 < 102 → would trigger
      // Let's use low=102.1 which stays above 102
      const result = trail.check(
        { high: '104', low: '102.1', close: '103' },
        d(1),
      );
      expect(result.type).toBe('none');
    });

    it('triggers full_exit when low breaches trailing stop', () => {
      const trail = new TrailingProfitExit(defaultConfig, d(100), 'long');
      trail.check({ high: '102', low: '99', close: '101.5' }, d(1));
      trail.check({ high: '104', low: '101', close: '103' }, d(1));

      // trailingStop=102, candle low=101.5 (< 102) → triggers
      const result = trail.check(
        { high: '103', low: '101.5', close: '102' },
        d(1),
      );
      expect(result.type).toBe('full_exit');
      expect(result.fillPrice.toNumber()).toBe(102); // fill at trailing stop
      expect(result.fraction.toNumber()).toBe(1);
      expect(result.reason).toBe('trailing_stop');
    });

    it('HWM never moves backward', () => {
      const trail = new TrailingProfitExit(defaultConfig, d(100), 'long');
      // Activate at 102
      trail.check({ high: '102', low: '99', close: '101.5' }, d(1));
      // HWM rises to 106
      trail.check({ high: '106', low: '103', close: '105' }, d(1));
      // trailingStop = 106 - 2*1 = 104

      // Next candle: high=104 (lower than HWM=106) → HWM stays 106, stop stays 104
      const result = trail.check(
        { high: '104', low: '104.1', close: '104' },
        d(1),
      );
      expect(result.type).toBe('none');
      expect(trail.getTrailingStopPrice()!.toNumber()).toBe(104);
    });

    it('always produces full_exit type, never partial', () => {
      const trail = new TrailingProfitExit(defaultConfig, d(100), 'long');
      trail.check({ high: '102', low: '99', close: '101.5' }, d(1));
      const result = trail.check(
        { high: '103', low: '99', close: '100' },
        d(1),
      );
      expect(result.type).toBe('full_exit');
      expect(result.fraction.toNumber()).toBe(1);
    });
  });

  describe('short positions', () => {
    it('activates when price drops by activateAfterPct', () => {
      // entry=100, activateAfterPct=0.02 → need candle low <= 98 (2% drop)
      const trail = new TrailingProfitExit(defaultConfig, d(100), 'short');
      const result = trail.check(
        { high: '101', low: '98', close: '98.5' },
        d(1),
      );
      expect(result.type).toBe('none'); // activation candle, no exit
      expect(trail.getTrailingStopPrice()).not.toBeNull();
    });

    it('uses candle low for HWM in short positions', () => {
      // Short: best price = lowest low (HWM tracks lowest)
      // entry=100, activation low=98, ATR=1, multiple=2 → stop = 98 + 2*1 = 100
      const trail = new TrailingProfitExit(defaultConfig, d(100), 'short');
      trail.check({ high: '101', low: '98', close: '98.5' }, d(1));

      // New low=96 → HWM=96, stop = 96 + 2*1 = 98
      trail.check({ high: '99', low: '96', close: '97' }, d(1));
      expect(trail.getTrailingStopPrice()!.toNumber()).toBe(98);
    });

    it('triggers when candle high breaches trailing stop for short', () => {
      const trail = new TrailingProfitExit(defaultConfig, d(100), 'short');
      trail.check({ high: '101', low: '98', close: '98.5' }, d(1));
      // stop = 98 + 2*1 = 100

      // Candle high=100.5 (> 100) → triggers
      const result = trail.check(
        { high: '100.5', low: '99', close: '100' },
        d(1),
      );
      expect(result.type).toBe('full_exit');
      expect(result.fillPrice.toNumber()).toBe(100);
      expect(result.reason).toBe('trailing_stop');
    });
  });

  describe('null ATR handling', () => {
    it('skips HWM/stop update when currentAtr is null but checks existing stop', () => {
      const trail = new TrailingProfitExit(defaultConfig, d(100), 'long');
      // Activate with valid ATR
      trail.check({ high: '102', low: '99', close: '101.5' }, d(1));
      // trailingStop = 102 - 2*1 = 100
      expect(trail.getTrailingStopPrice()!.toNumber()).toBe(100);

      // Now pass null ATR — stop should NOT update, but still check for breach
      const result = trail.check(
        { high: '103', low: '100.5', close: '101' },
        null,
      );
      expect(result.type).toBe('none');
      // Stop should remain at 100, not recalculated
      expect(trail.getTrailingStopPrice()!.toNumber()).toBe(100);
    });

    it('triggers exit even when currentAtr is null if existing stop is breached', () => {
      const trail = new TrailingProfitExit(defaultConfig, d(100), 'long');
      trail.check({ high: '102', low: '99', close: '101.5' }, d(1));
      // trailingStop = 100

      // Null ATR but low breaches stop
      const result = trail.check(
        { high: '101', low: '99.5', close: '100' },
        null,
      );
      expect(result.type).toBe('full_exit');
      expect(result.fillPrice.toNumber()).toBe(100);
    });

    it('does not activate when ATR is null (cannot compute stop distance)', () => {
      const trail = new TrailingProfitExit(defaultConfig, d(100), 'long');
      const result = trail.check(
        { high: '105', low: '99', close: '104' },
        null,
      );
      expect(result.type).toBe('none');
      expect(trail.getTrailingStopPrice()).toBeNull();
    });
  });
});
