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
  | 'shutdown'
  | 'perpPositionUpdate'
  | 'perpFundingUpdate'
  | 'perpExposureUpdate'
  | 'perpFundingHistory'
  | 'perpPnlUpdate'
  | 'perpMarkPriceUpdate'
  | 'feedHealth'
  | 'systemHealth';

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
  strategyName?: string;
  regimeAtEntry?: string;
  exitReason?: string;
  signalPrice?: string;
  exitSignalPrice?: string;
  entrySlippageBps?: string;
  exitSlippageBps?: string;
  entryConfidence?: number;
  entryFillType?: 'limit' | 'market';
  mode?: 'spot' | 'perp';
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
  perpFundingHistory?: PerpFundingBarPayload[];
  perpPnlHistory?: PerpPnlPointPayload[];
  perpFundingRates?: PerpFundingPayload[];
  feedHealth?: FeedHealthPayload[];
  systemHealth?: SystemHealthPayload;
}

// ── Perp Payloads ─────────────────────────────────────────────────────

export interface PerpPositionPayload {
  id: string;
  instrument: string;
  direction: 'long' | 'short';
  leverage: number;
  entryPrice: string;
  size: string;
  liquidationPrice: string;
  markPrice?: string;
  unrealizedPnl?: string;
  cumulativeFundingCost?: string;
  status: 'open' | 'closed' | 'emergency_closed';
  openedAt: number;
}

export interface PerpFundingPayload {
  instrument: string;
  currentFundingRate: string;
  cumulativeFundingCost: string;
}

export interface PerpExposurePayload {
  totalNotionalUsd: string;
  exposureCapUsd: string;
  utilizationPct: string;
}

export interface PerpFundingBarPayload {
  /** FCM product ID, e.g. 'BTC-PERP-INTX' */
  instrument: string;
  /** Unix seconds (Math.floor(timestamp / 1000)) */
  time: number;
  /** Bar height = Math.abs(fundingRate) */
  value: number;
  /** '#22c55e' for negative rate (longs paid), '#ef4444' for positive (shorts paid) */
  color: string;
}

export interface PerpPnlPointPayload {
  /** Unix seconds */
  time: number;
  /** Unrealized P&L as float (positive = profit, negative = loss) */
  value: number;
}

// ── Feed Health ─────────────────────────────────────────────────────

export interface FeedHealthPayload {
  instrument: string;
  status: 'LIVE' | 'STALE' | 'DEAD';
  lastCandleAt: number | null;
  lastMarkPriceAt: number | null;
}

export interface SystemHealthPayload {
  recoveryState: 'NORMAL' | 'RECOVERING' | 'RECONCILIATION_NEEDED';
  lastReconciliationAt: number | null;
  feedHealth: FeedHealthPayload[];
  riskProximity: {
    currentDrawdownPct: number;
    maxDrawdownPct: number;
    currentExposurePct: number;
    maxExposurePct: number;
  };
}

// ── Tournament Leaderboard ────────────────────────────────────────────

export interface TournamentLeaderboardEntry {
  rank: number;
  strategyName: string;
  strategyConfig?: Record<string, unknown>;
  isSharpe: number;
  oosSharpe: number;
  robustnessRatio: number;
  oosTradeCount: number;
  oosWinRate: number;
  disqualified: boolean;
  disqualifyReason: string | null;
  active: boolean;
}

export interface TournamentLeaderboard {
  runAt: number;
  strategiesEvaluated: number;
  leaderboard: TournamentLeaderboardEntry[];
}

// ── Perp Tournament Leaderboard ───────────────────────────────────────

export interface PerpTournamentEntry {
  rank: number;
  strategyName: string;
  strategyConfig: Record<string, unknown>;
  isSharpe: number;
  oosSharpe: number;
  robustnessRatio: number;
  oosTradeCount: number;
  oosWinRate: number;
  disqualified: boolean;
  disqualifyReason: string | null;
}

export interface PerpTournamentLeaderboard {
  runAt: number;
  strategiesEvaluated: number;
  leaderboard: PerpTournamentEntry[];
}

// ── Gate Status ──────────────────────────────────────────────────────

export interface GateStatusData {
  passed: boolean;
  spotTradeCount: number;
  perpTradeCount: number;
  totalTradeCount: number;
  spotNetPnl: string;
  perpNetPnl: string;
  totalNetPnl: string;
  spotWinRate: number;
  perpWinRate: number;
  failReasons: string[];
  config: {
    minTrades: number;
    minNetPnl: number;
    lookbackTrades?: number;
  };
  riskConfig: {
    maxDrawdownPct?: number;
    maxExposurePct?: number;
    maxDailyLossPct?: number;
    maxPositionCount?: number;
  };
  feeConfig: {
    spotTakerRate: number;
    spotFeeSource?: string;
    perpTakerRate?: number;
    perpFeeSource?: string;
  };
}
