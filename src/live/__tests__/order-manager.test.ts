/**
 * Tests for OrderManager -- full order lifecycle management.
 *
 * Mocks CBAdvancedTradeClient, WebsocketClient, RateLimiter, and LiveStateStore
 * to test order submission, WebSocket tracking, reconciliation, and cancellation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { OrderManager, OrderError } from '../order-manager.js';
import type { LiveOrder } from '../types.js';

// ── Mock factories ──────────────────────────────────────────────────

function makeMockRestClient() {
  return {
    submitOrder: vi.fn(),
    cancelOrders: vi.fn(),
    getOrders: vi.fn(),
    getOrder: vi.fn(),
    getAccounts: vi.fn(),
  };
}

function makeMockWsClient() {
  const ws = new EventEmitter();
  (ws as any).subscribe = vi.fn();
  (ws as any).unsubscribe = vi.fn();
  return ws as EventEmitter & {
    subscribe: ReturnType<typeof vi.fn>;
    unsubscribe: ReturnType<typeof vi.fn>;
  };
}

function makeMockRateLimiter() {
  return {
    acquire: vi.fn().mockResolvedValue(undefined),
    tryAcquire: vi.fn().mockReturnValue(true),
    reset: vi.fn(),
    get availableTokens() {
      return 25;
    },
  };
}

function makeMockStateStore() {
  return {
    getOpenOrders: vi.fn().mockReturnValue([]),
    persistOrder: vi.fn(),
    updateOrderStatus: vi.fn(),
    getOrder: vi.fn(),
    getOrderByClientId: vi.fn(),
    getPendingOrders: vi.fn().mockReturnValue([]),
    createSession: vi.fn(),
    endSession: vi.fn(),
    getSession: vi.fn(),
    listSessions: vi.fn(),
    recordTrade: vi.fn(),
    getSessionTrades: vi.fn(),
    recordEquityPoint: vi.fn(),
    getSessionEquity: vi.fn(),
    close: vi.fn(),
  };
}

function makeOrder(overrides: Partial<LiveOrder> = {}): LiveOrder {
  const now = Date.now();
  return {
    orderId: 'exchange-123',
    clientOrderId: 'client-abc',
    sessionId: 'session-1',
    productId: 'BTC-USD',
    side: 'BUY',
    orderType: 'MARKET',
    status: 'OPEN',
    baseSize: '0.01',
    filledSize: '0',
    filledValue: '0',
    totalFees: '0',
    createdAt: now,
    updatedAt: now,
    purpose: 'ENTRY',
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe('OrderManager', () => {
  let restClient: ReturnType<typeof makeMockRestClient>;
  let wsClient: ReturnType<typeof makeMockWsClient>;
  let rateLimiter: ReturnType<typeof makeMockRateLimiter>;
  let stateStore: ReturnType<typeof makeMockStateStore>;
  let manager: OrderManager;

  beforeEach(() => {
    restClient = makeMockRestClient();
    wsClient = makeMockWsClient();
    rateLimiter = makeMockRateLimiter();
    stateStore = makeMockStateStore();

    manager = new OrderManager({
      restClient: restClient as any,
      wsClient: wsClient as any,
      rateLimiter: rateLimiter as any,
      stateStore: stateStore as any,
      sessionId: 'session-1',
      pairs: ['BTC-USD'],
    });
  });

  // Test 1: Idempotent submission -- persist BEFORE API call
  it('submitMarketOrder persists clientOrderId BEFORE API call', async () => {
    const callOrder: string[] = [];

    stateStore.persistOrder.mockImplementation(() => {
      callOrder.push('persistOrder');
    });
    restClient.submitOrder.mockImplementation(async () => {
      callOrder.push('submitOrder');
      return {
        success: true,
        success_response: { order_id: 'exch-123' },
      };
    });

    await manager.submitMarketOrder({
      pair: 'BTC-USD',
      side: 'BUY',
      baseSize: '0.01',
    });

    // persistOrder should be called before submitOrder
    const persistIdx = callOrder.indexOf('persistOrder');
    const submitIdx = callOrder.indexOf('submitOrder');
    expect(persistIdx).toBeLessThan(submitIdx);
  });

  // Test 2: Successful market order
  it('submitMarketOrder returns LiveOrder on success', async () => {
    restClient.submitOrder.mockResolvedValue({
      success: true,
      success_response: {
        order_id: 'exch-456',
        product_id: 'BTC-USD',
        side: 'BUY',
        client_order_id: 'some-uuid',
      },
    });

    const order = await manager.submitMarketOrder({
      pair: 'BTC-USD',
      side: 'BUY',
      baseSize: '0.01',
    });

    expect(order.orderId).toBe('exch-456');
    expect(order.status).toBe('OPEN');
    expect(order.orderType).toBe('MARKET');
    expect(order.side).toBe('BUY');
    expect(order.baseSize).toBe('0.01');
  });

  // Test 3: Failed market order throws OrderError
  it('submitMarketOrder throws OrderError on API failure', async () => {
    restClient.submitOrder.mockResolvedValue({
      success: false,
      error_response: {
        message: 'Insufficient funds',
        new_order_failure_reason: 'INSUFFICIENT_FUND',
      },
    });

    await expect(
      manager.submitMarketOrder({
        pair: 'BTC-USD',
        side: 'BUY',
        baseSize: '100',
      }),
    ).rejects.toThrow(OrderError);

    await expect(
      manager.submitMarketOrder({
        pair: 'BTC-USD',
        side: 'BUY',
        baseSize: '100',
      }),
    ).rejects.toThrow('Insufficient funds');

    // Order should be marked as FAILED in state store
    const failedCalls = stateStore.persistOrder.mock.calls.filter(
      (call: any[]) => call[0].status === 'FAILED',
    );
    expect(failedCalls.length).toBeGreaterThan(0);
  });

  // Test 4: Stop-limit order uses correct order_configuration
  it('submitStopLimitOrder uses correct order_configuration', async () => {
    restClient.submitOrder.mockResolvedValue({
      success: true,
      success_response: { order_id: 'exch-sl-1' },
    });

    await manager.submitStopLimitOrder({
      pair: 'BTC-USD',
      side: 'SELL',
      baseSize: '0.01',
      stopPrice: '49000',
      limitPrice: '48900',
    });

    const submitCall = restClient.submitOrder.mock.calls[0][0];
    expect(submitCall.order_configuration).toEqual({
      stop_limit_stop_limit_gtc: {
        base_size: '0.01',
        stop_price: '49000',
        limit_price: '48900',
        stop_direction: 'STOP_DIRECTION_STOP_DOWN',
      },
    });

    // Verify BUY side uses STOP_UP
    restClient.submitOrder.mockResolvedValue({
      success: true,
      success_response: { order_id: 'exch-sl-2' },
    });

    await manager.submitStopLimitOrder({
      pair: 'BTC-USD',
      side: 'BUY',
      baseSize: '0.01',
      stopPrice: '51000',
      limitPrice: '51100',
    });

    const buyCall = restClient.submitOrder.mock.calls[1][0];
    expect(
      buyCall.order_configuration.stop_limit_stop_limit_gtc.stop_direction,
    ).toBe('STOP_DIRECTION_STOP_UP');
  });

  // Test 5: WebSocket onOrderUpdate updates tracked order
  it('onOrderUpdate updates tracked order from WebSocket', async () => {
    // First submit an order so it's tracked
    restClient.submitOrder.mockResolvedValue({
      success: true,
      success_response: { order_id: 'exch-ws-1' },
    });

    await manager.submitMarketOrder({
      pair: 'BTC-USD',
      side: 'BUY',
      baseSize: '0.01',
    });

    // Start tracking to set up WS listeners
    manager.startTracking();

    // Simulate WebSocket user channel update
    wsClient.emit('update', {
      channel: 'user',
      events: [
        {
          orders: [
            {
              order_id: 'exch-ws-1',
              status: 'FILLED',
              cumulative_quantity: '0.01',
              filled_value: '500.00',
              average_filled_price: '50000.00',
              total_fees: '3.00',
            },
          ],
        },
      ],
    });

    const tracked = manager.getTrackedOrder('exch-ws-1');
    expect(tracked).toBeDefined();
    expect(tracked!.status).toBe('FILLED');
    expect(tracked!.filledSize).toBe('0.01');
    expect(tracked!.filledValue).toBe('500.00');
    expect(tracked!.averageFillPrice).toBe('50000.00');
    expect(tracked!.totalFees).toBe('3.00');

    // State store should have been updated
    expect(stateStore.updateOrderStatus).toHaveBeenCalledWith(
      'exch-ws-1',
      expect.objectContaining({ status: 'FILLED' }),
    );
  });

  // Test 6: onOrderUpdate emits orderFilled when status becomes FILLED
  it('onOrderUpdate emits orderFilled when status becomes FILLED', async () => {
    restClient.submitOrder.mockResolvedValue({
      success: true,
      success_response: { order_id: 'exch-fill-1' },
    });

    await manager.submitMarketOrder({
      pair: 'BTC-USD',
      side: 'BUY',
      baseSize: '0.01',
    });

    manager.startTracking();

    const filledOrders: LiveOrder[] = [];
    manager.on('orderFilled', (order: LiveOrder) => {
      filledOrders.push(order);
    });

    wsClient.emit('update', {
      channel: 'user',
      events: [
        {
          orders: [
            {
              order_id: 'exch-fill-1',
              status: 'FILLED',
              cumulative_quantity: '0.01',
              filled_value: '500.00',
              average_filled_price: '50000.00',
              total_fees: '3.00',
            },
          ],
        },
      ],
    });

    expect(filledOrders).toHaveLength(1);
    expect(filledOrders[0].orderId).toBe('exch-fill-1');
    expect(filledOrders[0].status).toBe('FILLED');
  });

  // Test 7: cancelOrder calls REST and updates state
  it('cancelOrder calls REST and updates state', async () => {
    // Set up a tracked order
    restClient.submitOrder.mockResolvedValue({
      success: true,
      success_response: { order_id: 'exch-cancel-1' },
    });

    await manager.submitMarketOrder({
      pair: 'BTC-USD',
      side: 'BUY',
      baseSize: '0.01',
    });

    restClient.cancelOrders.mockResolvedValue({
      results: [{ success: true, order_id: 'exch-cancel-1', failure_reason: '' }],
    });

    const success = await manager.cancelOrder('exch-cancel-1');
    expect(success).toBe(true);

    expect(restClient.cancelOrders).toHaveBeenCalledWith({
      order_ids: ['exch-cancel-1'],
    });

    expect(stateStore.updateOrderStatus).toHaveBeenCalledWith(
      'exch-cancel-1',
      { status: 'CANCELLED' },
    );
  });

  // Test 8: cancelAllOrders batches in groups of 100
  it('cancelAllOrders batches in groups of 100', async () => {
    // Submit 150 orders
    for (let i = 0; i < 150; i++) {
      restClient.submitOrder.mockResolvedValueOnce({
        success: true,
        success_response: { order_id: `exch-batch-${i}` },
      });
      await manager.submitMarketOrder({
        pair: 'BTC-USD',
        side: 'BUY',
        baseSize: '0.001',
      });
    }

    // Mock cancel responses for two batches
    restClient.cancelOrders
      .mockResolvedValueOnce({
        results: Array.from({ length: 100 }, (_, i) => ({
          success: true,
          order_id: `exch-batch-${i}`,
          failure_reason: '',
        })),
      })
      .mockResolvedValueOnce({
        results: Array.from({ length: 50 }, (_, i) => ({
          success: true,
          order_id: `exch-batch-${100 + i}`,
          failure_reason: '',
        })),
      });

    const count = await manager.cancelAllOrders();

    expect(count).toBe(150);
    // Two batches: one of 100, one of 50
    expect(restClient.cancelOrders).toHaveBeenCalledTimes(2);

    // First batch has 100 order_ids
    expect(restClient.cancelOrders.mock.calls[0][0].order_ids).toHaveLength(100);
    // Second batch has 50 order_ids
    expect(restClient.cancelOrders.mock.calls[1][0].order_ids).toHaveLength(50);
  });

  // Test 9: reconcile detects untracked exchange orders
  it('reconcile detects untracked exchange orders', async () => {
    restClient.getOrders.mockResolvedValue({
      orders: [
        {
          order_id: 'unknown-exchange-order',
          product_id: 'BTC-USD',
          status: 'OPEN',
          side: 'BUY',
          filled_size: '0',
          filled_value: '0',
          average_filled_price: '0',
        },
      ],
      has_next: false,
    });
    restClient.getAccounts.mockResolvedValue({
      accounts: [],
      has_next: false,
      cursor: '',
      size: 0,
    });
    restClient.cancelOrders.mockResolvedValue({
      results: [
        { success: true, order_id: 'unknown-exchange-order', failure_reason: '' },
      ],
    });

    const report = await manager.reconcile();

    expect(report.discrepancies).toHaveLength(1);
    expect(report.discrepancies[0].type).toBe('UNTRACKED_ORDER');
    expect(report.discrepancies[0].orderId).toBe('unknown-exchange-order');
    expect(report.discrepancies[0].action).toBe('CANCEL');

    // Should have attempted to cancel the untracked order
    expect(restClient.cancelOrders).toHaveBeenCalledWith({
      order_ids: ['unknown-exchange-order'],
    });
  });

  // Test 10: reconcile detects missing orders and syncs state
  it('reconcile detects missing orders and syncs to exchange status', async () => {
    // Submit an order so it's tracked as OPEN
    restClient.submitOrder.mockResolvedValue({
      success: true,
      success_response: { order_id: 'exch-missing-1' },
    });

    await manager.submitMarketOrder({
      pair: 'BTC-USD',
      side: 'BUY',
      baseSize: '0.01',
    });

    // Exchange returns empty open orders (our order is not there -- it was filled)
    restClient.getOrders.mockResolvedValue({
      orders: [],
      has_next: false,
    });
    restClient.getAccounts.mockResolvedValue({
      accounts: [],
      has_next: false,
      cursor: '',
      size: 0,
    });
    // Individual order query returns FILLED
    restClient.getOrder.mockResolvedValue({
      order: {
        order_id: 'exch-missing-1',
        status: 'FILLED',
        filled_size: '0.01',
        filled_value: '500.00',
        average_filled_price: '50000.00',
        fee: '3.00',
      },
    });

    const filledOrders: LiveOrder[] = [];
    manager.on('orderFilled', (order: LiveOrder) => {
      filledOrders.push(order);
    });

    const report = await manager.reconcile();

    expect(report.discrepancies).toHaveLength(1);
    expect(report.discrepancies[0].type).toBe('MISSING_FROM_EXCHANGE');
    expect(report.discrepancies[0].action).toBe('SYNC');

    // Order should now be FILLED in tracked map
    const tracked = manager.getTrackedOrder('exch-missing-1');
    expect(tracked!.status).toBe('FILLED');
    expect(tracked!.filledSize).toBe('0.01');

    // Should have emitted orderFilled event
    expect(filledOrders).toHaveLength(1);
  });

  // Test 11: All REST calls go through rate limiter
  it('all REST calls go through rate limiter', async () => {
    restClient.submitOrder.mockResolvedValue({
      success: true,
      success_response: { order_id: 'exch-rl-1' },
    });

    // Submit order
    await manager.submitMarketOrder({
      pair: 'BTC-USD',
      side: 'BUY',
      baseSize: '0.01',
    });
    expect(rateLimiter.acquire).toHaveBeenCalledTimes(1);

    // Cancel order
    restClient.cancelOrders.mockResolvedValue({
      results: [{ success: true, order_id: 'exch-rl-1', failure_reason: '' }],
    });
    await manager.cancelOrder('exch-rl-1');
    expect(rateLimiter.acquire).toHaveBeenCalledTimes(2);

    // Reconcile calls acquire at least twice (getOrders + getAccounts)
    restClient.getOrders.mockResolvedValue({ orders: [], has_next: false });
    restClient.getAccounts.mockResolvedValue({
      accounts: [],
      has_next: false,
      cursor: '',
      size: 0,
    });

    await manager.reconcile();
    // 2 (previous) + 2 (getOrders + getAccounts) = 4
    expect(rateLimiter.acquire.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  // Test 12: WebSocket reconnect triggers immediate reconciliation
  it('WebSocket reconnect triggers immediate reconciliation', async () => {
    // Set up reconcile dependencies
    restClient.getOrders.mockResolvedValue({ orders: [], has_next: false });
    restClient.getAccounts.mockResolvedValue({
      accounts: [],
      has_next: false,
      cursor: '',
      size: 0,
    });

    manager.startTracking();

    // Emit reconnected event
    wsClient.emit('reconnected', { wsKey: 'advTradeUserData', event: {} });

    // Allow async reconcile to run
    await new Promise((resolve) => setTimeout(resolve, 50));

    // getOrders should have been called (reconcile was triggered)
    expect(restClient.getOrders).toHaveBeenCalled();
  });

  // ── ORDER-02: rejection reason allowlist ─────────────────────────────

  describe('ORDER-02: rejection reason allowlist', () => {
    it('treats unrecognized rejection reason as non-retryable', async () => {
      restClient.submitOrder.mockResolvedValue({
        success: false,
        error_response: {
          new_order_failure_reason: 'SOME_NEW_COINBASE_REASON',
          message: 'rejected',
        },
      });

      try {
        await manager.submitMarketOrder({
          pair: 'BTC-USD',
          side: 'BUY',
          baseSize: '0.01',
        });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(OrderError);
        expect((err as OrderError).isRetryable).toBe(false);
        expect((err as OrderError).failureReason).toBe('SOME_NEW_COINBASE_REASON');
      }

      // Order persisted as FAILED
      const failedCalls = stateStore.persistOrder.mock.calls.filter(
        (call: any[]) => call[0].status === 'FAILED',
      );
      expect(failedCalls.length).toBeGreaterThan(0);
    });

    it('treats UNKNOWN_FAILURE_REASON as retryable', async () => {
      restClient.submitOrder.mockResolvedValue({
        success: false,
        error_response: {
          new_order_failure_reason: 'UNKNOWN_FAILURE_REASON',
          message: 'unknown',
        },
      });

      try {
        await manager.submitMarketOrder({
          pair: 'BTC-USD',
          side: 'BUY',
          baseSize: '0.01',
        });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(OrderError);
        expect((err as OrderError).isRetryable).toBe(true);
        expect((err as OrderError).failureReason).toBe('UNKNOWN_FAILURE_REASON');
      }
    });

    it('includes failureReason in OrderError on non-retryable rejection', async () => {
      restClient.submitOrder.mockResolvedValue({
        success: false,
        error_response: {
          new_order_failure_reason: 'BRAND_NEW_ERROR_CODE',
          message: 'some new error',
        },
      });

      try {
        await manager.submitMarketOrder({
          pair: 'BTC-USD',
          side: 'BUY',
          baseSize: '0.01',
        });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(OrderError);
        const orderErr = err as OrderError;
        expect(orderErr.failureReason).toBe('BRAND_NEW_ERROR_CODE');
        expect(orderErr.isRetryable).toBe(false);
        expect(orderErr.message).toBe('some new error');
      }
    });

    it('INSUFFICIENT_FUND is still non-retryable under allowlist', async () => {
      restClient.submitOrder.mockResolvedValue({
        success: false,
        error_response: {
          new_order_failure_reason: 'INSUFFICIENT_FUND',
          message: 'Insufficient funds',
        },
      });

      try {
        await manager.submitMarketOrder({
          pair: 'BTC-USD',
          side: 'BUY',
          baseSize: '100',
        });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(OrderError);
        expect((err as OrderError).isRetryable).toBe(false);
        expect((err as OrderError).failureReason).toBe('INSUFFICIENT_FUND');
      }
    });

    it('stop-limit order treats unrecognized reason as non-retryable', async () => {
      restClient.submitOrder.mockResolvedValue({
        success: false,
        error_response: {
          new_order_failure_reason: 'EXOTIC_NEW_REASON',
          message: 'rejected',
        },
      });

      try {
        await manager.submitStopLimitOrder({
          pair: 'BTC-USD',
          side: 'SELL',
          baseSize: '0.01',
          stopPrice: '49000',
          limitPrice: '48900',
        });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(OrderError);
        expect((err as OrderError).isRetryable).toBe(false);
      }
    });
  });
});
