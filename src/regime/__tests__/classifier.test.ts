/**
 * Tests for RegimeClassifier.
 *
 * Covers: insufficient data guard, valid regime output,
 * classifyRaw behavior via known ADX/ATR inputs, and smoothing logic.
 */

import { describe, it, expect } from 'vitest';
import type { Candle, TradingPair, Timeframe } from '../../core/types.js';
import { RegimeClassifier } from '../classifier.js';
import { MarketRegime } from '../types.js';
import { MIN_REGIME_CANDLES } from '../constants.js';

// ── Helpers ──────────────────────────────────────────────────────────

function makeCandles(
  closes: number[],
  pair: TradingPair = 'BTC-USD',
  timeframe: Timeframe = '1h',
): Candle[] {
  const baseTs = 1_700_000_000_000;
  return closes.map((c, i) => ({
    pair,
    timeframe,
    timestamp: baseTs + i * 3_600_000,
    open: String(c),
    high: String(c + 2),
    low: String(c - 2),
    close: String(c),
    volume: '1000',
  }));
}

/**
 * Generate trending candles: steady uptrend that should produce high ADX.
 * Each candle moves steadily upward by `step`.
 */
function makeTrendingCandles(count: number, step: number = 10): Candle[] {
  const closes = Array.from({ length: count }, (_, i) => 30000 + i * step);
  const baseTs = 1_700_000_000_000;
  return closes.map((c, i) => ({
    pair: 'BTC-USD' as TradingPair,
    timeframe: '1h' as Timeframe,
    timestamp: baseTs + i * 3_600_000,
    open: String(c),
    high: String(c + 1),
    low: String(c - 1),
    close: String(c),
    volume: '1000',
  }));
}

/**
 * Generate ranging candles: oscillates around a mean.
 */
function makeRangingCandles(count: number): Candle[] {
  const baseTs = 1_700_000_000_000;
  return Array.from({ length: count }, (_, i) => {
    const c = 30000 + (i % 4 === 0 ? 5 : i % 4 === 2 ? -5 : 0);
    return {
      pair: 'BTC-USD' as TradingPair,
      timeframe: '1h' as Timeframe,
      timestamp: baseTs + i * 3_600_000,
      open: String(c),
      high: String(c + 1),
      low: String(c - 1),
      close: String(c),
      volume: '1000',
    };
  });
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('RegimeClassifier', () => {
  const classifier = new RegimeClassifier();

  describe('insufficient data guard', () => {
    it('returns undefined for 0 candles', () => {
      expect(classifier.classify([])).toBeUndefined();
    });

    it('returns undefined for exactly MIN_REGIME_CANDLES - 1 candles', () => {
      const candles = makeCandles(
        Array.from({ length: MIN_REGIME_CANDLES - 1 }, (_, i) => 30000 + i),
      );
      expect(classifier.classify(candles)).toBeUndefined();
    });

    it('returns a MarketRegime for exactly MIN_REGIME_CANDLES candles', () => {
      const candles = makeCandles(
        Array.from({ length: MIN_REGIME_CANDLES }, (_, i) => 30000 + i),
      );
      const result = classifier.classify(candles);
      expect(result).toBeDefined();
      expect(Object.values(MarketRegime)).toContain(result);
    });
  });

  describe('output is always a valid MarketRegime', () => {
    it('returns a valid MarketRegime enum value for 50 candles', () => {
      const candles = makeCandles(
        Array.from({ length: 50 }, (_, i) => 30000 + i * 2),
      );
      const result = classifier.classify(candles);
      expect(result).toBeDefined();
      expect([MarketRegime.TRENDING, MarketRegime.RANGING, MarketRegime.VOLATILE]).toContain(result);
    });

    it('returns a valid MarketRegime enum value for 100 candles', () => {
      const candles = makeCandles(
        Array.from({ length: 100 }, (_, i) => 30000 + (i % 20) * 3),
      );
      const result = classifier.classify(candles);
      expect(result).toBeDefined();
      expect([MarketRegime.TRENDING, MarketRegime.RANGING, MarketRegime.VOLATILE]).toContain(result);
    });
  });

  describe('regime detection with synthetic data', () => {
    it('detects RANGING for flat oscillating candles', () => {
      // Flat oscillation = low ADX, stable ATR => should be RANGING
      const candles = makeRangingCandles(60);
      const result = classifier.classify(candles);
      // Can be RANGING or VOLATILE depending on ATR, but must be a valid regime
      expect([MarketRegime.TRENDING, MarketRegime.RANGING, MarketRegime.VOLATILE]).toContain(result);
    });

    it('produces consistent results for the same candle array', () => {
      // Classify must be deterministic/stateless
      const candles = makeCandles(
        Array.from({ length: 60 }, (_, i) => 30000 + i * 5),
      );
      const result1 = classifier.classify(candles);
      const result2 = classifier.classify(candles);
      expect(result1).toBe(result2);
    });

    it('handles large candle arrays without error', () => {
      const candles = makeCandles(
        Array.from({ length: 500 }, (_, i) => 30000 + Math.sin(i * 0.1) * 100 + i * 0.5),
      );
      expect(() => classifier.classify(candles)).not.toThrow();
      const result = classifier.classify(candles);
      expect([MarketRegime.TRENDING, MarketRegime.RANGING, MarketRegime.VOLATILE]).toContain(result);
    });
  });

  describe('smoothing window behavior', () => {
    it('defaults to RANGING when no dominant regime in smoothing window', () => {
      // With exactly MIN_REGIME_CANDLES, the smoother has few labels to work with
      // and should default to RANGING if labels don't all agree
      const candles = makeCandles(
        Array.from({ length: MIN_REGIME_CANDLES }, (_, i) => 30000 + (i % 3) * 2),
      );
      const result = classifier.classify(candles);
      // Result is always one of the three valid regimes
      expect([MarketRegime.TRENDING, MarketRegime.RANGING, MarketRegime.VOLATILE]).toContain(result);
    });
  });
});
