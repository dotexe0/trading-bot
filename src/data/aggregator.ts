/**
 * Multi-timeframe candle aggregation from 1-minute candles.
 *
 * Aggregates 1m candles into 5m, 15m, 1h, 4h, and 1D timeframes.
 * Windows are time-aligned (e.g., 5m windows start at :00, :05, :10).
 *
 * CRITICAL: Uses Decimal.js for ALL high/low comparisons and volume summation.
 * CRITICAL: Aggregation windows are time-aligned, not relative to first candle.
 */

import { d, ZERO } from '../core/decimal.js';
import type {
  Candle,
  TradingPair,
  Timeframe,
} from '../core/types.js';
import { TIMEFRAME_MS } from '../core/types.js';
import { createModuleLogger } from '../core/logger.js';

const log = createModuleLogger('aggregator');

/**
 * Aggregate 1m candles into a target timeframe.
 *
 * Windows are time-aligned to the target timeframe interval:
 * - 5m: windows at :00, :05, :10, :15, etc.
 * - 15m: windows at :00, :15, :30, :45
 * - 1h: windows at the top of each hour
 * - 4h: windows at 00:00, 04:00, 08:00, 12:00, 16:00, 20:00
 * - 1D: windows at midnight UTC
 *
 * @param minuteCandles - Array of 1m candles (need not be sorted)
 * @param targetTimeframe - Target timeframe to aggregate to
 * @returns Aggregated candles sorted by timestamp ascending
 */
export function aggregateCandles(
  minuteCandles: Candle[],
  targetTimeframe: Timeframe,
): Candle[] {
  if (minuteCandles.length === 0) {
    return [];
  }

  const intervalMs = TIMEFRAME_MS[targetTimeframe];

  // Group candles into time-aligned windows
  const windows = new Map<number, Candle[]>();

  for (const candle of minuteCandles) {
    const windowStart =
      Math.floor(candle.timestamp / intervalMs) * intervalMs;

    let windowCandles = windows.get(windowStart);
    if (!windowCandles) {
      windowCandles = [];
      windows.set(windowStart, windowCandles);
    }
    windowCandles.push(candle);
  }

  // Aggregate each window
  const aggregated: Candle[] = [];
  const pair = minuteCandles[0].pair;

  // Sort window keys for ordered processing
  const sortedWindowStarts = Array.from(windows.keys()).sort((a, b) => a - b);

  for (const windowStart of sortedWindowStarts) {
    const windowCandles = windows.get(windowStart)!;

    // Sort candles within window by timestamp
    windowCandles.sort((a, b) => a.timestamp - b.timestamp);

    // Build aggregated candle using Decimal.js for precision
    const first = windowCandles[0];
    const last = windowCandles[windowCandles.length - 1];

    let high = d(first.high);
    let low = d(first.low);
    let volume = ZERO;

    for (const c of windowCandles) {
      const cHigh = d(c.high);
      const cLow = d(c.low);
      const cVol = d(c.volume);

      if (cHigh.gt(high)) high = cHigh;
      if (cLow.lt(low)) low = cLow;
      volume = volume.plus(cVol);
    }

    aggregated.push({
      pair: pair,
      timeframe: targetTimeframe,
      timestamp: windowStart,
      open: first.open,
      close: last.close,
      high: high.toString(),
      low: low.toString(),
      volume: volume.toString(),
    });
  }

  // Already sorted since we iterated sorted window starts
  log.debug(
    {
      targetTimeframe,
      inputCandles: minuteCandles.length,
      outputCandles: aggregated.length,
    },
    'Aggregation complete',
  );

  return aggregated;
}

/**
 * Aggregate 1m candles into all higher timeframes (5m, 15m, 1h, 4h, 1D).
 *
 * @param minuteCandles - Array of 1m candles
 * @param pair - Trading pair (for logging)
 * @returns Map of timeframe -> aggregated candles
 */
export function aggregateAllTimeframes(
  minuteCandles: Candle[],
  pair: TradingPair,
): Map<Timeframe, Candle[]> {
  const targetTimeframes: Timeframe[] = ['5m', '15m', '1h', '4h', '1D'];
  const result = new Map<Timeframe, Candle[]>();

  for (const tf of targetTimeframes) {
    const candles = aggregateCandles(minuteCandles, tf);
    result.set(tf, candles);
    log.info(
      { pair, timeframe: tf, count: candles.length },
      'Timeframe aggregated',
    );
  }

  return result;
}
