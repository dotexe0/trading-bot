/**
 * CrossAssetSignalBus — cross-asset signal confirmation for BTC/ETH.
 *
 * When both BTC and ETH emit signals in the same direction within a
 * staleness window, confidence is boosted. Opposing directions dampen.
 * Feeds into Phase 1's confidence-scaled sizing.
 *
 * Usage:
 *   const bus = new CrossAssetSignalBus();
 *   // In each engine's signal processing:
 *   bus.publish(pair, signal.direction, signal.confidence, timestamp);
 *   const adjustment = bus.getConfirmation(pair, signal.direction, timestamp);
 *   // adjustment: +0.15 (same dir), -0.10 (opposing), 0 (stale/missing)
 */

import type { TradingPair } from '../core/types.js';

export interface SignalEntry {
  direction: 'long' | 'short' | 'close';
  confidence: number;
  timestamp: number;
}

export interface CrossAssetSignalBusOptions {
  /** Max age in ms before a published signal is considered stale. Default: 1h. */
  stalenessMs?: number;
  /** Confidence boost when both assets agree on direction. Default: 0.15. */
  sameDirectionBoost?: number;
  /** Confidence penalty when assets disagree on direction. Default: 0.10. */
  opposingDirectionPenalty?: number;
}

export class CrossAssetSignalBus {
  private readonly signals = new Map<TradingPair, SignalEntry>();
  private readonly stalenessMs: number;
  private readonly sameDirectionBoost: number;
  private readonly opposingDirectionPenalty: number;

  constructor(options: CrossAssetSignalBusOptions = {}) {
    this.stalenessMs = options.stalenessMs ?? 3_600_000; // 1h
    this.sameDirectionBoost = options.sameDirectionBoost ?? 0.15;
    this.opposingDirectionPenalty = options.opposingDirectionPenalty ?? 0.10;
  }

  /**
   * Publish a signal for a trading pair. Called by each engine after signal emission.
   */
  publish(
    pair: TradingPair,
    direction: 'long' | 'short' | 'close',
    confidence: number,
    timestamp: number,
  ): void {
    this.signals.set(pair, { direction, confidence, timestamp });
  }

  /**
   * Get the cross-asset confirmation adjustment for a signal.
   *
   * Looks up the OTHER asset's most recent signal:
   *   - Same direction (long+long or short+short): +boost
   *   - Opposing direction (long+short or short+long): -penalty
   *   - 'close' direction from either side: 0 (no penalty)
   *   - Stale or missing: 0
   *
   * @returns Adjustment to add to confidence (can be negative).
   */
  getConfirmation(
    thisPair: TradingPair,
    thisDirection: 'long' | 'short' | 'close',
    now: number,
  ): number {
    // 'close' signals don't participate in cross-asset confirmation
    if (thisDirection === 'close') return 0;

    const otherPair = this.getOtherPair(thisPair);
    if (!otherPair) return 0;

    const other = this.signals.get(otherPair);
    if (!other) return 0;

    // Staleness check
    if (now - other.timestamp > this.stalenessMs) return 0;

    // 'close' from the other side doesn't penalize
    if (other.direction === 'close') return 0;

    // Same direction: boost
    if (thisDirection === other.direction) return this.sameDirectionBoost;

    // Opposing direction: dampen
    return -this.opposingDirectionPenalty;
  }

  /** Get the current state of all published signals (for dashboard display). */
  getState(): Map<TradingPair, SignalEntry> {
    return new Map(this.signals);
  }

  private getOtherPair(pair: TradingPair): TradingPair | null {
    if (pair === 'BTC-USD') return 'ETH-USD';
    if (pair === 'ETH-USD') return 'BTC-USD';
    return null;
  }
}
