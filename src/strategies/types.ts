/**
 * Core strategy types and interfaces.
 *
 * Defines the contract that all strategies implement (STRT-01),
 * the signal shape (STRT-03), and the environment-agnostic evaluation
 * interface (STRT-04).
 */

import type { Candle, TradingPair, Timeframe } from '../core/types.js';
import type { IndicatorConfig } from '../indicators/types.js';

/** Signal direction -- what the strategy recommends */
export type SignalDirection = 'long' | 'short' | 'close';

/** A trading signal produced by a strategy (STRT-03) */
export interface Signal {
  /** Which strategy produced this signal */
  strategyName: string;
  /** Trading pair this signal applies to */
  pair: TradingPair;
  /** Timeframe the strategy analyzed */
  timeframe: Timeframe;
  /** Timestamp of the candle that triggered the signal (Unix ms UTC) */
  timestamp: number;
  /** Direction: long, short, or close */
  direction: SignalDirection;
  /** Confidence score 0.0 to 1.0 */
  confidence: number;
  /** Human-readable explanation of why this signal was generated */
  reasoning: string;
}

/**
 * The core strategy interface (STRT-01, STRT-04).
 *
 * CRITICAL: Strategies MUST be environment-agnostic. They receive candle
 * data and return signals. No access to order books, account balances,
 * execution APIs, databases, or network. Running the same candles through
 * a strategy twice MUST give identical results (stateless between evaluate() calls).
 */
export interface IStrategy {
  /** Unique strategy name (matches config discriminator) */
  readonly name: string;

  /**
   * Minimum number of candles required before this strategy can produce signals.
   * Used by the caller to ensure sufficient data is provided.
   */
  readonly minCandles: number;

  /**
   * List of indicator configs this strategy needs computed.
   * Used by the backtester/runner to pre-compute indicators efficiently.
   */
  readonly requiredIndicators: IndicatorConfig[];

  /**
   * Evaluate market data and produce trading signals.
   *
   * @param candles - Historical candle data, sorted ascending by timestamp.
   *                  Must contain only COMPLETED candles (no partial/live candle).
   * @param pair - The trading pair being analyzed
   * @param timeframe - The primary timeframe of the candles
   * @param additionalCandles - Optional map of other timeframe candles (for multi-TF strategies).
   *                            Single-timeframe strategies ignore this parameter.
   * @returns Array of signals (may be empty if no signal conditions met)
   */
  evaluate(
    candles: Candle[],
    pair: TradingPair,
    timeframe: Timeframe,
    additionalCandles?: Map<Timeframe, Candle[]>,
  ): Signal[];
}
