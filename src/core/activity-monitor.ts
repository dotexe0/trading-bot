/**
 * ActivityMonitor — engine-level silent-failure detector.
 *
 * Complements FeedHealthMonitor: FeedHealth catches "data stopped flowing",
 * ActivityMonitor catches "data flowing but engine not reacting".
 *
 * Detects three classes of silent failure:
 *   1. STUCK_WITH_POSITION — position open, no signals for N candles
 *      (canonical symptom of the phantom-session deadlock class of bugs)
 *   2. NO_ACTIVITY          — no position and no signals for N candles
 *   3. STALE_HEARTBEAT      — engine stopped calling onCandle entirely
 *
 * Alerts are throttled: the same (engine, type) pair won't re-fire until
 * `repeatAlertIntervalMs` has elapsed. When a condition clears, a `clear`
 * event fires once.
 */

import { EventEmitter } from 'node:events';
import { createModuleLogger } from './logger.js';

const log = createModuleLogger('activity-monitor');

// ── Types ────────────────────────────────────────────────────────────────────

export interface EngineActivity {
  /** Identifier shown in alerts/logs (e.g., "perp-BTC", "spot-ETH"). */
  name: string;
  /** Date.now() when onCandle last completed (null = not yet warm). */
  lastCandleProcessedAt: number | null;
  /** Date.now() when any signal (open/close/hold) was last emitted. */
  lastSignalEmittedAt: number | null;
  /** Candles processed since the last signal was emitted. */
  candlesSinceLastSignal: number;
  /** Whether the engine currently holds an open position. */
  hasOpenPosition: boolean;
  /** Expected candle interval in ms (3_600_000 for '1h'). */
  timeframeMs: number;
}

export interface ActivitySource {
  getActivityMetrics(): EngineActivity;
}

export type ActivityAlertType = 'STUCK_WITH_POSITION' | 'NO_ACTIVITY' | 'STALE_HEARTBEAT';

export interface ActivityAlert {
  name: string;
  type: ActivityAlertType;
  severity: 'warn' | 'error';
  message: string;
  detectedAt: number;
  metrics: EngineActivity;
}

export interface ActivityMonitorConfig {
  /** Candles without signal while position is open → STUCK_WITH_POSITION (default 20). */
  stuckThresholdCandles?: number;
  /** Candles without signal while no position → NO_ACTIVITY (default 48). */
  quietThresholdCandles?: number;
  /** Multiple of timeframeMs without onCandle → STALE_HEARTBEAT (default 3). */
  staleHeartbeatMultiplier?: number;
  /** How often to check all engines (default 60_000 ms). */
  checkIntervalMs?: number;
  /** Throttle window for re-alerting the same condition (default 900_000 ms = 15 min). */
  repeatAlertIntervalMs?: number;
}

// ── Internal state ──────────────────────────────────────────────────────────

interface ActiveAlert {
  lastFiredAt: number;
}

// ── Monitor ─────────────────────────────────────────────────────────────────

export class ActivityMonitor extends EventEmitter {
  private readonly sources: ActivitySource[] = [];
  private readonly active = new Map<string, ActiveAlert>();
  private timer: ReturnType<typeof setInterval> | null = null;

  private readonly stuckThreshold: number;
  private readonly quietThreshold: number;
  private readonly staleMultiplier: number;
  private readonly checkIntervalMs: number;
  private readonly repeatIntervalMs: number;

  constructor(config: ActivityMonitorConfig = {}) {
    super();
    this.stuckThreshold = config.stuckThresholdCandles ?? 20;
    this.quietThreshold = config.quietThresholdCandles ?? 48;
    this.staleMultiplier = config.staleHeartbeatMultiplier ?? 3;
    this.checkIntervalMs = config.checkIntervalMs ?? 60_000;
    this.repeatIntervalMs = config.repeatAlertIntervalMs ?? 900_000;
  }

  register(source: ActivitySource): void {
    this.sources.push(source);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.check(), this.checkIntervalMs);
    log.info(
      { checkIntervalMs: this.checkIntervalMs, engines: this.sources.length },
      'ActivityMonitor started',
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      log.info('ActivityMonitor stopped');
    }
  }

  getSnapshots(): EngineActivity[] {
    return this.sources.map(s => s.getActivityMetrics());
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private check(): void {
    const now = Date.now();
    for (const source of this.sources) {
      const m = source.getActivityMetrics();
      this.evaluate(m, now);
    }
  }

  private evaluate(m: EngineActivity, now: number): void {
    const staleElapsed = m.lastCandleProcessedAt !== null
      ? now - m.lastCandleProcessedAt
      : null;

    const staleHeartbeat =
      staleElapsed !== null && staleElapsed > this.staleMultiplier * m.timeframeMs;
    const stuckWithPosition =
      m.hasOpenPosition && m.candlesSinceLastSignal >= this.stuckThreshold;
    const noActivity =
      !m.hasOpenPosition && m.candlesSinceLastSignal >= this.quietThreshold;

    this.handleCondition(m, 'STALE_HEARTBEAT', staleHeartbeat, 'error', now,
      `${m.name}: no onCandle for ${staleElapsed !== null ? Math.floor(staleElapsed / 1000) : '?'}s — engine may be stalled`);

    this.handleCondition(m, 'STUCK_WITH_POSITION', stuckWithPosition, 'error', now,
      `${m.name}: position open with ${m.candlesSinceLastSignal} candles since last signal — possible phantom-session deadlock`);

    this.handleCondition(m, 'NO_ACTIVITY', noActivity, 'warn', now,
      `${m.name}: no signals for ${m.candlesSinceLastSignal} candles (no position open)`);
  }

  private handleCondition(
    m: EngineActivity,
    type: ActivityAlertType,
    active: boolean,
    severity: 'warn' | 'error',
    now: number,
    message: string,
  ): void {
    const key = `${m.name}:${type}`;
    const existing = this.active.get(key);

    if (active) {
      const shouldFire = !existing || now - existing.lastFiredAt >= this.repeatIntervalMs;
      if (shouldFire) {
        this.active.set(key, { lastFiredAt: now });
        const alert: ActivityAlert = {
          name: m.name,
          type,
          severity,
          message,
          detectedAt: now,
          metrics: { ...m },
        };
        if (severity === 'error') {
          log.error({ activityAlert: alert }, message);
        } else {
          log.warn({ activityAlert: alert }, message);
        }
        this.emit('alert', alert);
      }
    } else if (existing) {
      this.active.delete(key);
      log.info({ name: m.name, type }, 'ActivityMonitor alert cleared');
      this.emit('clear', { name: m.name, type });
    }
  }
}
