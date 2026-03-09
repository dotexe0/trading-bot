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

    -- Live trading tables
    CREATE TABLE IF NOT EXISTS live_sessions (
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

    CREATE TABLE IF NOT EXISTS live_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      order_id TEXT NOT NULL,
      client_order_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      side TEXT NOT NULL,
      order_type TEXT NOT NULL,
      status TEXT NOT NULL,
      base_size TEXT NOT NULL,
      limit_price TEXT,
      stop_price TEXT,
      filled_size TEXT NOT NULL DEFAULT '0',
      filled_value TEXT NOT NULL DEFAULT '0',
      average_fill_price TEXT,
      total_fees TEXT NOT NULL DEFAULT '0',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      purpose TEXT NOT NULL,
      signal_json TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_live_orders_order_id
      ON live_orders (order_id);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_live_orders_client_order_id
      ON live_orders (client_order_id);

    CREATE INDEX IF NOT EXISTS idx_live_orders_session
      ON live_orders (session_id);

    CREATE INDEX IF NOT EXISTS idx_live_orders_status
      ON live_orders (status);

    CREATE TABLE IF NOT EXISTS live_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      entry_order_id TEXT NOT NULL,
      exit_order_id TEXT NOT NULL,
      entry_timestamp INTEGER NOT NULL,
      entry_price TEXT NOT NULL,
      entry_fee TEXT NOT NULL,
      entry_side TEXT NOT NULL,
      entry_quantity TEXT NOT NULL,
      exit_timestamp INTEGER,
      exit_price TEXT,
      exit_fee TEXT,
      exit_side TEXT,
      exit_quantity TEXT,
      pnl TEXT,
      pnl_pct TEXT,
      holding_period_ms INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_live_trades_session
      ON live_trades (session_id);

    CREATE TABLE IF NOT EXISTS live_equity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      equity TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_live_equity_session_ts
      ON live_equity (session_id, timestamp);

    -- Tournament tables
    CREATE TABLE IF NOT EXISTS tournaments (
      id TEXT PRIMARY KEY,
      config_json TEXT NOT NULL,
      leaderboard_json TEXT NOT NULL,
      run_timestamp INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      strategies_evaluated INTEGER NOT NULL,
      regime_leaderboards_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_tournaments_run_timestamp
      ON tournaments (run_timestamp);

    CREATE TABLE IF NOT EXISTS active_strategies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tournament_id TEXT NOT NULL,
      strategy_name TEXT NOT NULL,
      strategy_config_json TEXT NOT NULL,
      rank INTEGER NOT NULL,
      oos_sharpe TEXT NOT NULL,
      activation_mode TEXT NOT NULL,
      session_id TEXT,
      activated_at INTEGER NOT NULL,
      deactivated_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_active_strategies_tournament
      ON active_strategies (tournament_id);

    CREATE INDEX IF NOT EXISTS idx_active_strategies_mode_active
      ON active_strategies (activation_mode, deactivated_at);

    -- Monte Carlo tables
    CREATE TABLE IF NOT EXISTS monte_carlo_results (
      id TEXT PRIMARY KEY,
      backtest_config_json TEXT NOT NULL,
      strategy_name TEXT NOT NULL,
      iterations INTEGER NOT NULL,
      trade_count INTEGER NOT NULL,
      sharpe_distribution_json TEXT NOT NULL,
      drawdown_distribution_json TEXT NOT NULL,
      return_distribution_json TEXT NOT NULL,
      original_sharpe TEXT NOT NULL,
      original_max_drawdown_pct TEXT NOT NULL,
      original_total_return TEXT NOT NULL,
      initial_capital TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_mc_results_strategy
      ON monte_carlo_results (strategy_name);

    CREATE INDEX IF NOT EXISTS idx_mc_results_created
      ON monte_carlo_results (created_at);

    -- Regime Detection tables
    CREATE TABLE IF NOT EXISTS regime_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pair TEXT NOT NULL,
      timeframe TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      regime TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_regime_unique
      ON regime_history (pair, timeframe, timestamp);

    CREATE INDEX IF NOT EXISTS idx_regime_pair_tf_ts
      ON regime_history (pair, timeframe, timestamp);

    -- Correlation Snapshot tables
    CREATE TABLE IF NOT EXISTS correlation_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timeframe TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      correlation TEXT NOT NULL,
      window_size INTEGER NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_corr_unique
      ON correlation_snapshots (timeframe, timestamp);

    CREATE INDEX IF NOT EXISTS idx_corr_tf_ts
      ON correlation_snapshots (timeframe, timestamp);

    -- Backtest run tables
    CREATE TABLE IF NOT EXISTS backtest_runs (
      id TEXT PRIMARY KEY,
      strategy_name TEXT NOT NULL,
      pair TEXT NOT NULL,
      timeframe TEXT NOT NULL,
      start_timestamp INTEGER NOT NULL,
      end_timestamp INTEGER NOT NULL,
      initial_capital TEXT NOT NULL,
      final_equity TEXT NOT NULL,
      total_fees TEXT NOT NULL,
      trade_count INTEGER NOT NULL,
      config_json TEXT NOT NULL,
      trades_json TEXT NOT NULL,
      equity_json TEXT NOT NULL,
      regime_breakdown_json TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_backtest_runs_strategy
      ON backtest_runs (strategy_name);

    CREATE INDEX IF NOT EXISTS idx_backtest_runs_created
      ON backtest_runs (created_at);

    -- Exit Config Optimizer tables
    CREATE TABLE IF NOT EXISTS exit_config_optimizations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      strategy_name TEXT NOT NULL,
      strategy_config_hash TEXT NOT NULL,
      exit_config_json TEXT NOT NULL,
      profit_factor TEXT NOT NULL,
      searched_at INTEGER NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_exit_opt_strategy_hash
      ON exit_config_optimizations (strategy_name, strategy_config_hash);

    CREATE INDEX IF NOT EXISTS idx_exit_opt_strategy
      ON exit_config_optimizations (strategy_name);

    -- Perp trading tables
    CREATE TABLE IF NOT EXISTS perp_sessions (
      id TEXT PRIMARY KEY,
      instrument TEXT NOT NULL,
      direction TEXT NOT NULL,
      entry_price TEXT NOT NULL,
      size TEXT NOT NULL,
      leverage INTEGER NOT NULL,
      liquidation_price TEXT NOT NULL,
      maintenance_margin_rate TEXT NOT NULL,
      mark_price TEXT,
      unrealized_pnl TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      opened_at INTEGER NOT NULL,
      closed_at INTEGER,
      close_reason TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_perp_sessions_instrument
      ON perp_sessions (instrument, status);

    CREATE TABLE IF NOT EXISTS perp_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_order_id TEXT NOT NULL UNIQUE,
      session_id TEXT NOT NULL,
      instrument TEXT NOT NULL,
      side TEXT NOT NULL,
      size TEXT NOT NULL,
      status TEXT NOT NULL,
      purpose TEXT NOT NULL,
      exchange_order_id TEXT,
      avg_fill_price TEXT,
      fee TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_perp_orders_session
      ON perp_orders (session_id);
  `);

  // Migrate existing databases: add regime_leaderboards_json if absent.
  // SQLite does not support IF NOT EXISTS on ADD COLUMN, so we use try/catch.
  // On first run (new DB): column was already added in CREATE TABLE above.
  // On existing DB: ALTER TABLE adds it; duplicate-column error is silently swallowed.
  const alterSql = 'ALTER TABLE tournaments ADD COLUMN regime_leaderboards_json TEXT';
  try {
    sqlite.exec(alterSql);
  } catch (_e) {
    // Column already present — expected for existing databases
  }

  log.info('Database schema initialized');
}
