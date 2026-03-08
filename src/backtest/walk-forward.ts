/**
 * WalkForwardRunner -- rolling train/validate window validation.
 *
 * Detects overfitting by testing strategy performance on out-of-sample data.
 * Generates rolling windows, runs backtest on each, and produces both
 * per-window and aggregate out-of-sample metrics.
 */

import { z } from 'zod';
import { d, ZERO } from '../core/decimal.js';
import type { Candle, Timeframe } from '../core/types.js';
import type { BacktestConfig, BacktestResult, Trade, EquityPoint } from './types.js';
import type { BacktestEngine } from './engine.js';
import type { MetricsCalculator, PerformanceMetrics } from './metrics.js';
import type { MarketRegime } from '../regime/types.js';

// ── Types ─────────────────────────────────────────────────────────────

/** Configuration for walk-forward validation windows. */
export interface WalkForwardConfig {
  /** Training window duration in milliseconds */
  trainWindowMs: number;
  /** Validation window duration in milliseconds */
  validateWindowMs: number;
  /** Step size for sliding window in milliseconds */
  stepMs: number;
}

/** Zod schema for WalkForwardConfig validation. */
export const walkForwardConfigSchema = z.object({
  trainWindowMs: z.number().int().positive(),
  validateWindowMs: z.number().int().positive(),
  stepMs: z.number().int().positive(),
});

/** A single train/validate window with timestamps. */
export interface WalkForwardWindow {
  trainStart: number;
  trainEnd: number;
  validateStart: number;
  validateEnd: number;
}

/** Result from running one train/validate window. */
export interface WalkForwardWindowResult {
  window: WalkForwardWindow;
  trainMetrics: PerformanceMetrics;
  validateMetrics: PerformanceMetrics;
  trainResult: BacktestResult;
  validateResult: BacktestResult;
}

/** Complete result from walk-forward validation. */
export interface WalkForwardResult {
  windows: WalkForwardWindowResult[];
  aggregateValidateMetrics: PerformanceMetrics;
  config: WalkForwardConfig;
  validateTrades: Trade[];  // All OOS trades across all validate windows
}

// ── Window Generation ─────────────────────────────────────────────────

/**
 * Generate rolling train/validate windows for a given date range.
 *
 * @param startMs - Start of available data (timestamp ms)
 * @param endMs - End of available data (timestamp ms)
 * @param config - Walk-forward configuration
 * @returns Array of non-overlapping validate windows with overlapping train windows
 */
export function generateWindows(
  startMs: number,
  endMs: number,
  config: WalkForwardConfig,
): WalkForwardWindow[] {
  const parsed = walkForwardConfigSchema.parse(config);
  const windows: WalkForwardWindow[] = [];

  let current = startMs;
  while (true) {
    const trainStart = current;
    const trainEnd = current + parsed.trainWindowMs;
    const validateStart = trainEnd;
    const validateEnd = trainEnd + parsed.validateWindowMs;

    if (validateEnd > endMs) break;

    windows.push({ trainStart, trainEnd, validateStart, validateEnd });
    current += parsed.stepMs;
  }

  return windows;
}

// ── WalkForwardRunner ─────────────────────────────────────────────────

export class WalkForwardRunner {
  private readonly engine: BacktestEngine;
  private readonly metricsCalculator: MetricsCalculator;

  constructor(deps: { engine: BacktestEngine; metricsCalculator: MetricsCalculator }) {
    this.engine = deps.engine;
    this.metricsCalculator = deps.metricsCalculator;
  }

  /**
   * Run walk-forward validation on the given candles.
   *
   * @param backtestConfig - Base backtest configuration
   * @param wfConfig - Walk-forward window configuration
   * @param candles - Full set of candles (sorted ascending by timestamp)
   * @param additionalCandlesMap - Optional multi-TF candles
   * @returns WalkForwardResult with per-window and aggregate metrics
   */
  run(
    backtestConfig: BacktestConfig,
    wfConfig: WalkForwardConfig,
    candles: Candle[],
    additionalCandlesMap?: Map<Timeframe, Candle[]>,
    precomputedRegimes?: Map<number, MarketRegime>,
  ): WalkForwardResult {
    if (candles.length === 0) {
      return {
        windows: [],
        aggregateValidateMetrics: this.emptyMetrics(backtestConfig.initialCapital),
        config: wfConfig,
        validateTrades: [],
      };
    }

    const dataStart = candles[0].timestamp;
    const dataEnd = candles[candles.length - 1].timestamp;
    const windows = generateWindows(dataStart, dataEnd, wfConfig);

    const windowResults: WalkForwardWindowResult[] = [];
    const allValidateTrades: Trade[] = [];
    const allValidateEquity: EquityPoint[] = [];

    for (const window of windows) {
      // Filter candles for train window
      const trainCandles = candles.filter(
        (c) => c.timestamp >= window.trainStart && c.timestamp < window.trainEnd,
      );

      // Filter candles for validate window
      const validateCandles = candles.filter(
        (c) => c.timestamp >= window.validateStart && c.timestamp < window.validateEnd,
      );

      // Filter additional TF candles if provided
      let trainAdditional: Map<Timeframe, Candle[]> | undefined;
      let validateAdditional: Map<Timeframe, Candle[]> | undefined;

      if (additionalCandlesMap) {
        trainAdditional = new Map();
        validateAdditional = new Map();
        for (const [tf, tfCandles] of additionalCandlesMap) {
          trainAdditional.set(
            tf,
            tfCandles.filter((c) => c.timestamp >= window.trainStart && c.timestamp < window.trainEnd),
          );
          validateAdditional.set(
            tf,
            tfCandles.filter((c) => c.timestamp >= window.validateStart && c.timestamp < window.validateEnd),
          );
        }
      }

      // Build window-specific configs
      const trainConfig: BacktestConfig = {
        ...backtestConfig,
        startMs: window.trainStart,
        endMs: window.trainEnd,
      };
      const validateConfig: BacktestConfig = {
        ...backtestConfig,
        startMs: window.validateStart,
        endMs: window.validateEnd,
      };

      // Run engine on each window
      const trainResult = this.engine.run(trainConfig, trainCandles, trainAdditional, undefined, precomputedRegimes);
      const validateResult = this.engine.run(validateConfig, validateCandles, validateAdditional, undefined, precomputedRegimes);

      // Calculate metrics
      const trainMetrics = this.metricsCalculator.calculate(trainResult, backtestConfig.initialCapital);
      const validateMetrics = this.metricsCalculator.calculate(validateResult, backtestConfig.initialCapital);

      windowResults.push({
        window,
        trainMetrics,
        validateMetrics,
        trainResult,
        validateResult,
      });

      // Collect for aggregate
      allValidateTrades.push(...validateResult.trades);
      allValidateEquity.push(...validateResult.equityCurve);
    }

    // Calculate aggregate out-of-sample metrics
    const aggregateValidateMetrics = this.calculateAggregateMetrics(
      allValidateTrades,
      allValidateEquity,
      backtestConfig,
    );

    return {
      windows: windowResults,
      aggregateValidateMetrics,
      config: wfConfig,
      validateTrades: allValidateTrades,
    };
  }

  private calculateAggregateMetrics(
    trades: Trade[],
    equityCurve: EquityPoint[],
    config: BacktestConfig,
  ): PerformanceMetrics {
    // Sort equity curve by timestamp
    const sortedEquity = [...equityCurve].sort((a, b) => a.timestamp - b.timestamp);

    const lastEquity = sortedEquity.length > 0
      ? sortedEquity[sortedEquity.length - 1].equity
      : d(config.initialCapital);

    let totalFees = ZERO;
    for (const trade of trades) {
      totalFees = totalFees.plus(trade.entryFill.fee).plus(trade.exitFill.fee);
    }

    const startTs = sortedEquity.length > 0 ? sortedEquity[0].timestamp : 0;
    const endTs = sortedEquity.length > 0 ? sortedEquity[sortedEquity.length - 1].timestamp : 0;

    const aggregateResult: BacktestResult = {
      config,
      trades,
      equityCurve: sortedEquity,
      finalEquity: lastEquity,
      totalFees,
      startTimestamp: startTs,
      endTimestamp: endTs,
    };

    return this.metricsCalculator.calculate(aggregateResult, config.initialCapital);
  }

  private emptyMetrics(initialCapital: string): PerformanceMetrics {
    const emptyResult: BacktestResult = {
      config: {} as BacktestConfig,
      trades: [],
      equityCurve: [],
      finalEquity: d(initialCapital),
      totalFees: ZERO,
      startTimestamp: 0,
      endTimestamp: 0,
    };
    return this.metricsCalculator.calculate(emptyResult, initialCapital);
  }
}
