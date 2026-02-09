/**
 * Candle data validation on ingestion.
 *
 * Validates candle data before storage to ensure data integrity:
 * - Timestamp is Unix milliseconds (not seconds)
 * - OHLC relationships are valid (high >= low, etc.)
 * - No zero or negative prices
 * - Flags extreme outliers (>50% single-candle move)
 * - Allows zero volume (common during low-activity periods)
 *
 * CRITICAL: Uses Decimal.js for all price comparisons -- no floating point.
 */

import { d } from '../core/decimal.js';
import { createModuleLogger } from '../core/logger.js';
import type { Candle } from '../core/types.js';

const log = createModuleLogger('validator');

export interface ValidationResult {
  valid: Candle[];
  rejected: Array<{ candle: Candle; reason: string }>;
}

/**
 * Validate an array of candles and partition into valid and rejected.
 *
 * Rejection reasons:
 * - Timestamp appears to be seconds (< 1_000_000_000_000)
 * - Any OHLC price <= 0
 * - OHLC violations (high < low, high < open, etc.)
 * - Negative volume
 * - Extreme outlier (|close - open| / open > 0.5)
 *
 * Zero volume is allowed but logged at debug level.
 */
export function validateCandles(candles: Candle[]): ValidationResult {
  const valid: Candle[] = [];
  const rejected: Array<{ candle: Candle; reason: string }> = [];

  for (const candle of candles) {
    const reason = validateSingle(candle);
    if (reason) {
      rejected.push({ candle, reason });
    } else {
      valid.push(candle);
    }
  }

  log.info(
    { total: candles.length, valid: valid.length, rejected: rejected.length },
    'Validation complete',
  );

  if (rejected.length > 0) {
    for (const { candle, reason } of rejected.slice(0, 10)) {
      log.warn(
        { pair: candle.pair, timestamp: candle.timestamp, reason },
        'Candle rejected',
      );
    }
    if (rejected.length > 10) {
      log.warn(
        { remaining: rejected.length - 10 },
        'Additional rejected candles not shown',
      );
    }
  }

  return { valid, rejected };
}

/**
 * Validate a single candle. Returns a rejection reason string, or null if valid.
 */
function validateSingle(candle: Candle): string | null {
  // 1. Timestamp check: must be milliseconds
  if (candle.timestamp < 1_000_000_000_000) {
    return `Timestamp appears to be seconds, not milliseconds: ${candle.timestamp}`;
  }

  // Parse prices with Decimal for safe comparison
  const open = d(candle.open);
  const high = d(candle.high);
  const low = d(candle.low);
  const close = d(candle.close);
  const volume = d(candle.volume);

  // 2. Zero/negative price check
  if (open.lte(0)) return `Open price <= 0: ${candle.open}`;
  if (high.lte(0)) return `High price <= 0: ${candle.high}`;
  if (low.lte(0)) return `Low price <= 0: ${candle.low}`;
  if (close.lte(0)) return `Close price <= 0: ${candle.close}`;

  // 3. OHLC sanity: high >= low, high >= open, high >= close, low <= open, low <= close
  if (high.lt(low)) return `High (${candle.high}) < Low (${candle.low})`;
  if (high.lt(open)) return `High (${candle.high}) < Open (${candle.open})`;
  if (high.lt(close)) return `High (${candle.high}) < Close (${candle.close})`;
  if (low.gt(open)) return `Low (${candle.low}) > Open (${candle.open})`;
  if (low.gt(close)) return `Low (${candle.low}) > Close (${candle.close})`;

  // 4. Negative volume check
  if (volume.lt(0)) return `Negative volume: ${candle.volume}`;

  // 5. Zero volume: allow but log at debug level
  if (volume.eq(0)) {
    log.debug(
      { pair: candle.pair, timestamp: candle.timestamp },
      'Zero volume candle (allowed)',
    );
  }

  // 6. Extreme outlier check: |close - open| / open > 0.5 (50% move)
  const changeRatio = close.minus(open).abs().div(open);
  if (changeRatio.gt(0.5)) {
    log.warn(
      {
        pair: candle.pair,
        timestamp: candle.timestamp,
        open: candle.open,
        close: candle.close,
        changePercent: changeRatio.mul(100).toFixed(2),
      },
      'Extreme outlier detected (>50% single-candle move) -- rejecting',
    );
    return `Extreme outlier: ${changeRatio.mul(100).toFixed(2)}% move (open=${candle.open}, close=${candle.close})`;
  }

  return null;
}
