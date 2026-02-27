/**
 * Exit logic type system.
 *
 * Defines all types for the exit logic engine: exit actions,
 * position state, and configuration interfaces.
 * All financial fields use Decimal for precision.
 */

import type { Decimal } from 'decimal.js';

// ── Exit Action Types ───────────────────────────────────────────────

/** The type of exit action to take. */
export type ExitActionType = 'partial_exit' | 'full_exit' | 'none';

/** An exit action returned by an exit rule evaluation. */
export interface ExitAction {
  /** Type of exit: partial, full, or none */
  type: ExitActionType;
  /** Price at which to fill the exit */
  fillPrice: Decimal;
  /** Fraction of position to close (1.0 = full close) */
  fraction: Decimal;
  /** Human-readable reason for the exit */
  reason: string;
  /** Updated stop price after this action (optional) */
  newStopPrice?: Decimal;
}

// ── Position State ──────────────────────────────────────────────────

/** Current state of a position, used by exit rules. */
export interface PositionState {
  /** Price at which the position was entered */
  entryPrice: Decimal;
  /** Current remaining quantity */
  currentQuantity: Decimal;
  /** Position direction */
  direction: 'long' | 'short';
  /** Number of candles the position has been held */
  candlesHeld: number;
  /** Whether a partial exit has already been fired */
  partialExitFired: boolean;
  /** Current stop price */
  stopPrice: Decimal;
}

// ── Exit Configuration ──────────────────────────────────────────────

/** Trailing stop exit configuration. */
export interface TrailingExitConfig {
  enabled: boolean;
  /** Activate trailing stop after this percentage gain (decimal, e.g., 0.02 = 2%) */
  activateAfterPct: number;
  /** Trail distance as ATR multiple */
  trailAtrMultiple: number;
}

/** Partial exit configuration. */
export interface PartialExitConfig {
  enabled: boolean;
  /** Profit target percentage to trigger partial exit (decimal, e.g., 0.03 = 3%) */
  profitTargetPct: number;
  /** Fraction of position to close on partial exit (decimal, e.g., 0.5 = 50%) */
  closeFraction: number;
}

/** Time-based exit configuration. */
export interface TimeExitConfig {
  enabled: boolean;
  /** Max candles to hold before considering time exit */
  maxCandlesHeld: number;
  /** PnL threshold percentage; exit only if PnL below this (decimal) */
  pnlThresholdPct: number;
}

/** ATR-based dynamic stop configuration. */
export interface AtrStopConfig {
  enabled: boolean;
  /** ATR indicator period */
  atrPeriod: number;
  /** Stop distance as ATR multiple */
  atrMultiple: number;
}

/** Complete exit configuration with all four exit types. */
export interface ExitConfig {
  exits: {
    trailing: TrailingExitConfig;
    partial: PartialExitConfig;
    time: TimeExitConfig;
    atrStop: AtrStopConfig;
  };
}
