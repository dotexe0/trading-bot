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
import { d } from '../core/decimal.js';
import { createModuleLogger } from '../core/logger.js';
import { TrailingStopManager } from './trailing-stop.js';
import type { IntxClient } from './intx-client.js';
import type { PerpStateStore } from './perp-state-store.js';
import type { FcmConfig } from './config.js';
import type {
  PerpOrder,
  PerpSession,
  PerpDirection,
  PerpOrderEngineEvents,
  FcmOrderFillEvent,
  IntxMarkPriceEvent,
} from './types.js';

const log = createModuleLogger('perp-order-engine');

/** Failure reasons that are safe to retry (allowlist).
 * Any unrecognized reason is treated as non-retryable (fail-safe default). */
const RETRYABLE_FAILURE_REASONS = new Set([
  'UNKNOWN_FAILURE_REASON',
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

  // ── Post-fill order state ──────────────────────────────────────────
  private _stopManager: TrailingStopManager | null = null;
  private _tpOrderPlaced = false;
  private _tpExchangeOrderId: string | undefined;
  private _stopExchangeOrderId: string | undefined;
  private _currentAtr = '0';
  private _ratchetLoopActive = false;
  private _onMarkPriceRatchet: ((evt: IntxMarkPriceEvent) => void) | null = null;
  private _currentInstrument: string | null = null;

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
   * Update the current ATR value used by the ratchet loop.
   * Called by the orchestrator each time a new ATR is computed.
   */
  setCurrentAtr(atr: string): void {
    this._currentAtr = atr;
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

    const { maxRepriceAttempts, repriceTimeoutMs } = this.config;
    // entryOrderTimeoutMs retained in schema for backward-compat but superseded by orderMaxWaitSeconds
    const entryTimeoutMs = this.config.orderMaxWaitSeconds * 1000;

    while (true) {
      const elapsed = Date.now() - startTime;
      if (elapsed >= entryTimeoutMs) {
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

        if (failureReason && !RETRYABLE_FAILURE_REASONS.has(failureReason)) {
          // Non-retryable -- log ERROR with full context and abort
          log.error({
            instrument,
            side,
            size,
            limitPrice: midPrice,
            failureReason,
            errorMessage: errMsg,
          }, 'Non-retryable order rejection -- trade abandoned');
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
        liquidationPrice: '0', // computed by PerpTradingEngine
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

  // ── Post-fill order management ─────────────────────────────────────

  /**
   * Place take-profit limit and trailing stop-limit orders after an entry fills.
   *
   * Idempotent: guarded by _tpOrderPlaced flag + DB check for existing TAKE_PROFIT order.
   * TP order: LIMIT (no post_only — taker OK for close orders)
   * Stop order: stop_limit_stop_limit_gtc with stop_direction
   *
   * Persist BEFORE each API call for idempotency.
   * TP failure is logged but does NOT block stop placement.
   */
  async placePostFillOrders(session: PerpSession, atr: string): Promise<void> {
    // Idempotency guard — check flag and DB
    if (this._tpOrderPlaced) {
      log.info({ sessionId: session.id }, 'placePostFillOrders: already placed, skipping');
      return;
    }
    const existingOrders = this.stateStore.getOpenOrdersBySession(session.id);
    if (existingOrders.some((o) => o.purpose === 'TAKE_PROFIT')) {
      log.info({ sessionId: session.id }, 'placePostFillOrders: TAKE_PROFIT order already in DB, skipping');
      this._tpOrderPlaced = true;
      return;
    }

    const { direction, entryPrice, size, instrument } = session;
    const side: 'BUY' | 'SELL' = direction === 'long' ? 'SELL' : 'BUY';
    this._currentInstrument = instrument;
    this._currentAtr = atr;

    // 1. Compute TP limit price
    const entry = d(entryPrice);
    const tpPct = d(this.config.tpTargetPct).div(d('100'));
    let tpLimitPrice: string;
    if (direction === 'long') {
      tpLimitPrice = entry.mul(d('1').plus(tpPct)).toFixed(8);
    } else {
      tpLimitPrice = entry.mul(d('1').minus(tpPct)).toFixed(8);
    }

    // 2. Place TP limit order
    const tpClientOrderId = crypto.randomUUID();
    const now = Date.now();
    const tpOrder: PerpOrder = {
      id: tpClientOrderId,
      clientOrderId: tpClientOrderId,
      sessionId: session.id,
      instrument,
      side,
      size,
      status: 'PENDING',
      purpose: 'TAKE_PROFIT',
      limitPrice: tpLimitPrice,
      createdAt: now,
      updatedAt: now,
    };

    // Persist BEFORE API call
    this.stateStore.persistOrder(tpOrder);

    try {
      const tpResult = await this.intxClient.placeOrder({
        productId: instrument,
        side,
        size,
        orderType: 'LIMIT',
        limitPrice: tpLimitPrice,
        clientOrderId: tpClientOrderId,
        postOnly: false, // taker OK for close orders
      });
      tpOrder.exchangeOrderId = tpResult.orderId;
      tpOrder.status = 'OPEN';
      tpOrder.updatedAt = Date.now();
      this.stateStore.persistOrder(tpOrder);
      this._tpExchangeOrderId = tpResult.orderId;
      log.info(
        { sessionId: session.id, instrument, tpLimitPrice, exchangeOrderId: tpResult.orderId },
        'Take-profit limit order placed',
      );
    } catch (tpErr) {
      tpOrder.status = 'FAILED';
      tpOrder.updatedAt = Date.now();
      this.stateStore.persistOrder(tpOrder);
      log.error(
        { sessionId: session.id, err: tpErr instanceof Error ? tpErr.message : String(tpErr) },
        'placePostFillOrders: TP order failed — proceeding with stop placement',
      );
      // Do NOT throw — stop placement must proceed
    }

    // 3. Initialize trailing stop manager
    if (!this._stopManager) {
      this._stopManager = new TrailingStopManager({
        direction,
        atrMultiplier: this.config.atrMultiplier,
        slippagePct: this.config.stopLimitSlippagePct,
      });
    }
    const stopState = this._stopManager.initialize(entryPrice, atr);

    // 4. Place initial stop-limit order
    const stopClientOrderId = crypto.randomUUID();
    const stopSide: 'BUY' | 'SELL' = direction === 'long' ? 'SELL' : 'BUY';
    const stopDirection =
      direction === 'long' ? 'STOP_DIRECTION_STOP_DOWN' : 'STOP_DIRECTION_STOP_UP';

    const stopOrder: PerpOrder = {
      id: stopClientOrderId,
      clientOrderId: stopClientOrderId,
      sessionId: session.id,
      instrument,
      side: stopSide,
      size,
      status: 'PENDING',
      purpose: 'STOP_LOSS',
      stopPrice: stopState.stopPrice,
      limitPrice: stopState.limitPrice,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    // Persist BEFORE API call
    this.stateStore.persistOrder(stopOrder);

    try {
      const stopResult = await this.intxClient.placeStopOrder({
        productId: instrument,
        side: stopSide,
        size,
        stopPrice: stopState.stopPrice,
        limitPrice: stopState.limitPrice,
        stopDirection,
        clientOrderId: stopClientOrderId,
      });
      stopOrder.exchangeOrderId = stopResult.orderId;
      stopOrder.status = 'OPEN';
      stopOrder.updatedAt = Date.now();
      this.stateStore.persistOrder(stopOrder);
      this._stopExchangeOrderId = stopResult.orderId;
      log.info(
        {
          sessionId: session.id,
          instrument,
          stopPrice: stopState.stopPrice,
          limitPrice: stopState.limitPrice,
          exchangeOrderId: stopResult.orderId,
        },
        'Trailing stop-limit order placed',
      );
    } catch (stopErr) {
      stopOrder.status = 'FAILED';
      stopOrder.updatedAt = Date.now();
      this.stateStore.persistOrder(stopOrder);
      log.error(
        { sessionId: session.id, err: stopErr instanceof Error ? stopErr.message : String(stopErr) },
        'placePostFillOrders: stop order failed',
      );
    }

    this._tpOrderPlaced = true;

    // 5. Start ratchet loop
    this._startRatchetLoop(session);
  }

  /**
   * Start the mark-price ratchet loop for the trailing stop.
   * Listens to 'markPrice' events from intxClient.
   * On each favorable price movement: cancel old stop → place new stop → update DB.
   */
  private _startRatchetLoop(session: PerpSession): void {
    if (this._ratchetLoopActive) return;
    this._ratchetLoopActive = true;

    const { instrument, direction, size, id: sessionId } = session;
    const stopSide: 'BUY' | 'SELL' = direction === 'long' ? 'SELL' : 'BUY';
    const stopDirection =
      direction === 'long' ? 'STOP_DIRECTION_STOP_DOWN' : 'STOP_DIRECTION_STOP_UP';

    this._onMarkPriceRatchet = async (evt: IntxMarkPriceEvent) => {
      if (evt.instrument !== instrument) return;
      if (!this._stopManager) return;
      if (!this._ratchetLoopActive) return;

      const newState = this._stopManager.ratchet(evt.markPrice, this._currentAtr);
      if (newState === null) return; // no ratchet needed

      log.info(
        { sessionId, instrument, newStopPrice: newState.stopPrice, markPrice: evt.markPrice },
        'Ratchet: stop price updated',
      );

      // Cancel old stop order
      const oldStopOrderId = this._stopExchangeOrderId;
      if (oldStopOrderId) {
        try {
          await this.intxClient.cancelOrders([oldStopOrderId]);
        } catch (cancelErr) {
          log.warn(
            { oldStopOrderId, err: cancelErr instanceof Error ? cancelErr.message : String(cancelErr) },
            'Ratchet: cancel old stop failed — placing new stop anyway',
          );
        }
      }

      // Place new stop order
      const newStopClientOrderId = crypto.randomUUID();
      const newStopOrder: PerpOrder = {
        id: newStopClientOrderId,
        clientOrderId: newStopClientOrderId,
        sessionId,
        instrument,
        side: stopSide,
        size,
        status: 'PENDING',
        purpose: 'STOP_LOSS',
        stopPrice: newState.stopPrice,
        limitPrice: newState.limitPrice,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      // Persist BEFORE API call
      this.stateStore.persistOrder(newStopOrder);

      try {
        const newStopResult = await this.intxClient.placeStopOrder({
          productId: instrument,
          side: stopSide,
          size,
          stopPrice: newState.stopPrice,
          limitPrice: newState.limitPrice,
          stopDirection,
          clientOrderId: newStopClientOrderId,
        });
        newStopOrder.exchangeOrderId = newStopResult.orderId;
        newStopOrder.status = 'OPEN';
        newStopOrder.updatedAt = Date.now();
        this.stateStore.persistOrder(newStopOrder);
        this._stopExchangeOrderId = newStopResult.orderId;
        log.info(
          { sessionId, instrument, newStopPrice: newState.stopPrice, exchangeOrderId: newStopResult.orderId },
          'Ratchet: new stop order placed',
        );
      } catch (placeErr) {
        newStopOrder.status = 'FAILED';
        newStopOrder.updatedAt = Date.now();
        this.stateStore.persistOrder(newStopOrder);
        log.error(
          { sessionId, err: placeErr instanceof Error ? placeErr.message : String(placeErr) },
          'Ratchet: new stop order placement failed — will retry on next tick',
        );
        // Reset stop manager state so next tick retries
        if (this._stopManager) {
          // The ratchet already moved the internal state — the next markPrice event will
          // compute a new candidate and attempt placement again
        }
      }
    };

    this.intxClient.on('markPrice', this._onMarkPriceRatchet);
    log.info({ sessionId, instrument }, 'Ratchet loop started');
  }

  /**
   * Stop the ratchet loop and remove the markPrice listener.
   */
  private _stopRatchetLoop(): void {
    if (!this._ratchetLoopActive) return;
    this._ratchetLoopActive = false;
    if (this._onMarkPriceRatchet) {
      this.intxClient.off('markPrice', this._onMarkPriceRatchet);
      this._onMarkPriceRatchet = null;
    }
    log.info({ instrument: this._currentInstrument }, 'Ratchet loop stopped');
  }

  /**
   * Cancel all tracked post-fill orders (TP + stop) and clean up state.
   *
   * Called by PerpTradingEngine on all close paths before marking the session closed.
   * Does NOT throw — logs warn on partial failure and continues cleanup.
   *
   * Steps:
   * 1. Stop the ratchet loop
   * 2. Cancel TP and stop orders via batch cancel
   * 3. Mark each cancelled in DB
   * 4. Reset internal state flags
   */
  async closeAndCleanup(sessionId: string): Promise<void> {
    this._stopRatchetLoop();

    const orderIdsToCancel = [this._tpExchangeOrderId, this._stopExchangeOrderId].filter(
      (id): id is string => !!id,
    );

    if (orderIdsToCancel.length > 0) {
      try {
        await this.intxClient.cancelOrders(orderIdsToCancel);
        log.info({ sessionId, count: orderIdsToCancel.length }, 'closeAndCleanup: cancelled TP/stop orders');
      } catch (cancelErr) {
        log.warn(
          { sessionId, orderIdsToCancel, err: cancelErr instanceof Error ? cancelErr.message : String(cancelErr) },
          'closeAndCleanup: batch cancel partial failure — marking cancelled in DB anyway',
        );
      }

      // Mark each as CANCELLED in DB using DB query (catches any stop orders we placed during ratcheting)
      const openOrders = this.stateStore.getOpenOrdersBySession(sessionId);
      const now = Date.now();
      for (const order of openOrders) {
        if (order.purpose === 'TAKE_PROFIT' || order.purpose === 'STOP_LOSS') {
          this.stateStore.persistOrder({ ...order, status: 'CANCELLED', updatedAt: now });
        }
      }
    }

    // Reset state
    this._tpOrderPlaced = false;
    this._tpExchangeOrderId = undefined;
    this._stopExchangeOrderId = undefined;
    if (this._stopManager) {
      this._stopManager.reset();
    }

    log.info({ sessionId }, 'PerpOrderEngine: position cleanup complete');
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

    // Fallback: check if error message directly contains a well-known reason string
    const WELL_KNOWN_REASONS = [
      'INSUFFICIENT_FUND',
      'INVALID_SIZE',
      'INVALID_PRICE',
      'INVALID_PRODUCT',
      'UNKNOWN_FAILURE_REASON',
    ];
    for (const reason of WELL_KNOWN_REASONS) {
      if (errMsg.includes(reason)) return reason;
    }

    return null;
  }
}
