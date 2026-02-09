import { describe, it, expect } from 'vitest';
import type { Candle, TradingPair, Timeframe } from '../../core/types.js';
import type { Signal } from '../types.js';
import { RsiMeanReversionStrategy } from '../rsi-mean-reversion.js';

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

describe('RsiMeanReversionStrategy', () => {
  const strategy = new RsiMeanReversionStrategy({
    period: 5,
    oversoldThreshold: 30,
    overboughtThreshold: 70,
  });

  it('should have correct name', () => {
    expect(strategy.name).toBe('rsi-mean-reversion');
  });

  it('should have minCandles = period + 2', () => {
    expect(strategy.minCandles).toBe(7);
  });

  it('should have requiredIndicators with RSI config', () => {
    expect(strategy.requiredIndicators).toEqual([{ name: 'RSI', period: 5 }]);
  });

  it('should return empty array for insufficient data', () => {
    const candles = makeCandles([100, 99, 98]);
    const signals = strategy.evaluate(candles, 'BTC-USD', '1h');
    expect(signals).toEqual([]);
  });

  it('should detect oversold condition (long signal)', () => {
    // Consistently declining prices produce very low RSI
    const closes = [100, 99, 98, 97, 96, 95, 94, 93, 92, 91, 90, 89, 88, 87, 86, 85, 84, 83, 82, 81];
    const candles = makeCandles(closes);
    const signals = strategy.evaluate(candles, 'BTC-USD', '1h');

    expect(signals.length).toBeGreaterThanOrEqual(1);
    const longSignal = signals.find((s) => s.direction === 'long');
    expect(longSignal).toBeDefined();
    assertValidSignal(longSignal!, 'long');
    expect(longSignal!.strategyName).toBe('rsi-mean-reversion');
    expect(longSignal!.reasoning).toContain('oversold');
  });

  it('should detect overbought condition (short signal)', () => {
    // Consistently rising prices produce very high RSI
    const closes = [80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95, 96, 97, 98, 99];
    const candles = makeCandles(closes);
    const signals = strategy.evaluate(candles, 'BTC-USD', '1h');

    expect(signals.length).toBeGreaterThanOrEqual(1);
    const shortSignal = signals.find((s) => s.direction === 'short');
    expect(shortSignal).toBeDefined();
    assertValidSignal(shortSignal!, 'short');
    expect(shortSignal!.reasoning).toContain('overbought');
  });

  it('should return empty array for neutral RSI', () => {
    // Alternating prices keep RSI near 50
    const closes: number[] = [];
    for (let i = 0; i < 20; i++) {
      closes.push(i % 2 === 0 ? 100 : 101);
    }
    const candles = makeCandles(closes);
    const signals = strategy.evaluate(candles, 'BTC-USD', '1h');
    expect(signals).toEqual([]);
  });

  it('should be deterministic (same input = same output)', () => {
    const closes = [100, 99, 98, 97, 96, 95, 94, 93, 92, 91, 90, 89, 88, 87, 86, 85, 84, 83, 82, 81];
    const candles = makeCandles(closes);
    const result1 = strategy.evaluate(candles, 'BTC-USD', '1h');
    const result2 = strategy.evaluate(candles, 'BTC-USD', '1h');
    expect(result1).toEqual(result2);
  });
});
