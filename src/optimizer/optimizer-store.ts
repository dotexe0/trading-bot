/**
 * ExitConfigStore -- SQLite persistence for optimized exit configurations.
 *
 * Follows the TournamentStore pattern: constructor creates DB connection,
 * initializes schema, provides CRUD methods with JSON serialization.
 */

import { eq, and, sql } from 'drizzle-orm';
import { createModuleLogger } from '../core/logger.js';
import { createDatabase, initializeSchema } from '../data/storage/db.js';
import { exitConfigOptimizations } from '../data/storage/schema.js';
import type { ExitConfig } from '../risk/exit-logic/types.js';
import type { OptimizedExitParams } from './types.js';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type * as schema from '../data/storage/schema.js';
import type Database from 'better-sqlite3';

const log = createModuleLogger('exit-config-store');

// ── ExitConfigStore ──────────────────────────────────────────────

export class ExitConfigStore {
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
   * Save (upsert) an optimized exit config for a strategy+hash.
   * Uses INSERT OR REPLACE to handle duplicate strategy_name + strategy_config_hash.
   */
  save(params: OptimizedExitParams): void {
    const stmt = this.sqlite.prepare(
      `INSERT OR REPLACE INTO exit_config_optimizations
        (strategy_name, strategy_config_hash, exit_config_json, profit_factor, searched_at)
      VALUES (?, ?, ?, ?, ?)`,
    );
    stmt.run(
      params.strategyName,
      params.strategyConfigHash,
      JSON.stringify(params.exitConfig),
      params.profitFactor.toString(),
      params.searchedAt,
    );

    log.info(
      { strategyName: params.strategyName, profitFactor: params.profitFactor },
      'Optimized exit config saved',
    );
  }

  /**
   * Get the optimized exit config for a strategy with the given config hash.
   * Returns null if no row exists or if the hash doesn't match (stale config).
   */
  getForStrategy(
    strategyName: string,
    currentHash: string,
  ): OptimizedExitParams | null {
    const rows = this.db
      .select()
      .from(exitConfigOptimizations)
      .where(
        and(
          eq(exitConfigOptimizations.strategyName, strategyName),
          eq(exitConfigOptimizations.strategyConfigHash, currentHash),
        ),
      )
      .all();

    if (rows.length === 0) return null;
    return this.rowToParams(rows[0]);
  }

  /**
   * List all optimized exit configs for a strategy, newest first.
   */
  listForStrategy(strategyName: string): OptimizedExitParams[] {
    const rows = this.db
      .select()
      .from(exitConfigOptimizations)
      .where(eq(exitConfigOptimizations.strategyName, strategyName))
      .orderBy(sql`${exitConfigOptimizations.searchedAt} DESC`)
      .all();

    return rows.map((row) => this.rowToParams(row));
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.sqlite.close();
  }

  // ── Private: row mapper ──────────────────────────────────────────

  private rowToParams(
    row: typeof exitConfigOptimizations.$inferSelect,
  ): OptimizedExitParams {
    return {
      strategyName: row.strategyName,
      strategyConfigHash: row.strategyConfigHash,
      exitConfig: JSON.parse(row.exitConfigJson) as ExitConfig,
      profitFactor: parseFloat(row.profitFactor),
      searchedAt: row.searchedAt,
    };
  }
}
