/**
 * Drizzle ORM table definitions for the trading bot database.
 *
 * CRITICAL: OHLCV columns are TEXT to preserve decimal precision.
 * CRITICAL: timestamp is INTEGER storing Unix milliseconds UTC.
 */

import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const candles = sqliteTable(
  'candles',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    pair: text('pair').notNull(),
    timeframe: text('timeframe').notNull(),
    timestamp: integer('timestamp').notNull(),
    open: text('open').notNull(),
    high: text('high').notNull(),
    low: text('low').notNull(),
    close: text('close').notNull(),
    volume: text('volume').notNull(),
  },
  (table) => [
    index('idx_candles_pair_tf_ts').on(
      table.pair,
      table.timeframe,
      table.timestamp,
    ),
    uniqueIndex('idx_candles_unique').on(
      table.pair,
      table.timeframe,
      table.timestamp,
    ),
  ],
);

// ── Paper Trading Tables ────────────────────────────────────────────

export const paperSessions = sqliteTable('paper_sessions', {
  id: text('id').primaryKey(),
  configJson: text('config_json').notNull(),
  strategyName: text('strategy_name').notNull(),
  pair: text('pair').notNull(),
  timeframe: text('timeframe').notNull(),
  startTime: integer('start_time').notNull(),
  endTime: integer('end_time'),
  initialCapital: text('initial_capital').notNull(),
  finalEquity: text('final_equity'),
  status: text('status').notNull().default('running'),
});

export const paperTrades = sqliteTable(
  'paper_trades',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: text('session_id').notNull(),
    entryTimestamp: integer('entry_timestamp').notNull(),
    entryPrice: text('entry_price').notNull(),
    entryFee: text('entry_fee').notNull(),
    entrySide: text('entry_side').notNull(),
    entryQuantity: text('entry_quantity').notNull(),
    entrySignalJson: text('entry_signal_json').notNull(),
    exitTimestamp: integer('exit_timestamp'),
    exitPrice: text('exit_price'),
    exitFee: text('exit_fee'),
    exitSide: text('exit_side'),
    exitQuantity: text('exit_quantity'),
    exitSignalJson: text('exit_signal_json'),
    pnl: text('pnl'),
    pnlPct: text('pnl_pct'),
    holdingPeriodMs: integer('holding_period_ms'),
  },
  (table) => [index('idx_paper_trades_session').on(table.sessionId)],
);

export const paperEquity = sqliteTable(
  'paper_equity',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: text('session_id').notNull(),
    timestamp: integer('timestamp').notNull(),
    equity: text('equity').notNull(),
  },
  (table) => [
    index('idx_paper_equity_session_ts').on(table.sessionId, table.timestamp),
  ],
);
