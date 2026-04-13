import { describe, it, expect } from 'vitest';
import type { Candle, TradingPair, Timeframe } from '../../core/types.js';
import type { Signal } from '../types.js';
import { MultiTimeframeTrendStrategy } from '../multi-timeframe-trend.js';
import { createDefaultRegistry } from '../index.js';

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

describe('MultiTimeframeTrendStrategy', () => {
  const strategy = new MultiTimeframeTrendStrategy({
    trendTimeframe: '4h',
    trendEmaPeriod: 10,
    entryEmaPeriod: 5,
    atrPeriod: 5,
  });

  it('should have correct name', () => {
    expect(strategy.name).toBe('multi-timeframe-trend');
  });

  it('should have minCandles = max(trendEmaPeriod, entryEmaPeriod) + 1', () => {
    expect(strategy.minCandles).toBe(11);
  });

  it('should have requiredIndicators with EMA and ATR', () => {
    expect(strategy.requiredIndicators).toEqual([
      { name: 'EMA', period: 5 },
      { name: 'ATR', period: 5 },
    ]);
  });

  it('should return empty array for insufficient data', () => {
    const candles = makeCandles([100, 100, 100]);
    const signals = strategy.evaluate(candles, 'BTC-USD', '1h');
    expect(signals).toEqual([]);
  });

  it('should return empty array when additionalCandles not provided', () => {
    const closes: number[] = [];
    for (let i = 0; i < 30; i++) closes.push(100 + i * 0.5);
    const candles = makeCandles(closes);
    const signals = strategy.evaluate(candles, 'BTC-USD', '1h');
    expect(signals).toEqual([]);
  });

  it('should return empty array when required timeframe key missing', () => {
    const closes: number[] = [];
    for (let i = 0; i < 30; i++) closes.push(100 + i * 0.5);
    const candles = makeCandles(closes);
    const additionalCandles = new Map<Timeframe, Candle[]>();
    additionalCandles.set('1D', makeCandles(Array(20).fill(100), 'BTC-USD', '1D'));
    const signals = strategy.evaluate(candles, 'BTC-USD', '1h', additionalCandles);
    expect(signals).toEqual([]);
  });

  it('should return empty array for insufficient higher TF data', () => {
    const closes: number[] = [];
    for (let i = 0; i < 30; i++) closes.push(100 + i * 0.5);
    const candles = makeCandles(closes);
    const additionalCandles = new Map<Timeframe, Candle[]>();
    // Only 5 higher TF candles, less than trendEmaPeriod=10
    additionalCandles.set('4h', makeCandles([100, 101, 102, 103, 104], 'BTC-USD', '4h'));
    const signals = strategy.evaluate(candles, 'BTC-USD', '1h', additionalCandles);
    expect(signals).toEqual([]);
  });

  it('should detect aligned bullish trend (long signal)', () => {
    // Higher TF: steadily rising from 90 to 110 (20 candles above EMA)
    const higherTfCloses: number[] = [];
    for (let i = 0; i < 20; i++) higherTfCloses.push(90 + i);
    const higherTfCandles = makeCandles(higherTfCloses, 'BTC-USD', '4h');

    // Primary: rising from 100 to 115
    const primaryCloses: number[] = [];
    for (let i = 0; i < 30; i++) primaryCloses.push(100 + i * 0.5);
    const primaryCandles = makeCandles(primaryCloses);

    const additionalCandles = new Map<Timeframe, Candle[]>();
    additionalCandles.set('4h', higherTfCandles);

    const signals = strategy.evaluate(primaryCandles, 'BTC-USD', '1h', additionalCandles);

    expect(signals.length).toBeGreaterThanOrEqual(1);
    const longSignal = signals.find((s) => s.direction === 'long');
    expect(longSignal).toBeDefined();
    assertValidSignal(longSignal!, 'long');
    expect(longSignal!.strategyName).toBe('multi-timeframe-trend');
    expect(longSignal!.reasoning).toContain('Multi-TF trend aligned');
  });

  it('should detect aligned bearish trend (short signal)', () => {
    // Higher TF: steadily declining
    const higherTfCloses: number[] = [];
    for (let i = 0; i < 20; i++) higherTfCloses.push(110 - i);
    const higherTfCandles = makeCandles(higherTfCloses, 'BTC-USD', '4h');

    // Primary: declining
    const primaryCloses: number[] = [];
    for (let i = 0; i < 30; i++) primaryCloses.push(115 - i * 0.5);
    const primaryCandles = makeCandles(primaryCloses);

    const additionalCandles = new Map<Timeframe, Candle[]>();
    additionalCandles.set('4h', higherTfCandles);

    const signals = strategy.evaluate(primaryCandles, 'BTC-USD', '1h', additionalCandles);

    expect(signals.length).toBeGreaterThanOrEqual(1);
    const shortSignal = signals.find((s) => s.direction === 'short');
    expect(shortSignal).toBeDefined();
    assertValidSignal(shortSignal!, 'short');
  });

  it('should return empty array when timeframes conflict', () => {
    // Higher TF: bullish (rising)
    const higherTfCloses: number[] = [];
    for (let i = 0; i < 20; i++) higherTfCloses.push(90 + i);
    const higherTfCandles = makeCandles(higherTfCloses, 'BTC-USD', '4h');

    // Primary: bearish (declining)
    const primaryCloses: number[] = [];
    for (let i = 0; i < 30; i++) primaryCloses.push(115 - i * 0.5);
    const primaryCandles = makeCandles(primaryCloses);

    const additionalCandles = new Map<Timeframe, Candle[]>();
    additionalCandles.set('4h', higherTfCandles);

    const signals = strategy.evaluate(primaryCandles, 'BTC-USD', '1h', additionalCandles);
    expect(signals).toEqual([]);
  });

  it('should be deterministic (same input = same output)', () => {
    const higherTfCloses: number[] = [];
    for (let i = 0; i < 20; i++) higherTfCloses.push(90 + i);
    const higherTfCandles = makeCandles(higherTfCloses, 'BTC-USD', '4h');

    const primaryCloses: number[] = [];
    for (let i = 0; i < 30; i++) primaryCloses.push(100 + i * 0.5);
    const primaryCandles = makeCandles(primaryCloses);

    const additionalCandles = new Map<Timeframe, Candle[]>();
    additionalCandles.set('4h', higherTfCandles);

    const result1 = strategy.evaluate(primaryCandles, 'BTC-USD', '1h', additionalCandles);
    const result2 = strategy.evaluate(primaryCandles, 'BTC-USD', '1h', additionalCandles);
    expect(result1).toEqual(result2);
  });
});

describe('createDefaultRegistry', () => {
  it('should register all 7 strategies including multi-timeframe-trend', () => {
    const registry = createDefaultRegistry();
    const list = registry.list();
    expect(list).toHaveLength(7);
    expect(list).toContain('sma-crossover');
    expect(list).toContain('rsi-mean-reversion');
    expect(list).toContain('macd-momentum');
    expect(list).toContain('bollinger-breakout');
    expect(list).toContain('z-score-mean-reversion');
    expect(list).toContain('multi-timeframe-trend');
    expect(list).toContain('momentum-breakout');
  });

  it('should have all 7 strategies via has()', () => {
    const registry = createDefaultRegistry();
    expect(registry.has('sma-crossover')).toBe(true);
    expect(registry.has('rsi-mean-reversion')).toBe(true);
    expect(registry.has('macd-momentum')).toBe(true);
    expect(registry.has('bollinger-breakout')).toBe(true);
    expect(registry.has('z-score-mean-reversion')).toBe(true);
    expect(registry.has('multi-timeframe-trend')).toBe(true);
    expect(registry.has('momentum-breakout')).toBe(true);
  });

  it('should create sma-crossover strategy from config', () => {
    const registry = createDefaultRegistry();
    const strategy = registry.create({ strategy: 'sma-crossover' });
    expect(strategy.name).toBe('sma-crossover');
  });

  it('should create rsi-mean-reversion strategy from config', () => {
    const registry = createDefaultRegistry();
    const strategy = registry.create({ strategy: 'rsi-mean-reversion' });
    expect(strategy.name).toBe('rsi-mean-reversion');
  });

  it('should create macd-momentum strategy from config', () => {
    const registry = createDefaultRegistry();
    const strategy = registry.create({ strategy: 'macd-momentum' });
    expect(strategy.name).toBe('macd-momentum');
  });

  it('should create bollinger-breakout strategy from config', () => {
    const registry = createDefaultRegistry();
    const strategy = registry.create({ strategy: 'bollinger-breakout' });
    expect(strategy.name).toBe('bollinger-breakout');
  });

  it('multi-timeframe-trend is registered in the default registry', () => {
    const registry = createDefaultRegistry();
    expect(registry.has('multi-timeframe-trend')).toBe(true);
    const strategy = registry.create({ strategy: 'multi-timeframe-trend' });
    expect(strategy.name).toBe('multi-timeframe-trend');
  });

  it('should create momentum-breakout strategy from config', () => {
    const registry = createDefaultRegistry();
    const strategy = registry.create({ strategy: 'momentum-breakout' });
    expect(strategy.name).toBe('momentum-breakout');
  });
});
