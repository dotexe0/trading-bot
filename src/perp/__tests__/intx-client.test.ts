/**
 * Tests for IntxClient and intxConfigSchema.
 *
 * All CBInternationalClient and WebsocketClient interactions are mocked — no live network calls.
 * Tests validate:
 *   - Config schema refine rules (enabled + missing credentials)
 *   - IntxClient constructor guard (enabled=false throws)
 *   - IntxClient constructor success (CBInternationalClient instantiated)
 *   - getAccountState() calls getPortfolioDetails with portfolioId and maps response
 *   - WebSocket start() double-start guard
 *   - markPrice event emitted on RISK channel update
 *   - fundingRate event emitted on FUNDING channel update
 *   - isStale set on close, disconnected emitted
 *   - reconnectFailed after MAX_RECONNECT_ATTEMPTS close events
 *   - stop() clears pending reconnect timer and calls ws.closeAll()
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// ── Hoisted mock helpers (must be defined before vi.mock is hoisted) ─
const { mockGetPortfolioDetails, mockCloseAll, mockSubscribe, wsInstances } = vi.hoisted(() => {
  const mockGetPortfolioDetails = vi.fn();
  const mockCloseAll = vi.fn();
  const mockSubscribe = vi.fn();
  const wsInstances: EventEmitter[] = [];
  return { mockGetPortfolioDetails, mockCloseAll, mockSubscribe, wsInstances };
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
    CBInternationalClient: class MockCBInternationalClient {
      constructor(public opts: unknown) {}
      getPortfolioDetails = mockGetPortfolioDetails;
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
  apiPassphrase: 'test-passphrase',
  portfolioId: 'portfolio-uuid-001',
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

describe('intxConfigSchema', () => {
  it('Test 1: validates successfully with enabled=false and no credentials', () => {
    const result = intxConfigSchema.safeParse({ enabled: false });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(false);
    }
  });

  it('Test 2: validates successfully with enabled=true and all four credentials', () => {
    const result = intxConfigSchema.safeParse(VALID_ENABLED_CONFIG);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(true);
      expect(result.data.apiKey).toBe('test-key');
      expect(result.data.apiPassphrase).toBe('test-passphrase');
      expect(result.data.portfolioId).toBe('portfolio-uuid-001');
    }
  });

  it('Test 3: fails when enabled=true and apiPassphrase is missing', () => {
    const result = intxConfigSchema.safeParse({
      enabled: true,
      apiKey: 'test-key',
      apiSecret: 'test-secret',
      // apiPassphrase omitted
      portfolioId: 'portfolio-uuid-001',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages.some((m) => m.includes('INTX_API_PASSPHRASE'))).toBe(true);
    }
  });

  it('Test 4: fails when enabled=true and portfolioId is missing', () => {
    const result = intxConfigSchema.safeParse({
      enabled: true,
      apiKey: 'test-key',
      apiSecret: 'test-secret',
      apiPassphrase: 'test-passphrase',
      // portfolioId omitted
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages.some((m) => m.includes('INTX_PORTFOLIO_ID'))).toBe(true);
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
      'IntxClient instantiated with INTX_ENABLED=false',
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

  it('Test 7: calls getPortfolioDetails with portfolioId and maps response to IntxAccountState', async () => {
    const mockResponse = {
      balances: [{ asset: 'USD', quantity: '10000' }],
      positions: [{ instrument: 'BTC-PERP', netSize: '0.5' }],
      summary: { initialMargin: '500', maintenanceMargin: '250' },
    };
    mockGetPortfolioDetails.mockResolvedValueOnce(mockResponse);

    const config = intxConfigSchema.parse(VALID_ENABLED_CONFIG);
    const client = new IntxClient(config);
    const state = await client.getAccountState();

    expect(mockGetPortfolioDetails).toHaveBeenCalledOnce();
    expect(mockGetPortfolioDetails).toHaveBeenCalledWith({
      portfolio: 'portfolio-uuid-001',
    });

    expect(state.balances).toEqual(mockResponse.balances);
    expect(state.positions).toEqual(mockResponse.positions);
    expect(state.summary).toEqual(mockResponse.summary);
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
    await expect(client.start()).rejects.toThrow('IntxClient already started');
    await client.stop();
  });

  it('Test 9: RISK channel update emits markPrice with correct fields and isStale=false', async () => {
    const client = makeClient();
    await client.start();

    const received: any[] = [];
    client.on('markPrice', (evt) => received.push(evt));

    const ws = lastWsInstance();
    ws.emit('update', {
      channel: 'RISK',
      product_id: 'BTC-PERP',
      mark_price: '50000.00',
      index_price: '49990.00',
    });

    expect(received).toHaveLength(1);
    expect(received[0]!.instrument).toBe('BTC-PERP');
    expect(received[0]!.markPrice).toBe('50000.00');
    expect(received[0]!.indexPrice).toBe('49990.00');
    expect(received[0]!.isStale).toBe(false);
    expect(typeof received[0]!.timestamp).toBe('number');

    await client.stop();
  });

  it('Test 10: FUNDING channel update emits fundingRate with correct fields and isStale=false', async () => {
    const client = makeClient();
    await client.start();

    const received: any[] = [];
    client.on('fundingRate', (evt) => received.push(evt));

    const ws = lastWsInstance();
    ws.emit('update', {
      channel: 'FUNDING',
      product_id: 'ETH-PERP',
      funding_rate: '0.0001',
      is_final: true,
    });

    expect(received).toHaveLength(1);
    expect(received[0]!.instrument).toBe('ETH-PERP');
    expect(received[0]!.fundingRate).toBe('0.0001');
    expect(received[0]!.isFinal).toBe(true);
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
});
