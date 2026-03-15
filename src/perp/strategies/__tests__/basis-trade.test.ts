import { describe, it, expect } from 'vitest';
import type { Candle, TradingPair, Timeframe } from '../../../core/types.js';
import { BasisTradeStrategy } from '../basis-trade.js';

// period=5, minCandles=6
const PERIOD = 5;
const THRESHOLD = 1.5;

function makeCandles(n = 10): Candle[] {
  return Array.from({ length: n }, (_, i) => ({
    pair: 'BTC-USD' as TradingPair,
    timeframe: '1h' as Timeframe,
    timestamp: 1_700_000_000_000 + i * 3_600_000,
    open: '50000', high: '50100', low: '49900', close: '50000', volume: '100',
  }));
}

function makeStrategy(basisSamples: number[] | null, period = PERIOD, threshold = THRESHOLD) {
  return new BasisTradeStrategy({
    period,
    threshold,
    basisProvider: () => basisSamples,
  });
}

const candles = makeCandles(10);

describe('BasisTradeStrategy', () => {
  describe('constructor', () => {
    it('has correct name', () => {
      expect(makeStrategy([]).name).toBe('basis-trade');
    });

    it('minCandles = period + 1', () => {
      const s = makeStrategy([], 5, 1.5);
      expect(s.minCandles).toBe(6);
    });
  });

  describe('provider guards (null returns)', () => {
    it('returns [] when basisProvider returns null', () => {
      const s = makeStrategy(null);
      expect(s.evaluate(candles, 'BTC-USD', '1h')).toEqual([]);
    });

    it('returns [] when basisProvider returns fewer than period samples', () => {
      // period=5, only 3 samples
      const s = makeStrategy([0.1, 0.2, 0.3]);
      expect(s.evaluate(candles, 'BTC-USD', '1h')).toEqual([]);
    });

    it('returns [] when basisProvider returns empty array', () => {
      const s = makeStrategy([]);
      expect(s.evaluate(candles, 'BTC-USD', '1h')).toEqual([]);
    });
  });

  describe('SD = 0 guard (FCM reality: indexPrice === markPrice)', () => {
    it('returns [] when all basis values are zero', () => {
      // Simulates current FCM where indexPrice === markPrice → basis always 0
      const s = makeStrategy([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
      expect(s.evaluate(candles, 'BTC-USD', '1h')).toEqual([]);
    });

    it('returns [] when all basis values are identical non-zero', () => {
      // Constant series → SD=0 → Z-score undefined
      const s = makeStrategy([5, 5, 5, 5, 5, 5, 5, 5, 5, 5]);
      expect(s.evaluate(candles, 'BTC-USD', '1h')).toEqual([]);
    });
  });

  describe('signal generation', () => {
    it('returns [] when Z-score is within threshold', () => {
      // Near-zero Z-score: last value equals mean
      const s = makeStrategy([10, 10, 10, 10, 9, 11, 10, 10, 10, 10]);
      const signals = s.evaluate(candles, 'BTC-USD', '1h');
      // Z-score would be close to 0 — within threshold
      expect(signals.length).toBe(0);
    });

    it('generates LONG signal when last basis is far below mean', () => {
      // High-variance series with last value very low
      // mean ≈ 10, last = -20 → large negative Z-score
      const samples = [10, 10, 10, 10, 10, 10, 10, 10, 10, -20];
      const s = makeStrategy(samples);
      const signals = s.evaluate(candles, 'BTC-USD', '1h');
      expect(signals.length).toBe(1);
      expect(signals[0].direction).toBe('long');
      expect(signals[0].confidence).toBeGreaterThanOrEqual(0.01);
      expect(signals[0].confidence).toBeLessThanOrEqual(1);
      expect(signals[0].reasoning).toContain('BasisTrade');
    });

    it('generates SHORT signal when last basis is far above mean', () => {
      // mean ≈ 10, last = 40 → large positive Z-score
      const samples = [10, 10, 10, 10, 10, 10, 10, 10, 10, 40];
      const s = makeStrategy(samples);
      const signals = s.evaluate(candles, 'BTC-USD', '1h');
      expect(signals.length).toBe(1);
      expect(signals[0].direction).toBe('short');
    });

    it('signal timestamp matches last candle timestamp', () => {
      const samples = [10, 10, 10, 10, 10, 10, 10, 10, 10, -20];
      const s = makeStrategy(samples);
      const [sig] = s.evaluate(candles, 'BTC-USD', '1h');
      expect(sig.timestamp).toBe(candles[candles.length - 1].timestamp);
    });
  });

  describe('candle length guard', () => {
    it('returns [] when candles.length < minCandles', () => {
      // minCandles=6, only 3 candles provided
      const s = makeStrategy([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      const tooFew = makeCandles(3);
      expect(s.evaluate(tooFew, 'BTC-USD', '1h')).toEqual([]);
    });
  });
});
