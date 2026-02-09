import { describe, it, expect } from 'vitest';
import type { Candle, TradingPair, Timeframe } from '../../core/types.js';
import type { Signal } from '../types.js';
import { MacdMomentumStrategy } from '../macd-momentum.js';

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

describe('MacdMomentumStrategy', () => {
  const strategy = new MacdMomentumStrategy({
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
  });

  it('should have correct name', () => {
    expect(strategy.name).toBe('macd-momentum');
  });

  it('should have minCandles = slowPeriod + signalPeriod', () => {
    expect(strategy.minCandles).toBe(35);
  });

  it('should have requiredIndicators with MACD config', () => {
    expect(strategy.requiredIndicators).toEqual([
      { name: 'MACD', fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 },
    ]);
  });

  it('should return empty array for insufficient data', () => {
    const candles = makeCandles(Array(20).fill(100));
    const signals = strategy.evaluate(candles, 'BTC-USD', '1h');
    expect(signals).toEqual([]);
  });

  it('should detect bullish MACD crossover', () => {
    // Gradual decline then small uptick -- crossover happens at last point
    const closes: number[] = [];
    for (let i = 0; i < 40; i++) closes.push(100 - i * 0.3);
    // Use exactly 41 candles (slice at crossover point)
    closes.push(88 + 1.5);
    const candles = makeCandles(closes);
    const signals = strategy.evaluate(candles, 'BTC-USD', '1h');

    const longSignals = signals.filter((s) => s.direction === 'long');
    expect(longSignals.length).toBeGreaterThanOrEqual(1);
    for (const s of longSignals) {
      assertValidSignal(s, 'long');
      expect(s.strategyName).toBe('macd-momentum');
      expect(s.reasoning).toContain('MACD crossed above signal');
    }
  });

  it('should detect bearish MACD crossover', () => {
    // Gradual rise then small downtick -- crossover happens at last point
    const closes: number[] = [];
    for (let i = 0; i < 40; i++) closes.push(100 + i * 0.3);
    // Use exactly 41 candles (slice at crossover point)
    closes.push(112 - 1.5);
    const candles = makeCandles(closes);
    const signals = strategy.evaluate(candles, 'BTC-USD', '1h');

    const shortSignals = signals.filter((s) => s.direction === 'short');
    expect(shortSignals.length).toBeGreaterThanOrEqual(1);
    for (const s of shortSignals) {
      assertValidSignal(s, 'short');
      expect(s.reasoning).toContain('MACD crossed below signal');
    }
  });

  it('should return empty array for flat prices (no crossover)', () => {
    const closes = Array(50).fill(100);
    const candles = makeCandles(closes);
    const signals = strategy.evaluate(candles, 'BTC-USD', '1h');
    expect(signals).toEqual([]);
  });

  it('should be deterministic (same input = same output)', () => {
    const closes: number[] = [];
    for (let i = 0; i < 40; i++) closes.push(100 - i * 0.3);
    closes.push(88 + 1.5);
    const candles = makeCandles(closes);
    const result1 = strategy.evaluate(candles, 'BTC-USD', '1h');
    const result2 = strategy.evaluate(candles, 'BTC-USD', '1h');
    expect(result1).toEqual(result2);
  });
});
