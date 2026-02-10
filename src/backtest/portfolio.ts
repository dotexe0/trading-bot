/**
 * PortfolioTracker -- tracks portfolio state through a backtest.
 *
 * State machine handles long, short, close, and reversal signals.
 * All financial math uses Decimal precision.
 * Tracks round-trip trades, equity curve points, and peak equity for drawdown.
 */

import { d, ZERO, Decimal } from '../core/decimal.js';
import type { SimulatedFill, Trade } from './types.js';

export interface PortfolioState {
  readonly cashBalance: Decimal;
  readonly position: Decimal;
  readonly avgEntryPrice: Decimal;
  readonly totalFees: Decimal;
  readonly trades: readonly Trade[];
  readonly peakEquity: Decimal;
}

export class PortfolioTracker {
  private cashBalance: Decimal;
  private position: Decimal = ZERO;
  private avgEntryPrice: Decimal = ZERO;
  private totalFees: Decimal = ZERO;
  private _trades: Trade[] = [];
  private peakEquity: Decimal;
  private currentEntryFill: SimulatedFill | null = null;

  constructor(initialCapital: string) {
    this.cashBalance = d(initialCapital);
    this.peakEquity = this.cashBalance;
  }

  /**
   * Apply a simulated fill to the portfolio state.
   *
   * State machine:
   * - Buy when flat: open long position
   * - Sell when flat: open short position
   * - Sell when long / Buy when short: close position (create trade)
   * - Buy when already long / Sell when already short: ignored
   * - Reversal (long->short or short->long via close signal then new): handled
   */
  applyFill(fill: SimulatedFill): void {
    const direction = fill.signal.direction;

    if (direction === 'close') {
      this.closePosition(fill);
      return;
    }

    if (direction === 'long') {
      if (this.isLong()) {
        // Already long, ignore
        return;
      }
      if (this.isShort()) {
        // Reversal: close short, then open long
        this.closePosition(fill);
        this.openLong(fill);
        return;
      }
      // Flat -> open long
      this.openLong(fill);
      return;
    }

    if (direction === 'short') {
      if (this.isShort()) {
        // Already short, ignore
        return;
      }
      if (this.isLong()) {
        // Reversal: close long, then open short
        this.closePosition(fill);
        this.openShort(fill);
        return;
      }
      // Flat -> open short
      this.openShort(fill);
      return;
    }
  }

  /**
   * Calculate current equity: cashBalance + position * currentPrice.
   * For shorts, position is negative, so equity = cash + (negative * price).
   */
  equity(currentPrice: Decimal): Decimal {
    return this.cashBalance.plus(this.position.mul(currentPrice));
  }

  /** Get a readonly snapshot of the current portfolio state. */
  getState(): PortfolioState {
    return {
      cashBalance: this.cashBalance,
      position: this.position,
      avgEntryPrice: this.avgEntryPrice,
      totalFees: this.totalFees,
      trades: [...this._trades],
      peakEquity: this.peakEquity,
    };
  }

  /** Get the list of completed trades. */
  get trades(): readonly Trade[] {
    return this._trades;
  }

  isFlat(): boolean {
    return this.position.isZero();
  }

  isLong(): boolean {
    return this.position.gt(ZERO);
  }

  isShort(): boolean {
    return this.position.lt(ZERO);
  }

  // ── Private helpers ─────────────────────────────────────────────────

  private openLong(fill: SimulatedFill): void {
    // Deduct cost: quantity * fillPrice + fee
    const cost = fill.quantity.mul(fill.fillPrice).plus(fill.fee);
    this.cashBalance = this.cashBalance.minus(cost);
    this.position = fill.quantity;
    this.avgEntryPrice = fill.fillPrice;
    this.totalFees = this.totalFees.plus(fill.fee);
    this.currentEntryFill = fill;
  }

  private openShort(fill: SimulatedFill): void {
    // Add proceeds: quantity * fillPrice - fee
    const proceeds = fill.quantity.mul(fill.fillPrice).minus(fill.fee);
    this.cashBalance = this.cashBalance.plus(proceeds);
    this.position = fill.quantity.neg(); // negative for short
    this.avgEntryPrice = fill.fillPrice;
    this.totalFees = this.totalFees.plus(fill.fee);
    this.currentEntryFill = fill;
  }

  private closePosition(fill: SimulatedFill): void {
    if (this.isFlat()) return;

    const entryFill = this.currentEntryFill;
    if (!entryFill) return;

    let pnl: Decimal;

    if (this.isLong()) {
      // Closing long: sell proceeds - buy cost
      const exitProceeds = fill.quantity.mul(fill.fillPrice).minus(fill.fee);
      const entryCost = this.position.mul(this.avgEntryPrice).plus(entryFill.fee);
      pnl = exitProceeds.minus(entryCost);
      this.cashBalance = this.cashBalance.plus(exitProceeds);
    } else {
      // Closing short: buy back cost deducted
      // PnL = entry proceeds - exit cost
      const exitCost = fill.quantity.mul(fill.fillPrice).plus(fill.fee);
      this.cashBalance = this.cashBalance.minus(exitCost);
      const entryProceeds = this.position.abs().mul(this.avgEntryPrice).minus(entryFill.fee);
      pnl = entryProceeds.minus(exitCost);
    }

    this.totalFees = this.totalFees.plus(fill.fee);

    const pnlPct = pnl.div(this.position.abs().mul(this.avgEntryPrice)).mul(100);

    const trade: Trade = {
      entryFill,
      exitFill: fill,
      pnl,
      pnlPct,
      holdingPeriodMs: fill.fillTimestamp - entryFill.fillTimestamp,
    };

    this._trades.push(trade);
    this.position = ZERO;
    this.avgEntryPrice = ZERO;
    this.currentEntryFill = null;

    // Update peak equity (use fill price as current price approximation)
    const currentEquity = this.equity(fill.fillPrice);
    if (currentEquity.gt(this.peakEquity)) {
      this.peakEquity = currentEquity;
    }
  }
}
