/**
 * Candle repository providing CRUD operations for candle data.
 *
 * Uses Drizzle ORM query builder for type-safe queries.
 * Bulk inserts use transactions for performance.
 * INSERT OR IGNORE handles duplicate candles via unique index.
 */

import { eq, and, between, desc, asc, sql, gte, lte } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { Candle, TradingPair, Timeframe } from '../../core/types.js';
import * as schema from './schema.js';
import { candles } from './schema.js';

type DB = BetterSQLite3Database<typeof schema>;

export class CandleRepository {
  private db: DB;

  constructor(db: DB) {
    this.db = db;
  }

  /**
   * Bulk insert candles using a transaction.
   * Uses INSERT OR IGNORE to skip duplicates (unique index handles this).
   *
   * @param candleData - Array of candles to insert
   * @returns Number of actually inserted rows
   */
  insertCandles(candleData: Candle[]): number {
    if (candleData.length === 0) return 0;

    let insertedCount = 0;

    // Use drizzle's transaction for bulk insert
    this.db.transaction((tx) => {
      for (const candle of candleData) {
        const result = tx
          .insert(candles)
          .values({
            pair: candle.pair,
            timeframe: candle.timeframe,
            timestamp: candle.timestamp,
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
            volume: candle.volume,
          })
          .onConflictDoNothing()
          .run();

        // better-sqlite3 returns changes count
        insertedCount += result.changes;
      }
    });

    return insertedCount;
  }

  /**
   * Query candles by pair, timeframe, and time range.
   *
   * @param pair - Trading pair (e.g., 'BTC-USD')
   * @param timeframe - Candle timeframe (e.g., '1m')
   * @param startMs - Start of range (Unix ms, inclusive)
   * @param endMs - End of range (Unix ms, inclusive)
   * @returns Array of candles ordered by timestamp ascending
   */
  getCandles(
    pair: TradingPair,
    timeframe: Timeframe,
    startMs: number,
    endMs: number,
  ): Candle[] {
    const rows = this.db
      .select()
      .from(candles)
      .where(
        and(
          eq(candles.pair, pair),
          eq(candles.timeframe, timeframe),
          gte(candles.timestamp, startMs),
          lte(candles.timestamp, endMs),
        ),
      )
      .orderBy(asc(candles.timestamp))
      .all();

    return rows.map((row) => ({
      pair: row.pair as TradingPair,
      timeframe: row.timeframe as Timeframe,
      timestamp: row.timestamp,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: row.volume,
    }));
  }

  /**
   * Get the most recent candle timestamp for a pair/timeframe.
   * Used for incremental data updates.
   *
   * @returns Unix ms timestamp or null if no candles exist
   */
  getLatestTimestamp(
    pair: TradingPair,
    timeframe: Timeframe,
  ): number | null {
    const result = this.db
      .select({ maxTs: sql<number>`MAX(${candles.timestamp})` })
      .from(candles)
      .where(
        and(
          eq(candles.pair, pair),
          eq(candles.timeframe, timeframe),
        ),
      )
      .get();

    return result?.maxTs ?? null;
  }

  /**
   * Get the oldest candle timestamp for a pair/timeframe.
   *
   * @returns Unix ms timestamp or null if no candles exist
   */
  getEarliestTimestamp(
    pair: TradingPair,
    timeframe: Timeframe,
  ): number | null {
    const result = this.db
      .select({ minTs: sql<number>`MIN(${candles.timestamp})` })
      .from(candles)
      .where(
        and(
          eq(candles.pair, pair),
          eq(candles.timeframe, timeframe),
        ),
      )
      .get();

    return result?.minTs ?? null;
  }

  /**
   * Count candles for a pair/timeframe combination.
   */
  getCandleCount(
    pair: TradingPair,
    timeframe: Timeframe,
  ): number {
    const result = this.db
      .select({ count: sql<number>`COUNT(*)` })
      .from(candles)
      .where(
        and(
          eq(candles.pair, pair),
          eq(candles.timeframe, timeframe),
        ),
      )
      .get();

    return result?.count ?? 0;
  }

  /**
   * Return all timestamps sorted ascending for a pair/timeframe.
   * Used for gap detection in historical data.
   */
  getTimestamps(
    pair: TradingPair,
    timeframe: Timeframe,
  ): number[] {
    const rows = this.db
      .select({ timestamp: candles.timestamp })
      .from(candles)
      .where(
        and(
          eq(candles.pair, pair),
          eq(candles.timeframe, timeframe),
        ),
      )
      .orderBy(asc(candles.timestamp))
      .all();

    return rows.map((row) => row.timestamp);
  }
}
