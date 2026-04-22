/**
 * Unit tests for ActivityMonitor — engine-level silent-failure detector.
 *
 * Catches the class of bugs where data is flowing but the engine is stuck:
 *   - Phantom-session deadlock (position open, no signals emitted)
 *   - Strategy producing no signals for extended periods
 *   - Engine stopped processing candles (heartbeat stale)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ActivityMonitor } from '../activity-monitor.js';
import type { EngineActivity, ActivityAlert } from '../activity-monitor.js';

function makeEngine(initial: Partial<EngineActivity> = {}) {
  const metrics: EngineActivity = {
    name: 'perp-BTC',
    lastCandleProcessedAt: null,
    lastSignalEmittedAt: null,
    candlesSinceLastSignal: 0,
    hasOpenPosition: false,
    timeframeMs: 3_600_000,
    ...initial,
  };
  return {
    getActivityMetrics: () => ({ ...metrics }),
    update: (patch: Partial<EngineActivity>) => Object.assign(metrics, patch),
  };
}

function collectAlerts(monitor: ActivityMonitor): ActivityAlert[] {
  const alerts: ActivityAlert[] = [];
  monitor.on('alert', (a: ActivityAlert) => alerts.push(a));
  return alerts;
}

function collectClears(monitor: ActivityMonitor): Array<{ name: string; type: string }> {
  const clears: Array<{ name: string; type: string }> = [];
  monitor.on('clear', (c: { name: string; type: string }) => clears.push(c));
  return clears;
}

describe('ActivityMonitor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-21T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits no alerts when engine is healthy (candles flowing, no position, signals recent)', () => {
    const monitor = new ActivityMonitor({ checkIntervalMs: 50 });
    const engine = makeEngine({
      lastCandleProcessedAt: Date.now(),
      lastSignalEmittedAt: Date.now(),
      candlesSinceLastSignal: 2,
      hasOpenPosition: false,
    });
    monitor.register(engine);
    const alerts = collectAlerts(monitor);

    monitor.start();
    vi.advanceTimersByTime(200);

    expect(alerts).toEqual([]);
    monitor.stop();
  });

  it('emits STUCK_WITH_POSITION when open position has no signals for stuckThresholdCandles', () => {
    const monitor = new ActivityMonitor({ checkIntervalMs: 50, stuckThresholdCandles: 20 });
    const engine = makeEngine({
      lastCandleProcessedAt: Date.now(),
      lastSignalEmittedAt: Date.now() - 20 * 3_600_000,
      candlesSinceLastSignal: 20,
      hasOpenPosition: true,
    });
    monitor.register(engine);
    const alerts = collectAlerts(monitor);

    monitor.start();
    vi.advanceTimersByTime(60);

    expect(alerts).toHaveLength(1);
    expect(alerts[0].type).toBe('STUCK_WITH_POSITION');
    expect(alerts[0].severity).toBe('error');
    expect(alerts[0].name).toBe('perp-BTC');
    monitor.stop();
  });

  it('does NOT emit STUCK_WITH_POSITION when no position is open, even with no recent signals', () => {
    const monitor = new ActivityMonitor({ checkIntervalMs: 50, stuckThresholdCandles: 20 });
    const engine = makeEngine({
      lastCandleProcessedAt: Date.now(),
      candlesSinceLastSignal: 25,
      hasOpenPosition: false,
    });
    monitor.register(engine);
    const alerts = collectAlerts(monitor);

    monitor.start();
    vi.advanceTimersByTime(60);

    const stuckAlerts = alerts.filter(a => a.type === 'STUCK_WITH_POSITION');
    expect(stuckAlerts).toEqual([]);
    monitor.stop();
  });

  it('emits NO_ACTIVITY when no position AND candlesSinceLastSignal >= quietThresholdCandles', () => {
    const monitor = new ActivityMonitor({
      checkIntervalMs: 50,
      quietThresholdCandles: 48,
    });
    const engine = makeEngine({
      lastCandleProcessedAt: Date.now(),
      candlesSinceLastSignal: 48,
      hasOpenPosition: false,
    });
    monitor.register(engine);
    const alerts = collectAlerts(monitor);

    monitor.start();
    vi.advanceTimersByTime(60);

    expect(alerts).toHaveLength(1);
    expect(alerts[0].type).toBe('NO_ACTIVITY');
    expect(alerts[0].severity).toBe('warn');
    monitor.stop();
  });

  it('emits STALE_HEARTBEAT when lastCandleProcessedAt exceeds staleHeartbeatMultiplier * timeframe', () => {
    const monitor = new ActivityMonitor({
      checkIntervalMs: 50,
      staleHeartbeatMultiplier: 3,
    });
    const engine = makeEngine({
      lastCandleProcessedAt: Date.now() - 4 * 3_600_000, // 4h stale on 1h timeframe
      candlesSinceLastSignal: 1,
      hasOpenPosition: false,
    });
    monitor.register(engine);
    const alerts = collectAlerts(monitor);

    monitor.start();
    vi.advanceTimersByTime(60);

    expect(alerts).toHaveLength(1);
    expect(alerts[0].type).toBe('STALE_HEARTBEAT');
    expect(alerts[0].severity).toBe('error');
    monitor.stop();
  });

  it('does NOT emit STALE_HEARTBEAT when lastCandleProcessedAt is null (engine not yet warm)', () => {
    const monitor = new ActivityMonitor({ checkIntervalMs: 50 });
    const engine = makeEngine({
      lastCandleProcessedAt: null,
      hasOpenPosition: false,
    });
    monitor.register(engine);
    const alerts = collectAlerts(monitor);

    monitor.start();
    vi.advanceTimersByTime(60);

    expect(alerts).toEqual([]);
    monitor.stop();
  });

  it('does not spam the same alert on consecutive checks (throttles by repeatAlertIntervalMs)', () => {
    const monitor = new ActivityMonitor({
      checkIntervalMs: 50,
      stuckThresholdCandles: 20,
      repeatAlertIntervalMs: 1_000,
    });
    const engine = makeEngine({
      lastCandleProcessedAt: Date.now(),
      candlesSinceLastSignal: 25,
      hasOpenPosition: true,
    });
    monitor.register(engine);
    const alerts = collectAlerts(monitor);

    monitor.start();
    vi.advanceTimersByTime(400); // 8 check cycles
    expect(alerts).toHaveLength(1);

    // After repeat interval, it should re-fire
    vi.advanceTimersByTime(700);
    expect(alerts.length).toBeGreaterThanOrEqual(2);
    monitor.stop();
  });

  it('emits clear event when alert condition resolves', () => {
    const monitor = new ActivityMonitor({
      checkIntervalMs: 50,
      stuckThresholdCandles: 20,
    });
    const engine = makeEngine({
      lastCandleProcessedAt: Date.now(),
      candlesSinceLastSignal: 25,
      hasOpenPosition: true,
    });
    monitor.register(engine);
    const alerts = collectAlerts(monitor);
    const clears = collectClears(monitor);

    monitor.start();
    vi.advanceTimersByTime(60);
    expect(alerts).toHaveLength(1);

    // Resolve: position closed, signals flowing
    engine.update({ hasOpenPosition: false, candlesSinceLastSignal: 0 });
    vi.advanceTimersByTime(60);

    expect(clears).toHaveLength(1);
    expect(clears[0]).toMatchObject({ name: 'perp-BTC', type: 'STUCK_WITH_POSITION' });
    monitor.stop();
  });

  it('tracks multiple engines independently', () => {
    const monitor = new ActivityMonitor({
      checkIntervalMs: 50,
      stuckThresholdCandles: 20,
    });
    const perpEngine = makeEngine({
      name: 'perp-BTC',
      lastCandleProcessedAt: Date.now(),
      candlesSinceLastSignal: 25,
      hasOpenPosition: true,
    });
    const spotEngine = makeEngine({
      name: 'spot-BTC',
      lastCandleProcessedAt: Date.now(),
      candlesSinceLastSignal: 2,
      hasOpenPosition: false,
    });
    monitor.register(perpEngine);
    monitor.register(spotEngine);
    const alerts = collectAlerts(monitor);

    monitor.start();
    vi.advanceTimersByTime(60);

    expect(alerts).toHaveLength(1);
    expect(alerts[0].name).toBe('perp-BTC');
    monitor.stop();
  });

  it('returns snapshot of all engine metrics via getSnapshots()', () => {
    const monitor = new ActivityMonitor({ checkIntervalMs: 50 });
    const engine = makeEngine({
      name: 'perp-BTC',
      lastCandleProcessedAt: Date.now(),
      candlesSinceLastSignal: 3,
      hasOpenPosition: true,
    });
    monitor.register(engine);

    const snaps = monitor.getSnapshots();
    expect(snaps).toHaveLength(1);
    expect(snaps[0].name).toBe('perp-BTC');
    expect(snaps[0].hasOpenPosition).toBe(true);

    monitor.stop();
  });

  it('stop() clears the interval timer', () => {
    const monitor = new ActivityMonitor({ checkIntervalMs: 50 });
    const engine = makeEngine({
      lastCandleProcessedAt: Date.now(),
      candlesSinceLastSignal: 100,
      hasOpenPosition: true,
    });
    monitor.register(engine);
    const alerts = collectAlerts(monitor);

    monitor.start();
    vi.advanceTimersByTime(60);
    expect(alerts).toHaveLength(1);

    monitor.stop();
    vi.advanceTimersByTime(5_000);
    expect(alerts).toHaveLength(1);
  });
});
