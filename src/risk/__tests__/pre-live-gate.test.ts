/**
 * Unit tests for PreLiveGate -- pre-live activation safety gate.
 *
 * Tests cover all pass/fail scenarios for the gate check that prevents
 * live trading without demonstrated paper profitability.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PreLiveGate } from '../pre-live-gate.js';
import { d, ZERO } from '../../core/decimal.js';
import type { Trade, SimulatedFill } from '../../backtest/types.js';
import type { PerpTradeRecord } from '../../perp/perp-state-store.js';

// ── Mock logger ──────────────────────────────────────────────────────────
vi.mock('../../core/logger.js', () => ({
  createModuleLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

// ── Helpers ──────────────────────────────────────────────────────────────

function makeFill(price: string, timestamp: number, side: 'buy' | 'sell' = 'buy'): SimulatedFill {
  return {
    signal: { direction: 'long', confidence: 1, strategyName: 'test' } as any,
    fillPrice: d(price),
    fillTimestamp: timestamp,
    fee: d('0.50'),
    quantity: d('0.01'),
    side,
  };
}

function makeSpotTrade(pnl: string, entryTimestamp: number): Trade {
  return {
    entryFill: makeFill('50000', entryTimestamp),
    exitFill: makeFill('51000', entryTimestamp + 3600000, 'sell'),
    pnl: d(pnl),
    pnlPct: d('0.02'),
    holdingPeriodMs: 3600000,
  };
}

function makePerpTrade(realizedPnl: string, closedAt: number): PerpTradeRecord {
  return {
    sessionId: 'perp-session-1',
    instrument: 'BTC-PERP',
    direction: 'long',
    leverage: 5,
    entryPrice: '50000',
    exitPrice: '51000',
    size: '0.01',
    cumulativeFundingCost: '0.00000000',
    realizedPnl,
    openedAt: closedAt - 3600000,
    closedAt,
  };
}

// ── Mock stores ──────────────────────────────────────────────────────────

function createMockSessionStore(trades: Trade[][] = []) {
  const sessions = trades.map((_, i) => ({ id: `session-${i}` }));
  return {
    listSessions: vi.fn().mockReturnValue(sessions),
    getSessionTrades: vi.fn().mockImplementation((sessionId: string) => {
      const idx = sessions.findIndex((s) => s.id === sessionId);
      return idx >= 0 ? trades[idx] : [];
    }),
  } as any;
}

function createMockPerpStateStore(trades: PerpTradeRecord[] = []) {
  return {
    listClosedTrades: vi.fn().mockReturnValue(trades),
  } as any;
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('PreLiveGate', () => {
  describe('spot mode', () => {
    it('passes with sufficient spot trades and positive P&L', () => {
      // 25 trades, net P&L +$50
      const trades: Trade[] = [];
      for (let i = 0; i < 25; i++) {
        trades.push(makeSpotTrade('2.00', 1000000 + i * 1000));
      }

      const gate = new PreLiveGate({
        sessionStore: createMockSessionStore([trades]),
        minTrades: 20,
        minNetPnl: 0,
      });

      const result = gate.check('spot');

      expect(result.passed).toBe(true);
      expect(result.failReasons).toEqual([]);
      expect(result.spotTradeCount).toBe(25);
      expect(result.totalTradeCount).toBe(25);
      expect(result.totalNetPnl).toBe('50.00');
      expect(result.spotWinRate).toBe(1);
    });

    it('fails with insufficient trades', () => {
      // 5 trades (below default 20)
      const trades: Trade[] = [];
      for (let i = 0; i < 5; i++) {
        trades.push(makeSpotTrade('2.00', 1000000 + i * 1000));
      }

      const gate = new PreLiveGate({
        sessionStore: createMockSessionStore([trades]),
        minTrades: 20,
        minNetPnl: 0,
      });

      const result = gate.check('spot');

      expect(result.passed).toBe(false);
      expect(result.failReasons).toHaveLength(1);
      expect(result.failReasons[0]).toContain('Insufficient paper trades');
      expect(result.failReasons[0]).toContain('5 completed');
      expect(result.failReasons[0]).toContain('minimum 20 required');
    });

    it('fails with negative P&L', () => {
      // 25 trades, net P&L -$10
      const trades: Trade[] = [];
      for (let i = 0; i < 25; i++) {
        trades.push(makeSpotTrade('-0.40', 1000000 + i * 1000));
      }

      const gate = new PreLiveGate({
        sessionStore: createMockSessionStore([trades]),
        minTrades: 20,
        minNetPnl: 0,
      });

      const result = gate.check('spot');

      expect(result.passed).toBe(false);
      expect(result.failReasons).toHaveLength(1);
      expect(result.failReasons[0]).toContain('below minimum threshold');
      expect(result.failReasons[0]).toContain('-10.00');
    });

    it('fails with both conditions (insufficient trades + negative P&L)', () => {
      // 3 trades, net P&L -$5
      const trades: Trade[] = [];
      for (let i = 0; i < 3; i++) {
        trades.push(makeSpotTrade('-1.67', 1000000 + i * 1000));
      }

      const gate = new PreLiveGate({
        sessionStore: createMockSessionStore([trades]),
        minTrades: 20,
        minNetPnl: 0,
      });

      const result = gate.check('spot');

      expect(result.passed).toBe(false);
      expect(result.failReasons).toHaveLength(2);
      expect(result.failReasons[0]).toContain('Insufficient paper trades');
      expect(result.failReasons[1]).toContain('below minimum threshold');
    });
  });

  describe('perp mode', () => {
    it('passes with sufficient perp trades and positive P&L', () => {
      // 30 perp trades, net P&L +$100
      const trades: PerpTradeRecord[] = [];
      for (let i = 0; i < 30; i++) {
        trades.push(makePerpTrade('3.33', 2000000 + i * 1000));
      }

      const gate = new PreLiveGate({
        sessionStore: createMockSessionStore(),
        perpStateStore: createMockPerpStateStore(trades),
        minTrades: 20,
        minNetPnl: 0,
      });

      const result = gate.check('perp');

      expect(result.passed).toBe(true);
      expect(result.failReasons).toEqual([]);
      expect(result.perpTradeCount).toBe(30);
      expect(result.spotTradeCount).toBe(0);
      expect(result.perpWinRate).toBe(1);
    });

    it('fails with insufficient perp trades', () => {
      // 10 perp trades (below 20)
      const trades: PerpTradeRecord[] = [];
      for (let i = 0; i < 10; i++) {
        trades.push(makePerpTrade('5.00', 2000000 + i * 1000));
      }

      const gate = new PreLiveGate({
        sessionStore: createMockSessionStore(),
        perpStateStore: createMockPerpStateStore(trades),
        minTrades: 20,
        minNetPnl: 0,
      });

      const result = gate.check('perp');

      expect(result.passed).toBe(false);
      expect(result.failReasons).toHaveLength(1);
      expect(result.failReasons[0]).toContain('Insufficient paper trades');
      expect(result.failReasons[0]).toContain('10 completed');
    });
  });

  describe('lookback trades', () => {
    it('only considers last N trades when lookbackTrades is set', () => {
      // 100 total trades, but lookbackTrades=20
      // First 80 trades: +$2 each = +$160
      // Last 20 trades: -$1 each = -$20
      const trades: Trade[] = [];
      for (let i = 0; i < 80; i++) {
        trades.push(makeSpotTrade('2.00', 1000000 + i * 1000));
      }
      for (let i = 80; i < 100; i++) {
        trades.push(makeSpotTrade('-1.00', 1000000 + i * 1000));
      }

      const gate = new PreLiveGate({
        sessionStore: createMockSessionStore([trades]),
        minTrades: 10,
        minNetPnl: 0,
        lookbackTrades: 20,
      });

      const result = gate.check('spot');

      // Most recent 20 trades by entry timestamp (sorted descending, take 20)
      // The last 20 chronologically are the -$1 trades
      expect(result.spotTradeCount).toBe(20);
      expect(result.totalTradeCount).toBe(20);
      expect(result.passed).toBe(false);
      expect(result.failReasons).toHaveLength(1);
      expect(result.failReasons[0]).toContain('below minimum threshold');
      expect(result.totalNetPnl).toBe('-20.00');
    });
  });

  describe('zero trades (fresh install)', () => {
    it('fails with zero trades', () => {
      const gate = new PreLiveGate({
        sessionStore: createMockSessionStore(),
        minTrades: 20,
        minNetPnl: 0,
      });

      const result = gate.check('spot');

      expect(result.passed).toBe(false);
      expect(result.failReasons).toHaveLength(1);
      expect(result.failReasons[0]).toContain('0 completed');
      expect(result.totalTradeCount).toBe(0);
      expect(result.spotTradeCount).toBe(0);
      expect(result.spotWinRate).toBe(0);
    });
  });

  describe('custom thresholds', () => {
    it('fails when P&L is below custom minNetPnl', () => {
      // minNetPnl=50, but P&L is only +$30
      const trades: Trade[] = [];
      for (let i = 0; i < 25; i++) {
        trades.push(makeSpotTrade('1.20', 1000000 + i * 1000));
      }

      const gate = new PreLiveGate({
        sessionStore: createMockSessionStore([trades]),
        minTrades: 20,
        minNetPnl: 50,
      });

      const result = gate.check('spot');

      expect(result.passed).toBe(false);
      expect(result.failReasons).toHaveLength(1);
      expect(result.failReasons[0]).toContain('below minimum threshold');
      expect(result.failReasons[0]).toContain('$50');
      expect(result.totalNetPnl).toBe('30.00');
    });
  });

  describe('both mode', () => {
    it('combines spot and perp trades', () => {
      // 15 spot trades + 15 perp trades = 30 total
      const spotTrades: Trade[] = [];
      for (let i = 0; i < 15; i++) {
        spotTrades.push(makeSpotTrade('2.00', 1000000 + i * 1000));
      }
      const perpTrades: PerpTradeRecord[] = [];
      for (let i = 0; i < 15; i++) {
        perpTrades.push(makePerpTrade('3.00', 2000000 + i * 1000));
      }

      const gate = new PreLiveGate({
        sessionStore: createMockSessionStore([spotTrades]),
        perpStateStore: createMockPerpStateStore(perpTrades),
        minTrades: 20,
        minNetPnl: 0,
      });

      const result = gate.check('both');

      expect(result.passed).toBe(true);
      expect(result.spotTradeCount).toBe(15);
      expect(result.perpTradeCount).toBe(15);
      expect(result.totalTradeCount).toBe(30);
      expect(result.spotNetPnl).toBe('30.00');
      expect(result.perpNetPnl).toBe('45.00');
      expect(result.totalNetPnl).toBe('75.00');
    });
  });

  describe('win rate computation', () => {
    it('computes correct win rates for mixed wins/losses', () => {
      // 20 trades: 12 wins (+$3 each), 8 losses (-$1 each) = net +$28
      const trades: Trade[] = [];
      for (let i = 0; i < 12; i++) {
        trades.push(makeSpotTrade('3.00', 1000000 + i * 1000));
      }
      for (let i = 12; i < 20; i++) {
        trades.push(makeSpotTrade('-1.00', 1000000 + i * 1000));
      }

      const gate = new PreLiveGate({
        sessionStore: createMockSessionStore([trades]),
        minTrades: 20,
        minNetPnl: 0,
      });

      const result = gate.check('spot');

      expect(result.passed).toBe(true);
      expect(result.spotWinRate).toBe(0.6); // 12/20
      expect(result.totalNetPnl).toBe('28.00');
    });
  });
});
