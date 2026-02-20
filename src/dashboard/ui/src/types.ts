/**
 * Frontend type definitions mirroring server WsMessage / WsCommand types
 * and defining frontend data interfaces.
 *
 * All financial values are strings (no floating-point rounding errors in display).
 */

// ── WebSocket Types ──────────────────────────────────────────────────

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

// ── Frontend Data Interfaces ─────────────────────────────────────────

export interface SessionData {
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

export interface TradeData {
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

export interface EquityPoint {
  timestamp: number;
  equity: string;
}

export interface PositionData {
  sessionId: string;
  pair: string;
  side: string;
  entryPrice: string;
  currentPrice: string;
  quantity: string;
  unrealizedPnl: string;
  unrealizedPnlPct: string;
  strategyName: string;
  orderId?: string;
  createdAt?: number;
}

export interface RiskStatus {
  circuitBreakerTripped: boolean;
  thresholds: {
    maxDrawdownPct?: number;
    maxExposurePct?: number;
    maxDailyLossPct?: number;
    maxPositionCount?: number;
  };
  currentDrawdownPct?: number;
  currentExposurePct?: number;
}

export interface StrategyInfo {
  name: string;
  sessionId: string;
  status: 'running' | 'stopped';
}

// ── Circuit Breaker Event ────────────────────────────────────────────

export interface CircuitBreakerEvent {
  timestamp: number;
  type: string;
  resolution: string;
  message?: string;
}

// ── Price Tick Payload ───────────────────────────────────────────────

export interface PriceTickPayload {
  pair: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  timestamp: number;
}

// ── Equity Update Payload ────────────────────────────────────────────

export interface EquityUpdatePayload {
  sessionId: string;
  timestamp: number;
  equity: string;
}

// ── Snapshot Payload ─────────────────────────────────────────────────

export interface SnapshotPayload {
  sessions: SessionData[];
  trades: TradeData[];
  equity: EquityPoint[];
  strategies: StrategyInfo[];
  risk?: RiskStatus;
}
