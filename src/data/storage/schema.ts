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

// ── Live Trading Tables ─────────────────────────────────────────────

export const liveSessions = sqliteTable('live_sessions', {
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

export const liveOrders = sqliteTable(
  'live_orders',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: text('session_id').notNull(),
    orderId: text('order_id').notNull(),
    clientOrderId: text('client_order_id').notNull(),
    productId: text('product_id').notNull(),
    side: text('side').notNull(),
    orderType: text('order_type').notNull(),
    status: text('status').notNull(),
    baseSize: text('base_size').notNull(),
    limitPrice: text('limit_price'),
    stopPrice: text('stop_price'),
    filledSize: text('filled_size').notNull().default('0'),
    filledValue: text('filled_value').notNull().default('0'),
    averageFillPrice: text('average_fill_price'),
    totalFees: text('total_fees').notNull().default('0'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    purpose: text('purpose').notNull(),
    signalJson: text('signal_json'),
  },
  (table) => [
    uniqueIndex('idx_live_orders_order_id').on(table.orderId),
    uniqueIndex('idx_live_orders_client_order_id').on(table.clientOrderId),
    index('idx_live_orders_session').on(table.sessionId),
    index('idx_live_orders_status').on(table.status),
  ],
);

export const liveTrades = sqliteTable(
  'live_trades',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: text('session_id').notNull(),
    entryOrderId: text('entry_order_id').notNull(),
    exitOrderId: text('exit_order_id').notNull(),
    entryTimestamp: integer('entry_timestamp').notNull(),
    entryPrice: text('entry_price').notNull(),
    entryFee: text('entry_fee').notNull(),
    entrySide: text('entry_side').notNull(),
    entryQuantity: text('entry_quantity').notNull(),
    exitTimestamp: integer('exit_timestamp'),
    exitPrice: text('exit_price'),
    exitFee: text('exit_fee'),
    exitSide: text('exit_side'),
    exitQuantity: text('exit_quantity'),
    pnl: text('pnl'),
    pnlPct: text('pnl_pct'),
    holdingPeriodMs: integer('holding_period_ms'),
  },
  (table) => [index('idx_live_trades_session').on(table.sessionId)],
);

export const liveEquity = sqliteTable(
  'live_equity',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: text('session_id').notNull(),
    timestamp: integer('timestamp').notNull(),
    equity: text('equity').notNull(),
  },
  (table) => [
    index('idx_live_equity_session_ts').on(table.sessionId, table.timestamp),
  ],
);

// ── Tournament Tables ──────────────────────────────────────────────

export const tournaments = sqliteTable(
  'tournaments',
  {
    id: text('id').primaryKey(),
    configJson: text('config_json').notNull(),
    leaderboardJson: text('leaderboard_json').notNull(),
    runTimestamp: integer('run_timestamp').notNull(),
    durationMs: integer('duration_ms').notNull(),
    strategiesEvaluated: integer('strategies_evaluated').notNull(),
  },
  (table) => [
    index('idx_tournaments_run_timestamp').on(table.runTimestamp),
  ],
);

export const activeStrategies = sqliteTable(
  'active_strategies',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    tournamentId: text('tournament_id').notNull(),
    strategyName: text('strategy_name').notNull(),
    strategyConfigJson: text('strategy_config_json').notNull(),
    rank: integer('rank').notNull(),
    oosSharpe: text('oos_sharpe').notNull(),
    activationMode: text('activation_mode').notNull(),
    sessionId: text('session_id'),
    activatedAt: integer('activated_at').notNull(),
    deactivatedAt: integer('deactivated_at'),
  },
  (table) => [
    index('idx_active_strategies_tournament').on(table.tournamentId),
    index('idx_active_strategies_mode_active').on(
      table.activationMode,
      table.deactivatedAt,
    ),
  ],
);
