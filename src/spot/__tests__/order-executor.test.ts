/**
 * Tests for ISpotOrderExecutor implementations.
 *
 * PaperSpotOrderExecutor: verifies delegation to FillSimulator.
 * LiveSpotOrderExecutor: verifies delegation to OrderManager with retry.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { d } from '../../core/decimal.js';
import { PaperSpotOrderExecutor, LiveSpotOrderExecutor } from '../order-executor.js';
import type { Signal } from '../../strategies/types.js';
import type { Candle } from '../../core/types.js';

// ── Helpers ──────────────────────────────────────────────────────────

function makeSignal(direction: 'long' | 'short' | 'close' = 'long'): Signal {
  return {
    strategyName: 'test',
    pair: 'BTC-USD',
    timeframe: '1h',
    timestamp: Date.now(),
    direction,
    confidence: 1,
    reasoning: 'test signal',
  };
}

function makeCandle(close = '50000'): Candle {
  return {
    pair: 'BTC-USD',
    timeframe: '1h',
    timestamp: Date.now() - 3600_000,
    open: close,
    high: close,
    low: close,
    close,
    volume: '100',
  };
}

// ── Paper executor ───────────────────────────────────────────────────

describe('PaperSpotOrderExecutor', () => {
  it('delegates to FillSimulator and returns SpotFillResult', async () => {
    const mockSimulate = vi.fn().mockReturnValue({
      signal: makeSignal(),
      fillPrice: d('49990'),
      fillTimestamp: Date.now(),
      fee: d('0.5'),
      quantity: d('0.01'),
      side: 'buy',
    });

    const mockFillSim = { simulate: mockSimulate } as any;
    const executor = new PaperSpotOrderExecutor(mockFillSim);

    const result = await executor.executeOrder({
      signal: makeSignal(),
      candle: makeCandle(),
      quantity: d('0.01'),
      purpose: 'ENTRY',
    });

    expect(result.fillPrice.toString()).toBe('49990');
    expect(result.fee.toString()).toBe('0.5');
    expect(result.quantity.toString()).toBe('0.01');
    expect(result.side).toBe('buy');
    expect(result.orderId).toBeUndefined();
    expect(mockSimulate).toHaveBeenCalledOnce();
  });

  it('passes modified candle with open=close to FillSimulator', async () => {
    const mockSimulate = vi.fn().mockReturnValue({
      signal: makeSignal(),
      fillPrice: d('50000'),
      fillTimestamp: Date.now(),
      fee: d('0'),
      quantity: d('0.01'),
      side: 'buy',
    });

    const executor = new PaperSpotOrderExecutor({ simulate: mockSimulate } as any);
    const candle = makeCandle('51000');

    await executor.executeOrder({
      signal: makeSignal(),
      candle,
      quantity: d('0.01'),
      purpose: 'ENTRY',
    });

    const passedCandle = mockSimulate.mock.calls[0][1];
    expect(passedCandle.open).toBe('51000'); // open set to close
  });

  it('has no cancelOrder method', () => {
    const executor = new PaperSpotOrderExecutor({ simulate: vi.fn() } as any);
    expect((executor as any).cancelOrder).toBeUndefined();
  });
});

// ── Live executor ────────────────────────────────────────────────────

describe('LiveSpotOrderExecutor', () => {
  let executor: LiveSpotOrderExecutor;
  let mockOrderManager: any;

  beforeEach(() => {
    mockOrderManager = {
      submitMarketOrder: vi.fn().mockResolvedValue({
        orderId: 'ex-123',
        clientOrderId: 'uuid-1',
        sessionId: 'sess-1',
        productId: 'BTC-USD',
        side: 'BUY',
        orderType: 'MARKET',
        status: 'FILLED',
        baseSize: '0.01',
        filledSize: '0.01',
        filledValue: '500',
        averageFillPrice: '50050',
        totalFees: '0.75',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        purpose: 'ENTRY',
      }),
      cancelOrder: vi.fn().mockResolvedValue(true),
      reconcile: vi.fn().mockResolvedValue({}),
    };

    executor = new LiveSpotOrderExecutor(mockOrderManager);
  });

  it('executeOrder submits market order via OrderManager', async () => {
    const result = await executor.executeOrder({
      signal: makeSignal('long'),
      candle: makeCandle(),
      quantity: d('0.01'),
      purpose: 'ENTRY',
    });

    expect(mockOrderManager.submitMarketOrder).toHaveBeenCalledWith(
      expect.objectContaining({ pair: 'BTC-USD', side: 'BUY', purpose: 'ENTRY' }),
    );
    expect(result.fillPrice.toString()).toBe('50050');
    expect(result.fee.toString()).toBe('0.75');
    expect(result.orderId).toBe('ex-123');
  });

  it('executeOrder rounds quantity DOWN to base increment', async () => {
    await executor.executeOrder({
      signal: makeSignal('long'),
      candle: makeCandle(),
      quantity: d('0.015555559'),
      purpose: 'ENTRY',
    });

    const submitted = mockOrderManager.submitMarketOrder.mock.calls[0][0];
    // Should be rounded down to 8 decimal places
    expect(parseFloat(submitted.baseSize)).toBeLessThanOrEqual(0.01555555);
  });

  it('executeOrder throws if quantity too small after rounding', async () => {
    await expect(
      executor.executeOrder({
        signal: makeSignal('long'),
        candle: makeCandle(),
        quantity: d('0.000000001'), // too small
        purpose: 'ENTRY',
      }),
    ).rejects.toThrow('too small');
  });

  it('cancelOrder delegates to OrderManager', async () => {
    const result = await executor.cancelOrder!('order-123');
    expect(mockOrderManager.cancelOrder).toHaveBeenCalledWith('order-123');
    expect(result).toBe(true);
  });

  it('executeCloseWithRetry succeeds on first try', async () => {
    const result = await executor.executeCloseWithRetry!({
      pair: 'BTC-USD',
      closeSide: 'SELL',
      baseSize: '0.01',
      purpose: 'EXIT',
      maxRetries: 3,
    });

    expect(result.fillPrice.toString()).toBe('50050');
    expect(mockOrderManager.submitMarketOrder).toHaveBeenCalledTimes(1);
  });

  it('executeCloseWithRetry retries on failure then succeeds', async () => {
    let callCount = 0;
    mockOrderManager.submitMarketOrder.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw new Error('Network timeout');
      return {
        orderId: 'ex-retry',
        averageFillPrice: '50100',
        totalFees: '0.5',
        updatedAt: Date.now(),
        side: 'SELL',
      };
    });

    const result = await executor.executeCloseWithRetry!({
      pair: 'BTC-USD',
      closeSide: 'SELL',
      baseSize: '0.01',
      purpose: 'EXIT',
      maxRetries: 3,
    });

    expect(callCount).toBe(2); // 1 failure + 1 success
    expect(result.fillPrice.toString()).toBe('50100');
  });

  it('executeCloseWithRetry triggers reconciliation on total failure', async () => {
    mockOrderManager.submitMarketOrder.mockRejectedValue(new Error('All broken'));

    await expect(
      executor.executeCloseWithRetry!({
        pair: 'BTC-USD',
        closeSide: 'SELL',
        baseSize: '0.01',
        purpose: 'EXIT',
        maxRetries: 1,
      }),
    ).rejects.toThrow('All broken');

    // reconcile called as last resort
    expect(mockOrderManager.reconcile).toHaveBeenCalled();
  });
});

// ── Paper limit entry ──────────────────────────────────────────────

describe('PaperSpotOrderExecutor.executeLimitEntry', () => {
  function makeLongSignal(): Signal {
    return { strategyName: 'test', pair: 'BTC-USD', timeframe: '1h', timestamp: Date.now(), direction: 'long', confidence: 1, reasoning: 'test' };
  }

  function makeShortSignal(): Signal {
    return { ...makeLongSignal(), direction: 'short' };
  }

  it('fills long when candle low <= limitPrice', async () => {
    const mockSimulate = vi.fn().mockReturnValue({
      fillPrice: d('49900'),
      fillTimestamp: Date.now(),
      fee: d('0.3'),
      quantity: d('0.01'),
      side: 'buy',
    });
    const executor = new PaperSpotOrderExecutor({ simulate: mockSimulate } as any);

    const result = await executor.executeLimitEntry!({
      signal: makeLongSignal(),
      candle: { pair: 'BTC-USD', timeframe: '1h', timestamp: Date.now(), open: '50000', high: '50100', low: '49850', close: '50000', volume: '100' },
      quantity: d('0.01'),
      limitPrice: d('49900'),
      timeoutMs: 60000,
    });

    expect(result).not.toBeNull();
    expect(result!.fillPrice.toString()).toBe('49900');
    expect(result!.side).toBe('buy');
  });

  it('returns null for long when candle low > limitPrice', async () => {
    const executor = new PaperSpotOrderExecutor({ simulate: vi.fn() } as any);

    const result = await executor.executeLimitEntry!({
      signal: makeLongSignal(),
      candle: { pair: 'BTC-USD', timeframe: '1h', timestamp: Date.now(), open: '50000', high: '50100', low: '49950', close: '50000', volume: '100' },
      quantity: d('0.01'),
      limitPrice: d('49900'), // low=49950 > limit=49900
      timeoutMs: 60000,
    });

    expect(result).toBeNull();
  });

  it('fills short when candle high >= limitPrice', async () => {
    const mockSimulate = vi.fn().mockReturnValue({
      fillPrice: d('50100'),
      fillTimestamp: Date.now(),
      fee: d('0.3'),
      quantity: d('0.01'),
      side: 'sell',
    });
    const executor = new PaperSpotOrderExecutor({ simulate: mockSimulate } as any);

    const result = await executor.executeLimitEntry!({
      signal: makeShortSignal(),
      candle: { pair: 'BTC-USD', timeframe: '1h', timestamp: Date.now(), open: '50000', high: '50150', low: '49900', close: '50000', volume: '100' },
      quantity: d('0.01'),
      limitPrice: d('50100'),
      timeoutMs: 60000,
    });

    expect(result).not.toBeNull();
    expect(result!.fillPrice.toString()).toBe('50100');
    expect(result!.side).toBe('sell');
  });

  it('returns null for short when candle high < limitPrice', async () => {
    const executor = new PaperSpotOrderExecutor({ simulate: vi.fn() } as any);

    const result = await executor.executeLimitEntry!({
      signal: makeShortSignal(),
      candle: { pair: 'BTC-USD', timeframe: '1h', timestamp: Date.now(), open: '50000', high: '50050', low: '49900', close: '50000', volume: '100' },
      quantity: d('0.01'),
      limitPrice: d('50100'), // high=50050 < limit=50100
      timeoutMs: 60000,
    });

    expect(result).toBeNull();
  });
});
