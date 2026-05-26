/**
 * WalkForwardRunner tests -- rolling window generation and validation.
 */

import { describe, it, expect } from 'vitest';
import {
  generateWindows,
  splitWalkForward,
  WalkForwardRunner,
  type WalkForwardConfig,
} from '../walk-forward.js';
import { BacktestEngine } from '../engine.js';
import { MetricsCalculator } from '../metrics.js';
import { IndicatorEngine } from '../../indicators/engine.js';
import { StrategyRegistry } from '../../strategies/registry.js';
import type { IStrategy, Signal } from '../../strategies/types.js';
import type { IndicatorConfig } from '../../indicators/types.js';
import type { Candle, TradingPair, Timeframe } from '../../core/types.js';
import type { BacktestConfig } from '../types.js';

// ── Helpers ───────────────────────────────────────────────────────────

const HOUR_MS = 3600000;
const DAY_MS = 86400000;

function makeCandles(count: number, startTs = 1700000000000, intervalMs = HOUR_MS): Candle[] {
  const candles: Candle[] = [];
  for (let i = 0; i < count; i++) {
    const base = 50000 + Math.sin(i * 0.1) * 500;
    candles.push({
      pair: 'BTC-USD',
      timeframe: '1h',
      timestamp: startTs + i * intervalMs,
      open: String(base),
      high: String(base + 200),
      low: String(base - 200),
      close: String(base + 50),
      volume: '100',
    });
  }
  return candles;
}

/** Simple alternating strategy: long on even bars, close on odd bars. */
class AlternatingStrategy implements IStrategy {
  readonly name = 'alternating';
  readonly minCandles = 2;
  readonly requiredIndicators: IndicatorConfig[] = [];
  private callCount = 0;

  evaluate(candles: Candle[], pair: TradingPair, timeframe: Timeframe): Signal[] {
    this.callCount++;
    const direction = this.callCount % 2 === 0 ? 'close' : 'long';
    return [
      {
        strategyName: this.name,
        pair,
        timeframe,
        timestamp: candles[candles.length - 1].timestamp,
        direction,
        confidence: 0.7,
        reasoning: 'alternating test',
      },
    ];
  }
}

class MockStrategyRegistry extends StrategyRegistry {
  private mockStrategy: IStrategy;
  constructor(strategy: IStrategy) {
    super();
    this.mockStrategy = strategy;
  }
  override create(_rawConfig: unknown): IStrategy {
    return this.mockStrategy;
  }
}

function makeBaseConfig(startMs: number, endMs: number): BacktestConfig {
  return {
    pair: 'BTC-USD',
    timeframe: '1h',
    startMs,
    endMs,
    initialCapital: '10000',
    strategyConfig: { strategy: 'alternating' },
    slippageBps: 0,
    feeTierMaker: 0,
    feeTierTaker: 0,
    assumeTaker: true,
    positionSizePct: 0.95,
    allowShorts: false,
  };
}

// ── Tests: generateWindows ────────────────────────────────────────────

describe('generateWindows', () => {
  it('produces correct number of windows for known date range', () => {
    const startMs = 0;
    const endMs = 10 * DAY_MS; // 10 days
    const config: WalkForwardConfig = {
      trainWindowMs: 5 * DAY_MS,
      validateWindowMs: 2 * DAY_MS,
      stepMs: 2 * DAY_MS,
    };

    const windows = generateWindows(startMs, endMs, config);

    // Window 0: train [0, 5d], validate [5d, 7d] -- fits
    // Window 1: train [2d, 7d], validate [7d, 9d] -- fits
    // Window 2: train [4d, 9d], validate [9d, 11d] -- exceeds 10d, stops
    expect(windows).toHaveLength(2);
  });

  it('validate windows use strictly after train windows', () => {
    const startMs = 0;
    const endMs = 20 * DAY_MS;
    const config: WalkForwardConfig = {
      trainWindowMs: 5 * DAY_MS,
      validateWindowMs: 2 * DAY_MS,
      stepMs: 2 * DAY_MS,
    };

    const windows = generateWindows(startMs, endMs, config);

    for (const w of windows) {
      expect(w.validateStart).toBe(w.trainEnd);
      expect(w.validateStart).toBeGreaterThan(w.trainStart);
      expect(w.validateEnd).toBeGreaterThan(w.validateStart);
    }
  });

  it('validate windows do not overlap each other when stepMs >= validateWindowMs', () => {
    const startMs = 0;
    const endMs = 30 * DAY_MS;
    const config: WalkForwardConfig = {
      trainWindowMs: 10 * DAY_MS,
      validateWindowMs: 5 * DAY_MS,
      stepMs: 5 * DAY_MS, // step = validate window = no overlap
    };

    const windows = generateWindows(startMs, endMs, config);

    for (let i = 1; i < windows.length; i++) {
      expect(windows[i].validateStart).toBeGreaterThanOrEqual(windows[i - 1].validateEnd);
    }
  });

  it('empty result when date range too short for even one window', () => {
    const startMs = 0;
    const endMs = 3 * DAY_MS; // Only 3 days
    const config: WalkForwardConfig = {
      trainWindowMs: 5 * DAY_MS,
      validateWindowMs: 2 * DAY_MS,
      stepMs: 1 * DAY_MS,
    };

    const windows = generateWindows(startMs, endMs, config);
    expect(windows).toHaveLength(0);
  });
});

// ── Tests: WalkForwardRunner ──────────────────────────────────────────

describe('WalkForwardRunner', () => {
  function createRunner() {
    const strategy = new AlternatingStrategy();
    const registry = new MockStrategyRegistry(strategy);
    const engine = new BacktestEngine({
      strategyRegistry: registry,
      indicatorEngine: new IndicatorEngine(),
    });
    const metricsCalculator = new MetricsCalculator();
    return new WalkForwardRunner({ engine, metricsCalculator });
  }

  it('produces correct number of WalkForwardWindowResults', () => {
    // 100 hourly candles = ~4.17 days
    const candles = makeCandles(100);
    const startTs = candles[0].timestamp;
    const endTs = candles[candles.length - 1].timestamp;

    const wfConfig: WalkForwardConfig = {
      trainWindowMs: 30 * HOUR_MS,
      validateWindowMs: 10 * HOUR_MS,
      stepMs: 10 * HOUR_MS,
    };

    // Calculate expected windows
    const expectedWindows = generateWindows(startTs, endTs, wfConfig);

    const runner = createRunner();
    const config = makeBaseConfig(startTs, endTs);
    const result = runner.run(config, wfConfig, candles);

    expect(result.windows).toHaveLength(expectedWindows.length);
    expect(result.windows.length).toBeGreaterThan(0);
  });

  it('each window result has both train and validate metrics populated', () => {
    const candles = makeCandles(80);
    const startTs = candles[0].timestamp;
    const endTs = candles[candles.length - 1].timestamp;

    const wfConfig: WalkForwardConfig = {
      trainWindowMs: 30 * HOUR_MS,
      validateWindowMs: 10 * HOUR_MS,
      stepMs: 10 * HOUR_MS,
    };

    const runner = createRunner();
    const config = makeBaseConfig(startTs, endTs);
    const result = runner.run(config, wfConfig, candles);

    for (const windowResult of result.windows) {
      expect(windowResult.trainMetrics).toBeDefined();
      expect(windowResult.validateMetrics).toBeDefined();
      expect(windowResult.trainResult).toBeDefined();
      expect(windowResult.validateResult).toBeDefined();
      expect(typeof windowResult.trainMetrics.sharpeRatio).toBe('number');
      expect(typeof windowResult.validateMetrics.sharpeRatio).toBe('number');
      expect(windowResult.trainMetrics.totalTrades).toBeDefined();
      expect(windowResult.validateMetrics.totalTrades).toBeDefined();
    }
  });

  it('train and validate windows use non-overlapping candle subsets', () => {
    const candles = makeCandles(80);
    const startTs = candles[0].timestamp;
    const endTs = candles[candles.length - 1].timestamp;

    const wfConfig: WalkForwardConfig = {
      trainWindowMs: 30 * HOUR_MS,
      validateWindowMs: 10 * HOUR_MS,
      stepMs: 10 * HOUR_MS,
    };

    const runner = createRunner();
    const config = makeBaseConfig(startTs, endTs);
    const result = runner.run(config, wfConfig, candles);

    for (const windowResult of result.windows) {
      const { window } = windowResult;
      // Validate starts exactly where train ends
      expect(window.validateStart).toBe(window.trainEnd);

      // Train candle timestamps are all < trainEnd
      if (windowResult.trainResult.equityCurve.length > 0) {
        const trainTimestamps = windowResult.trainResult.equityCurve.map((e) => e.timestamp);
        for (const ts of trainTimestamps) {
          expect(ts).toBeGreaterThanOrEqual(window.trainStart);
          expect(ts).toBeLessThan(window.trainEnd);
        }
      }

      // Validate candle timestamps are all >= validateStart
      if (windowResult.validateResult.equityCurve.length > 0) {
        const validateTimestamps = windowResult.validateResult.equityCurve.map((e) => e.timestamp);
        for (const ts of validateTimestamps) {
          expect(ts).toBeGreaterThanOrEqual(window.validateStart);
          expect(ts).toBeLessThan(window.validateEnd);
        }
      }
    }
  });

  it('aggregate validate metrics are populated', () => {
    const candles = makeCandles(80);
    const startTs = candles[0].timestamp;
    const endTs = candles[candles.length - 1].timestamp;

    const wfConfig: WalkForwardConfig = {
      trainWindowMs: 30 * HOUR_MS,
      validateWindowMs: 10 * HOUR_MS,
      stepMs: 10 * HOUR_MS,
    };

    const runner = createRunner();
    const config = makeBaseConfig(startTs, endTs);
    const result = runner.run(config, wfConfig, candles);

    expect(result.aggregateValidateMetrics).toBeDefined();
    expect(typeof result.aggregateValidateMetrics.sharpeRatio).toBe('number');
    expect(result.aggregateValidateMetrics.totalTrades).toBeGreaterThanOrEqual(0);
  });
});

// ── Tests: WalkForwardResult validateTrades ───────────────────────────

describe('WalkForwardResult validateTrades', () => {
  function createRunner() {
    const strategy = new AlternatingStrategy();
    const registry = new MockStrategyRegistry(strategy);
    const engine = new BacktestEngine({
      strategyRegistry: registry,
      indicatorEngine: new IndicatorEngine(),
    });
    const metricsCalculator = new MetricsCalculator();
    return new WalkForwardRunner({ engine, metricsCalculator });
  }

  it('validateTrades is an array populated from all validate windows', () => {
    const candles = makeCandles(100);
    const startTs = candles[0].timestamp;
    const endTs = candles[candles.length - 1].timestamp;

    const wfConfig: WalkForwardConfig = {
      trainWindowMs: 30 * HOUR_MS,
      validateWindowMs: 10 * HOUR_MS,
      stepMs: 10 * HOUR_MS,
    };

    const runner = createRunner();
    const config = makeBaseConfig(startTs, endTs);
    const result = runner.run(config, wfConfig, candles);

    // validateTrades must be an array (not undefined)
    expect(Array.isArray(result.validateTrades)).toBe(true);

    // validateTrades must equal the sum of trades across all validate windows
    const expectedTradeCount = result.windows.reduce(
      (sum, w) => sum + w.validateResult.trades.length,
      0,
    );
    expect(result.validateTrades.length).toBe(expectedTradeCount);
  });

  it('validateTrades is empty array when no candles provided', () => {
    const wfConfig: WalkForwardConfig = {
      trainWindowMs: 30 * HOUR_MS,
      validateWindowMs: 10 * HOUR_MS,
      stepMs: 10 * HOUR_MS,
    };

    const runner = createRunner();
    const config = makeBaseConfig(1700000000000, 1700003600000);
    const result = runner.run(config, wfConfig, []);

    expect(Array.isArray(result.validateTrades)).toBe(true);
    expect(result.validateTrades.length).toBe(0);
  });
});

describe('splitWalkForward', () => {
  it('splits total span into windowCount non-overlapping windows (70/30 IS/OOS)', () => {
    const total = 1000;
    const cfg = splitWalkForward(total, 5);
    expect(cfg.trainWindowMs).toBe(140);   // floor(0.7*1000/5)
    expect(cfg.validateWindowMs).toBe(60);  // floor(0.3*1000/5)
    expect(cfg.stepMs).toBe(200);           // train + validate

    const windows = generateWindows(0, total, cfg);
    expect(windows).toHaveLength(5);
  });

  it('defaults to 5 windows and yields more OOS slices than the old 3-window split', () => {
    const total = 1_000_000;
    const five = generateWindows(0, total, splitWalkForward(total));
    const three = generateWindows(0, total, splitWalkForward(total, 3));
    expect(five.length).toBeGreaterThan(three.length);
    expect(five.length).toBe(5);
  });
});
