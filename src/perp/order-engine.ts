/**
 * PerpOrderEngine — post-only limit order entry loop for FCM perpetual futures.
 *
 * ORDER-01: All entry orders are submitted as limit_limit_gtc with post_only: true.
 * ORDER-02: When the exchange rejects with a taker-would-fill failure (post-only
 *           rejected), the engine logs REPRICE and resubmits at current mid-price.
 *           The loop terminates when maxRepriceAttempts is exceeded or
 *           entryOrderTimeoutMs elapses. Non-retryable rejections abort immediately.
 *
 * Safety guarantee: persistOrder() is called BEFORE every API call (idempotency).
 */

import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { createModuleLogger } from '../core/logger.js';
import type { IntxClient } from './intx-client.js';
import type { PerpStateStore } from './perp-state-store.js';
import type { FcmConfig } from './config.js';
import type {
  PerpOrder,
  PerpSession,
  PerpDirection,
  PerpOrderEngineEvents,
  FcmOrderFillEvent,
} from './types.js';

const log = createModuleLogger('perp-order-engine');

/** Failure reasons that should never be retried. */
const NON_RETRYABLE_REASONS = new Set([
  'INSUFFICIENT_FUND',
  'INVALID_SIZE',
  'INVALID_PRICE',
  'INVALID_PRODUCT',
]);

/** Typed error for order placement failures. */
export class OrderError extends Error {
  constructor(
    message: string,
    public readonly isRetryable: boolean,
    public readonly failureReason?: string,
  ) {
    super(message);
    this.name = 'OrderError';
  }
}

/** Sleep helper. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class PerpOrderEngine extends EventEmitter {
  private intxClient: IntxClient;
  private stateStore: PerpStateStore;
  private config: FcmConfig;

  /** Typed emit override for PerpOrderEngineEvents. */
  override emit<K extends keyof PerpOrderEngineEvents>(
    event: K,
    ...args: PerpOrderEngineEvents[K]
  ): boolean {
    return super.emit(event, ...args);
  }

  constructor(options: {
    intxClient: IntxClient;
    stateStore: PerpStateStore;
    config: FcmConfig;
  }) {
    super();
    this.intxClient = options.intxClient;
    this.stateStore = options.stateStore;
    this.config = options.config;
  }

  /**
   * Submit a post-only limit entry order with cancel-reprice loop.
   *
   * 1. Generates clientOrderId and builds PENDING PerpOrder.
   * 2. Persists order BEFORE each API call (idempotency).
   * 3. Places order as limit_limit_gtc with post_only: true.
   * 4. On post-only rejection (taker-would-fill): cancels, emits 'repriced', retries at new mid.
   * 5. On non-retryable failure: marks order FAILED, throws OrderError(isRetryable: false).
   * 6. On max attempts or timeout: throws OrderError.
   * 7. On placement success: waits for 'orderFill' event or polls after 30s.
   * 8. On fill: updates order to FILLED, creates PerpSession, emits 'entryFilled'.
   */
  async submitEntryOrder(params: {
    instrument: string;
    direction: PerpDirection;
    size: string;
    midPrice: string;
    atr: string;
    getMidPrice: () => Promise<string>;
  }): Promise<PerpSession> {
    const { instrument, direction, size, getMidPrice } = params;
    let midPrice = params.midPrice;

    const clientOrderId = crypto.randomUUID();
    const sessionId = crypto.randomUUID(); // session ID allocated upfront for order tracking
    const side: 'BUY' | 'SELL' = direction === 'long' ? 'BUY' : 'SELL';
    const now = Date.now();
    const startTime = now;

    const order: PerpOrder = {
      id: clientOrderId,
      clientOrderId,
      sessionId,
      instrument,
      side,
      size,
      status: 'PENDING',
      purpose: 'ENTRY',
      limitPrice: midPrice,
      createdAt: now,
      updatedAt: now,
    };

    let attempt = 0;
    let exchangeOrderId: string | undefined;

    const { maxRepriceAttempts, entryOrderTimeoutMs, repriceTimeoutMs } = this.config;

    while (true) {
      const elapsed = Date.now() - startTime;
      if (elapsed >= entryOrderTimeoutMs) {
        order.status = 'FAILED';
        order.updatedAt = Date.now();
        this.stateStore.persistOrder(order);
        const err = new OrderError('Entry order timed out', false);
        this.emit('entryFailed', { reason: err.message, attempts: attempt });
        throw err;
      }

      if (attempt >= maxRepriceAttempts) {
        order.status = 'FAILED';
        order.updatedAt = Date.now();
        this.stateStore.persistOrder(order);
        const err = new OrderError('Max reprice attempts exceeded', false);
        this.emit('entryFailed', { reason: err.message, attempts: attempt });
        throw err;
      }

      // Update order limit price and persist BEFORE API call (idempotency)
      order.limitPrice = midPrice;
      order.status = 'PENDING';
      order.updatedAt = Date.now();
      this.stateStore.persistOrder(order);

      let placeResult: { orderId: string; status: string; execQty: string; avgPrice: string; fee: string } | null = null;
      let placeError: unknown = null;

      try {
        placeResult = await this.intxClient.placeOrder({
          productId: instrument,
          side,
          size,
          orderType: 'LIMIT',
          limitPrice: midPrice,
          clientOrderId,
          postOnly: true,
        });
      } catch (err) {
        placeError = err;
      }

      if (placeError !== null) {
        // Check if non-retryable
        const errMsg = placeError instanceof Error ? placeError.message : String(placeError);
        const failureReason = this._extractFailureReason(errMsg);

        if (failureReason && NON_RETRYABLE_REASONS.has(failureReason)) {
          order.status = 'FAILED';
          order.updatedAt = Date.now();
          this.stateStore.persistOrder(order);
          const orderErr = new OrderError(
            `Non-retryable order failure: ${failureReason}`,
            false,
            failureReason,
          );
          this.emit('entryFailed', { reason: orderErr.message, attempts: attempt });
          throw orderErr;
        }

        // Post-only rejection (taker-would-fill) or transient error → reprice
        const oldPrice = midPrice;
        order.status = 'CANCELLED';
        order.updatedAt = Date.now();
        this.stateStore.persistOrder(order);

        attempt++;
        await sleep(500);

        try {
          midPrice = await getMidPrice();
        } catch (mpErr) {
          log.warn({ err: mpErr instanceof Error ? mpErr.message : String(mpErr) }, 'getMidPrice failed during reprice — keeping previous price');
        }

        this.emit('repriced', { attempt, oldPrice, newPrice: midPrice });
        log.info({ attempt, oldPrice, newPrice: midPrice, instrument }, 'REPRICE: post-only rejected, retrying at new mid');

        // Reset order status for next attempt
        order.status = 'PENDING';
        continue;
      }

      // API call succeeded
      if (!placeResult || !placeResult.orderId) {
        // No order ID returned — treat as transient failure, reprice
        const oldPrice = midPrice;
        order.status = 'CANCELLED';
        order.updatedAt = Date.now();
        this.stateStore.persistOrder(order);

        attempt++;
        await sleep(500);

        try {
          midPrice = await getMidPrice();
        } catch (_) {
          // keep previous price
        }

        this.emit('repriced', { attempt, oldPrice, newPrice: midPrice });
        order.status = 'PENDING';
        continue;
      }

      // Order placed successfully — update to OPEN
      exchangeOrderId = placeResult.orderId;
      order.exchangeOrderId = exchangeOrderId;
      order.status = 'OPEN';
      order.updatedAt = Date.now();
      this.stateStore.persistOrder(order);

      log.info({ clientOrderId, exchangeOrderId, instrument, side, limitPrice: midPrice }, 'Post-only entry order placed — awaiting fill');

      // Wait for fill via orderFill event or 30s poll timeout
      const fillResult = await this._waitForFill(clientOrderId, exchangeOrderId, repriceTimeoutMs);

      if (fillResult === null) {
        // Timeout waiting for fill — cancel and reprice
        try {
          await this.intxClient.cancelOrders([exchangeOrderId]);
        } catch (cancelErr) {
          log.warn({ exchangeOrderId, err: cancelErr instanceof Error ? cancelErr.message : String(cancelErr) }, 'Cancel before reprice failed — continuing');
        }

        const oldPrice = midPrice;
        order.status = 'CANCELLED';
        order.updatedAt = Date.now();
        this.stateStore.persistOrder(order);

        attempt++;

        try {
          midPrice = await getMidPrice();
        } catch (_) {
          // keep previous price
        }

        this.emit('repriced', { attempt, oldPrice, newPrice: midPrice });
        log.info({ attempt, oldPrice, newPrice: midPrice, instrument }, 'REPRICE: fill timeout, retrying at new mid');
        order.status = 'PENDING';
        continue;
      }

      // Filled!
      order.status = 'FILLED';
      order.avgFillPrice = fillResult.avgFillPrice;
      order.fee = fillResult.totalFees;
      order.updatedAt = Date.now();
      this.stateStore.persistOrder(order);

      // Build PerpSession
      const session: PerpSession = {
        id: sessionId,
        instrument,
        direction,
        entryPrice: fillResult.avgFillPrice,
        size,
        leverage: 1, // caller can override via a separate param in future plans
        liquidationPrice: '0', // computed by PerpPositionManager
        maintenanceMarginRate: this.config.defaultMaintenanceMarginRate,
        status: 'open',
        openedAt: Date.now(),
      };

      this.stateStore.createSession(session);
      this.emit('entryFilled', { sessionId, order, session });

      log.info({ sessionId, instrument, direction, avgFillPrice: fillResult.avgFillPrice }, 'Entry order filled — session created');

      return session;
    }
  }

  /**
   * Cancel all open/pending orders for a session and mark them CANCELLED in DB.
   * Calls intxClient.cancelOrders() (the public batch cancel method).
   * Logs at info for success, warn for partial failures — does NOT throw.
   */
  async cancelAllOpenOrders(sessionId: string): Promise<void> {
    const orders = this.stateStore.getOpenOrdersBySession(sessionId);
    if (orders.length === 0) {
      log.info({ sessionId }, 'cancelAllOpenOrders: no open/pending orders found');
      return;
    }

    const exchangeOrderIds = orders
      .filter((o) => !!o.exchangeOrderId)
      .map((o) => o.exchangeOrderId!);

    if (exchangeOrderIds.length > 0) {
      try {
        await this.intxClient.cancelOrders(exchangeOrderIds);
        log.info({ sessionId, count: exchangeOrderIds.length }, 'Batch cancel of session orders complete');
      } catch (err) {
        log.warn(
          { sessionId, exchangeOrderIds, err: err instanceof Error ? err.message : String(err) },
          'Batch cancel partial failure — marking orders CANCELLED in DB regardless',
        );
      }
    }

    // Mark all in DB as CANCELLED
    const now = Date.now();
    for (const order of orders) {
      this.stateStore.persistOrder({ ...order, status: 'CANCELLED', updatedAt: now });
    }

    log.info({ sessionId, cancelled: orders.length }, 'cancelAllOpenOrders: DB records marked CANCELLED');
  }

  // ── Private helpers ────────────────────────────────────────────────

  /**
   * Wait for an orderFill event matching clientOrderId or exchangeOrderId.
   * Returns the fill event or null on timeout.
   */
  private _waitForFill(
    clientOrderId: string,
    exchangeOrderId: string,
    timeoutMs: number,
  ): Promise<FcmOrderFillEvent | null> {
    return new Promise((resolve) => {
      let resolved = false;
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          this.intxClient.off('orderFill', onFill);
          resolve(null);
        }
      }, timeoutMs);

      const onFill = (evt: FcmOrderFillEvent) => {
        if (
          evt.clientOrderId === clientOrderId ||
          evt.orderId === exchangeOrderId
        ) {
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            this.intxClient.off('orderFill', onFill);
            resolve(evt);
          }
        }
      };

      this.intxClient.on('orderFill', onFill);
    });
  }

  /**
   * Extract a failure_reason string from an error message.
   * Exchange errors typically include the reason as a JSON field.
   */
  private _extractFailureReason(errMsg: string): string | null {
    // Try to find failure_reason in JSON-like error messages
    const match = errMsg.match(/["\']?failure_reason["\']?\s*:\s*["\']?([A-Z_]+)["\']?/);
    if (match) return match[1];

    // Check if error message directly contains a known non-retryable reason
    for (const reason of NON_RETRYABLE_REASONS) {
      if (errMsg.includes(reason)) return reason;
    }

    return null;
  }
}
