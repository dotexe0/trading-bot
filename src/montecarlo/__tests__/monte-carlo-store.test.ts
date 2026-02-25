/**
 * Tests for MonteCarloStore -- verifies SQLite persistence of
 * Monte Carlo simulation results.
 *
 * Follows the TournamentStore test pattern: in-memory SQLite for isolation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MonteCarloStore } from '../monte-carlo-store.js';
import type { MonteCarloResult, PercentileDistribution } from '../types.js';
import type { BacktestConfig } from '../../backtest/types.js';

// ── Helpers ────────────────────────────────────────────────────────

function makeDistribution(base: number): PercentileDistribution {
  return {
    p5: base * 0.5,
    p25: base * 0.75,
    p50: base,
    p75: base * 1.25,
    p95: base * 1.5,
    mean: base,
    stdDev: base * 0.2,
  };
}

function makeBacktestConfig(overrides: Partial<BacktestConfig> = {}): BacktestConfig {
  return {
    pair: 'BTC-USD',
    timeframe: '1h',
    startMs: 1700000000000,
    endMs: 1700100000000,
    initialCapital: '10000',
    slippageBps: 5,
    feeTierMaker: 0.0035,
    feeTierTaker: 0.0075,
    strategyConfig: { strategy: 'sma-crossover' },
    assumeTaker: true,
    positionSizePct: 0.95,
    allowShorts: false,
    ...overrides,
  };
}

function makeMCResult(
  id: string,
  strategyName: string,
  createdAt: number,
  overrides: Partial<MonteCarloResult> = {},
): MonteCarloResult {
  return {
    id,
    strategyName,
    iterations: 1000,
    tradeCount: 47,
    initialCapital: '10000',
    sharpeDistribution: makeDistribution(1.2),
    maxDrawdownDistribution: makeDistribution(0.05),
    totalReturnDistribution: makeDistribution(0.15),
    originalSharpe: 1.35,
    originalMaxDrawdownPct: 0.04,
    originalTotalReturn: 0.18,
    createdAt,
    backtestConfig: makeBacktestConfig(),
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────

describe('MonteCarloStore', () => {
  let store: MonteCarloStore;

  beforeEach(() => {
    store = new MonteCarloStore({ dbPath: ':memory:' });
  });

  afterEach(() => {
    store.close();
  });

  it('saves and retrieves MC result by ID', () => {
    const result = makeMCResult('mc-001', 'sma-crossover', 1700000000000);
    store.save(result);

    const loaded = store.getById('mc-001');
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe('mc-001');
    expect(loaded!.strategyName).toBe('sma-crossover');
    expect(loaded!.iterations).toBe(1000);
    expect(loaded!.tradeCount).toBe(47);
    expect(loaded!.createdAt).toBe(1700000000000);
    expect(loaded!.initialCapital).toBe('10000');
  });

  it('returns null for unknown ID', () => {
    expect(store.getById('nonexistent-id')).toBeNull();
  });

  it('retrieves results by strategy name', () => {
    store.save(makeMCResult('mc-001', 'sma-crossover', 1700000000000));
    store.save(makeMCResult('mc-002', 'rsi-mean-reversion', 1700000100000));
    store.save(makeMCResult('mc-003', 'sma-crossover', 1700000200000));

    const results = store.getByStrategy('sma-crossover');
    expect(results).toHaveLength(2);
    // Should be ordered descending by createdAt
    expect(results[0].id).toBe('mc-003');
    expect(results[1].id).toBe('mc-001');
  });

  it('lists recent results in descending order', () => {
    store.save(makeMCResult('mc-001', 'sma-crossover', 1700000000000));
    store.save(makeMCResult('mc-002', 'rsi-mean-reversion', 1700000300000));
    store.save(makeMCResult('mc-003', 'macd-momentum', 1700000100000));

    const results = store.listRecent();
    expect(results).toHaveLength(3);
    expect(results[0].id).toBe('mc-002'); // most recent
    expect(results[1].id).toBe('mc-003');
    expect(results[2].id).toBe('mc-001'); // oldest
  });

  it('preserves percentile distribution values through serialization round-trip', () => {
    const sharpeDist = makeDistribution(1.2);
    const drawdownDist = makeDistribution(0.05);
    const returnDist = makeDistribution(0.15);

    const result = makeMCResult('mc-001', 'sma-crossover', 1700000000000, {
      sharpeDistribution: sharpeDist,
      maxDrawdownDistribution: drawdownDist,
      totalReturnDistribution: returnDist,
      originalSharpe: 1.35,
      originalMaxDrawdownPct: 0.04,
      originalTotalReturn: 0.18,
    });

    store.save(result);
    const loaded = store.getById('mc-001')!;

    // Sharpe distribution
    expect(loaded.sharpeDistribution.p5).toBeCloseTo(sharpeDist.p5);
    expect(loaded.sharpeDistribution.p25).toBeCloseTo(sharpeDist.p25);
    expect(loaded.sharpeDistribution.p50).toBeCloseTo(sharpeDist.p50);
    expect(loaded.sharpeDistribution.p75).toBeCloseTo(sharpeDist.p75);
    expect(loaded.sharpeDistribution.p95).toBeCloseTo(sharpeDist.p95);
    expect(loaded.sharpeDistribution.mean).toBeCloseTo(sharpeDist.mean);
    expect(loaded.sharpeDistribution.stdDev).toBeCloseTo(sharpeDist.stdDev);

    // Drawdown distribution
    expect(loaded.maxDrawdownDistribution.p5).toBeCloseTo(drawdownDist.p5);
    expect(loaded.maxDrawdownDistribution.p50).toBeCloseTo(drawdownDist.p50);

    // Return distribution
    expect(loaded.totalReturnDistribution.p5).toBeCloseTo(returnDist.p5);
    expect(loaded.totalReturnDistribution.p50).toBeCloseTo(returnDist.p50);

    // Original metrics
    expect(loaded.originalSharpe).toBeCloseTo(1.35);
    expect(loaded.originalMaxDrawdownPct).toBeCloseTo(0.04);
    expect(loaded.originalTotalReturn).toBeCloseTo(0.18);
  });

  it('getByStrategy respects limit parameter', () => {
    store.save(makeMCResult('mc-001', 'sma-crossover', 1700000000000));
    store.save(makeMCResult('mc-002', 'sma-crossover', 1700000100000));
    store.save(makeMCResult('mc-003', 'sma-crossover', 1700000200000));

    const results = store.getByStrategy('sma-crossover', 2);
    expect(results).toHaveLength(2);
    expect(results[0].id).toBe('mc-003');
    expect(results[1].id).toBe('mc-002');
  });

  it('listRecent respects limit parameter', () => {
    store.save(makeMCResult('mc-001', 'sma-crossover', 1700000000000));
    store.save(makeMCResult('mc-002', 'rsi-mean-reversion', 1700000100000));
    store.save(makeMCResult('mc-003', 'macd-momentum', 1700000200000));

    const results = store.listRecent(2);
    expect(results).toHaveLength(2);
    expect(results[0].id).toBe('mc-003');
    expect(results[1].id).toBe('mc-002');
  });

  it('preserves backtestConfig through serialization round-trip', () => {
    const config = makeBacktestConfig({
      pair: 'ETH-USD',
      timeframe: '15m',
      initialCapital: '5000',
    });

    const result = makeMCResult('mc-001', 'test-strat', 1700000000000, {
      backtestConfig: config,
    });

    store.save(result);
    const loaded = store.getById('mc-001')!;

    expect(loaded.backtestConfig.pair).toBe('ETH-USD');
    expect(loaded.backtestConfig.timeframe).toBe('15m');
    expect(loaded.backtestConfig.initialCapital).toBe('5000');
    expect(loaded.backtestConfig.strategyConfig).toEqual({ strategy: 'sma-crossover' });
  });
});
