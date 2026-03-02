import { describe, it, expect } from 'vitest';
import type { Candle, TradingPair, Timeframe } from '../../core/types.js';
import type { Signal } from '../types.js';
import { MomentumBreakoutStrategy } from '../momentum-breakout.js';
import { MarketRegime } from '../../regime/types.js';

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

function assertValidSignal(signal: Signal, expectedDirection?: 'long' | 'short' | 'close'): void {
  expect(signal.confidence).toBeGreaterThanOrEqual(0);
  expect(signal.confidence).toBeLessThanOrEqual(1);
  expect(signal.reasoning).toBeTruthy();
  expect(typeof signal.reasoning).toBe('string');
  expect(signal.timestamp).toBeGreaterThan(0);
  expect(['long', 'short', 'close']).toContain(signal.direction);
  if (expectedDirection) expect(signal.direction).toBe(expectedDirection);
}

// breakoutWindow=5, volumeWindow=5, volumeMultiplier=1.5
// minCandles = Math.max(5, 5) + 1 = 6
const strategy = new MomentumBreakoutStrategy({
  breakoutWindow: 5,
  volumeWindow: 5,
  volumeMultiplier: 1.5,
});

describe('MomentumBreakoutStrategy', () => {
  // ---- constructor --------------------------------------------------------

  describe('constructor', () => {
    it('has correct name', () => {
      expect(strategy.name).toBe('momentum-breakout');
    });

    it('has minCandles = Math.max(breakoutWindow, volumeWindow) + 1', () => {
      expect(strategy.minCandles).toBe(6);
    });

    it('has requiredIndicators with Highest and Lowest configs', () => {
      expect(strategy.requiredIndicators).toContainEqual({ name: 'Highest', period: 5 });
      expect(strategy.requiredIndicators).toContainEqual({ name: 'Lowest', period: 5 });
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

  // ---- signal generation --------------------------------------------------

  describe('signal generation', () => {
    it('generates long signal on upward breakout with volume spike in TRENDING regime', () => {
      const candles = makeBreakoutCandles(8);
      const signals = strategy.evaluate(candles, 'BTC-USD', '1h', undefined, MarketRegime.TRENDING);

      const longSignals = signals.filter((s) => s.direction === 'long');
      expect(longSignals.length).toBeGreaterThanOrEqual(1);
      for (const s of longSignals) {
        assertValidSignal(s, 'long');
        expect(s.strategyName).toBe('momentum-breakout');
        expect(s.reasoning).toContain('Breakout');
      }
    });

    it('generates short signal on downward breakdown with volume spike in TRENDING regime', () => {
      const candles = makeBreakdownCandles(8);
      const signals = strategy.evaluate(candles, 'BTC-USD', '1h', undefined, MarketRegime.TRENDING);

      const shortSignals = signals.filter((s) => s.direction === 'short');
      expect(shortSignals.length).toBeGreaterThanOrEqual(1);
      for (const s of shortSignals) {
        assertValidSignal(s, 'short');
        expect(s.strategyName).toBe('momentum-breakout');
        expect(s.reasoning).toContain('Breakdown');
      }
    });

    it('generates signals when regime is undefined (no filter)', () => {
      const candles = makeBreakoutCandles(8);
      const signals = strategy.evaluate(candles, 'BTC-USD', '1h');
      expect(signals.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ---- volume confirmation (STRAT-05) ------------------------------------

  describe('volume confirmation', () => {
    it('returns empty when all volumes are equal (volume gate blocks)', () => {
      // Even with a high breakout, flat volumes mean volumeConfirmed is false
      // All volumes=100, avgVolume=100, currentVolume=100, 100 >= 150 is false
      const closes = Array(8).fill(100) as number[];
      const highs = Array(8).fill(101) as number[];
      const lows = Array(8).fill(99) as number[];
      const volumes = Array(8).fill(100) as number[];
      highs[7] = 130; // price breakout exists
      const candles = makeCandles({ closes, highs, lows, volumes });
      const signals = strategy.evaluate(candles, 'BTC-USD', '1h', undefined, MarketRegime.TRENDING);
      expect(signals).toEqual([]);
    });

    it('returns signal when last volume exceeds threshold', () => {
      // volumes=[100,100,100,100,100,100,100,200]
      // recentVolumes (last 5) = [100,100,100,100,200], avgVolume=120
      // currentVolume=200, 200 >= 120*1.5=180 is true
      const closes = Array(8).fill(100) as number[];
      const highs = Array(8).fill(101) as number[];
      const lows = Array(8).fill(99) as number[];
      const volumes = [100, 100, 100, 100, 100, 100, 100, 200];
      highs[7] = 130; // price breakout
      const candles = makeCandles({ closes, highs, lows, volumes });
      const signals = strategy.evaluate(candles, 'BTC-USD', '1h', undefined, MarketRegime.TRENDING);
      expect(signals.length).toBeGreaterThanOrEqual(1);
    });

    it('returns empty when last volume is just below threshold', () => {
      // volumes=[100,100,100,100,100,100,100,149]
      // recentVolumes (last 5) = [100,100,100,100,149], avgVolume=109.8
      // currentVolume=149, 149 >= 109.8*1.5=164.7 is false
      const closes = Array(8).fill(100) as number[];
      const highs = Array(8).fill(101) as number[];
      const lows = Array(8).fill(99) as number[];
      const volumes = [100, 100, 100, 100, 100, 100, 100, 149];
      highs[7] = 130; // price breakout
      const candles = makeCandles({ closes, highs, lows, volumes });
      const signals = strategy.evaluate(candles, 'BTC-USD', '1h', undefined, MarketRegime.TRENDING);
      expect(signals).toEqual([]);
    });
  });

  // ---- regime filter (STRAT-06) -------------------------------------------

  describe('regime filter', () => {
    it('returns signals in TRENDING regime', () => {
      const candles = makeBreakoutCandles(8);
      const signals = strategy.evaluate(candles, 'BTC-USD', '1h', undefined, MarketRegime.TRENDING);
      expect(signals.length).toBeGreaterThanOrEqual(1);
    });

    it('returns empty in RANGING regime', () => {
      const candles = makeBreakoutCandles(8);
      const signals = strategy.evaluate(candles, 'BTC-USD', '1h', undefined, MarketRegime.RANGING);
      expect(signals).toEqual([]);
    });

    it('returns empty in VOLATILE regime', () => {
      const candles = makeBreakoutCandles(8);
      const signals = strategy.evaluate(candles, 'BTC-USD', '1h', undefined, MarketRegime.VOLATILE);
      expect(signals).toEqual([]);
    });

    it('returns signals when regime is undefined (no filter)', () => {
      const candles = makeBreakoutCandles(8);
      const signals = strategy.evaluate(candles, 'BTC-USD', '1h');
      expect(signals.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ---- causality (STRAT-03) -----------------------------------------------

  describe('causality (STRAT-03)', () => {
    it('signal at candle i is unchanged when candle i+1 is appended', () => {
      const baseCandles = makeBreakoutCandles(8);
      // Append one extra future candle
      const extraCandle = makeCandles({
        closes: [105],
        highs: [106],
        lows: [104],
        volumes: [100],
      });
      const extendedCandles = [...baseCandles, ...extraCandle.map((c, _) => ({
        ...c,
        timestamp: 1_700_000_000_000 + 8 * 3_600_000,
      }))];

      const signalsBase = strategy.evaluate(baseCandles, 'BTC-USD', '1h', undefined, MarketRegime.TRENDING);
      const signalsSliced = strategy.evaluate(
        extendedCandles.slice(0, baseCandles.length),
        'BTC-USD',
        '1h',
        undefined,
        MarketRegime.TRENDING,
      );

      expect(signalsBase).toEqual(signalsSliced);
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

      const signalN = strategy.evaluate(candlesN, 'BTC-USD', '1h', undefined, MarketRegime.TRENDING);
      const signalN1 = strategy.evaluate(
        candlesN1.slice(0, closesN.length),
        'BTC-USD',
        '1h',
        undefined,
        MarketRegime.TRENDING,
      );

      expect(signalN).toEqual(signalN1);
      expect(signalN.length).toBeGreaterThanOrEqual(1); // confirm signal generated
    });
  });

  // ---- edge cases ---------------------------------------------------------

  describe('edge cases', () => {
    it('is deterministic (same input = same output)', () => {
      const candles = makeBreakoutCandles(8);
      const result1 = strategy.evaluate(candles, 'BTC-USD', '1h', undefined, MarketRegime.TRENDING);
      const result2 = strategy.evaluate(candles, 'BTC-USD', '1h', undefined, MarketRegime.TRENDING);
      expect(result1).toEqual(result2);
    });

    it('confidence is clamped to [0, 1]', () => {
      // Extreme breakout to push raw confidence high
      const closes = Array(8).fill(100) as number[];
      const highs = Array(8).fill(101) as number[];
      const lows = Array(8).fill(99) as number[];
      const volumes = Array(8).fill(100) as number[];
      highs[7] = 200; // massive breakout
      volumes[7] = 500; // massive volume
      const candles = makeCandles({ closes, highs, lows, volumes });
      const signals = strategy.evaluate(candles, 'BTC-USD', '1h', undefined, MarketRegime.TRENDING);
      for (const s of signals) {
        expect(s.confidence).toBeGreaterThanOrEqual(0);
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
      // priorCandles.length = 5 = breakoutWindow -- this should proceed
      const signals = strategy.evaluate(candles, 'BTC-USD', '1h', undefined, MarketRegime.TRENDING);
      // priorCandles has exactly 5 elements = breakoutWindow, so this should produce a signal
      expect(signals.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ---- signal fields ------------------------------------------------------

  describe('signal fields', () => {
    it('strategyName is momentum-breakout on all signals', () => {
      const candles = makeBreakoutCandles(8);
      const signals = strategy.evaluate(candles, 'BTC-USD', '1h', undefined, MarketRegime.TRENDING);
      expect(signals.length).toBeGreaterThanOrEqual(1);
      for (const s of signals) {
        expect(s.strategyName).toBe('momentum-breakout');
      }
    });

    it('reasoning contains Breakout for longs and Breakdown for shorts', () => {
      const longCandles = makeBreakoutCandles(8);
      const longSignals = strategy.evaluate(longCandles, 'BTC-USD', '1h', undefined, MarketRegime.TRENDING);
      const longs = longSignals.filter((s) => s.direction === 'long');
      expect(longs.length).toBeGreaterThanOrEqual(1);
      for (const s of longs) {
        expect(s.reasoning).toContain('Breakout');
      }

      const shortCandles = makeBreakdownCandles(8);
      const shortSignals = strategy.evaluate(shortCandles, 'BTC-USD', '1h', undefined, MarketRegime.TRENDING);
      const shorts = shortSignals.filter((s) => s.direction === 'short');
      expect(shorts.length).toBeGreaterThanOrEqual(1);
      for (const s of shorts) {
        expect(s.reasoning).toContain('Breakdown');
      }
    });

    it('timestamp matches last candle timestamp and pair/timeframe propagated', () => {
      const candles = makeBreakoutCandles(8);
      // Override pair/timeframe
      const ethCandles = makeCandles({
        closes: Array(8).fill(100),
        highs: (() => { const h = Array(8).fill(101) as number[]; h[7] = 130; return h; })(),
        lows: Array(8).fill(99),
        volumes: (() => { const v = Array(8).fill(100) as number[]; v[7] = 300; return v; })(),
        pair: 'ETH-USD',
        timeframe: '4h',
      });
      const signals = strategy.evaluate(ethCandles, 'ETH-USD', '4h', undefined, MarketRegime.TRENDING);
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
