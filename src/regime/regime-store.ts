/**
 * RegimeStore -- SQLite persistence for per-candle regime classification history.
 *
 * Follows the MonteCarloStore pattern: constructor creates DB connection,
 * initializes schema, provides batch save and range query methods.
 */

import { createModuleLogger } from '../core/logger.js';
import { createDatabase, initializeSchema } from '../data/storage/db.js';
import { regimeHistory } from '../data/storage/schema.js';
import { MarketRegime } from './types.js';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type * as schema from '../data/storage/schema.js';
import type Database from 'better-sqlite3';

const log = createModuleLogger('regime-store');

// ── RegimeStore ────────────────────────────────────────────────────

export class RegimeStore {
  private db: BetterSQLite3Database<typeof schema>;
  private sqlite: Database.Database;

  constructor(options: { dbPath?: string } = {}) {
    const dbPath = options.dbPath ?? 'data/trading.db';
    const conn = createDatabase(dbPath);
    this.db = conn.db;
    this.sqlite = conn.sqlite;
    initializeSchema(conn.sqlite);
  }

  /**
   * Save a batch of regime records to the database.
   *
   * Uses INSERT OR REPLACE semantics wrapped in a transaction for performance.
   * Duplicate (pair, timeframe, timestamp) records are overwritten.
   *
   * @param records - Array of regime records to persist
   */
  saveBatch(
    records: { pair: string; timeframe: string; timestamp: number; regime: MarketRegime }[],
  ): void {
    if (records.length === 0) return;

    const stmt = this.sqlite.prepare(
      'INSERT OR REPLACE INTO regime_history (pair, timeframe, timestamp, regime) VALUES (?, ?, ?, ?)',
    );

    const insertMany = this.sqlite.transaction(
      (rows: { pair: string; timeframe: string; timestamp: number; regime: MarketRegime }[]) => {
        for (const row of rows) {
          stmt.run(row.pair, row.timeframe, row.timestamp, row.regime);
        }
      },
    );

    insertMany(records);

    log.info({ count: records.length }, 'Regime batch saved');
  }

  /**
   * Get regime labels for a time range, ordered by timestamp ASC.
   *
   * @param pair - Trading pair (e.g. 'BTC-USD')
   * @param timeframe - Candle timeframe (e.g. '1h')
   * @param startMs - Start timestamp (inclusive, Unix ms)
   * @param endMs - End timestamp (inclusive, Unix ms)
   * @returns Array of { timestamp, regime } records sorted ascending
   */
  getByRange(
    pair: string,
    timeframe: string,
    startMs: number,
    endMs: number,
  ): { timestamp: number; regime: MarketRegime }[] {
    const rows = this.sqlite
      .prepare(
        `SELECT timestamp, regime FROM regime_history
         WHERE pair = ? AND timeframe = ? AND timestamp >= ? AND timestamp <= ?
         ORDER BY timestamp ASC`,
      )
      .all(pair, timeframe, startMs, endMs) as { timestamp: number; regime: string }[];

    return rows.map((row) => ({
      timestamp: row.timestamp,
      regime: row.regime as MarketRegime,
    }));
  }

  /**
   * Get the regime for a specific candle timestamp.
   *
   * @param pair - Trading pair
   * @param timeframe - Candle timeframe
   * @param timestamp - Exact candle timestamp (Unix ms)
   * @returns MarketRegime or null if not found
   */
  getAtTimestamp(
    pair: string,
    timeframe: string,
    timestamp: number,
  ): MarketRegime | null {
    const row = this.sqlite
      .prepare(
        'SELECT regime FROM regime_history WHERE pair = ? AND timeframe = ? AND timestamp = ?',
      )
      .get(pair, timeframe, timestamp) as { regime: string } | undefined;

    if (!row) return null;
    return row.regime as MarketRegime;
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.sqlite.close();
  }
}
