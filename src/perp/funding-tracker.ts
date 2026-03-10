/**
 * FundingRateTracker — pure stateful accumulator for perpetual futures funding costs.
 *
 * No EventEmitter, no I/O. All arithmetic uses d() from src/core/decimal.ts
 * (Decimal.js wrapper — never floats).
 *
 * Invariants:
 *  - cumulativeCost accumulates every non-stale fundingRate payment
 *  - Session ID guard: cost resets when a new session starts
 *  - drainTriggered fires only when cumulative cost is negative (paying) and
 *    abs(cumulativeCost) / notional >= drainThresholdPct
 *  - Receiving funding (positive cumulativeCost) is never a drain
 *
 * Mirror of TrailingStopManager structure — pure class, no side effects.
 */

import { d } from '../core/decimal.js';
import { createModuleLogger } from '../core/logger.js';
import type { IntxFundingRateEvent, PerpSession } from './types.js';

const log = createModuleLogger('funding-tracker');

// ── Public types ──────────────────────────────────────────────────────

export interface FundingRateTrackerOptions {
  /** Fraction of position notional at which drain triggers (e.g. 0.005 = 0.5%). */
  drainThresholdPct: number;
}

export interface FundingUpdate {
  /** Funding rate from this event (pass-through from evt.fundingRate). */
  currentFundingRate: string;
  /** Accumulated funding cost across all non-stale events this session. */
  cumulativeFundingCost: string;
  /** abs(cumulativeCost) / (size * entryPrice) — always non-negative. */
  cumulativeFundingPct: string;
  /**
   * True when cumulativeFundingPct >= drainThresholdPct AND cumulativeCost is
   * negative (position is being drained, not enriched).
   */
  drainTriggered: boolean;
}

// ── FundingRateTracker ────────────────────────────────────────────────

export class FundingRateTracker {
  private readonly drainThresholdPct: string;
  private cumulativeCost = d('0');
  private sessionId: string | null = null;

  constructor(opts: FundingRateTrackerOptions) {
    this.drainThresholdPct = String(opts.drainThresholdPct);
  }

  /**
   * Process an IntxFundingRateEvent against the current perp session.
   *
   * Stale events are returned early with the current state and drainTriggered=false.
   * A new session ID triggers a cost reset before accumulating.
   */
  onFundingEvent(evt: IntxFundingRateEvent, session: PerpSession): FundingUpdate {
    // 1. Stale gate — return current state, no accumulation, drain=false
    if (evt.isStale) {
      const notional = d(session.size).mul(d(session.entryPrice));
      const pct = notional.isZero() ? d('0') : this.cumulativeCost.abs().div(notional);
      return {
        currentFundingRate: evt.fundingRate,
        cumulativeFundingCost: this.cumulativeCost.toFixed(8),
        cumulativeFundingPct: pct.toFixed(8),
        drainTriggered: false,
      };
    }

    // 2. Session ID guard
    if (this.sessionId !== session.id) {
      // New session (or first call where sessionId is null) — reset accumulator
      this.cumulativeCost = d('0');
      this.sessionId = session.id;
    }

    // 3. Accumulate
    this.cumulativeCost = this.cumulativeCost.plus(d(evt.fundingRate));

    // 4. Compute notional and pct
    const notional = d(session.size).mul(d(session.entryPrice));
    const pct = notional.isZero() ? d('0') : this.cumulativeCost.abs().div(notional);

    // 5. Drain triggers only when position is being drained (paying = negative cost)
    const isPaying = this.cumulativeCost.isNegative();
    const drainTriggered = isPaying && pct.gte(d(this.drainThresholdPct));

    // 6. Log
    log.debug({
      sessionId: this.sessionId,
      instrument: evt.instrument,
      currentFundingRate: evt.fundingRate,
      cumulativeFundingCost: this.cumulativeCost.toFixed(8),
      cumulativeFundingPct: `${pct.mul(d('100')).toFixed(4)}%`,
    }, 'funding event processed');

    // 7. Return
    return {
      currentFundingRate: evt.fundingRate,
      cumulativeFundingCost: this.cumulativeCost.toFixed(8),
      cumulativeFundingPct: pct.toFixed(8),
      drainTriggered,
    };
  }

  /** Reset cumulativeCost to zero and clear sessionId. */
  reset(): void {
    this.cumulativeCost = d('0');
    this.sessionId = null;
  }

  /** Current accumulated funding cost as a fixed-8 decimal string. */
  getCumulativeCost(): string {
    return this.cumulativeCost.toFixed(8);
  }
}
