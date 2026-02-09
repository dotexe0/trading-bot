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
