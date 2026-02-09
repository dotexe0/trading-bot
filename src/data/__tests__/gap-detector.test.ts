/**
 * Unit tests for gap detector.
 */

import { describe, it, expect } from 'vitest';
import { detectGaps, classifyGaps } from '../gap-detector.js';

const ONE_MINUTE_MS = 60_000;

describe('detectGaps', () => {
  it('should detect no gaps in continuous timestamps', () => {
    const timestamps = [
      1700000000000,
      1700000060000,
      1700000120000,
      1700000180000,
    ];
    const gaps = detectGaps(timestamps, ONE_MINUTE_MS, 'BTC-USD', '1m');
    expect(gaps).toHaveLength(0);
  });

  it('should detect a single gap', () => {
    const timestamps = [
      1700000000000,
      1700000060000,
      // missing 1700000120000, 1700000180000
      1700000240000,
    ];
    const gaps = detectGaps(timestamps, ONE_MINUTE_MS, 'BTC-USD', '1m');
    expect(gaps).toHaveLength(1);
    expect(gaps[0].startMs).toBe(1700000060000);
    expect(gaps[0].endMs).toBe(1700000240000);
    expect(gaps[0].missingCount).toBe(2);
    expect(gaps[0].pair).toBe('BTC-USD');
    expect(gaps[0].timeframe).toBe('1m');
  });

  it('should detect multiple gaps', () => {
    const timestamps = [
      1700000000000,
      // gap: missing 1700000060000
      1700000120000,
      1700000180000,
      // gap: missing 1700000240000, 1700000300000, 1700000360000
      1700000420000,
    ];
    const gaps = detectGaps(timestamps, ONE_MINUTE_MS, 'BTC-USD', '1m');
    expect(gaps).toHaveLength(2);
    expect(gaps[0].missingCount).toBe(1);
    expect(gaps[1].missingCount).toBe(3);
  });

  it('should return empty for less than 2 timestamps', () => {
    expect(detectGaps([], ONE_MINUTE_MS, 'BTC-USD', '1m')).toHaveLength(0);
    expect(detectGaps([1700000000000], ONE_MINUTE_MS, 'BTC-USD', '1m')).toHaveLength(0);
  });
});

describe('classifyGaps', () => {
  it('should classify short gaps as fillable', () => {
    const gaps = [
      {
        pair: 'BTC-USD',
        timeframe: '1m',
        startMs: 1700000000000,
        endMs: 1700000000000 + 30 * ONE_MINUTE_MS, // 30 minutes
        missingCount: 29,
      },
    ];
    const { fillable, unfillable } = classifyGaps(gaps);
    expect(fillable).toHaveLength(1);
    expect(unfillable).toHaveLength(0);
  });

  it('should classify long gaps as unfillable', () => {
    const gaps = [
      {
        pair: 'BTC-USD',
        timeframe: '1m',
        startMs: 1700000000000,
        endMs: 1700000000000 + 120 * ONE_MINUTE_MS, // 2 hours
        missingCount: 119,
      },
    ];
    const { fillable, unfillable } = classifyGaps(gaps);
    expect(fillable).toHaveLength(0);
    expect(unfillable).toHaveLength(1);
  });

  it('should handle exactly 60 minute gaps as fillable', () => {
    const gaps = [
      {
        pair: 'BTC-USD',
        timeframe: '1m',
        startMs: 1700000000000,
        endMs: 1700000000000 + 60 * ONE_MINUTE_MS, // exactly 60 minutes
        missingCount: 59,
      },
    ];
    const { fillable, unfillable } = classifyGaps(gaps);
    expect(fillable).toHaveLength(1);
    expect(unfillable).toHaveLength(0);
  });

  it('should partition mixed gaps correctly', () => {
    const gaps = [
      {
        pair: 'BTC-USD',
        timeframe: '1m',
        startMs: 1700000000000,
        endMs: 1700000000000 + 10 * ONE_MINUTE_MS,
        missingCount: 9,
      },
      {
        pair: 'BTC-USD',
        timeframe: '1m',
        startMs: 1700100000000,
        endMs: 1700100000000 + 180 * ONE_MINUTE_MS,
        missingCount: 179,
      },
    ];
    const { fillable, unfillable } = classifyGaps(gaps);
    expect(fillable).toHaveLength(1);
    expect(unfillable).toHaveLength(1);
  });
});
