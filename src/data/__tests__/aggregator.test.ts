/**
 * Unit tests for candle aggregator.
 */

import { describe, it, expect } from 'vitest';
import { aggregateCandles, aggregateAllTimeframes } from '../aggregator.js';
import type { Candle } from '../../core/types.js';

function makeMinuteCandle(
  timestampMs: number,
  open: string,
  high: string,
  low: string,
  close: string,
  volume: string,
): Candle {
  return {
    pair: 'BTC-USD',
    timeframe: '1m',
    timestamp: timestampMs,
    open,
    high,
    low,
    close,
    volume,
  };
}

describe('aggregateCandles', () => {
  it('should aggregate 5 one-minute candles into 1 five-minute candle', () => {
    // 5 consecutive 1m candles starting at a 5m boundary
    // e.g., 2023-11-14 00:00:00 UTC = 1699920000000
    const baseTs = 1699920000000; // aligned to 5m
    const candles = [
      makeMinuteCandle(baseTs + 0 * 60000, '50000', '50100', '49900', '50050', '1.0'),
      makeMinuteCandle(baseTs + 1 * 60000, '50050', '50200', '49950', '50100', '1.5'),
      makeMinuteCandle(baseTs + 2 * 60000, '50100', '50300', '50000', '50250', '2.0'),
      makeMinuteCandle(baseTs + 3 * 60000, '50250', '50250', '49800', '49850', '0.5'),
      makeMinuteCandle(baseTs + 4 * 60000, '49850', '50000', '49700', '49900', '1.0'),
    ];

    const result = aggregateCandles(candles, '5m');
    expect(result).toHaveLength(1);

    const agg = result[0];
    expect(agg.pair).toBe('BTC-USD');
    expect(agg.timeframe).toBe('5m');
    expect(agg.timestamp).toBe(baseTs);

    // Open = first candle's open
    expect(agg.open).toBe('50000');
    // Close = last candle's close
    expect(agg.close).toBe('49900');
    // High = max of all highs = 50300
    expect(agg.high).toBe('50300');
    // Low = min of all lows = 49700
    expect(agg.low).toBe('49700');
    // Volume = sum = 1.0 + 1.5 + 2.0 + 0.5 + 1.0 = 6.0
    expect(agg.volume).toBe('6');
  });

  it('should create multiple windows when candles span multiple periods', () => {
    const baseTs = 1699920000000; // aligned to 5m
    const candles = [
      // First 5m window
      makeMinuteCandle(baseTs + 0 * 60000, '50000', '50100', '49900', '50050', '1.0'),
      makeMinuteCandle(baseTs + 1 * 60000, '50050', '50200', '49950', '50100', '1.5'),
      // Second 5m window
      makeMinuteCandle(baseTs + 5 * 60000, '50100', '50300', '50000', '50250', '2.0'),
      makeMinuteCandle(baseTs + 6 * 60000, '50250', '50250', '49800', '49850', '0.5'),
    ];

    const result = aggregateCandles(candles, '5m');
    expect(result).toHaveLength(2);
    expect(result[0].timestamp).toBe(baseTs);
    expect(result[1].timestamp).toBe(baseTs + 5 * 60000);
  });

  it('should handle empty input', () => {
    const result = aggregateCandles([], '5m');
    expect(result).toHaveLength(0);
  });

  it('should handle single candle', () => {
    const candle = makeMinuteCandle(1699920000000, '50000', '50100', '49900', '50050', '1.0');
    const result = aggregateCandles([candle], '5m');
    expect(result).toHaveLength(1);
    expect(result[0].open).toBe('50000');
    expect(result[0].close).toBe('50050');
    expect(result[0].high).toBe('50100');
    expect(result[0].low).toBe('49900');
    expect(result[0].volume).toBe('1');
  });

  it('should use Decimal.js for precise volume summation', () => {
    const baseTs = 1699920000000;
    const candles = [
      makeMinuteCandle(baseTs, '100', '100', '100', '100', '0.1'),
      makeMinuteCandle(baseTs + 60000, '100', '100', '100', '100', '0.2'),
    ];

    const result = aggregateCandles(candles, '5m');
    // 0.1 + 0.2 should be exactly 0.3 (not 0.30000000000000004)
    expect(result[0].volume).toBe('0.3');
  });

  it('should time-align windows (not relative to first candle)', () => {
    // Start at :03 -- should still snap to :00 and :05 boundaries
    const baseTs = 1699920000000 + 3 * 60000; // :03
    const candles = [
      makeMinuteCandle(baseTs, '50000', '50100', '49900', '50050', '1.0'),
      makeMinuteCandle(baseTs + 60000, '50050', '50100', '49900', '50050', '1.0'), // :04
      makeMinuteCandle(baseTs + 2 * 60000, '50050', '50100', '49900', '50050', '1.0'), // :05 (next window)
    ];

    const result = aggregateCandles(candles, '5m');
    expect(result).toHaveLength(2);
    // First window starts at :00 (rounded down from :03)
    expect(result[0].timestamp).toBe(1699920000000);
    // Second window starts at :05
    expect(result[1].timestamp).toBe(1699920000000 + 5 * 60000);
  });
});

describe('aggregateAllTimeframes', () => {
  it('should produce candles for all 5 higher timeframes', () => {
    // Create 60+ minutes of 1m candles (enough for at least 1 candle in each timeframe)
    const baseTs = 1699920000000; // midnight-aligned
    const candles: Candle[] = [];
    for (let i = 0; i < 1440; i++) {
      candles.push(
        makeMinuteCandle(
          baseTs + i * 60000,
          '50000',
          '50100',
          '49900',
          '50000',
          '1.0',
        ),
      );
    }

    const result = aggregateAllTimeframes(candles, 'BTC-USD');

    expect(result.has('5m')).toBe(true);
    expect(result.has('15m')).toBe(true);
    expect(result.has('1h')).toBe(true);
    expect(result.has('4h')).toBe(true);
    expect(result.has('1D')).toBe(true);

    // 1440 1m candles = 288 5m candles
    expect(result.get('5m')!.length).toBe(288);
    // 1440 / 15 = 96
    expect(result.get('15m')!.length).toBe(96);
    // 1440 / 60 = 24
    expect(result.get('1h')!.length).toBe(24);
    // 1440 / 240 = 6
    expect(result.get('4h')!.length).toBe(6);
    // 1440 / 1440 = 1
    expect(result.get('1D')!.length).toBe(1);
  });
});
