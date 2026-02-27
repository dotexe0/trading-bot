/**
 * TimeBasedExit (EXIT-03).
 *
 * A stateless exit rule that triggers when a position has been held
 * for at least maxCandlesHeld candles AND the current PnL percentage
 * is below the configured pnlThresholdPct.
 *
 * Key behaviors:
 * - candlesHeld is passed in (tracked by ExitLogicManager), not maintained here.
 * - Fills at candle close price (not a specific level).
 * - Does NOT fire if position is profitable above the threshold.
 * - Supports negative thresholds (e.g., -0.02 = only exit if losing > 2%).
 */

import { d, Decimal, ZERO } from '../../core/decimal.js';
import type { TimeExitConfig, ExitAction } from './types.js';

export class TimeBasedExit {
  private readonly config: TimeExitConfig;

  constructor(config: TimeExitConfig) {
    this.config = config;
  }

  /**
   * Check if the time-based exit should trigger.
   *
   * @param candlesHeld - Number of candles the position has been held
   * @param currentPnlPct - Current PnL as a decimal (e.g., -0.01 = -1%)
   * @param candle - Candle data with close price as string
   * @returns ExitAction: full_exit if conditions met, none otherwise
   */
  check(
    candlesHeld: number,
    currentPnlPct: Decimal,
    candle: { close: string },
  ): ExitAction {
    // Must have been held long enough
    if (candlesHeld < this.config.maxCandlesHeld) {
      return this.noneAction(candle.close);
    }

    // Must be below PnL threshold (losing or not profitable enough)
    const threshold = d(this.config.pnlThresholdPct);
    if (currentPnlPct.gte(threshold)) {
      return this.noneAction(candle.close);
    }

    // Time exit triggered — fill at close
    return {
      type: 'full_exit',
      fillPrice: d(candle.close),
      fraction: d(1),
      reason: 'time_exit',
    };
  }

  private noneAction(close: string): ExitAction {
    return {
      type: 'none',
      fillPrice: d(close),
      fraction: ZERO,
      reason: '',
    };
  }
}
