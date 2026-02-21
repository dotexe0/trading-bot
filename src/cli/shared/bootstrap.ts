/**
 * Shared bootstrap for CLI entry points.
 *
 * Loads config, initializes database, creates candle repository,
 * strategy registry, and indicator engine. Mirrors the setup
 * pattern from src/cli/fetch-data.ts.
 */

import type { Config } from '../../core/config.js';
import { loadConfig } from '../../core/config.js';
import { ConfigError } from '../../core/errors.js';
import { createDatabase, initializeSchema } from '../../data/storage/db.js';
import { CandleRepository } from '../../data/storage/candle-repo.js';
import { createDefaultRegistry, StrategyRegistry } from '../../strategies/index.js';
import { IndicatorEngine } from '../../indicators/engine.js';
import { out } from './output.js';
import type { DatabaseConnection } from '../../data/storage/db.js';

export interface BootstrapResult {
  config: Config;
  dbConn: DatabaseConnection;
  repo: CandleRepository;
  registry: StrategyRegistry;
  indicatorEngine: IndicatorEngine;
}

/**
 * Bootstrap shared infrastructure for CLI commands.
 *
 * Loads config from .env, initializes database, creates candle repo,
 * strategy registry, and indicator engine. Exits with code 1 on
 * config validation failure.
 */
export function bootstrap(): BootstrapResult {
  let config: Config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      out.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  const { db, sqlite } = createDatabase(config.database.path);
  initializeSchema(sqlite);

  const repo = new CandleRepository(db);
  const registry = createDefaultRegistry();
  const indicatorEngine = new IndicatorEngine();

  return { config, dbConn: { db, sqlite }, repo, registry, indicatorEngine };
}
