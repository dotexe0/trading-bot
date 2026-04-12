/**
 * MetricsCalculator tests -- verifies all 6 required performance metrics
 * plus auxiliary stats with known synthetic data.
 */

import { describe, it, expect } from 'vitest';
import { MetricsCalculator } from '../metrics.js';
import { d, ZERO, Decimal } from '../../core/decimal.js';
import type { BacktestResult, Trade, EquityPoint, SimulatedFill } from '../types.js';
import type { Signal } from '../../strategies/types.js';
import type { BacktestConfig } from '../types.js';

// ── Helpers ───────────────────────────────────────────────────────────

const DAY_MS = 86400000;

function makeSignal(direction: 'long' | 'short' | 'close' = 'long'): Signal {
  return {
    strategyName: 'test',
    pair: 'BTC-USD',
    timeframe: '1h',
    timestamp: 1700000000000,
    direction,
    confidence: 0.8,
    reasoning: 'test',
  };
}

function makeFill(overrides: Partial<SimulatedFill> = {}): SimulatedFill {
  return {
    signal: makeSignal(),
    fillPrice: d(50000),
    fillTimestamp: 1700000000000,
    fee: d(0),
    quantity: d(0.1),
    side: 'buy',
    ...overrides,
  };
}

function makeTrade(pnl: number, entryPrice = 50000, quantity = 0.1, holdMs = DAY_MS): Trade {
  return {
    entryFill: makeFill({
      fillPrice: d(entryPrice),
      quantity: d(quantity),
      fillTimestamp: 1700000000000,
      fee: d(0),
    }),
    exitFill: makeFill({
      signal: makeSignal('close'),
      fillPrice: d(entryPrice + pnl / quantity),
      quantity: d(quantity),
      fillTimestamp: 1700000000000 + holdMs,
      fee: d(0),
      side: 'sell',
    }),
    pnl: d(pnl),
    pnlPct: d(pnl / (entryPrice * quantity) * 100),
    holdingPeriodMs: holdMs,
  };
}

function makeEquityCurve(equityValues: number[], startTs = 1700000000000, intervalMs = 3600000): EquityPoint[] {
  return equityValues.map((v, i) => ({
    timestamp: startTs + i * intervalMs,
    equity: d(v),
  }));
}

function makeConfig(): BacktestConfig {
  return {
    pair: 'BTC-USD',
    timeframe: '1h',
    startMs: 1700000000000,
    endMs: 1700100000000,
    initialCapital: '10000',
    strategyConfig: { strategy: 'test' },
    slippageBps: 0,
    feeTierMaker: 0,
    feeTierTaker: 0,
    assumeTaker: true,
    positionSizePct: 0.95,
    allowShorts: true,
  };
}

function makeResult(overrides: Partial<BacktestResult> = {}): BacktestResult {
  return {
    config: makeConfig(),
    trades: [],
    equityCurve: [],
    finalEquity: d(10000),
    totalFees: d(0),
    fundingCost: ZERO,
    startTimestamp: 1700000000000,
    endTimestamp: 1700000000000 + 365 * DAY_MS,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('MetricsCalculator', () => {
  const calc = new MetricsCalculator();

  describe('Total Return', () => {
    it('calculates correctly: $10000 -> $12000 = 0.20', () => {
      const result = makeResult({ finalEquity: d(12000) });
      const metrics = calc.calculate(result, '10000');
      expect(metrics.totalReturn.toNumber()).toBeCloseTo(0.2, 10);
    });

    it('handles zero initial capital', () => {
      const result = makeResult({ finalEquity: d(5000) });
      const metrics = calc.calculate(result, '0');
      expect(metrics.totalReturn.toNumber()).toBe(0);
    });
  });

  describe('CAGR', () => {
    it('calculates correctly for 365 days, 2x return = 100%', () => {
      const startTs = 1700000000000;
      const endTs = startTs + 365 * DAY_MS;
      const result = makeResult({
        finalEquity: d(20000),
        startTimestamp: startTs,
        endTimestamp: endTs,
      });
      const metrics = calc.calculate(result, '10000');
      // (20000/10000)^(365/365) - 1 = 1.0
      expect(metrics.cagr.toNumber()).toBeCloseTo(1.0, 5);
    });

    it('returns ZERO for zero-length period', () => {
      const ts = 1700000000000;
      const result = makeResult({
        finalEquity: d(15000),
        startTimestamp: ts,
        endTimestamp: ts,
      });
      const metrics = calc.calculate(result, '10000');
      expect(metrics.cagr.toNumber()).toBe(0);
    });

    it('returns ZERO when startTimestamp > endTimestamp (negative duration)', () => {
      const result = makeResult({
        finalEquity: d(15000),
        startTimestamp: 1700100000000,
        endTimestamp: 1700000000000,
      });
      const metrics = calc.calculate(result, '10000');
      expect(metrics.cagr.toNumber()).toBe(0);
    });
  });

  describe('Sharpe Ratio', () => {
    it('returns 0 for constant equity (no variance)', () => {
      // Same equity every hour for 3 days
      const equityCurve = makeEquityCurve(
        Array(72).fill(10000),
        1700000000000,
        3600000,
      );
      const result = makeResult({ equityCurve });
      const metrics = calc.calculate(result, '10000');
      expect(metrics.sharpeRatio).toBe(0);
    });

    it('produces positive Sharpe for consistently rising equity', () => {
      // Equity rises over 10 days (240 hourly points)
      const values: number[] = [];
      for (let i = 0; i < 240; i++) {
        values.push(10000 + i * 10 + Math.sin(i) * 5); // uptrend with minor noise
      }
      const equityCurve = makeEquityCurve(values, 1700000000000, 3600000);
      const result = makeResult({ equityCurve });
      const metrics = calc.calculate(result, '10000');
      expect(metrics.sharpeRatio).toBeGreaterThan(0);
    });

    it('uses sqrt(365) annualization', () => {
      // Create exactly 2 days of hourly data with known daily returns
      const day1Values = Array(24).fill(10000);
      day1Values[23] = 10100; // day 1 end: 10100
      const day2Values = Array(24).fill(10100);
      day2Values[23] = 10201; // day 2 end: 10201

      const startTs = Date.UTC(2024, 0, 1, 0, 0, 0); // Jan 1 midnight UTC
      const equityCurve = makeEquityCurve(
        [...day1Values, ...day2Values],
        startTs,
        3600000,
      );
      const result = makeResult({ equityCurve });
      const metrics = calc.calculate(result, '10000');

      // Daily returns: 0.01, 0.01 (1% each day)
      // Mean = 0.01, StdDev = 0 for identical returns
      // stdDev = 0 means Sharpe = 0
      // Use slightly different second day return
      expect(metrics.sharpeRatio).toBe(0); // identical returns -> stdDev = 0

      // Now test with variance -- 4 days so we get 3 daily returns
      const day1b = Array(24).fill(10000);
      day1b[23] = 10100; // day1 end: 10100
      const day2b = Array(24).fill(10100);
      day2b[23] = 10302; // day2 end: 10302 (+2% from day1)
      const day3b = Array(24).fill(10302);
      day3b[23] = 10405.02; // day3 end: 10405.02 (+1% from day2)
      const day4b = Array(24).fill(10405.02);
      day4b[23] = 10613.1204; // day4 end: +2% from day3

      const startTs2 = Date.UTC(2024, 0, 1, 0, 0, 0);
      const curve2 = makeEquityCurve([...day1b, ...day2b, ...day3b, ...day4b], startTs2, 3600000);
      const result2 = makeResult({ equityCurve: curve2 });
      const metrics2 = calc.calculate(result2, '10000');

      // Daily resampled values: [10100, 10302, 10405.02, 10613.1204]
      // Daily returns: (10302-10100)/10100=0.02, (10405.02-10302)/10302=0.01, (10613.1204-10405.02)/10405.02=0.02
      const dailyReturns = [0.02, 0.01, 0.02];
      const mean = dailyReturns.reduce((a, b) => a + b) / dailyReturns.length;
      const variance = dailyReturns.reduce((a, r) => a + (r - mean) ** 2, 0) / (dailyReturns.length - 1);
      const stdDev = Math.sqrt(variance);
      const expectedSharpe = (mean / stdDev) * Math.sqrt(365);

      expect(metrics2.sharpeRatio).toBeCloseTo(expectedSharpe, 1);
    });

    it('returns 0 for fewer than 2 equity points', () => {
      const equityCurve = makeEquityCurve([10000]);
      const result = makeResult({ equityCurve });
      const metrics = calc.calculate(result, '10000');
      expect(metrics.sharpeRatio).toBe(0);
    });
  });

  describe('Max Drawdown', () => {
    it('calculates correctly: [100, 120, 90, 110] -> dd=30, pct=25%', () => {
      const equityCurve = makeEquityCurve([100, 120, 90, 110]);
      const result = makeResult({ equityCurve, finalEquity: d(110) });
      const metrics = calc.calculate(result, '100');

      // Peak = 120, trough = 90, drawdown = 30, pct = 30/120 = 25%
      expect(metrics.maxDrawdown.toNumber()).toBe(30);
      expect(metrics.maxDrawdownPct.toNumber()).toBeCloseTo(0.25, 10);
    });

    it('returns ZERO for empty equity curve', () => {
      const result = makeResult({ equityCurve: [] });
      const metrics = calc.calculate(result, '10000');
      expect(metrics.maxDrawdown.toNumber()).toBe(0);
      expect(metrics.maxDrawdownPct.toNumber()).toBe(0);
    });

    it('returns ZERO for monotonically increasing equity', () => {
      const equityCurve = makeEquityCurve([100, 110, 120, 130]);
      const result = makeResult({ equityCurve });
      const metrics = calc.calculate(result, '100');
      expect(metrics.maxDrawdown.toNumber()).toBe(0);
      expect(metrics.maxDrawdownPct.toNumber()).toBe(0);
    });
  });

  describe('Win Rate', () => {
    it('3 wins out of 5 trades = 0.60', () => {
      const trades = [
        makeTrade(100),   // win
        makeTrade(-50),   // loss
        makeTrade(200),   // win
        makeTrade(50),    // win
        makeTrade(-100),  // loss
      ];
      const result = makeResult({ trades });
      const metrics = calc.calculate(result, '10000');
      expect(metrics.winRate.toNumber()).toBeCloseTo(0.6, 10);
    });

    it('no trades = ZERO', () => {
      const result = makeResult({ trades: [] });
      const metrics = calc.calculate(result, '10000');
      expect(metrics.winRate.toNumber()).toBe(0);
    });
  });

  describe('Profit Factor', () => {
    it('gross profit 500 / gross loss 200 = 2.50', () => {
      const trades = [
        makeTrade(300),
        makeTrade(-100),
        makeTrade(200),
        makeTrade(-100),
      ];
      const result = makeResult({ trades });
      const metrics = calc.calculate(result, '10000');
      expect(metrics.profitFactor.toNumber()).toBeCloseTo(2.5, 10);
    });

    it('no losses returns 999', () => {
      const trades = [makeTrade(100), makeTrade(200)];
      const result = makeResult({ trades });
      const metrics = calc.calculate(result, '10000');
      expect(metrics.profitFactor.toNumber()).toBe(999);
    });

    it('no trades returns ZERO', () => {
      const result = makeResult({ trades: [] });
      const metrics = calc.calculate(result, '10000');
      expect(metrics.profitFactor.toNumber()).toBe(0);
    });
  });

  describe('Auxiliary metrics', () => {
    it('totalTrades matches trade count', () => {
      const trades = [makeTrade(100), makeTrade(-50)];
      const result = makeResult({ trades });
      const metrics = calc.calculate(result, '10000');
      expect(metrics.totalTrades).toBe(2);
    });

    it('bestTrade and worstTrade return correct extremes', () => {
      const trades = [makeTrade(300), makeTrade(-100), makeTrade(50)];
      const result = makeResult({ trades });
      const metrics = calc.calculate(result, '10000');
      expect(metrics.bestTrade.toNumber()).toBe(300);
      expect(metrics.worstTrade.toNumber()).toBe(-100);
    });

    it('totalFees passed through from result', () => {
      const result = makeResult({ totalFees: d(42.5) });
      const metrics = calc.calculate(result, '10000');
      expect(metrics.totalFees.toNumber()).toBe(42.5);
    });
  });

  describe('Decimal outputs', () => {
    it('all Decimal outputs are Decimal instances', () => {
      const trades = [makeTrade(100), makeTrade(-50)];
      const equityCurve = makeEquityCurve([10000, 10100, 10050]);
      const result = makeResult({
        trades,
        equityCurve,
        finalEquity: d(10050),
        startTimestamp: 1700000000000,
        endTimestamp: 1700000000000 + 30 * DAY_MS,
      });
      const metrics = calc.calculate(result, '10000');

      expect(metrics.totalReturn).toBeInstanceOf(Decimal);
      expect(metrics.cagr).toBeInstanceOf(Decimal);
      expect(metrics.maxDrawdown).toBeInstanceOf(Decimal);
      expect(metrics.maxDrawdownPct).toBeInstanceOf(Decimal);
      expect(metrics.winRate).toBeInstanceOf(Decimal);
      expect(metrics.profitFactor).toBeInstanceOf(Decimal);
      expect(metrics.totalFees).toBeInstanceOf(Decimal);
      expect(metrics.avgTradeReturn).toBeInstanceOf(Decimal);
      expect(metrics.bestTrade).toBeInstanceOf(Decimal);
      expect(metrics.worstTrade).toBeInstanceOf(Decimal);
      // Sharpe, Sortino, Calmar are number, not Decimal
      expect(typeof metrics.sharpeRatio).toBe('number');
      expect(typeof metrics.sortinoRatio).toBe('number');
      expect(typeof metrics.calmarRatio).toBe('number');
    });
  });
});

// ── FEES-03: fundingCost is separate from totalFees ────────────────────

describe('fundingCost — FEES-03', () => {
  const calc = new MetricsCalculator();

  it('fundingCost passes through from BacktestResult to PerformanceMetrics', () => {
    const result = makeResult({ fundingCost: ZERO });
    const metrics = calc.calculate(result, '10000');
    expect(metrics.fundingCost.isZero()).toBe(true);
  });

  it('fundingCost and totalFees are independent — adding them yields correct sum', () => {
    const result = makeResult({ fundingCost: d('10'), totalFees: d('5') });
    const metrics = calc.calculate(result, '10000');
    expect(metrics.fundingCost.plus(metrics.totalFees).toNumber()).toBe(15);
    expect(metrics.totalFees.toNumber()).toBe(5);    // not double-counted
    expect(metrics.fundingCost.toNumber()).toBe(10); // not double-counted
  });

  it('fundingCost is a Decimal instance', () => {
    const result = makeResult({ fundingCost: d('7.5') });
    const metrics = calc.calculate(result, '10000');
    expect(metrics.fundingCost).toBeInstanceOf(Decimal);
  });
});

// ── Sortino Ratio ─────────────────────────────────────────────────────

describe('Sortino Ratio', () => {
  const calc = new MetricsCalculator();

  it('Sortino > Sharpe when mixed returns (downside dev < total stddev)', () => {
    // Create 10 days of hourly data with mixed returns: mostly up, some down
    // Day progression: 10000, 10200(+2%), 10098(-1%), 10300(+2%), 10197(-1%),
    //                  10401(+2%), 10297(-1%), 10503(+2%), 10398(-1%), 10606(+2%)
    const dayEndValues = [10000, 10200, 10098, 10300, 10197, 10401, 10297, 10503, 10398, 10606];
    const hourlyValues: number[] = [];
    const startTs = Date.UTC(2024, 0, 1, 0, 0, 0);

    for (let day = 0; day < dayEndValues.length; day++) {
      for (let hour = 0; hour < 24; hour++) {
        // Fill each day with the end-of-previous-day value, last hour gets the actual value
        if (hour < 23) {
          hourlyValues.push(day === 0 ? 10000 : dayEndValues[day - 1]);
        } else {
          hourlyValues.push(dayEndValues[day]);
        }
      }
    }

    const equityCurve = makeEquityCurve(hourlyValues, startTs, 3600000);
    const result = makeResult({
      equityCurve,
      finalEquity: d(10606),
      startTimestamp: startTs,
      endTimestamp: startTs + 10 * DAY_MS,
    });
    const metrics = calc.calculate(result, '10000');

    // With mixed positive/negative returns, downside dev < total stddev
    // so Sortino should be > Sharpe (both should be positive since mean return > 0)
    expect(metrics.sortinoRatio).toBeGreaterThan(0);
    expect(metrics.sharpeRatio).toBeGreaterThan(0);
    expect(metrics.sortinoRatio).toBeGreaterThan(metrics.sharpeRatio);
  });

  it('Sortino = 0 when no downside deviation (all positive returns)', () => {
    // Monotonically increasing equity over 5 days
    const dayEndValues = [10000, 10100, 10201, 10303, 10406];
    const hourlyValues: number[] = [];
    const startTs = Date.UTC(2024, 0, 1, 0, 0, 0);

    for (let day = 0; day < dayEndValues.length; day++) {
      for (let hour = 0; hour < 24; hour++) {
        if (hour < 23) {
          hourlyValues.push(day === 0 ? 10000 : dayEndValues[day - 1]);
        } else {
          hourlyValues.push(dayEndValues[day]);
        }
      }
    }

    const equityCurve = makeEquityCurve(hourlyValues, startTs, 3600000);
    const result = makeResult({
      equityCurve,
      finalEquity: d(10406),
      startTimestamp: startTs,
      endTimestamp: startTs + 5 * DAY_MS,
    });
    const metrics = calc.calculate(result, '10000');

    // No negative returns means downsideSquared = 0 -> Sortino = 0
    expect(metrics.sortinoRatio).toBe(0);
  });

  it('Sortino = 0 with fewer than 2 equity points', () => {
    const equityCurve = makeEquityCurve([10000]);
    const result = makeResult({ equityCurve });
    const metrics = calc.calculate(result, '10000');
    expect(metrics.sortinoRatio).toBe(0);
  });
});

// ── Calmar Ratio ──────────────────────────────────────────────────────

describe('Calmar Ratio', () => {
  const calc = new MetricsCalculator();

  it('Calmar > 0 when there is both return and drawdown', () => {
    // Equity: 10000 -> 12000 -> 10800 -> 11500 over ~365 days
    // This has a drawdown (12000 -> 10800 = 10%) and positive CAGR
    const startTs = 1700000000000;
    const endTs = startTs + 365 * DAY_MS;

    // Create a curve with a drawdown in the middle
    const values: number[] = [];
    for (let i = 0; i < 240; i++) {
      if (i < 80) {
        values.push(10000 + i * 25); // rise to 12000
      } else if (i < 160) {
        values.push(12000 - (i - 80) * 15); // drop to 10800
      } else {
        values.push(10800 + (i - 160) * 8.75); // rise to 11500
      }
    }

    const equityCurve = makeEquityCurve(values, startTs, 3600000);
    const result = makeResult({
      equityCurve,
      finalEquity: d(11500),
      startTimestamp: startTs,
      endTimestamp: endTs,
    });
    const metrics = calc.calculate(result, '10000');

    expect(metrics.calmarRatio).toBeGreaterThan(0);
    // CAGR is positive (15% return over 365 days) and maxDD is non-zero
    expect(metrics.cagr.toNumber()).toBeGreaterThan(0);
    expect(metrics.maxDrawdownPct.toNumber()).toBeGreaterThan(0);
  });

  it('Calmar = 0 when maxDrawdownPct is zero (monotonically increasing equity)', () => {
    const equityCurve = makeEquityCurve([100, 110, 120, 130]);
    const result = makeResult({
      equityCurve,
      finalEquity: d(130),
      startTimestamp: 1700000000000,
      endTimestamp: 1700000000000 + 365 * DAY_MS,
    });
    const metrics = calc.calculate(result, '100');

    // No drawdown -> maxDrawdownPct = 0 -> Calmar = 0
    expect(metrics.maxDrawdownPct.toNumber()).toBe(0);
    expect(metrics.calmarRatio).toBe(0);
  });
});
