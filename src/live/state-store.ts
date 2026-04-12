/**
 * LiveStateStore -- SQLite persistence for live trading sessions.
 *
 * Stores sessions, orders, trades, and equity points. All decimal
 * fields are serialized to/from strings for storage, preserving
 * full precision. Follows the SessionStore pattern from paper trading.
 */

import crypto from 'node:crypto';
import { eq, sql, inArray } from 'drizzle-orm';
import { d } from '../core/decimal.js';
import { createModuleLogger } from '../core/logger.js';
import { createDatabase, initializeSchema } from '../data/storage/db.js';
import {
  liveSessions,
  liveOrders,
  liveTrades,
  liveEquity,
} from '../data/storage/schema.js';
import type { TradingPair, Timeframe } from '../core/types.js';
import type { EquityPoint } from '../backtest/types.js';
import type {
  LiveTradingConfig,
  LiveSession,
  LiveOrder,
  LiveTrade,
  OrderStatus,
} from './types.js';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type * as schema from '../data/storage/schema.js';
import type Database from 'better-sqlite3';

const log = createModuleLogger('live-state-store');

export class LiveStateStore {
  private db: BetterSQLite3Database<typeof schema>;
  private sqlite: Database.Database;

  constructor(options: { dbPath?: string } = {}) {
    const dbPath = options.dbPath ?? 'data/trading.db';
    const conn = createDatabase(dbPath);
    this.db = conn.db;
    this.sqlite = conn.sqlite;
    initializeSchema(conn.sqlite);

    // v3.1 migration: add trade journal columns to live_trades
    for (const col of ['strategy_name', 'regime_at_entry', 'exit_reason']) {
      try {
        this.sqlite.exec(`ALTER TABLE live_trades ADD COLUMN ${col} TEXT`);
      } catch {
        // Column already exists — ignore
      }
    }
  }

  // ── Session CRUD ──────────────────────────────────────────────────

  /**
   * Create a new live trading session.
   */
  createSession(
    config: LiveTradingConfig,
    strategyName: string,
  ): LiveSession {
    const id = crypto.randomUUID();
    const now = Date.now();

    this.db.insert(liveSessions).values({
      id,
      configJson: JSON.stringify(config),
      strategyName,
      pair: config.pair,
      timeframe: config.timeframe,
      startTime: now,
      initialCapital: config.initialCapital,
      status: 'running',
    }).run();

    const session: LiveSession = {
      id,
      config,
      strategyName,
      pair: config.pair as TradingPair,
      timeframe: config.timeframe as Timeframe,
      startTime: now,
      initialCapital: config.initialCapital,
      status: 'running',
      mode: 'live',
    };

    log.info({ sessionId: id, strategyName, pair: config.pair }, 'Live session created');
    return session;
  }

  /**
   * End a session with final equity and status.
   */
  endSession(
    sessionId: string,
    finalEquity: string,
    status: 'stopped' | 'error' | 'shutdown',
  ): void {
    this.db
      .update(liveSessions)
      .set({
        endTime: Date.now(),
        finalEquity,
        status,
      })
      .where(eq(liveSessions.id, sessionId))
      .run();

    log.info({ sessionId, finalEquity, status }, 'Live session ended');
  }

  /**
   * Get a session by ID.
   */
  getSession(sessionId: string): LiveSession | null {
    const rows = this.db
      .select()
      .from(liveSessions)
      .where(eq(liveSessions.id, sessionId))
      .all();

    if (rows.length === 0) return null;
    return this.rowToSession(rows[0]);
  }

  /**
   * List sessions, optionally filtered by status.
   */
  listSessions(status?: string): LiveSession[] {
    let rows;
    if (status) {
      rows = this.db
        .select()
        .from(liveSessions)
        .where(eq(liveSessions.status, status))
        .all();
    } else {
      rows = this.db.select().from(liveSessions).all();
    }

    return rows.map((row) => this.rowToSession(row));
  }

  // ── Order persistence ─────────────────────────────────────────────

  /**
   * Persist an order (upsert by orderId).
   */
  persistOrder(order: LiveOrder): void {
    // Try insert, on conflict update
    const existing = this.getOrder(order.orderId);
    if (existing) {
      this.db
        .update(liveOrders)
        .set({
          status: order.status,
          filledSize: order.filledSize,
          filledValue: order.filledValue,
          averageFillPrice: order.averageFillPrice ?? null,
          totalFees: order.totalFees,
          updatedAt: order.updatedAt,
        })
        .where(eq(liveOrders.orderId, order.orderId))
        .run();
    } else {
      this.db.insert(liveOrders).values({
        sessionId: order.sessionId,
        orderId: order.orderId,
        clientOrderId: order.clientOrderId,
        productId: order.productId,
        side: order.side,
        orderType: order.orderType,
        status: order.status,
        baseSize: order.baseSize,
        limitPrice: order.limitPrice ?? null,
        stopPrice: order.stopPrice ?? null,
        filledSize: order.filledSize,
        filledValue: order.filledValue,
        averageFillPrice: order.averageFillPrice ?? null,
        totalFees: order.totalFees,
        createdAt: order.createdAt,
        updatedAt: order.updatedAt,
        purpose: order.purpose,
        signalJson: order.signalJson ?? null,
      }).run();
    }
  }

  /**
   * Partial update of order status and fill fields.
   */
  updateOrderStatus(
    orderId: string,
    updates: Partial<Pick<LiveOrder, 'status' | 'filledSize' | 'filledValue' | 'averageFillPrice' | 'totalFees'>>,
  ): void {
    const setFields: Record<string, unknown> = {
      updatedAt: Date.now(),
    };
    if (updates.status !== undefined) setFields['status'] = updates.status;
    if (updates.filledSize !== undefined) setFields['filledSize'] = updates.filledSize;
    if (updates.filledValue !== undefined) setFields['filledValue'] = updates.filledValue;
    if (updates.averageFillPrice !== undefined) setFields['averageFillPrice'] = updates.averageFillPrice;
    if (updates.totalFees !== undefined) setFields['totalFees'] = updates.totalFees;

    this.db
      .update(liveOrders)
      .set(setFields)
      .where(eq(liveOrders.orderId, orderId))
      .run();
  }

  /**
   * Get an order by exchange orderId.
   */
  getOrder(orderId: string): LiveOrder | null {
    const rows = this.db
      .select()
      .from(liveOrders)
      .where(eq(liveOrders.orderId, orderId))
      .all();

    if (rows.length === 0) return null;
    return this.rowToOrder(rows[0]);
  }

  /**
   * Get an order by client-side UUID.
   */
  getOrderByClientId(clientOrderId: string): LiveOrder | null {
    const rows = this.db
      .select()
      .from(liveOrders)
      .where(eq(liveOrders.clientOrderId, clientOrderId))
      .all();

    if (rows.length === 0) return null;
    return this.rowToOrder(rows[0]);
  }

  /**
   * Get all open orders (PENDING or OPEN) for a session.
   */
  getOpenOrders(sessionId: string): LiveOrder[] {
    const rows = this.db
      .select()
      .from(liveOrders)
      .where(
        sql`${liveOrders.sessionId} = ${sessionId} AND ${liveOrders.status} IN ('PENDING', 'OPEN')`,
      )
      .all();

    return rows.map((row) => this.rowToOrder(row));
  }

  /**
   * Get pending orders (PENDING only) for restart recovery.
   */
  getPendingOrders(sessionId: string): LiveOrder[] {
    const rows = this.db
      .select()
      .from(liveOrders)
      .where(
        sql`${liveOrders.sessionId} = ${sessionId} AND ${liveOrders.status} = 'PENDING'`,
      )
      .all();

    return rows.map((row) => this.rowToOrder(row));
  }

  // ── Trade persistence ─────────────────────────────────────────────

  /**
   * Record a completed round-trip trade.
   */
  recordTrade(sessionId: string, trade: LiveTrade): void {
    this.db.insert(liveTrades).values({
      sessionId,
      entryOrderId: trade.entryOrderId,
      exitOrderId: trade.exitOrderId,
      entryTimestamp: trade.entryTimestamp,
      entryPrice: trade.entryPrice,
      entryFee: trade.entryFee,
      entrySide: trade.entrySide,
      entryQuantity: trade.entryQuantity,
      exitTimestamp: trade.exitTimestamp ?? null,
      exitPrice: trade.exitPrice ?? null,
      exitFee: trade.exitFee ?? null,
      exitSide: trade.exitSide ?? null,
      exitQuantity: trade.exitQuantity ?? null,
      pnl: trade.pnl ?? null,
      pnlPct: trade.pnlPct ?? null,
      holdingPeriodMs: trade.holdingPeriodMs ?? null,
      signalPrice: trade.signalPrice ?? null,
      exitSignalPrice: trade.exitSignalPrice ?? null,
      entrySlippageBps: trade.entrySlippageBps ?? null,
      exitSlippageBps: trade.exitSlippageBps ?? null,
      strategyName: trade.strategyName ?? null,
      regimeAtEntry: trade.regimeAtEntry ?? null,
      exitReason: trade.exitReason ?? null,
    }).run();
  }

  /**
   * Get all trades for a session.
   */
  getSessionTrades(sessionId: string): LiveTrade[] {
    const rows = this.db
      .select()
      .from(liveTrades)
      .where(eq(liveTrades.sessionId, sessionId))
      .all();

    return rows.map((row) => this.rowToTrade(row));
  }

  // ── Equity persistence ────────────────────────────────────────────

  /**
   * Record an equity point for a session.
   */
  recordEquityPoint(
    sessionId: string,
    timestamp: number,
    equity: string,
  ): void {
    this.db.insert(liveEquity).values({
      sessionId,
      timestamp,
      equity,
    }).run();
  }

  /**
   * Get equity curve for a session, sorted ascending by timestamp.
   */
  getSessionEquity(sessionId: string): EquityPoint[] {
    const rows = this.db
      .select()
      .from(liveEquity)
      .where(eq(liveEquity.sessionId, sessionId))
      .orderBy(liveEquity.timestamp)
      .all();

    return rows.map((row) => ({
      timestamp: row.timestamp,
      equity: d(row.equity),
    }));
  }

  // ── Lifecycle ─────────────────────────────────────────────────────

  /**
   * Close the database connection.
   */
  close(): void {
    this.sqlite.close();
  }

  // ── Private: row-to-object mappers ────────────────────────────────

  private rowToSession(row: typeof liveSessions.$inferSelect): LiveSession {
    return {
      id: row.id,
      config: JSON.parse(row.configJson) as LiveTradingConfig,
      strategyName: row.strategyName,
      pair: row.pair as TradingPair,
      timeframe: row.timeframe as Timeframe,
      startTime: row.startTime,
      endTime: row.endTime ?? undefined,
      initialCapital: row.initialCapital,
      finalEquity: row.finalEquity ?? undefined,
      status: row.status as LiveSession['status'],
      mode: 'live',
    };
  }

  private rowToOrder(row: typeof liveOrders.$inferSelect): LiveOrder {
    return {
      orderId: row.orderId,
      clientOrderId: row.clientOrderId,
      sessionId: row.sessionId,
      productId: row.productId,
      side: row.side as LiveOrder['side'],
      orderType: row.orderType as LiveOrder['orderType'],
      status: row.status as LiveOrder['status'],
      baseSize: row.baseSize,
      limitPrice: row.limitPrice ?? undefined,
      stopPrice: row.stopPrice ?? undefined,
      filledSize: row.filledSize,
      filledValue: row.filledValue,
      averageFillPrice: row.averageFillPrice ?? undefined,
      totalFees: row.totalFees,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      purpose: row.purpose as LiveOrder['purpose'],
      signalJson: row.signalJson ?? undefined,
    };
  }

  private rowToTrade(row: typeof liveTrades.$inferSelect): LiveTrade {
    return {
      sessionId: row.sessionId,
      entryOrderId: row.entryOrderId,
      exitOrderId: row.exitOrderId,
      entryTimestamp: row.entryTimestamp,
      entryPrice: row.entryPrice,
      entryFee: row.entryFee,
      entrySide: row.entrySide as LiveTrade['entrySide'],
      entryQuantity: row.entryQuantity,
      exitTimestamp: row.exitTimestamp ?? undefined,
      exitPrice: row.exitPrice ?? undefined,
      exitFee: row.exitFee ?? undefined,
      exitSide: (row.exitSide as LiveTrade['exitSide']) ?? undefined,
      exitQuantity: row.exitQuantity ?? undefined,
      pnl: row.pnl ?? undefined,
      pnlPct: row.pnlPct ?? undefined,
      holdingPeriodMs: row.holdingPeriodMs ?? undefined,
      signalPrice: row.signalPrice ?? undefined,
      exitSignalPrice: row.exitSignalPrice ?? undefined,
      entrySlippageBps: row.entrySlippageBps ?? undefined,
      exitSlippageBps: row.exitSlippageBps ?? undefined,
      strategyName: row.strategyName ?? undefined,
      regimeAtEntry: row.regimeAtEntry ?? undefined,
      exitReason: row.exitReason ?? undefined,
    };
  }
}
