/**
 * Unit tests for FeedHealthMonitor -- per-instrument feed freshness tracker.
 *
 * Uses vi.useFakeTimers() + vi.setSystemTime() for deterministic time control.
 * Each test calls monitor.stop() to clean up the interval timer.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FeedHealthMonitor } from '../feed-health.js';
import type { FeedHealthState, FeedStatus } from '../feed-health.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Create a monitor with a 100ms expected interval for fast tests. */
function makeMonitor(opts?: { staleMultiplier?: number; deadMultiplier?: number; checkIntervalMs?: number }) {
  return new FeedHealthMonitor({
    staleMultiplier: opts?.staleMultiplier ?? 2.5,
    deadMultiplier: opts?.deadMultiplier ?? 5,
    checkIntervalMs: opts?.checkIntervalMs ?? 50,
  });
}

/** Collect healthChange events into an array. */
function collectEvents(monitor: FeedHealthMonitor): FeedHealthState[] {
  const events: FeedHealthState[] = [];
  monitor.on('healthChange', (state: FeedHealthState) => events.push(state));
  return events;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('FeedHealthMonitor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-22T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // 1. Registration and default state
  it('registers an instrument with LIVE status and no timestamps', () => {
    const monitor = makeMonitor();
    monitor.register('BTC-USD', 100);

    expect(monitor.getStatus('BTC-USD')).toBe('LIVE');
    expect(monitor.isStale('BTC-USD')).toBe(false);

    const statuses = monitor.getAllStatuses();
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({
      instrument: 'BTC-USD',
      status: 'LIVE',
      lastCandleAt: null,
      lastMarkPriceAt: null,
      expectedIntervalMs: 100,
    });

    monitor.stop();
  });

  // 2. onCandle updates lastCandleAt
  it('updates lastCandleAt on onCandle()', () => {
    const monitor = makeMonitor();
    monitor.register('BTC-USD', 100);

    const beforeCandle = Date.now();
    monitor.onCandle('BTC-USD');

    const statuses = monitor.getAllStatuses();
    expect(statuses[0].lastCandleAt).toBe(beforeCandle);

    monitor.stop();
  });

  // 3. onMarkPrice updates lastMarkPriceAt
  it('updates lastMarkPriceAt on onMarkPrice()', () => {
    const monitor = makeMonitor();
    monitor.register('BTC-USD', 100);

    const beforeMarkPrice = Date.now();
    monitor.onMarkPrice('BTC-USD');

    const statuses = monitor.getAllStatuses();
    expect(statuses[0].lastMarkPriceAt).toBe(beforeMarkPrice);

    monitor.stop();
  });

  // 4. LIVE -> STALE transition
  it('transitions LIVE -> STALE after 2.5x expected interval', () => {
    const monitor = makeMonitor({ checkIntervalMs: 10 });
    const events = collectEvents(monitor);

    monitor.register('BTC-USD', 100);
    monitor.onCandle('BTC-USD');
    monitor.start();

    // Advance past stale threshold: 2.5 * 100 = 250ms, add margin
    vi.advanceTimersByTime(260);

    expect(monitor.getStatus('BTC-USD')).toBe('STALE');
    expect(monitor.isStale('BTC-USD')).toBe(true);
    expect(events.length).toBeGreaterThanOrEqual(1);

    const staleEvent = events.find((e) => e.status === 'STALE');
    expect(staleEvent).toBeDefined();
    expect(staleEvent!.instrument).toBe('BTC-USD');

    monitor.stop();
  });

  // 5. STALE -> DEAD transition
  it('transitions STALE -> DEAD after 5x expected interval', () => {
    const monitor = makeMonitor({ checkIntervalMs: 10 });
    const events = collectEvents(monitor);

    monitor.register('BTC-USD', 100);
    monitor.onCandle('BTC-USD');
    monitor.start();

    // Advance past dead threshold: 5 * 100 = 500ms, add margin
    vi.advanceTimersByTime(510);

    expect(monitor.getStatus('BTC-USD')).toBe('DEAD');
    expect(monitor.isStale('BTC-USD')).toBe(true);

    const deadEvent = events.find((e) => e.status === 'DEAD');
    expect(deadEvent).toBeDefined();
    expect(deadEvent!.instrument).toBe('BTC-USD');

    monitor.stop();
  });

  // 6. Recovery STALE -> LIVE
  it('recovers from STALE to LIVE when fresh candle arrives', () => {
    const monitor = makeMonitor({ checkIntervalMs: 10 });
    const events = collectEvents(monitor);

    monitor.register('BTC-USD', 100);
    monitor.onCandle('BTC-USD');
    monitor.start();

    // Go stale
    vi.advanceTimersByTime(260);
    expect(monitor.getStatus('BTC-USD')).toBe('STALE');

    // Simulate fresh candle arrival
    monitor.onCandle('BTC-USD');

    // Next check should detect recovery
    vi.advanceTimersByTime(10);
    expect(monitor.getStatus('BTC-USD')).toBe('LIVE');

    const liveEvent = events.find((e) => e.status === 'LIVE');
    expect(liveEvent).toBeDefined();
    expect(liveEvent!.instrument).toBe('BTC-USD');

    monitor.stop();
  });

  // 7. Perp instrument uses best of candle and markPrice
  it('stays LIVE when markPrice is fresh even if candle is old (perp best-of)', () => {
    const monitor = makeMonitor({ checkIntervalMs: 10 });

    monitor.register('BTC-PERP', 100);
    monitor.onCandle('BTC-PERP');
    monitor.start();

    // Advance past stale threshold for candle only
    vi.advanceTimersByTime(200);

    // Send fresh markPrice -- should keep instrument alive
    monitor.onMarkPrice('BTC-PERP');

    // Next check should see markPrice is fresh
    vi.advanceTimersByTime(20);
    expect(monitor.getStatus('BTC-PERP')).toBe('LIVE');
    expect(monitor.isStale('BTC-PERP')).toBe(false);

    monitor.stop();
  });

  // 8. No data yet = stays LIVE
  it('stays LIVE when no data has been received yet (just registered)', () => {
    const monitor = makeMonitor({ checkIntervalMs: 10 });

    monitor.register('BTC-USD', 100);
    monitor.start();

    // Advance well past any threshold
    vi.advanceTimersByTime(1000);

    // Should stay LIVE because no candle/markPrice received yet
    expect(monitor.getStatus('BTC-USD')).toBe('LIVE');
    expect(monitor.isStale('BTC-USD')).toBe(false);

    monitor.stop();
  });

  // 9. Unregistered instrument returns LIVE defensively
  it('returns LIVE for unregistered instrument (defensive default)', () => {
    const monitor = makeMonitor();

    expect(monitor.getStatus('UNKNOWN-PAIR')).toBe('LIVE');
    expect(monitor.isStale('UNKNOWN-PAIR')).toBe(false);

    monitor.stop();
  });

  // 10. stop() clears timer -- no more checks fire
  it('stops checking when stop() is called', () => {
    const monitor = makeMonitor({ checkIntervalMs: 10 });

    monitor.register('BTC-USD', 100);
    monitor.onCandle('BTC-USD');
    monitor.start();
    monitor.stop();

    // Advance well past stale threshold -- but no checks should fire
    vi.advanceTimersByTime(1000);

    expect(monitor.getStatus('BTC-USD')).toBe('LIVE');
    expect(monitor.isStale('BTC-USD')).toBe(false);
  });

  // Additional: healthChange does NOT emit when status stays the same
  it('does not emit healthChange when status stays the same', () => {
    const monitor = makeMonitor({ checkIntervalMs: 10 });
    const events = collectEvents(monitor);

    monitor.register('BTC-USD', 100);
    monitor.onCandle('BTC-USD');
    monitor.start();

    // Run several check cycles while still LIVE (within threshold)
    vi.advanceTimersByTime(100);

    // No events should fire -- status stayed LIVE
    expect(events).toHaveLength(0);

    monitor.stop();
  });

  // Additional: onCandle/onMarkPrice for unregistered instrument is a no-op
  it('ignores onCandle/onMarkPrice for unregistered instruments', () => {
    const monitor = makeMonitor();

    // Should not throw
    monitor.onCandle('UNKNOWN');
    monitor.onMarkPrice('UNKNOWN');

    expect(monitor.getAllStatuses()).toHaveLength(0);
    monitor.stop();
  });
});
