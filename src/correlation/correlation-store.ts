/**
 * CorrelationStore -- SQLite persistence for BTC/ETH correlation snapshots.
 *
 * Follows the RegimeStore pattern: constructor creates DB connection,
 * initializes schema, provides save, saveBatch, getByRange, getLatest methods.
 */

import { createModuleLogger } from '../core/logger.js';
import { createDatabase, initializeSchema } from '../data/storage/db.js';
import type { CorrelationSnapshot } from './types.js';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type * as schema from '../data/storage/schema.js';
import type Database from 'better-sqlite3';

const log = createModuleLogger('correlation-store');

// ── CorrelationStore ────────────────────────────────────────────────

export class CorrelationStore {
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
   * Save a single correlation snapshot to the database.
   *
   * Uses INSERT OR REPLACE semantics keyed on (timeframe, timestamp).
   * Duplicate (timeframe, timestamp) records are overwritten.
   *
   * @param snapshot - CorrelationSnapshot to persist
   * @param timeframe - Candle timeframe (e.g. '1h', '4h')
   */
  save(snapshot: CorrelationSnapshot, timeframe: string): void {
    this.sqlite
      .prepare(
        'INSERT OR REPLACE INTO correlation_snapshots (timeframe, timestamp, correlation, window_size) VALUES (?, ?, ?, ?)',
      )
      .run(
        timeframe,
        snapshot.timestamp,
        String(snapshot.correlation),
        snapshot.windowSize,
      );

    log.debug({ timeframe, timestamp: snapshot.timestamp }, 'Correlation snapshot saved');
  }

  /**
   * Save a batch of correlation snapshots atomically.
   *
   * Wraps individual save calls in a SQLite transaction for performance.
   * Each item in the array must include a timeframe field alongside the snapshot fields.
   *
   * @param snapshots - Array of snapshots with timeframe field
   */
  saveBatch(
    snapshots: Array<CorrelationSnapshot & { timeframe: string }>,
  ): void {
    if (snapshots.length === 0) return;

    const stmt = this.sqlite.prepare(
      'INSERT OR REPLACE INTO correlation_snapshots (timeframe, timestamp, correlation, window_size) VALUES (?, ?, ?, ?)',
    );

    const insertMany = this.sqlite.transaction(
      (rows: Array<CorrelationSnapshot & { timeframe: string }>) => {
        for (const row of rows) {
          stmt.run(row.timeframe, row.timestamp, String(row.correlation), row.windowSize);
        }
      },
    );

    insertMany(snapshots);

    log.info({ count: snapshots.length }, 'Correlation snapshots batch saved');
  }

  /**
   * Get correlation snapshots for a time range, ordered by timestamp ASC.
   *
   * @param timeframe - Candle timeframe (e.g. '1h')
   * @param startMs - Start timestamp (inclusive, Unix ms)
   * @param endMs - End timestamp (inclusive, Unix ms)
   * @returns Array of CorrelationSnapshot records (with timeframe) sorted ascending
   */
  getByRange(
    timeframe: string,
    startMs: number,
    endMs: number,
  ): Array<CorrelationSnapshot & { timeframe: string }> {
    const rows = this.sqlite
      .prepare(
        `SELECT timeframe, timestamp, correlation, window_size
         FROM correlation_snapshots
         WHERE timeframe = ? AND timestamp >= ? AND timestamp <= ?
         ORDER BY timestamp ASC`,
      )
      .all(timeframe, startMs, endMs) as Array<{
        timeframe: string;
        timestamp: number;
        correlation: string;
        window_size: number;
      }>;

    return rows.map((row) => ({
      timeframe: row.timeframe,
      timestamp: row.timestamp,
      correlation: Number(row.correlation),
      windowSize: row.window_size,
    }));
  }

  /**
   * Get the most recent correlation snapshot for a given timeframe.
   *
   * @param timeframe - Candle timeframe (e.g. '1h')
   * @returns The latest CorrelationSnapshot (with timeframe), or null if none found
   */
  getLatest(
    timeframe: string,
  ): (CorrelationSnapshot & { timeframe: string }) | null {
    const row = this.sqlite
      .prepare(
        `SELECT timeframe, timestamp, correlation, window_size
         FROM correlation_snapshots
         WHERE timeframe = ?
         ORDER BY timestamp DESC
         LIMIT 1`,
      )
      .get(timeframe) as
      | { timeframe: string; timestamp: number; correlation: string; window_size: number }
      | undefined;

    if (!row) return null;

    return {
      timeframe: row.timeframe,
      timestamp: row.timestamp,
      correlation: Number(row.correlation),
      windowSize: row.window_size,
    };
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.sqlite.close();
  }
}
