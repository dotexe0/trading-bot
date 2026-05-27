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
import type { CandleGranularity } from './providers/coinbase.js';
import { CryptoCompareProvider } from './providers/cryptocompare.js';
import type { CandleRepository } from './storage/candle-repo.js';
import { validateCandles } from './validator.js';
import { detectGaps, classifyGaps } from './gap-detector.js';
import { aggregateCandles } from './aggregator.js';

const log = createModuleLogger('pipeline');

/** Timeframes aggregated from 1m candles (coarse frames come from native fetch). */
const SCALPING_TIMEFRAMES: Timeframe[] = ['5m', '15m'];

/** Native granularities fetched directly from Coinbase, with their stored timeframe. */
const NATIVE_FETCHES: ReadonlyArray<{ granularity: CandleGranularity; timeframe: Timeframe }> = [
  { granularity: 'ONE_HOUR', timeframe: '1h' },
  { granularity: 'ONE_DAY', timeframe: '1D' },
];

/**
 * Minimal candle-fetching contract DataPipeline depends on.
 * Declared as an interface so tests can inject a mock provider.
 */
export interface CandleFetcher {
  fetchCandles(
    pair: TradingPair,
    startMs: number,
    endMs: number,
    granularity?: CandleGranularity,
  ): Promise<Candle[]>;
}

export class DataPipeline {
  private coinbase: CandleFetcher;
  private cryptoCompare: CryptoCompareProvider | null;
  private repo: CandleRepository;
  private config: Config;

  /**
   * @param coinbase - Optional injected candle fetcher (for testing);
   *                   defaults to a real CoinbaseProvider built from config.
   */
  constructor(config: Config, repo: CandleRepository, coinbase?: CandleFetcher) {
    this.config = config;
    this.repo = repo;

    this.coinbase =
      coinbase ??
      new CoinbaseProvider(
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
   * 6. Aggregate 1m → 5m/15m only (coarse frames come from native fetch)
   * 7. Fetch native 1h and 1D directly (sole source — lifts the ~113-day 1m ceiling)
   * 8. Derive 4h from the stored native 1h
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

    // Step 6: Aggregate 1m candles to scalping timeframes only (5m/15m).
    // 1h/1D are no longer derived from 1m — they come from the native fetch below.
    const earliest = this.repo.getEarliestTimestamp(pair, '1m');
    const latest = this.repo.getLatestTimestamp(pair, '1m');
    let totalAggregated = 0;

    if (earliest !== null && latest !== null) {
      const allMinuteCandles = this.repo.getCandles(pair, '1m', earliest, latest);

      log.info(
        { pair, minuteCandles: allMinuteCandles.length },
        'Aggregating 1m to scalping timeframes (5m/15m)',
      );

      for (const timeframe of SCALPING_TIMEFRAMES) {
        const candles = aggregateCandles(allMinuteCandles, timeframe);
        const aggInserted = this.repo.insertCandles(candles);
        totalAggregated += aggInserted;
        log.info(
          { pair, timeframe, stored: aggInserted, total: candles.length },
          'Aggregated candles stored',
        );
      }
    } else {
      log.warn({ pair }, 'No 1m candles found after fetch -- skipping 5m/15m aggregation');
    }

    // Step 7: Fetch native 1h and 1D directly (sole source for those frames).
    for (const { granularity, timeframe } of NATIVE_FETCHES) {
      await this.syncNativeTimeframe(pair, granularity, timeframe);
    }

    // Step 8: Derive 4h from the stored native 1h candles.
    const fourHourStored = this.derive4hFromNativeHourly(pair);

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
        fourHourStored,
      },
      'Pipeline complete for pair',
    );
  }

  /**
   * Fetch a native higher-timeframe (1h or 1D) directly from Coinbase and store it.
   *
   * Two complementary passes, because a DB may already hold shallow candles for
   * this frame (e.g. the old 1m-aggregation era) — a forward-only resume would
   * top up recent candles but never lift the history ceiling:
   *
   *   1. Forward top-up: from the latest stored candle to now (catch up since last sync).
   *   2. Backward backfill: from the `nativeHistoryDays` target up to the earliest
   *      stored candle, extending deep history. fetch-until-empty self-limits once
   *      Coinbase's true retention edge is reached, so steady-state runs are cheap.
   *
   * Native candles already carry the correct timeframe tag, and INSERT OR IGNORE
   * dedupes any overlap. A fetch failure logs and preserves existing data (never wipes).
   */
  private async syncNativeTimeframe(
    pair: TradingPair,
    granularity: CandleGranularity,
    timeframe: Timeframe,
  ): Promise<void> {
    const endMs = Date.now();
    const targetStartMs = endMs - this.config.data.nativeHistoryDays * 86_400_000;
    const latest = this.repo.getLatestTimestamp(pair, timeframe);
    const earliest = this.repo.getEarliestTimestamp(pair, timeframe);

    // Pass 1: forward top-up from the latest stored candle (skip when no data yet).
    if (latest !== null) {
      await this.fetchNativeRange(pair, granularity, timeframe, latest, endMs, 'forward');
    }

    // Pass 2: backward backfill toward the native target. When the DB is empty
    // this is the full fetch; when shallow data exists it extends deeper; once
    // Coinbase's retention edge is reached it returns empty almost immediately.
    if (earliest === null || earliest > targetStartMs) {
      const backfillEndMs = earliest ?? endMs;
      await this.fetchNativeRange(
        pair,
        granularity,
        timeframe,
        targetStartMs,
        backfillEndMs,
        'backfill',
      );
    }
  }

  /**
   * Fetch a native candle range and store the valid candles. Failures are logged
   * and swallowed so one bad pass never wipes or aborts the rest of the sync.
   */
  private async fetchNativeRange(
    pair: TradingPair,
    granularity: CandleGranularity,
    timeframe: Timeframe,
    startMs: number,
    endMs: number,
    mode: 'forward' | 'backfill',
  ): Promise<void> {
    log.info(
      {
        pair,
        timeframe,
        granularity,
        mode,
        from: new Date(startMs).toISOString(),
        to: new Date(endMs).toISOString(),
      },
      'Fetching native candles from Coinbase',
    );

    try {
      const native = await this.coinbase.fetchCandles(pair, startMs, endMs, granularity);
      const { valid, rejected } = validateCandles(native);
      const inserted = this.repo.insertCandles(valid);
      log.info(
        { pair, timeframe, mode, fetched: native.length, valid: valid.length, rejected: rejected.length, stored: inserted },
        'Native candles stored',
      );
    } catch (error) {
      log.error(
        {
          pair,
          timeframe,
          granularity,
          mode,
          error: error instanceof Error ? error.message : String(error),
        },
        'Native fetch failed -- preserving existing stored data',
      );
    }
  }

  /**
   * Aggregate the stored native 1h candles into 4h and store them.
   * Coinbase has no native 4h granularity, so it is derived from 1h.
   *
   * @returns Number of 4h candles newly stored
   */
  private derive4hFromNativeHourly(pair: TradingPair): number {
    const earliest = this.repo.getEarliestTimestamp(pair, '1h');
    const latest = this.repo.getLatestTimestamp(pair, '1h');

    if (earliest === null || latest === null) {
      log.warn({ pair }, 'No native 1h candles -- skipping 4h derivation');
      return 0;
    }

    const hourly = this.repo.getCandles(pair, '1h', earliest, latest);
    const fourHour = aggregateCandles(hourly, '4h');
    const inserted = this.repo.insertCandles(fourHour);
    log.info(
      { pair, hourlyCandles: hourly.length, stored: inserted, total: fourHour.length },
      '4h derived from native 1h and stored',
    );
    return inserted;
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
