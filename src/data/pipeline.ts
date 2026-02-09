/**
 * Data pipeline orchestrator.
 *
 * Coordinates the full data flow:
 * fetch -> validate -> store -> detect gaps -> fill gaps -> aggregate
 *
 * Supports incremental updates: only fetches candles newer than what is stored.
 * Uses CoinbaseProvider as primary source, with optional CryptoCompareProvider
 * for supplementary gap filling.
 */

import type { Config } from '../core/config.js';
import type { Candle, TradingPair, Timeframe } from '../core/types.js';
import { TIMEFRAME_MS } from '../core/types.js';
import { createModuleLogger } from '../core/logger.js';
import { CoinbaseProvider } from './providers/coinbase.js';
import { CryptoCompareProvider } from './providers/cryptocompare.js';
import type { CandleRepository } from './storage/candle-repo.js';
import { validateCandles } from './validator.js';
import { detectGaps, classifyGaps } from './gap-detector.js';
import { aggregateAllTimeframes } from './aggregator.js';

const log = createModuleLogger('pipeline');

export class DataPipeline {
  private coinbase: CoinbaseProvider;
  private cryptoCompare: CryptoCompareProvider | null;
  private repo: CandleRepository;
  private config: Config;

  constructor(config: Config, repo: CandleRepository) {
    this.config = config;
    this.repo = repo;

    this.coinbase = new CoinbaseProvider(
      config.coinbase.apiKeyName,
      config.coinbase.apiKeySecret,
    );

    this.cryptoCompare =
      config.cryptoCompare.apiKey.length > 0
        ? new CryptoCompareProvider(config.cryptoCompare.apiKey)
        : null;

    log.info(
      { hasCryptoCompare: this.cryptoCompare !== null },
      'DataPipeline initialized',
    );
  }

  /**
   * Run the full pipeline for a single trading pair:
   * 1. Determine fetch range (full or incremental)
   * 2. Fetch 1m candles from Coinbase
   * 3. Validate fetched candles
   * 4. Store valid candles
   * 5. Detect and attempt to fill gaps
   * 6. Aggregate to all higher timeframes
   * 7. Store aggregated candles
   */
  async runFull(pair: TradingPair): Promise<void> {
    const endMs = Date.now();
    const fullStartMs = endMs - this.config.data.historyDays * 86_400_000;

    // Check for existing data for incremental updates
    const latestTimestamp = this.repo.getLatestTimestamp(pair, '1m');
    let startMs: number;

    if (latestTimestamp !== null) {
      // Incremental update: fetch from latest stored candle to now
      startMs = latestTimestamp;
      log.info(
        {
          pair,
          mode: 'incremental',
          from: new Date(startMs).toISOString(),
          to: new Date(endMs).toISOString(),
        },
        'Incremental update from last stored candle',
      );
    } else {
      // Full historical fetch
      startMs = fullStartMs;
      log.info(
        {
          pair,
          mode: 'full',
          historyDays: this.config.data.historyDays,
          from: new Date(startMs).toISOString(),
          to: new Date(endMs).toISOString(),
        },
        'Full historical fetch',
      );
    }

    // Step 1: Fetch 1m candles from Coinbase
    log.info({ pair }, 'Fetching 1m candles from Coinbase');
    const rawCandles = await this.coinbase.fetchCandles(pair, startMs, endMs);
    log.info({ pair, rawFetched: rawCandles.length }, 'Raw candles fetched');

    // Step 2: Validate
    const { valid, rejected } = validateCandles(rawCandles);
    log.info(
      { pair, valid: valid.length, rejected: rejected.length },
      'Candle validation complete',
    );

    // Step 3: Store valid candles
    const insertedCount = this.repo.insertCandles(valid);
    log.info(
      { pair, stored: insertedCount, duplicatesSkipped: valid.length - insertedCount },
      'Candles stored',
    );

    // Step 4: Gap detection on all stored 1m data
    const allTimestamps = this.repo.getTimestamps(pair, '1m');
    const gaps = detectGaps(
      allTimestamps,
      TIMEFRAME_MS['1m'],
      pair,
      '1m',
    );

    let gapsFilled = 0;

    if (gaps.length > 0) {
      const { fillable, unfillable } = classifyGaps(gaps);

      // Step 5a: Attempt to fill fillable gaps by re-fetching from Coinbase
      for (const gap of fillable) {
        try {
          log.info(
            {
              pair,
              gapStart: new Date(gap.startMs).toISOString(),
              gapEnd: new Date(gap.endMs).toISOString(),
              missing: gap.missingCount,
            },
            'Attempting to fill gap from Coinbase',
          );

          const gapCandles = await this.coinbase.fetchCandles(
            pair,
            gap.startMs,
            gap.endMs,
          );

          if (gapCandles.length > 0) {
            const { valid: validGap } = validateCandles(gapCandles);
            const gapInserted = this.repo.insertCandles(validGap);
            gapsFilled += gapInserted;
            log.info(
              { pair, gapFilled: gapInserted },
              'Gap filled',
            );
          }
        } catch (error) {
          log.warn(
            {
              pair,
              gapStart: gap.startMs,
              gapEnd: gap.endMs,
              error: error instanceof Error ? error.message : String(error),
            },
            'Failed to fill gap',
          );
        }
      }

      // Step 5b: Log unfillable gaps
      for (const gap of unfillable) {
        log.warn(
          {
            pair,
            gapStart: new Date(gap.startMs).toISOString(),
            gapEnd: new Date(gap.endMs).toISOString(),
            missingCandles: gap.missingCount,
            durationHours: ((gap.endMs - gap.startMs) / 3_600_000).toFixed(1),
          },
          'Unfillable gap detected (>60 min) -- needs manual investigation',
        );
      }
    }

    // Step 6: Aggregate 1m candles to all higher timeframes
    // Fetch all stored 1m candles for aggregation
    const earliest = this.repo.getEarliestTimestamp(pair, '1m');
    const latest = this.repo.getLatestTimestamp(pair, '1m');

    if (earliest !== null && latest !== null) {
      const allMinuteCandles = this.repo.getCandles(
        pair,
        '1m',
        earliest,
        latest,
      );

      log.info(
        { pair, minuteCandles: allMinuteCandles.length },
        'Aggregating to higher timeframes',
      );

      const aggregated = aggregateAllTimeframes(allMinuteCandles, pair);

      // Step 7: Store aggregated candles
      let totalAggregated = 0;
      for (const [timeframe, candles] of aggregated) {
        const aggInserted = this.repo.insertCandles(candles);
        totalAggregated += aggInserted;
        log.info(
          { pair, timeframe, stored: aggInserted, total: candles.length },
          'Aggregated candles stored',
        );
      }

      log.info(
        {
          pair,
          rawFetched: rawCandles.length,
          valid: valid.length,
          rejected: rejected.length,
          stored: insertedCount,
          gapsFound: gaps.length,
          gapsFilled,
          totalAggregated,
        },
        'Pipeline complete for pair',
      );
    } else {
      log.warn({ pair }, 'No 1m candles found after fetch -- skipping aggregation');
    }
  }

  /**
   * Run the full pipeline for all configured trading pairs.
   */
  async runAllPairs(): Promise<void> {
    const pairs = this.config.data.pairs;
    log.info({ pairs }, 'Running pipeline for all pairs');

    for (const pair of pairs) {
      try {
        await this.runFull(pair);
      } catch (error) {
        log.error(
          {
            pair,
            error: error instanceof Error ? error.message : String(error),
          },
          'Pipeline failed for pair',
        );
        // Continue with next pair rather than failing entirely
      }
    }

    log.info('Pipeline complete for all pairs');
  }
}
