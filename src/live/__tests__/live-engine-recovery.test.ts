/**
 * Tests for LiveTradingEngine recoverFromRestart() enhancements:
 *
 * RECOV-01: Position field-level verification (size + entry price vs exchange)
 * RECOV-02: Ghost PENDING order cleanup (query and sync to exchange status)
 *
 * The engine's restart recovery path now queries OrderManager.queryOrderStatus()
 * to verify DB position state against the exchange and to clean up ghost PENDING
 * orders that were left behind by a crash.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { LiveTradingEngine } from '../live-engine.js';
import type { LiveTradingConfig, LiveSession, LiveOrder, LiveTrade } from '../types.js';
import type { OrderManager } from '../order-manager.js';
import type { LiveStateStore } from '../state-store.js';
import type { StrategyRegistry } from '../../strategies/registry.js';
import type { IndicatorEngine } from '../../indicators/engine.js';
import type { LiveDataFeed } from '../../paper/live-data-feed.js';
import type { RiskManager } from '../../risk/risk-manager.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<LiveTradingConfig> = {}): LiveTradingConfig {
  return {
    pair: 'BTC-USD',
    timeframe: '1h',
    strategyConfig: { strategy: 'test-strat' },
    initialCapital: 10000,
    bufferSize: 100,
    pollIntervalMs: 60000,
    reconciliationIntervalMs: 300000,
    shutdownTimeoutMs: 30000,
    enableStopLossOnShutdown: false,
    allowShorts: false,
    orderMaxWaitSeconds: 60,
    orderCloseMaxRetries: 3,
    ...overrides,
  } as LiveTradingConfig;
}

function makeStateStore(): LiveStateStore {
  return {
    createSession: vi.fn().mockReturnValue({
      id: 'session-1',
      status: 'running',
      initialCapital: 10000,
    }),
    getSession: vi.fn().mockReturnValue({
      id: 'session-1',
      status: 'running',
      initialCapital: '10000',
    }),
    getSessionTrades: vi.fn().mockReturnValue([]),
    getPendingOrders: vi.fn().mockReturnValue([]),
    getOpenOrders: vi.fn().mockReturnValue([]),
    updateOrderStatus: vi.fn(),
    endSession: vi.fn(),
    recordEquityPoint: vi.fn(),
    recordTrade: vi.fn(),
  } as unknown as LiveStateStore;
}

function makeOrderManager(): OrderManager {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    reconcile: vi.fn().mockResolvedValue({ discrepancies: [] }),
    queryOrderStatus: vi.fn(),
    mapExchangeStatus: vi.fn().mockImplementation((status: string) => {
      const map: Record<string, string> = {
        PENDING: 'PENDING',
        OPEN: 'OPEN',
        FILLED: 'FILLED',
        CANCELLED: 'CANCELLED',
        EXPIRED: 'EXPIRED',
        FAILED: 'FAILED',
      };
      return map[status] ?? 'PENDING';
    }),
    submitMarketOrder: vi.fn(),
    submitStopLimitOrder: vi.fn(),
    cancelOrder: vi.fn(),
    cancelAllOrders: vi.fn(),
    startTracking: vi.fn(),
    stopTracking: vi.fn(),
    getTrackedOrder: vi.fn(),
    getOpenOrders: vi.fn().mockReturnValue([]),
  }) as unknown as OrderManager;
}

function makeLiveFeed(): LiveDataFeed {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    start: vi.fn(),
    stop: vi.fn(),
  }) as unknown as LiveDataFeed;
}

function makeStrategyRegistry(): StrategyRegistry {
  return {
    create: vi.fn().mockReturnValue({
      name: 'test-strat',
      minCandles: 2,
      requiredIndicators: [],
      evaluate: vi.fn().mockReturnValue([]),
    }),
  } as unknown as StrategyRegistry;
}

function makeIndicatorEngine(): IndicatorEngine {
  return {
    compute: vi.fn().mockReturnValue({ values: [] }),
  } as unknown as IndicatorEngine;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('LiveTradingEngine recoverFromRestart() -- RECOV-01/02', () => {
  let stateStore: ReturnType<typeof makeStateStore>;
  let orderManager: ReturnType<typeof makeOrderManager>;
  let liveFeed: ReturnType<typeof makeLiveFeed>;
  let strategyRegistry: ReturnType<typeof makeStrategyRegistry>;
  let indicatorEngine: ReturnType<typeof makeIndicatorEngine>;
  let config: LiveTradingConfig;

  beforeEach(() => {
    stateStore = makeStateStore();
    orderManager = makeOrderManager();
    liveFeed = makeLiveFeed();
    strategyRegistry = makeStrategyRegistry();
    indicatorEngine = makeIndicatorEngine();
    config = makeConfig();
  });

  function createEngine(overrides: Partial<{ resumeSessionId: string }> = {}) {
    return new LiveTradingEngine({
      config,
      liveFeed: liveFeed as any,
      orderManager: orderManager as any,
      stateStore: stateStore as any,
      strategyRegistry: strategyRegistry as any,
      indicatorEngine: indicatorEngine as any,
      resumeSessionId: overrides.resumeSessionId,
    });
  }

  // ── Test 1: Size match passes ─────────────────────────────────────

  it('completes recovery when exchange size and entry price match DB within tolerance', async () => {
    // Open trade in DB: quantity=0.1, entryPrice=50000
    (stateStore.getSessionTrades as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        entryOrderId: 'order-entry-1',
        exitOrderId: '',
        entryTimestamp: Date.now(),
        entryPrice: '50000.00000000',
        entryFee: '0.50',
        entrySide: 'BUY',
        entryQuantity: '0.10000000',
        // No exitTimestamp = open position
      } as Partial<LiveTrade>,
    ]);
    (stateStore.getPendingOrders as ReturnType<typeof vi.fn>).mockReturnValue([]);

    // Exchange returns matching values (within tolerance)
    (orderManager.queryOrderStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      order: {
        status: 'FILLED',
        filled_size: '0.10000000',
        filled_value: '5000.00',
        average_filled_price: '50000.00000000',
        fee: '0.50',
      },
    });

    const engine = createEngine({ resumeSessionId: 'session-1' });
    const errorSpy = vi.fn();
    engine.on('error', errorSpy);

    await engine.start();

    // No error emitted -- recovery succeeded
    expect(errorSpy).not.toHaveBeenCalled();
    expect(engine.running).toBe(true);

    await engine.stop();
  });

  // ── Test 2: Size mismatch triggers ALERT ──────────────────────────

  it('sets recoveryFailed=true and emits error when exchange size diverges from DB', async () => {
    // DB says quantity=0.1
    (stateStore.getSessionTrades as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        entryOrderId: 'order-entry-1',
        exitOrderId: '',
        entryTimestamp: Date.now(),
        entryPrice: '50000.00000000',
        entryFee: '0.50',
        entrySide: 'BUY',
        entryQuantity: '0.10000000',
      } as Partial<LiveTrade>,
    ]);
    (stateStore.getPendingOrders as ReturnType<typeof vi.fn>).mockReturnValue([]);

    // Exchange says only 0.05 filled (50% less -- well beyond 0.1% tolerance)
    (orderManager.queryOrderStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      order: {
        status: 'FILLED',
        filled_size: '0.05000000',
        filled_value: '2500.00',
        average_filled_price: '50000.00000000',
        fee: '0.25',
      },
    });

    const engine = createEngine({ resumeSessionId: 'session-1' });
    const errorSpy = vi.fn();
    engine.on('error', errorSpy);

    const session = await engine.start();

    // Error emitted with ALERT message
    expect(errorSpy).toHaveBeenCalledOnce();
    expect(errorSpy.mock.calls[0][0].message).toMatch(/size mismatch/);

    // Engine not running (recoveryFailed prevents trading)
    expect(engine.running).toBe(false);
  });

  // ── Test 3: Entry price mismatch triggers ALERT ───────────────────

  it('sets recoveryFailed=true when exchange entry price diverges by more than 1%', async () => {
    // DB says entryPrice=50000
    (stateStore.getSessionTrades as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        entryOrderId: 'order-entry-1',
        exitOrderId: '',
        entryTimestamp: Date.now(),
        entryPrice: '50000.00000000',
        entryFee: '0.50',
        entrySide: 'BUY',
        entryQuantity: '0.10000000',
      } as Partial<LiveTrade>,
    ]);
    (stateStore.getPendingOrders as ReturnType<typeof vi.fn>).mockReturnValue([]);

    // Exchange says avg price=47500 (5% off -- well beyond 1% tolerance)
    (orderManager.queryOrderStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      order: {
        status: 'FILLED',
        filled_size: '0.10000000',
        filled_value: '4750.00',
        average_filled_price: '47500.00000000',
        fee: '0.50',
      },
    });

    const engine = createEngine({ resumeSessionId: 'session-1' });
    const errorSpy = vi.fn();
    engine.on('error', errorSpy);

    await engine.start();

    expect(errorSpy).toHaveBeenCalledOnce();
    expect(errorSpy.mock.calls[0][0].message).toMatch(/entry price mismatch/);
    expect(engine.running).toBe(false);
  });

  // ── Test 4: Ghost PENDING order synced to FILLED ──────────────────

  it('syncs ghost PENDING order to FILLED status from exchange', async () => {
    // No open trades (flat position)
    (stateStore.getSessionTrades as ReturnType<typeof vi.fn>).mockReturnValue([]);

    // One ghost PENDING order
    const ghostOrder = {
      orderId: 'ghost-order-1',
      clientOrderId: 'ghost-uuid-1',
      sessionId: 'session-1',
      productId: 'BTC-USD',
      side: 'BUY',
      orderType: 'MARKET',
      status: 'PENDING',
      baseSize: '0.01',
      filledSize: '0',
      filledValue: '0',
      totalFees: '0',
      createdAt: Date.now() - 10000,
      updatedAt: Date.now() - 10000,
    } as Partial<LiveOrder>;
    (stateStore.getPendingOrders as ReturnType<typeof vi.fn>).mockReturnValue([ghostOrder]);

    // Exchange shows it was actually FILLED
    (orderManager.queryOrderStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      order: {
        status: 'FILLED',
        filled_size: '0.01000000',
        filled_value: '500.00',
        average_filled_price: '50000.00000000',
        fee: '0.10',
      },
    });
    (orderManager.mapExchangeStatus as ReturnType<typeof vi.fn>).mockReturnValue('FILLED');

    const engine = createEngine({ resumeSessionId: 'session-1' });
    await engine.start();

    // stateStore.updateOrderStatus called with FILLED status
    expect(stateStore.updateOrderStatus).toHaveBeenCalledWith(
      'ghost-order-1',
      expect.objectContaining({ status: 'FILLED' }),
    );

    await engine.stop();
  });

  // ── Test 5: Ghost PENDING order marked FAILED on API error ────────

  it('marks ghost PENDING order as FAILED when queryOrderStatus throws', async () => {
    (stateStore.getSessionTrades as ReturnType<typeof vi.fn>).mockReturnValue([]);

    const ghostOrder = {
      orderId: 'ghost-order-2',
      clientOrderId: 'ghost-uuid-2',
      sessionId: 'session-1',
      productId: 'BTC-USD',
      side: 'BUY',
      orderType: 'MARKET',
      status: 'PENDING',
      baseSize: '0.01',
      filledSize: '0',
      filledValue: '0',
      totalFees: '0',
      createdAt: Date.now() - 10000,
      updatedAt: Date.now() - 10000,
    } as Partial<LiveOrder>;
    (stateStore.getPendingOrders as ReturnType<typeof vi.fn>).mockReturnValue([ghostOrder]);

    // queryOrderStatus throws (API unreachable)
    (orderManager.queryOrderStatus as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Network timeout'),
    );

    const engine = createEngine({ resumeSessionId: 'session-1' });
    await engine.start();

    // stateStore.updateOrderStatus called with FAILED status (conservative)
    expect(stateStore.updateOrderStatus).toHaveBeenCalledWith(
      'ghost-order-2',
      expect.objectContaining({ status: 'FAILED' }),
    );

    await engine.stop();
  });

  // ── Test 6: No position = no verification ─────────────────────────

  it('does not call queryOrderStatus for verification when no open position exists', async () => {
    // All trades are closed (have exitTimestamp)
    (stateStore.getSessionTrades as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        entryOrderId: 'order-1',
        exitOrderId: 'order-2',
        entryTimestamp: Date.now() - 100000,
        entryPrice: '50000',
        entryFee: '0.50',
        entrySide: 'BUY',
        entryQuantity: '0.1',
        exitTimestamp: Date.now() - 50000,
        exitPrice: '51000',
        exitFee: '0.50',
        exitSide: 'SELL',
        exitQuantity: '0.1',
        pnl: '99.00',
      } as Partial<LiveTrade>,
    ]);
    (stateStore.getPendingOrders as ReturnType<typeof vi.fn>).mockReturnValue([]);

    const engine = createEngine({ resumeSessionId: 'session-1' });
    const errorSpy = vi.fn();
    engine.on('error', errorSpy);

    await engine.start();

    // queryOrderStatus never called (no PENDING orders, no open position)
    expect(orderManager.queryOrderStatus).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(engine.running).toBe(true);

    await engine.stop();
  });

  // ── Test 7: Verification passes within tight tolerance ────────────

  it('passes verification when size difference is within 0.1% tolerance', async () => {
    // DB says 0.10000000, exchange says 0.10009 (within 0.1% = 0.0001 tolerance)
    (stateStore.getSessionTrades as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        entryOrderId: 'order-entry-1',
        exitOrderId: '',
        entryTimestamp: Date.now(),
        entryPrice: '50000.00000000',
        entryFee: '0.50',
        entrySide: 'BUY',
        entryQuantity: '0.10000000',
      } as Partial<LiveTrade>,
    ]);
    (stateStore.getPendingOrders as ReturnType<typeof vi.fn>).mockReturnValue([]);

    (orderManager.queryOrderStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      order: {
        status: 'FILLED',
        filled_size: '0.10009000',
        filled_value: '5004.50',
        average_filled_price: '50000.00000000',
        fee: '0.50',
      },
    });

    const engine = createEngine({ resumeSessionId: 'session-1' });
    const errorSpy = vi.fn();
    engine.on('error', errorSpy);

    await engine.start();

    expect(errorSpy).not.toHaveBeenCalled();
    expect(engine.running).toBe(true);

    await engine.stop();
  });
});
