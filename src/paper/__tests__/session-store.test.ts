/**
 * Tests for SessionStore.
 *
 * Uses in-memory SQLite database for isolation.
 * Verifies CRUD operations, Decimal precision round-trip, and result assembly.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { d } from '../../core/decimal.js';
import { SessionStore } from '../session-store.js';
import type { PaperTradingConfig } from '../types.js';
import type { Trade } from '../../backtest/types.js';
import type { Signal } from '../../strategies/types.js';

// ── Test helpers ─────────────────────────────────────────────────────

function makeConfig(overrides: Partial<PaperTradingConfig> = {}): PaperTradingConfig {
  return {
    pair: 'BTC-USD',
    timeframe: '1m',
    strategyConfig: { strategy: 'test-strategy' },
    initialCapital: '10000',
    slippageBps: 5,
    feeTierMaker: 0.0035,
    feeTierTaker: 0.0075,
    assumeTaker: true,
    allowShorts: true,
    bufferSize: 500,
    pollIntervalMs: 60000,
    ...overrides,
  };
}

function makeSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    strategyName: 'test-strategy',
    pair: 'BTC-USD',
    timeframe: '1m',
    timestamp: 1700000000000,
    direction: 'long',
    confidence: 0.8,
    reasoning: 'Test signal',
    ...overrides,
  };
}

function makeTrade(overrides: Partial<{
  entryPrice: string;
  exitPrice: string;
  entryTimestamp: number;
  exitTimestamp: number;
  pnl: string;
  pnlPct: string;
  quantity: string;
  entryFee: string;
  exitFee: string;
}> = {}): Trade {
  const entrySignal = makeSignal({ direction: 'long' });
  const exitSignal = makeSignal({ direction: 'close', timestamp: 1700003600000 });

  return {
    entryFill: {
      signal: entrySignal,
      fillPrice: d(overrides.entryPrice ?? '50000.12345678'),
      fillTimestamp: overrides.entryTimestamp ?? 1700000000000,
      fee: d(overrides.entryFee ?? '3.75009259'),
      quantity: d(overrides.quantity ?? '0.01'),
      side: 'buy',
    },
    exitFill: {
      signal: exitSignal,
      fillPrice: d(overrides.exitPrice ?? '51000.98765432'),
      fillTimestamp: overrides.exitTimestamp ?? 1700003600000,
      fee: d(overrides.exitFee ?? '3.82507407'),
      quantity: d(overrides.quantity ?? '0.01'),
      side: 'sell',
    },
    pnl: d(overrides.pnl ?? '10.00419754'),
    pnlPct: d(overrides.pnlPct ?? '0.02000839508'),
    holdingPeriodMs: (overrides.exitTimestamp ?? 1700003600000) - (overrides.entryTimestamp ?? 1700000000000),
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('SessionStore', () => {
  let store: SessionStore;

  beforeEach(() => {
    // Use in-memory database for test isolation
    store = new SessionStore({ dbPath: ':memory:' });
  });

  afterEach(() => {
    store.close();
  });

  it('creates a session with running status', () => {
    const config = makeConfig();
    const session = store.createSession(config, 'test-strategy');

    expect(session.id).toBeTruthy();
    expect(session.status).toBe('running');
    expect(session.strategyName).toBe('test-strategy');
    expect(session.pair).toBe('BTC-USD');
    expect(session.timeframe).toBe('1m');
    expect(session.initialCapital).toBe('10000');
    expect(session.startTime).toBeGreaterThan(0);
    expect(session.endTime).toBeUndefined();
    expect(session.finalEquity).toBeUndefined();
  });

  it('ends session with final equity and status', () => {
    const config = makeConfig();
    const session = store.createSession(config, 'test-strategy');

    store.endSession(session.id, '10500.50', 'stopped');

    const retrieved = store.getSession(session.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.status).toBe('stopped');
    expect(retrieved!.finalEquity).toBe('10500.50');
    expect(retrieved!.endTime).toBeGreaterThan(0);
  });

  it('records and retrieves trades with Decimal precision', () => {
    const config = makeConfig();
    const session = store.createSession(config, 'test-strategy');
    const trade = makeTrade();

    store.recordTrade(session.id, trade);

    const trades = store.getSessionTrades(session.id);
    expect(trades).toHaveLength(1);

    const retrieved = trades[0];
    // Verify Decimal precision round-trip
    expect(retrieved.entryFill.fillPrice.toString()).toBe('50000.12345678');
    expect(retrieved.entryFill.fee.toString()).toBe('3.75009259');
    expect(retrieved.entryFill.quantity.toString()).toBe('0.01');
    expect(retrieved.exitFill.fillPrice.toString()).toBe('51000.98765432');
    expect(retrieved.exitFill.fee.toString()).toBe('3.82507407');
    expect(retrieved.pnl.toString()).toBe('10.00419754');
    expect(retrieved.pnlPct.toString()).toBe('0.02000839508');

    // Verify other fields
    expect(retrieved.entryFill.side).toBe('buy');
    expect(retrieved.exitFill.side).toBe('sell');
    expect(retrieved.entryFill.fillTimestamp).toBe(1700000000000);
    expect(retrieved.exitFill.fillTimestamp).toBe(1700003600000);
    expect(retrieved.holdingPeriodMs).toBe(3600000);

    // Verify signal round-trip
    expect(retrieved.entryFill.signal.direction).toBe('long');
    expect(retrieved.entryFill.signal.confidence).toBe(0.8);
    expect(retrieved.exitFill.signal.direction).toBe('close');
  });

  it('records and retrieves equity points in order', () => {
    const config = makeConfig();
    const session = store.createSession(config, 'test-strategy');

    // Insert out of order
    store.recordEquityPoint(session.id, 1700002000000, d('10200'));
    store.recordEquityPoint(session.id, 1700000000000, d('10000'));
    store.recordEquityPoint(session.id, 1700001000000, d('10100'));

    const equity = store.getSessionEquity(session.id);
    expect(equity).toHaveLength(3);

    // Should be sorted ascending by timestamp
    expect(equity[0].timestamp).toBe(1700000000000);
    expect(equity[1].timestamp).toBe(1700001000000);
    expect(equity[2].timestamp).toBe(1700002000000);

    // Verify Decimal precision
    expect(equity[0].equity.toString()).toBe('10000');
    expect(equity[1].equity.toString()).toBe('10100');
    expect(equity[2].equity.toString()).toBe('10200');
  });

  it('getResult assembles complete PaperTradingResult', () => {
    const config = makeConfig();
    const session = store.createSession(config, 'test-strategy');

    // Add trades
    const trade1 = makeTrade({ entryFee: '3.00', exitFee: '3.50' });
    const trade2 = makeTrade({
      entryPrice: '51000',
      exitPrice: '52000',
      entryFee: '4.00',
      exitFee: '4.50',
      entryTimestamp: 1700010000000,
      exitTimestamp: 1700013600000,
    });
    store.recordTrade(session.id, trade1);
    store.recordTrade(session.id, trade2);

    // Add equity points
    store.recordEquityPoint(session.id, 1700000000000, d('10000'));
    store.recordEquityPoint(session.id, 1700010000000, d('10100'));
    store.recordEquityPoint(session.id, 1700013600000, d('10200'));

    // End session
    store.endSession(session.id, '10200', 'stopped');

    const result = store.getResult(session.id);
    expect(result).not.toBeNull();
    expect(result!.session.status).toBe('stopped');
    expect(result!.trades).toHaveLength(2);
    expect(result!.equityCurve).toHaveLength(3);
    expect(result!.finalEquity.toString()).toBe('10200');

    // Total fees = (3.00 + 3.50) + (4.00 + 4.50) = 15.00
    expect(result!.totalFees.toString()).toBe('15');
  });

  it('listSessions filters by status', () => {
    const config = makeConfig();
    store.createSession(config, 'strategy-a');
    const session2 = store.createSession(config, 'strategy-b');
    store.endSession(session2.id, '10500', 'stopped');

    const allSessions = store.listSessions();
    expect(allSessions).toHaveLength(2);

    const runningSessions = store.listSessions('running');
    expect(runningSessions).toHaveLength(1);
    expect(runningSessions[0].strategyName).toBe('strategy-a');

    const stoppedSessions = store.listSessions('stopped');
    expect(stoppedSessions).toHaveLength(1);
    expect(stoppedSessions[0].strategyName).toBe('strategy-b');
  });

  it('getSession returns null for unknown ID', () => {
    const result = store.getSession('nonexistent-id');
    expect(result).toBeNull();
  });

  it('getResult returns null for unknown session', () => {
    const result = store.getResult('nonexistent-id');
    expect(result).toBeNull();
  });

  describe('getLastFinalEquity', () => {
    it('returns null when no prior sessions exist', () => {
      const result = store.getLastFinalEquity('BTC-USD');
      expect(result).toBeNull();
    });

    it('returns null when prior sessions have no final equity', () => {
      const config = makeConfig({ pair: 'BTC-USD' });
      store.createSession(config, 'test-strategy');
      // Session still running — no final equity
      expect(store.getLastFinalEquity('BTC-USD')).toBeNull();
    });

    it('returns final equity from the most recent stopped session', () => {
      const config = makeConfig({ pair: 'BTC-USD' });

      const s1 = store.createSession(config, 'strat-a');
      store.endSession(s1.id, '10500.25', 'stopped');

      const s2 = store.createSession(config, 'strat-b');
      store.endSession(s2.id, '10800.75', 'stopped');

      expect(store.getLastFinalEquity('BTC-USD')).toBe('10800.75');
    });

    it('ignores sessions with error status', () => {
      const config = makeConfig({ pair: 'BTC-USD' });

      const s1 = store.createSession(config, 'strat-a');
      store.endSession(s1.id, '9500', 'stopped');

      const s2 = store.createSession(config, 'strat-b');
      store.endSession(s2.id, '0', 'error');

      // Should return s1's equity, not s2's
      expect(store.getLastFinalEquity('BTC-USD')).toBe('9500');
    });

    it('filters by pair', () => {
      const btcConfig = makeConfig({ pair: 'BTC-USD' });
      const ethConfig = makeConfig({ pair: 'ETH-USD' });

      const s1 = store.createSession(btcConfig, 'strat-a');
      store.endSession(s1.id, '10500', 'stopped');

      const s2 = store.createSession(ethConfig, 'strat-b');
      store.endSession(s2.id, '5000', 'stopped');

      expect(store.getLastFinalEquity('BTC-USD')).toBe('10500');
      expect(store.getLastFinalEquity('ETH-USD')).toBe('5000');
      expect(store.getLastFinalEquity('SOL-USD' as any)).toBeNull();
    });
  });
});
