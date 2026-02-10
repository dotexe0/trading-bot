/**
 * StrategyComparator tests -- multi-strategy comparison and ranking.
 *
 * Uses real strategy implementations (sma-crossover with different periods)
 * and real IndicatorEngine for integration testing.
 */

import { describe, it, expect } from 'vitest';
import { StrategyComparator } from '../comparison.js';
import { BacktestEngine } from '../engine.js';
import { MetricsCalculator } from '../metrics.js';
import { IndicatorEngine } from '../../indicators/engine.js';
import { createDefaultRegistry } from '../../strategies/index.js';
import type { Candle, TradingPair, Timeframe } from '../../core/types.js';
import type { BacktestConfig } from '../types.js';

// ── Helpers ───────────────────────────────────────────────────────────

function makeCandles(count: number): Candle[] {
  const candles: Candle[] = [];
  const baseTs = 1700000000000;

  for (let i = 0; i < count; i++) {
    // Create a price pattern with trends and mean reversion
    const trend = Math.sin(i * 0.03) * 2000;
    const noise = Math.sin(i * 0.5) * 200;
    const base = 50000 + trend + noise;
    candles.push({
      pair: 'BTC-USD' as TradingPair,
      timeframe: '1h' as Timeframe,
      timestamp: baseTs + i * 3600000,
      open: String(base - 50),
      high: String(base + 300),
      low: String(base - 300),
      close: String(base),
      volume: '100',
    });
  }
  return candles;
}

function makeBaseConfig(): Omit<BacktestConfig, 'strategyConfig'> {
  return {
    pair: 'BTC-USD' as TradingPair,
    timeframe: '1h' as Timeframe,
    startMs: 1700000000000,
    endMs: 1700000000000 + 500 * 3600000,
    initialCapital: '10000',
    slippageBps: 5,
    feeTierMaker: 0.0035,
    feeTierTaker: 0.0075,
    assumeTaker: true,
    positionSizePct: 0.95,
    allowShorts: true,
  };
}

function createComparator() {
  const registry = createDefaultRegistry();
  const engine = new BacktestEngine({
    strategyRegistry: registry,
    indicatorEngine: new IndicatorEngine(),
  });
  const metricsCalculator = new MetricsCalculator();
  return new StrategyComparator({ engine, metricsCalculator });
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('StrategyComparator', () => {
  const candles = makeCandles(200);

  it('runs multiple strategy configs and returns results for each', () => {
    const comparator = createComparator();
    const configs = [
      { strategy: 'sma-crossover', fastPeriod: 3, slowPeriod: 7 },
      { strategy: 'sma-crossover', fastPeriod: 5, slowPeriod: 15 },
      { strategy: 'sma-crossover', fastPeriod: 10, slowPeriod: 30 },
    ];

    const report = comparator.compare(configs, makeBaseConfig(), candles);

    expect(report.entries).toHaveLength(3);
    for (const entry of report.entries) {
      expect(entry.metrics).toBeDefined();
      expect(entry.result).toBeDefined();
      expect(entry.strategyName).toBe('sma-crossover');
      expect(typeof entry.metrics.sharpeRatio).toBe('number');
    }
  });

  it('results are ranked by Sharpe ratio in rankedBySharpe', () => {
    const comparator = createComparator();
    const configs = [
      { strategy: 'sma-crossover', fastPeriod: 3, slowPeriod: 7 },
      { strategy: 'sma-crossover', fastPeriod: 5, slowPeriod: 15 },
      { strategy: 'sma-crossover', fastPeriod: 10, slowPeriod: 30 },
    ];

    const report = comparator.compare(configs, makeBaseConfig(), candles);

    // Verify descending Sharpe order
    for (let i = 1; i < report.rankedBySharpe.length; i++) {
      expect(report.rankedBySharpe[i - 1].metrics.sharpeRatio).toBeGreaterThanOrEqual(
        report.rankedBySharpe[i].metrics.sharpeRatio,
      );
    }
  });

  it('results are ranked by total return in rankedByReturn', () => {
    const comparator = createComparator();
    const configs = [
      { strategy: 'sma-crossover', fastPeriod: 3, slowPeriod: 7 },
      { strategy: 'sma-crossover', fastPeriod: 5, slowPeriod: 15 },
    ];

    const report = comparator.compare(configs, makeBaseConfig(), candles);

    for (let i = 1; i < report.rankedByReturn.length; i++) {
      expect(
        report.rankedByReturn[i - 1].metrics.totalReturn.gte(
          report.rankedByReturn[i].metrics.totalReturn,
        ),
      ).toBe(true);
    }
  });

  it('all strategies run on identical candle data (same date range)', () => {
    const comparator = createComparator();
    const configs = [
      { strategy: 'sma-crossover', fastPeriod: 3, slowPeriod: 7 },
      { strategy: 'sma-crossover', fastPeriod: 5, slowPeriod: 15 },
    ];

    const report = comparator.compare(configs, makeBaseConfig(), candles);

    // All entries should have same start/end timestamps
    const startTimes = report.entries.map((e) => e.result.startTimestamp);
    const endTimes = report.entries.map((e) => e.result.endTimestamp);

    expect(new Set(startTimes).size).toBe(1);
    expect(new Set(endTimes).size).toBe(1);
  });

  it('comparison with single strategy still works', () => {
    const comparator = createComparator();
    const configs = [{ strategy: 'sma-crossover', fastPeriod: 5, slowPeriod: 15 }];

    const report = comparator.compare(configs, makeBaseConfig(), candles);

    expect(report.entries).toHaveLength(1);
    expect(report.rankedBySharpe).toHaveLength(1);
    expect(report.rankedByReturn).toHaveLength(1);
    expect(report.rankedByProfitFactor).toHaveLength(1);
  });

  it('report includes dateRange, pair, and timeframe', () => {
    const comparator = createComparator();
    const configs = [{ strategy: 'sma-crossover', fastPeriod: 5, slowPeriod: 15 }];
    const baseConfig = makeBaseConfig();

    const report = comparator.compare(configs, baseConfig, candles);

    expect(report.dateRange.startMs).toBe(baseConfig.startMs);
    expect(report.dateRange.endMs).toBe(baseConfig.endMs);
    expect(report.pair).toBe('BTC-USD');
    expect(report.timeframe).toBe('1h');
  });
});
