/**
 * Tests for LiveStateStore -- SQLite persistence for live trading.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { LiveStateStore } from '../state-store.js';
import type { LiveTradingConfig, LiveOrder, LiveTrade } from '../types.js';

function makeTempDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-store-'));
  return path.join(dir, 'test.db');
}

function makeConfig(overrides: Partial<LiveTradingConfig> = {}): LiveTradingConfig {
  return {
    pair: 'BTC-USD',
    timeframe: '1h',
    strategyConfig: { strategy: 'test' },
    initialCapital: '10000',
    allowShorts: false,
    slippageBps: 5,
    feeTierMaker: 0.004,
    feeTierTaker: 0.006,
    assumeTaker: true,
    bufferSize: 500,
    reconciliationIntervalMs: 60000,
    maxOrderRetries: 3,
    shutdownTimeoutMs: 30000,
    enableStopLossOnShutdown: true,
    pollIntervalMs: 60000,
    ...overrides,
  } as LiveTradingConfig;
}

function makeOrder(sessionId: string, overrides: Partial<LiveOrder> = {}): LiveOrder {
  const now = Date.now();
  return {
    orderId: `exchange-${Math.random().toString(36).slice(2, 8)}`,
    clientOrderId: `client-${Math.random().toString(36).slice(2, 8)}`,
    sessionId,
    productId: 'BTC-USD',
    side: 'BUY',
    orderType: 'MARKET',
    status: 'PENDING',
    baseSize: '0.01',
    filledSize: '0',
    filledValue: '0',
    totalFees: '0',
    createdAt: now,
    updatedAt: now,
    purpose: 'ENTRY',
    ...overrides,
  };
}

describe('LiveStateStore', () => {
  let store: LiveStateStore;
  let dbPath: string;

  beforeEach(() => {
    dbPath = makeTempDb();
    store = new LiveStateStore({ dbPath });
  });

  afterEach(() => {
    store.close();
    try {
      fs.unlinkSync(dbPath);
      fs.unlinkSync(dbPath + '-wal');
      fs.unlinkSync(dbPath + '-shm');
    } catch {
      // ignore cleanup errors
    }
  });

  it('creates and retrieves a session', () => {
    const config = makeConfig();
    const session = store.createSession(config, 'testStrategy');

    expect(session.id).toBeTruthy();
    expect(session.strategyName).toBe('testStrategy');
    expect(session.pair).toBe('BTC-USD');
    expect(session.status).toBe('running');
    expect(session.mode).toBe('live');

    const retrieved = store.getSession(session.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(session.id);
    expect(retrieved!.config.pair).toBe('BTC-USD');
  });

  it('ends a session with status and finalEquity', () => {
    const config = makeConfig();
    const session = store.createSession(config, 'testStrategy');

    store.endSession(session.id, '10500.25', 'stopped');

    const retrieved = store.getSession(session.id);
    expect(retrieved!.status).toBe('stopped');
    expect(retrieved!.finalEquity).toBe('10500.25');
    expect(retrieved!.endTime).toBeGreaterThan(0);
  });

  it('persists and retrieves an order', () => {
    const session = store.createSession(makeConfig(), 'strat');
    const order = makeOrder(session.id, {
      orderId: 'EX-001',
      clientOrderId: 'CL-001',
    });

    store.persistOrder(order);

    const retrieved = store.getOrder('EX-001');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.orderId).toBe('EX-001');
    expect(retrieved!.clientOrderId).toBe('CL-001');
    expect(retrieved!.side).toBe('BUY');
    expect(retrieved!.status).toBe('PENDING');
  });

  it('updates order status with partial update', () => {
    const session = store.createSession(makeConfig(), 'strat');
    const order = makeOrder(session.id, { orderId: 'EX-002' });
    store.persistOrder(order);

    store.updateOrderStatus('EX-002', {
      status: 'FILLED',
      filledSize: '0.01',
      filledValue: '500.00',
      averageFillPrice: '50000.00',
      totalFees: '3.00',
    });

    const updated = store.getOrder('EX-002');
    expect(updated!.status).toBe('FILLED');
    expect(updated!.filledSize).toBe('0.01');
    expect(updated!.filledValue).toBe('500.00');
    expect(updated!.averageFillPrice).toBe('50000.00');
    expect(updated!.totalFees).toBe('3.00');
  });

  it('filters open orders correctly', () => {
    const session = store.createSession(makeConfig(), 'strat');

    store.persistOrder(makeOrder(session.id, { orderId: 'O1', status: 'PENDING' }));
    store.persistOrder(makeOrder(session.id, { orderId: 'O2', status: 'OPEN' }));
    store.persistOrder(makeOrder(session.id, { orderId: 'O3', status: 'FILLED' }));
    store.persistOrder(makeOrder(session.id, { orderId: 'O4', status: 'CANCELLED' }));

    const open = store.getOpenOrders(session.id);
    expect(open).toHaveLength(2);
    expect(open.map((o) => o.orderId).sort()).toEqual(['O1', 'O2']);
  });

  it('gets order by clientOrderId', () => {
    const session = store.createSession(makeConfig(), 'strat');
    store.persistOrder(makeOrder(session.id, {
      orderId: 'EX-100',
      clientOrderId: 'MY-UUID-123',
    }));

    const found = store.getOrderByClientId('MY-UUID-123');
    expect(found).not.toBeNull();
    expect(found!.orderId).toBe('EX-100');
  });

  it('records and retrieves trades', () => {
    const session = store.createSession(makeConfig(), 'strat');
    const trade: LiveTrade = {
      sessionId: session.id,
      entryOrderId: 'EX-E1',
      exitOrderId: 'EX-X1',
      entryTimestamp: 1000000,
      entryPrice: '50000',
      entryFee: '3.00',
      entrySide: 'BUY',
      entryQuantity: '0.01',
      exitTimestamp: 2000000,
      exitPrice: '51000',
      exitFee: '3.06',
      exitSide: 'SELL',
      exitQuantity: '0.01',
      pnl: '3.94',
      pnlPct: '0.79',
      holdingPeriodMs: 1000000,
    };

    store.recordTrade(session.id, trade);
    const trades = store.getSessionTrades(session.id);

    expect(trades).toHaveLength(1);
    expect(trades[0].entryOrderId).toBe('EX-E1');
    expect(trades[0].exitPrice).toBe('51000');
    expect(trades[0].pnl).toBe('3.94');
  });

  describe('slippage fields', () => {
    it('round-trips all 4 slippage fields through recordTrade and getSessionTrades', () => {
      const session = store.createSession(makeConfig(), 'strat');
      const trade: LiveTrade = {
        sessionId: session.id,
        entryOrderId: 'EX-SLIP-E1',
        exitOrderId: 'EX-SLIP-X1',
        entryTimestamp: 1000000,
        entryPrice: '50000',
        entryFee: '3.00',
        entrySide: 'BUY',
        entryQuantity: '0.01',
        exitTimestamp: 2000000,
        exitPrice: '50100',
        exitFee: '3.01',
        exitSide: 'SELL',
        exitQuantity: '0.01',
        pnl: '3.99',
        pnlPct: '0.80',
        holdingPeriodMs: 1000000,
        signalPrice: '50000',
        exitSignalPrice: '50100',
        entrySlippageBps: '5.00',
        exitSlippageBps: '-2.00',
      };

      store.recordTrade(session.id, trade);
      const trades = store.getSessionTrades(session.id);

      expect(trades).toHaveLength(1);
      expect(trades[0].signalPrice).toBe('50000');
      expect(trades[0].exitSignalPrice).toBe('50100');
      expect(trades[0].entrySlippageBps).toBe('5.00');
      expect(trades[0].exitSlippageBps).toBe('-2.00');
    });

    it('returns undefined for old trades with null slippage fields', () => {
      const session = store.createSession(makeConfig(), 'strat');
      const trade: LiveTrade = {
        sessionId: session.id,
        entryOrderId: 'EX-OLD-E1',
        exitOrderId: 'EX-OLD-X1',
        entryTimestamp: 1000000,
        entryPrice: '50000',
        entryFee: '3.00',
        entrySide: 'BUY',
        entryQuantity: '0.01',
        exitTimestamp: 2000000,
        exitPrice: '51000',
        exitFee: '3.06',
        exitSide: 'SELL',
        exitQuantity: '0.01',
        pnl: '3.94',
        pnlPct: '0.79',
        holdingPeriodMs: 1000000,
        // No slippage fields -- simulating old trade
      };

      store.recordTrade(session.id, trade);
      const trades = store.getSessionTrades(session.id);

      expect(trades).toHaveLength(1);
      expect(trades[0].signalPrice).toBeUndefined();
      expect(trades[0].exitSignalPrice).toBeUndefined();
      expect(trades[0].entrySlippageBps).toBeUndefined();
      expect(trades[0].exitSlippageBps).toBeUndefined();
    });
  });

  it('records and retrieves equity points', () => {
    const session = store.createSession(makeConfig(), 'strat');

    store.recordEquityPoint(session.id, 1000, '10000');
    store.recordEquityPoint(session.id, 2000, '10100');
    store.recordEquityPoint(session.id, 3000, '10050');

    const equity = store.getSessionEquity(session.id);
    expect(equity).toHaveLength(3);
    expect(equity[0].timestamp).toBe(1000);
    expect(equity[0].equity.toString()).toBe('10000');
    expect(equity[1].equity.toString()).toBe('10100');
    expect(equity[2].equity.toString()).toBe('10050');
  });
});
