/**
 * Tests for IntxClient (FCM) and fcmConfigSchema / intxConfigSchema.
 *
 * All CBAdvancedTradeClient and WebsocketClient interactions are mocked — no live network calls.
 * Tests validate:
 *   - Config schema refine rules (enabled + missing credentials)
 *   - IntxClient constructor guard (enabled=false throws)
 *   - IntxClient constructor success (CBAdvancedTradeClient instantiated)
 *   - getAccountState() calls getFuturesBalanceSummary + getFuturesPositions and maps response
 *   - WebSocket start() double-start guard
 *   - ticker channel update emits markPrice with correct fields and isStale=false
 *   - futures_balance_summary channel emits fundingRate
 *   - isStale set on close, disconnected emitted
 *   - reconnectFailed after MAX_RECONNECT_ATTEMPTS close events
 *   - stop() clears pending reconnect timer and calls ws.closeAll()
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// ── Hoisted mock helpers (must be defined before vi.mock is hoisted) ─
const { mockGetFuturesBalanceSummary, mockGetFuturesPositions, mockCloseAll, mockSubscribe, wsInstances } = vi.hoisted(() => {
  const mockGetFuturesBalanceSummary = vi.fn();
  const mockGetFuturesPositions = vi.fn();
  const mockCloseAll = vi.fn();
  const mockSubscribe = vi.fn();
  const wsInstances: EventEmitter[] = [];
  return { mockGetFuturesBalanceSummary, mockGetFuturesPositions, mockCloseAll, mockSubscribe, wsInstances };
});

vi.mock('coinbase-api', () => {
  const { EventEmitter: EE } = require('node:events');
  class MockWebsocketClient extends EE {
    constructor(opts: unknown) {
      super();
      (MockWebsocketClient as any)._instances.push(this);
    }
    closeAll = mockCloseAll;
    subscribe = mockSubscribe;
    static _instances: MockWebsocketClient[] = [];
  }
  return {
    CBAdvancedTradeClient: class MockCBAdvancedTradeClient {
      constructor(public opts: unknown) {}
      getFuturesBalanceSummary = mockGetFuturesBalanceSummary;
      getFuturesPositions = mockGetFuturesPositions;
    },
    WebsocketClient: MockWebsocketClient,
  };
});

// Import AFTER mock registration
import { intxConfigSchema } from '../config.js';
import { IntxClient } from '../intx-client.js';
import { WebsocketClient as MockWSCtor } from 'coinbase-api';

// ── Helpers ─────────────────────────────────────────────────────────

const VALID_ENABLED_CONFIG = {
  enabled: true,
  apiKey: 'test-key',
  apiSecret: 'test-secret',
  testnet: true,
};

function makeClient(): IntxClient {
  const config = intxConfigSchema.parse(VALID_ENABLED_CONFIG);
  return new IntxClient(config);
}

/** Returns the most recently created MockWebsocketClient instance. */
function lastWsInstance(): EventEmitter {
  const instances = (MockWSCtor as any)._instances as EventEmitter[];
  if (instances.length === 0) throw new Error('No MockWebsocketClient instances created');
  return instances[instances.length - 1]!;
}

// ── intxConfigSchema tests ────────────────────────────────────────────

describe('intxConfigSchema (FCM)', () => {
  it('Test 1: validates successfully with enabled=false and no credentials', () => {
    const result = intxConfigSchema.safeParse({ enabled: false });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(false);
    }
  });

  it('Test 2: validates successfully with enabled=true and apiKey + apiSecret', () => {
    const result = intxConfigSchema.safeParse(VALID_ENABLED_CONFIG);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(true);
      expect(result.data.apiKey).toBe('test-key');
      expect(result.data.apiSecret).toBe('test-secret');
    }
  });

  it('Test 3: fails when enabled=true and apiKey is missing', () => {
    const result = intxConfigSchema.safeParse({
      enabled: true,
      // apiKey omitted
      apiSecret: 'test-secret',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages.some((m) => m.includes('COINBASE_API_KEY_NAME'))).toBe(true);
    }
  });

  it('Test 4: fails when enabled=true and apiSecret is missing', () => {
    const result = intxConfigSchema.safeParse({
      enabled: true,
      apiKey: 'test-key',
      // apiSecret omitted
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages.some((m) => m.includes('COINBASE_API_KEY_SECRET'))).toBe(true);
    }
  });
});

// ── IntxClient constructor tests ─────────────────────────────────────

describe('IntxClient constructor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (MockWSCtor as any)._instances = [];
  });

  it('Test 5: throws when instantiated with enabled=false', () => {
    const disabledConfig = intxConfigSchema.parse({ enabled: false });
    expect(() => new IntxClient(disabledConfig)).toThrow(
      'IntxClient instantiated with FCM_ENABLED=false',
    );
  });

  it('Test 6: succeeds with a valid enabled config', () => {
    const config = intxConfigSchema.parse(VALID_ENABLED_CONFIG);
    const client = new IntxClient(config);
    expect(client).toBeInstanceOf(IntxClient);
  });
});

// ── IntxClient.getAccountState() tests ──────────────────────────────

describe('IntxClient.getAccountState()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (MockWSCtor as any)._instances = [];
  });

  it('Test 7: calls getFuturesBalanceSummary + getFuturesPositions and maps response to IntxAccountState', async () => {
    const mockBalanceSummary = {
      balance_summary: {
        futures_buying_power: { value: '10000', currency: 'USD' },
        total_usd_balance: { value: '10000', currency: 'USD' },
      },
    };
    const mockPositions = {
      positions: [
        { product_id: 'BIP-20DEC30-CDE', side: 'LONG', number_of_contracts: '1' },
      ],
    };
    mockGetFuturesBalanceSummary.mockResolvedValueOnce(mockBalanceSummary);
    mockGetFuturesPositions.mockResolvedValueOnce(mockPositions);

    const config = intxConfigSchema.parse(VALID_ENABLED_CONFIG);
    const client = new IntxClient(config);
    const state = await client.getAccountState();

    expect(mockGetFuturesBalanceSummary).toHaveBeenCalledOnce();
    expect(mockGetFuturesPositions).toHaveBeenCalledOnce();

    expect(state.balances).toEqual(mockBalanceSummary.balance_summary);
    expect(state.positions).toEqual(mockPositions.positions);
    expect(state.summary).toEqual(mockBalanceSummary.balance_summary);
  });
});

// ── IntxClient WebSocket tests ───────────────────────────────────────

describe('IntxClient WebSocket streaming', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (MockWSCtor as any)._instances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('Test 8: start() throws if called twice (double-start guard)', async () => {
    const client = makeClient();
    await client.start();
    await expect(client.start()).rejects.toThrow('FcmClient already started');
    await client.stop();
  });

  it('Test 9: ticker channel update emits markPrice with correct fields and isStale=false', async () => {
    const client = makeClient();
    await client.start();

    const received: any[] = [];
    client.on('markPrice', (evt) => received.push(evt));

    const ws = lastWsInstance();
    // Simulate nested ticker event structure
    ws.emit('update', {
      channel: 'ticker',
      events: [
        {
          tickers: [
            {
              product_id: 'BIP-20DEC30-CDE',
              price: '50000.00',
            },
          ],
        },
      ],
    });

    expect(received).toHaveLength(1);
    expect(received[0]!.instrument).toBe('BIP-20DEC30-CDE');
    expect(received[0]!.markPrice).toBe('50000.00');
    expect(received[0]!.isStale).toBe(false);
    expect(typeof received[0]!.timestamp).toBe('number');

    await client.stop();
  });

  it('Test 10: futures_balance_summary channel emits fundingRate with correct fields', async () => {
    const client = makeClient();
    await client.start();

    const received: any[] = [];
    client.on('fundingRate', (evt) => received.push(evt));

    const ws = lastWsInstance();
    ws.emit('update', {
      channel: 'futures_balance_summary',
      events: [
        {
          fcm_balance_summary: {
            funding_hold: '0.0001',
          },
        },
      ],
    });

    expect(received).toHaveLength(1);
    expect(received[0]!.instrument).toBe('FCM');
    expect(received[0]!.fundingRate).toBe('0.0001');
    expect(received[0]!.isFinal).toBe(false);
    expect(received[0]!.isStale).toBe(false);
    expect(typeof received[0]!.timestamp).toBe('number');

    await client.stop();
  });

  it('Test 11: close event sets _isStale=true and emits disconnected', async () => {
    vi.useFakeTimers();

    const client = makeClient();
    await client.start();

    const disconnectedEvents: unknown[] = [];
    client.on('disconnected', () => disconnectedEvents.push(true));

    const ws = lastWsInstance();
    ws.emit('close');

    expect((client as any)._isStale).toBe(true);
    expect(disconnectedEvents).toHaveLength(1);

    await client.stop();
  });

  it('Test 12: after MAX_RECONNECT_ATTEMPTS close events, reconnectFailed is emitted and stopped=true', async () => {
    vi.useFakeTimers();

    const client = makeClient();
    await client.start();

    const reconnectFailedEvents: unknown[] = [];
    client.on('reconnectFailed', (evt) => reconnectFailedEvents.push(evt));

    const ws = lastWsInstance();

    // Emit close events without advancing fake timers so reconnectAttempts accumulates.
    // Each close → _scheduleReconnect() increments reconnectAttempts then schedules a timer.
    // Since we don't advance the timer, the timers never fire and attempts keep growing.
    // On the 11th close, reconnectAttempts (11) > MAX_RECONNECT_ATTEMPTS (10) → fires reconnectFailed.
    for (let i = 0; i < 11; i++) {
      ws.emit('close');
    }

    expect(reconnectFailedEvents).toHaveLength(1);
    expect((reconnectFailedEvents[0] as any).attempts).toBeGreaterThan(10);
    expect((client as any).stopped).toBe(true);
  });

  it('Test 13: stop() clears pending reconnect timer and calls ws.closeAll()', async () => {
    vi.useFakeTimers();

    const client = makeClient();
    await client.start();

    const ws = lastWsInstance();

    // Trigger a close to schedule a reconnect timer
    ws.emit('close');

    // Verify a reconnect timer is pending
    expect((client as any).reconnectTimer).not.toBeNull();

    await client.stop();

    // Timer should be cleared and ws.closeAll should have been called
    expect((client as any).reconnectTimer).toBeNull();
    expect(mockCloseAll).toHaveBeenCalledOnce();
    expect((client as any).ws).toBeNull();
  });

  it('Test 15: getLastFundingRate() returns null initially then cached value after event', async () => {
    const client = makeClient();
    await client.start();

    // Before any event: must be null
    expect(client.getLastFundingRate()).toBeNull();

    // Emit a futures_balance_summary event
    const ws = lastWsInstance();
    ws.emit('update', {
      channel: 'futures_balance_summary',
      events: [{
        fcm_balance_summary: { funding_hold: '0.00015' },
      }],
    });

    // After event: should return the numeric value
    expect(client.getLastFundingRate()).toBe(0.00015);

    await client.stop();
  });

  it('Test 14: user channel FILLED order event emits orderFill with correct fields', async () => {
    const client = makeClient();
    await client.start();

    const received: any[] = [];
    client.on('orderFill', (evt) => received.push(evt));

    const ws = lastWsInstance();

    // Simulate a FILLED order via user channel
    ws.emit('update', {
      channel: 'user',
      events: [
        {
          orders: [
            {
              status: 'FILLED',
              order_id: 'ord-1',
              client_order_id: 'coid-1',
              product_id: 'BIP-20DEC30-CDE',
              side: 'BUY',
              filled_size: '1',
              average_filled_price: '50000',
              total_fees: '5',
            },
          ],
        },
      ],
    });

    expect(received).toHaveLength(1);
    expect(received[0]!.orderId).toBe('ord-1');
    expect(received[0]!.clientOrderId).toBe('coid-1');
    expect(received[0]!.productId).toBe('BIP-20DEC30-CDE');
    expect(received[0]!.side).toBe('BUY');
    expect(received[0]!.filledSize).toBe('1');
    expect(received[0]!.avgFillPrice).toBe('50000');
    expect(received[0]!.totalFees).toBe('5');
    expect(typeof received[0]!.timestamp).toBe('number');

    // Non-FILLED (OPEN) order must NOT emit orderFill
    ws.emit('update', {
      channel: 'user',
      events: [
        {
          orders: [
            {
              status: 'OPEN',
              order_id: 'ord-2',
              client_order_id: 'coid-2',
              product_id: 'BIP-20DEC30-CDE',
              side: 'BUY',
              filled_size: '0',
              average_filled_price: '0',
              total_fees: '0',
            },
          ],
        },
      ],
    });

    // Still only 1 event — the OPEN order did not emit
    expect(received).toHaveLength(1);

    await client.stop();
  });
});
