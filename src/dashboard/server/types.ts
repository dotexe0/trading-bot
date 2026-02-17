/**
 * Dashboard API and WebSocket type definitions.
 *
 * All financial values in API responses are strings (no Decimal objects
 * in JSON). Helper functions convert store objects to JSON-safe format.
 */

import type { LiveSession, LiveOrder, LiveTrade } from '../../live/types.js';
import type { PaperSession } from '../../paper/types.js';
import type { Trade } from '../../backtest/types.js';

// ── WebSocket Message Types ──────────────────────────────────────────

export type WsMessageType =
  | 'priceTick'
  | 'equityUpdate'
  | 'orderFilled'
  | 'orderSubmitted'
  | 'orderCancelled'
  | 'orderFailed'
  | 'circuitBreaker'
  | 'engineStarted'
  | 'engineStopped'
  | 'riskUpdate'
  | 'snapshot'
  | 'error'
  | 'reconciliation'
  | 'shutdown';

export interface WsMessage {
  type: WsMessageType;
  payload: unknown;
  timestamp: number;
}

export interface WsCommand {
  action: 'startStrategy' | 'stopStrategy' | 'killSwitch';
  params?: Record<string, unknown>;
}

// ── API Response Types ───────────────────────────────────────────────

export interface ApiSession {
  id: string;
  strategyName: string;
  pair: string;
  timeframe: string;
  startTime: number;
  endTime?: number;
  initialCapital: string;
  finalEquity?: string;
  status: string;
  mode: 'live' | 'paper';
}

export interface ApiTrade {
  sessionId: string;
  entryTimestamp: number;
  entryPrice: string;
  entryFee: string;
  entrySide: string;
  entryQuantity: string;
  exitTimestamp?: number;
  exitPrice?: string;
  exitFee?: string;
  exitSide?: string;
  exitQuantity?: string;
  pnl?: string;
  pnlPct?: string;
  holdingPeriodMs?: number;
}

export interface ApiOrder {
  orderId: string;
  clientOrderId: string;
  sessionId: string;
  productId: string;
  side: string;
  orderType: string;
  status: string;
  baseSize: string;
  limitPrice?: string;
  stopPrice?: string;
  filledSize: string;
  filledValue: string;
  averageFillPrice?: string;
  totalFees: string;
  createdAt: number;
  updatedAt: number;
  purpose: string;
}

export interface ApiEquityPoint {
  timestamp: number;
  equity: string;
}

export interface ApiRiskStatus {
  circuitBreakerTripped: boolean;
  thresholds: {
    maxDrawdownPct?: number;
    maxExposurePct?: number;
    maxDailyLossPct?: number;
    maxPositionCount?: number;
  };
}

export interface ApiStrategyInfo {
  name: string;
  sessionId: string;
  status: 'running' | 'stopped';
}

// ── Conversion Helpers ───────────────────────────────────────────────

/** Convert a LiveSession to a JSON-safe API session. */
export function toApiSession(session: LiveSession): ApiSession {
  return {
    id: session.id,
    strategyName: session.strategyName,
    pair: session.pair,
    timeframe: session.timeframe,
    startTime: session.startTime,
    endTime: session.endTime,
    initialCapital: session.initialCapital,
    finalEquity: session.finalEquity,
    status: session.status,
    mode: 'live',
  };
}

/** Convert a PaperSession to a JSON-safe API session. */
export function toApiPaperSession(session: PaperSession): ApiSession {
  return {
    id: session.id,
    strategyName: session.strategyName,
    pair: session.pair,
    timeframe: session.timeframe,
    startTime: session.startTime,
    endTime: session.endTime,
    initialCapital: session.initialCapital,
    finalEquity: session.finalEquity,
    status: session.status,
    mode: 'paper',
  };
}

/** Convert a LiveTrade to a JSON-safe API trade. */
export function toApiTrade(trade: LiveTrade): ApiTrade {
  return {
    sessionId: trade.sessionId,
    entryTimestamp: trade.entryTimestamp,
    entryPrice: trade.entryPrice,
    entryFee: trade.entryFee,
    entrySide: trade.entrySide,
    entryQuantity: trade.entryQuantity,
    exitTimestamp: trade.exitTimestamp,
    exitPrice: trade.exitPrice,
    exitFee: trade.exitFee,
    exitSide: trade.exitSide,
    exitQuantity: trade.exitQuantity,
    pnl: trade.pnl,
    pnlPct: trade.pnlPct,
    holdingPeriodMs: trade.holdingPeriodMs,
  };
}

/** Convert a paper Trade (backtest type with Decimals) to a JSON-safe API trade. */
export function toApiPaperTrade(sessionId: string, trade: Trade): ApiTrade {
  return {
    sessionId,
    entryTimestamp: trade.entryFill.fillTimestamp,
    entryPrice: trade.entryFill.fillPrice.toString(),
    entryFee: trade.entryFill.fee.toString(),
    entrySide: trade.entryFill.side,
    entryQuantity: trade.entryFill.quantity.toString(),
    exitTimestamp: trade.exitFill.fillTimestamp,
    exitPrice: trade.exitFill.fillPrice.toString(),
    exitFee: trade.exitFill.fee.toString(),
    exitSide: trade.exitFill.side,
    exitQuantity: trade.exitFill.quantity.toString(),
    pnl: trade.pnl.toString(),
    pnlPct: trade.pnlPct.toString(),
    holdingPeriodMs: trade.holdingPeriodMs,
  };
}

/** Convert a LiveOrder to a JSON-safe API order. */
export function toApiOrder(order: LiveOrder): ApiOrder {
  return {
    orderId: order.orderId,
    clientOrderId: order.clientOrderId,
    sessionId: order.sessionId,
    productId: order.productId,
    side: order.side,
    orderType: order.orderType,
    status: order.status,
    baseSize: order.baseSize,
    limitPrice: order.limitPrice,
    stopPrice: order.stopPrice,
    filledSize: order.filledSize,
    filledValue: order.filledValue,
    averageFillPrice: order.averageFillPrice,
    totalFees: order.totalFees,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    purpose: order.purpose,
  };
}
