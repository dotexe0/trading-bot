/**
 * Tests for LiveDataFeed.
 *
 * All WebSocket interactions are mocked -- no real connections.
 * Tests verify candle completion detection, timestamp conversion,
 * multi-pair independence, and event forwarding.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock coinbase-api ────────────────────────────────────────────────

// Capture event handlers registered by LiveDataFeed
const wsHandlers: Record<string, (...args: unknown[]) => void> = {};

const mockWsInstance = {
  on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    wsHandlers[event] = handler;
  }),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
};

vi.mock('coinbase-api', () => ({
  WebsocketClient: class MockWebsocketClient {
    constructor() {
      // Delegate all methods to the shared mock instance
      return mockWsInstance;
    }
  },
  CBAdvancedTradeClient: class MockCBAdvancedTradeClient {
    getProductCandles = vi.fn();
  },
}));

import { LiveDataFeed } from '../live-data-feed.js';

describe('LiveDataFeed', () => {
  let feed: LiveDataFeed;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset captured handlers
    for (const key of Object.keys(wsHandlers)) {
      delete wsHandlers[key];
    }
    feed = new LiveDataFeed();
    feed.start(['BTC-USD']);
  });

  // ── Helper: simulate a candle update from WebSocket ────────────────

  function sendCandleUpdate(
    productId: string,
    start: string,
    overrides: Partial<{
      open: string;
      high: string;
      low: string;
      close: string;
      volume: string;
    }> = {},
  ) {
    const updateHandler = wsHandlers['update'];
    expect(updateHandler).toBeDefined();

    updateHandler({
      channel: 'candles',
      events: [
        {
          candles: [
            {
              product_id: productId,
              start,
              open: overrides.open ?? '50000.00',
              high: overrides.high ?? '50500.00',
              low: overrides.low ?? '49500.00',
              close: overrides.close ?? '50200.00',
              volume: overrides.volume ?? '1.5',
            },
          ],
        },
      ],
    });
  }

  // ── Tests ──────────────────────────────────────────────────────────

  it('emits candle when new candle start arrives', () => {
    const candles: unknown[] = [];
    feed.on('candle', (c) => candles.push(c));

    // First update -- no emission (no previous candle to complete)
    sendCandleUpdate('BTC-USD', '1688998200', {
      open: '50000.00',
      close: '50200.00',
    });
    expect(candles).toHaveLength(0);

    // Second update with different start -- first candle is now complete
    sendCandleUpdate('BTC-USD', '1688998260', {
      open: '50200.00',
      close: '50300.00',
    });
    expect(candles).toHaveLength(1);
    expect((candles[0] as { open: string }).open).toBe('50000.00');
    expect((candles[0] as { close: string }).close).toBe('50200.00');
  });

  it('does NOT emit partial/in-progress candle', () => {
    const candles: unknown[] = [];
    feed.on('candle', (c) => candles.push(c));

    // Single update -- candle is still in progress
    sendCandleUpdate('BTC-USD', '1688998200');
    expect(candles).toHaveLength(0);

    // Same start timestamp again (update to same candle, not new)
    sendCandleUpdate('BTC-USD', '1688998200', {
      close: '50400.00',
    });
    expect(candles).toHaveLength(0);
  });

  it('converts WebSocket Unix seconds to Unix milliseconds', () => {
    const candles: unknown[] = [];
    feed.on('candle', (c) => candles.push(c));

    // Send two candles to trigger emission of the first
    sendCandleUpdate('BTC-USD', '1688998200');
    sendCandleUpdate('BTC-USD', '1688998260');

    expect(candles).toHaveLength(1);
    // 1688998200 seconds * 1000 = 1688998200000 milliseconds
    expect((candles[0] as { timestamp: number }).timestamp).toBe(
      1688998200000,
    );
  });

  it('handles multiple pairs independently', () => {
    const candles: unknown[] = [];
    feed.on('candle', (c) => candles.push(c));

    // BTC-USD first candle
    sendCandleUpdate('BTC-USD', '1688998200', { open: '50000.00' });
    // ETH-USD first candle
    sendCandleUpdate('ETH-USD', '1688998200', { open: '1800.00' });

    expect(candles).toHaveLength(0);

    // BTC-USD second candle -- triggers BTC-USD completion only
    sendCandleUpdate('BTC-USD', '1688998260', { open: '50200.00' });
    expect(candles).toHaveLength(1);
    expect((candles[0] as { pair: string }).pair).toBe('BTC-USD');
    expect((candles[0] as { open: string }).open).toBe('50000.00');

    // ETH-USD second candle -- triggers ETH-USD completion
    sendCandleUpdate('ETH-USD', '1688998260', { open: '1820.00' });
    expect(candles).toHaveLength(2);
    expect((candles[1] as { pair: string }).pair).toBe('ETH-USD');
    expect((candles[1] as { open: string }).open).toBe('1800.00');
  });

  it('emits connected/disconnected/reconnected events', () => {
    const events: string[] = [];
    feed.on('connected', () => events.push('connected'));
    feed.on('disconnected', () => events.push('disconnected'));
    feed.on('reconnected', () => events.push('reconnected'));

    // Trigger WebSocket events
    wsHandlers['open']?.();
    expect(events).toContain('connected');

    wsHandlers['close']?.();
    expect(events).toContain('disconnected');

    wsHandlers['reconnected']?.();
    expect(events).toContain('reconnected');
  });

  it('emits error events from WebSocket exceptions', () => {
    const errors: Error[] = [];
    feed.on('error', (err) => errors.push(err));

    const testError = new Error('WebSocket connection failed');
    wsHandlers['exception']?.(testError);

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe('WebSocket connection failed');
  });

  it('subscribes to advTradeMarketData candles channel', () => {
    expect(mockWsInstance.subscribe).toHaveBeenCalledWith(
      {
        topic: 'candles',
        payload: { product_ids: ['BTC-USD'] },
      },
      'advTradeMarketData',
    );
  });
});
