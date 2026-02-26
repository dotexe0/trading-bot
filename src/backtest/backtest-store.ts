/**
 * BacktestStore -- SQLite persistence for backtest results.
 *
 * Follows the MonteCarloStore pattern: constructor creates DB connection,
 * initializes schema, provides CRUD methods with JSON serialization.
 */

import crypto from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { createModuleLogger } from '../core/logger.js';
import { createDatabase, initializeSchema } from '../data/storage/db.js';
import { backtestRuns } from '../data/storage/schema.js';
import type { BacktestResult, BacktestConfig } from './types.js';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type * as schema from '../data/storage/schema.js';
import type Database from 'better-sqlite3';

const log = createModuleLogger('backtest-store');

// ── API Types ─────────────────────────────────────────────────────────

/** Serialized trade for API responses (all Decimal fields as strings). */
export interface ApiBacktestTrade {
  entryTimestamp: number;
  entryPrice: string;
  entryFee: string;
  entrySide: string;
  entryQuantity: string;
  exitTimestamp: number;
  exitPrice: string;
  exitFee: string;
  exitSide: string;
  exitQuantity: string;
  pnl: string;
  pnlPct: string;
  holdingPeriodMs: number;
  signal: string; // SignalDirection: 'long' | 'short' | 'close'
}

/** Metadata-only shape returned by listRecentMeta (no large blobs). */
export interface ApiBacktestMeta {
  id: string;
  strategyName: string;
  pair: string;
  timeframe: string;
  startTimestamp: number;
  endTimestamp: number;
  initialCapital: string;
  finalEquity: string;
  totalFees: string;
  tradeCount: number;
  createdAt: number;
}

/** Full backtest run shape with trades and config. */
export interface ApiBacktestRun extends ApiBacktestMeta {
  trades: ApiBacktestTrade[];
  config: BacktestConfig;
}

// ── BacktestStore ─────────────────────────────────────────────────────

export class BacktestStore {
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
   * Save a BacktestResult to the database.
   * Returns the generated UUID id.
   */
  save(result: BacktestResult): string {
    const id = crypto.randomUUID();

    // Extract strategy name from config
    const strategyName =
      ((result.config.strategyConfig as Record<string, unknown>)['strategy'] as string) ??
      'unknown';

    // Serialize trades: all Decimal fields to strings
    const trades: ApiBacktestTrade[] = result.trades.map((t) => ({
      entryTimestamp: t.entryFill.fillTimestamp,
      entryPrice: t.entryFill.fillPrice.toString(),
      entryFee: t.entryFill.fee.toString(),
      entrySide: t.entryFill.side,
      entryQuantity: t.entryFill.quantity.toString(),
      exitTimestamp: t.exitFill.fillTimestamp,
      exitPrice: t.exitFill.fillPrice.toString(),
      exitFee: t.exitFill.fee.toString(),
      exitSide: t.exitFill.side,
      exitQuantity: t.exitFill.quantity.toString(),
      pnl: t.pnl.toString(),
      pnlPct: t.pnlPct.toString(),
      holdingPeriodMs: t.holdingPeriodMs,
      signal: t.entryFill.signal.direction,
    }));

    // Serialize equity curve
    const equityJson = JSON.stringify(
      result.equityCurve.map((ep) => ({
        timestamp: ep.timestamp,
        equity: ep.equity.toString(),
      })),
    );

    this.db
      .insert(backtestRuns)
      .values({
        id,
        strategyName,
        pair: result.config.pair,
        timeframe: result.config.timeframe,
        startTimestamp: result.startTimestamp,
        endTimestamp: result.endTimestamp,
        initialCapital: result.config.initialCapital,
        finalEquity: result.finalEquity.toString(),
        totalFees: result.totalFees.toString(),
        tradeCount: result.trades.length,
        configJson: JSON.stringify(result.config),
        tradesJson: JSON.stringify(trades),
        equityJson,
        regimeBreakdownJson: result.regimeBreakdown
          ? JSON.stringify(result.regimeBreakdown)
          : null,
        createdAt: Date.now(),
      })
      .run();

    log.info(
      { id, strategy: strategyName, trades: result.trades.length },
      'Backtest result saved',
    );

    return id;
  }

  /**
   * Get a full backtest run by ID (includes trades and config).
   */
  getById(id: string): ApiBacktestRun | null {
    const rows = this.db
      .select()
      .from(backtestRuns)
      .where(eq(backtestRuns.id, id))
      .all();

    if (rows.length === 0) return null;
    return this.rowToRun(rows[0]);
  }

  /**
   * List recent backtest runs (metadata only, no trades/equity blobs).
   */
  listRecentMeta(limit?: number): ApiBacktestMeta[] {
    const query = this.db
      .select({
        id: backtestRuns.id,
        strategyName: backtestRuns.strategyName,
        pair: backtestRuns.pair,
        timeframe: backtestRuns.timeframe,
        startTimestamp: backtestRuns.startTimestamp,
        endTimestamp: backtestRuns.endTimestamp,
        initialCapital: backtestRuns.initialCapital,
        finalEquity: backtestRuns.finalEquity,
        totalFees: backtestRuns.totalFees,
        tradeCount: backtestRuns.tradeCount,
        createdAt: backtestRuns.createdAt,
      })
      .from(backtestRuns)
      .orderBy(sql`${backtestRuns.createdAt} DESC`);

    const rows = limit ? query.limit(limit).all() : query.all();

    return rows.map((row) => ({
      id: row.id,
      strategyName: row.strategyName,
      pair: row.pair,
      timeframe: row.timeframe,
      startTimestamp: row.startTimestamp,
      endTimestamp: row.endTimestamp,
      initialCapital: row.initialCapital,
      finalEquity: row.finalEquity,
      totalFees: row.totalFees,
      tradeCount: row.tradeCount,
      createdAt: row.createdAt,
    }));
  }

  /**
   * List recent backtest runs (full data including trades).
   */
  listRecent(limit?: number): ApiBacktestRun[] {
    const query = this.db
      .select()
      .from(backtestRuns)
      .orderBy(sql`${backtestRuns.createdAt} DESC`);

    const rows = limit ? query.limit(limit).all() : query.all();
    return rows.map((row) => this.rowToRun(row));
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.sqlite.close();
  }

  // ── Private: row mapper ────────────────────────────────────────────

  private rowToRun(row: typeof backtestRuns.$inferSelect): ApiBacktestRun {
    return {
      id: row.id,
      strategyName: row.strategyName,
      pair: row.pair,
      timeframe: row.timeframe,
      startTimestamp: row.startTimestamp,
      endTimestamp: row.endTimestamp,
      initialCapital: row.initialCapital,
      finalEquity: row.finalEquity,
      totalFees: row.totalFees,
      tradeCount: row.tradeCount,
      createdAt: row.createdAt,
      trades: JSON.parse(row.tradesJson) as ApiBacktestTrade[],
      config: JSON.parse(row.configJson) as BacktestConfig,
    };
  }
}
