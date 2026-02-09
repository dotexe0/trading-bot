/**
 * Adapter functions that convert Candle[] (string OHLCV) to the
 * number arrays expected by fast-technical-indicators.
 *
 * Assumes candles are already sorted ascending by timestamp
 * (matching CandleRepository.getCandles behavior).
 */

import type { Candle } from '../core/types.js';

/** Extract close prices as a number array. */
export function extractCloses(candles: Candle[]): number[] {
  return candles.map((c) => parseFloat(c.close));
}

/** Extract open, high, low, close as parallel number arrays. */
export function extractOHLC(candles: Candle[]): {
  open: number[];
  high: number[];
  low: number[];
  close: number[];
} {
  return {
    open: candles.map((c) => parseFloat(c.open)),
    high: candles.map((c) => parseFloat(c.high)),
    low: candles.map((c) => parseFloat(c.low)),
    close: candles.map((c) => parseFloat(c.close)),
  };
}
