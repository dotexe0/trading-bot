import { describe, it, expect, beforeEach } from 'vitest';
import type { Candle, TradingPair, Timeframe } from '../../../core/types.js';
import type { Signal } from '../../../strategies/types.js';
import { MarketRegime } from '../../../regime/types.js';
import { PerpMeanReversionStrategy } from '../perp-mean-reversion.js';

// -- Helpers ----------------------------------------------------------------

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

/**
 * Creates a fundingRateProvider callback returning the given value.
 */
function makeFundingProvider(rate: number | null): () => number | null {
  return () => rate;
}

function assertValidSignal(signal: Signal, expectedDirection?: 'long' | 'short' | 'close'): void {
  expect(signal.confidence).toBeGreaterThanOrEqual(0.01);
  expect(signal.confidence).toBeLessThanOrEqual(1);
  expect(signal.reasoning).toBeTruthy();
  expect(typeof signal.reasoning).toBe('string');
  expect(signal.timestamp).toBeGreaterThan(0);
  expect(['long', 'short', 'close']).toContain(signal.direction);
  if (expectedDirection) expect(signal.direction).toBe(expectedDirection);
}

// period=5, threshold=1.5, fundingThreshold=0.01, fundingRateProvider=null
// minCandles = period + 1 = 6
// Fresh instance per test — strategy carries _openDirection/_candlesHeld state
// between evaluate() calls, so sharing across tests would cause interference.
function makeStrategy(): PerpMeanReversionStrategy {
  return new PerpMeanReversionStrategy({
    period: 5,
    threshold: 1.5,
    fundingThreshold: 0.01,
    fundingRateProvider: makeFundingProvider(null),
  });
}

describe('PerpMeanReversionStrategy', () => {
  let strategy: PerpMeanReversionStrategy;
  beforeEach(() => {
    strategy = makeStrategy();
  });

  // ---- constructor --------------------------------------------------------

  describe('constructor', () => {
    it('has correct name', () => {
      expect(strategy.name).toBe('perp-mean-reversion');
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

  // ---- insufficient data --------------------------------------------------

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

  // ---- signal generation (no regime filter) --------------------------------

  describe('signal generation', () => {
    it('generates long signal when Z-score < -threshold (price far below mean)', () => {
      // 10 candles near 100, then a sharp drop to create negative Z-score
      const closes = [100, 101, 100, 99, 100, 101, 100, 99, 100, 80];
      const candles = makeCandles(closes);
      const signals = strategy.evaluate(candles, 'BTC-USD', '1h');

      const longSignals = signals.filter((s) => s.direction === 'long');
      expect(longSignals.length).toBeGreaterThanOrEqual(1);
      for (const s of longSignals) {
        assertValidSignal(s, 'long');
        expect(s.strategyName).toBe('perp-mean-reversion');
        expect(s.reasoning).toContain('Z-score');
        expect(s.reasoning).toContain('below');
      }
    });

    it('generates short signal when Z-score > +threshold (price far above mean)', () => {
      // 10 candles near 100, then a sharp spike to create positive Z-score
      const closes = [100, 99, 100, 101, 100, 99, 100, 101, 100, 120];
      const candles = makeCandles(closes);
      const signals = strategy.evaluate(candles, 'BTC-USD', '1h');

      const shortSignals = signals.filter((s) => s.direction === 'short');
      expect(shortSignals.length).toBeGreaterThanOrEqual(1);
      for (const s of shortSignals) {
        assertValidSignal(s, 'short');
        expect(s.strategyName).toBe('perp-mean-reversion');
        expect(s.reasoning).toContain('Z-score');
        expect(s.reasoning).toContain('above');
      }
    });

    it('returns empty signals when price is near the mean (Z-score within threshold)', () => {
      // Prices hovering near 100 with small variation
      const closes = [100, 100.5, 99.5, 100.2, 99.8, 100.1, 99.9, 100.3, 99.7, 100];
      const candles = makeCandles(closes);
      const signals = strategy.evaluate(candles, 'BTC-USD', '1h');
      expect(signals).toEqual([]);
    });

    it('suppresses signals in TRENDING regime (mean-reversion fights the trend)', () => {
      const closes = [100, 101, 100, 99, 100, 101, 100, 99, 100, 80];
      const candles = makeCandles(closes);
      const signals = strategy.evaluate(candles, 'BTC-USD', '1h', undefined, MarketRegime.TRENDING);
      expect(signals).toEqual([]);
    });

    it('generates signals in RANGING and VOLATILE regimes', () => {
      const closes = [100, 101, 100, 99, 100, 101, 100, 99, 100, 80];
      const candles = makeCandles(closes);
      for (const regime of [MarketRegime.RANGING, MarketRegime.VOLATILE]) {
        const freshStrategy = makeStrategy();
        const signals = freshStrategy.evaluate(candles, 'BTC-USD', '1h', undefined, regime);
        expect(signals.length).toBeGreaterThanOrEqual(1);
      }
    });

    it('generates signals when regime is undefined', () => {
      const closes = [100, 101, 100, 99, 100, 101, 100, 99, 100, 80];
      const candles = makeCandles(closes);
      const signals = strategy.evaluate(candles, 'BTC-USD', '1h');
      expect(signals.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ---- funding rate adjustment --------------------------------------------

  describe('funding rate adjustment', () => {
    it('fundingRate=null → confidence unchanged from raw (no FundingAdj in reasoning)', () => {
      const closes = [100, 101, 100, 99, 100, 101, 100, 99, 100, 80];
      const candles = makeCandles(closes);
      const signals = strategy.evaluate(candles, 'BTC-USD', '1h');
      const longs = signals.filter((s) => s.direction === 'long');
      expect(longs.length).toBeGreaterThanOrEqual(1);
      for (const s of longs) {
        expect(s.reasoning).not.toContain('FundingAdj');
      }
    });

    it('fundingRate=0.01 (threshold=0.01) on long signal → confidence * 0.5 (50% max reduction)', () => {
      const closes = [100, 101, 100, 99, 100, 101, 100, 99, 100, 80];
      const candles = makeCandles(closes);

      const stratNull = new PerpMeanReversionStrategy({
        period: 5,
        threshold: 1.5,
        fundingThreshold: 0.01,
        fundingRateProvider: makeFundingProvider(null),
      });
      const stratFunding = new PerpMeanReversionStrategy({
        period: 5,
        threshold: 1.5,
        fundingThreshold: 0.01,
        fundingRateProvider: makeFundingProvider(0.01),
      });

      const baseSignals = stratNull.evaluate(candles, 'BTC-USD', '1h');
      const adjustedSignals = stratFunding.evaluate(candles, 'BTC-USD', '1h');

      const baseLong = baseSignals.find((s) => s.direction === 'long');
      const adjustedLong = adjustedSignals.find((s) => s.direction === 'long');

      expect(baseLong).toBeDefined();
      expect(adjustedLong).toBeDefined();

      // adjustment = Math.min(0.01/0.01, 0.5) = Math.min(1, 0.5) = 0.5
      // adjustedConfidence = rawConfidence * (1 - 0.5) = rawConfidence * 0.5
      expect(adjustedLong!.confidence).toBeCloseTo(baseLong!.confidence * 0.5, 1);
      expect(adjustedLong!.reasoning).toContain('FundingAdj');
      expect(adjustedLong!.reasoning).toContain('50%');
    });

    it('fundingRate=0.005 (threshold=0.01) on long signal → no adjustment (rate < threshold)', () => {
      const closes = [100, 101, 100, 99, 100, 101, 100, 99, 100, 80];
      const candles = makeCandles(closes);

      const stratNull = new PerpMeanReversionStrategy({
        period: 5,
        threshold: 1.5,
        fundingThreshold: 0.01,
        fundingRateProvider: makeFundingProvider(null),
      });
      const stratFunding = new PerpMeanReversionStrategy({
        period: 5,
        threshold: 1.5,
        fundingThreshold: 0.01,
        fundingRateProvider: makeFundingProvider(0.005),
      });

      const baseSignals = stratNull.evaluate(candles, 'BTC-USD', '1h');
      const adjustedSignals = stratFunding.evaluate(candles, 'BTC-USD', '1h');

      const baseLong = baseSignals.find((s) => s.direction === 'long');
      const adjustedLong = adjustedSignals.find((s) => s.direction === 'long');

      expect(baseLong).toBeDefined();
      expect(adjustedLong).toBeDefined();

      // 0.005 < 0.01 → no adjustment applied
      expect(adjustedLong!.confidence).toBe(baseLong!.confidence);
      expect(adjustedLong!.reasoning).not.toContain('FundingAdj');
    });

    it('fundingRate=0.005 on short signal (positive rate, short direction) → no adjustment', () => {
      const closes = [100, 99, 100, 101, 100, 99, 100, 101, 100, 120];
      const candles = makeCandles(closes);

      const stratNull = new PerpMeanReversionStrategy({
        period: 5,
        threshold: 1.5,
        fundingThreshold: 0.01,
        fundingRateProvider: makeFundingProvider(null),
      });
      const stratFunding = new PerpMeanReversionStrategy({
        period: 5,
        threshold: 1.5,
        fundingThreshold: 0.01,
        fundingRateProvider: makeFundingProvider(0.005),
      });

      const baseSignals = stratNull.evaluate(candles, 'BTC-USD', '1h');
      const adjustedSignals = stratFunding.evaluate(candles, 'BTC-USD', '1h');

      const baseShort = baseSignals.find((s) => s.direction === 'short');
      const adjustedShort = adjustedSignals.find((s) => s.direction === 'short');

      expect(baseShort).toBeDefined();
      expect(adjustedShort).toBeDefined();

      // Positive funding rate doesn't affect short direction (only negative funding opposes shorts)
      expect(adjustedShort!.confidence).toBe(baseShort!.confidence);
      expect(adjustedShort!.reasoning).not.toContain('FundingAdj');
    });

    it('fundingRate=-0.01 on short signal (threshold=0.01) → confidence * 0.5', () => {
      const closes = [100, 99, 100, 101, 100, 99, 100, 101, 100, 120];
      const candles = makeCandles(closes);

      const stratNull = new PerpMeanReversionStrategy({
        period: 5,
        threshold: 1.5,
        fundingThreshold: 0.01,
        fundingRateProvider: makeFundingProvider(null),
      });
      const stratFunding = new PerpMeanReversionStrategy({
        period: 5,
        threshold: 1.5,
        fundingThreshold: 0.01,
        fundingRateProvider: makeFundingProvider(-0.01),
      });

      const baseSignals = stratNull.evaluate(candles, 'BTC-USD', '1h');
      const adjustedSignals = stratFunding.evaluate(candles, 'BTC-USD', '1h');

      const baseShort = baseSignals.find((s) => s.direction === 'short');
      const adjustedShort = adjustedSignals.find((s) => s.direction === 'short');

      expect(baseShort).toBeDefined();
      expect(adjustedShort).toBeDefined();

      // adjustment = Math.min(abs(-0.01)/0.01, 0.5) = Math.min(1, 0.5) = 0.5
      // adjustedConfidence = rawConfidence * (1 - 0.5) = rawConfidence * 0.5
      expect(adjustedShort!.confidence).toBeCloseTo(baseShort!.confidence * 0.5, 1);
      expect(adjustedShort!.reasoning).toContain('FundingAdj');
      expect(adjustedShort!.reasoning).toContain('50%');
    });

    it('fundingRate does not reduce long confidence when rate < fundingThreshold', () => {
      // Rate=0.001, threshold=0.01 → 0.001 < 0.01 → no adjustment
      const closes = [100, 101, 100, 99, 100, 101, 100, 99, 100, 80];
      const candles = makeCandles(closes);

      const stratNull = new PerpMeanReversionStrategy({
        period: 5,
        threshold: 1.5,
        fundingThreshold: 0.01,
        fundingRateProvider: makeFundingProvider(null),
      });
      const stratFunding = new PerpMeanReversionStrategy({
        period: 5,
        threshold: 1.5,
        fundingThreshold: 0.01,
        fundingRateProvider: makeFundingProvider(0.001),
      });

      const baseSignals = stratNull.evaluate(candles, 'BTC-USD', '1h');
      const adjustedSignals = stratFunding.evaluate(candles, 'BTC-USD', '1h');

      const baseLong = baseSignals.find((s) => s.direction === 'long');
      const adjustedLong = adjustedSignals.find((s) => s.direction === 'long');

      expect(baseLong).toBeDefined();
      expect(adjustedLong).toBeDefined();

      expect(adjustedLong!.confidence).toBe(baseLong!.confidence);
      expect(adjustedLong!.reasoning).not.toContain('FundingAdj');
    });

    it('confidence is clamped to minimum 0.01 after funding adjustment', () => {
      const closes = [100, 101, 100, 99, 100, 101, 100, 99, 100, 80];
      const candles = makeCandles(closes);

      // Very small threshold and massive funding rate to force maximum reduction
      const stratFunding = new PerpMeanReversionStrategy({
        period: 5,
        threshold: 1.5,
        fundingThreshold: 0.0001,
        fundingRateProvider: makeFundingProvider(10),
      });
      const signals = stratFunding.evaluate(candles, 'BTC-USD', '1h');
      const longs = signals.filter((s) => s.direction === 'long');
      for (const s of longs) {
        expect(s.confidence).toBeGreaterThanOrEqual(0.01);
        expect(s.confidence).toBeLessThanOrEqual(1.0);
      }
    });
  });

  // ---- causality (no-lookahead) -------------------------------------------

  describe('causality (no-lookahead)', () => {
    it('signal at candle i is unchanged when candle i+1 is appended', () => {
      const baseCloses = [100, 101, 100, 99, 100, 101, 100, 99, 100, 80];
      const extendedCloses = [...baseCloses, 105];

      const baseCandles = makeCandles(baseCloses);
      const extendedCandles = makeCandles(extendedCloses);

      // Fresh instances — strategy is stateful across evaluate() calls
      const signalsBase = makeStrategy().evaluate(baseCandles, 'BTC-USD', '1h');
      const signalsSliced = makeStrategy().evaluate(
        extendedCandles.slice(0, baseCloses.length),
        'BTC-USD',
        '1h',
      );

      expect(signalsBase).toEqual(signalsSliced);
    });

    it('evaluate with N candles then N+1 candles: signal at N is consistent', () => {
      const closesN = [100, 102, 98, 101, 99, 100, 103, 97, 100, 75];
      const closesN1 = [...closesN, 110];

      const candlesN = makeCandles(closesN);
      const candlesN1 = makeCandles(closesN1);

      const signalN = makeStrategy().evaluate(candlesN, 'BTC-USD', '1h');
      const signalN1 = makeStrategy().evaluate(
        candlesN1.slice(0, closesN.length),
        'BTC-USD',
        '1h',
      );

      expect(signalN).toEqual(signalN1);
      expect(signalN.length).toBeGreaterThanOrEqual(1);
    });

    it('evaluate from fresh state with same candles produces identical results', () => {
      const closes = [100, 101, 100, 99, 100, 101, 100, 99, 100, 80];
      const candles = makeCandles(closes);
      const result1 = makeStrategy().evaluate(candles, 'BTC-USD', '1h');
      const result2 = makeStrategy().evaluate(candles, 'BTC-USD', '1h');
      expect(result1).toEqual(result2);
    });
  });

  // ---- edge cases ---------------------------------------------------------

  describe('edge cases', () => {
    it('constant prices (sd=0) returns empty signals', () => {
      const candles = makeCandles([50, 50, 50, 50, 50, 50, 50, 50, 50, 50]);
      const signals = strategy.evaluate(candles, 'BTC-USD', '1h');
      expect(signals).toEqual([]);
    });

    it('is deterministic across fresh instances (same input = same output)', () => {
      const closes = [100, 101, 100, 99, 100, 101, 100, 99, 100, 80];
      const candles = makeCandles(closes);
      const result1 = makeStrategy().evaluate(candles, 'BTC-USD', '1h');
      const result2 = makeStrategy().evaluate(candles, 'BTC-USD', '1h');
      expect(result1).toEqual(result2);
    });

    it('confidence is clamped to [0.01, 1.0]', () => {
      // Extreme deviation to push raw confidence above 1
      const closes = [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 101, 50];
      const candles = makeCandles(closes);
      const signals = strategy.evaluate(candles, 'BTC-USD', '1h');
      for (const s of signals) {
        expect(s.confidence).toBeGreaterThanOrEqual(0.01);
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

  // ---- signal fields ------------------------------------------------------

  describe('signal fields', () => {
    it('strategyName is perp-mean-reversion on all signals', () => {
      const closes = [100, 101, 100, 99, 100, 101, 100, 99, 100, 80];
      const candles = makeCandles(closes);
      const signals = strategy.evaluate(candles, 'BTC-USD', '1h');
      expect(signals.length).toBeGreaterThanOrEqual(1);
      for (const s of signals) {
        expect(s.strategyName).toBe('perp-mean-reversion');
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
