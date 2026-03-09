/**
 * PaperPerpEngine -- mark-price-driven perp position simulator (paper mode).
 *
 * Simulates the open/close lifecycle of a perp position using IntxClient
 * markPrice events. NEVER calls intxClient.placeOrder or cancelOrder.
 * All position state is persisted to PerpStateStore (same tables as live).
 *
 * Safety guarantees:
 *  - Zero REST order calls: paper engine subscribes to markPrice events only
 *  - Emergency close guard: _emergencyCloseInProgress flag reset in finally block
 *  - Stale data ignored: evt.isStale === true → no-op
 */

import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { d, ZERO } from '../core/decimal.js';
import { createModuleLogger } from '../core/logger.js';
import { calcLiquidationPrice, calcLiquidationDistance } from './liquidation-calc.js';
import type { IntxClient } from './intx-client.js';
import type { PerpStateStore } from './perp-state-store.js';
import type { IntxConfig } from './config.js';
import type {
  PerpSession,
  PerpDirection,
  PerpPositionManagerEvents,
  IntxMarkPriceEvent,
} from './types.js';

const log = createModuleLogger('paper-perp-engine');

// ── Internal types ────────────────────────────────────────────────────────────

interface PaperPerpPosition {
  session: PerpSession;
  /** Mark price at simulated entry */
  paperEntryPrice: string;
  /** Mark price at simulated exit */
  paperExitPrice?: string;
  realizedPnl?: string;
}

// ── Options ───────────────────────────────────────────────────────────────────

export interface PaperPerpEngineOptions {
  intxClient: IntxClient;
  stateStore: PerpStateStore;
  config: IntxConfig;
  /**
   * Optional signal callback. Called on each markPrice event.
   * Return value controls the engine's action:
   *  - 'open-long'  → open a long position
   *  - 'open-short' → open a short position
   *  - 'close'      → close the current position (if open)
   *  - 'hold'       → do nothing
   *
   * When not provided, the engine operates in passive monitoring mode
   * (liquidation safety checks only).
   */
  onSignal?: (
    instrument: string,
    markPrice: string,
  ) => 'open-long' | 'open-short' | 'close' | 'hold';
}

// ── Engine ────────────────────────────────────────────────────────────────────

export class PaperPerpEngine extends EventEmitter {
  private intxClient: IntxClient;
  private stateStore: PerpStateStore;
  private config: IntxConfig;
  private onSignal?: PaperPerpEngineOptions['onSignal'];

  private currentPosition: PaperPerpPosition | null = null;
  private _started = false;
  private _emergencyCloseInProgress = false;
  private _onMarkPrice: ((evt: IntxMarkPriceEvent) => void) | null = null;

  /** Typed emit override — matches PerpPositionManagerEvents interface. */
  override emit<K extends keyof PerpPositionManagerEvents>(
    event: K,
    ...args: PerpPositionManagerEvents[K]
  ): boolean {
    return super.emit(event, ...args);
  }

  constructor(options: PaperPerpEngineOptions) {
    super();
    this.intxClient = options.intxClient;
    this.stateStore = options.stateStore;
    this.config = options.config;
    this.onSignal = options.onSignal;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Subscribe to markPrice events. Throws if already started.
   */
  start(): void {
    if (this._started) throw new Error('PaperPerpEngine already started');
    this._started = true;
    this._onMarkPrice = (evt: IntxMarkPriceEvent) => this._handleMarkPrice(evt);
    this.intxClient.on('markPrice', this._onMarkPrice);
    log.info('PaperPerpEngine started');
  }

  /**
   * Unsubscribe from markPrice events.
   */
  stop(): void {
    if (this._onMarkPrice) {
      this.intxClient.off('markPrice', this._onMarkPrice);
      this._onMarkPrice = null;
    }
    this._started = false;
    log.info('PaperPerpEngine stopped');
  }

  // ── Position management ───────────────────────────────────────────────────

  /**
   * Open a simulated paper position at the current mark price.
   * Persists to PerpStateStore — no REST calls made.
   */
  openPaperPosition(
    instrument: string,
    direction: PerpDirection,
    size: string,
    leverage: number,
    markPrice: string,
  ): PerpSession {
    if (this.currentPosition !== null) {
      throw new Error('Paper position already open — close existing position first');
    }

    const mmr = d(this.config.defaultMaintenanceMarginRate);
    const liqPrice = calcLiquidationPrice(d(markPrice), leverage, direction, mmr);

    log.info(
      {
        instrument,
        direction,
        leverage,
        paperEntryPrice: markPrice,
        liquidationPrice: liqPrice.toFixed(8),
      },
      '[PAPER] Liquidation price computed before entry',
    );

    const session: PerpSession = {
      id: crypto.randomUUID(),
      instrument,
      direction,
      entryPrice: markPrice,
      size,
      leverage,
      liquidationPrice: liqPrice.toFixed(8),
      maintenanceMarginRate: mmr.toFixed(8),
      markPrice,
      status: 'open',
      openedAt: Date.now(),
    };

    // Pass a snapshot so mutations during close don't affect the stored record
    this.stateStore.createSession({ ...session });
    this.currentPosition = { session, paperEntryPrice: markPrice };

    this.emit('positionOpened', session);
    return session;
  }

  /**
   * Close the current simulated paper position.
   * Persists updated session to PerpStateStore — no REST calls made.
   */
  closePaperPosition(markPrice: string, reason?: string): PerpSession {
    if (!this.currentPosition) {
      throw new Error('No open paper position to close');
    }

    const { session, paperEntryPrice } = this.currentPosition;
    const { direction, size } = session;

    // Compute realized PnL
    const entryD = d(paperEntryPrice);
    const exitD = d(markPrice);
    const sizeD = d(size);
    const realizedPnl =
      direction === 'long'
        ? exitD.minus(entryD).mul(sizeD).toFixed(8)
        : entryD.minus(exitD).mul(sizeD).toFixed(8);

    const closedAt = Date.now();
    const closeReason = reason ?? 'manual';

    session.status = 'closed';
    session.closedAt = closedAt;
    session.closeReason = closeReason;

    this.stateStore.updateSession(session.id, { status: 'closed', closedAt, closeReason });

    log.info(
      {
        instrument: session.instrument,
        direction,
        paperEntryPrice,
        paperExitPrice: markPrice,
        realizedPnl,
      },
      '[PAPER] Position closed',
    );

    this.currentPosition.paperExitPrice = markPrice;
    this.currentPosition.realizedPnl = realizedPnl;

    this.emit('positionClosed', session);

    const closedSession = { ...session };
    this.currentPosition = null;
    return closedSession;
  }

  // ── Mark price handler ────────────────────────────────────────────────────

  /**
   * Internal: handle each markPrice event.
   *
   * Order:
   * 1. Ignore stale events
   * 2. If position open for this instrument: check liquidation distance, emit
   *    event, persist updated mark price, trigger emergency close if needed
   * 3. If onSignal provided: call signal and act on directive
   */
  private _handleMarkPrice(evt: IntxMarkPriceEvent): void {
    if (evt.isStale) return;

    // Step 2: liquidation distance monitoring
    if (
      this.currentPosition &&
      evt.instrument === this.currentPosition.session.instrument
    ) {
      const session = this.currentPosition.session;
      const distancePct = calcLiquidationDistance(
        d(evt.markPrice),
        d(session.liquidationPrice),
        session.direction,
      );

      this.emit('liquidationDistance', {
        sessionId: session.id,
        instrument: session.instrument,
        distancePct: distancePct.toFixed(4),
        markPrice: evt.markPrice,
      });

      // Persist latest mark price
      this.stateStore.updateSession(session.id, { markPrice: evt.markPrice });

      // Emergency close if dangerously close to liquidation
      if (
        distancePct.lt(d(this.config.liquidationSafetyThresholdPct)) &&
        !this._emergencyCloseInProgress
      ) {
        this._emergencyCloseInProgress = true;
        log.warn(
          {
            instrument: session.instrument,
            markPrice: evt.markPrice,
            liquidationPrice: session.liquidationPrice,
            distancePct: distancePct.toFixed(2),
          },
          '[PAPER] LIQUIDATION_RISK: emergency close triggered',
        );

        this.emit('emergencyClose', session, {
          markPrice: evt.markPrice,
          distancePct: distancePct.toFixed(4),
        });

        try {
          this.closePaperPosition(evt.markPrice, 'EMERGENCY_CLOSE');
        } finally {
          // Always reset flag — even if close throws — so future positions
          // can trigger emergency close again
          this._emergencyCloseInProgress = false;
        }
        return; // no signal processing after emergency close
      }
    }

    // Step 3: optional signal directive
    if (this.onSignal) {
      const directive = this.onSignal(evt.instrument, evt.markPrice);
      switch (directive) {
        case 'open-long':
          this.openPaperPosition(evt.instrument, 'long', '0.01', 5, evt.markPrice);
          break;
        case 'open-short':
          this.openPaperPosition(evt.instrument, 'short', '0.01', 5, evt.markPrice);
          break;
        case 'close':
          if (this.currentPosition) {
            this.closePaperPosition(evt.markPrice);
          }
          break;
        case 'hold':
          break;
      }
    }
  }

  // ── Accessors ─────────────────────────────────────────────────────────────

  getCurrentSession(): PerpSession | null {
    return this.currentPosition?.session ?? null;
  }

  isPositionOpen(): boolean {
    return this.currentPosition !== null;
  }
}
