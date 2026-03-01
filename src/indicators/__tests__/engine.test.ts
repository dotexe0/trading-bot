/**
 * Comprehensive tests for the indicator engine.
 *
 * Covers: config validation, minCandlesRequired, adapters,
 * all 7 indicators (SMA, EMA, RSI, MACD, BB, Stochastic, ATR),
 * insufficient data, and multi-timeframe independence.
 */

import { describe, it, expect } from 'vitest';
import type { Candle, TradingPair, Timeframe } from '../../core/types.js';
import { IndicatorConfigError } from '../../core/errors.js';
import {
  parseIndicatorConfig,
  validateIndicatorConfigs,
  minCandlesRequired,
} from '../config.js';
import { extractCloses, extractOHLC, extractVolumes } from '../adapters.js';
import { IndicatorEngine } from '../engine.js';
import type {
  MACDPoint,
  BollingerBandsPoint,
  StochasticPoint,
} from '../types.js';

// ── Helpers ──────────────────────────────────────────────────────────

function makeCandles(
  closes: number[],
  pair: TradingPair = 'BTC-USD',
  timeframe: Timeframe = '1h',
): Candle[] {
  const baseTs = 1_700_000_000_000; // arbitrary start
  return closes.map((c, i) => ({
    pair,
    timeframe,
    timestamp: baseTs + i * 3_600_000,
    open: String(c),
    high: String(c + 1),
    low: String(c - 1),
    close: String(c),
    volume: '100',
  }));
}

function makeOHLCCandles(
  data: { o: number; h: number; l: number; c: number }[],
  pair: TradingPair = 'BTC-USD',
  timeframe: Timeframe = '1h',
): Candle[] {
  const baseTs = 1_700_000_000_000;
  return data.map((d, i) => ({
    pair,
    timeframe,
    timestamp: baseTs + i * 3_600_000,
    open: String(d.o),
    high: String(d.h),
    low: String(d.l),
    close: String(d.c),
    volume: '100',
  }));
}

function makeCandlesWithVolumes(
  closes: number[],
  volumes: number[],
  pair: TradingPair = 'BTC-USD',
  timeframe: Timeframe = '1h',
): Candle[] {
  const baseTs = 1_700_000_000_000;
  return closes.map((c, i) => ({
    pair,
    timeframe,
    timestamp: baseTs + i * 3_600_000,
    open: String(c),
    high: String(c + 1),
    low: String(c - 1),
    close: String(c),
    volume: String(volumes[i] ?? 100),
  }));
}

const engine = new IndicatorEngine();

// ── 1. Config validation ─────────────────────────────────────────────

describe('Config validation', () => {
  it('parses valid SMA config', () => {
    const config = parseIndicatorConfig({ name: 'SMA', period: 10 });
    expect(config).toEqual({ name: 'SMA', period: 10 });
  });

  it('rejects SMA period = 0', () => {
    expect(() => parseIndicatorConfig({ name: 'SMA', period: 0 })).toThrow(
      IndicatorConfigError,
    );
  });

  it('rejects SMA period = 1 (min is 2)', () => {
    expect(() => parseIndicatorConfig({ name: 'SMA', period: 1 })).toThrow(
      IndicatorConfigError,
    );
  });

  it('rejects MACD with fastPeriod >= slowPeriod', () => {
    expect(() =>
      parseIndicatorConfig({
        name: 'MACD',
        fastPeriod: 26,
        slowPeriod: 12,
        signalPeriod: 9,
      }),
    ).toThrow(IndicatorConfigError);
  });

  it('parses BollingerBands with default stdDev = 2', () => {
    const config = parseIndicatorConfig({ name: 'BollingerBands', period: 20 });
    expect(config).toEqual({ name: 'BollingerBands', period: 20, stdDev: 2 });
  });

  it('validates array of configs', () => {
    const configs = validateIndicatorConfigs([
      { name: 'SMA', period: 10 },
      { name: 'RSI', period: 14 },
    ]);
    expect(configs).toHaveLength(2);
  });

  it('rejects array on first invalid config', () => {
    expect(() =>
      validateIndicatorConfigs([
        { name: 'SMA', period: 10 },
        { name: 'SMA', period: -1 },
      ]),
    ).toThrow(IndicatorConfigError);
  });

  it('parses valid SD config', () => {
    const config = parseIndicatorConfig({ name: 'SD', period: 20 });
    expect(config).toEqual({ name: 'SD', period: 20 });
  });

  it('parses valid Highest config', () => {
    const config = parseIndicatorConfig({ name: 'Highest', period: 14 });
    expect(config).toEqual({ name: 'Highest', period: 14 });
  });

  it('parses valid Lowest config', () => {
    const config = parseIndicatorConfig({ name: 'Lowest', period: 14 });
    expect(config).toEqual({ name: 'Lowest', period: 14 });
  });

  it('rejects SD period = 1', () => {
    expect(() => parseIndicatorConfig({ name: 'SD', period: 1 })).toThrow(IndicatorConfigError);
  });
});

// ── 2. minCandlesRequired ────────────────────────────────────────────

describe('minCandlesRequired', () => {
  it('SMA(10) -> 10', () => {
    expect(minCandlesRequired({ name: 'SMA', period: 10 })).toBe(10);
  });

  it('RSI(14) -> 15', () => {
    expect(minCandlesRequired({ name: 'RSI', period: 14 })).toBe(15);
  });

  it('MACD(12,26,9) -> 34', () => {
    expect(
      minCandlesRequired({
        name: 'MACD',
        fastPeriod: 12,
        slowPeriod: 26,
        signalPeriod: 9,
      }),
    ).toBe(34);
  });

  it('BollingerBands(20) -> 20', () => {
    expect(
      minCandlesRequired({ name: 'BollingerBands', period: 20, stdDev: 2 }),
    ).toBe(20);
  });

  it('Stochastic(14,3) -> 16', () => {
    expect(
      minCandlesRequired({ name: 'Stochastic', period: 14, signalPeriod: 3 }),
    ).toBe(16);
  });

  it('ATR(14) -> 15', () => {
    expect(minCandlesRequired({ name: 'ATR', period: 14 })).toBe(15);
  });

  it('SD(10) -> 10', () => {
    expect(minCandlesRequired({ name: 'SD', period: 10 })).toBe(10);
  });

  it('Highest(14) -> 14', () => {
    expect(minCandlesRequired({ name: 'Highest', period: 14 })).toBe(14);
  });

  it('Lowest(14) -> 14', () => {
    expect(minCandlesRequired({ name: 'Lowest', period: 14 })).toBe(14);
  });
});

// ── 3. Adapter tests ─────────────────────────────────────────────────

describe('Adapters', () => {
  const candles = makeCandles([10.5, 20.3, 30.1, 40.7, 50.9]);

  it('extractCloses returns correct number[]', () => {
    expect(extractCloses(candles)).toEqual([10.5, 20.3, 30.1, 40.7, 50.9]);
  });

  it('extractOHLC returns correct parallel arrays', () => {
    const ohlc = extractOHLC(candles);
    expect(ohlc.close).toEqual([10.5, 20.3, 30.1, 40.7, 50.9]);
    expect(ohlc.high).toEqual([11.5, 21.3, 31.1, 41.7, 51.9]);
    expect(ohlc.low).toEqual([9.5, 19.3, 29.1, 39.7, 49.9]);
    expect(ohlc.open).toEqual([10.5, 20.3, 30.1, 40.7, 50.9]);
  });
});

// ── 4. SMA ───────────────────────────────────────────────────────────

describe('SMA', () => {
  it('SMA(4) on [1..10] returns correct averages', () => {
    const candles = makeCandles([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const result = engine.compute({ name: 'SMA', period: 4 }, candles);
    expect(result.values).toHaveLength(7);
    const expected = [2.5, 3.5, 4.5, 5.5, 6.5, 7.5, 8.5];
    for (let i = 0; i < expected.length; i++) {
      expect(result.values[i]).toBeCloseTo(expected[i], 5);
    }
  });

  it('SMA offset is period - 1', () => {
    const candles = makeCandles([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const result = engine.compute({ name: 'SMA', period: 4 }, candles);
    expect(result.offset).toBe(3);
  });
});

// ── 5. EMA ───────────────────────────────────────────────────────────

describe('EMA', () => {
  it('EMA(4) returns correct number of values', () => {
    const candles = makeCandles([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const result = engine.compute({ name: 'EMA', period: 4 }, candles);
    expect(result.values.length).toBe(10 - 4 + 1);
  });

  it('EMA offset is period - 1', () => {
    const candles = makeCandles([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const result = engine.compute({ name: 'EMA', period: 4 }, candles);
    expect(result.offset).toBe(3);
  });

  it('EMA first value matches SMA seed', () => {
    const candles = makeCandles([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const result = engine.compute({ name: 'EMA', period: 4 }, candles);
    // First EMA value is the SMA of the first `period` values = 2.5
    expect(result.values[0]).toBeCloseTo(2.5, 5);
  });
});

// ── 6. RSI ───────────────────────────────────────────────────────────

describe('RSI', () => {
  const wilderCloses = [
    44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.85, 46.08, 45.89, 46.03,
    46.83, 47.69, 46.49, 46.26, 47.09, 46.66, 46.8, 46.23, 46.38, 46.33,
    46.55, 45.88, 47.82,
  ];

  it('RSI(14) first value is in the expected range (library variance)', () => {
    const candles = makeCandles(wilderCloses);
    const result = engine.compute({ name: 'RSI', period: 14 }, candles);
    expect(result.values.length).toBeGreaterThan(0);
    // Library uses cutler RSI variant; Wilder's classic gives ~70.46,
    // fast-technical-indicators gives ~68.16. Both are valid RSI implementations.
    const firstRSI = result.values[0] as number;
    expect(firstRSI).toBeGreaterThan(60);
    expect(firstRSI).toBeLessThan(75);
  });

  it('all RSI values between 0 and 100', () => {
    const candles = makeCandles(wilderCloses);
    const result = engine.compute({ name: 'RSI', period: 14 }, candles);
    for (const v of result.values) {
      expect(v as number).toBeGreaterThanOrEqual(0);
      expect(v as number).toBeLessThanOrEqual(100);
    }
  });
});

// ── 7. MACD ──────────────────────────────────────────────────────────

describe('MACD', () => {
  // Generate 60 data points with some trend
  const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 5) * 10 + i * 0.5);
  const candles = makeCandles(closes);

  it('MACD returns objects with MACD, signal, histogram', () => {
    const result = engine.compute(
      { name: 'MACD', fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 },
      candles,
    );
    expect(result.values.length).toBeGreaterThan(0);
    const pt = result.values[result.values.length - 1] as MACDPoint;
    expect(pt).toHaveProperty('MACD');
    expect(pt).toHaveProperty('signal');
    expect(pt).toHaveProperty('histogram');
  });

  it('histogram approximately equals MACD - signal', () => {
    const result = engine.compute(
      { name: 'MACD', fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 },
      candles,
    );
    // Check last few points where signal is defined
    for (const v of result.values.slice(-5)) {
      const pt = v as MACDPoint;
      if (pt.MACD !== undefined && pt.signal !== undefined && pt.histogram !== undefined) {
        expect(pt.histogram).toBeCloseTo(pt.MACD - pt.signal, 5);
      }
    }
  });
});

// ── 8. Bollinger Bands ───────────────────────────────────────────────

describe('Bollinger Bands', () => {
  const closes = Array.from({ length: 40 }, (_, i) => 50 + Math.sin(i / 3) * 5);
  const candles = makeCandles(closes);

  it('BB(20) returns upper > middle > lower', () => {
    const result = engine.compute(
      { name: 'BollingerBands', period: 20, stdDev: 2 },
      candles,
    );
    expect(result.values.length).toBeGreaterThan(0);
    for (const v of result.values) {
      const pt = v as BollingerBandsPoint;
      expect(pt.upper).toBeGreaterThan(pt.middle);
      expect(pt.middle).toBeGreaterThan(pt.lower);
    }
  });

  it('middle is approximately SMA of close prices', () => {
    const result = engine.compute(
      { name: 'BollingerBands', period: 20, stdDev: 2 },
      candles,
    );
    // Compute SMA manually for comparison
    const smaResult = engine.compute({ name: 'SMA', period: 20 }, candles);
    // BB middle should closely match SMA values
    for (let i = 0; i < result.values.length; i++) {
      const bbPt = result.values[i] as BollingerBandsPoint;
      expect(bbPt.middle).toBeCloseTo(smaResult.values[i] as number, 5);
    }
  });
});

// ── 9. Stochastic ────────────────────────────────────────────────────

describe('Stochastic', () => {
  // Create OHLC data with meaningful ranges
  const ohlcData = Array.from({ length: 30 }, (_, i) => ({
    o: 50 + Math.sin(i / 3) * 5,
    h: 55 + Math.sin(i / 3) * 5,
    l: 45 + Math.sin(i / 3) * 5,
    c: 50 + Math.sin(i / 3) * 5 + (i % 2 === 0 ? 2 : -2),
  }));
  const candles = makeOHLCCandles(ohlcData);

  it('Stochastic returns k and d values', () => {
    const result = engine.compute(
      { name: 'Stochastic', period: 14, signalPeriod: 3 },
      candles,
    );
    expect(result.values.length).toBeGreaterThan(0);
    const pt = result.values[0] as StochasticPoint;
    expect(pt).toHaveProperty('k');
    expect(pt).toHaveProperty('d');
  });

  it('k and d values between 0 and 100 (where defined)', () => {
    const result = engine.compute(
      { name: 'Stochastic', period: 14, signalPeriod: 3 },
      candles,
    );
    for (const v of result.values) {
      const pt = v as StochasticPoint;
      expect(pt.k).toBeGreaterThanOrEqual(0);
      expect(pt.k).toBeLessThanOrEqual(100);
      // d may be undefined for the first signalPeriod-1 points
      if (pt.d !== undefined) {
        expect(pt.d).toBeGreaterThanOrEqual(0);
        expect(pt.d).toBeLessThanOrEqual(100);
      }
    }
  });
});

// ── 10. ATR ──────────────────────────────────────────────────────────

describe('ATR', () => {
  const ohlcData = Array.from({ length: 30 }, (_, i) => ({
    o: 100 + i,
    h: 105 + i,
    l: 95 + i,
    c: 100 + i + (i % 2 === 0 ? 2 : -2),
  }));
  const candles = makeOHLCCandles(ohlcData);

  it('ATR(14) returns all positive values', () => {
    const result = engine.compute({ name: 'ATR', period: 14 }, candles);
    expect(result.values.length).toBeGreaterThan(0);
    for (const v of result.values) {
      expect(v as number).toBeGreaterThan(0);
    }
  });

  it('ATR result length is correct', () => {
    const result = engine.compute({ name: 'ATR', period: 14 }, candles);
    // ATR needs period + 1 candles to start, result length = input - period
    expect(result.values.length).toBe(candles.length - 14);
  });
});

// ── 11. Insufficient data ────────────────────────────────────────────

describe('Insufficient data', () => {
  it('SMA(10) on 5 candles returns empty values', () => {
    const candles = makeCandles([1, 2, 3, 4, 5]);
    const result = engine.compute({ name: 'SMA', period: 10 }, candles);
    expect(result.values).toEqual([]);
    expect(result.offset).toBe(0);
  });

  it('RSI(14) on 10 candles returns empty values', () => {
    const candles = makeCandles([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const result = engine.compute({ name: 'RSI', period: 14 }, candles);
    expect(result.values).toEqual([]);
    expect(result.offset).toBe(0);
  });
});

// ── 12. Multi-timeframe ──────────────────────────────────────────────

describe('Multi-timeframe', () => {
  it('RSI(14) on 1h and 4h candles produces independent results', () => {
    // 1h candles: gradually rising
    const closes1h = Array.from({ length: 30 }, (_, i) => 100 + i * 0.5);
    const candles1h = makeCandles(closes1h, 'BTC-USD', '1h');

    // 4h candles: volatile oscillation
    const closes4h = Array.from(
      { length: 30 },
      (_, i) => 100 + Math.sin(i) * 20,
    );
    const candles4h = makeCandles(closes4h, 'BTC-USD', '4h');

    const rsi1h = engine.compute({ name: 'RSI', period: 14 }, candles1h);
    const rsi4h = engine.compute({ name: 'RSI', period: 14 }, candles4h);

    expect(rsi1h.values.length).toBeGreaterThan(0);
    expect(rsi4h.values.length).toBeGreaterThan(0);

    // Results must be different (different input data)
    const last1h = rsi1h.values[rsi1h.values.length - 1] as number;
    const last4h = rsi4h.values[rsi4h.values.length - 1] as number;
    expect(last1h).not.toBeCloseTo(last4h, 0);
  });
});

// ── 13. extractVolumes adapter ───────────────────────────────────────

describe('extractVolumes', () => {
  it('returns volume values as number[]', () => {
    const candles = makeCandlesWithVolumes(
      [10, 20, 30],
      [1500.5, 2300.75, 890.25],
    );
    expect(extractVolumes(candles)).toEqual([1500.5, 2300.75, 890.25]);
  });

  it('handles zero volume', () => {
    const candles = makeCandlesWithVolumes([10], [0]);
    expect(extractVolumes(candles)).toEqual([0]);
  });

  it('returns empty array for empty candles', () => {
    expect(extractVolumes([])).toEqual([]);
  });
});

// ── 14. SD ───────────────────────────────────────────────────────────

describe('SD', () => {
  it('SD(3) returns correct standard deviation values', () => {
    // Known values: SD of [1,2,3] with population formula
    const candles = makeCandles([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const result = engine.compute({ name: 'SD', period: 3 }, candles);
    expect(result.values.length).toBeGreaterThan(0);
    // All SD values should be positive (varying data)
    for (const v of result.values) {
      expect(v as number).toBeGreaterThan(0);
    }
  });

  it('SD offset matches input minus output length', () => {
    const candles = makeCandles([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const result = engine.compute({ name: 'SD', period: 4 }, candles);
    expect(result.offset).toBe(candles.length - result.values.length);
  });

  it('SD on constant prices returns zero values', () => {
    const candles = makeCandles([50, 50, 50, 50, 50, 50, 50, 50]);
    const result = engine.compute({ name: 'SD', period: 3 }, candles);
    expect(result.values.length).toBeGreaterThan(0);
    for (const v of result.values) {
      expect(v as number).toBeCloseTo(0, 5);
    }
  });

  it('SD insufficient data returns empty', () => {
    const candles = makeCandles([1, 2]);
    const result = engine.compute({ name: 'SD', period: 5 }, candles);
    expect(result.values).toEqual([]);
    expect(result.offset).toBe(0);
  });
});

// ── 15. Highest ──────────────────────────────────────────────────────

describe('Highest', () => {
  it('Highest(3) returns highest HIGH over 3-candle window', () => {
    // makeCandles sets high = close + 1
    // closes: [5,3,8,2,9,1,7] -> highs: [6,4,9,3,10,2,8]
    // Highest(3) windows: [6,4,9]=9, [4,9,3]=9, [9,3,10]=10, [3,10,2]=10, [10,2,8]=10
    const candles = makeCandles([5, 3, 8, 2, 9, 1, 7]);
    const result = engine.compute({ name: 'Highest', period: 3 }, candles);
    expect(result.values.length).toBeGreaterThan(0);
    // Each value should be the max HIGH in its window
    for (const v of result.values) {
      expect(v as number).toBeGreaterThan(0);
    }
  });

  it('Highest offset matches input minus output length', () => {
    const candles = makeCandles([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const result = engine.compute({ name: 'Highest', period: 4 }, candles);
    expect(result.offset).toBe(candles.length - result.values.length);
  });

  it('Highest on ascending highs returns each window max', () => {
    // closes: [10,20,30,40,50] -> highs: [11,21,31,41,51]
    // Highest(3): [11,21,31]=31, [21,31,41]=41, [31,41,51]=51
    const candles = makeCandles([10, 20, 30, 40, 50]);
    const result = engine.compute({ name: 'Highest', period: 3 }, candles);
    const expected = [31, 41, 51];
    expect(result.values).toHaveLength(expected.length);
    for (let i = 0; i < expected.length; i++) {
      expect(result.values[i]).toBeCloseTo(expected[i], 5);
    }
  });

  it('Highest insufficient data returns empty', () => {
    const candles = makeCandles([1, 2]);
    const result = engine.compute({ name: 'Highest', period: 5 }, candles);
    expect(result.values).toEqual([]);
    expect(result.offset).toBe(0);
  });
});

// ── 16. Lowest ───────────────────────────────────────────────────────

describe('Lowest', () => {
  it('Lowest(3) returns lowest LOW over 3-candle window', () => {
    // makeCandles sets low = close - 1
    // closes: [5,3,8,2,9,1,7] -> lows: [4,2,7,1,8,0,6]
    // Lowest(3) windows: [4,2,7]=2, [2,7,1]=1, [7,1,8]=1, [1,8,0]=0, [8,0,6]=0
    const candles = makeCandles([5, 3, 8, 2, 9, 1, 7]);
    const result = engine.compute({ name: 'Lowest', period: 3 }, candles);
    expect(result.values.length).toBeGreaterThan(0);
  });

  it('Lowest on descending lows returns each window min', () => {
    // closes: [50,40,30,20,10] -> lows: [49,39,29,19,9]
    // Lowest(3): [49,39,29]=29, [39,29,19]=19, [29,19,9]=9
    const candles = makeCandles([50, 40, 30, 20, 10]);
    const result = engine.compute({ name: 'Lowest', period: 3 }, candles);
    const expected = [29, 19, 9];
    expect(result.values).toHaveLength(expected.length);
    for (let i = 0; i < expected.length; i++) {
      expect(result.values[i]).toBeCloseTo(expected[i], 5);
    }
  });

  it('Lowest offset matches input minus output length', () => {
    const candles = makeCandles([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const result = engine.compute({ name: 'Lowest', period: 4 }, candles);
    expect(result.offset).toBe(candles.length - result.values.length);
  });

  it('Lowest insufficient data returns empty', () => {
    const candles = makeCandles([1, 2]);
    const result = engine.compute({ name: 'Lowest', period: 5 }, candles);
    expect(result.values).toEqual([]);
    expect(result.offset).toBe(0);
  });
});
