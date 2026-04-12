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
 *
 * When the strategy config includes an `exits` block with any exit type
 * enabled, ExitLogicManager replaces StopLossTracker for that run.
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
import { RegimeClassifier } from '../regime/classifier.js';
import { MetricsCalculator } from './metrics.js';
import type { MarketRegime } from '../regime/types.js';
import { ExitLogicManager, parseExitConfig } from '../risk/exit-logic/index.js';
import type { ExitConfig } from '../risk/exit-logic/types.js';
import type { SpotSignalGate } from '../risk/spot-signal-gate.js';

export interface BacktestEngineOptions {
  strategyRegistry: StrategyRegistry;
  indicatorEngine: IndicatorEngine;
  riskManager?: RiskManager;
  riskConfig?: RiskConfig;
  spotSignalGate?: SpotSignalGate;
}

export class BacktestEngine {
  private readonly strategyRegistry: StrategyRegistry;
  private readonly indicatorEngine: IndicatorEngine;
  private readonly riskManager?: RiskManager;
  private readonly riskConfig?: RiskConfig;
  private readonly spotSignalGate?: SpotSignalGate;
  private readonly classifier = new RegimeClassifier();

  constructor(deps: BacktestEngineOptions) {
    this.strategyRegistry = deps.strategyRegistry;
    this.indicatorEngine = deps.indicatorEngine;
    this.riskManager = deps.riskManager;
    this.riskConfig = deps.riskConfig;
    this.spotSignalGate = deps.spotSignalGate;
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
    precomputedRegimes?: Map<number, MarketRegime>,
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

    // 5b. Exit logic setup: extract exits config from strategy config
    const rawExits = (validConfig.strategyConfig as Record<string, unknown>).exits;
    const exitConfig: ExitConfig = parseExitConfig(rawExits !== undefined ? { exits: rawExits } : {});
    const hasExits = exitConfig.exits.trailing.enabled || exitConfig.exits.partial.enabled ||
                     exitConfig.exits.time.enabled || exitConfig.exits.atrStop.enabled;
    let exitManager: ExitLogicManager | null = null;

    // 6. Main loop
    const equityCurve: EquityPoint[] = [];
    const startIdx = strategy.minCandles - 1;
    // Track position direction for stop-loss keying
    let positionDirection: 'long' | 'short' | null = null;
    // Track regime per candle for breakdown and persistence
    const regimePerCandle = new Map<number, MarketRegime>();

    for (let i = startIdx; i < candles.length; i++) {
      const currentPrice = d(candles[i].close);
      const currentEquity = portfolio.equity(currentPrice);

      // 6a-pre. Compute visible candles BEFORE exit check (needed for ATR computation)
      const visibleCandles = candles.slice(0, i + 1);

      // 6a. Exit logic / stop-loss check for open positions (before signal evaluation)
      if (!portfolio.isFlat() && i + 1 < candles.length) {
        if (hasExits && exitManager) {
          // ATR recomputed per candle; acceptable for v1 backtests up to ~10k candles
          const atrOutput = this.indicatorEngine.compute(
            { name: 'ATR', period: exitConfig.exits.atrStop.atrPeriod },
            visibleCandles,
          );
          const currentAtr = atrOutput.values.length > 0
            ? d(atrOutput.values[atrOutput.values.length - 1] as number)
            : null;

          const exitAction = exitManager.check({
            open: candles[i].open,
            high: candles[i].high,
            low: candles[i].low,
            close: candles[i].close,
            timestamp: candles[i].timestamp,
          }, currentAtr);

          if (exitAction.type === 'full_exit') {
            const exitSignal: Signal = {
              strategyName: `__exit-logic-${exitAction.reason}`,
              pair: validConfig.pair,
              timeframe: validConfig.timeframe,
              timestamp: candles[i].timestamp,
              direction: 'close',
              confidence: 1,
              reasoning: `Exit logic: ${exitAction.reason} at ${exitAction.fillPrice.toFixed(2)}`,
            };
            const positionSize = portfolio.getState().position.abs();
            const exitFillCandle: Candle = { ...candles[i], open: exitAction.fillPrice.toFixed(8) };
            const fill = fillSimulator.simulate(exitSignal, exitFillCandle, positionSize);
            portfolio.applyFill(fill);
            exitManager = null;
            positionDirection = null;
          } else if (exitAction.type === 'partial_exit') {
            const partialSignal: Signal = {
              strategyName: '__exit-logic-partial',
              pair: validConfig.pair,
              timeframe: validConfig.timeframe,
              timestamp: candles[i].timestamp,
              direction: 'close',
              confidence: 1,
              reasoning: `Partial exit at ${exitAction.fillPrice.toFixed(2)}`,
            };
            const positionSize = portfolio.getState().position.abs();
            const partialFillCandle: Candle = { ...candles[i], open: exitAction.fillPrice.toFixed(8) };
            const partialFill = fillSimulator.simulate(partialSignal, partialFillCandle, positionSize);
            portfolio.applyPartialClose(partialFill, exitAction.fraction);
            // ExitLogicManager handles breakeven floor internally via newStopPrice
            // The next check() call will use the updated stop price in the manager's ATR stop
          }
        } else if (!hasExits && hasRisk) {
          // Backward-compat: use existing StopLossTracker path
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
      }

      // 6b-regime. Compute regime using only visible candles (no lookahead),
      // or do a fast O(1) map lookup when precomputedRegimes is provided.
      const regime = precomputedRegimes
        ? precomputedRegimes.get(candles[i].timestamp)
        : this.classifier.classify(visibleCandles);
      if (regime !== undefined) {
        regimePerCandle.set(candles[i].timestamp, regime);
      }

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

      // 6d. Evaluate strategy (pass regime as 5th argument)
      const signals = strategy.evaluate(
        visibleCandles,
        validConfig.pair,
        validConfig.timeframe,
        filteredAdditionalCandles,
        regime,
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

          // Clean up stop-loss tracker and exit manager
          stopLossTrackers.clear();
          exitManager = null;
          positionDirection = null;
        } else {
          // Spot fee-drag gate: block entries where expected move <= round-trip fee
          if (this.spotSignalGate) {
            const atrOutput = this.indicatorEngine.compute(
              { name: 'ATR', period: this.spotSignalGate.atrPeriod },
              candles.slice(0, i + 1),
            );
            const currentAtr = atrOutput.values.length > 0
              ? d(atrOutput.values[atrOutput.values.length - 1] as number)
              : null;
            const notional = portfolio.equity(currentPrice).mul(d(validConfig.positionSizePct));
            const gateResult = this.spotSignalGate.check(currentAtr, currentPrice, notional);
            if (!gateResult.approved) continue;
          }

          // Entry signal -- use risk manager if available
          let quantity: Decimal;

          if (hasRisk && positionSizer && this.riskManager) {
            // Use PositionSizer for sizing
            const equity = portfolio.equity(currentPrice);

            // Get current ATR for volatility sizing
            const atrForSizing = (() => {
              const visCandles = candles.slice(0, i + 1);
              const atrOutput = this.indicatorEngine.compute({ name: 'ATR', period: 14 }, visCandles);
              return atrOutput.values.length > 0 ? d(atrOutput.values[atrOutput.values.length - 1] as number) : undefined;
            })();

            const sizeResult = positionSizer.calculate(
              equity,
              nextOpen,
              strategyStats ?? null,
              undefined,
              signal.confidence,
              atrForSizing,
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

            // Apply drawdown recovery scaling
            const recoveryScale = this.riskManager!.getDrawdownRecoveryScale();
            if (recoveryScale < 1.0) {
              quantity = quantity.mul(d(recoveryScale));
            }
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

          // Set up exit logic or stop-loss tracker for new position
          if (hasExits) {
            const direction = signal.direction as 'long' | 'short';
            positionDirection = direction;
            const entryAtrOutput = this.indicatorEngine.compute(
              { name: 'ATR', period: exitConfig.exits.atrStop.atrPeriod },
              candles.slice(0, i + 1),
            );
            const entryAtr = entryAtrOutput.values.length > 0
              ? d(entryAtrOutput.values[entryAtrOutput.values.length - 1] as number)
              : null;
            exitManager = new ExitLogicManager(
              exitConfig,
              fill.fillPrice,
              direction,
              entryAtr,
              regime,
            );
          } else if (hasRisk && this.riskConfig) {
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

    // Compute regime breakdown if any regimes were classified
    const metricsCalc = new MetricsCalculator();
    const tradesCopy = [...state.trades];
    const regimeBreakdown =
      regimePerCandle.size > 0
        ? metricsCalc.calculateRegimeBreakdown(
            regimePerCandle,
            tradesCopy,
            candles.length,
          )
        : undefined;

    // Build regime timeline for persistence
    const regimeTimeline =
      regimePerCandle.size > 0
        ? Array.from(regimePerCandle.entries()).map(([ts, r]) => ({
            timestamp: ts,
            regime: r,
          }))
        : undefined;

    return {
      config: validConfig,
      trades: [...state.trades],
      equityCurve,
      finalEquity: portfolio.equity(lastPrice),
      totalFees: state.totalFees,
      fundingCost: ZERO,
      startTimestamp: candles[0].timestamp,
      endTimestamp: candles[candles.length - 1].timestamp,
      regimeBreakdown,
      regimeTimeline,
    };
  }

  private emptyResult(config: BacktestConfig): BacktestResult {
    return {
      config,
      trades: [],
      equityCurve: [],
      finalEquity: d(config.initialCapital),
      totalFees: ZERO,
      fundingCost: ZERO,
      startTimestamp: 0,
      endTimestamp: 0,
    };
  }
}
