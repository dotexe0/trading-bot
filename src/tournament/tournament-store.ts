/**
 * TournamentStore -- SQLite persistence for tournament results and
 * active strategy records.
 *
 * Follows the SessionStore pattern: constructor creates DB connection,
 * initializes schema, provides CRUD methods with JSON serialization.
 */

import { eq, isNull, and, sql } from 'drizzle-orm';
import { d, ZERO, type Decimal } from '../core/decimal.js';
import { createModuleLogger } from '../core/logger.js';
import { createDatabase, initializeSchema } from '../data/storage/db.js';
import { tournaments, activeStrategies } from '../data/storage/schema.js';
import type { PerformanceMetrics } from '../backtest/metrics.js';
import type { TournamentResult, LeaderboardEntry, ActivationRecord } from './types.js';
import type { TournamentConfig } from './config.js';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type * as schema from '../data/storage/schema.js';
import type Database from 'better-sqlite3';

const log = createModuleLogger('tournament-store');

// ── Serialization helpers ──────────────────────────────────────────

/**
 * Serialize PerformanceMetrics to a plain object (Decimal -> string).
 */
function serializeMetrics(m: PerformanceMetrics): Record<string, unknown> {
  return {
    totalReturn: m.totalReturn.toString(),
    cagr: m.cagr.toString(),
    sharpeRatio: m.sharpeRatio,
    maxDrawdown: m.maxDrawdown.toString(),
    maxDrawdownPct: m.maxDrawdownPct.toString(),
    winRate: m.winRate.toString(),
    profitFactor: m.profitFactor.toString(),
    totalTrades: m.totalTrades,
    totalFees: m.totalFees.toString(),
    avgTradeReturn: m.avgTradeReturn.toString(),
    bestTrade: m.bestTrade.toString(),
    worstTrade: m.worstTrade.toString(),
  };
}

/**
 * Deserialize a plain object back to PerformanceMetrics (string -> Decimal).
 */
function deserializeMetrics(raw: Record<string, unknown>): PerformanceMetrics {
  return {
    totalReturn: d(raw.totalReturn as string),
    cagr: d(raw.cagr as string),
    sharpeRatio: raw.sharpeRatio as number,
    maxDrawdown: d(raw.maxDrawdown as string),
    maxDrawdownPct: d(raw.maxDrawdownPct as string),
    winRate: d(raw.winRate as string),
    profitFactor: d(raw.profitFactor as string),
    totalTrades: raw.totalTrades as number,
    totalFees: d(raw.totalFees as string),
    avgTradeReturn: d(raw.avgTradeReturn as string),
    bestTrade: d(raw.bestTrade as string),
    worstTrade: d(raw.worstTrade as string),
  };
}

/**
 * Serialize a leaderboard entry for JSON storage.
 */
function serializeEntry(entry: LeaderboardEntry): Record<string, unknown> {
  return {
    rank: entry.rank,
    strategyName: entry.strategyName,
    strategyConfig: entry.strategyConfig,
    oosMetrics: serializeMetrics(entry.oosMetrics),
    isMetrics: serializeMetrics(entry.isMetrics),
    robustnessRatio: entry.robustnessRatio,
    windowCount: entry.windowCount,
  };
}

/**
 * Deserialize a leaderboard entry from JSON storage.
 */
function deserializeEntry(raw: Record<string, unknown>): LeaderboardEntry {
  return {
    rank: raw.rank as number,
    strategyName: raw.strategyName as string,
    strategyConfig: raw.strategyConfig as Record<string, unknown>,
    oosMetrics: deserializeMetrics(raw.oosMetrics as Record<string, unknown>),
    isMetrics: deserializeMetrics(raw.isMetrics as Record<string, unknown>),
    robustnessRatio: raw.robustnessRatio as number,
    windowCount: raw.windowCount as number,
  };
}

// ── TournamentStore ────────────────────────────────────────────────

export class TournamentStore {
  private db: BetterSQLite3Database<typeof schema>;
  private sqlite: Database.Database;

  constructor(options: { dbPath?: string } = {}) {
    const dbPath = options.dbPath ?? 'data/trading.db';
    const conn = createDatabase(dbPath);
    this.db = conn.db;
    this.sqlite = conn.sqlite;
    initializeSchema(conn.sqlite);
  }

  // ── Tournament CRUD ──────────────────────────────────────────────

  /**
   * Save a tournament result to the database.
   */
  saveTournament(result: TournamentResult): void {
    const configJson = JSON.stringify(result.config);
    const leaderboardJson = JSON.stringify(
      result.leaderboard.map(serializeEntry),
    );

    this.db.insert(tournaments).values({
      id: result.id,
      configJson,
      leaderboardJson,
      runTimestamp: result.runTimestamp,
      durationMs: result.durationMs,
      strategiesEvaluated: result.strategiesEvaluated,
    }).run();

    log.info(
      { tournamentId: result.id, strategies: result.strategiesEvaluated },
      'Tournament saved',
    );
  }

  /**
   * Get a tournament result by ID.
   */
  getTournament(id: string): TournamentResult | null {
    const rows = this.db
      .select()
      .from(tournaments)
      .where(eq(tournaments.id, id))
      .all();

    if (rows.length === 0) return null;
    return this.rowToResult(rows[0]);
  }

  /**
   * Get the most recent tournament result.
   */
  getLatestTournament(): TournamentResult | null {
    const rows = this.db
      .select()
      .from(tournaments)
      .orderBy(sql`${tournaments.runTimestamp} DESC`)
      .limit(1)
      .all();

    if (rows.length === 0) return null;
    return this.rowToResult(rows[0]);
  }

  /**
   * List tournament results, most recent first.
   */
  listTournaments(limit?: number): TournamentResult[] {
    let query = this.db
      .select()
      .from(tournaments)
      .orderBy(sql`${tournaments.runTimestamp} DESC`);

    const rows = limit
      ? query.limit(limit).all()
      : query.all();

    return rows.map((row) => this.rowToResult(row));
  }

  // ── Active Strategy Management ───────────────────────────────────

  /**
   * Save active strategies from a tournament, deactivating previous ones.
   */
  saveActiveStrategies(
    tournamentId: string,
    entries: LeaderboardEntry[],
    mode: 'paper' | 'live',
  ): void {
    const now = Date.now();

    // Deactivate existing active strategies for this mode using prepared statement
    const deactivateStmt = this.sqlite.prepare(
      `UPDATE active_strategies SET deactivated_at = ? WHERE activation_mode = ? AND deactivated_at IS NULL`,
    );
    deactivateStmt.run(now, mode);

    // Insert new active strategies
    for (const entry of entries) {
      this.db.insert(activeStrategies).values({
        tournamentId,
        strategyName: entry.strategyName,
        strategyConfigJson: JSON.stringify(entry.strategyConfig),
        rank: entry.rank,
        oosSharpe: entry.oosMetrics.sharpeRatio.toString(),
        activationMode: mode,
        sessionId: null,
        activatedAt: now,
        deactivatedAt: null,
      }).run();
    }

    log.info(
      { tournamentId, mode, count: entries.length },
      'Active strategies updated',
    );
  }

  /**
   * Get currently active strategies, optionally filtered by mode.
   */
  getActiveStrategies(mode?: 'paper' | 'live'): ActivationRecord[] {
    let rows;
    if (mode) {
      rows = this.db
        .select()
        .from(activeStrategies)
        .where(
          and(
            eq(activeStrategies.activationMode, mode),
            isNull(activeStrategies.deactivatedAt),
          ),
        )
        .all();
    } else {
      rows = this.db
        .select()
        .from(activeStrategies)
        .where(isNull(activeStrategies.deactivatedAt))
        .all();
    }

    return rows.map((row) => this.rowToActivation(row));
  }

  /**
   * Deactivate all active strategies, optionally filtered by mode.
   */
  deactivateAll(mode?: 'paper' | 'live'): void {
    const now = Date.now();
    if (mode) {
      const stmt = this.sqlite.prepare(
        `UPDATE active_strategies SET deactivated_at = ? WHERE activation_mode = ? AND deactivated_at IS NULL`,
      );
      stmt.run(now, mode);
    } else {
      const stmt = this.sqlite.prepare(
        `UPDATE active_strategies SET deactivated_at = ? WHERE deactivated_at IS NULL`,
      );
      stmt.run(now);
    }
    log.info({ mode: mode ?? 'all' }, 'Strategies deactivated');
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.sqlite.close();
  }

  // ── Private: row mappers ─────────────────────────────────────────

  private rowToResult(row: typeof tournaments.$inferSelect): TournamentResult {
    const config = JSON.parse(row.configJson) as TournamentConfig;
    const rawLeaderboard = JSON.parse(row.leaderboardJson) as Record<string, unknown>[];
    const leaderboard = rawLeaderboard.map(deserializeEntry);

    return {
      id: row.id,
      config,
      leaderboard,
      runTimestamp: row.runTimestamp,
      durationMs: row.durationMs,
      strategiesEvaluated: row.strategiesEvaluated,
    };
  }

  private rowToActivation(
    row: typeof activeStrategies.$inferSelect,
  ): ActivationRecord {
    return {
      tournamentId: row.tournamentId,
      strategyName: row.strategyName,
      strategyConfig: JSON.parse(row.strategyConfigJson) as Record<string, unknown>,
      rank: row.rank,
      oosSharpe: parseFloat(row.oosSharpe),
      activationMode: row.activationMode as 'paper' | 'live',
      sessionId: row.sessionId,
      activatedAt: row.activatedAt,
      deactivatedAt: row.deactivatedAt,
    };
  }
}
