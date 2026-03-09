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
import { perpSessions, perpOrders } from '../data/storage/schema.js';
import type { PerpSession, PerpOrder } from './types.js';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type * as schema from '../data/storage/schema.js';
import type Database from 'better-sqlite3';

const log = createModuleLogger('perp-state-store');

export class PerpStateStore {
  private db: BetterSQLite3Database<typeof schema>;
  private sqlite: Database.Database;

  constructor(options: { dbPath?: string } = {}) {
    const dbPath = options.dbPath ?? 'data/trading.db';
    const conn = createDatabase(dbPath);
    this.db = conn.db;
    this.sqlite = conn.sqlite;
    initializeSchema(conn.sqlite);
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
        'markPrice' | 'unrealizedPnl' | 'status' | 'closedAt' | 'closeReason'
      >
    >,
  ): void {
    const setFields: Record<string, unknown> = {};
    if (updates.markPrice !== undefined) setFields['markPrice'] = updates.markPrice;
    if (updates.unrealizedPnl !== undefined) setFields['unrealizedPnl'] = updates.unrealizedPnl;
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
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
