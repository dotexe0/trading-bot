/**
 * Tests for SpotSignalGate -- fee-drag pre-entry filter for spot entries.
 *
 * Mirrors PerpRiskGate Check 4 test structure but for the synchronous
 * spot-specific gate that uses spot taker fee rates.
 */
import { describe, it, expect } from 'vitest';
import { SpotSignalGate } from '../spot-signal-gate.js';
import { d } from '../../core/decimal.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeGate(takerFeeRate = 0.0075, feeDragMultiple = 2.0): SpotSignalGate {
  return new SpotSignalGate({ takerFeeRate, feeDragMultiple });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('SpotSignalGate', () => {

  describe('rejection (lte semantics)', () => {
    it('rejects when expectedMove equals roundTripFee exactly', () => {
      // takerRate=0.0075, price=50000 -> roundTripFee = 2*0.0075*50000 = 750
      // feeDragMultiple=2.0, so atr that makes expectedMove = 750 -> atr = 750/2 = 375
      const gate = makeGate(0.0075, 2.0);
      const result = gate.check(d('375'), d('50000'), d('1000'));
      expect(result.approved).toBe(false);
      expect(result.reason).toBe('SPOT_FEE_DRAG');
    });

    it('rejects when expectedMove is less than roundTripFee', () => {
      // roundTripFee = 750, atr=200 -> expectedMove = 200*2 = 400 < 750
      const gate = makeGate(0.0075, 2.0);
      const result = gate.check(d('200'), d('50000'), d('1000'));
      expect(result.approved).toBe(false);
      expect(result.reason).toBe('SPOT_FEE_DRAG');
    });

    it('approves when expectedMove exceeds roundTripFee', () => {
      // roundTripFee = 750, atr=500 -> expectedMove = 500*2 = 1000 > 750
      const gate = makeGate(0.0075, 2.0);
      const result = gate.check(d('500'), d('50000'), d('1000'));
      expect(result.approved).toBe(true);
      expect(result.reason).toBeUndefined();
    });
  });

  describe('permissive default (ATR unavailable)', () => {
    it('approves with permissive default when ATR is null', () => {
      const gate = makeGate(0.0075, 2.0);
      const result = gate.check(null, d('50000'), d('1000'));
      expect(result.approved).toBe(true);
    });

    it('approves with permissive default when ATR is zero', () => {
      const gate = makeGate(0.0075, 2.0);
      const result = gate.check(d('0'), d('50000'), d('1000'));
      expect(result.approved).toBe(true);
    });
  });

  describe('feeDragMultiple effect', () => {
    it('uses correct fee-drag multiple in calculation (multiple=3.0)', () => {
      // takerRate=0.0075, price=50000 -> roundTripFee = 750
      // With multiple=3.0: atr=200 -> expectedMove = 200*3 = 600 < 750 => rejected
      const gate = makeGate(0.0075, 3.0);
      const result = gate.check(d('200'), d('50000'), d('1000'));
      expect(result.approved).toBe(false);

      // With multiple=3.0: atr=300 -> expectedMove = 300*3 = 900 > 750 => approved
      const result2 = gate.check(d('300'), d('50000'), d('1000'));
      expect(result2.approved).toBe(true);
    });
  });

  describe('rejection details', () => {
    it('returns SPOT_FEE_DRAG as reason on rejection', () => {
      const gate = makeGate(0.0075, 2.0);
      const result = gate.check(d('200'), d('50000'), d('1000'));
      expect(result.approved).toBe(false);
      expect(result.reason).toBe('SPOT_FEE_DRAG');
    });

    it('returns structured details with expectedMove, roundTripFee, atr, feeDragMultiple on rejection', () => {
      const gate = makeGate(0.0075, 2.0);
      const result = gate.check(d('200'), d('50000'), d('1000'));
      expect(result.approved).toBe(false);
      expect(result.details).toEqual({
        expectedMove: '400',   // 200 * 2.0 = 400
        roundTripFee: '750',   // 2 * 0.0075 * 50000 = 750
        atr: '200',
        feeDragMultiple: '2',
      });
    });
  });
});
