/**
 * Gap detection and classification for candle time series.
 *
 * Detects missing candle periods in sorted timestamp arrays and
 * classifies them as fillable (short gaps that can be forward-filled)
 * or unfillable (long gaps that need re-fetch from provider).
 */

import { createModuleLogger } from '../core/logger.js';

const log = createModuleLogger('gap-detector');

/** Represents a gap in candle data. */
export interface Gap {
  pair: string;
  timeframe: string;
  startMs: number;
  endMs: number;
  missingCount: number;
}

/**
 * Detect gaps in a sorted ascending array of timestamps.
 *
 * A gap exists when consecutive timestamps differ by more than
 * the expected interval for the timeframe.
 *
 * @param timestamps - Sorted ascending array of Unix ms timestamps
 * @param expectedIntervalMs - Expected interval between candles in ms
 * @param pair - Trading pair (for gap metadata)
 * @param timeframe - Timeframe (for gap metadata)
 * @returns Array of detected gaps
 */
export function detectGaps(
  timestamps: number[],
  expectedIntervalMs: number,
  pair: string,
  timeframe: string,
): Gap[] {
  const gaps: Gap[] = [];

  if (timestamps.length < 2) {
    return gaps;
  }

  for (let i = 1; i < timestamps.length; i++) {
    const diff = timestamps[i] - timestamps[i - 1];

    if (diff > expectedIntervalMs) {
      const missingCount = Math.round(diff / expectedIntervalMs) - 1;
      gaps.push({
        pair,
        timeframe,
        startMs: timestamps[i - 1],
        endMs: timestamps[i],
        missingCount,
      });
    }
  }

  const totalMissing = gaps.reduce((sum, g) => sum + g.missingCount, 0);
  log.info(
    { pair, timeframe, gapsFound: gaps.length, totalMissingCandles: totalMissing },
    'Gap detection complete',
  );

  return gaps;
}

/**
 * Classify gaps into fillable and unfillable categories.
 *
 * - Fillable: gaps shorter than 60 minutes (can potentially be forward-filled
 *   or represent normal low-activity periods like weekends/holidays)
 * - Unfillable: gaps longer than 60 minutes (need re-fetch from provider)
 *
 * @param gaps - Array of detected gaps
 * @returns Object with fillable and unfillable gap arrays
 */
export function classifyGaps(gaps: Gap[]): {
  fillable: Gap[];
  unfillable: Gap[];
} {
  const FILLABLE_THRESHOLD_MS = 60 * 60 * 1000; // 60 minutes

  const fillable: Gap[] = [];
  const unfillable: Gap[] = [];

  for (const gap of gaps) {
    const durationMs = gap.endMs - gap.startMs;
    if (durationMs <= FILLABLE_THRESHOLD_MS) {
      fillable.push(gap);
    } else {
      unfillable.push(gap);
    }
  }

  log.info(
    { fillable: fillable.length, unfillable: unfillable.length },
    'Gap classification complete',
  );

  return { fillable, unfillable };
}
