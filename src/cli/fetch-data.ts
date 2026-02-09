/**
 * CLI entry point for downloading candle data.
 *
 * Usage: npx tsx src/cli/fetch-data.ts
 *
 * Loads config from .env, initializes database, and runs the full
 * data pipeline for all configured trading pairs.
 *
 * Environment overrides:
 *   HISTORY_DAYS=7  -- limit fetch to 7 days of history
 *   TRADING_PAIRS=BTC-USD  -- limit to a single pair
 */

import { loadConfig } from '../core/config.js';
import { ConfigError } from '../core/errors.js';
import { createModuleLogger } from '../core/logger.js';
import { createDatabase, initializeSchema } from '../data/storage/db.js';
import { CandleRepository } from '../data/storage/candle-repo.js';
import { DataPipeline } from '../data/pipeline.js';

const log = createModuleLogger('fetch-data');

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

  log.info(
    {
      pairs: config.data.pairs,
      historyDays: config.data.historyDays,
      dbPath: config.database.path,
    },
    'Starting data fetch',
  );

  // Initialize database
  const { db, sqlite } = createDatabase(config.database.path);
  initializeSchema(sqlite);

  // Create repository and pipeline
  const repo = new CandleRepository(db);
  const pipeline = new DataPipeline(config, repo);

  try {
    await pipeline.runAllPairs();
    log.info('Data fetch complete');
  } catch (error) {
    log.error(
      { error: error instanceof Error ? error.message : String(error) },
      'Data fetch failed',
    );
    process.exit(1);
  } finally {
    sqlite.close();
    log.info('Database connection closed');
  }
}

main().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
