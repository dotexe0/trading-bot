/**
 * Tests for IPerpOrderExecutor implementations.
 *
 * PaperPerpOrderExecutor: verifies instant fills at mark price, zero fees.
 * LivePerpOrderExecutor: verifies order persistence before API call, fill propagation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PaperPerpOrderExecutor, LivePerpOrderExecutor } from '../order-executor.js';
import type { PerpSession } from '../types.js';

// ── Helpers ──────────────────────────────────────────────────────────

function makeSession(overrides?: Partial<PerpSession>): PerpSession {
  return {
    id: 'sess-1',
    instrument: 'BTC-PERP',
    direction: 'long',
    entryPrice: '50000',
    size: '0.1',
    leverage: 5,
    liquidationPrice: '40000',
    maintenanceMarginRate: '0.0333',
    status: 'open',
    openedAt: Date.now(),
    ...overrides,
  };
}

// ── Paper executor ───────────────────────────────────────────────────

describe('PaperPerpOrderExecutor', () => {
  let executor: PaperPerpOrderExecutor;

  beforeEach(() => {
    executor = new PaperPerpOrderExecutor();
  });

  it('openPosition returns fill at mark price with zero fee', async () => {
    const result = await executor.openPosition({
      instrument: 'BTC-PERP',
      direction: 'long',
      size: '0.1',
      leverage: 5,
      entryPrice: '50000',
    });

    expect(result.fillPrice).toBe('50000');
    expect(result.fee).toBe('0');
    expect(result.exchangeOrderId).toBeUndefined();
  });

  it('closePosition returns fill at mark price with zero fee', async () => {
    const session = makeSession();
    const result = await executor.closePosition({
      session,
      markPrice: '51000',
      reason: 'strategy-signal',
    });

    expect(result.fillPrice).toBe('51000');
    expect(result.fee).toBe('0');
    expect(result.exchangeOrderId).toBeUndefined();
  });

  it('has no cleanupOrders method', () => {
    expect((executor as any).cleanupOrders).toBeUndefined();
  });
});

// ── Live executor ────────────────────────────────────────────────────

describe('LivePerpOrderExecutor', () => {
  let executor: LivePerpOrderExecutor;
  let mockIntxClient: any;
  let mockStateStore: any;
  let mockOrderEngine: any;

  beforeEach(() => {
    mockIntxClient = {
      placeOrder: vi.fn().mockResolvedValue({
        orderId: 'ex-123',
        status: 'FILLED',
        execQty: '0.1',
        avgPrice: '50050',
        fee: '0.50',
      }),
      getAccountState: vi.fn().mockResolvedValue({
        positions: [],
        balances: {},
        summary: {},
      }),
    };

    mockStateStore = {
      persistOrder: vi.fn(),
    };

    mockOrderEngine = {
      closeAndCleanup: vi.fn().mockResolvedValue(undefined),
    };

    executor = new LivePerpOrderExecutor({
      intxClient: mockIntxClient,
      stateStore: mockStateStore,
      orderEngine: mockOrderEngine,
    });
  });

  it('openPosition persists order BEFORE API call', async () => {
    const callOrder: string[] = [];
    mockStateStore.persistOrder.mockImplementation(() => callOrder.push('persist'));
    mockIntxClient.placeOrder.mockImplementation(async () => {
      callOrder.push('placeOrder');
      return { orderId: 'ex-1', status: 'FILLED', execQty: '0.1', avgPrice: '50000', fee: '0.5' };
    });

    await executor.openPosition({
      instrument: 'BTC-PERP',
      direction: 'long',
      size: '0.1',
      leverage: 5,
      entryPrice: '50000',
      botSessionId: 'bot-sess-1',
    });

    expect(callOrder[0]).toBe('persist');
    expect(callOrder[1]).toBe('placeOrder');
  });

  it('openPosition returns exchange fill data', async () => {
    const result = await executor.openPosition({
      instrument: 'BTC-PERP',
      direction: 'long',
      size: '0.1',
      leverage: 5,
      entryPrice: '50000',
    });

    expect(result.fillPrice).toBe('50050');
    expect(result.fee).toBe('0.50');
    expect(result.exchangeOrderId).toBe('ex-123');
  });

  it('openPosition creates BUY order for long, SELL for short', async () => {
    await executor.openPosition({
      instrument: 'BTC-PERP',
      direction: 'long',
      size: '0.1',
      leverage: 5,
      entryPrice: '50000',
    });
    expect(mockIntxClient.placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({ side: 'BUY' }),
    );

    mockIntxClient.placeOrder.mockClear();
    await executor.openPosition({
      instrument: 'BTC-PERP',
      direction: 'short',
      size: '0.1',
      leverage: 5,
      entryPrice: '50000',
    });
    expect(mockIntxClient.placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({ side: 'SELL' }),
    );
  });

  it('closePosition persists order BEFORE API call and uses closeOnly', async () => {
    const callOrder: string[] = [];
    mockStateStore.persistOrder.mockImplementation(() => callOrder.push('persist'));
    mockIntxClient.placeOrder.mockImplementation(async () => {
      callOrder.push('placeOrder');
      return { orderId: 'ex-close', status: 'FILLED', execQty: '0.1', avgPrice: '51000', fee: '0.25' };
    });

    const session = makeSession();
    const result = await executor.closePosition({ session, markPrice: '51000', reason: 'manual' });

    expect(callOrder[0]).toBe('persist');
    expect(callOrder[1]).toBe('placeOrder');
    expect(result.fillPrice).toBe('51000');
    expect(result.fee).toBe('0.25');
    expect(mockIntxClient.placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({ closeOnly: true, side: 'SELL' }),
    );
  });

  it('closePosition uses BUY side for short positions', async () => {
    const session = makeSession({ direction: 'short' });
    await executor.closePosition({ session, markPrice: '49000' });
    expect(mockIntxClient.placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({ side: 'BUY' }),
    );
  });

  it('closePosition sets EMERGENCY_CLOSE purpose when reason matches', async () => {
    const session = makeSession();
    await executor.closePosition({ session, markPrice: '51000', reason: 'EMERGENCY_CLOSE' });

    // Check the persisted order had purpose EMERGENCY_CLOSE
    const persistedOrder = mockStateStore.persistOrder.mock.calls[0][0];
    expect(persistedOrder.purpose).toBe('EMERGENCY_CLOSE');
  });

  it('cleanupOrders delegates to orderEngine', async () => {
    await executor.cleanupOrders!('sess-1');
    expect(mockOrderEngine.closeAndCleanup).toHaveBeenCalledWith('sess-1');
  });

  it('cleanupOrders is a no-op when no orderEngine provided', async () => {
    const execNoEngine = new LivePerpOrderExecutor({
      intxClient: mockIntxClient,
      stateStore: mockStateStore,
    });
    // Should not throw
    await execNoEngine.cleanupOrders!('sess-1');
  });

  it('openPosition propagates API errors', async () => {
    mockIntxClient.placeOrder.mockRejectedValue(new Error('Network timeout'));

    await expect(
      executor.openPosition({
        instrument: 'BTC-PERP',
        direction: 'long',
        size: '0.1',
        leverage: 5,
        entryPrice: '50000',
      }),
    ).rejects.toThrow('Network timeout');

    // Order should still have been persisted before the failure
    expect(mockStateStore.persistOrder).toHaveBeenCalledTimes(1);
  });

  // ── Silent-fill detection (Finding 8) ──────────────────────────────

  it('openPosition: detects silent fill when placeOrder throws but exchange has matching position', async () => {
    mockIntxClient.placeOrder.mockRejectedValue(new Error('ECONNRESET'));
    mockIntxClient.getAccountState.mockResolvedValue({
      positions: [
        {
          product_id: 'BTC-PERP',
          side: 'LONG',
          number_of_contracts: '0.1',
          avg_entry_price: '50050',
        },
      ],
      balances: {},
      summary: {},
    });

    const result = await executor.openPosition({
      instrument: 'BTC-PERP',
      direction: 'long',
      size: '0.1',
      leverage: 5,
      entryPrice: '50000',
    });

    // Silent fill: use exchange entry price, fee unknown → '0'
    expect(result.fillPrice).toBe('50050');
    expect(result.fee).toBe('0');
    expect(mockIntxClient.getAccountState).toHaveBeenCalled();
  });

  it('openPosition: re-throws original error when placeOrder throws and exchange has no matching position', async () => {
    mockIntxClient.placeOrder.mockRejectedValue(new Error('Network timeout'));
    mockIntxClient.getAccountState.mockResolvedValue({
      positions: [],
      balances: {},
      summary: {},
    });

    await expect(
      executor.openPosition({
        instrument: 'BTC-PERP',
        direction: 'long',
        size: '0.1',
        leverage: 5,
        entryPrice: '50000',
      }),
    ).rejects.toThrow('Network timeout');
  });

  it('openPosition: re-throws when exchange has position with wrong side', async () => {
    mockIntxClient.placeOrder.mockRejectedValue(new Error('Network timeout'));
    mockIntxClient.getAccountState.mockResolvedValue({
      positions: [
        {
          product_id: 'BTC-PERP',
          side: 'SHORT', // wrong direction — not our fill
          number_of_contracts: '0.1',
          avg_entry_price: '50000',
        },
      ],
      balances: {},
      summary: {},
    });

    await expect(
      executor.openPosition({
        instrument: 'BTC-PERP',
        direction: 'long',
        size: '0.1',
        leverage: 5,
        entryPrice: '50000',
      }),
    ).rejects.toThrow('Network timeout');
  });

  it('openPosition: re-throws when exchange has position with wrong instrument', async () => {
    mockIntxClient.placeOrder.mockRejectedValue(new Error('Network timeout'));
    mockIntxClient.getAccountState.mockResolvedValue({
      positions: [
        {
          product_id: 'ETH-PERP', // different instrument
          side: 'LONG',
          number_of_contracts: '0.5',
          avg_entry_price: '3000',
        },
      ],
      balances: {},
      summary: {},
    });

    await expect(
      executor.openPosition({
        instrument: 'BTC-PERP',
        direction: 'long',
        size: '0.1',
        leverage: 5,
        entryPrice: '50000',
      }),
    ).rejects.toThrow('Network timeout');
  });

  it('openPosition: re-throws original error when getAccountState also fails', async () => {
    mockIntxClient.placeOrder.mockRejectedValue(new Error('Network timeout'));
    mockIntxClient.getAccountState.mockRejectedValue(new Error('Exchange offline'));

    await expect(
      executor.openPosition({
        instrument: 'BTC-PERP',
        direction: 'long',
        size: '0.1',
        leverage: 5,
        entryPrice: '50000',
      }),
    ).rejects.toThrow('Network timeout'); // original error preserved, not Exchange offline
  });

  // ── Silent-close detection (CP-3) ──────────────────────────────────

  it('closePosition: detects silent close when placeOrder throws but exchange shows no position', async () => {
    mockIntxClient.placeOrder.mockRejectedValue(new Error('ECONNRESET'));
    // Exchange shows no position → silent close succeeded
    mockIntxClient.getAccountState.mockResolvedValue({
      positions: [],
      balances: {},
      summary: {},
    });

    const session = makeSession();
    const result = await executor.closePosition({ session, markPrice: '51000', reason: 'manual' });

    // Treated as closed — use requested markPrice as exit price (best effort), fee unknown
    expect(result.fillPrice).toBe('51000');
    expect(result.fee).toBe('0');
    expect(mockIntxClient.getAccountState).toHaveBeenCalled();
  });

  it('closePosition: detects silent close when exchange shows zero-contract position', async () => {
    mockIntxClient.placeOrder.mockRejectedValue(new Error('Network timeout'));
    mockIntxClient.getAccountState.mockResolvedValue({
      positions: [
        {
          product_id: 'BTC-PERP',
          side: 'LONG',
          number_of_contracts: '0', // exchange already flat
          avg_entry_price: '50000',
        },
      ],
      balances: {}, summary: {},
    });

    const session = makeSession();
    const result = await executor.closePosition({ session, markPrice: '51000' });

    expect(result.fillPrice).toBe('51000');
  });

  it('closePosition: re-throws original error when placeOrder throws and position still on exchange', async () => {
    mockIntxClient.placeOrder.mockRejectedValue(new Error('Network timeout'));
    mockIntxClient.getAccountState.mockResolvedValue({
      positions: [
        {
          product_id: 'BTC-PERP',
          side: 'LONG',
          number_of_contracts: '0.1', // still open — close genuinely failed
          avg_entry_price: '50000',
        },
      ],
      balances: {}, summary: {},
    });

    const session = makeSession();
    await expect(
      executor.closePosition({ session, markPrice: '51000' }),
    ).rejects.toThrow('Network timeout');
  });

  it('closePosition: re-throws original error when getAccountState also fails', async () => {
    mockIntxClient.placeOrder.mockRejectedValue(new Error('Network timeout'));
    mockIntxClient.getAccountState.mockRejectedValue(new Error('Exchange offline'));

    const session = makeSession();
    await expect(
      executor.closePosition({ session, markPrice: '51000' }),
    ).rejects.toThrow('Network timeout');
  });

  it('openPosition: treats zero-contract position as no match (not silent fill)', async () => {
    mockIntxClient.placeOrder.mockRejectedValue(new Error('Network timeout'));
    mockIntxClient.getAccountState.mockResolvedValue({
      positions: [
        {
          product_id: 'BTC-PERP',
          side: 'LONG',
          number_of_contracts: '0', // closed position record
          avg_entry_price: '50000',
        },
      ],
      balances: {},
      summary: {},
    });

    await expect(
      executor.openPosition({
        instrument: 'BTC-PERP',
        direction: 'long',
        size: '0.1',
        leverage: 5,
        entryPrice: '50000',
      }),
    ).rejects.toThrow('Network timeout');
  });
});
