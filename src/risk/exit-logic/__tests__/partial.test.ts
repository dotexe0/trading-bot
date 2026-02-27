/**
 * PartialPositionExit tests -- TDD RED phase.
 *
 * Tests EXIT-02: Partial profit target exit that fires once when price
 * reaches a configured profit percentage, closing a fraction of the position.
 */

import { describe, it, expect } from 'vitest';
import { PartialPositionExit } from '../partial.js';
import { d } from '../../../core/decimal.js';

describe('PartialPositionExit', () => {
  const defaultConfig = {
    enabled: true,
    profitTargetPct: 0.03,
    closeFraction: 0.5,
  };

  describe('long positions', () => {
    it('returns none when candle high does not reach profit target', () => {
      // entry=100, profitTargetPct=0.03 → target=103
      // Candle high=102.5 → not enough
      const partial = new PartialPositionExit(defaultConfig, d(100), 'long');
      const result = partial.check({ high: '102.5', low: '99', close: '102' });
      expect(result.type).toBe('none');
      expect(partial.hasFired()).toBe(false);
    });

    it('returns partial_exit when candle high reaches profit target', () => {
      // entry=100, profitTargetPct=0.03 → target=103
      // Candle high=103.5 → breached
      const partial = new PartialPositionExit(defaultConfig, d(100), 'long');
      const result = partial.check({ high: '103.5', low: '101', close: '103' });
      expect(result.type).toBe('partial_exit');
      expect(result.fillPrice.toNumber()).toBe(103); // exact target price
      expect(result.fraction.toNumber()).toBe(0.5);
      expect(result.reason).toBe('partial_profit_target');
      expect(result.newStopPrice?.toNumber()).toBe(100); // breakeven
    });

    it('returns none after partial exit has already fired (guard)', () => {
      const partial = new PartialPositionExit(defaultConfig, d(100), 'long');
      // First call triggers
      partial.check({ high: '103.5', low: '101', close: '103' });

      // Second call: even higher profit → still none (already fired)
      const result = partial.check({ high: '110', low: '105', close: '109' });
      expect(result.type).toBe('none');
      expect(partial.hasFired()).toBe(true);
    });
  });

  describe('short positions', () => {
    it('returns none when candle low does not reach profit target', () => {
      // entry=100, profitTargetPct=0.03 → target=97 for short
      // Candle low=97.5 → not enough
      const partial = new PartialPositionExit(defaultConfig, d(100), 'short');
      const result = partial.check({ high: '101', low: '97.5', close: '98' });
      expect(result.type).toBe('none');
    });

    it('returns partial_exit when candle low reaches profit target for short', () => {
      // entry=100, profitTargetPct=0.03 → target=97
      // Candle low=96.5 → breached
      const partial = new PartialPositionExit(defaultConfig, d(100), 'short');
      const result = partial.check({ high: '100', low: '96.5', close: '97' });
      expect(result.type).toBe('partial_exit');
      expect(result.fillPrice.toNumber()).toBe(97); // exact target
      expect(result.newStopPrice?.toNumber()).toBe(100); // breakeven for short
    });
  });

  describe('closeFraction', () => {
    it('uses configured closeFraction in the returned fraction', () => {
      const config = { ...defaultConfig, closeFraction: 0.5 };
      const partial = new PartialPositionExit(config, d(100), 'long');
      const result = partial.check({ high: '105', low: '99', close: '104' });
      expect(result.fraction.toNumber()).toBe(0.5);
    });

    it('supports different closeFraction values', () => {
      const config = { ...defaultConfig, closeFraction: 0.25 };
      const partial = new PartialPositionExit(config, d(100), 'long');
      const result = partial.check({ high: '105', low: '99', close: '104' });
      expect(result.fraction.toNumber()).toBe(0.25);
    });
  });

  describe('markFired', () => {
    it('prevents subsequent check() from triggering via markFired()', () => {
      const partial = new PartialPositionExit(defaultConfig, d(100), 'long');
      expect(partial.hasFired()).toBe(false);

      // Manually mark as fired (ExitLogicManager calls this)
      partial.markFired();
      expect(partial.hasFired()).toBe(true);

      // check() should now return none
      const result = partial.check({ high: '110', low: '99', close: '109' });
      expect(result.type).toBe('none');
    });
  });
});
