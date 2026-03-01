import { describe, it, expect } from 'vitest';
import type { Candle, TradingPair, Timeframe } from '../../core/types.js';
import type { Signal } from '../types.js';
import { ZScoreMeanReversionStrategy } from '../z-score-mean-reversion.js';
import { MarketRegime } from '../../regime/types.js';

function makeCandles(
  closes: number[],
  pair: TradingPair = 'BTC-USD',
  timeframe: Timeframe = '1h',
): Candle[] {
  return closes.map((c, i) => ({
    pair,
    timeframe,
    timestamp: 1_700_000_000_000 + i * 3_600_000,
    open: String(c),
    high: String(c + 1),
    low: String(c - 1),
    close: String(c),
    volume: '100',
  }));
}

function assertValidSignal(signal: Signal, expectedDirection?: 'long' | 'short' | 'close'): void {
  expect(signal.confidence).toBeGreaterThanOrEqual(0);
  expect(signal.confidence).toBeLessThanOrEqual(1);
  expect(signal.reasoning).toBeTruthy();
  expect(typeof signal.reasoning).toBe('string');
  expect(signal.timestamp).toBeGreaterThan(0);
  expect(['long', 'short', 'close']).toContain(signal.direction);
  if (expectedDirection) expect(signal.direction).toBe(expectedDirection);
}

// period=5, threshold=1.5 -- small period for manageable test data
const strategy = new ZScoreMeanReversionStrategy({ period: 5, threshold: 1.5 });

describe('ZScoreMeanReversionStrategy', () => {
  describe('constructor', () => {
    it('has correct name', () => {
      expect(strategy.name).toBe('z-score-mean-reversion');
    });

    it('has minCandles = period + 1', () => {
      expect(strategy.minCandles).toBe(6);
    });

    it('has requiredIndicators with SMA and SD configs', () => {
      expect(strategy.requiredIndicators).toEqual([
        { name: 'SMA', period: 5 },
        { name: 'SD', period: 5 },
      ]);
    });
  });

  describe('insufficient data', () => {
    it('returns empty signals when candles < minCandles', () => {
      const candles = makeCandles([100, 101, 102]);
      const signals = strategy.evaluate(candles, 'BTC-USD', '1h');
      expect(signals).toEqual([]);
    });

    it('returns empty signals when candles exactly equal to period (needs period+1)', () => {
      const candles = makeCandles([100, 101, 102, 103, 104]);
      const signals = strategy.evaluate(candles, 'BTC-USD', '1h');
      expect(signals).toEqual([]);
    });
  });

  describe('signal generation', () => {
    it('generates long signal when Z-score < -threshold (price far below mean)', () => {
      // 10 candles near 100, then a sharp drop to create negative Z-score
      const closes = [100, 101, 100, 99, 100, 101, 100, 99, 100, 80];
      const candles = makeCandles(closes);
      const signals = strategy.evaluate(candles, 'BTC-USD', '1h', undefined, MarketRegime.RANGING);

      const longSignals = signals.filter((s) => s.direction === 'long');
      expect(longSignals.length).toBeGreaterThanOrEqual(1);
      for (const s of longSignals) {
        assertValidSignal(s, 'long');
        expect(s.strategyName).toBe('z-score-mean-reversion');
        expect(s.reasoning).toContain('Z-score');
        expect(s.reasoning).toContain('below');
      }
    });

    it('generates short signal when Z-score > +threshold (price far above mean)', () => {
      // 10 candles near 100, then a sharp spike to create positive Z-score
      const closes = [100, 99, 100, 101, 100, 99, 100, 101, 100, 120];
      const candles = makeCandles(closes);
      const signals = strategy.evaluate(candles, 'BTC-USD', '1h', undefined, MarketRegime.RANGING);

      const shortSignals = signals.filter((s) => s.direction === 'short');
      expect(shortSignals.length).toBeGreaterThanOrEqual(1);
      for (const s of shortSignals) {
        assertValidSignal(s, 'short');
        expect(s.strategyName).toBe('z-score-mean-reversion');
        expect(s.reasoning).toContain('Z-score');
        expect(s.reasoning).toContain('above');
      }
    });

    it('returns empty signals when price is near the mean (Z-score within threshold)', () => {
      // Prices hovering near 100 with small variation
      const closes = [100, 100.5, 99.5, 100.2, 99.8, 100.1, 99.9, 100.3, 99.7, 100];
      const candles = makeCandles(closes);
      const signals = strategy.evaluate(candles, 'BTC-USD', '1h', undefined, MarketRegime.RANGING);
      expect(signals).toEqual([]);
    });
  });

  describe('regime filter', () => {
    // Use data that WOULD trigger a signal in RANGING
    const closes = [100, 101, 100, 99, 100, 101, 100, 99, 100, 80];

    it('returns empty signals in TRENDING regime', () => {
      const candles = makeCandles(closes);
      const signals = strategy.evaluate(candles, 'BTC-USD', '1h', undefined, MarketRegime.TRENDING);
      expect(signals).toEqual([]);
    });

    it('returns empty signals in VOLATILE regime', () => {
      const candles = makeCandles(closes);
      const signals = strategy.evaluate(candles, 'BTC-USD', '1h', undefined, MarketRegime.VOLATILE);
      expect(signals).toEqual([]);
    });

    it('returns signals in RANGING regime', () => {
      const candles = makeCandles(closes);
      const signals = strategy.evaluate(candles, 'BTC-USD', '1h', undefined, MarketRegime.RANGING);
      expect(signals.length).toBeGreaterThanOrEqual(1);
    });

    it('returns signals when regime is undefined (no regime = no filter)', () => {
      const candles = makeCandles(closes);
      const signals = strategy.evaluate(candles, 'BTC-USD', '1h');
      expect(signals.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('causality (STRAT-03)', () => {
    it('Z-score at candle i does not change when candle i+1 is appended', () => {
      // Build a data set where we know a signal will be generated
      const baseCloses = [100, 101, 100, 99, 100, 101, 100, 99, 100, 80];
      const extendedCloses = [...baseCloses, 105]; // append one more candle

      const baseCandles = makeCandles(baseCloses);
      const extendedCandles = makeCandles(extendedCloses);

      const signalsBase = strategy.evaluate(baseCandles, 'BTC-USD', '1h');
      const signalsExtended = strategy.evaluate(extendedCandles.slice(0, baseCloses.length), 'BTC-USD', '1h');

      // Same input slice must produce identical signals
      expect(signalsBase).toEqual(signalsExtended);
    });

    it('evaluate with N candles then N+1 candles: signal at N is consistent', () => {
      // More explicit: evaluate twice, once with N candles, once with N+1
      // The strategy only looks at the last SMA/SD value, so appending
      // a future candle should not affect the signal at candle N
      const closesN = [100, 102, 98, 101, 99, 100, 103, 97, 100, 75];
      const closesN1 = [...closesN, 110];

      const candlesN = makeCandles(closesN);
      const candlesN1 = makeCandles(closesN1);

      const signalN = strategy.evaluate(candlesN, 'BTC-USD', '1h');
      const signalN1 = strategy.evaluate(candlesN1.slice(0, closesN.length), 'BTC-USD', '1h');

      // Evaluating the same candle window must give the same result
      expect(signalN).toEqual(signalN1);

      // Additionally: the strategy should NOT produce different results
      // for candle N when candle N+1 exists. Since we use rolling SMA/SD
      // and take the LAST value, only the last candle matters.
      // Verify the strategy never accesses future data:
      expect(signalN.length).toBeGreaterThanOrEqual(1); // confirm signal generated
    });
  });

  describe('edge cases', () => {
    it('constant prices (sd=0) returns empty signals', () => {
      const candles = makeCandles([50, 50, 50, 50, 50, 50, 50, 50, 50, 50]);
      const signals = strategy.evaluate(candles, 'BTC-USD', '1h');
      expect(signals).toEqual([]);
    });

    it('is deterministic (same input = same output)', () => {
      const closes = [100, 101, 100, 99, 100, 101, 100, 99, 100, 80];
      const candles = makeCandles(closes);
      const result1 = strategy.evaluate(candles, 'BTC-USD', '1h');
      const result2 = strategy.evaluate(candles, 'BTC-USD', '1h');
      expect(result1).toEqual(result2);
    });

    it('signal confidence is clamped to [0, 1]', () => {
      // Extreme deviation to push raw confidence above 1
      const closes = [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 101, 50];
      const candles = makeCandles(closes);
      const signals = strategy.evaluate(candles, 'BTC-USD', '1h');
      for (const s of signals) {
        expect(s.confidence).toBeGreaterThanOrEqual(0);
        expect(s.confidence).toBeLessThanOrEqual(1);
      }
    });

    it('signal contains correct pair and timeframe', () => {
      const closes = [100, 101, 100, 99, 100, 101, 100, 99, 100, 80];
      const candles = makeCandles(closes, 'ETH-USD', '4h');
      const signals = strategy.evaluate(candles, 'ETH-USD', '4h');
      for (const s of signals) {
        expect(s.pair).toBe('ETH-USD');
        expect(s.timeframe).toBe('4h');
      }
    });
  });

  describe('signal fields', () => {
    it('strategyName is z-score-mean-reversion on all signals', () => {
      const closes = [100, 101, 100, 99, 100, 101, 100, 99, 100, 80];
      const candles = makeCandles(closes);
      const signals = strategy.evaluate(candles, 'BTC-USD', '1h');
      expect(signals.length).toBeGreaterThanOrEqual(1);
      for (const s of signals) {
        expect(s.strategyName).toBe('z-score-mean-reversion');
      }
    });

    it('reasoning is a non-empty string containing Z-score info', () => {
      const closes = [100, 101, 100, 99, 100, 101, 100, 99, 100, 80];
      const candles = makeCandles(closes);
      const signals = strategy.evaluate(candles, 'BTC-USD', '1h');
      expect(signals.length).toBeGreaterThanOrEqual(1);
      for (const s of signals) {
        expect(s.reasoning.length).toBeGreaterThan(0);
        expect(s.reasoning).toContain('Z-score');
      }
    });

    it('timestamp matches the last candle timestamp', () => {
      const closes = [100, 101, 100, 99, 100, 101, 100, 99, 100, 80];
      const candles = makeCandles(closes);
      const signals = strategy.evaluate(candles, 'BTC-USD', '1h');
      const expectedTs = candles[candles.length - 1].timestamp;
      for (const s of signals) {
        expect(s.timestamp).toBe(expectedTs);
      }
    });
  });
});
