/**
 * Live trading type system.
 *
 * Defines LiveTradingConfig, LiveSession, LiveOrder, LiveTrade,
 * ReconciliationReport, ShutdownState, and LiveEngineEvents.
 * Mirrors paper trading patterns but adds exchange-specific fields.
 */

import type { TradingPair, Timeframe } from '../core/types.js';
import type { z } from 'zod';
import type { liveConfigSchema } from './config.js';

// ── Live Trading Config (Zod-inferred) ──────────────────────────────

/** Validated live trading configuration, inferred from Zod schema. */
export type LiveTradingConfig = z.infer<typeof liveConfigSchema>;

// ── Order enums ─────────────────────────────────────────────────────

export type OrderSide = 'BUY' | 'SELL';
export type OrderType = 'MARKET' | 'LIMIT' | 'STOP_LIMIT';
export type OrderStatus =
  | 'PENDING'
  | 'OPEN'
  | 'FILLED'
  | 'CANCELLED'
  | 'FAILED'
  | 'CANCEL_QUEUED'
  | 'EXPIRED';
export type OrderPurpose = 'ENTRY' | 'EXIT' | 'STOP_LOSS' | 'PARTIAL_EXIT';

// ── Session ─────────────────────────────────────────────────────────

/** A live trading session record. */
export interface LiveSession {
  /** Unique session identifier */
  id: string;
  /** Configuration used for this session */
  config: LiveTradingConfig;
  /** Strategy name */
  strategyName: string;
  /** Trading pair */
  pair: TradingPair;
  /** Candle timeframe */
  timeframe: Timeframe;
  /** Session start time (Unix ms) */
  startTime: number;
  /** Session end time (Unix ms), undefined while running */
  endTime?: number;
  /** Initial capital as string for precision */
  initialCapital: string;
  /** Final equity as string, undefined while running */
  finalEquity?: string;
  /** Session status */
  status: 'running' | 'stopped' | 'error' | 'shutdown';
  /** Mode discriminator */
  mode: 'live';
}

// ── Live Order ──────────────────────────────────────────────────────

/** Full order lifecycle tracking for live exchange orders. */
export interface LiveOrder {
  /** Exchange-assigned order ID */
  orderId: string;
  /** Our UUID for client-side tracking */
  clientOrderId: string;
  /** Session this order belongs to */
  sessionId: string;
  /** Coinbase product ID (e.g. 'BTC-USD') */
  productId: string;
  /** Buy or sell */
  side: OrderSide;
  /** Order type */
  orderType: OrderType;
  /** Current status */
  status: OrderStatus;
  /** Requested base size */
  baseSize: string;
  /** Limit price for LIMIT orders */
  limitPrice?: string;
  /** Stop trigger price for STOP_LIMIT orders */
  stopPrice?: string;
  /** Amount filled so far */
  filledSize: string;
  /** Total value filled */
  filledValue: string;
  /** Weighted average fill price */
  averageFillPrice?: string;
  /** Total fees charged */
  totalFees: string;
  /** When order was created (Unix ms) */
  createdAt: number;
  /** When order was last updated (Unix ms) */
  updatedAt: number;
  /** Purpose of this order */
  purpose: OrderPurpose;
  /** Original signal JSON for debugging */
  signalJson?: string;
}

// ── Live Trade (round-trip) ─────────────────────────────────────────

/** A completed round-trip live trade. */
export interface LiveTrade {
  /** Session this trade belongs to */
  sessionId: string;
  /** Entry order ID */
  entryOrderId: string;
  /** Exit order ID */
  exitOrderId: string;
  /** Entry timestamp (Unix ms) */
  entryTimestamp: number;
  /** Entry price as string */
  entryPrice: string;
  /** Entry fee as string */
  entryFee: string;
  /** Entry side */
  entrySide: OrderSide;
  /** Entry quantity as string */
  entryQuantity: string;
  /** Exit timestamp (Unix ms), undefined if still open */
  exitTimestamp?: number;
  /** Exit price as string */
  exitPrice?: string;
  /** Exit fee as string */
  exitFee?: string;
  /** Exit side */
  exitSide?: OrderSide;
  /** Exit quantity as string */
  exitQuantity?: string;
  /** Realized PnL as string */
  pnl?: string;
  /** Realized PnL percentage as string */
  pnlPct?: string;
  /** Holding period in milliseconds */
  holdingPeriodMs?: number;
  /** Candle close price at entry signal time (string for precision) */
  signalPrice?: string;
  /** Candle close price at exit signal time, or stop trigger price for stop-loss exits */
  exitSignalPrice?: string;
  /** Entry slippage in basis points (positive = unfavorable) */
  entrySlippageBps?: string;
  /** Exit slippage in basis points (positive = unfavorable) */
  exitSlippageBps?: string;
  /** Strategy name at time of trade */
  strategyName?: string;
  /** Market regime at time of entry */
  regimeAtEntry?: string;
  /** Reason for exit (SIGNAL, STOP_LOSS, trailing_profit, etc.) */
  exitReason?: string;
}

// ── Reconciliation Report ───────────────────────────────────────────

export type DiscrepancyType =
  | 'UNTRACKED_ORDER'
  | 'MISSING_FROM_EXCHANGE'
  | 'STATUS_MISMATCH'
  | 'BALANCE_MISMATCH';

export type DiscrepancyAction = 'CANCEL' | 'SYNC' | 'LOG';

export interface Discrepancy {
  type: DiscrepancyType;
  orderId?: string;
  details: string;
  action: DiscrepancyAction;
}

export interface ReconciliationReport {
  /** Timestamp of reconciliation */
  timestamp: number;
  /** List of discrepancies found */
  discrepancies: Discrepancy[];
}

// ── Shutdown State ──────────────────────────────────────────────────

export type ShutdownState =
  | 'running'
  | 'blocking_signals'
  | 'cancelling_orders'
  | 'setting_stops'
  | 'closing_connections'
  | 'done';

// ── Live Engine Events ──────────────────────────────────────────────

/** Typed events for the SpotTradingEngine (live mode) EventEmitter. */
export interface LiveEngineEvents {
  orderSubmitted: [LiveOrder];
  orderFilled: [LiveOrder];
  orderCancelled: [LiveOrder];
  orderFailed: [LiveOrder, Error];
  reconciliation: [ReconciliationReport];
  shutdown: [ShutdownState];
  error: [Error];
  started: [LiveSession];
  stopped: [LiveSession];
}
