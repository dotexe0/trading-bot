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
import type { Candle, TradingPair } from '../../core/types.js';
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

/** One minute in seconds */
const ONE_MINUTE_SEC = 60;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class CoinbaseProvider {
  private client: CBAdvancedTradeClient;

  constructor(apiKeyName: string, apiKeySecret: string) {
    this.client = new CBAdvancedTradeClient({
      apiKey: apiKeyName,
      apiSecret: apiKeySecret,
    });
    log.info('CoinbaseProvider initialized');
  }

  /**
   * Fetch 1-minute candles for a trading pair over a time range.
   *
   * Walks backward from endMs to startMs, fetching BATCH_SIZE candles per request.
   * Handles rate limiting with 35ms sleep between requests and retry on 429.
   *
   * @param pair - Trading pair (e.g., 'BTC-USD')
   * @param startMs - Start of range in Unix milliseconds (inclusive)
   * @param endMs - End of range in Unix milliseconds (inclusive)
   * @returns Array of candles sorted by timestamp ascending
   */
  async fetchCandles(
    pair: TradingPair,
    startMs: number,
    endMs: number,
  ): Promise<Candle[]> {
    const allCandles: Candle[] = [];
    const startSec = Math.floor(startMs / 1000);
    const endSec = Math.floor(endMs / 1000);

    // Walk backward from endSec to startSec in BATCH_SIZE-minute windows
    let currentEndSec = endSec;
    let batchCount = 0;
    const totalEstimate = Math.ceil(
      (endSec - startSec) / (BATCH_SIZE * ONE_MINUTE_SEC),
    );

    log.info(
      { pair, startMs, endMs, totalBatchEstimate: totalEstimate },
      'Starting candle fetch',
    );

    while (currentEndSec > startSec) {
      const currentStartSec = Math.max(
        startSec,
        currentEndSec - BATCH_SIZE * ONE_MINUTE_SEC,
      );

      let retries = 0;
      let batch: Candle[] | null = null;

      while (retries <= MAX_RETRIES) {
        try {
          const response = await this.client.getProductCandles({
            product_id: pair,
            start: String(currentStartSec),
            end: String(currentEndSec),
            granularity: 'ONE_MINUTE',
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
              timeframe: '1m' as const,
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
