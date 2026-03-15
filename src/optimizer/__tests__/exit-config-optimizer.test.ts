/**
 * Tests for ExitConfigOptimizer and hashStrategyConfig.
 */

import { describe, it, expect } from 'vitest';
import { d, ZERO } from '../../core/decimal.js';
import { ExitConfigOptimizer, hashStrategyConfig } from '../exit-config-optimizer.js';
import { parseExitConfig } from '../../risk/exit-logic/config.js';
import type { BacktestConfig } from '../../backtest/types.js';
import type { WalkForwardConfig, WalkForwardResult } from '../../backtest/walk-forward.js';
import type { PerformanceMetrics } from '../../backtest/metrics.js';
import type { Candle } from '../../core/types.js';
import type { GridSpec, OptimizerConfig } from '../types.js';

// ── Mock helpers ───────────────────────────────────────────────────

/** Build a minimal PerformanceMetrics with given profitFactor and totalTrades. */
function makeMetrics(pf: number, totalTrades: number): PerformanceMetrics {
  return {
    totalReturn: ZERO,
    cagr: ZERO,
    sharpeRatio: 0,
    maxDrawdown: ZERO,
    maxDrawdownPct: ZERO,
    winRate: ZERO,
    profitFactor: d(pf),
    totalTrades,
    totalFees: ZERO,
    fundingCost: ZERO,
    avgTradeReturn: ZERO,
    bestTrade: ZERO,
    worstTrade: ZERO,
  };
}

/** Build a mock WalkForwardResult with given metrics. */
function makeWfResult(pf: number, totalTrades: number): WalkForwardResult {
  return {
    windows: [],
    aggregateValidateMetrics: makeMetrics(pf, totalTrades),
    config: { trainWindowMs: 1, validateWindowMs: 1, stepMs: 1 },
    validateTrades: [],
  };
}

/**
 * MockWalkForwardRunner returns preset results in sequence.
 * After exhausting the preset array, repeats the last result.
 */
class MockWalkForwardRunner {
  private results: WalkForwardResult[];
  private callIndex = 0;

  constructor(results: WalkForwardResult[]) {
    this.results = results;
  }

  run(): WalkForwardResult {
    const idx = Math.min(this.callIndex, this.results.length - 1);
    this.callIndex++;
    return this.results[idx];
  }
}

// ── Minimal fixtures ───────────────────────────────────────────────

const MINIMAL_CONFIG: BacktestConfig = {
  pair: 'BTC-USD',
  timeframe: '1h',
  startMs: 1000,
  endMs: 2000,
  initialCapital: '10000',
  strategyConfig: { period: 14 },
  slippageBps: 5,
  feeTierMaker: 0.0035,
  feeTierTaker: 0.0075,
  assumeTaker: true,
  positionSizePct: 0.95,
  allowShorts: true,
};

const MINIMAL_WF_CONFIG: WalkForwardConfig = {
  trainWindowMs: 86400000,
  validateWindowMs: 86400000,
  stepMs: 86400000,
};

const MINIMAL_CANDLES: Candle[] = [];

/** Single-value grid for deterministic testing (1 combo). */
const SINGLE_GRID: GridSpec = {
  atrMultiples: [2.0],
  trailActivatePcts: [0.02],
  partialTargetPcts: [0.03],
  maxCandlesHeld: [20],
};

/** Two-value grid: 2x1x1x1 = 2 combos. */
const TWO_COMBO_GRID: GridSpec = {
  atrMultiples: [1.5, 2.5],
  trailActivatePcts: [0.02],
  partialTargetPcts: [0.03],
  maxCandlesHeld: [20],
};

/** Three-value grid: 3x1x1x1 = 3 combos. */
const THREE_COMBO_GRID: GridSpec = {
  atrMultiples: [1.5, 2.0, 2.5],
  trailActivatePcts: [0.02],
  partialTargetPcts: [0.03],
  maxCandlesHeld: [20],
};

// ── hashStrategyConfig tests ───────────────────────────────────────

describe('hashStrategyConfig', () => {
  it('same logical config with different key insertion order produces identical hash', () => {
    const configA = { period: 14, threshold: 0.5, name: 'test' };
    const configB = { name: 'test', threshold: 0.5, period: 14 };

    expect(hashStrategyConfig(configA)).toBe(hashStrategyConfig(configB));
  });

  it('adding an exits key does NOT change the hash', () => {
    const base = { period: 14, threshold: 0.5 };
    const withExits = {
      period: 14,
      threshold: 0.5,
      exits: { trailing: { enabled: true, activateAfterPct: 0.02, trailAtrMultiple: 2.0 } },
    };

    expect(hashStrategyConfig(base)).toBe(hashStrategyConfig(withExits));
  });

  it('changing a non-exit field produces a different hash', () => {
    const configA = { period: 14, threshold: 0.5 };
    const configB = { period: 20, threshold: 0.5 };

    expect(hashStrategyConfig(configA)).not.toBe(hashStrategyConfig(configB));
  });
});

// ── ExitConfigOptimizer.optimize() tests ───────────────────────────

describe('ExitConfigOptimizer.optimize()', () => {
  it('selects the combo with the highest OOS profit factor', () => {
    const mock = new MockWalkForwardRunner([
      makeWfResult(2.0, 10),
      makeWfResult(3.5, 8),
      makeWfResult(1.5, 12),
    ]);

    const optimizer = new ExitConfigOptimizer({
      walkForwardRunner: mock as any,
    });

    const config: OptimizerConfig = {
      grid: THREE_COMBO_GRID,
      minTradesFloor: 5,
    };

    const result = optimizer.optimize(
      MINIMAL_CONFIG,
      'test-strategy',
      MINIMAL_CANDLES,
      MINIMAL_WF_CONFIG,
      config,
    );

    expect(result.profitFactor).toBeCloseTo(3.5, 2);
    expect(result.strategyName).toBe('test-strategy');
  });

  it('respects MIN_TRADES_FLOOR: skips combos below threshold', () => {
    const mock = new MockWalkForwardRunner([
      makeWfResult(5.0, 2),  // Skipped: only 2 trades < floor of 5
      makeWfResult(1.2, 10), // Selected: 10 trades >= floor
    ]);

    const optimizer = new ExitConfigOptimizer({
      walkForwardRunner: mock as any,
    });

    const config: OptimizerConfig = {
      grid: TWO_COMBO_GRID,
      minTradesFloor: 5,
    };

    const result = optimizer.optimize(
      MINIMAL_CONFIG,
      'test-strategy',
      MINIMAL_CANDLES,
      MINIMAL_WF_CONFIG,
      config,
    );

    expect(result.profitFactor).toBeCloseTo(1.2, 2);
  });

  it('all combos below floor: returns fallback (all-disabled exits, pf=0)', () => {
    const mock = new MockWalkForwardRunner([
      makeWfResult(10.0, 1), // Always returns 1 trade < floor of 5
    ]);

    const optimizer = new ExitConfigOptimizer({
      walkForwardRunner: mock as any,
    });

    const config: OptimizerConfig = {
      grid: SINGLE_GRID,
      minTradesFloor: 5,
    };

    const result = optimizer.optimize(
      MINIMAL_CONFIG,
      'test-strategy',
      MINIMAL_CANDLES,
      MINIMAL_WF_CONFIG,
      config,
    );

    const fallback = parseExitConfig({});
    expect(result.profitFactor).toBe(0);
    expect(result.exitConfig).toEqual(fallback);
  });

  it('strategyConfigHash in result is empty string (caller responsibility)', () => {
    const mock = new MockWalkForwardRunner([
      makeWfResult(2.0, 10),
    ]);

    const optimizer = new ExitConfigOptimizer({
      walkForwardRunner: mock as any,
    });

    const config: OptimizerConfig = {
      grid: SINGLE_GRID,
      minTradesFloor: 5,
    };

    const result = optimizer.optimize(
      MINIMAL_CONFIG,
      'test-strategy',
      MINIMAL_CANDLES,
      MINIMAL_WF_CONFIG,
      config,
    );

    expect(result.strategyConfigHash).toBe('');
  });
});
