/**
 * IPerpOrderExecutor — strategy pattern interface for perp order placement.
 *
 * Abstracts the difference between paper (simulated) and live (real API) fills.
 * The unified PerpTradingEngine delegates only the fill mechanism to this interface;
 * all risk checks, state management, and event emission remain in the engine.
 */

import crypto from 'node:crypto';
import { d } from '../core/decimal.js';
import { createModuleLogger } from '../core/logger.js';
import type { IntxClient } from './intx-client.js';
import type { PerpStateStore } from './perp-state-store.js';
import type { PerpOrderEngine } from './order-engine.js';
import type { PerpSession, PerpOrder, PerpDirection } from './types.js';

// ── Shared types ─────────────────────────────────────────────────────

export interface PerpOpenParams {
  instrument: string;
  direction: PerpDirection;
  size: string;
  leverage: number;
  /** Mark price (paper) or desired entry price (live). */
  entryPrice: string;
  /** Bot session ID for order tracking (live only). */
  botSessionId?: string;
  marginMode?: 'isolated' | 'cross';
}

export interface PerpCloseParams {
  session: PerpSession;
  /** Current mark price used as exit price in paper mode. */
  markPrice: string;
  reason?: string;
}

export interface PerpFillResult {
  /** Actual fill price (same as markPrice in paper, avgPrice from exchange in live). */
  fillPrice: string;
  /** Fee charged (always '0' in paper). */
  fee: string;
  /** Exchange order ID (undefined in paper). */
  exchangeOrderId?: string;
}

// ── Interface ────────────────────────────────────────────────────────

export interface IPerpOrderExecutor {
  openPosition(params: PerpOpenParams): Promise<PerpFillResult>;
  closePosition(params: PerpCloseParams): Promise<PerpFillResult>;
  /** Cancel TP/stop orders on close (live only — no-op in paper). */
  cleanupOrders?(sessionId: string): Promise<void>;
}

// ── Paper implementation ─────────────────────────────────────────────

const paperLog = createModuleLogger('paper-perp-executor');

/**
 * Simulates fills instantly at mark price. No API calls made.
 */
export class PaperPerpOrderExecutor implements IPerpOrderExecutor {
  async openPosition(params: PerpOpenParams): Promise<PerpFillResult> {
    paperLog.info(
      { instrument: params.instrument, direction: params.direction, entryPrice: params.entryPrice },
      '[PAPER] Simulated fill at mark price',
    );
    return {
      fillPrice: params.entryPrice,
      fee: '0',
    };
  }

  async closePosition(params: PerpCloseParams): Promise<PerpFillResult> {
    paperLog.info(
      { instrument: params.session.instrument, markPrice: params.markPrice, reason: params.reason },
      '[PAPER] Simulated close at mark price',
    );
    return {
      fillPrice: params.markPrice,
      fee: '0',
    };
  }
}

// ── Live implementation ──────────────────────────────────────────────

const liveLog = createModuleLogger('live-perp-executor');

/**
 * Places real orders via IntxClient. Persists orders BEFORE API calls (idempotency).
 */
export class LivePerpOrderExecutor implements IPerpOrderExecutor {
  private intxClient: IntxClient;
  private stateStore: PerpStateStore;
  private _orderEngine: PerpOrderEngine | null;

  constructor(opts: {
    intxClient: IntxClient;
    stateStore: PerpStateStore;
    orderEngine?: PerpOrderEngine;
  }) {
    this.intxClient = opts.intxClient;
    this.stateStore = opts.stateStore;
    this._orderEngine = opts.orderEngine ?? null;
  }

  async openPosition(params: PerpOpenParams): Promise<PerpFillResult> {
    const { instrument, direction, size } = params;
    const clientOrderId = crypto.randomUUID();
    const now = Date.now();

    const order: PerpOrder = {
      id: clientOrderId,
      clientOrderId,
      sessionId: params.botSessionId ?? crypto.randomUUID(),
      instrument,
      side: direction === 'long' ? 'BUY' : 'SELL',
      size,
      status: 'PENDING',
      purpose: 'ENTRY',
      createdAt: now,
      updatedAt: now,
    };

    // Persist BEFORE API call (idempotency)
    this.stateStore.persistOrder(order);

    let result;
    try {
      result = await this.intxClient.placeOrder({
        productId: instrument,
        instrument,
        side: order.side,
        size,
        orderType: 'MARKET',
        clientOrderId,
      });
    } catch (err) {
      // Network error may have thrown AFTER the exchange accepted and filled.
      // Query account state to detect a silent fill before propagating the error.
      const silent = await this._detectSilentFill(instrument, direction);
      if (silent) {
        liveLog.warn(
          {
            instrument,
            direction,
            err: err instanceof Error ? err.message : String(err),
            fillPrice: silent.fillPrice,
          },
          'Silent fill detected: placeOrder threw but exchange shows position — treating as filled',
        );
        order.status = 'FILLED';
        order.avgFillPrice = silent.fillPrice;
        order.fee = silent.fee;
        order.updatedAt = Date.now();
        this.stateStore.persistOrder(order);
        return silent;
      }
      throw err;
    }

    // Update order with exchange data
    order.exchangeOrderId = result.orderId;
    order.status = 'FILLED';
    order.avgFillPrice = result.avgPrice;
    order.fee = result.fee;
    order.updatedAt = Date.now();
    this.stateStore.persistOrder(order);

    liveLog.info(
      { instrument, direction, orderId: result.orderId, avgPrice: result.avgPrice },
      'Entry order filled',
    );

    return {
      fillPrice: result.avgPrice,
      fee: result.fee,
      exchangeOrderId: result.orderId,
    };
  }

  private async _detectSilentFill(
    instrument: string,
    direction: PerpDirection,
  ): Promise<PerpFillResult | null> {
    try {
      const state = await this.intxClient.getAccountState();
      const expectedSide = direction === 'long' ? 'LONG' : 'SHORT';
      const positions = (state?.positions ?? []) as Array<Record<string, unknown>>;
      const match = positions.find(
        (p) =>
          p.product_id === instrument &&
          p.side === expectedSide &&
          Number(p.number_of_contracts ?? '0') > 0,
      );
      if (!match) return null;
      return {
        fillPrice: String(match.avg_entry_price ?? '0'),
        fee: '0',
      };
    } catch (detectErr) {
      liveLog.error(
        { err: detectErr instanceof Error ? detectErr.message : String(detectErr) },
        'Silent-fill detection failed — original placeOrder error will propagate',
      );
      return null;
    }
  }

  async closePosition(params: PerpCloseParams): Promise<PerpFillResult> {
    const { session, reason, markPrice } = params;
    const { instrument, direction, size } = session;
    const closeSide = direction === 'long' ? 'SELL' : 'BUY';
    const clientOrderId = crypto.randomUUID();
    const now = Date.now();

    const closeOrder: PerpOrder = {
      id: clientOrderId,
      clientOrderId,
      sessionId: session.id,
      instrument,
      side: closeSide,
      size,
      status: 'PENDING',
      purpose: reason === 'EMERGENCY_CLOSE' ? 'EMERGENCY_CLOSE' : 'EXIT',
      createdAt: now,
      updatedAt: now,
    };

    // Persist BEFORE API call
    this.stateStore.persistOrder(closeOrder);

    let result;
    try {
      result = await this.intxClient.placeOrder({
        productId: instrument,
        instrument,
        side: closeSide,
        size,
        orderType: 'MARKET',
        closeOnly: true,
        clientOrderId,
      });
    } catch (err) {
      // Network error may have thrown AFTER the exchange accepted and closed.
      // Query account state — if position is gone, treat as closed.
      const silentClose = await this._detectSilentClose(instrument, direction);
      if (silentClose) {
        liveLog.warn(
          { instrument, direction, err: err instanceof Error ? err.message : String(err) },
          'Silent close detected: placeOrder threw but exchange shows position gone — treating as closed',
        );
        closeOrder.status = 'FILLED';
        closeOrder.avgFillPrice = markPrice;
        closeOrder.fee = '0';
        closeOrder.updatedAt = Date.now();
        this.stateStore.persistOrder(closeOrder);
        return { fillPrice: markPrice, fee: '0' };
      }
      throw err;
    }

    // Update close order
    closeOrder.exchangeOrderId = result.orderId;
    closeOrder.status = 'FILLED';
    closeOrder.avgFillPrice = result.avgPrice;
    closeOrder.fee = result.fee;
    closeOrder.updatedAt = Date.now();
    this.stateStore.persistOrder(closeOrder);

    liveLog.info(
      { instrument, direction, orderId: result.orderId, avgPrice: result.avgPrice, reason },
      'Close order filled',
    );

    return {
      fillPrice: result.avgPrice,
      fee: result.fee,
      exchangeOrderId: result.orderId,
    };
  }

  private async _detectSilentClose(
    instrument: string,
    direction: PerpDirection,
  ): Promise<boolean> {
    try {
      const state = await this.intxClient.getAccountState();
      const expectedSide = direction === 'long' ? 'LONG' : 'SHORT';
      const positions = (state?.positions ?? []) as Array<Record<string, unknown>>;
      const match = positions.find(
        (p) =>
          p.product_id === instrument &&
          p.side === expectedSide &&
          Number(p.number_of_contracts ?? '0') > 0,
      );
      // Silent close: position that was open is no longer present (or zero).
      return !match;
    } catch (detectErr) {
      liveLog.error(
        { err: detectErr instanceof Error ? detectErr.message : String(detectErr) },
        'Silent-close detection failed — original placeOrder error will propagate',
      );
      return false;
    }
  }

  async cleanupOrders(sessionId: string): Promise<void> {
    if (!this._orderEngine) return;
    try {
      await this._orderEngine.closeAndCleanup(sessionId);
    } catch (err) {
      liveLog.warn({ err, sessionId }, 'Order cleanup failed, proceeding with close');
    }
  }
}
