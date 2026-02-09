import { describe, it, expect } from 'vitest';
import type { Candle, TradingPair, Timeframe } from '../../core/types.js';
import type { Signal } from '../types.js';
import { BollingerBreakoutStrategy } from '../bollinger-breakout.js';

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

describe('BollingerBreakoutStrategy', () => {
  describe('breakout mode', () => {
    const strategy = new BollingerBreakoutStrategy({
      period: 10,
      stdDev: 2,
      breakoutMode: true,
    });

    it('should have correct name', () => {
      expect(strategy.name).toBe('bollinger-breakout');
    });

    it('should have minCandles = period + 1', () => {
      expect(strategy.minCandles).toBe(11);
    });

    it('should have requiredIndicators with BollingerBands config', () => {
      expect(strategy.requiredIndicators).toEqual([
        { name: 'BollingerBands', period: 10, stdDev: 2 },
      ]);
    });

    it('should return empty array for insufficient data', () => {
      const candles = makeCandles([100, 100, 100]);
      const signals = strategy.evaluate(candles, 'BTC-USD', '1h');
      expect(signals).toEqual([]);
    });

    it('should detect upper breakout as long signal', () => {
      // 20 candles at 100, then single spike to 130 (must be above upper band)
      const closes = [...Array(20).fill(100), 130];
      const candles = makeCandles(closes);
      const signals = strategy.evaluate(candles, 'BTC-USD', '1h');

      const longSignals = signals.filter((s) => s.direction === 'long');
      expect(longSignals.length).toBeGreaterThanOrEqual(1);
      for (const s of longSignals) {
        assertValidSignal(s, 'long');
        expect(s.strategyName).toBe('bollinger-breakout');
        expect(s.reasoning).toContain('Bollinger Band');
      }
    });

    it('should detect lower breakout as short signal', () => {
      // 20 candles at 100, then single drop to 70 (must be below lower band)
      const closes = [...Array(20).fill(100), 70];
      const candles = makeCandles(closes);
      const signals = strategy.evaluate(candles, 'BTC-USD', '1h');

      const shortSignals = signals.filter((s) => s.direction === 'short');
      expect(shortSignals.length).toBeGreaterThanOrEqual(1);
      for (const s of shortSignals) {
        assertValidSignal(s, 'short');
      }
    });

    it('should return empty array for prices within bands', () => {
      // Slight variation staying well within bands
      const closes: number[] = [];
      for (let i = 0; i < 20; i++) {
        closes.push(100 + (i % 2 === 0 ? 0.5 : -0.5));
      }
      const candles = makeCandles(closes);
      const signals = strategy.evaluate(candles, 'BTC-USD', '1h');
      expect(signals).toEqual([]);
    });

    it('should be deterministic', () => {
      const closes = [...Array(20).fill(100), 130];
      const candles = makeCandles(closes);
      const result1 = strategy.evaluate(candles, 'BTC-USD', '1h');
      const result2 = strategy.evaluate(candles, 'BTC-USD', '1h');
      expect(result1).toEqual(result2);
    });
  });

  describe('mean-reversion mode', () => {
    const strategy = new BollingerBreakoutStrategy({
      period: 10,
      stdDev: 2,
      breakoutMode: false,
    });

    it('should detect upper breakout as short signal (reversed)', () => {
      const closes = [...Array(20).fill(100), 130];
      const candles = makeCandles(closes);
      const signals = strategy.evaluate(candles, 'BTC-USD', '1h');

      const shortSignals = signals.filter((s) => s.direction === 'short');
      expect(shortSignals.length).toBeGreaterThanOrEqual(1);
      for (const s of shortSignals) {
        assertValidSignal(s, 'short');
      }
    });

    it('should detect lower breakout as long signal (reversed)', () => {
      const closes = [...Array(20).fill(100), 70];
      const candles = makeCandles(closes);
      const signals = strategy.evaluate(candles, 'BTC-USD', '1h');

      const longSignals = signals.filter((s) => s.direction === 'long');
      expect(longSignals.length).toBeGreaterThanOrEqual(1);
      for (const s of longSignals) {
        assertValidSignal(s, 'long');
      }
    });
  });
});
