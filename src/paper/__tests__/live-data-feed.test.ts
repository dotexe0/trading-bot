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

// Capture the most recently created REST client instance
let mockRestInstance: { getProductCandles: ReturnType<typeof vi.fn> } | null = null;

vi.mock('coinbase-api', () => ({
  WebsocketClient: class MockWebsocketClient {
    constructor() {
      // Delegate all methods to the shared mock instance
      return mockWsInstance;
    }
  },
  CBAdvancedTradeClient: class MockCBAdvancedTradeClient {
    getProductCandles = vi.fn();
    constructor() {
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      mockRestInstance = this as unknown as { getProductCandles: ReturnType<typeof vi.fn> };
    }
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

  it('deduplicates historical snapshot candles — blocks already-seen timestamps', () => {
    // Simulate the Coinbase WS pattern: each update sends a 100-candle snapshot
    // (all historical). Without deduplication, every batch re-emits 99 stale candles.
    // With deduplication, only genuinely new candles (strictly newer than the last
    // emitted timestamp) are forwarded.
    const candles: unknown[] = [];
    feed.on('candle', (c) => candles.push(c));

    // Simulate a batch of 5 historical candles (T, T+5m, T+10m, T+15m, T+20m)
    // The Coinbase WS sends these as a snapshot. Each successive candle triggers
    // emission of the previous (all pass dedup since they're ascending).
    sendCandleUpdate('BTC-USD', '1688998200');  // T=1m (stored)
    sendCandleUpdate('BTC-USD', '1688998260');  // T+1m → emit T
    sendCandleUpdate('BTC-USD', '1688998320');  // T+2m → emit T+1m
    sendCandleUpdate('BTC-USD', '1688998380');  // T+3m → emit T+2m
    sendCandleUpdate('BTC-USD', '1688998440');  // T+4m → emit T+3m
    expect(candles).toHaveLength(4); // T through T+3m emitted (T+4m pending)

    // Now simulate the WS sending the SAME historical batch again (snapshot replay).
    // Only the first candle in the old batch (T) differs from pendingStart (T+4m),
    // which triggers emitting the pending T+4m. Then T through T+3m are blocked by dedup.
    sendCandleUpdate('BTC-USD', '1688998200', { open: '99999.00' }); // historical T — flushes T+4m
    // T+4m gets emitted (it's newer than last emitted T+3m)
    expect(candles).toHaveLength(5);

    // Further historical candles in the same replay batch are blocked (older than T+4m)
    sendCandleUpdate('BTC-USD', '1688998260', { open: '88888.00' }); // T+1m — blocked
    sendCandleUpdate('BTC-USD', '1688998320', { open: '77777.00' }); // T+2m — blocked
    expect(candles).toHaveLength(5); // No new emissions

    // All original candles are unmodified
    expect((candles[0] as { open: string }).open).toBe('50000.00');
  });

  it('emits candles with the configured timeframe label', () => {
    const candles: unknown[] = [];
    feed.on('candle', (c) => candles.push(c));

    sendCandleUpdate('BTC-USD', '1688998200');
    sendCandleUpdate('BTC-USD', '1688998260');

    expect(candles).toHaveLength(1);
    // Default timeframe is '5m' (WS native)
    expect((candles[0] as { timeframe: string }).timeframe).toBe('5m');
  });
});

// ── REST polling / 'polled' heartbeat ────────────────────────────────────────

describe('LiveDataFeed REST polling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockRestInstance = null;
    vi.clearAllMocks();
    for (const key of Object.keys(wsHandlers)) {
      delete wsHandlers[key];
    }
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Build a minimal candle response as returned by getProductCandles. */
  function makeRestResponse(starts: number[]) {
    return {
      candles: starts.map((s) => ({
        start: String(s),
        open: '50000',
        high: '50500',
        low: '49500',
        close: '50200',
        volume: '1.0',
      })),
    };
  }

  it("emits 'polled' on every successful REST poll, even when candle is deduplicated", async () => {
    // 1h feed uses REST polling as primary data source
    const restFeed = new LiveDataFeed({
      apiKey: 'key',
      apiSecret: 'secret',
      timeframe: '1h',
    });

    const polledPairs: string[] = [];
    const emittedCandles: unknown[] = [];
    restFeed.on('polled', (pair) => polledPairs.push(pair));
    restFeed.on('candle', (c) => emittedCandles.push(c));

    // Two candle timestamps: in-progress = t, completed = t-1h (skip[0], emit[1])
    const t = 1700000000;
    mockRestInstance!.getProductCandles.mockResolvedValue(makeRestResponse([t, t - 3600]));

    restFeed.start(['BTC-USD'], 60_000);

    // The immediate first poll fires synchronously via `void this._pollRest()`.
    // Advance a tiny bit to let the async promise resolve.
    await vi.advanceTimersByTimeAsync(1);
    expect(polledPairs).toHaveLength(1);
    expect(polledPairs[0]).toBe('BTC-USD');
    expect(emittedCandles).toHaveLength(1); // first completed candle emitted

    // Second poll — same completed candle is deduplicated, but 'polled' still fires
    await vi.advanceTimersByTimeAsync(60_000);
    expect(polledPairs).toHaveLength(2);
    expect(emittedCandles).toHaveLength(1); // no new candle (deduplicated)

    restFeed.stop();
  });

  it("does NOT emit 'polled' when REST poll throws", async () => {
    const restFeed = new LiveDataFeed({
      apiKey: 'key',
      apiSecret: 'secret',
      timeframe: '1h',
    });

    const polledPairs: string[] = [];
    restFeed.on('polled', (pair) => polledPairs.push(pair));

    mockRestInstance!.getProductCandles.mockRejectedValue(new Error('API error'));

    restFeed.start(['BTC-USD'], 60_000);
    // Let the immediate first poll resolve (it throws, so no 'polled')
    await vi.advanceTimersByTimeAsync(1);

    expect(polledPairs).toHaveLength(0);

    restFeed.stop();
  });
});
