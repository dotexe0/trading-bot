/**
 * FeedHealthMonitor -- centralized per-instrument feed freshness tracker.
 *
 * Tracks when candle and mark-price data was last received for each
 * registered instrument and computes LIVE / STALE / DEAD status.
 *
 * Consumers:
 *  - Engines: guard onCandle() with isStale() to skip signal evaluation on stale data
 *  - Dashboard: subscribe to healthChange events for real-time feed health UI
 *
 * CRITICAL: Uses Date.now() (receipt time), NOT candle.timestamp (candle open time).
 *           See research Pitfall 3 -- candle.timestamp can be seconds in the past.
 */

import { EventEmitter } from 'node:events';
import { createModuleLogger } from './logger.js';

const log = createModuleLogger('feed-health');

// ── Types ────────────────────────────────────────────────────────────────────

export type FeedStatus = 'LIVE' | 'STALE' | 'DEAD';

export interface FeedHealthState {
  instrument: string;
  status: FeedStatus;
  /** Date.now() when last candle was received (null = no candle yet) */
  lastCandleAt: number | null;
  /** Date.now() when last mark price was received (null = perp-only, or no data yet) */
  lastMarkPriceAt: number | null;
  /** Expected candle delivery interval in ms (e.g., 60_000 for 1m candles) */
  expectedIntervalMs: number;
}

export interface FeedHealthConfig {
  /**
   * Multiplier for STALE threshold (default 2.5).
   * Requirement says "2x the expected interval" -- 2.5x adds a grace buffer
   * to prevent flicker from timer drift (Research Pitfall 2).
   */
  staleMultiplier?: number;
  /** Multiplier for DEAD threshold (default 5). */
  deadMultiplier?: number;
  /** How often to run the staleness check in ms (default 5000). */
  checkIntervalMs?: number;
}

// ── FeedHealthMonitor ────────────────────────────────────────────────────────

export class FeedHealthMonitor extends EventEmitter {
  private instruments = new Map<string, FeedHealthState>();
  private checkTimer: ReturnType<typeof setInterval> | null = null;

  private readonly staleMultiplier: number;
  private readonly deadMultiplier: number;
  private readonly checkIntervalMs: number;

  constructor(config: FeedHealthConfig = {}) {
    super();
    this.staleMultiplier = config.staleMultiplier ?? 2.5;
    this.deadMultiplier = config.deadMultiplier ?? 5;
    this.checkIntervalMs = config.checkIntervalMs ?? 5000;
  }

  // ── Public API ─────────────────────────────────────────────────────────

  /**
   * Register an instrument for health monitoring.
   * Call once per instrument at startup.
   */
  register(instrument: string, expectedIntervalMs: number): void {
    this.instruments.set(instrument, {
      instrument,
      status: 'LIVE',
      lastCandleAt: null,
      lastMarkPriceAt: null,
      expectedIntervalMs,
    });
    log.info({ instrument, expectedIntervalMs }, 'Instrument registered for feed health monitoring');
  }

  /**
   * Record candle receipt for an instrument.
   * Uses Date.now() -- NOT candle.timestamp.
   */
  onCandle(instrument: string): void {
    const state = this.instruments.get(instrument);
    if (!state) return;
    state.lastCandleAt = Date.now();
  }

  /**
   * Record mark price receipt for an instrument (perp only).
   * Uses Date.now() for the same reason as onCandle.
   */
  onMarkPrice(instrument: string): void {
    const state = this.instruments.get(instrument);
    if (!state) return;
    state.lastMarkPriceAt = Date.now();
  }

  /**
   * Get current feed status for an instrument.
   * Returns 'LIVE' for unregistered instruments (defensive default).
   */
  getStatus(instrument: string): FeedStatus {
    const state = this.instruments.get(instrument);
    return state?.status ?? 'LIVE';
  }

  /**
   * Get all registered instrument states.
   */
  getAllStatuses(): FeedHealthState[] {
    return Array.from(this.instruments.values());
  }

  /**
   * Returns true if the instrument is STALE or DEAD.
   * Returns false for unregistered instruments (defensive default).
   */
  isStale(instrument: string): boolean {
    const status = this.getStatus(instrument);
    return status === 'STALE' || status === 'DEAD';
  }

  /**
   * Start periodic staleness checking.
   * Uses a single setInterval for all instruments.
   */
  start(): void {
    if (this.checkTimer) return; // Already running
    this.checkTimer = setInterval(() => this.checkStaleness(), this.checkIntervalMs);
    log.info({ checkIntervalMs: this.checkIntervalMs }, 'FeedHealthMonitor started');
  }

  /**
   * Stop the periodic check timer. Call on shutdown.
   */
  stop(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
      log.info('FeedHealthMonitor stopped');
    }
  }

  // ── Private ────────────────────────────────────────────────────────────

  /**
   * Check all registered instruments for staleness.
   * Computes elapsed time since most-recent data receipt.
   * Emits `healthChange` only on status transitions.
   */
  private checkStaleness(): void {
    const now = Date.now();

    for (const state of this.instruments.values()) {
      // Pick the most-recent receipt timestamp (candle or markPrice).
      // For perp instruments, markPrice may keep the feed alive even if
      // candles are delayed. For spot, lastMarkPriceAt is always null.
      const timestamps: number[] = [];
      if (state.lastCandleAt !== null) timestamps.push(state.lastCandleAt);
      if (state.lastMarkPriceAt !== null) timestamps.push(state.lastMarkPriceAt);

      // No data received yet -- instrument was just registered, stay LIVE.
      if (timestamps.length === 0) continue;

      const mostRecent = Math.max(...timestamps);
      const elapsed = now - mostRecent;

      let newStatus: FeedStatus;
      if (elapsed > this.deadMultiplier * state.expectedIntervalMs) {
        newStatus = 'DEAD';
      } else if (elapsed > this.staleMultiplier * state.expectedIntervalMs) {
        newStatus = 'STALE';
      } else {
        newStatus = 'LIVE';
      }

      // Only emit on transitions
      if (newStatus !== state.status) {
        const prevStatus = state.status;
        state.status = newStatus;

        // Log at appropriate level based on transition
        if (newStatus === 'DEAD') {
          log.error(
            { instrument: state.instrument, prevStatus, newStatus, elapsedMs: elapsed },
            'Feed status: DEAD',
          );
        } else if (newStatus === 'STALE') {
          log.warn(
            { instrument: state.instrument, prevStatus, newStatus, elapsedMs: elapsed },
            'Feed status: STALE',
          );
        } else {
          // Recovery to LIVE
          log.info(
            { instrument: state.instrument, prevStatus, newStatus },
            'Feed status: recovered to LIVE',
          );
        }

        this.emit('healthChange', { ...state });
      }
    }
  }
}
