/**
 * BacktestEngine -- event-driven candle replay loop with structural
 * lookahead prevention.
 *
 * Replays candles chronologically through a strategy. Signals on candle[i]
 * are filled at candle[i+1].open with configurable slippage and fees.
 * Strategies only ever see candles[0..i] (never future data).
 *
 * Optionally integrates RiskManager for position sizing, risk rules,
 * and stop-loss enforcement between signal and fill.
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
import type { RiskConfig, RiskContext, StrategyStats } from '../risk/types.js';
import { RiskManager } from '../risk/risk-manager.js';
import { PositionSizer } from '../risk/position-sizer.js';
import { StopLossTracker } from '../risk/stop-loss.js';

export interface BacktestEngineOptions {
  strategyRegistry: StrategyRegistry;
  indicatorEngine: IndicatorEngine;
  riskManager?: RiskManager;
  riskConfig?: RiskConfig;
}

export class BacktestEngine {
  private readonly strategyRegistry: StrategyRegistry;
  private readonly indicatorEngine: IndicatorEngine;
  private readonly riskManager?: RiskManager;
  private readonly riskConfig?: RiskConfig;

  constructor(deps: BacktestEngineOptions) {
    this.strategyRegistry = deps.strategyRegistry;
    this.indicatorEngine = deps.indicatorEngine;
    this.riskManager = deps.riskManager;
    this.riskConfig = deps.riskConfig;
  }

  /**
   * Run a backtest on the given candles using the configured strategy.
   *
   * @param config - Backtest configuration (validated via Zod)
   * @param candles - Historical candles sorted ascending by timestamp
   * @param additionalCandlesMap - Optional multi-TF candles keyed by timeframe
   * @param strategyStats - Optional strategy stats for Kelly criterion sizing
   * @returns BacktestResult with trades, equity curve, and summary stats
   */
  run(
    config: BacktestConfig,
    candles: Candle[],
    additionalCandlesMap?: Map<Timeframe, Candle[]>,
    strategyStats?: StrategyStats,
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

    // 5. Risk management setup (optional)
    const hasRisk = !!(this.riskManager && this.riskConfig);
    const positionSizer = hasRisk ? new PositionSizer(this.riskConfig!) : null;
    const stopLossTrackers = new Map<string, StopLossTracker>();

    // 6. Main loop
    const equityCurve: EquityPoint[] = [];
    const startIdx = strategy.minCandles - 1;
    // Track position direction for stop-loss keying
    let positionDirection: 'long' | 'short' | null = null;

    for (let i = startIdx; i < candles.length; i++) {
      const currentPrice = d(candles[i].close);
      const currentEquity = portfolio.equity(currentPrice);

      // 6a. Stop-loss check for open positions (before signal evaluation)
      if (hasRisk && !portfolio.isFlat() && i + 1 < candles.length) {
        for (const [key, tracker] of stopLossTrackers) {
          const check = tracker.check({
            low: candles[i].low,
            high: candles[i].high,
            close: candles[i].close,
          });

          if (check.triggered) {
            // Generate synthetic close signal at stop price
            const stopSignal: Signal = {
              strategyName: '__stop-loss',
              pair: validConfig.pair,
              timeframe: validConfig.timeframe,
              timestamp: candles[i].timestamp,
              direction: 'close',
              confidence: 1,
              reasoning: `Stop-loss triggered at ${check.stopPrice.toFixed(2)}`,
            };

            const positionSize = portfolio.getState().position.abs();

            // Create a synthetic fill candle with open = stop price for realistic fill
            const stopFillCandle: Candle = {
              ...candles[i],
              open: check.stopPrice.toFixed(8),
            };

            const fill = fillSimulator.simulate(stopSignal, stopFillCandle, positionSize);
            portfolio.applyFill(fill);
            stopLossTrackers.delete(key);
            positionDirection = null;
            break; // Position closed, no more stop-loss checks needed
          }
        }
      }

      // 6b. Structural lookahead prevention: only provide candles[0..i]
      const visibleCandles = candles.slice(0, i + 1);

      // 6c. Filter additional TF candles by timestamp
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

      // 6d. Evaluate strategy
      const signals = strategy.evaluate(
        visibleCandles,
        validConfig.pair,
        validConfig.timeframe,
        filteredAdditionalCandles,
      );

      // 6e. Process signals
      for (const signal of signals) {
        // Skip shorts if not allowed
        if (!validConfig.allowShorts && signal.direction === 'short') {
          continue;
        }

        // No next bar for fill -- skip
        if (i + 1 >= candles.length) {
          continue;
        }

        const nextOpen = d(candles[i + 1].open);

        if (signal.direction === 'close') {
          // Close signals bypass position sizing but not the portfolio
          const quantity = portfolio.getState().position.abs();
          if (quantity.isZero()) continue;

          const fill = fillSimulator.simulate(signal, candles[i + 1], quantity);
          portfolio.applyFill(fill);

          // Clean up stop-loss tracker
          stopLossTrackers.clear();
          positionDirection = null;
        } else {
          // Entry signal -- use risk manager if available
          let quantity: Decimal;

          if (hasRisk && positionSizer && this.riskManager) {
            // Use PositionSizer for sizing
            const equity = portfolio.equity(currentPrice);
            const sizeResult = positionSizer.calculate(
              equity,
              nextOpen,
              strategyStats ?? null,
            );
            quantity = sizeResult.quantity;

            if (quantity.lte(ZERO)) continue;

            // Build risk context
            const state = portfolio.getState();
            const riskContext: RiskContext = {
              signal,
              proposedQuantity: quantity,
              proposedPrice: nextOpen,
              currentEquity: equity,
              peakEquity: state.peakEquity,
              cashBalance: state.cashBalance,
              openPositionCount: portfolio.isFlat() ? 0 : 1,
              totalExposure: portfolio.isFlat()
                ? ZERO
                : state.position.abs().mul(currentPrice).div(equity),
              dailyPnL: ZERO,
              riskConfig: this.riskConfig!,
              timestamp: candles[i].timestamp,
            };

            const decision = this.riskManager.evaluate(riskContext);

            if (!decision.approved) {
              continue; // Risk manager rejected
            }

            quantity = decision.finalQuantity;
          } else {
            // Legacy path: fixed percentage sizing
            const equity = portfolio.equity(currentPrice);
            quantity = equity
              .mul(d(validConfig.positionSizePct))
              .div(nextOpen);
            if (quantity.lte(ZERO)) continue;
          }

          // Simulate fill on next bar
          const fill = fillSimulator.simulate(signal, candles[i + 1], quantity);
          portfolio.applyFill(fill);

          // Set up stop-loss tracker for new position
          if (hasRisk && this.riskConfig) {
            const direction = signal.direction as 'long' | 'short';
            positionDirection = direction;
            const tracker = new StopLossTracker(
              {
                type: this.riskConfig.stopLoss.type,
                percentage: d(this.riskConfig.stopLoss.percentage),
              },
              fill.fillPrice,
              direction,
            );
            stopLossTrackers.set(validConfig.pair, tracker);
          }
        }
      }

      // 6f. Record equity point
      equityCurve.push({
        timestamp: candles[i].timestamp,
        equity: portfolio.equity(currentPrice),
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
