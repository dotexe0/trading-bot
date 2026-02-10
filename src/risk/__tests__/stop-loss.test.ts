/**
 * Tests for StopLossTracker -- fixed and trailing stop-loss modes.
 */

import { describe, it, expect } from 'vitest';
import { d } from '../../core/decimal.js';
import { StopLossTracker } from '../stop-loss.js';
import type { StopLossConfig } from '../types.js';

const fixedConfig: StopLossConfig = { type: 'fixed', percentage: d(0.05) };
const trailingConfig: StopLossConfig = { type: 'trailing', percentage: d(0.05) };

/** Helper to create a candle object */
function candle(low: string, high: string, close: string) {
  return { low, high, close };
}

describe('StopLossTracker', () => {
  describe('fixed long', () => {
    it('sets stop at entry * (1 - pct)', () => {
      const tracker = new StopLossTracker(fixedConfig, d(100), 'long');
      // 100 * (1 - 0.05) = 95
      expect(tracker.getStopPrice().toNumber()).toBe(95);
    });

    it('does not trigger when low is above stop', () => {
      const tracker = new StopLossTracker(fixedConfig, d(100), 'long');
      const result = tracker.check(candle('96', '102', '101'));
      expect(result.triggered).toBe(false);
      expect(result.stopPrice.toNumber()).toBe(95);
    });

    it('triggers when low is below stop', () => {
      const tracker = new StopLossTracker(fixedConfig, d(100), 'long');
      const result = tracker.check(candle('94', '99', '95'));
      expect(result.triggered).toBe(true);
    });
  });

  describe('fixed short', () => {
    it('sets stop at entry * (1 + pct)', () => {
      const tracker = new StopLossTracker(fixedConfig, d(100), 'short');
      // 100 * (1 + 0.05) = 105
      expect(tracker.getStopPrice().toNumber()).toBe(105);
    });

    it('does not trigger when high is below stop', () => {
      const tracker = new StopLossTracker(fixedConfig, d(100), 'short');
      const result = tracker.check(candle('96', '104', '98'));
      expect(result.triggered).toBe(false);
    });

    it('triggers when high exceeds stop', () => {
      const tracker = new StopLossTracker(fixedConfig, d(100), 'short');
      const result = tracker.check(candle('99', '106', '105'));
      expect(result.triggered).toBe(true);
    });
  });

  describe('trailing long', () => {
    it('ratchets stop upward as price rises', () => {
      const tracker = new StopLossTracker(trailingConfig, d(100), 'long');
      expect(tracker.getStopPrice().toNumber()).toBe(95);

      // Price rises to 110 -> new stop = 110 * 0.95 = 104.5
      // Low must be above 104.5 for no trigger
      const r1 = tracker.check(candle('105', '110', '108'));
      expect(r1.triggered).toBe(false);
      expect(r1.stopPrice.toNumber()).toBe(104.5);

      // Low at 105 -> above 104.5, not triggered
      const r2 = tracker.check(candle('105', '109', '107'));
      expect(r2.triggered).toBe(false);

      // Low at 104 -> below 104.5, triggered
      const r3 = tracker.check(candle('104', '108', '106'));
      expect(r3.triggered).toBe(true);
    });

    it('never moves stop backward', () => {
      const tracker = new StopLossTracker(trailingConfig, d(100), 'long');

      // Price rises to 110 -> stop = 104.5
      tracker.check(candle('102', '110', '108'));
      expect(tracker.getStopPrice().toNumber()).toBe(104.5);

      // Price drops, high = 105 (below previous HWM of 110) -> stop stays
      tracker.check(candle('105', '105', '105'));
      expect(tracker.getStopPrice().toNumber()).toBe(104.5);
    });
  });

  describe('trailing short', () => {
    it('ratchets stop downward as price drops', () => {
      const tracker = new StopLossTracker(trailingConfig, d(100), 'short');
      // Initial stop = 100 * 1.05 = 105
      expect(tracker.getStopPrice().toNumber()).toBe(105);

      // Price drops to low=90 -> new HWM = 90, stop = 90 * 1.05 = 94.5
      // High must be below 94.5 for no trigger
      const r1 = tracker.check(candle('90', '94', '92'));
      expect(r1.triggered).toBe(false);
      expect(r1.stopPrice.toNumber()).toBe(94.5);

      // High at 94, low at 91 (above HWM 90, no update) -> stop stays 94.5, high 94 < 94.5, not triggered
      const r2 = tracker.check(candle('91', '94', '92'));
      expect(r2.triggered).toBe(false);
      expect(r2.stopPrice.toNumber()).toBe(94.5);

      // High at 95 -> above 94.5, triggered
      const r3 = tracker.check(candle('91', '95', '93'));
      expect(r3.triggered).toBe(true);
    });
  });

  describe('fixed stop never moves', () => {
    it('stop stays at original level regardless of price movement', () => {
      const tracker = new StopLossTracker(fixedConfig, d(100), 'long');
      expect(tracker.getStopPrice().toNumber()).toBe(95);

      // Price rises significantly
      tracker.check(candle('110', '150', '140'));
      expect(tracker.getStopPrice().toNumber()).toBe(95);

      tracker.check(candle('120', '200', '180'));
      expect(tracker.getStopPrice().toNumber()).toBe(95);
    });
  });

  describe('edge cases', () => {
    it('triggers when stop price exactly equals candle low (long)', () => {
      const tracker = new StopLossTracker(fixedConfig, d(100), 'long');
      // Stop is at 95. Low exactly at 95 -> should trigger (<=)
      const result = tracker.check(candle('95', '100', '98'));
      expect(result.triggered).toBe(true);
    });

    it('triggers when stop price exactly equals candle high (short)', () => {
      const tracker = new StopLossTracker(fixedConfig, d(100), 'short');
      // Stop is at 105. High exactly at 105 -> should trigger (>=)
      const result = tracker.check(candle('99', '105', '102'));
      expect(result.triggered).toBe(true);
    });
  });
});
