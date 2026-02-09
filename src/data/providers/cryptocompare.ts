/**
 * CryptoCompare data provider for supplementary hourly/daily backfill.
 *
 * Uses plain fetch() to call CryptoCompare REST API -- no SDK needed.
 * This is a supplementary provider: primary data comes from Coinbase.
 * CryptoCompare is used to fill gaps where Coinbase data is missing,
 * particularly for hourly and daily candles.
 *
 * CRITICAL: CryptoCompare API returns Unix seconds -- multiply by 1000.
 */

import type { Candle, TradingPair } from '../../core/types.js';
import { createModuleLogger } from '../../core/logger.js';
import { DataProviderError } from '../../core/errors.js';

const log = createModuleLogger('cryptocompare-provider');

/** CryptoCompare API base URL */
const BASE_URL = 'https://min-api.cryptocompare.com/data/v2';

/** Max candles per request */
const PAGE_LIMIT = 2000;

/** Milliseconds between requests */
const RATE_LIMIT_MS = 100;

/** Max retries on rate limit */
const MAX_RETRIES = 3;

/** Retry delay on rate limit */
const RETRY_DELAY_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse a TradingPair like 'BTC-USD' into fsym='BTC' and tsym='USD'.
 */
function parsePair(pair: TradingPair): { fsym: string; tsym: string } {
  const parts = pair.split('-');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new DataProviderError(
      `Invalid trading pair format: ${pair}. Expected 'XXX-YYY'.`,
      'cryptocompare',
    );
  }
  return { fsym: parts[0], tsym: parts[1] };
}

interface CryptoCompareDataPoint {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volumefrom: number;
}

interface CryptoCompareResponse {
  Response: string;
  Message: string;
  Data: {
    Data: CryptoCompareDataPoint[];
    TimeFrom: number;
    TimeTo: number;
  };
}

export class CryptoCompareProvider {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    log.info('CryptoCompareProvider initialized');
  }

  /**
   * Fetch hourly candles from CryptoCompare histohour endpoint.
   *
   * @param pair - Trading pair (e.g., 'BTC-USD')
   * @param startMs - Start of range in Unix milliseconds
   * @param endMs - End of range in Unix milliseconds
   * @returns Array of hourly candles sorted by timestamp ascending
   */
  async fetchHourlyCandles(
    pair: TradingPair,
    startMs: number,
    endMs: number,
  ): Promise<Candle[]> {
    return this.fetchCandles(pair, startMs, endMs, 'histohour', '1h');
  }

  /**
   * Fetch daily candles from CryptoCompare histoday endpoint.
   *
   * @param pair - Trading pair (e.g., 'BTC-USD')
   * @param startMs - Start of range in Unix milliseconds
   * @param endMs - End of range in Unix milliseconds
   * @returns Array of daily candles sorted by timestamp ascending
   */
  async fetchDailyCandles(
    pair: TradingPair,
    startMs: number,
    endMs: number,
  ): Promise<Candle[]> {
    return this.fetchCandles(pair, startMs, endMs, 'histoday', '1D');
  }

  /**
   * Generic candle fetcher for a given endpoint and timeframe.
   * Paginates using `toTs` parameter (Unix seconds), up to PAGE_LIMIT per request.
   */
  private async fetchCandles(
    pair: TradingPair,
    startMs: number,
    endMs: number,
    endpoint: 'histohour' | 'histoday',
    timeframe: '1h' | '1D',
  ): Promise<Candle[]> {
    const { fsym, tsym } = parsePair(pair);
    const allCandles: Candle[] = [];
    const startSec = Math.floor(startMs / 1000);

    let toTsSec = Math.floor(endMs / 1000);
    let batchCount = 0;

    log.info(
      { pair, startMs, endMs, endpoint, timeframe },
      'Starting CryptoCompare candle fetch',
    );

    while (toTsSec > startSec) {
      const url = `${BASE_URL}/${endpoint}?fsym=${fsym}&tsym=${tsym}&limit=${PAGE_LIMIT}&toTs=${toTsSec}&api_key=${this.apiKey}`;

      let data: CryptoCompareResponse | null = null;
      let retries = 0;

      while (retries <= MAX_RETRIES) {
        try {
          const response = await fetch(url);

          if (response.status === 429) {
            retries++;
            if (retries > MAX_RETRIES) {
              throw new DataProviderError(
                `Rate limited after ${MAX_RETRIES} retries for ${pair} (${endpoint})`,
                'cryptocompare',
                429,
              );
            }
            log.warn(
              { pair, retry: retries, maxRetries: MAX_RETRIES },
              'CryptoCompare rate limited, waiting',
            );
            await sleep(RETRY_DELAY_MS);
            continue;
          }

          if (!response.ok) {
            throw new DataProviderError(
              `CryptoCompare HTTP ${response.status} for ${pair} (${endpoint})`,
              'cryptocompare',
              response.status,
            );
          }

          data = (await response.json()) as CryptoCompareResponse;

          if (data.Response === 'Error') {
            throw new DataProviderError(
              `CryptoCompare API error: ${data.Message}`,
              'cryptocompare',
            );
          }

          break; // Success
        } catch (error: unknown) {
          if (error instanceof DataProviderError) {
            throw error;
          }
          throw new DataProviderError(
            `CryptoCompare fetch error for ${pair}: ${error instanceof Error ? error.message : String(error)}`,
            'cryptocompare',
          );
        }
      }

      if (!data || !data.Data || !data.Data.Data || data.Data.Data.length === 0) {
        break; // No more data
      }

      const points = data.Data.Data;
      let earliestSec = Infinity;

      for (const point of points) {
        const timestampMs = point.time * 1000;

        // Only include candles within our requested range
        if (timestampMs < startMs || timestampMs > endMs) {
          continue;
        }

        allCandles.push({
          pair,
          timeframe,
          timestamp: timestampMs,
          open: point.open.toString(),
          high: point.high.toString(),
          low: point.low.toString(),
          close: point.close.toString(),
          volume: point.volumefrom.toString(),
        });

        if (point.time < earliestSec) {
          earliestSec = point.time;
        }
      }

      batchCount++;

      // Move the pagination window backward
      // Set toTs to the earliest timestamp we received minus 1 second
      if (earliestSec === Infinity || earliestSec <= startSec) {
        break;
      }
      toTsSec = earliestSec - 1;

      // Rate limiting
      await sleep(RATE_LIMIT_MS);
    }

    // Sort by timestamp ascending
    allCandles.sort((a, b) => a.timestamp - b.timestamp);

    log.info(
      { pair, timeframe, totalCandles: allCandles.length, batches: batchCount },
      'CryptoCompare candle fetch complete',
    );

    return allCandles;
  }
}
