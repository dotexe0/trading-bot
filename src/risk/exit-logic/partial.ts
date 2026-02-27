/**
 * PartialPositionExit (EXIT-02).
 *
 * Fires once when the candle price reaches a configurable profit target
 * percentage above entry (long) or below entry (short). Returns a
 * partial_exit action with a fraction of the position to close and
 * sets the new stop price to entry (breakeven).
 *
 * Key behaviors:
 * - Fires at most once per position (partialExitFired guard).
 * - fillPrice = exact profit target price (not candle price).
 * - newStopPrice = entryPrice (breakeven).
 * - After firing, subsequent check() calls return none immediately.
 */

import { d, Decimal, ZERO } from '../../core/decimal.js';
import type { PartialExitConfig, ExitAction } from './types.js';

export class PartialPositionExit {
  private readonly config: PartialExitConfig;
  private readonly entryPrice: Decimal;
  private readonly direction: 'long' | 'short';
  private readonly profitTarget: Decimal;

  private fired: boolean = false;

  constructor(
    config: PartialExitConfig,
    entryPrice: Decimal,
    direction: 'long' | 'short',
  ) {
    this.config = config;
    this.entryPrice = entryPrice;
    this.direction = direction;

    // Compute profit target price
    if (direction === 'long') {
      // Long target: entry * (1 + profitTargetPct)
      this.profitTarget = entryPrice.mul(d(1).plus(d(config.profitTargetPct)));
    } else {
      // Short target: entry * (1 - profitTargetPct)
      this.profitTarget = entryPrice.mul(d(1).minus(d(config.profitTargetPct)));
    }
  }

  /**
   * Check if the partial exit should trigger.
   *
   * @param candle - Candle data with high, low, close as strings
   * @returns ExitAction: partial_exit if target breached and not yet fired, none otherwise
   */
  check(candle: { high: string; low: string; close: string }): ExitAction {
    // Guard: already fired, return none immediately
    if (this.fired) {
      return this.noneAction(candle.close);
    }

    const breached = this.isTargetBreached(candle);
    if (!breached) {
      return this.noneAction(candle.close);
    }

    // Target breached — fire partial exit
    this.fired = true;
    return {
      type: 'partial_exit',
      fillPrice: this.profitTarget,
      fraction: d(this.config.closeFraction),
      reason: 'partial_profit_target',
      newStopPrice: this.entryPrice,
    };
  }

  /**
   * Mark as fired externally (called by ExitLogicManager after handling).
   */
  markFired(): void {
    this.fired = true;
  }

  /**
   * Whether the partial exit has already fired.
   */
  hasFired(): boolean {
    return this.fired;
  }

  // ── Private helpers ────────────────────────────────────────────────

  private isTargetBreached(candle: {
    high: string;
    low: string;
  }): boolean {
    if (this.direction === 'long') {
      // Long: candle high >= profit target
      return d(candle.high).gte(this.profitTarget);
    } else {
      // Short: candle low <= profit target
      return d(candle.low).lte(this.profitTarget);
    }
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
