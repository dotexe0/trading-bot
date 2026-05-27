/**
 * Coinbase Advanced Trade API data provider.
 *
 * Fetches paginated 1-minute candles with rate limiting, retry on 429,
 * and timestamp normalization (API returns Unix seconds, we store Unix milliseconds).
 *
 * CRITICAL: Coinbase API `start` and `end` params are Unix seconds strings.
 * CRITICAL: Coinbase API response `start` field is Unix seconds -- multiply by 1000.
 */

import { CBAdvancedTradeClient } from 'coinbase-api';
import type { Candle, TradingPair, Timeframe } from '../../core/types.js';
import { createModuleLogger } from '../../core/logger.js';
import { DataProviderError } from '../../core/errors.js';

const log = createModuleLogger('coinbase-provider');

/** Number of candles per request (Coinbase max is 350) */
const BATCH_SIZE = 350;

/** Milliseconds between requests (~28 req/sec with safety margin) */
const RATE_LIMIT_MS = 35;

/** Milliseconds to wait on HTTP 429 */
const RETRY_DELAY_MS = 2000;

/** Maximum retries per batch on rate limit */
const MAX_RETRIES = 3;

/**
 * Coinbase candle granularities we fetch natively.
 * 1m powers the recent-history pipeline; 1h/1D are fetched directly because
 * Coinbase retains them far longer than 1m, lifting the history ceiling.
 */
export type CandleGranularity = 'ONE_MINUTE' | 'ONE_HOUR' | 'ONE_DAY';

/** Duration of one candle, in seconds, for each granularity. */
const GRANULARITY_SECONDS: Record<CandleGranularity, number> = {
  ONE_MINUTE: 60,
  ONE_HOUR: 3_600,
  ONE_DAY: 86_400,
};

/** The stored `Timeframe` each granularity maps to. */
const GRANULARITY_TIMEFRAME: Record<CandleGranularity, Timeframe> = {
  ONE_MINUTE: '1m',
  ONE_HOUR: '1h',
  ONE_DAY: '1D',
};

/** Raw candle as returned by Coinbase (start is Unix *seconds* string). */
interface RawCandle {
  start: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

/**
 * Minimal slice of the Coinbase client this provider depends on.
 * Declared as an interface so tests can inject a mock without real credentials.
 */
export interface ProductCandlesClient {
  getProductCandles(params: {
    product_id: string;
    start: string;
    end: string;
    granularity: string;
  }): Promise<{ candles?: RawCandle[] }>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class CoinbaseProvider {
  private client: ProductCandlesClient;

  /**
   * @param apiKeyName - Coinbase API key name (ignored when `client` is injected)
   * @param apiKeySecret - Coinbase API key secret (ignored when `client` is injected)
   * @param client - Optional injected client (for testing); defaults to a real CBAdvancedTradeClient
   */
  constructor(
    apiKeyName: string,
    apiKeySecret: string,
    client?: ProductCandlesClient,
  ) {
    this.client =
      client ??
      (new CBAdvancedTradeClient({
        apiKey: apiKeyName,
        apiSecret: apiKeySecret,
      }) as unknown as ProductCandlesClient);
    log.info('CoinbaseProvider initialized');
  }

  /**
   * Fetch candles for a trading pair over a time range at a given granularity.
   *
   * Walks backward from endMs to startMs, fetching BATCH_SIZE candles per request.
   * Handles rate limiting with 35ms sleep between requests and retry on 429.
   *
   * The walk terminates when the start bound is reached **or** a batch comes back
   * empty — the latter auto-discovers Coinbase's true retention limit at runtime
   * (it retains native 1h/1D far longer than 1m). Window size scales with the
   * granularity (a 350-candle batch spans 350 minutes, hours, or days).
   *
   * @param pair - Trading pair (e.g., 'BTC-USD')
   * @param startMs - Start of range in Unix milliseconds (inclusive)
   * @param endMs - End of range in Unix milliseconds (inclusive)
   * @param granularity - Candle granularity (default 'ONE_MINUTE')
   * @returns Array of candles sorted by timestamp ascending
   */
  async fetchCandles(
    pair: TradingPair,
    startMs: number,
    endMs: number,
    granularity: CandleGranularity = 'ONE_MINUTE',
  ): Promise<Candle[]> {
    const allCandles: Candle[] = [];
    const startSec = Math.floor(startMs / 1000);
    const endSec = Math.floor(endMs / 1000);
    const stepSec = GRANULARITY_SECONDS[granularity];
    const timeframe = GRANULARITY_TIMEFRAME[granularity];

    // Walk backward from endSec to startSec in BATCH_SIZE-candle windows
    let currentEndSec = endSec;
    let batchCount = 0;
    const totalEstimate = Math.ceil(
      (endSec - startSec) / (BATCH_SIZE * stepSec),
    );

    log.info(
      { pair, startMs, endMs, granularity, totalBatchEstimate: totalEstimate },
      'Starting candle fetch',
    );

    while (currentEndSec > startSec) {
      const currentStartSec = Math.max(
        startSec,
        currentEndSec - BATCH_SIZE * stepSec,
      );

      let retries = 0;
      let batch: Candle[] | null = null;

      while (retries <= MAX_RETRIES) {
        try {
          const response = await this.client.getProductCandles({
            product_id: pair,
            start: String(currentStartSec),
            end: String(currentEndSec),
            granularity,
          });

          batch = (response.candles || []).map((c) => {
            const timestampMs = Number(c.start) * 1000;

            // Assertion: timestamp must be in milliseconds
            if (timestampMs < 1_000_000_000_000) {
              throw new DataProviderError(
                `Timestamp appears to be seconds, not milliseconds: ${timestampMs} (raw start: ${c.start})`,
                'coinbase',
              );
            }

            return {
              pair,
              timeframe,
              timestamp: timestampMs,
              open: c.open,
              high: c.high,
              low: c.low,
              close: c.close,
              volume: c.volume,
            };
          });

          break; // Success -- exit retry loop
        } catch (error: unknown) {
          // Check for rate limiting (HTTP 429)
          if (
            error instanceof Error &&
            (error.message.includes('429') ||
              error.message.includes('rate limit') ||
              error.message.includes('Too Many Requests'))
          ) {
            retries++;
            if (retries > MAX_RETRIES) {
              throw new DataProviderError(
                `Rate limited after ${MAX_RETRIES} retries for ${pair} at ${currentStartSec}-${currentEndSec}`,
                'coinbase',
                429,
              );
            }
            log.warn(
              { pair, retry: retries, maxRetries: MAX_RETRIES },
              'Rate limited, waiting before retry',
            );
            await sleep(RETRY_DELAY_MS);
            continue;
          }

          // Re-throw DataProviderError as-is
          if (error instanceof DataProviderError) {
            throw error;
          }

          // Wrap other errors
          throw new DataProviderError(
            `Coinbase API error for ${pair}: ${error instanceof Error ? error.message : String(error)}`,
            'coinbase',
          );
        }
      }

      if (batch) {
        allCandles.push(...batch);
      }

      batchCount++;

      // Fetch-until-empty: an empty batch means we have walked past Coinbase's
      // retention edge for this granularity — older data does not exist, so stop.
      if (batch !== null && batch.length === 0) {
        log.info(
          { pair, granularity, fetched: allCandles.length, batches: batchCount },
          'Empty batch reached — terminating backward walk at retention edge',
        );
        break;
      }

      // Log progress every 100 batches
      if (batchCount % 100 === 0) {
        const percent =
          totalEstimate > 0
            ? Math.round((batchCount / totalEstimate) * 100)
            : 0;
        log.info(
          { pair, fetched: allCandles.length, totalBatchEstimate: totalEstimate, percent },
          'Fetch progress',
        );
      }

      // Move window backward
      currentEndSec = currentStartSec;

      // Rate limiting between requests
      await sleep(RATE_LIMIT_MS);
    }

    // Sort by timestamp ascending
    allCandles.sort((a, b) => a.timestamp - b.timestamp);

    log.info(
      { pair, totalCandles: allCandles.length, batches: batchCount },
      'Candle fetch complete',
    );

    return allCandles;
  }
}
