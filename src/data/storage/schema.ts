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
    regimeLeaderboardsJson: text('regime_leaderboards_json'),  // nullable — Phase 23 addition
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

// ── Monte Carlo Tables ──────────────────────────────────────────────

export const monteCarloResults = sqliteTable(
  'monte_carlo_results',
  {
    id: text('id').primaryKey(),
    backtestConfigJson: text('backtest_config_json').notNull(),
    strategyName: text('strategy_name').notNull(),
    iterations: integer('iterations').notNull(),
    tradeCount: integer('trade_count').notNull(),
    sharpeDistributionJson: text('sharpe_distribution_json').notNull(),
    drawdownDistributionJson: text('drawdown_distribution_json').notNull(),
    returnDistributionJson: text('return_distribution_json').notNull(),
    originalSharpe: text('original_sharpe').notNull(),
    originalMaxDrawdownPct: text('original_max_drawdown_pct').notNull(),
    originalTotalReturn: text('original_total_return').notNull(),
    initialCapital: text('initial_capital').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    index('idx_mc_results_strategy').on(table.strategyName),
    index('idx_mc_results_created').on(table.createdAt),
  ],
);

// -- Regime Detection Tables --

export const regimeHistory = sqliteTable(
  'regime_history',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    pair: text('pair').notNull(),
    timeframe: text('timeframe').notNull(),
    timestamp: integer('timestamp').notNull(),
    regime: text('regime').notNull(), // 'TRENDING' | 'RANGING' | 'VOLATILE'
  },
  (table) => [
    uniqueIndex('idx_regime_unique').on(
      table.pair,
      table.timeframe,
      table.timestamp,
    ),
    index('idx_regime_pair_tf_ts').on(
      table.pair,
      table.timeframe,
      table.timestamp,
    ),
  ],
);

// -- Correlation Snapshot Tables --

export const correlationSnapshots = sqliteTable(
  'correlation_snapshots',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    timeframe: text('timeframe').notNull(),
    timestamp: integer('timestamp').notNull(),
    correlation: text('correlation').notNull(), // stored as TEXT per project convention
    windowSize: integer('window_size').notNull(),
  },
  (table) => [
    uniqueIndex('idx_corr_unique').on(
      table.timeframe,
      table.timestamp,
    ),
    index('idx_corr_tf_ts').on(
      table.timeframe,
      table.timestamp,
    ),
  ],
);

// -- Backtest Run Tables --

export const backtestRuns = sqliteTable(
  'backtest_runs',
  {
    id: text('id').primaryKey(),
    strategyName: text('strategy_name').notNull(),
    pair: text('pair').notNull(),
    timeframe: text('timeframe').notNull(),
    startTimestamp: integer('start_timestamp').notNull(),
    endTimestamp: integer('end_timestamp').notNull(),
    initialCapital: text('initial_capital').notNull(),
    finalEquity: text('final_equity').notNull(),
    totalFees: text('total_fees').notNull(),
    tradeCount: integer('trade_count').notNull(),
    configJson: text('config_json').notNull(),
    tradesJson: text('trades_json').notNull(),
    equityJson: text('equity_json').notNull(),
    regimeBreakdownJson: text('regime_breakdown_json'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    index('idx_backtest_runs_strategy').on(table.strategyName),
    index('idx_backtest_runs_created').on(table.createdAt),
  ],
);

// ── Perp Trading Tables ─────────────────────────────────────────────

export const perpSessions = sqliteTable('perp_sessions', {
  id: text('id').primaryKey(),
  instrument: text('instrument').notNull(),
  direction: text('direction').notNull(),
  entryPrice: text('entry_price').notNull(),
  size: text('size').notNull(),
  leverage: integer('leverage').notNull(),
  liquidationPrice: text('liquidation_price').notNull(),
  maintenanceMarginRate: text('maintenance_margin_rate').notNull(),
  markPrice: text('mark_price'),
  unrealizedPnl: text('unrealized_pnl'),
  status: text('status').notNull().default('open'),
  openedAt: integer('opened_at').notNull(),
  closedAt: integer('closed_at'),
  closeReason: text('close_reason'),
});

export const perpOrders = sqliteTable(
  'perp_orders',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    clientOrderId: text('client_order_id').notNull().unique(),
    sessionId: text('session_id').notNull(),
    instrument: text('instrument').notNull(),
    side: text('side').notNull(),
    size: text('size').notNull(),
    status: text('status').notNull(),
    purpose: text('purpose').notNull(),
    exchangeOrderId: text('exchange_order_id'),
    avgFillPrice: text('avg_fill_price'),
    fee: text('fee'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [index('idx_perp_orders_session').on(table.sessionId)],
);

// -- Exit Config Optimizer Tables --

export const exitConfigOptimizations = sqliteTable(
  'exit_config_optimizations',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    strategyName: text('strategy_name').notNull(),
    strategyConfigHash: text('strategy_config_hash').notNull(),
    exitConfigJson: text('exit_config_json').notNull(),
    profitFactor: text('profit_factor').notNull(), // TEXT per project decimal convention
    searchedAt: integer('searched_at').notNull(),
  },
  (table) => [
    uniqueIndex('idx_exit_opt_strategy_hash').on(
      table.strategyName,
      table.strategyConfigHash,
    ),
    index('idx_exit_opt_strategy').on(table.strategyName),
  ],
);
