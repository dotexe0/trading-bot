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

/** Typed EventEmitter event map for IntxClient. */
export interface IntxClientEvents {
  markPrice: [IntxMarkPriceEvent];
  fundingRate: [IntxFundingRateEvent];
  connected: [];
  disconnected: [];
  reconnected: [];
  reconnectFailed: [{ attempts: number }];
  error: [Error];
}

// ── REST Types ────────────────────────────────────────────────────────

/**
 * INTX account state: balances, open positions, and portfolio summary.
 * Typed loosely — Phase 27 will tighten based on CBInternationalClient
 * response shape.
 */
export interface IntxAccountState {
  balances: unknown;
  positions: unknown;
  summary: unknown;
}

/** Parameters for placing a perpetual order on INTX. */
export interface PlaceOrderParams {
  instrument: string;
  side: 'BUY' | 'SELL';
  size: string;
  orderType: 'MARKET' | 'LIMIT';
  limitPrice?: string;
  clientOrderId?: string;
}

/** Parameters for cancelling a perpetual order on INTX. */
export interface CancelOrderParams {
  orderId: string;
  portfolioId: string;
}

// ── Config re-export ─────────────────────────────────────────────────

/** Re-export IntxConfig from config.ts for convenience. */
export type { IntxConfig } from './config.js';
