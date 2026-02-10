/**
 * BacktestEngine -- event-driven candle replay loop with structural
 * lookahead prevention.
 *
 * Replays candles chronologically through a strategy. Signals on candle[i]
 * are filled at candle[i+1].open with configurable slippage and fees.
 * Strategies only ever see candles[0..i] (never future data).
 */

import { d, ZERO } from '../core/decimal.js';
import type Decimal from 'decimal.js';
import type { Candle, Timeframe } from '../core/types.js';
import type { Signal } from '../strategies/types.js';
import type { IStrategy } from '../strategies/types.js';
import { StrategyRegistry } from '../strategies/registry.js';
import { IndicatorEngine } from '../indicators/engine.js';
import { FillSimulator } from './fill-simulator.js';
import { PortfolioTracker } from './portfolio.js';
import {
  parseBacktestConfig,
  type BacktestConfig,
  type BacktestResult,
  type EquityPoint,
  type SimulatedFill,
} from './types.js';

export class BacktestEngine {
  private readonly strategyRegistry: StrategyRegistry;
  private readonly indicatorEngine: IndicatorEngine;

  constructor(deps: {
    strategyRegistry: StrategyRegistry;
    indicatorEngine: IndicatorEngine;
  }) {
    this.strategyRegistry = deps.strategyRegistry;
    this.indicatorEngine = deps.indicatorEngine;
  }

  /**
   * Run a backtest on the given candles using the configured strategy.
   *
   * @param config - Backtest configuration (validated via Zod)
   * @param candles - Historical candles sorted ascending by timestamp
   * @param additionalCandlesMap - Optional multi-TF candles keyed by timeframe
   * @returns BacktestResult with trades, equity curve, and summary stats
   */
  run(
    config: BacktestConfig,
    candles: Candle[],
    additionalCandlesMap?: Map<Timeframe, Candle[]>,
  ): BacktestResult {
    // 1. Validate config
    const validConfig = parseBacktestConfig(config);

    // Handle empty or insufficient candles
    if (candles.length === 0) {
      return this.emptyResult(validConfig);
    }

    // 2. Create strategy from config
    const strategy = this.strategyRegistry.create(validConfig.strategyConfig);

    if (candles.length < strategy.minCandles) {
      return this.emptyResult(validConfig);
    }

    // 3. Create FillSimulator
    const fillSimulator = new FillSimulator({
      slippageBps: validConfig.slippageBps,
      feeTierMaker: validConfig.feeTierMaker,
      feeTierTaker: validConfig.feeTierTaker,
      assumeTaker: validConfig.assumeTaker,
    });

    // 4. Create PortfolioTracker
    const portfolio = new PortfolioTracker(validConfig.initialCapital);

    // 5. Pre-compute indicators (optimization: causal filters, safe to compute once)
    // The strategy computes indicators internally via its own IndicatorEngine,
    // so no explicit pre-computation is needed here. The strategy's evaluate()
    // method handles it.

    // 6. Main loop
    const equityCurve: EquityPoint[] = [];
    const startIdx = strategy.minCandles - 1;

    for (let i = startIdx; i < candles.length; i++) {
      // 6a. Structural lookahead prevention: only provide candles[0..i]
      const visibleCandles = candles.slice(0, i + 1);

      // 6b. Filter additional TF candles by timestamp
      let filteredAdditionalCandles: Map<Timeframe, Candle[]> | undefined;
      if (additionalCandlesMap) {
        filteredAdditionalCandles = new Map();
        for (const [tf, tfCandles] of additionalCandlesMap) {
          filteredAdditionalCandles.set(
            tf,
            tfCandles.filter((c) => c.timestamp <= candles[i].timestamp),
          );
        }
      }

      // 6c. Evaluate strategy
      const signals = strategy.evaluate(
        visibleCandles,
        validConfig.pair,
        validConfig.timeframe,
        filteredAdditionalCandles,
      );

      // 6d. Process signals
      for (const signal of signals) {
        // Skip shorts if not allowed
        if (!validConfig.allowShorts && signal.direction === 'short') {
          continue;
        }

        // No next bar for fill -- skip
        if (i + 1 >= candles.length) {
          continue;
        }

        // Calculate quantity
        let quantity: Decimal;
        if (signal.direction === 'close') {
          quantity = portfolio.getState().position.abs();
          if (quantity.isZero()) continue; // nothing to close
        } else {
          const currentEquity = portfolio.equity(d(candles[i].close));
          const nextOpen = d(candles[i + 1].open);
          quantity = currentEquity
            .mul(d(validConfig.positionSizePct))
            .div(nextOpen);
          if (quantity.lte(ZERO)) continue;
        }

        // Simulate fill on next bar
        const fill = fillSimulator.simulate(signal, candles[i + 1], quantity);

        // Apply fill to portfolio
        portfolio.applyFill(fill);
      }

      // 6e. Record equity point
      equityCurve.push({
        timestamp: candles[i].timestamp,
        equity: portfolio.equity(d(candles[i].close)),
      });
    }

    // 7. Force-close if still in position at end
    if (!portfolio.isFlat()) {
      const lastCandle = candles[candles.length - 1];
      const closeSignal: Signal = {
        strategyName: '__force-close',
        pair: validConfig.pair,
        timeframe: validConfig.timeframe,
        timestamp: lastCandle.timestamp,
        direction: 'close',
        confidence: 1,
        reasoning: 'Backtest end: force-close open position',
      };

      const position = portfolio.getState().position.abs();
      // Use last candle as the fill candle (fill at its open, which is ~ close for last bar)
      const closeFill = fillSimulator.simulate(closeSignal, lastCandle, position);
      portfolio.applyFill(closeFill);
    }

    // 8. Build result
    const state = portfolio.getState();
    const lastPrice = d(candles[candles.length - 1].close);

    return {
      config: validConfig,
      trades: [...state.trades],
      equityCurve,
      finalEquity: portfolio.equity(lastPrice),
      totalFees: state.totalFees,
      startTimestamp: candles[0].timestamp,
      endTimestamp: candles[candles.length - 1].timestamp,
    };
  }

  private emptyResult(config: BacktestConfig): BacktestResult {
    return {
      config,
      trades: [],
      equityCurve: [],
      finalEquity: d(config.initialCapital),
      totalFees: ZERO,
      startTimestamp: 0,
      endTimestamp: 0,
    };
  }
}
