/**
 * INTX / Perpetual Futures type definitions.
 *
 * Isolated from spot types (src/core/types.ts, src/paper/types.ts, etc.).
 * All price and size fields use string for decimal precision consistency
 * (matches Trade type in src/backtest/types.ts).
 */

// ── WebSocket Events ─────────────────────────────────────────────────

/** Mark price event emitted by the INTX WebSocket feed. */
export interface IntxMarkPriceEvent {
  instrument: string;
  markPrice: string;
  indexPrice: string;
  timestamp: number;
  isStale: boolean;
}

/** Funding rate event emitted by the INTX WebSocket feed. */
export interface IntxFundingRateEvent {
  instrument: string;
  fundingRate: string;
  isFinal: boolean;
  timestamp: number;
  isStale: boolean;
}

// ── EventEmitter Events ──────────────────────────────────────────────

/** Order fill event emitted by the FCM user channel WebSocket feed. */
export interface FcmOrderFillEvent {
  orderId: string;          // exchange order_id
  clientOrderId: string;
  productId: string;
  side: 'BUY' | 'SELL';
  filledSize: string;
  avgFillPrice: string;
  totalFees: string;
  timestamp: number;
}

/** Typed EventEmitter event map for IntxClient. */
export interface IntxClientEvents {
  markPrice: [IntxMarkPriceEvent];
  fundingRate: [IntxFundingRateEvent];
  orderFill: [FcmOrderFillEvent];
  connected: [];
  disconnected: [];
  reconnected: [];
  reconnectFailed: [{ attempts: number }];
  error: [Error];
}

// ── REST Types ────────────────────────────────────────────────────────

/**
 * FCM account state: futures balance summary and open positions.
 */
export interface IntxAccountState {
  balances: unknown;
  positions: Array<{
    product_id?: string;
    side?: string;        // 'LONG' | 'SHORT'
    number_of_contracts?: string;
    current_price?: string;
    avg_entry_price?: string;
    unrealized_pnl?: string;
    [key: string]: unknown;
  }>;
  summary: unknown;
}

/** Parameters for placing a perpetual futures order via FCM. */
export interface PlaceOrderParams {
  productId?: string;   // FCM product ID (preferred): 'BIP-20DEC30-CDE', 'ETP-20DEC30-CDE'
  instrument?: string;  // legacy alias — falls back to productId if productId not set
  side: 'BUY' | 'SELL';
  size: string;
  orderType: 'MARKET' | 'LIMIT';
  limitPrice?: string;
  clientOrderId?: string;
  closeOnly?: boolean;
  postOnly?: boolean;
}

/** Parameters for cancelling a perpetual futures order via FCM. */
export interface CancelOrderParams {
  orderId: string;
  portfolioId?: string; // optional — not used by FCM
}

// ── Perp Position Types ──────────────────────────────────────────────

/** Direction of a perp position. */
export type PerpDirection = 'long' | 'short';

/** Status of a perp session (open position lifecycle). */
export type PerpSessionStatus = 'open' | 'closed' | 'emergency_closed';

/** An open or closed perp position session. */
export interface PerpSession {
  id: string;                   // UUID session ID
  instrument: string;           // 'BIP-20DEC30-CDE' | 'ETP-20DEC30-CDE'
  direction: PerpDirection;
  entryPrice: string;           // decimal string
  size: string;                 // base units (decimal string)
  leverage: number;
  liquidationPrice: string;     // decimal string; computed pre-entry
  maintenanceMarginRate: string; // decimal string (e.g. '0.0333')
  markPrice?: string;           // last known mark price
  unrealizedPnl?: string;       // decimal string
  cumulativeFundingCost?: string; // signed decimal string; negative = paid, positive = received
  marginMode?: 'isolated' | 'cross'; // bot-internal margin policy; undefined for legacy rows
  status: PerpSessionStatus;
  openedAt: number;             // Unix ms
  closedAt?: number;            // Unix ms
  closeReason?: string;
}

/** A persisted perp order record (entry or exit). */
export interface PerpOrder {
  id: string;                   // client_order_id (UUID); updated to exchange order_id on fill
  clientOrderId: string;
  sessionId: string;
  instrument: string;
  side: 'BUY' | 'SELL';
  size: string;
  status: 'PENDING' | 'OPEN' | 'FILLED' | 'FAILED' | 'CANCELLED';
  purpose: 'ENTRY' | 'EXIT' | 'EMERGENCY_CLOSE' | 'TAKE_PROFIT' | 'STOP_LOSS';
  exchangeOrderId?: string;     // set after API confirms
  avgFillPrice?: string;
  fee?: string;
  limitPrice?: string;
  stopPrice?: string;
  createdAt: number;
  updatedAt: number;
}

/** Typed event map for PerpPositionManager. */
export interface PerpPositionManagerEvents {
  positionOpened: [PerpSession];
  positionClosed: [PerpSession];
  emergencyClose: [PerpSession, { markPrice: string; distancePct: string }];
  liquidationDistance: [{ sessionId: string; instrument: string; distancePct: string; markPrice: string }];
  /** Emitted when the active strategy is switched due to a regime change. */
  strategySwitch: [{ newStrategy: string }];
  /** Emitted on each non-stale funding rate event — even when no position is open (sessionId is null). */
  fundingUpdate: [{ sessionId: string | null; instrument: string; currentFundingRate: string; cumulativeFundingCost: string; cumulativeFundingPct: string; unrealizedPnl?: string }];
  /** Emitted when cumulative funding cost exceeds the drain threshold. */
  fundingDrain: [PerpSession, { cumulativeFundingCost: string }];
  /** Emitted after positionOpened and positionClosed with current total notional vs cap. */
  exposureUpdate: [{ totalNotionalUsd: string; exposureCapUsd: string; utilizationPct: string }];
  error: [Error];
}

/** Typed event map for PerpOrderEngine. */
export interface PerpOrderEngineEvents {
  entryFilled: [{ sessionId: string; order: PerpOrder; session: PerpSession }];
  entryFailed: [{ reason: string; attempts: number }];
  repriced: [{ attempt: number; oldPrice: string; newPrice: string }];
  error: [Error];
}

// ── Risk Gate Types ───────────────────────────────────────────────────

/** Result of a PerpRiskGate check. */
export interface RiskGateResult {
  approved: boolean;
  rejectReason?: 'MARGIN_UTILIZATION_EXCEEDED' | 'EXPOSURE_CAP_EXCEEDED' | 'MAX_LOSS_EXCEEDED' | 'FEE_DRAG_EXCESSIVE';
  details: Record<string, string>;
}

/** Input parameters for PerpRiskGate.check(). */
export interface PerpRiskGateParams {
  instrument: string;
  proposedNotional: string; // decimal string: size * entryPrice (before leverage divisor)
  proposedMaxLoss: string;  // decimal string: proposedNotional * stopDistancePct
  accountValue: string;     // decimal string: total FCM account equity
  expectedGain: string;     // decimal string: estimated gain for this trade (e.g. notional * tpTargetPct / 100)
}

// ── Config re-export ─────────────────────────────────────────────────

/** Re-export IntxConfig from config.ts for convenience. */
export type { IntxConfig } from './config.js';
