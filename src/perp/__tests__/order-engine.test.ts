/**
 * Tests for PerpOrderEngine -- ORDER-02 allowlist flip, config defaults, and timeout.
 *
 * IntxClient and PerpStateStore are fully mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PerpOrderEngine, OrderError } from '../order-engine.js';
import { fcmConfigSchema } from '../config.js';
import type { FcmConfig } from '../config.js';
import type { IntxClient } from '../intx-client.js';
import type { PerpStateStore } from '../perp-state-store.js';

// ── Mock factories ──────────────────────────────────────────────────

function makeMockIntxClient() {
  const client = new EventEmitter() as EventEmitter & {
    placeOrder: ReturnType<typeof vi.fn>;
    placeStopOrder: ReturnType<typeof vi.fn>;
    cancelOrders: ReturnType<typeof vi.fn>;
    getAccountState: ReturnType<typeof vi.fn>;
  };
  client.placeOrder = vi.fn();
  client.placeStopOrder = vi.fn();
  client.cancelOrders = vi.fn();
  client.getAccountState = vi.fn();
  return client;
}

function makeMockStateStore() {
  return {
    persistOrder: vi.fn(),
    createSession: vi.fn(),
    getOpenOrdersBySession: vi.fn().mockReturnValue([]),
    getPendingOrders: vi.fn().mockReturnValue([]),
    updateOrderStatus: vi.fn(),
  };
}

function makeMockConfig(overrides: Partial<FcmConfig> = {}): FcmConfig {
  return {
    enabled: true,
    apiKey: 'key',
    apiSecret: 'secret',
    testnet: false,
    btcProductId: 'BIP-20DEC30-CDE',
    ethProductId: 'ETP-20DEC30-CDE',
    liquidationSafetyThresholdPct: 5.0,
    defaultMaintenanceMarginRate: '0.0333',
    tpTargetPct: 2.0,
    atrMultiplier: 2.0,
    stopLimitSlippagePct: 0.1,
    repriceTimeoutMs: 60000,
    maxRepriceAttempts: 20,
    entryOrderTimeoutMs: 300000,
    maxLeverageCap: 5,
    defaultLeverage: 3,
    leverageByRegime: { VOLATILE: 2, TRENDING: 5, RANGING: 3 },
    marginUtilizationCeiling: 0.8,
    perpExposureCapPct: 0.5,
    perpMaxLossPct: 0.02,
    fundingDrainThresholdPct: 0.005,
    perpMode: 'none',
    orderMaxWaitSeconds: 60,
    orderCloseMaxRetries: 3,
    scalpingTimeframe: '5m',
    maxDailyLossUsd: 500,
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe('PerpOrderEngine', () => {
  let intxClient: ReturnType<typeof makeMockIntxClient>;
  let stateStore: ReturnType<typeof makeMockStateStore>;
  let config: FcmConfig;
  let engine: PerpOrderEngine;

  beforeEach(() => {
    intxClient = makeMockIntxClient();
    stateStore = makeMockStateStore();
    config = makeMockConfig();

    engine = new PerpOrderEngine({
      intxClient: intxClient as unknown as IntxClient,
      stateStore: stateStore as unknown as PerpStateStore,
      config,
    });
  });

  // ── ORDER-02: rejection reason allowlist ──────────────────────────

  describe('ORDER-02: rejection reason allowlist', () => {
    it('treats unrecognized failure reason as non-retryable and throws', async () => {
      intxClient.placeOrder.mockRejectedValue(
        new Error('Order rejected: failure_reason: SOME_UNKNOWN_REASON'),
      );

      try {
        await engine.submitEntryOrder({
          instrument: 'BIP-20DEC30-CDE',
          direction: 'long',
          size: '0.01',
          midPrice: '50000',
          atr: '500',
          getMidPrice: vi.fn().mockResolvedValue('50000'),
        });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(OrderError);
        const orderErr = err as OrderError;
        expect(orderErr.isRetryable).toBe(false);
        expect(orderErr.failureReason).toBe('SOME_UNKNOWN_REASON');
      }
    });

    it('allows reprice on post-only rejection (no failure_reason extracted)', async () => {
      // Use short reprice timeout so fill wait doesn't block forever
      config = makeMockConfig({ repriceTimeoutMs: 2000 });
      engine = new PerpOrderEngine({
        intxClient: intxClient as unknown as IntxClient,
        stateStore: stateStore as unknown as PerpStateStore,
        config,
      });

      // First call: throw with no parseable failure_reason (post-only rejection)
      intxClient.placeOrder
        .mockRejectedValueOnce(new Error('post_only_rejected'))
        // Second call: succeed
        .mockResolvedValueOnce({
          orderId: 'exch-entry-1',
          status: 'OPEN',
          execQty: '0',
          avgPrice: '0',
          fee: '0',
        });

      // When fill wait starts, emit orderFill event after enough time for
      // the reprice loop (sleep 500ms + placeOrder)
      const submitPromise = engine.submitEntryOrder({
        instrument: 'BIP-20DEC30-CDE',
        direction: 'long',
        size: '0.01',
        midPrice: '50000',
        atr: '500',
        getMidPrice: vi.fn().mockResolvedValue('50100'),
      });

      // Emit fill after 700ms (> 500ms sleep in reprice loop + placeOrder)
      setTimeout(() => {
        intxClient.emit('orderFill', {
          orderId: 'exch-entry-1',
          clientOrderId: '',  // won't match but orderId will
          productId: 'BIP-20DEC30-CDE',
          side: 'BUY',
          filledSize: '0.01',
          avgFillPrice: '50100',
          totalFees: '0.50',
          timestamp: Date.now(),
        });
      }, 700);

      const session = await submitPromise;
      expect(session).toBeDefined();
      expect(session.instrument).toBe('BIP-20DEC30-CDE');
      expect(session.direction).toBe('long');

      // placeOrder was called twice (once rejected, once success)
      expect(intxClient.placeOrder).toHaveBeenCalledTimes(2);
    }, 10000);

    it('INSUFFICIENT_FUND rejection aborts immediately with non-retryable error', async () => {
      intxClient.placeOrder.mockRejectedValue(
        new Error('Rejected: failure_reason: INSUFFICIENT_FUND'),
      );

      try {
        await engine.submitEntryOrder({
          instrument: 'BIP-20DEC30-CDE',
          direction: 'long',
          size: '0.01',
          midPrice: '50000',
          atr: '500',
          getMidPrice: vi.fn().mockResolvedValue('50000'),
        });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(OrderError);
        const orderErr = err as OrderError;
        expect(orderErr.isRetryable).toBe(false);
        expect(orderErr.failureReason).toBe('INSUFFICIENT_FUND');
      }

      // Only called once (no reprice loop)
      expect(intxClient.placeOrder).toHaveBeenCalledTimes(1);
    });

    it('entry timeout fires when orderMaxWaitSeconds exceeded', async () => {
      // Set orderMaxWaitSeconds to 1s — the reprice loop has a 500ms sleep,
      // so after the first rejection + sleep the second iteration's elapsed check
      // will exceed the 1s budget. (entryOrderTimeoutMs is no longer consulted)
      config = makeMockConfig({ orderMaxWaitSeconds: 1 });
      engine = new PerpOrderEngine({
        intxClient: intxClient as unknown as IntxClient,
        stateStore: stateStore as unknown as PerpStateStore,
        config,
      });

      // Always reject with transient (post-only) error so the loop keeps cycling
      intxClient.placeOrder.mockRejectedValue(new Error('post_only_rejected'));

      try {
        await engine.submitEntryOrder({
          instrument: 'BIP-20DEC30-CDE',
          direction: 'long',
          size: '0.01',
          midPrice: '50000',
          atr: '500',
          getMidPrice: vi.fn().mockResolvedValue('50000'),
        });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(OrderError);
        const orderErr = err as OrderError;
        expect(orderErr.message).toMatch(/timed out/i);
        expect(orderErr.isRetryable).toBe(false);
      }
    }, 10000);
  });

  // ── ORDER-01: orderMaxWaitSeconds wiring ─────────────────────────

  describe('ORDER-01: orderMaxWaitSeconds wiring', () => {
    it('uses orderMaxWaitSeconds for entry timeout instead of entryOrderTimeoutMs', async () => {
      // Set orderMaxWaitSeconds to 1 second (1000ms) while entryOrderTimeoutMs stays at 300000ms
      // If the engine correctly uses orderMaxWaitSeconds, it will time out after ~1s
      config = makeMockConfig({ orderMaxWaitSeconds: 1, entryOrderTimeoutMs: 300000 });
      engine = new PerpOrderEngine({
        intxClient: intxClient as unknown as IntxClient,
        stateStore: stateStore as unknown as PerpStateStore,
        config,
      });

      // Always reject with transient error to keep the loop cycling
      intxClient.placeOrder.mockRejectedValue(new Error('post_only_rejected'));

      const startTime = Date.now();

      try {
        await engine.submitEntryOrder({
          instrument: 'BIP-20DEC30-CDE',
          direction: 'long',
          size: '0.01',
          midPrice: '50000',
          atr: '500',
          getMidPrice: vi.fn().mockResolvedValue('50000'),
        });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(OrderError);
        const orderErr = err as OrderError;
        expect(orderErr.message).toMatch(/timed out/i);
      }

      const elapsed = Date.now() - startTime;
      // Should time out around 1s (orderMaxWaitSeconds=1), not 300s (entryOrderTimeoutMs)
      // Allow generous margin for test environment, but it must be much less than 300s
      expect(elapsed).toBeLessThan(10000);
    }, 15000);
  });

  // ── Config fields ─────────────────────────────────────────────────

  describe('Config fields', () => {
    it('orderMaxWaitSeconds defaults to 60', () => {
      const result = fcmConfigSchema.safeParse({
        enabled: true,
        apiKey: 'k',
        apiSecret: 's',
      });
      expect(result.success).toBe(true);
      expect(result.data?.orderMaxWaitSeconds).toBe(60);
    });

    it('orderCloseMaxRetries defaults to 3', () => {
      const result = fcmConfigSchema.safeParse({
        enabled: true,
        apiKey: 'k',
        apiSecret: 's',
      });
      expect(result.success).toBe(true);
      expect(result.data?.orderCloseMaxRetries).toBe(3);
    });
  });
});
