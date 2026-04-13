/**
 * Tests for SpotTradingEngine — unified paper/live spot engine.
 *
 * Uses a mock ISpotOrderExecutor + mock dependencies to verify:
 * - Paper mode: start/stop, onCandle, entry/exit signals, exit logic, PnL
 * - Live mode: executor receives live fill, slippage tracking
 * - Shared: regime auto-switch, buffer preload, feed health guard
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { d } from '../../core/decimal.js';
import { SpotTradingEngine } from '../spot-trading-engine.js';
import type { SpotTradingEngineOptions, ISpotStateStore } from '../spot-trading-engine.js';
import type { ISpotOrderExecutor, SpotFillResult, SpotOrderParams } from '../order-executor.js';
import type { Signal } from '../../strategies/types.js';
import type { Candle } from '../../core/types.js';

// ── Mock helpers ────────────────────────────────────────────────────

function makeCandle(close = '50000', pair = 'BTC-USD', tf = '1h', ts?: number): Candle {
  return {
    pair: pair as any,
    timeframe: tf as any,
    timestamp: ts ?? Date.now() - 3600_000,
    open: close,
    high: close,
    low: close,
    close,
    volume: '100',
  };
}

function makeFillResult(overrides: Partial<SpotFillResult> = {}): SpotFillResult {
  return {
    fillPrice: d('50000'),
    quantity: d('0.01'),
    fee: d('0.5'),
    fillTimestamp: Date.now(),
    side: 'buy',
    ...overrides,
  };
}

function createMockExecutor(overrides: Partial<ISpotOrderExecutor> = {}): ISpotOrderExecutor {
  return {
    executeOrder: vi.fn().mockResolvedValue(makeFillResult()),
    ...overrides,
  };
}

function createMockStateStore(): ISpotStateStore {
  return {
    createSession: vi.fn().mockReturnValue({ id: 'test-session-1' }),
    endSession: vi.fn(),
    recordEquityPoint: vi.fn(),
    recordTrade: vi.fn(),
    getSession: vi.fn().mockReturnValue(null),
    getSessionTrades: vi.fn().mockReturnValue([]),
    getResult: vi.fn().mockReturnValue(null),
    close: vi.fn(),
  };
}

function createMockLiveFeed(): any {
  const feed = new EventEmitter();
  (feed as any).start = vi.fn();
  (feed as any).stop = vi.fn();
  return feed;
}

function createMockRegistry(strategy?: any): any {
  const defaultStrategy = {
    name: 'test-strategy',
    minCandles: 1,
    evaluate: vi.fn().mockReturnValue([]),
  };
  return {
    create: vi.fn().mockReturnValue(strategy ?? defaultStrategy),
  };
}

function createMockIndicatorEngine(): any {
  return {
    compute: vi.fn().mockReturnValue({ values: [100] }),
  };
}

function createDefaultOptions(overrides: Partial<SpotTradingEngineOptions> = {}): SpotTradingEngineOptions {
  return {
    mode: 'paper',
    executor: createMockExecutor(),
    config: {
      pair: 'BTC-USD',
      timeframe: '1h',
      strategyConfig: { strategy: 'test' },
      initialCapital: '10000',
      allowShorts: true,
      slippageBps: 5,
      feeTierMaker: 0.004,
      feeTierTaker: 0.006,
      assumeTaker: true,
      bufferSize: 500,
      pollIntervalMs: 60000,
    },
    liveFeed: createMockLiveFeed(),
    stateStore: createMockStateStore(),
    strategyRegistry: createMockRegistry(),
    indicatorEngine: createMockIndicatorEngine(),
    ...overrides,
  };
}

// ── Paper mode tests ────────────────────────────────────────────────

describe('SpotTradingEngine – paper mode', () => {
  let engine: SpotTradingEngine;
  let opts: SpotTradingEngineOptions;

  beforeEach(() => {
    opts = createDefaultOptions();
    engine = new SpotTradingEngine(opts);
  });

  afterEach(async () => {
    if (engine.running) await engine.stop();
  });

  it('starts and creates a session', async () => {
    await engine.start();
    expect(engine.running).toBe(true);
    expect(opts.stateStore.createSession).toHaveBeenCalled();
    expect(engine.getSession()?.id).toBe('test-session-1');
  });

  it('stops and ends session', async () => {
    await engine.start();
    await engine.stop();
    expect(engine.running).toBe(false);
    expect(opts.stateStore.endSession).toHaveBeenCalledWith('test-session-1', expect.any(String), 'stopped');
  });

  it('emits started and stopped events', async () => {
    const started = vi.fn();
    const stopped = vi.fn();
    engine.on('started', started);
    engine.on('stopped', stopped);

    await engine.start();
    expect(started).toHaveBeenCalledTimes(1);

    await engine.stop();
    expect(stopped).toHaveBeenCalledTimes(1);
  });

  it('isFlat() returns true initially', async () => {
    await engine.start();
    expect(engine.isFlat()).toBe(true);
  });

  it('getOpenPosition() returns null when flat', async () => {
    await engine.start();
    expect(engine.getOpenPosition()).toBeNull();
  });

  it('mode is paper', () => {
    expect(engine.mode).toBe('paper');
  });
});

describe('SpotTradingEngine – paper onCandle entry/exit', () => {
  let engine: SpotTradingEngine;
  let opts: SpotTradingEngineOptions;
  let mockExecutor: ISpotOrderExecutor;

  beforeEach(async () => {
    const entryFill = makeFillResult({
      fillPrice: d('50000'),
      quantity: d('0.19'),
      fee: d('0.57'),
      side: 'buy',
      fillTimestamp: Date.now(),
    });

    mockExecutor = createMockExecutor();
    (mockExecutor.executeOrder as any).mockResolvedValue(entryFill);

    const strategy = {
      name: 'test-entry',
      minCandles: 1,
      evaluate: vi.fn().mockReturnValue([]),
    };

    opts = createDefaultOptions({
      executor: mockExecutor,
      strategyRegistry: createMockRegistry(strategy),
    });
    engine = new SpotTradingEngine(opts);
    await engine.start();
  });

  afterEach(async () => {
    if (engine.running) await engine.stop();
  });

  it('processes entry signal and opens position', async () => {
    const strategy = opts.strategyRegistry.create({});
    vi.mocked(strategy.evaluate).mockReturnValue([{
      strategyName: 'test-entry',
      pair: 'BTC-USD',
      timeframe: '1h',
      timestamp: Date.now(),
      direction: 'long',
      confidence: 0.8,
      reasoning: 'test',
    }]);

    const candle = makeCandle('50000');
    engine.onCandle(candle);

    // Wait for async executor
    await vi.waitFor(() => {
      expect(engine.isFlat()).toBe(false);
    });

    expect(mockExecutor.executeOrder).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'ENTRY' }),
    );

    const pos = engine.getOpenPosition();
    expect(pos).not.toBeNull();
    expect(pos!.side).toBe('long');
    expect(pos!.avgEntryPrice).toBe('50000');
  });

  it('processes close signal and records trade', async () => {
    // Open position first
    const strategy = opts.strategyRegistry.create({});
    vi.mocked(strategy.evaluate).mockReturnValueOnce([{
      strategyName: 'test-entry',
      pair: 'BTC-USD',
      timeframe: '1h',
      timestamp: Date.now(),
      direction: 'long',
      confidence: 0.8,
      reasoning: 'test',
    }]);

    engine.onCandle(makeCandle('50000'));
    await vi.waitFor(() => expect(engine.isFlat()).toBe(false));

    // Now close
    const closeFill = makeFillResult({
      fillPrice: d('51000'),
      quantity: d('0.19'),
      fee: d('0.57'),
      side: 'sell',
      fillTimestamp: Date.now(),
    });
    (mockExecutor.executeOrder as any).mockResolvedValue(closeFill);

    vi.mocked(strategy.evaluate).mockReturnValueOnce([{
      strategyName: 'test-close',
      pair: 'BTC-USD',
      timeframe: '1h',
      timestamp: Date.now(),
      direction: 'close',
      confidence: 1,
      reasoning: 'test',
    }]);

    engine.onCandle(makeCandle('51000'));
    await vi.waitFor(() => expect(engine.isFlat()).toBe(true));

    expect(opts.stateStore.recordTrade).toHaveBeenCalled();
  });

  it('skips entry when already in position', async () => {
    const strategy = opts.strategyRegistry.create({});
    vi.mocked(strategy.evaluate).mockReturnValue([{
      strategyName: 'test-entry',
      pair: 'BTC-USD',
      timeframe: '1h',
      timestamp: Date.now(),
      direction: 'long',
      confidence: 0.8,
      reasoning: 'test',
    }]);

    engine.onCandle(makeCandle('50000'));
    await vi.waitFor(() => expect(engine.isFlat()).toBe(false));

    const callsBefore = (mockExecutor.executeOrder as any).mock.calls.length;

    // Second candle with entry signal should be ignored
    engine.onCandle(makeCandle('50100'));
    await new Promise(r => setTimeout(r, 10));

    expect((mockExecutor.executeOrder as any).mock.calls.length).toBe(callsBefore);
  });

  it('emits orderFilled for entry', async () => {
    const orderFilled = vi.fn();
    engine.on('orderFilled', orderFilled);

    const strategy = opts.strategyRegistry.create({});
    vi.mocked(strategy.evaluate).mockReturnValue([{
      strategyName: 'test-entry',
      pair: 'BTC-USD',
      timeframe: '1h',
      timestamp: Date.now(),
      direction: 'long',
      confidence: 0.8,
      reasoning: 'test',
    }]);

    engine.onCandle(makeCandle('50000'));
    await vi.waitFor(() => expect(orderFilled).toHaveBeenCalled());

    expect(orderFilled).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'ENTRY', pair: 'BTC-USD' }),
    );
  });

  it('records equity point on each candle', async () => {
    const strategy = opts.strategyRegistry.create({});
    vi.mocked(strategy.evaluate).mockReturnValue([]);

    engine.onCandle(makeCandle('50000'));
    expect(opts.stateStore.recordEquityPoint).toHaveBeenCalledWith(
      'test-session-1',
      expect.any(Number),
      expect.anything(),
    );
  });

  it('skips signal when feed is stale', async () => {
    const feedHealthMonitor = { isStale: vi.fn().mockReturnValue(true) } as any;
    const opts2 = createDefaultOptions({ feedHealthMonitor });
    const engine2 = new SpotTradingEngine(opts2);
    await engine2.start();

    const strategy = opts2.strategyRegistry.create({});
    vi.mocked(strategy.evaluate).mockReturnValue([{
      strategyName: 'test',
      pair: 'BTC-USD',
      timeframe: '1h',
      timestamp: Date.now(),
      direction: 'long',
      confidence: 0.8,
      reasoning: 'test',
    }]);

    engine2.onCandle(makeCandle('50000'));
    await new Promise(r => setTimeout(r, 10));

    // Strategy should not even be called (feed stale returns early)
    expect(strategy.evaluate).not.toHaveBeenCalled();
    await engine2.stop();
  });

  it('does not process candles when stopped', async () => {
    await engine.stop();
    const strategy = opts.strategyRegistry.create({});
    vi.mocked(strategy.evaluate).mockReturnValue([{
      strategyName: 'test',
      pair: 'BTC-USD',
      timeframe: '1h',
      timestamp: Date.now(),
      direction: 'long',
      confidence: 0.8,
      reasoning: 'test',
    }]);

    engine.onCandle(makeCandle('50000'));
    await new Promise(r => setTimeout(r, 10));

    expect(strategy.evaluate).not.toHaveBeenCalled();
  });
});

describe('SpotTradingEngine – paper PnL computation', () => {
  it('computes positive PnL for long position', async () => {
    const entryFill = makeFillResult({
      fillPrice: d('50000'),
      quantity: d('0.1'),
      fee: d('3'),
      side: 'buy',
    });
    const closeFill = makeFillResult({
      fillPrice: d('51000'),
      quantity: d('0.1'),
      fee: d('3'),
      side: 'sell',
    });

    const executor = createMockExecutor();
    (executor.executeOrder as any)
      .mockResolvedValueOnce(entryFill)
      .mockResolvedValueOnce(closeFill);

    const strategy = {
      name: 'pnl-test',
      minCandles: 1,
      evaluate: vi.fn()
        .mockReturnValueOnce([{
          strategyName: 'pnl-test',
          pair: 'BTC-USD',
          timeframe: '1h',
          timestamp: Date.now(),
          direction: 'long',
          confidence: 1,
        }])
        .mockReturnValueOnce([{
          strategyName: 'pnl-test',
          pair: 'BTC-USD',
          timeframe: '1h',
          timestamp: Date.now(),
          direction: 'close',
          confidence: 1,
        }]),
    };

    const stateStore = createMockStateStore();
    const opts = createDefaultOptions({
      executor,
      strategyRegistry: createMockRegistry(strategy),
      stateStore,
    });

    const engine = new SpotTradingEngine(opts);
    await engine.start();

    engine.onCandle(makeCandle('50000'));
    await vi.waitFor(() => expect(engine.isFlat()).toBe(false));

    engine.onCandle(makeCandle('51000'));
    await vi.waitFor(() => expect(engine.isFlat()).toBe(true));

    // Verify trade was recorded with correct PnL
    expect(stateStore.recordTrade).toHaveBeenCalledTimes(1);
    const trade = (stateStore.recordTrade as any).mock.calls[0][1];
    // PnL = (51000 - 50000) * 0.1 - 3 - 3 = 94
    expect(trade.pnl.toNumber()).toBe(94);

    await engine.stop();
  });

  it('computes negative PnL for short position', async () => {
    const entryFill = makeFillResult({
      fillPrice: d('50000'),
      quantity: d('0.1'),
      fee: d('3'),
      side: 'sell',
    });
    const closeFill = makeFillResult({
      fillPrice: d('51000'),
      quantity: d('0.1'),
      fee: d('3'),
      side: 'buy',
    });

    const executor = createMockExecutor();
    (executor.executeOrder as any)
      .mockResolvedValueOnce(entryFill)
      .mockResolvedValueOnce(closeFill);

    const strategy = {
      name: 'pnl-short',
      minCandles: 1,
      evaluate: vi.fn()
        .mockReturnValueOnce([{
          strategyName: 'pnl-short',
          pair: 'BTC-USD',
          timeframe: '1h',
          timestamp: Date.now(),
          direction: 'short',
          confidence: 1,
        }])
        .mockReturnValueOnce([{
          strategyName: 'pnl-short',
          pair: 'BTC-USD',
          timeframe: '1h',
          timestamp: Date.now(),
          direction: 'close',
          confidence: 1,
        }]),
    };

    const stateStore = createMockStateStore();
    const opts = createDefaultOptions({
      executor,
      strategyRegistry: createMockRegistry(strategy),
      stateStore,
    });

    const engine = new SpotTradingEngine(opts);
    await engine.start();

    engine.onCandle(makeCandle('50000'));
    await vi.waitFor(() => expect(engine.isFlat()).toBe(false));

    engine.onCandle(makeCandle('51000'));
    await vi.waitFor(() => expect(engine.isFlat()).toBe(true));

    const trade = (stateStore.recordTrade as any).mock.calls[0][1];
    // PnL = (50000 - 51000) * 0.1 - 3 - 3 = -106
    expect(trade.pnl.toNumber()).toBe(-106);

    await engine.stop();
  });
});

// ── Live mode tests ─────────────────────────────────────────────────

describe('SpotTradingEngine – live mode', () => {
  it('creates engine in live mode', () => {
    const opts = createDefaultOptions({ mode: 'live' });
    const engine = new SpotTradingEngine(opts);
    expect(engine.mode).toBe('live');
  });

  it('uses executeCloseWithRetry for live exits when available', async () => {
    const entryFill = makeFillResult({ fillPrice: d('50000'), quantity: d('0.1'), fee: d('0'), side: 'buy' });
    const closeFill = makeFillResult({ fillPrice: d('51000'), quantity: d('0.1'), fee: d('0'), side: 'sell' });

    const mockCloseWithRetry = vi.fn().mockResolvedValue(closeFill);
    const executor = createMockExecutor({
      executeCloseWithRetry: mockCloseWithRetry,
    });
    (executor.executeOrder as any).mockResolvedValue(entryFill);

    const strategy = {
      name: 'live-test',
      minCandles: 1,
      evaluate: vi.fn()
        .mockReturnValueOnce([{
          strategyName: 'live-test',
          pair: 'BTC-USD',
          timeframe: '1h',
          timestamp: Date.now(),
          direction: 'long',
          confidence: 1,
        }])
        .mockReturnValueOnce([{
          strategyName: 'live-test',
          pair: 'BTC-USD',
          timeframe: '1h',
          timestamp: Date.now(),
          direction: 'close',
          confidence: 1,
        }]),
    };

    const opts = createDefaultOptions({
      mode: 'live',
      executor,
      strategyRegistry: createMockRegistry(strategy),
    });
    const engine = new SpotTradingEngine(opts);
    await engine.start();

    engine.onCandle(makeCandle('50000'));
    await vi.waitFor(() => expect(engine.isFlat()).toBe(false));

    engine.onCandle(makeCandle('51000'));
    await vi.waitFor(() => expect(engine.isFlat()).toBe(true));

    expect(mockCloseWithRetry).toHaveBeenCalled();
    await engine.stop();
  });

  it('records LiveTrade format (flat strings) in live mode', async () => {
    const entryFill = makeFillResult({ fillPrice: d('50000'), quantity: d('0.1'), fee: d('3'), side: 'buy', orderId: 'ex-1' });
    const closeFill = makeFillResult({ fillPrice: d('51000'), quantity: d('0.1'), fee: d('3'), side: 'sell', orderId: 'ex-2' });

    const executor = createMockExecutor({
      executeCloseWithRetry: vi.fn().mockResolvedValue(closeFill),
    });
    (executor.executeOrder as any).mockResolvedValue(entryFill);

    const strategy = {
      name: 'live-trade-test',
      minCandles: 1,
      evaluate: vi.fn()
        .mockReturnValueOnce([{
          strategyName: 'live-trade-test',
          pair: 'BTC-USD',
          timeframe: '1h',
          timestamp: Date.now(),
          direction: 'long',
          confidence: 1,
        }])
        .mockReturnValueOnce([{
          strategyName: 'live-trade-test',
          pair: 'BTC-USD',
          timeframe: '1h',
          timestamp: Date.now(),
          direction: 'close',
          confidence: 1,
        }]),
    };

    const stateStore = createMockStateStore();
    const opts = createDefaultOptions({
      mode: 'live',
      executor,
      strategyRegistry: createMockRegistry(strategy),
      stateStore,
    });

    const engine = new SpotTradingEngine(opts);
    await engine.start();

    engine.onCandle(makeCandle('50000'));
    await vi.waitFor(() => expect(engine.isFlat()).toBe(false));

    engine.onCandle(makeCandle('51000'));
    await vi.waitFor(() => expect(engine.isFlat()).toBe(true));

    const trade = (stateStore.recordTrade as any).mock.calls[0][1];
    // Live trade format has flat string fields
    expect(typeof trade.entryPrice).toBe('string');
    expect(typeof trade.exitPrice).toBe('string');
    expect(typeof trade.pnl).toBe('string');
    expect(trade.entryOrderId).toBe('ex-1');
    expect(trade.exitOrderId).toBe('ex-2');

    await engine.stop();
  });
});

// ── Buffer preload tests ────────────────────────────────────────────

describe('SpotTradingEngine – buffer preload', () => {
  it('preloads buffer from candleRepo when provided', async () => {
    const historical = Array.from({ length: 50 }, (_, i) =>
      makeCandle('50000', 'BTC-USD', '1h', Date.now() - (50 - i) * 3600_000 - 7200_000),
    );

    const candleRepo = {
      getCandles: vi.fn().mockReturnValue(historical),
    } as any;

    const opts = createDefaultOptions({ candleRepo });
    const engine = new SpotTradingEngine(opts);
    await engine.start();

    expect(engine.getBufferSize('BTC-USD:1h')).toBeGreaterThan(0);
    await engine.stop();
  });

  it('starts with empty buffer when no candleRepo', async () => {
    const opts = createDefaultOptions();
    const engine = new SpotTradingEngine(opts);
    await engine.start();

    expect(engine.getBufferSize('BTC-USD:1h')).toBe(0);
    await engine.stop();
  });
});

// ── Regime auto-switch tests ────────────────────────────────────────

describe('SpotTradingEngine – regime auto-switch', () => {
  it('defers switch when position is open', async () => {
    const entryFill = makeFillResult({ fillPrice: d('50000'), quantity: d('0.1'), fee: d('0'), side: 'buy' });
    const executor = createMockExecutor();
    (executor.executeOrder as any).mockResolvedValue(entryFill);

    let evalCount = 0;
    const strategy = {
      name: 'initial',
      minCandles: 1,
      evaluate: vi.fn().mockImplementation(() => {
        evalCount++;
        if (evalCount === 1) {
          return [{
            strategyName: 'initial',
            pair: 'BTC-USD',
            timeframe: '1h',
            timestamp: Date.now(),
            direction: 'long',
            confidence: 1,
          }];
        }
        return [];
      }),
    };

    const switchedStrategy = { name: 'switched', minCandles: 1, evaluate: vi.fn().mockReturnValue([]) };
    const registry = {
      create: vi.fn().mockImplementation((config: any) => {
        if (config?.strategy === 'test') return strategy;
        return switchedStrategy;
      }),
    };

    const regimeLeaderboards = {
      trending: [{ strategyConfig: { strategy: 'trending-winner' }, sharpe: 1.5 }],
      'mean-reverting': [{ strategyConfig: { strategy: 'mr-winner' }, sharpe: 1.2 }],
      volatile: [],
      quiet: [],
      fallbackEntry: { strategyConfig: { strategy: 'fallback' }, sharpe: 0.5 },
    } as any;

    const opts = createDefaultOptions({
      executor,
      strategyRegistry: registry as any,
      regimeLeaderboards,
    });
    const engine = new SpotTradingEngine(opts);
    await engine.start();

    // First candle: opens position
    engine.onCandle(makeCandle('50000'));
    await vi.waitFor(() => expect(engine.isFlat()).toBe(false));

    // Strategy switch should be deferred (position open)
    expect(switchedStrategy.evaluate).not.toHaveBeenCalled();

    await engine.stop();
  });
});
