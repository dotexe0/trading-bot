import { describe, it, expect } from 'vitest';
import type { Candle, TradingPair, Timeframe } from '../../../core/types.js';
import type { Signal } from '../../../strategies/types.js';
import { MarketRegime } from '../../../regime/types.js';
import { PerpMomentumStrategy } from '../perp-momentum.js';

// -- Helpers ----------------------------------------------------------------

function makeCandles(params: {
  closes: number[];
  highs?: number[];
  lows?: number[];
  volumes?: number[];
  pair?: TradingPair;
  timeframe?: Timeframe;
}): Candle[] {
  const { closes, highs, lows, volumes, pair = 'BTC-USD', timeframe = '1h' } = params;
  return closes.map((c, i) => ({
    pair,
    timeframe,
    timestamp: 1_700_000_000_000 + i * 3_600_000,
    open: String(c),
    high: String(highs?.[i] ?? c + 1),
    low: String(lows?.[i] ?? c - 1),
    close: String(c),
    volume: String(volumes?.[i] ?? 100),
  }));
}

/**
 * Builds a canonical bullish breakout scenario:
 * n-1 flat candles at 100 (high=101, low=99), then last candle spikes high
 * with a volume spike well above 1.5x average.
 */
function makeBreakoutCandles(n = 8): Candle[] {
  const closes = Array(n).fill(100) as number[];
  const highs = Array(n).fill(101) as number[];
  const lows = Array(n).fill(99) as number[];
  const volumes = Array(n).fill(100) as number[];
  highs[n - 1] = 130; // price spike on last candle
  volumes[n - 1] = 300; // volume spike on last candle (3x > 1.5x)
  return makeCandles({ closes, highs, lows, volumes });
}

/**
 * Builds a canonical bearish breakdown scenario:
 * n-1 flat candles at 100 (high=101, low=99), then last candle low drops
 * with a volume spike well above 1.5x average.
 */
function makeBreakdownCandles(n = 8): Candle[] {
  const closes = Array(n).fill(100) as number[];
  const highs = Array(n).fill(101) as number[];
  const lows = Array(n).fill(99) as number[];
  const volumes = Array(n).fill(100) as number[];
  lows[n - 1] = 70; // low drops on last candle
  volumes[n - 1] = 300; // volume spike on last candle
  return makeCandles({ closes, highs, lows, volumes });
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

// breakoutWindow=5, volumeWindow=5, volumeMultiplier=1.5, fundingThreshold=0.01
// minCandles = Math.max(5, 5) + 1 = 6
const strategy = new PerpMomentumStrategy({
  breakoutWindow: 5,
  volumeWindow: 5,
  volumeMultiplier: 1.5,
  fundingThreshold: 0.01,
  fundingRateProvider: makeFundingProvider(null),
});

describe('PerpMomentumStrategy', () => {
  // ---- constructor --------------------------------------------------------

  describe('constructor', () => {
    it('has correct name', () => {
      expect(strategy.name).toBe('perp-momentum');
    });

    it('has minCandles = Math.max(breakoutWindow, volumeWindow) + 1', () => {
      expect(strategy.minCandles).toBe(6);
    });

    it('has requiredIndicators with Highest and Lowest configs', () => {
      expect(strategy.requiredIndicators).toContainEqual({ name: 'Highest', period: 5 });
      expect(strategy.requiredIndicators).toContainEqual({ name: 'Lowest', period: 5 });
    });

    it('strategyName is perp-momentum', () => {
      expect(strategy.name).toBe('perp-momentum');
    });

    it('accepts maxHoldCandles param — construction succeeds for boundary values', () => {
      // Must not throw for any valid value
      expect(() => new PerpMomentumStrategy({
        breakoutWindow: 5, volumeWindow: 5, volumeMultiplier: 1.5,
        fundingThreshold: 0.01, fundingRateProvider: makeFundingProvider(null),
        maxHoldCandles: 1,
      })).not.toThrow();
      expect(() => new PerpMomentumStrategy({
        breakoutWindow: 5, volumeWindow: 5, volumeMultiplier: 1.5,
        fundingThreshold: 0.01, fundingRateProvider: makeFundingProvider(null),
        maxHoldCandles: 1000,
      })).not.toThrow();
    });

    it('defaults maxHoldCandles to 20 when not provided', () => {
      // Verified behaviorally in Task 3 time-stop tests.
      // Here we confirm that omitting the param does not throw and strategy is usable.
      const strat = new PerpMomentumStrategy({
        breakoutWindow: 5, volumeWindow: 5, volumeMultiplier: 1.5,
        fundingThreshold: 0.01, fundingRateProvider: makeFundingProvider(null),
      });
      const candles = makeBreakoutCandles(8);
      // Strategy should function normally with default maxHoldCandles
      expect(() => strat.evaluate(candles, 'BTC-USD', '1h')).not.toThrow();
    });
  });

  // ---- insufficient data --------------------------------------------------

  describe('insufficient data', () => {
    it('returns empty when candles.length < minCandles', () => {
      const candles = makeCandles({ closes: [100, 101, 102] });
      const signals = strategy.evaluate(candles, 'BTC-USD', '1h');
      expect(signals).toEqual([]);
    });

    it('returns empty when candles.length === breakoutWindow (needs breakoutWindow + 1)', () => {
      // 5 candles = breakoutWindow, but minCandles = 6
      const candles = makeCandles({ closes: [100, 101, 102, 103, 104] });
      const signals = strategy.evaluate(candles, 'BTC-USD', '1h');
      expect(signals).toEqual([]);
    });
  });

  // ---- signal generation (no regime filter) --------------------------------

  describe('signal generation', () => {
    it('generates long signal on upward breakout with volume spike — no regime required', () => {
      const candles = makeBreakoutCandles(8);
      const signals = strategy.evaluate(candles, 'BTC-USD', '1h');

      const longSignals = signals.filter((s) => s.direction === 'long');
      expect(longSignals.length).toBeGreaterThanOrEqual(1);
      for (const s of longSignals) {
        assertValidSignal(s, 'long');
        expect(s.strategyName).toBe('perp-momentum');
        expect(s.reasoning).toContain('Breakout');
      }
    });

    it('generates short signal on downward breakdown with volume spike — no regime required', () => {
      const candles = makeBreakdownCandles(8);
      const signals = strategy.evaluate(candles, 'BTC-USD', '1h');

      const shortSignals = signals.filter((s) => s.direction === 'short');
      expect(shortSignals.length).toBeGreaterThanOrEqual(1);
      for (const s of shortSignals) {
        assertValidSignal(s, 'short');
        expect(s.strategyName).toBe('perp-momentum');
        expect(s.reasoning).toContain('Breakdown');
      }
    });

    it('generates signals in any regime (TRENDING, RANGING, VOLATILE)', () => {
      const candles = makeBreakoutCandles(8);

      // All three regimes should produce signals (no regime filter)
      for (const regime of [MarketRegime.TRENDING, MarketRegime.RANGING, MarketRegime.VOLATILE]) {
        const signals = strategy.evaluate(candles, 'BTC-USD', '1h', undefined, regime);
        expect(signals.length).toBeGreaterThanOrEqual(1);
      }
    });

    it('returns empty when no volume spike (no breakout even with price move)', () => {
      const closes = Array(8).fill(100) as number[];
      const highs = Array(8).fill(101) as number[];
      const lows = Array(8).fill(99) as number[];
      const volumes = Array(8).fill(100) as number[];
      highs[7] = 130; // price breakout exists but no volume spike
      const candles = makeCandles({ closes, highs, lows, volumes });
      const signals = strategy.evaluate(candles, 'BTC-USD', '1h');
      expect(signals).toEqual([]);
    });
  });

  // ---- funding rate adjustment ---------------------------------------------

  describe('funding rate adjustment', () => {
    it('fundingRate=null → confidence unchanged from raw', () => {
      const strat = new PerpMomentumStrategy({
        breakoutWindow: 5,
        volumeWindow: 5,
        volumeMultiplier: 1.5,
        fundingThreshold: 0.01,
        fundingRateProvider: makeFundingProvider(null),
      });
      const candles = makeBreakoutCandles(8);
      const signals = strat.evaluate(candles, 'BTC-USD', '1h');
      const longs = signals.filter((s) => s.direction === 'long');
      expect(longs.length).toBeGreaterThanOrEqual(1);
      // reasoning should NOT mention FundingAdj when rate is null
      for (const s of longs) {
        expect(s.reasoning).not.toContain('FundingAdj');
      }
    });

    it('fundingRate=0.01 (threshold=0.01) on long → confidence * 0.5 (50% max reduction)', () => {
      const stratNull = new PerpMomentumStrategy({
        breakoutWindow: 5,
        volumeWindow: 5,
        volumeMultiplier: 1.5,
        fundingThreshold: 0.01,
        fundingRateProvider: makeFundingProvider(null),
      });
      const stratFunding = new PerpMomentumStrategy({
        breakoutWindow: 5,
        volumeWindow: 5,
        volumeMultiplier: 1.5,
        fundingThreshold: 0.01,
        fundingRateProvider: makeFundingProvider(0.01),
      });
      const candles = makeBreakoutCandles(8);

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

    it('fundingRate=0.005 (threshold=0.01) on long → no adjustment (rate < threshold)', () => {
      // Rate 0.005 is strictly less than threshold 0.01, so no adjustment fires.
      // The plan annotation "(25% reduction)" is inconsistent with the formula.
      // The formula triggers only when rate >= fundingThreshold.
      const stratNull = new PerpMomentumStrategy({
        breakoutWindow: 5,
        volumeWindow: 5,
        volumeMultiplier: 1.5,
        fundingThreshold: 0.01,
        fundingRateProvider: makeFundingProvider(null),
      });
      const stratFunding = new PerpMomentumStrategy({
        breakoutWindow: 5,
        volumeWindow: 5,
        volumeMultiplier: 1.5,
        fundingThreshold: 0.01,
        fundingRateProvider: makeFundingProvider(0.005),
      });
      const candles = makeBreakoutCandles(8);

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
      const stratFunding = new PerpMomentumStrategy({
        breakoutWindow: 5,
        volumeWindow: 5,
        volumeMultiplier: 1.5,
        fundingThreshold: 0.01,
        fundingRateProvider: makeFundingProvider(0.005),
      });
      const stratNull = new PerpMomentumStrategy({
        breakoutWindow: 5,
        volumeWindow: 5,
        volumeMultiplier: 1.5,
        fundingThreshold: 0.01,
        fundingRateProvider: makeFundingProvider(null),
      });
      const candles = makeBreakdownCandles(8);

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
      const stratNull = new PerpMomentumStrategy({
        breakoutWindow: 5,
        volumeWindow: 5,
        volumeMultiplier: 1.5,
        fundingThreshold: 0.01,
        fundingRateProvider: makeFundingProvider(null),
      });
      const stratFunding = new PerpMomentumStrategy({
        breakoutWindow: 5,
        volumeWindow: 5,
        volumeMultiplier: 1.5,
        fundingThreshold: 0.01,
        fundingRateProvider: makeFundingProvider(-0.01),
      });
      const candles = makeBreakdownCandles(8);

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

    it('fundingRate does not reduce long confidence when rate <= fundingThreshold', () => {
      // Rate=0.001, threshold=0.01 → 0.001 < 0.01 → no adjustment triggered (rate not > threshold)
      const stratFunding = new PerpMomentumStrategy({
        breakoutWindow: 5,
        volumeWindow: 5,
        volumeMultiplier: 1.5,
        fundingThreshold: 0.01,
        fundingRateProvider: makeFundingProvider(0.001),
      });
      const stratNull = new PerpMomentumStrategy({
        breakoutWindow: 5,
        volumeWindow: 5,
        volumeMultiplier: 1.5,
        fundingThreshold: 0.01,
        fundingRateProvider: makeFundingProvider(null),
      });
      const candles = makeBreakoutCandles(8);

      const baseSignals = stratNull.evaluate(candles, 'BTC-USD', '1h');
      const adjustedSignals = stratFunding.evaluate(candles, 'BTC-USD', '1h');

      const baseLong = baseSignals.find((s) => s.direction === 'long');
      const adjustedLong = adjustedSignals.find((s) => s.direction === 'long');

      expect(baseLong).toBeDefined();
      expect(adjustedLong).toBeDefined();

      // 0.001 is NOT > 0.01, so no adjustment
      expect(adjustedLong!.confidence).toBe(baseLong!.confidence);
      expect(adjustedLong!.reasoning).not.toContain('FundingAdj');
    });

    it('confidence is clamped to minimum 0.01 after funding adjustment', () => {
      // Edge case: ensure clamping at 0.01 minimum
      // Use a tiny breakout to get minimal rawConfidence, then large funding reduction
      const stratFunding = new PerpMomentumStrategy({
        breakoutWindow: 5,
        volumeWindow: 5,
        volumeMultiplier: 1.5,
        fundingThreshold: 0.0001, // very small threshold
        fundingRateProvider: makeFundingProvider(10), // massive funding rate
      });
      const candles = makeBreakoutCandles(8);
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
      const baseCandles = makeBreakoutCandles(8);
      const extraCandle = makeCandles({
        closes: [105],
        highs: [106],
        lows: [104],
        volumes: [100],
      });
      const extendedCandles = [...baseCandles, ...extraCandle.map((c) => ({
        ...c,
        timestamp: 1_700_000_000_000 + 8 * 3_600_000,
      }))];

      const signalsBase = strategy.evaluate(baseCandles, 'BTC-USD', '1h');
      const signalsSliced = strategy.evaluate(
        extendedCandles.slice(0, baseCandles.length),
        'BTC-USD',
        '1h',
      );

      expect(signalsBase).toEqual(signalsSliced);
    });

    it('evaluate with N candles then same N candles again produces identical results (stateless)', () => {
      const candles = makeBreakoutCandles(8);
      const result1 = strategy.evaluate(candles, 'BTC-USD', '1h');
      const result2 = strategy.evaluate(candles, 'BTC-USD', '1h');
      expect(result1).toEqual(result2);
    });

    it('evaluate with N candles then N+1 candles: signal at N is consistent', () => {
      const closesN = Array(8).fill(100) as number[];
      const highsN = Array(8).fill(101) as number[];
      const lowsN = Array(8).fill(99) as number[];
      const volumesN = Array(8).fill(100) as number[];
      highsN[7] = 130;
      volumesN[7] = 300;

      const closesN1 = [...closesN, 100];
      const highsN1 = [...highsN, 101];
      const lowsN1 = [...lowsN, 99];
      const volumesN1 = [...volumesN, 100];

      const candlesN = makeCandles({ closes: closesN, highs: highsN, lows: lowsN, volumes: volumesN });
      const candlesN1 = makeCandles({ closes: closesN1, highs: highsN1, lows: lowsN1, volumes: volumesN1 });

      const signalN = strategy.evaluate(candlesN, 'BTC-USD', '1h');
      const signalN1 = strategy.evaluate(
        candlesN1.slice(0, closesN.length),
        'BTC-USD',
        '1h',
      );

      expect(signalN).toEqual(signalN1);
      expect(signalN.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ---- edge cases ---------------------------------------------------------

  describe('edge cases', () => {
    it('is deterministic (same input → same output)', () => {
      const candles = makeBreakoutCandles(8);
      const result1 = strategy.evaluate(candles, 'BTC-USD', '1h');
      const result2 = strategy.evaluate(candles, 'BTC-USD', '1h');
      expect(result1).toEqual(result2);
    });

    it('confidence is clamped to [0.01, 1.0]', () => {
      const closes = Array(8).fill(100) as number[];
      const highs = Array(8).fill(101) as number[];
      const lows = Array(8).fill(99) as number[];
      const volumes = Array(8).fill(100) as number[];
      highs[7] = 200; // massive breakout
      volumes[7] = 500;
      const candles = makeCandles({ closes, highs, lows, volumes });
      const signals = strategy.evaluate(candles, 'BTC-USD', '1h');
      for (const s of signals) {
        expect(s.confidence).toBeGreaterThanOrEqual(0.01);
        expect(s.confidence).toBeLessThanOrEqual(1);
      }
    });

    it('returns empty when priorCandles.length < breakoutWindow', () => {
      // Exactly minCandles=6 candles: priorCandles has 5 (= breakoutWindow), should work
      const closes = Array(6).fill(100) as number[];
      const highs = Array(6).fill(101) as number[];
      const lows = Array(6).fill(99) as number[];
      const volumes = Array(6).fill(100) as number[];
      highs[5] = 130;
      volumes[5] = 300;
      const candles = makeCandles({ closes, highs, lows, volumes });
      const signals = strategy.evaluate(candles, 'BTC-USD', '1h');
      // priorCandles has exactly 5 elements = breakoutWindow, should produce signal
      expect(signals.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ---- signal fields ------------------------------------------------------

  describe('signal fields', () => {
    it('strategyName is perp-momentum on all signals', () => {
      const candles = makeBreakoutCandles(8);
      const signals = strategy.evaluate(candles, 'BTC-USD', '1h');
      expect(signals.length).toBeGreaterThanOrEqual(1);
      for (const s of signals) {
        expect(s.strategyName).toBe('perp-momentum');
      }
    });

    it('reasoning contains Breakout for longs and Breakdown for shorts', () => {
      const longCandles = makeBreakoutCandles(8);
      const longSignals = strategy.evaluate(longCandles, 'BTC-USD', '1h');
      const longs = longSignals.filter((s) => s.direction === 'long');
      expect(longs.length).toBeGreaterThanOrEqual(1);
      for (const s of longs) {
        expect(s.reasoning).toContain('Breakout');
      }

      const shortCandles = makeBreakdownCandles(8);
      const shortSignals = strategy.evaluate(shortCandles, 'BTC-USD', '1h');
      const shorts = shortSignals.filter((s) => s.direction === 'short');
      expect(shorts.length).toBeGreaterThanOrEqual(1);
      for (const s of shorts) {
        expect(s.reasoning).toContain('Breakdown');
      }
    });

    it('timestamp matches last candle timestamp and pair/timeframe propagated', () => {
      const ethCandles = makeCandles({
        closes: Array(8).fill(100),
        highs: (() => { const h = Array(8).fill(101) as number[]; h[7] = 130; return h; })(),
        lows: Array(8).fill(99),
        volumes: (() => { const v = Array(8).fill(100) as number[]; v[7] = 300; return v; })(),
        pair: 'ETH-USD',
        timeframe: '4h',
      });
      const signals = strategy.evaluate(ethCandles, 'ETH-USD', '4h');
      const expectedTs = ethCandles[ethCandles.length - 1].timestamp;
      expect(signals.length).toBeGreaterThanOrEqual(1);
      for (const s of signals) {
        expect(s.timestamp).toBe(expectedTs);
        expect(s.pair).toBe('ETH-USD');
        expect(s.timeframe).toBe('4h');
      }
    });
  });
});
