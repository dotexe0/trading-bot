/**
 * Tests for PerpStateStore.recordTrade() and listClosedTrades().
 *
 * RED phase: these tests must FAIL before the perpTrades table is created.
 * GREEN phase: all tests pass after implementing the schema and store methods.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { PerpStateStore, type PerpTradeRecord } from '../perp-state-store.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeStore(): PerpStateStore {
  return new PerpStateStore({ dbPath: ':memory:' });
}

function makeTradeRecord(overrides: Partial<PerpTradeRecord> = {}): PerpTradeRecord {
  return {
    sessionId: 'session-001',
    instrument: 'BIP-20DEC30-CDE',
    direction: 'long',
    leverage: 5,
    entryPrice: '50000.00000000',
    exitPrice: '51000.00000000',
    size: '0.01000000',
    cumulativeFundingCost: '0.00000000',
    realizedPnl: '10.00000000',
    openedAt: 1_700_000_000_000,
    closedAt: 1_700_001_000_000,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PerpStateStore – recordTrade / listClosedTrades', () => {
  let store: PerpStateStore;

  beforeEach(() => {
    store = makeStore();
  });

  it('round-trip: insert one record and listClosedTrades returns it with all fields intact', () => {
    const record = makeTradeRecord();
    store.recordTrade(record);

    const results = store.listClosedTrades();

    expect(results).toHaveLength(1);
    const row = results[0];
    expect(row.sessionId).toBe(record.sessionId);
    expect(row.instrument).toBe(record.instrument);
    expect(row.direction).toBe(record.direction);
    expect(row.leverage).toBe(record.leverage);
    expect(row.entryPrice).toBe(record.entryPrice);
    expect(row.exitPrice).toBe(record.exitPrice);
    expect(row.size).toBe(record.size);
    expect(row.cumulativeFundingCost).toBe(record.cumulativeFundingCost);
    expect(row.realizedPnl).toBe(record.realizedPnl);
    expect(row.openedAt).toBe(record.openedAt);
    expect(row.closedAt).toBe(record.closedAt);
  });

  it('cumulativeFundingCost undefined → stored and returned as "0.00000000"', () => {
    const record = makeTradeRecord({ cumulativeFundingCost: '0.00000000' });
    store.recordTrade(record);

    const results = store.listClosedTrades();
    expect(results[0].cumulativeFundingCost).toBe('0.00000000');
  });

  it('two records: listClosedTrades returns both', () => {
    const record1 = makeTradeRecord({ sessionId: 'session-001' });
    const record2 = makeTradeRecord({
      sessionId: 'session-002',
      direction: 'short',
      realizedPnl: '-5.00000000',
    });

    store.recordTrade(record1);
    store.recordTrade(record2);

    const results = store.listClosedTrades();
    expect(results).toHaveLength(2);
    const sessionIds = results.map((r) => r.sessionId);
    expect(sessionIds).toContain('session-001');
    expect(sessionIds).toContain('session-002');
  });

  it('closeReason is preserved when set', () => {
    const record = makeTradeRecord({ closeReason: 'STOP_LOSS' });
    store.recordTrade(record);

    const results = store.listClosedTrades();
    expect(results[0].closeReason).toBe('STOP_LOSS');
  });

  it('closeReason is undefined when not set', () => {
    const record = makeTradeRecord();
    // no closeReason field in makeTradeRecord default
    store.recordTrade(record);

    const results = store.listClosedTrades();
    expect(results[0].closeReason).toBeUndefined();
  });

  it('listClosedTrades returns empty array when no trades recorded', () => {
    const results = store.listClosedTrades();
    expect(results).toHaveLength(0);
  });
});

// ── Integration: closePosition() call site ────────────────────────────────────

describe('PerpPositionManager – recordTrade() call site on closePosition()', () => {
  it('after live close, a row exists in stateStore.listClosedTrades()', async () => {
    const { PerpPositionManager } = await import('../position-manager.js');
    const { createIntxClient } = await import('../intx-client.js');

    const store = makeStore();

    // Minimal mock IntxClient
    const mockPlace = async () => ({
      orderId: 'oid-001',
      clientOrderId: 'coid-001',
      avgPrice: '51000.00000000',
      fee: '0.01000000',
      status: 'FILLED' as const,
    });

    // Build a minimal IntxConfig
    const config = {
      enabled: true,
      apiKey: 'k',
      apiSecret: 's',
      defaultMaintenanceMarginRate: '0.03330000',
      liquidationSafetyThresholdPct: '5',
      maxPositionSizeUsd: '10000',
      fundingDrainThresholdPct: '0.5',
    };

    // Build a minimal IntxClient mock
    const fakeClient = {
      placeOrder: mockPlace,
      cancelOrder: async () => {},
      getAccountState: async () => ({ balances: {}, positions: [], summary: {} }),
      on: () => {},
      off: () => {},
      emit: () => false,
    };

    const manager = new PerpPositionManager({
      intxClient: fakeClient as never,
      stateStore: store,
      config: config as never,
    });

    // Open a position
    await manager.openPosition({
      instrument: 'BIP-20DEC30-CDE',
      direction: 'long',
      size: '0.01',
      leverage: 5,
      entryPrice: '50000.00000000',
    });

    // Close the position
    await manager.closePosition('manual');

    // Verify trade record written
    const trades = store.listClosedTrades();
    expect(trades).toHaveLength(1);
    expect(trades[0].instrument).toBe('BIP-20DEC30-CDE');
    expect(trades[0].direction).toBe('long');
    expect(trades[0].exitPrice).toBe('51000.00000000');
  });
});

// ── Integration: closePaperPosition() call site ───────────────────────────────

describe('PaperPerpEngine – recordTrade() call site on closePaperPosition()', () => {
  it('after paper close, a row exists in stateStore.listClosedTrades()', async () => {
    const { PaperPerpEngine } = await import('../paper-perp-engine.js');

    const store = makeStore();

    const config = {
      enabled: true,
      apiKey: 'k',
      apiSecret: 's',
      defaultMaintenanceMarginRate: '0.03330000',
      liquidationSafetyThresholdPct: '5',
      maxPositionSizeUsd: '10000',
      fundingDrainThresholdPct: '0.5',
    };

    const fakeClient = {
      on: () => {},
      off: () => {},
      emit: () => false,
    };

    const engine = new PaperPerpEngine({
      intxClient: fakeClient as never,
      stateStore: store,
      config: config as never,
    });

    // Open a paper position
    await engine.openPaperPosition('BIP-20DEC30-CDE', 'long', '0.01', 5, '50000.00000000');

    // Close at a higher price
    engine.closePaperPosition('51000.00000000', 'manual');

    // Verify trade record written
    const trades = store.listClosedTrades();
    expect(trades).toHaveLength(1);
    expect(trades[0].instrument).toBe('BIP-20DEC30-CDE');
    expect(trades[0].direction).toBe('long');
    expect(trades[0].exitPrice).toBe('51000.00000000');
    expect(trades[0].realizedPnl).toBe('10.00000000'); // (51000 - 50000) * 0.01 = 10
  });
});
