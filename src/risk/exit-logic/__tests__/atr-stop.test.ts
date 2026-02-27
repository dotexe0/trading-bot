/**
 * AtrDynamicStop tests -- TDD RED phase.
 *
 * Tests EXIT-04: ATR-based dynamic stop that computes a fixed stop at
 * position open and triggers on candle breach.
 */

import { describe, it, expect } from 'vitest';
import { AtrDynamicStop } from '../atr-stop.js';
import { d } from '../../../core/decimal.js';

describe('AtrDynamicStop', () => {
  const defaultConfig = { enabled: true, atrPeriod: 14, atrMultiple: 2.0 };

  describe('long positions', () => {
    it('returns none when candle low stays above the ATR stop', () => {
      // entry=10000, ATR=100, multiple=2.0 => stop=10000-200=9800
      const stop = new AtrDynamicStop(defaultConfig, d(10000), 'long', d(100));
      const result = stop.check({ low: '9900', high: '10100', close: '10050' });
      expect(result.type).toBe('none');
    });

    it('returns full_exit when candle low breaches the ATR stop', () => {
      // entry=10000, ATR=100, multiple=2.0 => stop=9800
      // candle low=9799 breaches stop
      const stop = new AtrDynamicStop(defaultConfig, d(10000), 'long', d(100));
      const result = stop.check({ low: '9799', high: '10100', close: '9850' });
      expect(result.type).toBe('full_exit');
      expect(result.fillPrice.toNumber()).toBe(9800);
      expect(result.fraction.toNumber()).toBe(1);
      expect(result.reason).toBe('atr_stop');
    });

    it('triggers on exact boundary (candle low === stopPrice)', () => {
      // entry=10000, ATR=100, multiple=2.0 => stop=9800
      // candle low=9800 exactly equals stop => triggered (lte)
      const stop = new AtrDynamicStop(defaultConfig, d(10000), 'long', d(100));
      const result = stop.check({ low: '9800', high: '10100', close: '9900' });
      expect(result.type).toBe('full_exit');
      expect(result.fillPrice.toNumber()).toBe(9800);
    });
  });

  describe('short positions', () => {
    it('returns none when candle high stays below the ATR stop', () => {
      // entry=10000, ATR=100, multiple=2.0 => stop=10000+200=10200
      const stop = new AtrDynamicStop(defaultConfig, d(10000), 'short', d(100));
      const result = stop.check({ low: '9800', high: '10100', close: '10050' });
      expect(result.type).toBe('none');
    });

    it('returns full_exit when candle high breaches the ATR stop', () => {
      // entry=10000, ATR=100, multiple=2.0 => stop=10200
      // candle high=10201 breaches stop
      const stop = new AtrDynamicStop(defaultConfig, d(10000), 'short', d(100));
      const result = stop.check({ low: '9800', high: '10201', close: '10100' });
      expect(result.type).toBe('full_exit');
      expect(result.fillPrice.toNumber()).toBe(10200);
      expect(result.fraction.toNumber()).toBe(1);
      expect(result.reason).toBe('atr_stop');
    });
  });

  describe('null ATR fallback', () => {
    it('falls back to percentage-based stop when ATR is null', () => {
      // entry=10000, null ATR, multiple=2.0
      // fallback: stop = entry - (atrMultiple * 0.01 * entry)
      //         = 10000 - (2.0 * 0.01 * 10000) = 10000 - 200 = 9800
      const stop = new AtrDynamicStop(defaultConfig, d(10000), 'long', null);
      expect(stop.getStopPrice().toNumber()).toBe(9800);

      // Should trigger on breach
      const result = stop.check({ low: '9799', high: '10000', close: '9850' });
      expect(result.type).toBe('full_exit');
      expect(result.fillPrice.toNumber()).toBe(9800);
    });

    it('falls back to percentage-based stop for short when ATR is null', () => {
      // entry=10000, null ATR, multiple=2.0
      // fallback: stop = entry + (atrMultiple * 0.01 * entry)
      //         = 10000 + 200 = 10200
      const stop = new AtrDynamicStop(defaultConfig, d(10000), 'short', null);
      expect(stop.getStopPrice().toNumber()).toBe(10200);
    });
  });

  describe('getStopPrice', () => {
    it('returns the calculated stop price for long', () => {
      // entry=10000, ATR=100, multiple=2.0 => stop=9800
      const stop = new AtrDynamicStop(defaultConfig, d(10000), 'long', d(100));
      expect(stop.getStopPrice().toNumber()).toBe(9800);
    });

    it('returns the calculated stop price for short', () => {
      // entry=10000, ATR=100, multiple=2.0 => stop=10200
      const stop = new AtrDynamicStop(defaultConfig, d(10000), 'short', d(100));
      expect(stop.getStopPrice().toNumber()).toBe(10200);
    });
  });
});
