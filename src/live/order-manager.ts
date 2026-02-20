/**
 * OrderManager -- full order lifecycle management for live trading.
 *
 * Wraps CBAdvancedTradeClient for all order operations. Handles idempotent
 * submission (client_order_id persisted BEFORE API call), real-time WebSocket
 * user channel updates, periodic REST reconciliation, and graceful cancellation.
 *
 * All REST calls go through the RateLimiter. Order state is persisted to
 * LiveStateStore for crash recovery.
 */

import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import type { CBAdvancedTradeClient, WebsocketClient } from 'coinbase-api';
import type { RateLimiter } from './rate-limiter.js';
import type { LiveStateStore } from './state-store.js';
import type {
  LiveOrder,
  OrderSide,
  OrderStatus,
  ReconciliationReport,
  Discrepancy,
  LiveEngineEvents,
} from './types.js';
import { createModuleLogger } from '../core/logger.js';

const log = createModuleLogger('order-manager');

// ── Error class ──────────────────────────────────────────────────────

/** Typed error for order operations with retryability classification. */
export class OrderError extends Error {
  readonly orderId?: string;
  readonly failureReason?: string;
  readonly isRetryable: boolean;

  constructor(opts: {
    message: string;
    orderId?: string;
    failureReason?: string;
    isRetryable: boolean;
  }) {
    super(opts.message);
    this.name = 'OrderError';
    this.orderId = opts.orderId;
    this.failureReason = opts.failureReason;
    this.isRetryable = opts.isRetryable;
  }
}

// ── Non-retryable failure reasons from Coinbase ──────────────────────

const NON_RETRYABLE_REASONS = new Set([
  'INSUFFICIENT_FUND',
  'INVALID_SIZE',
  'INVALID_PRICE',
  'INVALID_PRODUCT',
  'UNKNOWN_ORDER_TYPE',
]);

// ── Types ────────────────────────────────────────────────────────────

export interface OrderManagerOptions {
  restClient: CBAdvancedTradeClient;
  wsClient: WebsocketClient;
  rateLimiter: RateLimiter;
  stateStore: LiveStateStore;
  sessionId: string;
  pairs: string[];
}

export interface SubmitMarketOrderParams {
  pair: string;
  side: OrderSide;
  baseSize: string;
  purpose?: LiveOrder['purpose'];
}

export interface SubmitStopLimitOrderParams {
  pair: string;
  side: OrderSide;
  baseSize: string;
  stopPrice: string;
  limitPrice: string;
  purpose?: LiveOrder['purpose'];
}

// ── OrderManager Events ──────────────────────────────────────────────

export interface OrderManagerEvents {
  orderFilled: [LiveOrder];
  orderCancelled: [LiveOrder];
  orderFailed: [LiveOrder, Error];
  reconciliation: [ReconciliationReport];
}

// ── OrderManager ─────────────────────────────────────────────────────

export class OrderManager extends EventEmitter {
  private readonly restClient: CBAdvancedTradeClient;
  private readonly wsClient: WebsocketClient;
  private readonly rateLimiter: RateLimiter;
  private readonly stateStore: LiveStateStore;
  private readonly sessionId: string;
  private readonly pairs: string[];
  private readonly trackedOrders: Map<string, LiveOrder> = new Map();

  constructor(options: OrderManagerOptions) {
    super();
    this.restClient = options.restClient;
    this.wsClient = options.wsClient;
    this.rateLimiter = options.rateLimiter;
    this.stateStore = options.stateStore;
    this.sessionId = options.sessionId;
    this.pairs = options.pairs;
  }

  // ── WebSocket Setup ──────────────────────────────────────────────

  /**
   * Start tracking orders via WebSocket user channel.
   * Loads existing open orders from stateStore into the tracked map.
   */
  startTracking(): void {
    // Load existing open orders from DB
    const openOrders = this.stateStore.getOpenOrders(this.sessionId);
    for (const order of openOrders) {
      this.trackedOrders.set(order.orderId, order);
    }
    log.info(
      { sessionId: this.sessionId, loadedOrders: openOrders.length },
      'Loaded existing open orders into tracker',
    );

    // Subscribe to user channel for order updates
    this.wsClient.subscribe(
      {
        topic: 'user',
        payload: { product_ids: this.pairs },
      },
      'advTradeUserData' as any,
    );

    // Subscribe to heartbeats for connection monitoring
    this.wsClient.subscribe(
      {
        topic: 'heartbeats',
        payload: { product_ids: [this.pairs[0]] },
      },
      'advTradeUserData' as any,
    );

    // Handle WebSocket update events
    this.wsClient.on('update', (data: any) => {
      if (data?.channel !== 'user') return;

      const events = data?.events;
      if (!Array.isArray(events)) return;

      for (const event of events) {
        const orders = event?.orders;
        if (!Array.isArray(orders)) continue;
        for (const wsOrder of orders) {
          this.onOrderUpdate(wsOrder);
        }
      }
    });

    // Handle reconnection -- trigger immediate reconciliation
    this.wsClient.on('reconnected', () => {
      log.warn('WebSocket reconnected, triggering immediate reconciliation');
      this.reconcile().catch((err) => {
        log.error({ err }, 'Post-reconnect reconciliation failed');
      });
    });

    log.info({ pairs: this.pairs }, 'Order tracking started');
  }

  // ── Order Submission ─────────────────────────────────────────────

  /**
   * Submit a market order (IOC).
   * Persists client_order_id BEFORE making the API call for idempotency.
   */
  async submitMarketOrder(params: SubmitMarketOrderParams): Promise<LiveOrder> {
    const clientOrderId = crypto.randomUUID();
    const now = Date.now();

    // Create order object with PENDING status
    const order: LiveOrder = {
      orderId: clientOrderId, // temporary, updated after API response
      clientOrderId,
      sessionId: this.sessionId,
      productId: params.pair,
      side: params.side,
      orderType: 'MARKET',
      status: 'PENDING',
      baseSize: params.baseSize,
      filledSize: '0',
      filledValue: '0',
      totalFees: '0',
      createdAt: now,
      updatedAt: now,
      purpose: params.purpose ?? 'ENTRY',
    };

    // Persist BEFORE API call (idempotency guarantee)
    this.stateStore.persistOrder(order);
    this.trackedOrders.set(order.orderId, order);

    log.info(
      { clientOrderId, pair: params.pair, side: params.side, baseSize: params.baseSize },
      'Submitting market order',
    );

    try {
      await this.rateLimiter.acquire();

      const response = await this.restClient.submitOrder({
        client_order_id: clientOrderId,
        product_id: params.pair,
        side: params.side,
        order_configuration: {
          market_market_ioc: {
            base_size: params.baseSize,
          },
        },
      });

      if (response.success && response.success_response) {
        const exchangeOrderId = response.success_response.order_id;

        // Remove temp entry, re-add with exchange ID
        this.trackedOrders.delete(order.orderId);
        order.orderId = exchangeOrderId;
        order.status = 'OPEN';
        order.updatedAt = Date.now();
        this.trackedOrders.set(exchangeOrderId, order);

        // Persist the updated order (with real exchange orderId)
        this.stateStore.persistOrder(order);

        this.emit('orderSubmitted', order);
        log.info(
          { clientOrderId, exchangeOrderId },
          'Market order submitted successfully',
        );
        return order;
      }

      // API returned failure
      order.status = 'FAILED';
      order.updatedAt = Date.now();
      this.stateStore.persistOrder(order);

      const errorMsg =
        response.error_response?.message ?? 'Unknown order submission error';
      throw new OrderError({
        message: errorMsg,
        orderId: order.orderId,
        failureReason: response.error_response?.new_order_failure_reason,
        isRetryable: !NON_RETRYABLE_REASONS.has(
          response.error_response?.new_order_failure_reason ?? '',
        ),
      });
    } catch (err) {
      if (err instanceof OrderError) throw err;

      // Network or unexpected error -- order stays PENDING for restart recovery
      log.error(
        { err, clientOrderId },
        'Network error submitting market order',
      );
      throw new OrderError({
        message: err instanceof Error ? err.message : 'Unknown error',
        orderId: order.orderId,
        isRetryable: true,
      });
    }
  }

  /**
   * Submit a stop-limit GTC order.
   * Persists client_order_id BEFORE making the API call for idempotency.
   */
  async submitStopLimitOrder(
    params: SubmitStopLimitOrderParams,
  ): Promise<LiveOrder> {
    const clientOrderId = crypto.randomUUID();
    const now = Date.now();

    const order: LiveOrder = {
      orderId: clientOrderId,
      clientOrderId,
      sessionId: this.sessionId,
      productId: params.pair,
      side: params.side,
      orderType: 'STOP_LIMIT',
      status: 'PENDING',
      baseSize: params.baseSize,
      stopPrice: params.stopPrice,
      limitPrice: params.limitPrice,
      filledSize: '0',
      filledValue: '0',
      totalFees: '0',
      createdAt: now,
      updatedAt: now,
      purpose: params.purpose ?? 'STOP_LOSS',
    };

    // Persist BEFORE API call
    this.stateStore.persistOrder(order);
    this.trackedOrders.set(order.orderId, order);

    log.info(
      {
        clientOrderId,
        pair: params.pair,
        side: params.side,
        stopPrice: params.stopPrice,
        limitPrice: params.limitPrice,
      },
      'Submitting stop-limit order',
    );

    try {
      await this.rateLimiter.acquire();

      const stopDirection =
        params.side === 'SELL'
          ? 'STOP_DIRECTION_STOP_DOWN'
          : 'STOP_DIRECTION_STOP_UP';

      const response = await this.restClient.submitOrder({
        client_order_id: clientOrderId,
        product_id: params.pair,
        side: params.side,
        order_configuration: {
          stop_limit_stop_limit_gtc: {
            base_size: params.baseSize,
            stop_price: params.stopPrice,
            limit_price: params.limitPrice,
            stop_direction: stopDirection,
          },
        },
      });

      if (response.success && response.success_response) {
        const exchangeOrderId = response.success_response.order_id;

        this.trackedOrders.delete(order.orderId);
        order.orderId = exchangeOrderId;
        order.status = 'OPEN';
        order.updatedAt = Date.now();
        this.trackedOrders.set(exchangeOrderId, order);

        this.stateStore.persistOrder(order);

        this.emit('orderSubmitted', order);
        log.info(
          { clientOrderId, exchangeOrderId },
          'Stop-limit order submitted successfully',
        );
        return order;
      }

      order.status = 'FAILED';
      order.updatedAt = Date.now();
      this.stateStore.persistOrder(order);

      const errorMsg =
        response.error_response?.message ?? 'Unknown order submission error';
      throw new OrderError({
        message: errorMsg,
        orderId: order.orderId,
        failureReason: response.error_response?.new_order_failure_reason,
        isRetryable: !NON_RETRYABLE_REASONS.has(
          response.error_response?.new_order_failure_reason ?? '',
        ),
      });
    } catch (err) {
      if (err instanceof OrderError) throw err;

      log.error(
        { err, clientOrderId },
        'Network error submitting stop-limit order',
      );
      throw new OrderError({
        message: err instanceof Error ? err.message : 'Unknown error',
        orderId: order.orderId,
        isRetryable: true,
      });
    }
  }

  // ── Order Cancellation ───────────────────────────────────────────

  /**
   * Cancel a single order by exchange order ID.
   */
  async cancelOrder(orderId: string): Promise<boolean> {
    await this.rateLimiter.acquire();

    log.info({ orderId }, 'Cancelling order');

    const response = await this.restClient.cancelOrders({
      order_ids: [orderId],
    });

    const result = response.results[0];
    if (result?.success) {
      const tracked = this.trackedOrders.get(orderId);
      if (tracked) {
        tracked.status = 'CANCELLED';
        tracked.updatedAt = Date.now();
        this.stateStore.updateOrderStatus(orderId, { status: 'CANCELLED' });
      }
      log.info({ orderId }, 'Order cancelled successfully');
      return true;
    }

    log.warn(
      { orderId, failureReason: result?.failure_reason },
      'Order cancellation failed',
    );
    return false;
  }

  /**
   * Cancel all open/pending orders. Batches in groups of 100 (Coinbase max).
   * @returns Number of successfully cancelled orders.
   */
  async cancelAllOrders(): Promise<number> {
    const openOrders = [...this.trackedOrders.values()].filter(
      (o) => o.status === 'PENDING' || o.status === 'OPEN',
    );

    if (openOrders.length === 0) return 0;

    let cancelledCount = 0;
    const batchSize = 100;

    for (let i = 0; i < openOrders.length; i += batchSize) {
      const batch = openOrders.slice(i, i + batchSize);
      const orderIds = batch.map((o) => o.orderId);

      await this.rateLimiter.acquire();

      const response = await this.restClient.cancelOrders({
        order_ids: orderIds,
      });

      for (const result of response.results) {
        if (result.success) {
          cancelledCount++;
          const tracked = this.trackedOrders.get(result.order_id);
          if (tracked) {
            tracked.status = 'CANCELLED';
            tracked.updatedAt = Date.now();
            this.stateStore.updateOrderStatus(result.order_id, {
              status: 'CANCELLED',
            });
          }
        }
      }
    }

    log.info(
      { total: openOrders.length, cancelled: cancelledCount },
      'Batch cancel complete',
    );
    return cancelledCount;
  }

  // ── Reconciliation ───────────────────────────────────────────────

  /**
   * Reconcile internal tracked orders with exchange state.
   * Detects untracked orders, missing orders, and status mismatches.
   * Auto-resolves: cancels untracked, syncs missing to exchange status.
   */
  async reconcile(): Promise<ReconciliationReport> {
    log.info('Starting order reconciliation');

    const discrepancies: Discrepancy[] = [];

    // Fetch exchange orders
    await this.rateLimiter.acquire();
    const exchangeResponse = await this.restClient.getOrders({
      product_ids: this.pairs,
      order_status: ['OPEN', 'PENDING'] as any,
    });
    const exchangeOrders = exchangeResponse.orders;

    // Fetch accounts for balance info
    await this.rateLimiter.acquire();
    await this.restClient.getAccounts();

    // Build exchange order map
    const exchangeMap = new Map<string, any>();
    for (const exOrder of exchangeOrders) {
      exchangeMap.set(exOrder.order_id, exOrder);
    }

    // Check for untracked orders (on exchange but not in our map)
    for (const exOrder of exchangeOrders) {
      if (!this.trackedOrders.has(exOrder.order_id)) {
        discrepancies.push({
          type: 'UNTRACKED_ORDER',
          orderId: exOrder.order_id,
          details: `Exchange order ${exOrder.order_id} not tracked locally`,
          action: 'CANCEL',
        });

        // Auto-resolve: cancel untracked order (safety)
        try {
          await this.rateLimiter.acquire();
          await this.restClient.cancelOrders({
            order_ids: [exOrder.order_id],
          });
          log.warn(
            { orderId: exOrder.order_id },
            'Cancelled untracked exchange order',
          );
        } catch (err) {
          log.error(
            { err, orderId: exOrder.order_id },
            'Failed to cancel untracked order',
          );
        }
      }
    }

    // Check for missing orders (tracked locally but not on exchange)
    const openTracked = [...this.trackedOrders.values()].filter(
      (o) => o.status === 'PENDING' || o.status === 'OPEN',
    );

    for (const tracked of openTracked) {
      if (!exchangeMap.has(tracked.orderId)) {
        // Query individual order status
        try {
          await this.rateLimiter.acquire();
          const orderResponse = await this.restClient.getOrder({
            order_id: tracked.orderId,
          });
          const exOrder = orderResponse.order;

          discrepancies.push({
            type: 'MISSING_FROM_EXCHANGE',
            orderId: tracked.orderId,
            details: `Tracked order ${tracked.orderId} not in open orders, exchange status: ${exOrder.status}`,
            action: 'SYNC',
          });

          // Auto-resolve: sync to exchange status
          const newStatus = this.mapExchangeStatus(exOrder.status);
          tracked.status = newStatus;
          tracked.filledSize = exOrder.filled_size;
          tracked.filledValue = exOrder.filled_value;
          tracked.averageFillPrice = exOrder.average_filled_price;
          tracked.totalFees = exOrder.fee ?? '0';
          tracked.updatedAt = Date.now();

          this.stateStore.updateOrderStatus(tracked.orderId, {
            status: newStatus,
            filledSize: tracked.filledSize,
            filledValue: tracked.filledValue,
            averageFillPrice: tracked.averageFillPrice,
            totalFees: tracked.totalFees,
          });

          // Emit events for status changes
          if (newStatus === 'FILLED') {
            this.emit('orderFilled', tracked);
          } else if (newStatus === 'CANCELLED') {
            this.emit('orderCancelled', tracked);
          }
        } catch (err) {
          log.error(
            { err, orderId: tracked.orderId },
            'Failed to query individual order for reconciliation',
          );
        }
      } else {
        // Check for status mismatch
        const exOrder = exchangeMap.get(tracked.orderId);
        const exchangeStatus = this.mapExchangeStatus(exOrder.status);
        if (tracked.status !== exchangeStatus) {
          discrepancies.push({
            type: 'STATUS_MISMATCH',
            orderId: tracked.orderId,
            details: `Local status ${tracked.status} != exchange status ${exchangeStatus}`,
            action: 'SYNC',
          });

          tracked.status = exchangeStatus;
          tracked.updatedAt = Date.now();
          this.stateStore.updateOrderStatus(tracked.orderId, {
            status: exchangeStatus,
          });
        }
      }
    }

    const report: ReconciliationReport = {
      timestamp: Date.now(),
      discrepancies,
    };

    this.emit('reconciliation', report);
    log.info(
      { discrepancyCount: discrepancies.length },
      'Reconciliation complete',
    );

    return report;
  }

  // ── Accessors ────────────────────────────────────────────────────

  /** Get a tracked order by exchange order ID. */
  getTrackedOrder(orderId: string): LiveOrder | undefined {
    return this.trackedOrders.get(orderId);
  }

  /** Get all open/pending tracked orders. */
  getOpenOrders(): LiveOrder[] {
    return [...this.trackedOrders.values()].filter(
      (o) => o.status === 'PENDING' || o.status === 'OPEN',
    );
  }

  /** Stop tracking: unsubscribe from WS user channel and clear map. */
  stopTracking(): void {
    this.wsClient.unsubscribe(
      {
        topic: 'user',
        payload: { product_ids: this.pairs },
      },
      'advTradeUserData' as any,
    );
    this.trackedOrders.clear();
    log.info('Order tracking stopped');
  }

  // ── Private ──────────────────────────────────────────────────────

  /**
   * Handle a WebSocket order update from the user channel.
   */
  private onOrderUpdate(wsOrder: any): void {
    const orderId = wsOrder.order_id;
    if (!orderId) return;

    const tracked = this.trackedOrders.get(orderId);
    if (!tracked) {
      log.debug({ orderId }, 'Received update for untracked order, ignoring');
      return;
    }

    const prevStatus = tracked.status;
    const newStatus = this.mapExchangeStatus(wsOrder.status);

    tracked.status = newStatus;
    if (wsOrder.cumulative_quantity !== undefined) {
      tracked.filledSize = wsOrder.cumulative_quantity;
    }
    if (wsOrder.filled_value !== undefined) {
      tracked.filledValue = wsOrder.filled_value;
    }
    if (wsOrder.average_filled_price !== undefined) {
      tracked.averageFillPrice = wsOrder.average_filled_price;
    }
    if (wsOrder.total_fees !== undefined) {
      tracked.totalFees = wsOrder.total_fees;
    }
    tracked.updatedAt = Date.now();

    // Persist update
    this.stateStore.updateOrderStatus(orderId, {
      status: tracked.status,
      filledSize: tracked.filledSize,
      filledValue: tracked.filledValue,
      averageFillPrice: tracked.averageFillPrice,
      totalFees: tracked.totalFees,
    });

    log.info(
      {
        orderId,
        prevStatus,
        newStatus,
        filledSize: tracked.filledSize,
      },
      'Order updated via WebSocket',
    );

    // Emit typed events for terminal states
    if (newStatus === 'FILLED' && prevStatus !== 'FILLED') {
      this.emit('orderFilled', tracked);
    } else if (newStatus === 'CANCELLED' && prevStatus !== 'CANCELLED') {
      this.emit('orderCancelled', tracked);
    } else if (newStatus === 'FAILED' && prevStatus !== 'FAILED') {
      this.emit(
        'orderFailed',
        tracked,
        new OrderError({
          message: 'Order failed on exchange',
          orderId,
          isRetryable: false,
        }),
      );
    }
  }

  /**
   * Map exchange status string to our OrderStatus type.
   */
  private mapExchangeStatus(exchangeStatus: string): OrderStatus {
    const statusMap: Record<string, OrderStatus> = {
      PENDING: 'PENDING',
      OPEN: 'OPEN',
      FILLED: 'FILLED',
      CANCELLED: 'CANCELLED',
      EXPIRED: 'EXPIRED',
      FAILED: 'FAILED',
      CANCEL_QUEUED: 'CANCEL_QUEUED',
    };
    return statusMap[exchangeStatus] ?? 'PENDING';
  }
}
