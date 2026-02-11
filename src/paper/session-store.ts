/**
 * SessionStore -- SQLite persistence for paper trading sessions.
 *
 * Stores sessions, trades (using the same Trade type as backtest), and
 * equity points. All Decimal fields are serialized to/from strings for
 * storage, preserving full precision.
 */

import crypto from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { d, ZERO, type Decimal } from '../core/decimal.js';
import { createModuleLogger } from '../core/logger.js';
import { createDatabase, initializeSchema } from '../data/storage/db.js';
import {
  paperSessions,
  paperTrades,
  paperEquity,
} from '../data/storage/schema.js';
import type { Trade, EquityPoint, SimulatedFill } from '../backtest/types.js';
import type { Signal } from '../strategies/types.js';
import type { TradingPair, Timeframe } from '../core/types.js';
import type { PaperTradingConfig, PaperSession, PaperTradingResult } from './types.js';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type * as schema from '../data/storage/schema.js';
import type Database from 'better-sqlite3';

const log = createModuleLogger('session-store');

export class SessionStore {
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
   * Create a new paper trading session.
   */
  createSession(
    config: PaperTradingConfig,
    strategyName: string,
  ): PaperSession {
    const id = crypto.randomUUID();
    const now = Date.now();

    this.db.insert(paperSessions).values({
      id,
      configJson: JSON.stringify(config),
      strategyName,
      pair: config.pair,
      timeframe: config.timeframe,
      startTime: now,
      initialCapital: config.initialCapital,
      status: 'running',
    }).run();

    const session: PaperSession = {
      id,
      config,
      strategyName,
      pair: config.pair as TradingPair,
      timeframe: config.timeframe as Timeframe,
      startTime: now,
      initialCapital: config.initialCapital,
      status: 'running',
    };

    log.info({ sessionId: id, strategyName, pair: config.pair }, 'Session created');
    return session;
  }

  /**
   * End a session with final equity and status.
   */
  endSession(
    sessionId: string,
    finalEquity: string,
    status: 'stopped' | 'error',
  ): void {
    this.db
      .update(paperSessions)
      .set({
        endTime: Date.now(),
        finalEquity,
        status,
      })
      .where(eq(paperSessions.id, sessionId))
      .run();

    log.info({ sessionId, finalEquity, status }, 'Session ended');
  }

  // ── Trade persistence ─────────────────────────────────────────────

  /**
   * Record a completed trade for a session.
   * Serializes Decimal fields to string and Signal to JSON.
   */
  recordTrade(sessionId: string, trade: Trade): void {
    this.db.insert(paperTrades).values({
      sessionId,
      entryTimestamp: trade.entryFill.fillTimestamp,
      entryPrice: trade.entryFill.fillPrice.toString(),
      entryFee: trade.entryFill.fee.toString(),
      entrySide: trade.entryFill.side,
      entryQuantity: trade.entryFill.quantity.toString(),
      entrySignalJson: JSON.stringify(trade.entryFill.signal),
      exitTimestamp: trade.exitFill.fillTimestamp,
      exitPrice: trade.exitFill.fillPrice.toString(),
      exitFee: trade.exitFill.fee.toString(),
      exitSide: trade.exitFill.side,
      exitQuantity: trade.exitFill.quantity.toString(),
      exitSignalJson: JSON.stringify(trade.exitFill.signal),
      pnl: trade.pnl.toString(),
      pnlPct: trade.pnlPct.toString(),
      holdingPeriodMs: trade.holdingPeriodMs,
    }).run();
  }

  // ── Equity persistence ────────────────────────────────────────────

  /**
   * Record an equity point for a session.
   */
  recordEquityPoint(
    sessionId: string,
    timestamp: number,
    equity: Decimal,
  ): void {
    this.db.insert(paperEquity).values({
      sessionId,
      timestamp,
      equity: equity.toString(),
    }).run();
  }

  // ── Query methods ─────────────────────────────────────────────────

  /**
   * Get a session by ID.
   */
  getSession(sessionId: string): PaperSession | null {
    const rows = this.db
      .select()
      .from(paperSessions)
      .where(eq(paperSessions.id, sessionId))
      .all();

    if (rows.length === 0) return null;
    return this.rowToSession(rows[0]);
  }

  /**
   * Get all trades for a session, reconstructing Trade objects with Decimals.
   */
  getSessionTrades(sessionId: string): Trade[] {
    const rows = this.db
      .select()
      .from(paperTrades)
      .where(eq(paperTrades.sessionId, sessionId))
      .all();

    return rows.map((row) => this.rowToTrade(row));
  }

  /**
   * Get equity curve for a session, sorted ascending by timestamp.
   */
  getSessionEquity(sessionId: string): EquityPoint[] {
    const rows = this.db
      .select()
      .from(paperEquity)
      .where(eq(paperEquity.sessionId, sessionId))
      .orderBy(paperEquity.timestamp)
      .all();

    return rows.map((row) => ({
      timestamp: row.timestamp,
      equity: d(row.equity),
    }));
  }

  /**
   * Get complete result for a session (session + trades + equity + fees).
   */
  getResult(sessionId: string): PaperTradingResult | null {
    const session = this.getSession(sessionId);
    if (!session) return null;

    const trades = this.getSessionTrades(sessionId);
    const equityCurve = this.getSessionEquity(sessionId);

    // Compute total fees from all entry + exit fees
    let totalFees = ZERO;
    for (const trade of trades) {
      totalFees = totalFees.plus(trade.entryFill.fee).plus(trade.exitFill.fee);
    }

    const finalEquity = session.finalEquity
      ? d(session.finalEquity)
      : equityCurve.length > 0
        ? equityCurve[equityCurve.length - 1].equity
        : d(session.initialCapital);

    return {
      session,
      trades,
      equityCurve,
      finalEquity,
      totalFees,
    };
  }

  /**
   * List sessions, optionally filtered by status.
   */
  listSessions(status?: string): PaperSession[] {
    let rows;
    if (status) {
      rows = this.db
        .select()
        .from(paperSessions)
        .where(eq(paperSessions.status, status))
        .all();
    } else {
      rows = this.db.select().from(paperSessions).all();
    }

    return rows.map((row) => this.rowToSession(row));
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.sqlite.close();
  }

  // ── Private: row-to-object mappers ────────────────────────────────

  private rowToSession(row: typeof paperSessions.$inferSelect): PaperSession {
    return {
      id: row.id,
      config: JSON.parse(row.configJson) as PaperTradingConfig,
      strategyName: row.strategyName,
      pair: row.pair as TradingPair,
      timeframe: row.timeframe as Timeframe,
      startTime: row.startTime,
      endTime: row.endTime ?? undefined,
      initialCapital: row.initialCapital,
      finalEquity: row.finalEquity ?? undefined,
      status: row.status as 'running' | 'stopped' | 'error',
    };
  }

  private rowToTrade(row: typeof paperTrades.$inferSelect): Trade {
    const entrySignal = JSON.parse(row.entrySignalJson) as Signal;
    const exitSignal = row.exitSignalJson
      ? (JSON.parse(row.exitSignalJson) as Signal)
      : entrySignal;

    const entryFill: SimulatedFill = {
      signal: entrySignal,
      fillPrice: d(row.entryPrice),
      fillTimestamp: row.entryTimestamp,
      fee: d(row.entryFee),
      quantity: d(row.entryQuantity),
      side: row.entrySide as 'buy' | 'sell',
    };

    const exitFill: SimulatedFill = {
      signal: exitSignal,
      fillPrice: d(row.exitPrice ?? '0'),
      fillTimestamp: row.exitTimestamp ?? 0,
      fee: d(row.exitFee ?? '0'),
      quantity: d(row.exitQuantity ?? '0'),
      side: (row.exitSide as 'buy' | 'sell') ?? 'sell',
    };

    return {
      entryFill,
      exitFill,
      pnl: d(row.pnl ?? '0'),
      pnlPct: d(row.pnlPct ?? '0'),
      holdingPeriodMs: row.holdingPeriodMs ?? 0,
    };
  }
}
