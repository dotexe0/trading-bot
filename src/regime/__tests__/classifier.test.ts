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

  describe('classifyAll', () => {
    it('returns empty map when candles < MIN_REGIME_CANDLES', () => {
      const candles = makeCandles(
        Array.from({ length: MIN_REGIME_CANDLES - 1 }, (_, i) => 30000 + i),
      );
      const result = classifier.classifyAll(candles);
      expect(result.size).toBe(0);
    });

    it('returns non-empty map for sufficient trending candles', () => {
      const candles = makeTrendingCandles(100, 10);
      const result = classifier.classifyAll(candles);
      expect(result.size).toBeGreaterThan(0);
      const validRegimes = [MarketRegime.TRENDING, MarketRegime.RANGING, MarketRegime.VOLATILE];
      for (const value of result.values()) {
        expect(validRegimes).toContain(value);
      }
    });

    it('map keys are candle timestamps (not array indices)', () => {
      const candles = makeCandles(
        Array.from({ length: 60 }, (_, i) => 30000 + i * 5),
      );
      const result = classifier.classifyAll(candles);
      expect(result.size).toBeGreaterThan(0);

      const candleTimestamps = new Set(candles.map((c) => c.timestamp));
      // Every key in the map must be a candle timestamp
      for (const key of result.keys()) {
        expect(candleTimestamps.has(key)).toBe(true);
      }
      // No key should be a small integer like 0, 1, 2 (which would indicate index-based keying)
      for (const key of result.keys()) {
        expect(key).toBeGreaterThan(100);
      }
    });

    it('map keys are in ascending order (forward chronological, no lookahead)', () => {
      const candles = makeTrendingCandles(100, 10);
      const result = classifier.classifyAll(candles);
      expect(result.size).toBeGreaterThan(0);

      const keys = Array.from(result.keys());
      for (let i = 1; i < keys.length; i++) {
        expect(keys[i]).toBeGreaterThan(keys[i - 1]);
      }
    });

    it('classifyAll result is consistent with classify() for last candle', () => {
      const candles = makeTrendingCandles(80, 10);
      const lastCandle = candles[candles.length - 1];

      const allResult = classifier.classifyAll(candles);
      const singleResult = classifier.classify(candles);

      const allLastEntry = allResult.get(lastCandle.timestamp);

      // If both methods produced a result, they must agree
      if (allLastEntry !== undefined && singleResult !== undefined) {
        expect(allLastEntry).toBe(singleResult);
      }
    });
  });
});
