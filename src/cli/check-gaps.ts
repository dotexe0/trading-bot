/**
 * CLI entry point for gap detection and data quality reporting.
 *
 * Usage: npx tsx src/cli/check-gaps.ts
 *
 * Loads config, opens the database, and reports data quality for each
 * configured pair at the 1m timeframe: total candles, date range,
 * gaps found, fillable vs unfillable classification.
 *
 * Exit codes:
 *   0 - No unfillable gaps found
 *   1 - Unfillable gaps exist (need re-fetch or investigation)
 */

import { loadConfig } from '../core/config.js';
import { ConfigError } from '../core/errors.js';
import { createModuleLogger } from '../core/logger.js';
import { TIMEFRAME_MS } from '../core/types.js';
import { createDatabase, initializeSchema } from '../data/storage/db.js';
import { CandleRepository } from '../data/storage/candle-repo.js';
import { detectGaps, classifyGaps } from '../data/gap-detector.js';

const log = createModuleLogger('check-gaps');

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      log.error({ error: error.message }, 'Configuration error');
      process.exit(1);
    }
    throw error;
  }

  // Initialize database (read-only operation, but we still init schema in case)
  const { db, sqlite } = createDatabase(config.database.path);
  initializeSchema(sqlite);

  const repo = new CandleRepository(db);
  let hasUnfillable = false;

  for (const pair of config.data.pairs) {
    log.info({ pair }, 'Checking data quality');

    const count = repo.getCandleCount(pair, '1m');
    const earliest = repo.getEarliestTimestamp(pair, '1m');
    const latest = repo.getLatestTimestamp(pair, '1m');

    if (count === 0) {
      log.warn({ pair }, 'No 1m candles found -- run fetch-data first');
      continue;
    }

    // Report basic stats
    log.info(
      {
        pair,
        totalCandles: count,
        dateRange: {
          from: earliest ? new Date(earliest).toISOString() : 'N/A',
          to: latest ? new Date(latest).toISOString() : 'N/A',
        },
      },
      'Data summary',
    );

    // Run gap detection
    const timestamps = repo.getTimestamps(pair, '1m');
    const gaps = detectGaps(timestamps, TIMEFRAME_MS['1m'], pair, '1m');

    if (gaps.length === 0) {
      log.info({ pair }, 'No gaps detected -- data is continuous');
      continue;
    }

    const { fillable, unfillable } = classifyGaps(gaps);

    // Report fillable gaps
    if (fillable.length > 0) {
      const totalFillableMissing = fillable.reduce(
        (sum, g) => sum + g.missingCount,
        0,
      );
      log.info(
        {
          pair,
          fillableGaps: fillable.length,
          totalMissing: totalFillableMissing,
        },
        'Fillable gaps (< 60 min) -- may resolve on next fetch',
      );
    }

    // Report unfillable gaps
    if (unfillable.length > 0) {
      hasUnfillable = true;
      const totalUnfillableMissing = unfillable.reduce(
        (sum, g) => sum + g.missingCount,
        0,
      );
      log.warn(
        {
          pair,
          unfillableGaps: unfillable.length,
          totalMissing: totalUnfillableMissing,
        },
        'Unfillable gaps (> 60 min) -- needs investigation',
      );

      // Show details for first 5 unfillable gaps
      for (const gap of unfillable.slice(0, 5)) {
        log.warn(
          {
            pair,
            from: new Date(gap.startMs).toISOString(),
            to: new Date(gap.endMs).toISOString(),
            missingCandles: gap.missingCount,
            durationHours: ((gap.endMs - gap.startMs) / 3_600_000).toFixed(1),
          },
          'Unfillable gap detail',
        );
      }
      if (unfillable.length > 5) {
        log.warn(
          { remaining: unfillable.length - 5 },
          'Additional unfillable gaps not shown',
        );
      }
    }

    // Report all timeframe candle counts
    const timeframes = ['1m', '5m', '15m', '1h', '4h', '1D'] as const;
    const counts: Record<string, number> = {};
    for (const tf of timeframes) {
      counts[tf] = repo.getCandleCount(pair, tf);
    }
    log.info({ pair, candleCounts: counts }, 'Candle counts by timeframe');
  }

  sqlite.close();

  if (hasUnfillable) {
    log.warn('Unfillable gaps found -- exiting with code 1');
    process.exit(1);
  } else {
    log.info('Data quality check passed -- no unfillable gaps');
    process.exit(0);
  }
}

main().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
