/**
 * Unit tests for candle validator.
 */

import { describe, it, expect } from 'vitest';
import { validateCandles } from '../validator.js';
import type { Candle } from '../../core/types.js';

function makeCandle(overrides: Partial<Candle> = {}): Candle {
  return {
    pair: 'BTC-USD',
    timeframe: '1m',
    timestamp: 1700000000000, // Unix ms
    open: '50000',
    high: '50100',
    low: '49900',
    close: '50050',
    volume: '1.5',
    ...overrides,
  };
}

describe('validateCandles', () => {
  it('should accept a valid candle', () => {
    const result = validateCandles([makeCandle()]);
    expect(result.valid).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
  });

  it('should reject candles with timestamp in seconds', () => {
    const result = validateCandles([
      makeCandle({ timestamp: 1700000000 }), // seconds, not ms
    ]);
    expect(result.valid).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toContain('seconds');
  });

  it('should reject candles with zero price', () => {
    const result = validateCandles([makeCandle({ open: '0' })]);
    expect(result.valid).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toContain('Open price <= 0');
  });

  it('should reject candles with negative price', () => {
    const result = validateCandles([makeCandle({ low: '-5' })]);
    expect(result.valid).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toContain('Low price <= 0');
  });

  it('should reject candles where high < low', () => {
    const result = validateCandles([
      makeCandle({ high: '49800', low: '49900', open: '49800', close: '49800' }),
    ]);
    expect(result.valid).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toContain('High');
    expect(result.rejected[0].reason).toContain('Low');
  });

  it('should reject candles where high < open', () => {
    const result = validateCandles([
      makeCandle({ high: '49900', open: '50000', low: '49800', close: '49850' }),
    ]);
    expect(result.valid).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toContain('High');
    expect(result.rejected[0].reason).toContain('Open');
  });

  it('should reject candles where low > close', () => {
    const result = validateCandles([
      makeCandle({ high: '50200', open: '50100', low: '50000', close: '49900' }),
    ]);
    expect(result.valid).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toContain('Low');
    expect(result.rejected[0].reason).toContain('Close');
  });

  it('should reject candles with negative volume', () => {
    const result = validateCandles([makeCandle({ volume: '-1' })]);
    expect(result.valid).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toContain('Negative volume');
  });

  it('should allow zero volume candles', () => {
    const result = validateCandles([makeCandle({ volume: '0' })]);
    expect(result.valid).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
  });

  it('should reject extreme outliers (>50% move)', () => {
    // Open 50000, close 80000 = 60% move
    const result = validateCandles([
      makeCandle({ open: '50000', high: '80000', close: '80000', low: '50000' }),
    ]);
    expect(result.valid).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toContain('Extreme outlier');
  });

  it('should accept candles with exactly 50% move', () => {
    // Open 50000, close 75000 = exactly 50%
    const result = validateCandles([
      makeCandle({ open: '50000', high: '75000', close: '75000', low: '50000' }),
    ]);
    expect(result.valid).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
  });

  it('should partition mixed valid and invalid candles correctly', () => {
    const candles = [
      makeCandle(),
      makeCandle({ timestamp: 1700000060000 }), // valid, 1 minute later
      makeCandle({ open: '0' }), // invalid
      makeCandle({ timestamp: 1700000 }), // invalid (seconds)
    ];
    const result = validateCandles(candles);
    expect(result.valid).toHaveLength(2);
    expect(result.rejected).toHaveLength(2);
  });
});
