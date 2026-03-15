/**
 * MonteCarloEngine tests -- verifies trade-sequence shuffling,
 * percentile distribution extraction, and edge cases.
 */

import { describe, it, expect } from 'vitest';
import { MonteCarloEngine } from '../monte-carlo-engine.js';
import { parseMonteCarloConfig } from '../types.js';
import { MetricsCalculator } from '../../backtest/metrics.js';
import { d, ZERO } from '../../core/decimal.js';
import type {
  BacktestResult,
  BacktestConfig,
  Trade,
  EquityPoint,
  SimulatedFill,
} from '../../backtest/types.js';
import type { Signal } from '../../strategies/types.js';
import type { MonteCarloResult, PercentileDistribution } from '../types.js';

// -- Helpers -----------------------------------------------------------------

const DAY_MS = 86400000;
const HOUR_MS = 3600000;

function makeSignal(direction: 'long' | 'short' | 'close' = 'long'): Signal {
  return {
    strategyName: 'test-mc',
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

function makeConfig(): BacktestConfig {
  return {
    pair: 'BTC-USD',
    timeframe: '1h',
    startMs: 1700000000000,
    endMs: 1700000000000 + 90 * DAY_MS,
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

/**
 * Create a synthetic trade with given pnlPct (as a percentage, e.g., 2.0 = 2%).
 * This matches the portfolio convention where pnlPct is stored as percentage * 100.
 */
function makeTrade(
  pnlPctValue: number,
  index: number,
  entryPrice = 50000,
  quantity = 0.1,
): Trade {
  const pnlDollars = (pnlPctValue / 100) * entryPrice * quantity;
  return {
    entryFill: makeFill({
      fillPrice: d(entryPrice),
      quantity: d(quantity),
      fillTimestamp: 1700000000000 + index * HOUR_MS,
      fee: d(0),
      side: 'buy',
    }),
    exitFill: makeFill({
      signal: makeSignal('close'),
      fillPrice: d(entryPrice + pnlDollars / quantity),
      quantity: d(quantity),
      fillTimestamp: 1700000000000 + index * HOUR_MS + HOUR_MS / 2,
      fee: d(0),
      side: 'sell',
    }),
    pnl: d(pnlDollars),
    pnlPct: d(pnlPctValue),
    holdingPeriodMs: HOUR_MS / 2,
  };
}

/**
 * Create a BacktestResult with synthetic trades.
 * @param tradeCount Number of trades to generate
 * @param winRate Fraction of trades that are winners (0-1)
 */
function makeSyntheticBacktestResult(
  tradeCount: number,
  winRate = 0.6,
): BacktestResult {
  const trades: Trade[] = [];
  const lossInterval = Math.round(1 / (1 - winRate));

  for (let i = 0; i < tradeCount; i++) {
    const isWin = i % lossInterval !== 0;
    // Win: +2% to +5%, Loss: -1% to -3%
    const pnlPctValue = isWin
      ? 2 + (i % 4) // 2, 3, 4, 5 repeating
      : -(1 + (i % 3)); // -1, -2, -3 repeating
    trades.push(makeTrade(pnlPctValue, i));
  }

  // Build equity curve from trades
  let equity = 10000;
  const equityCurve: EquityPoint[] = [
    { timestamp: 1700000000000, equity: d(equity) },
  ];

  for (let i = 0; i < trades.length; i++) {
    equity += trades[i].pnl.toNumber();
    equityCurve.push({
      timestamp: 1700000000000 + (i + 1) * HOUR_MS,
      equity: d(equity),
    });
  }

  return {
    config: makeConfig(),
    trades,
    equityCurve,
    finalEquity: d(equity),
    totalFees: d(0),
    fundingCost: ZERO,
    startTimestamp: 1700000000000,
    endTimestamp: 1700000000000 + 90 * DAY_MS,
  };
}

/** Check that a PercentileDistribution has monotonically ordered percentiles. */
function expectMonotonic(dist: PercentileDistribution, label: string): void {
  expect(dist.p5, `${label} p5 <= p25`).toBeLessThanOrEqual(dist.p25);
  expect(dist.p25, `${label} p25 <= p50`).toBeLessThanOrEqual(dist.p50);
  expect(dist.p50, `${label} p50 <= p75`).toBeLessThanOrEqual(dist.p75);
  expect(dist.p75, `${label} p75 <= p95`).toBeLessThanOrEqual(dist.p95);
}

// -- Tests -------------------------------------------------------------------

describe('MonteCarloEngine', () => {
  const defaultConfig = parseMonteCarloConfig({});

  describe('validation', () => {
    it('throws when trade count below minTrades', () => {
      const config = parseMonteCarloConfig({ minTrades: 15 });
      const engine = new MonteCarloEngine(config);
      const result = makeSyntheticBacktestResult(5, 0.6);

      expect(() => engine.run(result, 'test-strategy')).toThrow(
        /Insufficient trades/,
      );
    });

    it('handles minimum viable trade count (exactly minTrades)', () => {
      const config = parseMonteCarloConfig({ iterations: 100, minTrades: 15 });
      const engine = new MonteCarloEngine(config);
      const result = makeSyntheticBacktestResult(15, 0.6);

      // Should not throw
      const mcResult = engine.run(result, 'test-strategy');
      expect(mcResult.tradeCount).toBe(15);
    });
  });

  describe('result structure', () => {
    it('returns correct structure with all distributions', () => {
      const config = parseMonteCarloConfig({ iterations: 100 });
      const engine = new MonteCarloEngine(config);
      const backtest = makeSyntheticBacktestResult(30, 0.6);

      const mcResult = engine.run(backtest, 'test-strategy');

      // Basic fields
      expect(mcResult.id).toBeTruthy();
      expect(mcResult.id.length).toBeGreaterThan(0);
      expect(mcResult.strategyName).toBe('test-strategy');
      expect(mcResult.iterations).toBe(100);
      expect(mcResult.tradeCount).toBe(30);
      expect(mcResult.initialCapital).toBe('10000');
      expect(mcResult.createdAt).toBeGreaterThan(0);
      expect(mcResult.backtestConfig).toEqual(backtest.config);

      // Distribution fields exist
      for (const dist of [
        mcResult.sharpeDistribution,
        mcResult.maxDrawdownDistribution,
        mcResult.totalReturnDistribution,
      ]) {
        expect(dist).toHaveProperty('p5');
        expect(dist).toHaveProperty('p25');
        expect(dist).toHaveProperty('p50');
        expect(dist).toHaveProperty('p75');
        expect(dist).toHaveProperty('p95');
        expect(dist).toHaveProperty('mean');
        expect(dist).toHaveProperty('stdDev');
        expect(typeof dist.p5).toBe('number');
        expect(typeof dist.mean).toBe('number');
        expect(typeof dist.stdDev).toBe('number');
      }
    });
  });

  describe('percentile distributions', () => {
    it('percentiles are monotonically ordered', () => {
      const config = parseMonteCarloConfig({ iterations: 500 });
      const engine = new MonteCarloEngine(config);
      const backtest = makeSyntheticBacktestResult(50, 0.6);

      const mcResult = engine.run(backtest, 'test-strategy');

      expectMonotonic(mcResult.sharpeDistribution, 'sharpe');
      expectMonotonic(mcResult.maxDrawdownDistribution, 'maxDrawdown');
      expectMonotonic(mcResult.totalReturnDistribution, 'totalReturn');
    });

    it('max drawdown distribution percentiles are all >= 0', () => {
      const config = parseMonteCarloConfig({ iterations: 200 });
      const engine = new MonteCarloEngine(config);
      const backtest = makeSyntheticBacktestResult(30, 0.6);

      const mcResult = engine.run(backtest, 'test-strategy');
      const dd = mcResult.maxDrawdownDistribution;

      expect(dd.p5).toBeGreaterThanOrEqual(0);
      expect(dd.p25).toBeGreaterThanOrEqual(0);
      expect(dd.p50).toBeGreaterThanOrEqual(0);
      expect(dd.p75).toBeGreaterThanOrEqual(0);
      expect(dd.p95).toBeGreaterThanOrEqual(0);
      expect(dd.mean).toBeGreaterThanOrEqual(0);
    });
  });

  describe('metric accuracy', () => {
    it('total return distribution p50 is near original total return', () => {
      const config = parseMonteCarloConfig({ iterations: 500 });
      const engine = new MonteCarloEngine(config);
      const backtest = makeSyntheticBacktestResult(40, 0.6);

      const mcResult = engine.run(backtest, 'test-strategy');

      // With pnlPct compounding, the median total return should be
      // in the same ballpark as the original (within 50% tolerance --
      // compounding order matters, so we use a loose bound)
      const originalReturn = mcResult.originalTotalReturn;
      const mcMedian = mcResult.totalReturnDistribution.p50;

      // Both should have the same sign (positive for a winning strategy)
      expect(originalReturn).toBeGreaterThan(0);
      expect(mcMedian).toBeGreaterThan(0);

      // Within reasonable tolerance
      const ratio = mcMedian / originalReturn;
      expect(ratio).toBeGreaterThan(0.3);
      expect(ratio).toBeLessThan(3.0);
    });

    it('preserves original metrics in result', () => {
      const config = parseMonteCarloConfig({ iterations: 100 });
      const engine = new MonteCarloEngine(config);
      const backtest = makeSyntheticBacktestResult(30, 0.6);

      // Compute original metrics independently
      const metricsCalc = new MetricsCalculator();
      const originalMetrics = metricsCalc.calculate(
        backtest,
        backtest.config.initialCapital,
      );

      const mcResult = engine.run(backtest, 'test-strategy');

      // Original metrics should match
      expect(mcResult.originalSharpe).toBeCloseTo(
        originalMetrics.sharpeRatio,
        6,
      );
      expect(mcResult.originalMaxDrawdownPct).toBeCloseTo(
        originalMetrics.maxDrawdownPct.toNumber(),
        6,
      );
      expect(mcResult.originalTotalReturn).toBeCloseTo(
        originalMetrics.totalReturn.toNumber(),
        6,
      );
    });
  });

  describe('randomness', () => {
    it('running twice produces different results (non-deterministic)', () => {
      const config = parseMonteCarloConfig({ iterations: 200 });
      const engine = new MonteCarloEngine(config);
      const backtest = makeSyntheticBacktestResult(30, 0.6);

      const result1 = engine.run(backtest, 'test-strategy');
      const result2 = engine.run(backtest, 'test-strategy');

      // UUIDs should differ
      expect(result1.id).not.toBe(result2.id);

      // Total return and drawdown distributions depend on trade ordering
      // (compounding makes different orderings produce different equity paths).
      // Sharpe from per-trade returns is order-invariant (same mean/stddev),
      // so we check totalReturn and maxDrawdown instead.
      const ret1 = result1.totalReturnDistribution;
      const ret2 = result2.totalReturnDistribution;
      const dd1 = result1.maxDrawdownDistribution;
      const dd2 = result2.maxDrawdownDistribution;
      const allSame =
        ret1.p5 === ret2.p5 &&
        ret1.p50 === ret2.p50 &&
        ret1.p95 === ret2.p95 &&
        dd1.p5 === dd2.p5 &&
        dd1.p50 === dd2.p50 &&
        dd1.p95 === dd2.p95;
      expect(allSame).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('works with all winning trades', () => {
      const config = parseMonteCarloConfig({ iterations: 100, minTrades: 5 });
      const engine = new MonteCarloEngine(config);

      // Create all-win backtest
      const trades: Trade[] = [];
      for (let i = 0; i < 20; i++) {
        trades.push(makeTrade(2.0, i)); // +2% each
      }

      let equity = 10000;
      const equityCurve: EquityPoint[] = [
        { timestamp: 1700000000000, equity: d(equity) },
      ];
      for (const t of trades) {
        equity += t.pnl.toNumber();
        equityCurve.push({
          timestamp: 1700000000000 + equityCurve.length * HOUR_MS,
          equity: d(equity),
        });
      }

      const backtest: BacktestResult = {
        config: makeConfig(),
        trades,
        equityCurve,
        finalEquity: d(equity),
        totalFees: d(0),
        fundingCost: ZERO,
        startTimestamp: 1700000000000,
        endTimestamp: 1700000000000 + 90 * DAY_MS,
      };

      const mcResult = engine.run(backtest, 'all-wins');

      // All wins => total return is always positive
      expect(mcResult.totalReturnDistribution.p5).toBeGreaterThan(0);
      // Max drawdown should be 0 for all-win (all positive returns)
      expect(mcResult.maxDrawdownDistribution.p50).toBeCloseTo(0, 5);
    });

    it('works with all losing trades', () => {
      const config = parseMonteCarloConfig({ iterations: 100, minTrades: 5 });
      const engine = new MonteCarloEngine(config);

      const trades: Trade[] = [];
      for (let i = 0; i < 20; i++) {
        trades.push(makeTrade(-1.5, i)); // -1.5% each
      }

      let equity = 10000;
      const equityCurve: EquityPoint[] = [
        { timestamp: 1700000000000, equity: d(equity) },
      ];
      for (const t of trades) {
        equity += t.pnl.toNumber();
        equityCurve.push({
          timestamp: 1700000000000 + equityCurve.length * HOUR_MS,
          equity: d(equity),
        });
      }

      const backtest: BacktestResult = {
        config: makeConfig(),
        trades,
        equityCurve,
        finalEquity: d(equity),
        totalFees: d(0),
        fundingCost: ZERO,
        startTimestamp: 1700000000000,
        endTimestamp: 1700000000000 + 90 * DAY_MS,
      };

      const mcResult = engine.run(backtest, 'all-losses');

      // All losses => total return is always negative
      expect(mcResult.totalReturnDistribution.p95).toBeLessThan(0);
      // Max drawdown should be substantial
      expect(mcResult.maxDrawdownDistribution.p50).toBeGreaterThan(0);
    });
  });
});
