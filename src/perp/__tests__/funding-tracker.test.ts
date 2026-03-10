import { describe, it, expect, beforeEach } from 'vitest';
import { FundingRateTracker } from '../funding-tracker.js';
import type { IntxFundingRateEvent } from '../types.js';
import type { PerpSession } from '../types.js';

// ── Helpers ───────────────────────────────────────────────────────────

function makeSession(overrides: Partial<PerpSession> = {}): PerpSession {
  return {
    id: 's1',
    instrument: 'BIP-20DEC30-CDE',
    direction: 'long',
    entryPrice: '100000',
    size: '0.1',
    leverage: 5,
    liquidationPrice: '85000',
    maintenanceMarginRate: '0.0333',
    status: 'open',
    openedAt: Date.now(),
    ...overrides,
  };
}

function makeEvent(overrides: Partial<IntxFundingRateEvent> = {}): IntxFundingRateEvent {
  return {
    instrument: 'FCM',
    fundingRate: '-25',
    isFinal: true,
    timestamp: Date.now(),
    isStale: false,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('FundingRateTracker', () => {
  let tracker: FundingRateTracker;
  const session = makeSession(); // size=0.1, entryPrice=100000, notional=10000

  beforeEach(() => {
    tracker = new FundingRateTracker({ drainThresholdPct: 0.005 });
  });

  // ── Accumulation ──────────────────────────────────────────────────

  it('accumulates a single funding payment', () => {
    const result = tracker.onFundingEvent(makeEvent({ fundingRate: '-50' }), session);

    expect(result.currentFundingRate).toBe('-50');
    expect(result.cumulativeFundingCost).toBe('-50.00000000');
    expect(result.cumulativeFundingPct).toBe('0.00500000'); // abs(50) / 10000
  });

  it('accumulates two equal funding payments', () => {
    tracker.onFundingEvent(makeEvent({ fundingRate: '-25' }), session);
    const result = tracker.onFundingEvent(makeEvent({ fundingRate: '-25' }), session);

    expect(result.cumulativeFundingCost).toBe('-50.00000000');
    expect(result.cumulativeFundingPct).toBe('0.00500000'); // abs(50) / 10000
  });

  it('accumulates positive (receiving) funding payment', () => {
    const result = tracker.onFundingEvent(makeEvent({ fundingRate: '10' }), session);

    expect(result.cumulativeFundingCost).toBe('10.00000000');
    expect(result.cumulativeFundingPct).toBe('0.00100000'); // abs(10) / 10000
  });

  // ── Drain trigger ─────────────────────────────────────────────────

  it('triggers drain when cumulativePct meets threshold (rate=-50, threshold=0.005)', () => {
    const result = tracker.onFundingEvent(makeEvent({ fundingRate: '-50' }), session);

    expect(result.drainTriggered).toBe(true);
  });

  it('does not trigger drain when cumulativePct is below threshold (rate=-25)', () => {
    const result = tracker.onFundingEvent(makeEvent({ fundingRate: '-25' }), session);

    // abs(-25)/10000 = 0.0025 < 0.005
    expect(result.drainTriggered).toBe(false);
  });

  it('triggers drain when two payments accumulate to threshold (2x -25)', () => {
    tracker.onFundingEvent(makeEvent({ fundingRate: '-25' }), session);
    const result = tracker.onFundingEvent(makeEvent({ fundingRate: '-25' }), session);

    expect(result.drainTriggered).toBe(true);
  });

  it('does not trigger drain for receiving (positive) funding even if abs exceeds threshold', () => {
    // A receiving payment of +50 means pct = abs(50)/10000 = 0.005 which hits threshold
    // But drain = position being drained — receiving is enriching, not draining
    // The implementation uses abs() so this WILL trigger drain (abs >= threshold)
    // The plan says: drain triggers on abs() >= threshold regardless of direction
    // However plan NOTE says: "Receiving funding (positive cumulativeCost) does NOT trigger drain"
    // Re-reading: "drainTriggered = cumulativeFundingPct >= drainThresholdPct" — uses abs() already
    // The behavior note says positive rate drain=false even at threshold
    // This contradicts the abs() formula. The plan behavior says:
    // "Positive rate evt.fundingRate='10' (receiving) → pct=0.001, drain=false (receiving not draining)"
    // At rate=10, pct=0.001 which is < threshold 0.005, so drain=false — not a contradiction.
    // The NOTE says receiving does NOT trigger drain, but that may mean: abs() is used for pct calc
    // but drainTriggered only fires when cumulativeCost is negative (paying).
    // Let's re-read implementation spec:
    // "drainTriggered = pct.gte(d(drainThresholdPct))" — no sign check mentioned
    // But behavior NOTE says: "Receiving funding (positive cumulativeCost) does NOT trigger drain"
    // We must honor the NOTE which is the authoritative design intent.
    // Implementation will guard: drainTriggered only when cumulativeCost is negative.
    const largePositive = tracker.onFundingEvent(makeEvent({ fundingRate: '50' }), session);
    // pct = 0.005 >= threshold BUT positive (receiving) — no drain
    expect(largePositive.drainTriggered).toBe(false);
  });

  // ── Stale events ──────────────────────────────────────────────────

  it('does not accumulate cost for stale events', () => {
    // Send one normal event to establish cost
    tracker.onFundingEvent(makeEvent({ fundingRate: '-25' }), session);
    // Then a stale event — should NOT accumulate
    const result = tracker.onFundingEvent(makeEvent({ fundingRate: '-25', isStale: true }), session);

    expect(result.cumulativeFundingCost).toBe('-25.00000000');
  });

  it('returns drainTriggered=false for stale events even if cumulative would trigger', () => {
    // Accumulate to threshold
    tracker.onFundingEvent(makeEvent({ fundingRate: '-50' }), session);
    // Now a stale event
    const result = tracker.onFundingEvent(makeEvent({ fundingRate: '-50', isStale: true }), session);

    expect(result.drainTriggered).toBe(false);
  });

  it('returns current state (not zero) for stale events', () => {
    tracker.onFundingEvent(makeEvent({ fundingRate: '-25' }), session);
    const result = tracker.onFundingEvent(makeEvent({ fundingRate: '-999', isStale: true }), session);

    // Cost stays at -25 from first event
    expect(result.cumulativeFundingCost).toBe('-25.00000000');
    expect(result.currentFundingRate).toBe('-999'); // still reports the event rate
  });

  // ── Session ID guard ──────────────────────────────────────────────

  it('resets cumulativeCost when session ID changes', () => {
    const session1 = makeSession({ id: 's1' });
    const session2 = makeSession({ id: 's2' });

    // Accumulate on session1
    tracker.onFundingEvent(makeEvent({ fundingRate: '-50' }), session1);
    // Switch to session2 — should reset
    const result = tracker.onFundingEvent(makeEvent({ fundingRate: '-25' }), session2);

    // After reset, only the new payment counts
    expect(result.cumulativeFundingCost).toBe('-25.00000000');
  });

  it('continues accumulating when session ID stays the same', () => {
    const session1 = makeSession({ id: 's1' });

    tracker.onFundingEvent(makeEvent({ fundingRate: '-25' }), session1);
    const result = tracker.onFundingEvent(makeEvent({ fundingRate: '-10' }), session1);

    expect(result.cumulativeFundingCost).toBe('-35.00000000');
  });

  it('initializes session ID on first call (null → session.id)', () => {
    // Tracker starts with null sessionId — first call should set it without reset
    const result = tracker.onFundingEvent(makeEvent({ fundingRate: '-25' }), session);

    expect(result.cumulativeFundingCost).toBe('-25.00000000');
  });

  // ── reset() ───────────────────────────────────────────────────────

  it('reset() zeroes cumulativeCost', () => {
    tracker.onFundingEvent(makeEvent({ fundingRate: '-50' }), session);
    tracker.reset();

    expect(tracker.getCumulativeCost()).toBe('0.00000000');
  });

  it('reset() clears sessionId so next call initializes fresh', () => {
    tracker.onFundingEvent(makeEvent({ fundingRate: '-50' }), session);
    tracker.reset();
    // After reset, a new session should start fresh without triggering reset branch
    const result = tracker.onFundingEvent(makeEvent({ fundingRate: '-10' }), makeSession({ id: 's2' }));

    expect(result.cumulativeFundingCost).toBe('-10.00000000');
  });

  it('reset() allows drain to trigger again after reset and re-accumulation', () => {
    tracker.onFundingEvent(makeEvent({ fundingRate: '-50' }), session);
    tracker.reset();
    const result = tracker.onFundingEvent(makeEvent({ fundingRate: '-50' }), session);

    expect(result.drainTriggered).toBe(true);
  });

  // ── getCumulativeCost() ────────────────────────────────────────────

  it('getCumulativeCost() returns 0.00000000 on fresh tracker', () => {
    expect(tracker.getCumulativeCost()).toBe('0.00000000');
  });

  it('getCumulativeCost() returns accumulated value after events', () => {
    tracker.onFundingEvent(makeEvent({ fundingRate: '-25' }), session);
    tracker.onFundingEvent(makeEvent({ fundingRate: '-10' }), session);

    expect(tracker.getCumulativeCost()).toBe('-35.00000000');
  });

  // ── FundingUpdate shape ────────────────────────────────────────────

  it('FundingUpdate has correct shape with all required fields', () => {
    const result = tracker.onFundingEvent(makeEvent({ fundingRate: '-25' }), session);

    expect(result).toHaveProperty('currentFundingRate');
    expect(result).toHaveProperty('cumulativeFundingCost');
    expect(result).toHaveProperty('cumulativeFundingPct');
    expect(result).toHaveProperty('drainTriggered');
    expect(typeof result.currentFundingRate).toBe('string');
    expect(typeof result.cumulativeFundingCost).toBe('string');
    expect(typeof result.cumulativeFundingPct).toBe('string');
    expect(typeof result.drainTriggered).toBe('boolean');
  });

  // ── Edge cases ─────────────────────────────────────────────────────

  it('handles zero fundingRate without error', () => {
    const result = tracker.onFundingEvent(makeEvent({ fundingRate: '0' }), session);

    expect(result.cumulativeFundingCost).toBe('0.00000000');
    expect(result.drainTriggered).toBe(false);
  });

  it('handles notional calculation correctly (size=0.1, entryPrice=100000, notional=10000)', () => {
    // notional = 0.1 * 100000 = 10000
    // payment = -50 → pct = 50/10000 = 0.005
    const result = tracker.onFundingEvent(makeEvent({ fundingRate: '-50' }), session);
    expect(result.cumulativeFundingPct).toBe('0.00500000');
  });
});
