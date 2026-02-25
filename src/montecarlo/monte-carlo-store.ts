/**
 * MonteCarloStore -- SQLite persistence for Monte Carlo simulation results.
 *
 * Follows the TournamentStore pattern: constructor creates DB connection,
 * initializes schema, provides CRUD methods with JSON serialization.
 */

import { eq, sql } from 'drizzle-orm';
import { createModuleLogger } from '../core/logger.js';
import { createDatabase, initializeSchema } from '../data/storage/db.js';
import { monteCarloResults } from '../data/storage/schema.js';
import type { MonteCarloResult, PercentileDistribution } from './types.js';
import type { BacktestConfig } from '../backtest/types.js';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type * as schema from '../data/storage/schema.js';
import type Database from 'better-sqlite3';

const log = createModuleLogger('monte-carlo-store');

// ── MonteCarloStore ────────────────────────────────────────────────

export class MonteCarloStore {
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
   * Save a Monte Carlo result to the database.
   */
  save(result: MonteCarloResult): void {
    this.db.insert(monteCarloResults).values({
      id: result.id,
      backtestConfigJson: JSON.stringify(result.backtestConfig),
      strategyName: result.strategyName,
      iterations: result.iterations,
      tradeCount: result.tradeCount,
      sharpeDistributionJson: JSON.stringify(result.sharpeDistribution),
      drawdownDistributionJson: JSON.stringify(result.maxDrawdownDistribution),
      returnDistributionJson: JSON.stringify(result.totalReturnDistribution),
      originalSharpe: String(result.originalSharpe),
      originalMaxDrawdownPct: String(result.originalMaxDrawdownPct),
      originalTotalReturn: String(result.originalTotalReturn),
      initialCapital: result.initialCapital,
      createdAt: result.createdAt,
    }).run();

    log.info(
      { id: result.id, strategy: result.strategyName, iterations: result.iterations },
      'Monte Carlo result saved',
    );
  }

  /**
   * Get a Monte Carlo result by ID.
   */
  getById(id: string): MonteCarloResult | null {
    const rows = this.db
      .select()
      .from(monteCarloResults)
      .where(eq(monteCarloResults.id, id))
      .all();

    if (rows.length === 0) return null;
    return this.rowToResult(rows[0]);
  }

  /**
   * Get Monte Carlo results by strategy name, ordered by createdAt DESC.
   */
  getByStrategy(strategyName: string, limit?: number): MonteCarloResult[] {
    let query = this.db
      .select()
      .from(monteCarloResults)
      .where(eq(monteCarloResults.strategyName, strategyName))
      .orderBy(sql`${monteCarloResults.createdAt} DESC`);

    const rows = limit ? query.limit(limit).all() : query.all();
    return rows.map((row) => this.rowToResult(row));
  }

  /**
   * List recent Monte Carlo results, ordered by createdAt DESC.
   */
  listRecent(limit?: number): MonteCarloResult[] {
    let query = this.db
      .select()
      .from(monteCarloResults)
      .orderBy(sql`${monteCarloResults.createdAt} DESC`);

    const rows = limit ? query.limit(limit).all() : query.all();
    return rows.map((row) => this.rowToResult(row));
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.sqlite.close();
  }

  // ── Private: row mapper ─────────────────────────────────────────

  private rowToResult(
    row: typeof monteCarloResults.$inferSelect,
  ): MonteCarloResult {
    return {
      id: row.id,
      strategyName: row.strategyName,
      iterations: row.iterations,
      tradeCount: row.tradeCount,
      initialCapital: row.initialCapital,
      sharpeDistribution: JSON.parse(row.sharpeDistributionJson) as PercentileDistribution,
      maxDrawdownDistribution: JSON.parse(row.drawdownDistributionJson) as PercentileDistribution,
      totalReturnDistribution: JSON.parse(row.returnDistributionJson) as PercentileDistribution,
      originalSharpe: Number(row.originalSharpe),
      originalMaxDrawdownPct: Number(row.originalMaxDrawdownPct),
      originalTotalReturn: Number(row.originalTotalReturn),
      createdAt: row.createdAt,
      backtestConfig: JSON.parse(row.backtestConfigJson) as BacktestConfig,
    };
  }
}
