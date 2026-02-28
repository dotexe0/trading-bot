/**
 * Unit tests for computePerformanceReport, normalizeApiBacktestTrade,
 * and normalizeLiveTrade.
 */

import { describe, it, expect } from 'vitest';
import {
  computePerformanceReport,
  normalizeApiBacktestTrade,
  normalizeLiveTrade,
} from '../performance-report.js';
import { d, ZERO } from '../../core/decimal.js';
import type { Trade, SimulatedFill } from '../../backtest/types.js';
import type { Signal } from '../../strategies/types.js';
import type { ApiBacktestTrade } from '../../backtest/backtest-store.js';
import type { LiveTrade } from '../../live/types.js';

// ── Test Helpers ────────────────────────────────────────────────────

function makeSignal(overrides?: Partial<Signal>): Signal {
  return {
    strategyName: 'test',
    pair: 'BTC-USD',
    timeframe: '1h',
    timestamp: 1000000,
    direction: 'long',
    confidence: 1,
    reasoning: '',
    ...overrides,
  };
}

function makeFill(overrides?: Partial<SimulatedFill>): SimulatedFill {
  return {
    signal: makeSignal(),
    fillPrice: d('50000'),
    fillTimestamp: 1000000,
    fee: d('0.50'),
    quantity: d('0.01'),
    side: 'buy' as const,
    ...overrides,
  };
}

function makeTrade(
  pnl: string,
  pnlPct: string,
  entryPrice: string = '50000',
  exitPrice: string = '51000',
): Trade {
  const entryTs = 1000000 + Math.floor(Math.random() * 100000);
  const exitTs = entryTs + 3600000;

  return {
    entryFill: makeFill({
      fillPrice: d(entryPrice),
      fillTimestamp: entryTs,
    }),
    exitFill: makeFill({
      signal: makeSignal({ direction: 'close', timestamp: exitTs }),
      fillPrice: d(exitPrice),
      fillTimestamp: exitTs,
      side: 'sell',
    }),
    pnl: d(pnl),
    pnlPct: d(pnlPct),
    holdingPeriodMs: exitTs - entryTs,
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe('computePerformanceReport', () => {
  it('returns zeros for empty trades array', () => {
    const report = computePerformanceReport([], 'BTC-USD');

    expect(report.winRate.eq(ZERO)).toBe(true);
    expect(report.avgWin.eq(ZERO)).toBe(true);
    expect(report.avgLoss.eq(ZERO)).toBe(true);
    expect(report.winLossRatio.eq(ZERO)).toBe(true);
    expect(report.profitFactor.eq(ZERO)).toBe(true);
    expect(report.tradeCount).toBe(0);
    expect(report.bestTrades).toEqual([]);
    expect(report.worstTrades).toEqual([]);
  });

  it('handles all winning trades (3 trades)', () => {
    const trades = [
      makeTrade('100', '0.02'),
      makeTrade('200', '0.04'),
      makeTrade('150', '0.03'),
    ];

    const report = computePerformanceReport(trades, 'BTC-USD');

    expect(report.winRate.eq(d(1))).toBe(true);
    expect(report.avgWin.toNumber()).toBeCloseTo(0.03, 6);
    expect(report.avgLoss.eq(ZERO)).toBe(true);
    expect(report.winLossRatio.eq(d(999))).toBe(true);
    expect(report.profitFactor.eq(d(999))).toBe(true);
    expect(report.tradeCount).toBe(3);
  });

  it('handles all losing trades (3 trades)', () => {
    const trades = [
      makeTrade('-100', '-0.02'),
      makeTrade('-200', '-0.04'),
      makeTrade('-150', '-0.03'),
    ];

    const report = computePerformanceReport(trades, 'BTC-USD');

    expect(report.winRate.eq(ZERO)).toBe(true);
    expect(report.avgWin.eq(ZERO)).toBe(true);
    expect(report.avgLoss.toNumber()).toBeCloseTo(-0.03, 6);
    expect(report.winLossRatio.eq(ZERO)).toBe(true);
    expect(report.profitFactor.eq(ZERO)).toBe(true);
    expect(report.tradeCount).toBe(3);
  });

  it('computes correct metrics for mixed trades (3 wins, 2 losses)', () => {
    const trades = [
      makeTrade('100', '0.02'),   // win
      makeTrade('200', '0.04'),   // win
      makeTrade('-80', '-0.016'), // loss
      makeTrade('150', '0.03'),   // win
      makeTrade('-120', '-0.024'), // loss
    ];

    const report = computePerformanceReport(trades, 'BTC-USD');

    // winRate = 3/5 = 0.6
    expect(report.winRate.toNumber()).toBeCloseTo(0.6, 6);

    // avgWin = (0.02 + 0.04 + 0.03) / 3 = 0.03
    expect(report.avgWin.toNumber()).toBeCloseTo(0.03, 6);

    // avgLoss = (-0.016 + -0.024) / 2 = -0.02
    expect(report.avgLoss.toNumber()).toBeCloseTo(-0.02, 6);

    // winLossRatio = |0.03| / |−0.02| = 1.5
    expect(report.winLossRatio.toNumber()).toBeCloseTo(1.5, 6);

    // profitFactor = (100+200+150) / (80+120) = 450/200 = 2.25
    expect(report.profitFactor.toNumber()).toBeCloseTo(2.25, 6);

    expect(report.tradeCount).toBe(5);
    expect(report.bestTrades.length).toBe(5);
    expect(report.worstTrades.length).toBe(5);
  });

  it('limits bestTrades and worstTrades to topN', () => {
    const trades = Array.from({ length: 10 }, (_, i) =>
      makeTrade(String((i - 5) * 10), String((i - 5) * 0.01)),
    );

    const report = computePerformanceReport(trades, 'BTC-USD', 3);

    expect(report.bestTrades.length).toBe(3);
    expect(report.worstTrades.length).toBe(3);

    // Best trades should have highest pnlPct
    expect(parseFloat(report.bestTrades[0].pnlPct)).toBeGreaterThan(
      parseFloat(report.bestTrades[1].pnlPct),
    );

    // Worst trades should have lowest pnlPct
    expect(parseFloat(report.worstTrades[0].pnlPct)).toBeLessThan(
      parseFloat(report.worstTrades[1].pnlPct),
    );
  });

  it('returns all trades when fewer than topN', () => {
    const trades = [
      makeTrade('100', '0.02'),
      makeTrade('-50', '-0.01'),
    ];

    const report = computePerformanceReport(trades, 'BTC-USD', 5);

    expect(report.bestTrades.length).toBe(2);
    expect(report.worstTrades.length).toBe(2);
  });

  it('includes correct pair in TradeSnapshot', () => {
    const trades = [makeTrade('100', '0.02')];
    const report = computePerformanceReport(trades, 'ETH-USD');

    expect(report.bestTrades[0].pair).toBe('ETH-USD');
  });
});

describe('normalizeApiBacktestTrade', () => {
  it('converts string fields to Decimal correctly', () => {
    const apiTrade: ApiBacktestTrade = {
      entryTimestamp: 1000000,
      entryPrice: '50000.50',
      entryFee: '3.75',
      entrySide: 'buy',
      entryQuantity: '0.01',
      exitTimestamp: 1003600,
      exitPrice: '51000.25',
      exitFee: '3.83',
      exitSide: 'sell',
      exitQuantity: '0.01',
      pnl: '9.92',
      pnlPct: '0.0198',
      holdingPeriodMs: 3600,
      signal: 'long',
    };

    const trade = normalizeApiBacktestTrade(apiTrade);

    expect(trade.entryFill.fillPrice.eq(d('50000.50'))).toBe(true);
    expect(trade.entryFill.fee.eq(d('3.75'))).toBe(true);
    expect(trade.entryFill.quantity.eq(d('0.01'))).toBe(true);
    expect(trade.entryFill.fillTimestamp).toBe(1000000);
    expect(trade.entryFill.side).toBe('buy');

    expect(trade.exitFill.fillPrice.eq(d('51000.25'))).toBe(true);
    expect(trade.exitFill.fee.eq(d('3.83'))).toBe(true);
    expect(trade.exitFill.fillTimestamp).toBe(1003600);
    expect(trade.exitFill.side).toBe('sell');

    expect(trade.pnl.eq(d('9.92'))).toBe(true);
    expect(trade.pnlPct.eq(d('0.0198'))).toBe(true);
    expect(trade.holdingPeriodMs).toBe(3600);
  });

  it('uses t.signal for entry direction, not t.entrySide', () => {
    const apiTrade: ApiBacktestTrade = {
      entryTimestamp: 1000000,
      entryPrice: '50000',
      entryFee: '3.75',
      entrySide: 'sell', // order side for short entry
      entryQuantity: '0.01',
      exitTimestamp: 1003600,
      exitPrice: '49000',
      exitFee: '3.68',
      exitSide: 'buy',
      exitQuantity: '0.01',
      pnl: '9.57',
      pnlPct: '0.019',
      holdingPeriodMs: 3600,
      signal: 'short', // actual direction
    };

    const trade = normalizeApiBacktestTrade(apiTrade);

    // Entry direction should be 'short' (from t.signal), NOT derived from entrySide
    expect(trade.entryFill.signal.direction).toBe('short');
    // Entry side should still be 'sell' (order side)
    expect(trade.entryFill.side).toBe('sell');
    // Exit direction should always be 'close'
    expect(trade.exitFill.signal.direction).toBe('close');
  });
});

describe('normalizeLiveTrade', () => {
  it('returns null for incomplete trade (no exitPrice)', () => {
    const lt: LiveTrade = {
      sessionId: 'session-1',
      entryOrderId: 'order-1',
      exitOrderId: 'order-2',
      entryTimestamp: 1000000,
      entryPrice: '50000',
      entryFee: '3.75',
      entrySide: 'BUY',
      entryQuantity: '0.01',
      // no exitPrice, no pnl, no pnlPct
    };

    expect(normalizeLiveTrade(lt)).toBeNull();
  });

  it('returns null for trade with exitPrice but no pnl', () => {
    const lt: LiveTrade = {
      sessionId: 'session-1',
      entryOrderId: 'order-1',
      exitOrderId: 'order-2',
      entryTimestamp: 1000000,
      entryPrice: '50000',
      entryFee: '3.75',
      entrySide: 'BUY',
      entryQuantity: '0.01',
      exitTimestamp: 1003600,
      exitPrice: '51000',
      exitFee: '3.83',
      exitSide: 'SELL',
      exitQuantity: '0.01',
      // no pnl or pnlPct
    };

    expect(normalizeLiveTrade(lt)).toBeNull();
  });

  it('returns Trade for complete trade', () => {
    const lt: LiveTrade = {
      sessionId: 'session-1',
      entryOrderId: 'order-1',
      exitOrderId: 'order-2',
      entryTimestamp: 1000000,
      entryPrice: '50000',
      entryFee: '3.75',
      entrySide: 'BUY',
      entryQuantity: '0.01',
      exitTimestamp: 1003600,
      exitPrice: '51000',
      exitFee: '3.83',
      exitSide: 'SELL',
      exitQuantity: '0.01',
      pnl: '9.42',
      pnlPct: '0.0188',
      holdingPeriodMs: 3600000,
    };

    const trade = normalizeLiveTrade(lt);
    expect(trade).not.toBeNull();
    expect(trade!.entryFill.fillPrice.eq(d('50000'))).toBe(true);
    expect(trade!.exitFill.fillPrice.eq(d('51000'))).toBe(true);
    expect(trade!.pnl.eq(d('9.42'))).toBe(true);
    expect(trade!.pnlPct.eq(d('0.0188'))).toBe(true);
    expect(trade!.holdingPeriodMs).toBe(3600000);

    // BUY entry maps to 'buy' side and 'long' direction
    expect(trade!.entryFill.side).toBe('buy');
    expect(trade!.entryFill.signal.direction).toBe('long');

    // SELL exit maps to 'sell' side and 'close' direction
    expect(trade!.exitFill.side).toBe('sell');
    expect(trade!.exitFill.signal.direction).toBe('close');
  });

  it('maps SELL entry to short direction', () => {
    const lt: LiveTrade = {
      sessionId: 'session-1',
      entryOrderId: 'order-1',
      exitOrderId: 'order-2',
      entryTimestamp: 1000000,
      entryPrice: '50000',
      entryFee: '3.75',
      entrySide: 'SELL',
      entryQuantity: '0.01',
      exitTimestamp: 1003600,
      exitPrice: '49000',
      exitFee: '3.68',
      exitSide: 'BUY',
      exitQuantity: '0.01',
      pnl: '9.57',
      pnlPct: '0.019',
      holdingPeriodMs: 3600000,
    };

    const trade = normalizeLiveTrade(lt);
    expect(trade).not.toBeNull();
    expect(trade!.entryFill.signal.direction).toBe('short');
    expect(trade!.entryFill.side).toBe('sell');
    expect(trade!.exitFill.side).toBe('buy');
  });
});
