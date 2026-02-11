/**
 * Database connection factory with WAL mode and performance pragmas.
 *
 * Creates a SQLite database via better-sqlite3, configures it for
 * performance (WAL, memory temp store, 64MB cache), and wraps it
 * with Drizzle ORM for type-safe queries.
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { createModuleLogger } from '../../core/logger.js';
import * as schema from './schema.js';

const log = createModuleLogger('database');

export interface DatabaseConnection {
  db: BetterSQLite3Database<typeof schema>;
  sqlite: Database.Database;
}

/**
 * Create and configure a SQLite database connection.
 *
 * @param dbPath - Path to the SQLite database file
 * @returns Object with db (Drizzle instance) and sqlite (raw better-sqlite3 instance)
 */
export function createDatabase(dbPath: string): DatabaseConnection {
  // Ensure parent directory exists
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });

  // Create SQLite connection
  const sqlite = new Database(dbPath);

  // Configure performance pragmas
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('cache_size = -64000'); // 64MB
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('temp_store = MEMORY');

  // Create Drizzle ORM instance
  const db = drizzle(sqlite, { schema });

  log.info({ path: dbPath }, 'Database initialized with WAL mode');

  return { db, sqlite };
}

/**
 * Initialize database schema by running CREATE TABLE IF NOT EXISTS.
 *
 * This runs raw SQL to create tables and indexes, ensuring the schema
 * exists on first run without requiring drizzle-kit push (a dev tool).
 *
 * @param sqlite - Raw better-sqlite3 database instance
 */
export function initializeSchema(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS candles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pair TEXT NOT NULL,
      timeframe TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      open TEXT NOT NULL,
      high TEXT NOT NULL,
      low TEXT NOT NULL,
      close TEXT NOT NULL,
      volume TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_candles_pair_tf_ts
      ON candles (pair, timeframe, timestamp);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_candles_unique
      ON candles (pair, timeframe, timestamp);

    -- Paper trading tables
    CREATE TABLE IF NOT EXISTS paper_sessions (
      id TEXT PRIMARY KEY,
      config_json TEXT NOT NULL,
      strategy_name TEXT NOT NULL,
      pair TEXT NOT NULL,
      timeframe TEXT NOT NULL,
      start_time INTEGER NOT NULL,
      end_time INTEGER,
      initial_capital TEXT NOT NULL,
      final_equity TEXT,
      status TEXT NOT NULL DEFAULT 'running'
    );

    CREATE TABLE IF NOT EXISTS paper_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES paper_sessions(id),
      entry_timestamp INTEGER NOT NULL,
      entry_price TEXT NOT NULL,
      entry_fee TEXT NOT NULL,
      entry_side TEXT NOT NULL,
      entry_quantity TEXT NOT NULL,
      entry_signal_json TEXT NOT NULL,
      exit_timestamp INTEGER,
      exit_price TEXT,
      exit_fee TEXT,
      exit_side TEXT,
      exit_quantity TEXT,
      exit_signal_json TEXT,
      pnl TEXT,
      pnl_pct TEXT,
      holding_period_ms INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_paper_trades_session
      ON paper_trades (session_id);

    CREATE TABLE IF NOT EXISTS paper_equity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES paper_sessions(id),
      timestamp INTEGER NOT NULL,
      equity TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_paper_equity_session_ts
      ON paper_equity (session_id, timestamp);
  `);

  log.info('Database schema initialized');
}
