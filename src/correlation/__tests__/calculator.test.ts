/**
 * CorrelationCalculator TDD tests.
 *
 * Covers:
 * - Null on insufficient data (fewer than windowCandles+1 aligned candles)
 * - Valid CorrelationSnapshot on well-formed aligned data
 * - Scalar formula: 1 - max(0, r)
 * - Degenerate input guards (constant price series, misaligned timestamps)
 * - Timestamp alignment: only matching timestamps from both arrays used
 * - daysToCandles utility
 */

import { describe, it, expect } from 'vitest';
import { CorrelationCalculator } from '../calculator.js';
import { daysToCandles } from '../types.js';
import type { Candle } from '../../core/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build minimal Candle objects from timestamp + close arrays.
 * All other OHLCV fields are set to the close price for simplicity.
 */
function makeCandles(timestamps: number[], closes: number[]): Candle[] {
  return timestamps.map((timestamp, i) => ({
    pair: 'BTC-USD' as const,
    timeframe: '1h' as const,
    timestamp,
    open: String(closes[i]),
    high: String(closes[i]),
    low: String(closes[i]),
    close: String(closes[i]),
    volume: '0',
  }));
}

/**
 * Generate N+1 candles with a linear price trend to ensure non-zero variance.
 * Starting at basePrice and incrementing by 1 each candle.
 */
function makeTrendingCandles(count: number, basePrice = 50000): Candle[] {
  const timestamps = Array.from({ length: count }, (_, i) => i * 3600_000);
  const closes = Array.from({ length: count }, (_, i) => basePrice + i);
  return makeCandles(timestamps, closes);
}

/**
 * Generate N+1 candles with perfectly correlated prices (BTC and ETH move
 * in sync). Returns [btcCandles, ethCandles].
 */
function makeCorrelatedCandles(
  count: number,
): [btcCandles: Candle[], ethCandles: Candle[]] {
  const timestamps = Array.from({ length: count }, (_, i) => i * 3600_000);
  const btcCloses = Array.from({ length: count }, (_, i) => 50000 + i * 100);
  const ethCloses = Array.from({ length: count }, (_, i) => 3000 + i * 6);

  const btcCandles: Candle[] = makeCandles(timestamps, btcCloses);
  const ethCandles: Candle[] = timestamps.map((timestamp, i) => ({
    pair: 'ETH-USD' as const,
    timeframe: '1h' as const,
    timestamp,
    open: String(ethCloses[i]),
    high: String(ethCloses[i]),
    low: String(ethCloses[i]),
    close: String(ethCloses[i]),
    volume: '0',
  }));

  return [btcCandles, ethCandles];
}

// ---------------------------------------------------------------------------
// CorrelationCalculator tests
// ---------------------------------------------------------------------------

describe('CorrelationCalculator', () => {
  const WINDOW = 5; // small window for test speed
  let calc: CorrelationCalculator;

  // Re-create for each test
  beforeEach(() => {
    calc = new CorrelationCalculator(WINDOW);
  });

  // -- Null cases (insufficient data) ---------------------------------------

  describe('returns null when data is insufficient', () => {
    it('returns null for empty arrays', () => {
      expect(calc.compute([], [])).toBeNull();
    });

    it('returns null when btcCandles is empty', () => {
      const [, ethCandles] = makeCorrelatedCandles(WINDOW + 1);
      expect(calc.compute([], ethCandles)).toBeNull();
    });

    it('returns null when ethCandles is empty', () => {
      const [btcCandles] = makeCorrelatedCandles(WINDOW + 1);
      expect(calc.compute(btcCandles, [])).toBeNull();
    });

    it('returns null when exactly windowCandles candles exist (not windowCandles+1)', () => {
      // WINDOW candles aligned but need WINDOW+1 for log-returns
      const [btcCandles, ethCandles] = makeCorrelatedCandles(WINDOW);
      expect(calc.compute(btcCandles, ethCandles)).toBeNull();
    });

    it('returns null when aligned candle count < windowCandles+1 due to timestamp mismatch', () => {
      // btc=[T0,T1,T3], eth=[T0,T2,T3] — intersect=[T0,T3]=2 candles; windowCandles=5 → null
      const T0 = 0;
      const T1 = 3600_000;
      const T2 = 7200_000;
      const T3 = 10800_000;

      const btcCandles = makeCandles([T0, T1, T3], [50000, 50100, 50200]);
      const ethCandles = makeCandles([T0, T2, T3], [3000, 3010, 3020]);

      expect(calc.compute(btcCandles, ethCandles)).toBeNull();
    });
  });

  // -- Valid snapshot cases -------------------------------------------------

  describe('returns CorrelationSnapshot when data is sufficient', () => {
    it('returns a non-null snapshot with correct shape for well-formed aligned data', () => {
      const [btcCandles, ethCandles] = makeCorrelatedCandles(WINDOW + 1);
      const result = calc.compute(btcCandles, ethCandles);

      expect(result).not.toBeNull();
      expect(result).toMatchObject({
        correlation: expect.any(Number),
        windowSize: expect.any(Number),
        timestamp: expect.any(Number),
      });
    });

    it('windowSize equals number of log-returns computed (aligned candles - 1)', () => {
      const [btcCandles, ethCandles] = makeCorrelatedCandles(WINDOW + 1);
      const result = calc.compute(btcCandles, ethCandles);

      // WINDOW+1 aligned candles produce WINDOW log-returns
      expect(result!.windowSize).toBe(WINDOW);
    });

    it('timestamp equals the last aligned candle timestamp', () => {
      const [btcCandles, ethCandles] = makeCorrelatedCandles(WINDOW + 1);
      const lastTimestamp = btcCandles[btcCandles.length - 1].timestamp;
      const result = calc.compute(btcCandles, ethCandles);

      expect(result!.timestamp).toBe(lastTimestamp);
    });

    it('correlation is between -1 and 1 (valid Pearson range)', () => {
      const [btcCandles, ethCandles] = makeCorrelatedCandles(WINDOW + 1);
      const result = calc.compute(btcCandles, ethCandles);

      expect(result!.correlation).toBeGreaterThanOrEqual(-1);
      expect(result!.correlation).toBeLessThanOrEqual(1);
    });

    it('nearly perfectly correlated series produces correlation close to 1', () => {
      const [btcCandles, ethCandles] = makeCorrelatedCandles(WINDOW + 2);
      const result = calc.compute(btcCandles, ethCandles);

      // Both price series are linear trending — returns should correlate strongly
      expect(result!.correlation).toBeGreaterThan(0.9);
    });
  });

  // -- Degenerate input guards ----------------------------------------------

  describe('degenerate input guards (returns null, does not throw)', () => {
    it('returns null (not throws) for constant BTC price series', () => {
      const timestamps = Array.from({ length: WINDOW + 1 }, (_, i) => i * 3600_000);
      const btcConst = makeCandles(timestamps, Array(WINDOW + 1).fill(50000));
      const ethTrend = makeTrendingCandles(WINDOW + 1, 3000);
      // ETH timestamps must match BTC timestamps for alignment
      const ethAligned = timestamps.map((ts, i) => ({ ...ethTrend[i], timestamp: ts }));

      expect(() => calc.compute(btcConst, ethAligned)).not.toThrow();
      expect(calc.compute(btcConst, ethAligned)).toBeNull();
    });

    it('returns null (not throws) for constant ETH price series', () => {
      const timestamps = Array.from({ length: WINDOW + 1 }, (_, i) => i * 3600_000);
      const btcTrend = makeTrendingCandles(WINDOW + 1, 50000);
      const ethConst = makeCandles(timestamps, Array(WINDOW + 1).fill(3000));
      const btcAligned = timestamps.map((ts, i) => ({ ...btcTrend[i], timestamp: ts }));

      expect(() => calc.compute(btcAligned, ethConst)).not.toThrow();
      expect(calc.compute(btcAligned, ethConst)).toBeNull();
    });

    it('returns null (not throws) for fully misaligned timestamps', () => {
      // No overlap in timestamps at all
      const btcCandles = makeCandles([1000, 2000, 3000, 4000, 5000, 6000], [50000, 50100, 50200, 50300, 50400, 50500]);
      const ethCandles = makeCandles([7000, 8000, 9000, 10000, 11000, 12000], [3000, 3010, 3020, 3030, 3040, 3050]);

      expect(() => calc.compute(btcCandles, ethCandles)).not.toThrow();
      expect(calc.compute(btcCandles, ethCandles)).toBeNull();
    });

    it('uses only intersecting timestamps (partial alignment)', () => {
      // 6 total BTC timestamps, 6 total ETH timestamps, only 6 shared → can be sufficient
      const sharedTs = Array.from({ length: WINDOW + 1 }, (_, i) => i * 3600_000);
      const btcExtra = [...sharedTs, sharedTs[sharedTs.length - 1] + 3600_000];
      const ethExtra = [...sharedTs, sharedTs[sharedTs.length - 1] + 7200_000];

      // Only sharedTs are aligned; that is exactly WINDOW+1 candles → should succeed
      const btcCloses = btcExtra.map((_, i) => 50000 + i * 100);
      const ethCloses = ethExtra.map((_, i) => 3000 + i * 6);

      const btcCandles = makeCandles(btcExtra, btcCloses);
      const ethCandles: Candle[] = ethExtra.map((ts, i) => ({
        pair: 'ETH-USD' as const,
        timeframe: '1h' as const,
        timestamp: ts,
        open: String(ethCloses[i]),
        high: String(ethCloses[i]),
        low: String(ethCloses[i]),
        close: String(ethCloses[i]),
        volume: '0',
      }));

      const result = calc.compute(btcCandles, ethCandles);
      expect(result).not.toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Scalar formula tests
// ---------------------------------------------------------------------------

describe('CorrelationCalculator.scalar()', () => {
  let calc: CorrelationCalculator;

  beforeEach(() => {
    calc = new CorrelationCalculator(5);
  });

  it('r=0.0 → scalar=1.0 (uncorrelated, no discount)', () => {
    expect(calc.scalar(0.0)).toBeCloseTo(1.0);
  });

  it('r=0.5 → scalar=0.5 (moderate correlation, 50% discount)', () => {
    expect(calc.scalar(0.5)).toBeCloseTo(0.5);
  });

  it('r=1.0 → scalar=0.0 (perfect correlation, full discount)', () => {
    expect(calc.scalar(1.0)).toBeCloseTo(0.0);
  });

  it('r=-0.5 → scalar=1.0 (negative correlation, no discount)', () => {
    expect(calc.scalar(-0.5)).toBeCloseTo(1.0);
  });

  it('r=-1.0 → scalar=1.0 (perfect negative correlation, no discount)', () => {
    expect(calc.scalar(-1.0)).toBeCloseTo(1.0);
  });

  it('r=0.8 → scalar=0.2', () => {
    expect(calc.scalar(0.8)).toBeCloseTo(0.2);
  });

  it('scalar never goes below 0 (no amplification)', () => {
    expect(calc.scalar(0.0)).toBeGreaterThanOrEqual(0);
    expect(calc.scalar(0.5)).toBeGreaterThanOrEqual(0);
    expect(calc.scalar(1.0)).toBeGreaterThanOrEqual(0);
    expect(calc.scalar(-0.5)).toBeGreaterThanOrEqual(0);
  });

  it('scalar never exceeds 1.0', () => {
    expect(calc.scalar(-0.5)).toBeLessThanOrEqual(1.0);
    expect(calc.scalar(-1.0)).toBeLessThanOrEqual(1.0);
    expect(calc.scalar(0.0)).toBeLessThanOrEqual(1.0);
    expect(calc.scalar(0.5)).toBeLessThanOrEqual(1.0);
    expect(calc.scalar(1.0)).toBeLessThanOrEqual(1.0);
  });
});

// ---------------------------------------------------------------------------
// daysToCandles utility tests
// ---------------------------------------------------------------------------

describe('daysToCandles()', () => {
  it('daysToCandles(30, "1h") = 720', () => {
    expect(daysToCandles(30, '1h')).toBe(720);
  });

  it('daysToCandles(30, "4h") = 180', () => {
    expect(daysToCandles(30, '4h')).toBe(180);
  });

  it('daysToCandles(30, "1D") = 30', () => {
    expect(daysToCandles(30, '1D')).toBe(30);
  });

  it('daysToCandles(1, "1m") = 1440', () => {
    expect(daysToCandles(1, '1m')).toBe(1440);
  });

  it('daysToCandles(1, "5m") = 288', () => {
    expect(daysToCandles(1, '5m')).toBe(288);
  });

  it('daysToCandles(1, "15m") = 96', () => {
    expect(daysToCandles(1, '15m')).toBe(96);
  });

  it('daysToCandles(7, "1h") = 168', () => {
    expect(daysToCandles(7, '1h')).toBe(168);
  });

  it('unknown timeframe defaults to 60-minute candles (1h assumption)', () => {
    // @ts-expect-error - testing unknown timeframe fallback
    expect(daysToCandles(30, 'unknown')).toBe(720);
  });
});
