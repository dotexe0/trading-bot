/**
 * ExitLogicManager — orchestrates all four exit types.
 *
 * Priority decision tree (early return on first match):
 *   1. PartialPositionExit (partial_exit)
 *   2. TrailingProfitExit  (full_exit, trailing_stop)
 *   3. AtrDynamicStop      (full_exit, atr_stop)
 *   4. TimeBasedExit       (full_exit, time_exit)
 *
 * Tracks candlesHeld internally with timestamp deduplication.
 * After a partial exit fires, enforces a breakeven floor on the ATR stop:
 * the stop price will not go below entryPrice.
 */

import { d, Decimal, ZERO } from '../../core/decimal.js';
import type { ExitConfig, ExitAction } from './types.js';
import { TrailingProfitExit } from './trailing.js';
import { PartialPositionExit } from './partial.js';
import { AtrDynamicStop } from './atr-stop.js';
import { TimeBasedExit } from './time.js';

export class ExitLogicManager {
  private readonly entryPrice: Decimal;
  private readonly direction: 'long' | 'short';

  // Sub-exit instances (null when disabled)
  private readonly trailing: TrailingProfitExit | null;
  private readonly partial: PartialPositionExit | null;
  private readonly atrStop: AtrDynamicStop | null;
  private readonly timeExit: TimeBasedExit | null;

  // Candle tracking
  private candlesHeld: number = 0;
  private lastCandleTimestamp: number = -1;

  // Breakeven floor: set after partial exit fires
  private breakevenFloor: Decimal | null = null;

  constructor(
    config: ExitConfig,
    entryPrice: Decimal,
    direction: 'long' | 'short',
    entryAtr: Decimal | null,
  ) {
    this.entryPrice = entryPrice;
    this.direction = direction;

    // Instantiate sub-exits based on config flags
    this.trailing = config.exits.trailing.enabled
      ? new TrailingProfitExit(config.exits.trailing, entryPrice, direction)
      : null;

    this.partial = config.exits.partial.enabled
      ? new PartialPositionExit(config.exits.partial, entryPrice, direction)
      : null;

    this.atrStop = config.exits.atrStop.enabled
      ? new AtrDynamicStop(config.exits.atrStop, entryPrice, direction, entryAtr)
      : null;

    this.timeExit = config.exits.time.enabled
      ? new TimeBasedExit(config.exits.time)
      : null;
  }

  /**
   * Evaluate all exit conditions in priority order.
   *
   * @param candle - Full OHLC candle with timestamp
   * @param currentAtr - Current ATR value, or null if insufficient data
   * @returns The highest-priority ExitAction that triggers, or none
   */
  check(
    candle: {
      open: string;
      high: string;
      low: string;
      close: string;
      timestamp: number;
    },
    currentAtr: Decimal | null,
  ): ExitAction {
    // ── 1. Increment candlesHeld (deduplicate by timestamp) ──
    if (candle.timestamp !== this.lastCandleTimestamp) {
      this.candlesHeld++;
      this.lastCandleTimestamp = candle.timestamp;
    }

    // Compute current PnL percentage for time exit
    const closePrice = d(candle.close);
    const currentPnlPct = this.direction === 'long'
      ? closePrice.minus(this.entryPrice).div(this.entryPrice)
      : this.entryPrice.minus(closePrice).div(this.entryPrice);

    // Candle subset for sub-exits
    const candleHLC = {
      high: candle.high,
      low: candle.low,
      close: candle.close,
    };

    // ── 2. Partial exit (highest priority) ──
    if (this.partial !== null && !this.partial.hasFired()) {
      const action = this.partial.check(candleHLC);
      if (action.type === 'partial_exit') {
        this.partial.markFired();
        // Activate breakeven floor
        this.breakevenFloor = this.entryPrice;
        return action;
      }
    }

    // ── 3. Trailing exit ──
    if (this.trailing !== null) {
      const action = this.trailing.check(candleHLC, currentAtr);
      if (action.type === 'full_exit') {
        return action;
      }
    }

    // ── 4. ATR stop ──
    if (this.atrStop !== null) {
      const action = this.atrStop.check(candleHLC);
      if (action.type === 'full_exit') {
        // Apply breakeven floor if active
        if (this.breakevenFloor !== null) {
          return this.applyBreakevenFloor(action, candle);
        }
        return action;
      } else if (this.breakevenFloor !== null) {
        // ATR stop didn't trigger at its original level, but check the
        // breakeven floor: the candle may have breached breakeven even
        // though it didn't breach the original (lower) ATR stop.
        const floorAction = this.checkBreakevenFloor(candle);
        if (floorAction !== null) {
          return floorAction;
        }
      }
    }

    // ── 5. Time exit (lowest priority) ──
    if (this.timeExit !== null) {
      const action = this.timeExit.check(
        this.candlesHeld,
        currentPnlPct,
        { close: candle.close },
      );
      if (action.type === 'full_exit') {
        return action;
      }
    }

    // ── 6. No exit condition met ──
    return {
      type: 'none',
      fillPrice: ZERO,
      fraction: ZERO,
      reason: 'none',
    };
  }

  /**
   * Get the number of unique candles processed.
   */
  getCandlesHeld(): number {
    return this.candlesHeld;
  }

  /**
   * Whether the partial exit has already fired.
   */
  isPartialExitFired(): boolean {
    return this.partial !== null ? this.partial.hasFired() : false;
  }

  /**
   * Get the current stop price.
   * Returns ATR stop price if enabled, otherwise entryPrice as sentinel.
   */
  getCurrentStopPrice(): Decimal {
    if (this.atrStop !== null) {
      const baseStop = this.atrStop.getStopPrice();
      // Apply breakeven floor if active
      if (this.breakevenFloor !== null) {
        if (this.direction === 'long') {
          return Decimal.max(baseStop, this.breakevenFloor);
        } else {
          return Decimal.min(baseStop, this.breakevenFloor);
        }
      }
      return baseStop;
    }
    return this.entryPrice;
  }

  // ── Private helpers ────────────────────────────────────────────────

  /**
   * When breakeven floor is active and ATR stop triggers, ensure the
   * fill price is at least the breakeven level (not worse than entry).
   */
  private applyBreakevenFloor(
    action: ExitAction,
    candle: { low: string; high: string },
  ): ExitAction {
    if (this.direction === 'long') {
      // Long: fill price should be at least breakeven (higher is better)
      const flooredFill = Decimal.max(action.fillPrice, this.breakevenFloor!);
      // Verify the candle actually breaches the floored stop
      if (d(candle.low).lte(flooredFill)) {
        return {
          ...action,
          fillPrice: flooredFill,
        };
      }
    } else {
      // Short: fill price should be at most breakeven (lower is better)
      const flooredFill = Decimal.min(action.fillPrice, this.breakevenFloor!);
      if (d(candle.high).gte(flooredFill)) {
        return {
          ...action,
          fillPrice: flooredFill,
        };
      }
    }
    return action;
  }

  /**
   * Check if the breakeven floor is breached even when the original
   * ATR stop was not (because the floor is closer to entry than ATR stop).
   */
  private checkBreakevenFloor(candle: {
    low: string;
    high: string;
    close: string;
  }): ExitAction | null {
    if (this.direction === 'long') {
      // Long: check if candle low breaches the breakeven floor
      if (d(candle.low).lte(this.breakevenFloor!)) {
        return {
          type: 'full_exit',
          fillPrice: this.breakevenFloor!,
          fraction: d(1),
          reason: 'atr_stop',
        };
      }
    } else {
      // Short: check if candle high breaches the breakeven floor
      if (d(candle.high).gte(this.breakevenFloor!)) {
        return {
          type: 'full_exit',
          fillPrice: this.breakevenFloor!,
          fraction: d(1),
          reason: 'atr_stop',
        };
      }
    }
    return null;
  }
}
