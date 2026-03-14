/**
 * PerpStateStore -- SQLite persistence for perp trading sessions and orders.
 *
 * Stores perp sessions and orders. All decimal fields are serialized to/from
 * strings for storage, preserving full precision. Mirrors the LiveStateStore
 * pattern from src/live/state-store.ts.
 */

import { eq, sql } from 'drizzle-orm';
import { createModuleLogger } from '../core/logger.js';
import { createDatabase, initializeSchema } from '../data/storage/db.js';
import { perpSessions, perpOrders, perpTrades } from '../data/storage/schema.js';
import type { PerpSession, PerpOrder } from './types.js';

// ── PerpTradeRecord ───────────────────────────────────────────────────────────

/**
 * A durable record of a closed perp trade, written by recordTrade() and
 * read back by listClosedTrades(). Enables Phase 32-02 CLI analytics.
 */
export interface PerpTradeRecord {
  sessionId: string;
  instrument: string;
  direction: 'long' | 'short';
  leverage: number;
  entryPrice: string;
  exitPrice: string;
  size: string;
  /** '0.00000000' when no funding events fired during the session. */
  cumulativeFundingCost: string;
  realizedPnl: string;
  openedAt: number;
  closedAt: number;
  closeReason?: string;
}
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type * as schema from '../data/storage/schema.js';
import type Database from 'better-sqlite3';

const log = createModuleLogger('perp-state-store');

export class PerpStateStore {
  private db: BetterSQLite3Database<typeof schema>;
  private sqlite: Database.Database;

  constructor(options: { dbPath?: string } = {}) {
    const dbPath = options.dbPath ?? 'data/perp.db';
    const conn = createDatabase(dbPath);
    this.db = conn.db;
    this.sqlite = conn.sqlite;
    initializeSchema(conn.sqlite);

    // Guard: add margin_mode column to existing DBs that pre-date this column.
    // CREATE TABLE IF NOT EXISTS does not alter existing tables, so existing DBs
    // lack this column until we add it here. The catch is intentional:
    // SQLite throws "duplicate column name" if the column already exists.
    try {
      conn.sqlite.prepare('ALTER TABLE perp_sessions ADD COLUMN margin_mode TEXT').run();
    } catch {
      // column already exists — no action needed
    }

    try {
      conn.sqlite.prepare('ALTER TABLE perp_sessions ADD COLUMN cumulative_funding_cost TEXT').run();
    } catch {
      // column already exists — no action needed
    }
  }

  // ── Session CRUD ──────────────────────────────────────────────────

  /**
   * Persist a fully-constructed PerpSession. The caller is responsible
   * for setting id, openedAt, and status before calling this method.
   * The store simply writes all fields as-is.
   */
  createSession(session: PerpSession): void {
    this.db
      .insert(perpSessions)
      .values({
        id: session.id,
        instrument: session.instrument,
        direction: session.direction,
        entryPrice: session.entryPrice,
        size: session.size,
        leverage: session.leverage,
        liquidationPrice: session.liquidationPrice,
        maintenanceMarginRate: session.maintenanceMarginRate,
        marginMode: session.marginMode ?? null,
        cumulativeFundingCost: session.cumulativeFundingCost ?? null,
        markPrice: session.markPrice ?? null,
        unrealizedPnl: session.unrealizedPnl ?? null,
        status: session.status,
        openedAt: session.openedAt,
        closedAt: session.closedAt ?? null,
        closeReason: session.closeReason ?? null,
      })
      .run();

    log.info(
      { sessionId: session.id, instrument: session.instrument, direction: session.direction },
      'Perp session created',
    );
  }

  /**
   * Get all open sessions across all instruments (status = 'open').
   * Used by recoverFromRestart() to reconcile state on startup.
   */
  getAllOpenSessions(): PerpSession[] {
    const rows = this.db
      .select()
      .from(perpSessions)
      .where(sql`${perpSessions.status} = 'open'`)
      .all();

    return rows.map((row) => this.rowToSession(row));
  }

  /**
   * Get the open session for an instrument (status = 'open').
   */
  getOpenSession(instrument: string): PerpSession | null {
    const rows = this.db
      .select()
      .from(perpSessions)
      .where(
        sql`${perpSessions.instrument} = ${instrument} AND ${perpSessions.status} = 'open'`,
      )
      .all();

    if (rows.length === 0) return null;
    return this.rowToSession(rows[0]);
  }

  /**
   * Update mutable fields of a perp session.
   */
  updateSession(
    id: string,
    updates: Partial<
      Pick<
        PerpSession,
        'markPrice' | 'unrealizedPnl' | 'cumulativeFundingCost' | 'status' | 'closedAt' | 'closeReason'
      >
    >,
  ): void {
    const setFields: Record<string, unknown> = {};
    if (updates.markPrice !== undefined) setFields['markPrice'] = updates.markPrice;
    if (updates.unrealizedPnl !== undefined) setFields['unrealizedPnl'] = updates.unrealizedPnl;
    if (updates.cumulativeFundingCost !== undefined) setFields['cumulativeFundingCost'] = updates.cumulativeFundingCost;
    if (updates.status !== undefined) setFields['status'] = updates.status;
    if (updates.closedAt !== undefined) setFields['closedAt'] = updates.closedAt;
    if (updates.closeReason !== undefined) setFields['closeReason'] = updates.closeReason;

    this.db
      .update(perpSessions)
      .set(setFields)
      .where(eq(perpSessions.id, id))
      .run();
  }

  // ── Order persistence ─────────────────────────────────────────────

  /**
   * Persist a perp order (upsert by clientOrderId).
   */
  persistOrder(order: PerpOrder): void {
    const existing = this.getOrderByClientId(order.clientOrderId);
    if (existing) {
      this.db
        .update(perpOrders)
        .set({
          status: order.status,
          exchangeOrderId: order.exchangeOrderId ?? null,
          avgFillPrice: order.avgFillPrice ?? null,
          fee: order.fee ?? null,
          limitPrice: order.limitPrice ?? null,
          stopPrice: order.stopPrice ?? null,
          updatedAt: order.updatedAt,
        })
        .where(eq(perpOrders.clientOrderId, order.clientOrderId))
        .run();
    } else {
      this.db
        .insert(perpOrders)
        .values({
          clientOrderId: order.clientOrderId,
          sessionId: order.sessionId,
          instrument: order.instrument,
          side: order.side,
          size: order.size,
          status: order.status,
          purpose: order.purpose,
          exchangeOrderId: order.exchangeOrderId ?? null,
          avgFillPrice: order.avgFillPrice ?? null,
          fee: order.fee ?? null,
          limitPrice: order.limitPrice ?? null,
          stopPrice: order.stopPrice ?? null,
          createdAt: order.createdAt,
          updatedAt: order.updatedAt,
        })
        .run();
    }
  }

  /**
   * Get a perp order by its client-side UUID.
   */
  getOrderByClientId(clientOrderId: string): PerpOrder | null {
    const rows = this.db
      .select()
      .from(perpOrders)
      .where(eq(perpOrders.clientOrderId, clientOrderId))
      .all();

    if (rows.length === 0) return null;
    return this.rowToOrder(rows[0]);
  }

  /**
   * Get all PENDING orders for a session.
   */
  getPendingOrders(sessionId: string): PerpOrder[] {
    const rows = this.db
      .select()
      .from(perpOrders)
      .where(
        sql`${perpOrders.sessionId} = ${sessionId} AND ${perpOrders.status} = 'PENDING'`,
      )
      .all();

    return rows.map((row) => this.rowToOrder(row));
  }

  /**
   * Get all PENDING and OPEN orders for a session.
   * Used by cancelAllOpenOrders() to find orders eligible for cancellation.
   */
  getOpenOrdersBySession(sessionId: string): PerpOrder[] {
    const rows = this.db
      .select()
      .from(perpOrders)
      .where(
        sql`${perpOrders.sessionId} = ${sessionId} AND ${perpOrders.status} IN ('PENDING', 'OPEN')`,
      )
      .all();

    return rows.map((row) => this.rowToOrder(row));
  }

  // ── Trade persistence ─────────────────────────────────────────────

  /**
   * Insert one closed trade record into perp_trades.
   * Called by both closePosition() (live) and closePaperPosition() (paper).
   */
  recordTrade(record: PerpTradeRecord): void {
    this.db
      .insert(perpTrades)
      .values({
        sessionId: record.sessionId,
        instrument: record.instrument,
        direction: record.direction,
        leverage: record.leverage,
        entryPrice: record.entryPrice,
        exitPrice: record.exitPrice,
        size: record.size,
        cumulativeFundingCost: record.cumulativeFundingCost,
        realizedPnl: record.realizedPnl,
        openedAt: record.openedAt,
        closedAt: record.closedAt,
        closeReason: record.closeReason ?? null,
      })
      .run();

    log.info(
      { sessionId: record.sessionId, instrument: record.instrument, realizedPnl: record.realizedPnl },
      'Perp trade recorded',
    );
  }

  /**
   * Return all closed trade records from perp_trades, unfiltered.
   * Used by Phase 32-02 CLI analytics report.
   */
  listClosedTrades(): PerpTradeRecord[] {
    const rows = this.db.select().from(perpTrades).all();
    return rows.map((row) => this.rowToTrade(row));
  }

  // ── Lifecycle ─────────────────────────────────────────────────────

  /**
   * Close the database connection.
   */
  close(): void {
    this.sqlite.close();
  }

  // ── Private: row-to-object mappers ────────────────────────────────

  private rowToSession(row: typeof perpSessions.$inferSelect): PerpSession {
    return {
      id: row.id,
      instrument: row.instrument,
      direction: row.direction as PerpSession['direction'],
      entryPrice: row.entryPrice,
      size: row.size,
      leverage: row.leverage,
      liquidationPrice: row.liquidationPrice,
      maintenanceMarginRate: row.maintenanceMarginRate,
      marginMode: row.marginMode as 'isolated' | 'cross' | undefined ?? undefined,
      cumulativeFundingCost: row.cumulativeFundingCost ?? undefined,
      markPrice: row.markPrice ?? undefined,
      unrealizedPnl: row.unrealizedPnl ?? undefined,
      status: row.status as PerpSession['status'],
      openedAt: row.openedAt,
      closedAt: row.closedAt ?? undefined,
      closeReason: row.closeReason ?? undefined,
    };
  }

  private rowToOrder(row: typeof perpOrders.$inferSelect): PerpOrder {
    return {
      id: row.clientOrderId,
      clientOrderId: row.clientOrderId,
      sessionId: row.sessionId,
      instrument: row.instrument,
      side: row.side as PerpOrder['side'],
      size: row.size,
      status: row.status as PerpOrder['status'],
      purpose: row.purpose as PerpOrder['purpose'],
      exchangeOrderId: row.exchangeOrderId ?? undefined,
      avgFillPrice: row.avgFillPrice ?? undefined,
      fee: row.fee ?? undefined,
      limitPrice: row.limitPrice ?? undefined,
      stopPrice: row.stopPrice ?? undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private rowToTrade(row: typeof perpTrades.$inferSelect): PerpTradeRecord {
    return {
      sessionId: row.sessionId,
      instrument: row.instrument,
      direction: row.direction as 'long' | 'short',
      leverage: row.leverage,
      entryPrice: row.entryPrice,
      exitPrice: row.exitPrice,
      size: row.size,
      cumulativeFundingCost: row.cumulativeFundingCost,
      realizedPnl: row.realizedPnl,
      openedAt: row.openedAt,
      closedAt: row.closedAt,
      closeReason: row.closeReason ?? undefined,
    };
  }
}
