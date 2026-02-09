/**
 * Shared types used across the entire trading bot project.
 *
 * CRITICAL: All OHLCV values are strings to preserve decimal precision.
 * CRITICAL: All timestamps are Unix milliseconds UTC.
 */

export const ALL_PAIRS = ['BTC-USD', 'ETH-USD'] as const;
export type TradingPair = (typeof ALL_PAIRS)[number];

export const ALL_TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1D'] as const;
export type Timeframe = (typeof ALL_TIMEFRAMES)[number];

/**
 * OHLCV candle data.
 *
 * - `pair`: Trading pair (e.g., 'BTC-USD')
 * - `timeframe`: Candle timeframe (e.g., '1m', '1h', '1D')
 * - `timestamp`: Unix milliseconds UTC (start of candle)
 * - `open`, `high`, `low`, `close`: Price as string for decimal precision
 * - `volume`: Volume as string for decimal precision
 */
export interface Candle {
  pair: TradingPair;
  timeframe: Timeframe;
  timestamp: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

/** Maps each timeframe to its duration in minutes. */
export const TIMEFRAME_MINUTES: Record<Timeframe, number> = {
  '1m': 1,
  '5m': 5,
  '15m': 15,
  '1h': 60,
  '4h': 240,
  '1D': 1440,
};

/** Maps each timeframe to its duration in milliseconds. */
export const TIMEFRAME_MS: Record<Timeframe, number> = {
  '1m': 1 * 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '4h': 240 * 60_000,
  '1D': 1440 * 60_000,
};
