/**
 * SpotSignalGate -- pre-entry fee-drag filter for spot trading signals.
 *
 * Mirrors PerpRiskGate Check 4 for spot entries: rejects when the
 * ATR-estimated expected move does not exceed a configurable multiple
 * of the round-trip taker fee.
 *
 * Key differences from PerpRiskGate:
 *  - Synchronous (no REST calls needed for spot)
 *  - Uses spot taker fee rate (0.0075), NOT the FCM rate (0.0003)
 *  - Permissive default when ATR is null or zero (approves entry)
 *
 * Satisfies: SIG-01, FEES-04 (feeDragMultiple is a FIXED CONSTANT)
 */

import { d, ZERO } from '../core/decimal.js';
import type Decimal from 'decimal.js';
import { createModuleLogger } from '../core/logger.js';

const log = createModuleLogger('spot-signal-gate');

/** Options for SpotSignalGate constructor. */
export interface SpotSignalGateOptions {
  /** Spot taker fee rate (e.g., 0.0075 for Coinbase Intro 2). NOT the FCM rate. */
  takerFeeRate: number;
  /** Fee drag multiple -- FIXED CONSTANT per FEES-04 rule. Never swept as optimizer param. */
  feeDragMultiple: number;
}

/** Result of a SpotSignalGate check. */
export interface SpotGateResult {
  approved: boolean;
  reason?: string;
  details: Record<string, string>;
}

export class SpotSignalGate {
  private readonly _takerRate: number;
  private readonly _multiple: number;

  constructor(options: SpotSignalGateOptions) {
    this._takerRate = options.takerFeeRate;
    this._multiple = options.feeDragMultiple;
  }

  /**
   * Check whether an entry signal should be approved based on fee-drag analysis.
   *
   * @param atr - Current ATR value (null when unavailable)
   * @param price - Current asset price
   * @param notional - Estimated position notional value
   * @returns SpotGateResult with approved/rejected status and details
   */
  check(atr: Decimal | null, price: Decimal, notional: Decimal): SpotGateResult {
    // Permissive default: approve when ATR is unavailable or zero
    if (atr === null || atr.isZero()) {
      log.debug(
        { price: price.toString(), event: 'spot-fee-gate-permissive' },
        'ATR unavailable or zero -- permissive approval',
      );
      return { approved: true, details: {} };
    }

    const expectedMove = atr.mul(d(String(this._multiple)));
    const roundTripFee = d(String(this._takerRate)).mul(d('2')).mul(notional);

    if (expectedMove.lte(roundTripFee)) {
      log.info(
        {
          expectedMove: expectedMove.toString(),
          roundTripFee: roundTripFee.toString(),
          atr: atr.toString(),
          feeDragMultiple: this._multiple,
          event: 'spot-fee-gate-blocked',
        },
        'SPOT_FEE_DRAG: entry rejected -- expected move does not exceed round-trip fee',
      );
      return {
        approved: false,
        reason: 'SPOT_FEE_DRAG',
        details: {
          expectedMove: expectedMove.toString(),
          roundTripFee: roundTripFee.toString(),
          atr: atr.toString(),
          feeDragMultiple: String(this._multiple),
        },
      };
    }

    return { approved: true, details: {} };
  }
}
