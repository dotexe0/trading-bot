/**
 * TrailingStopManager — pure ratchet logic for ATR-based trailing stop-limit orders.
 *
 * No EventEmitter, no I/O. All price arithmetic uses d() from src/core/decimal.ts
 * (Decimal.js wrapper — never floats).
 *
 * Invariants:
 *  - For long positions: stopPrice only ever increases (never retreats downward)
 *  - For short positions: stopPrice only ever decreases (never retreats upward)
 *  - trailDist = atr * atrMultiplier (recalculated on each ratchet with latest ATR)
 *  - limitPrice = stopPrice * (1 ± slippagePct) — below stop for long, above for short
 */

import { d } from '../core/decimal.js';
import type { PerpDirection } from './types.js';

export interface TrailingStopState {
  stopPrice: string;      // current ratcheted stop trigger price
  limitPrice: string;     // stop_limit limit offset = stopPrice * (1 - slippagePct) for long
  trailDist: string;      // fixed trail distance = atr * atrMultiplier
}

export class TrailingStopManager {
  private state: TrailingStopState | null = null;
  private readonly direction: PerpDirection;
  private readonly atrMultiplier: string;
  private readonly slippagePct: string;
  private _ratchetInProgress = false;
  private _pendingMarkPrice: string | null = null;

  constructor(opts: { direction: PerpDirection; atrMultiplier: number; slippagePct: number }) {
    this.direction = opts.direction;
    this.atrMultiplier = String(opts.atrMultiplier);
    this.slippagePct = String(opts.slippagePct / 100); // convert pct to ratio
  }

  /**
   * Initialize stop placement after entry fills.
   * Sets initial stopPrice based on entryPrice and ATR trail distance.
   *
   * long:  stopPrice = entryPrice - (atr * atrMultiplier)  — below entry
   * short: stopPrice = entryPrice + (atr * atrMultiplier)  — above entry
   */
  initialize(entryPrice: string, atr: string): TrailingStopState {
    const entry = d(entryPrice);
    const trailDist = d(atr).mul(d(this.atrMultiplier));

    let stop: ReturnType<typeof d>;
    if (this.direction === 'long') {
      stop = entry.minus(trailDist); // initial stop below entry
    } else {
      stop = entry.plus(trailDist);  // initial stop above entry (short)
    }

    const limit = this._computeLimit(stop);
    this.state = {
      stopPrice: stop.toFixed(8),
      limitPrice: limit.toFixed(8),
      trailDist: trailDist.toFixed(8),
    };
    return { ...this.state };
  }

  /**
   * Ratchet stop price based on new mark price.
   * Returns new state if the stop moved, null if no change needed.
   *
   * Thread-safe: uses _ratchetInProgress guard + _pendingMarkPrice queue.
   * The queued price is processed after the current ratchet completes.
   */
  ratchet(markPrice: string, atr: string): TrailingStopState | null {
    if (!this.state) throw new Error('TrailingStopManager: not initialized');

    // Queue if ratchet in progress
    if (this._ratchetInProgress) {
      this._pendingMarkPrice = markPrice;
      return null;
    }

    this._ratchetInProgress = true;
    try {
      return this._doRatchet(markPrice, atr);
    } finally {
      this._ratchetInProgress = false;
      // Process queued price
      if (this._pendingMarkPrice !== null) {
        const queued = this._pendingMarkPrice;
        this._pendingMarkPrice = null;
        this.ratchet(queued, atr);
      }
    }
  }

  private _doRatchet(markPrice: string, atr: string): TrailingStopState | null {
    const mark = d(markPrice);
    const trailDist = d(atr).mul(d(this.atrMultiplier));
    const currentStop = d(this.state!.stopPrice);

    let candidateStop: ReturnType<typeof d>;
    if (this.direction === 'long') {
      candidateStop = mark.minus(trailDist);
      // Only ratchet upward (never retreat for long)
      if (candidateStop.lte(currentStop)) return null;
    } else {
      candidateStop = mark.plus(trailDist);
      // Only ratchet downward (never retreat for short)
      if (candidateStop.gte(currentStop)) return null;
    }

    const limit = this._computeLimit(candidateStop);
    this.state = {
      stopPrice: candidateStop.toFixed(8),
      limitPrice: limit.toFixed(8),
      trailDist: trailDist.toFixed(8),
    };
    return { ...this.state };
  }

  private _computeLimit(stop: ReturnType<typeof d>): ReturnType<typeof d> {
    const slip = d(this.slippagePct);
    if (this.direction === 'long') {
      return stop.mul(d('1').minus(slip)); // limit slightly below stop for long
    } else {
      return stop.mul(d('1').plus(slip));  // limit slightly above stop for short
    }
  }

  getState(): TrailingStopState | null {
    return this.state ? { ...this.state } : null;
  }

  reset(): void {
    this.state = null;
    this._ratchetInProgress = false;
    this._pendingMarkPrice = null;
  }
}
