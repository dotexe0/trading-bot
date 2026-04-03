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
 *
 * Regime auto-switch:
 *  - When regimeLeaderboards is provided, the engine classifies market regime on
 *    each candle (onCandle()) and switches the active strategy to the leaderboard
 *    winner for the new regime.
 *  - A 10-candle cooldown prevents rapid strategy thrashing.
 *  - Switches are deferred while a position is open; they fire when the position closes.
 *  - Regime classification fires ONLY in onCandle(), never in _handleMarkPrice().
 */

import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { d } from '../core/decimal.js';
import { createModuleLogger } from '../core/logger.js';
import { calcLiquidationPrice, calcLiquidationDistance } from './liquidation-calc.js';
import { PerpStrategyController } from './perp-strategy-controller.js';
import { FundingRateTracker } from './funding-tracker.js';
import type { IntxClient } from './intx-client.js';
import type { PerpStateStore } from './perp-state-store.js';
import type { IntxConfig } from './config.js';
import type { PerpRiskGate } from './perp-risk-gate.js';
import type { IStrategy } from '../strategies/types.js';
import type { StrategyRegistry } from '../strategies/registry.js';
import type { RegimeLeaderboards } from '../tournament/types.js';
import type { Candle, TradingPair, Timeframe } from '../core/types.js';
import type {
  PerpSession,
  PerpDirection,
  PerpPositionManagerEvents,
  IntxMarkPriceEvent,
  IntxFundingRateEvent,
} from './types.js';
import type { FeedHealthMonitor } from '../core/feed-health.js';

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
  /** Optional: if provided, check() called before every openPaperPosition() call. */
  riskGate?: PerpRiskGate;
  /**
   * Optional signal callback. Called on each markPrice event.
   * Return value controls the engine's action:
   *  - 'open-long'  → open a long position
   *  - 'open-short' → open a short position
   *  - 'close'      → close the current position (if open)
   *  - 'hold'       → do nothing
   *
   * When not provided, the engine operates in passive monitoring mode
   * (liquidation safety checks only) unless a strategy is set via
   * regimeLeaderboards / initialStrategy.
   */
  onSignal?: (
    instrument: string,
    markPrice: string,
  ) => 'open-long' | 'open-short' | 'close' | 'hold';
  /**
   * Optional regime leaderboards from the latest tournament.
   * When provided, enables automatic strategy switching on regime changes.
   * Must be used together with a strategyRegistry (or fundingRateProvider).
   */
  regimeLeaderboards?: RegimeLeaderboards;
  /**
   * Optional pre-built strategy registry for regime auto-switch.
   * If omitted but regimeLeaderboards is provided, the engine will build
   * one internally via createLivePerpRegistry(fundingRateProvider ?? () => null).
   *
   * Callers may also pass a createLivePerpRegistry(provider) result directly
   * to ensure funding adjustments fire at runtime.
   */
  strategyRegistry?: StrategyRegistry;
  /**
   * Optional initial strategy to use before the first regime classification.
   * When set, this strategy is used for signal evaluation until a regime switch occurs.
   */
  initialStrategy?: IStrategy;
  /**
   * Optional funding rate provider for strategies created during regime switches.
   * Used when building the internal registry via createLivePerpRegistry().
   * If strategyRegistry is provided, this field is ignored.
   *
   * KEY INVARIANT: strategies built for regime switches must receive a real
   * fundingRateProvider (not () => null) so funding adjustments fire at runtime.
   */
  fundingRateProvider?: () => number | null;
  /**
   * Optional pre-built FundingRateTracker instance. If not provided, one is
   * created from config.fundingDrainThresholdPct. Useful for testing with
   * controlled drain trigger behavior.
   */
  fundingTracker?: FundingRateTracker;
  /** When provided, skips signal evaluation when feed is stale. */
  feedHealthMonitor?: FeedHealthMonitor;
  /**
   * Interval between simulated funding payments in ms.
   * Defaults to 28_800_000 (8 hours) — matches real perpetual funding cadence.
   * Override to a shorter value in tests.
   */
  paperFundingIntervalMs?: number;
}

// ── Engine ────────────────────────────────────────────────────────────────────

export class PaperPerpEngine extends EventEmitter {
  private intxClient: IntxClient;
  private stateStore: PerpStateStore;
  private config: IntxConfig;
  private onSignal?: PaperPerpEngineOptions['onSignal'];
  private _riskGate: PerpRiskGate | null;

  private currentPosition: PaperPerpPosition | null = null;
  private _started = false;
  private _emergencyCloseInProgress = false;
  private _onMarkPrice: ((evt: IntxMarkPriceEvent) => void) | null = null;
  private _fundingRateTracker: FundingRateTracker;
  private _fundingDrainInProgress = false;
  private _onFundingRate: ((evt: IntxFundingRateEvent) => void) | null = null;
  private _paperFundingTimer: ReturnType<typeof setInterval> | null = null;
  private readonly _paperFundingIntervalMs: number;

  // ── Strategy controller (regime auto-switch, candle buffer, feed health) ──
  private readonly ctrl: PerpStrategyController;

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
    this._riskGate = options.riskGate ?? null;

    // Funding rate tracker
    this._fundingRateTracker = options.fundingTracker
      ?? new FundingRateTracker({ drainThresholdPct: options.config.fundingDrainThresholdPct });

    // Strategy controller: regime auto-switch, candle buffer, feed health
    this.ctrl = new PerpStrategyController({
      regimeLeaderboards: options.regimeLeaderboards,
      strategyRegistry: options.strategyRegistry,
      initialStrategy: options.initialStrategy,
      fundingRateProvider: options.fundingRateProvider,
      feedHealthMonitor: options.feedHealthMonitor,
      logPrefix: '[PAPER]',
      onStrategySwitch: (name) => this.emit('strategySwitch', { newStrategy: name }),
    });
    this._paperFundingIntervalMs = options.paperFundingIntervalMs ?? 28_800_000;
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

    // Re-hydrate in-memory state from DB on IntxClient reconnection
    this.intxClient.on('reconnected', () => this._handleReconnection());

    this._onFundingRate = (evt: IntxFundingRateEvent) => this._handleFundingRate(evt);
    this.intxClient.on('fundingRate', this._onFundingRate);

    // Paper funding simulation: apply 8h funding payment on each interval
    this._paperFundingTimer = setInterval(() => {
      void this._applyPaperFunding();
    }, this._paperFundingIntervalMs);

    // Re-hydrate from DB: recover or clean up sessions left open by a previous run
    const openSessions = this.stateStore.getAllOpenSessions();
    if (openSessions.length > 0) {
      // Sort descending by openedAt — keep the most recent, close the rest as orphans
      openSessions.sort((a, b) => b.openedAt - a.openedAt);

      const STALE_SESSION_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

      for (const orphan of openSessions.slice(1)) {
        this.stateStore.updateSession(orphan.id, {
          status: 'closed',
          closedAt: Date.now(),
          closeReason: 'engine-restart',
        });
        log.info({ sessionId: orphan.id, instrument: orphan.instrument }, '[PAPER] Closed orphaned session on restart');
      }

      // Close the candidate session if it is too stale to be safely re-adopted
      const candidate = openSessions[0];
      const ageMs = Date.now() - candidate.openedAt;
      if (ageMs > STALE_SESSION_AGE_MS) {
        this.stateStore.updateSession(candidate.id, {
          status: 'closed',
          closedAt: Date.now(),
          closeReason: 'stale-session-startup',
        });
        log.warn(
          { sessionId: candidate.id, instrument: candidate.instrument, ageDays: (ageMs / 86_400_000).toFixed(1) },
          '[PAPER] Closed stale session on startup (older than 7 days)',
        );
        // Fall through — no position to re-hydrate
      } else {
        const session = candidate;

        // Correct instrument if session was opened with a raw trading pair (pre-fix bug)
        let correctedInstrument = session.instrument;
        if (session.instrument === 'BTC-USD') {
          correctedInstrument = this.config.btcProductId;
        } else if (session.instrument === 'ETH-USD') {
          correctedInstrument = this.config.ethProductId;
        }
        if (correctedInstrument !== session.instrument) {
          this.stateStore.updateSession(session.id, { instrument: correctedInstrument });
          session.instrument = correctedInstrument;
          log.info({ sessionId: session.id, correctedInstrument }, '[PAPER] Corrected session instrument on restart');
        }

        this.currentPosition = { session, paperEntryPrice: session.entryPrice };

        // Restore strategy position state so exit logic can trigger
        const currentStrategy = this.ctrl.getStrategy();
        if (
          currentStrategy &&
          typeof (currentStrategy as unknown as Record<string, unknown>)['restorePosition'] === 'function'
        ) {
          (currentStrategy as unknown as { restorePosition: (d: 'long' | 'short', e: string) => void })
            .restorePosition(session.direction, session.entryPrice);
        }

        log.info(
          { sessionId: session.id, instrument: session.instrument, direction: session.direction },
          '[PAPER] Re-hydrated open position from DB on startup',
        );
      }
    }

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
    if (this._onFundingRate) {
      this.intxClient.off('fundingRate', this._onFundingRate);
      this._onFundingRate = null;
    }
    if (this._paperFundingTimer) {
      clearInterval(this._paperFundingTimer);
      this._paperFundingTimer = null;
    }
    this._started = false;
    log.info('PaperPerpEngine stopped');
  }

  // ── Candle ingestion ──────────────────────────────────────────────────────

  /**
   * Process a completed candle.
   *
   * - Appends to the rolling candle buffer (max 100 candles).
   * - Classifies market regime — ONLY here, never in _handleMarkPrice.
   * - Applies regime auto-switch logic when regimeLeaderboards is configured:
   *   switches strategy to the regime winner on regime change, with a 10-candle
   *   cooldown; defers the switch if a position is currently open.
   * - If a pendingSwitch exists and no position is open, executes it.
   * - If a strategy is set (and onSignal is not provided), evaluates the strategy
   *   and acts on signals.
   */
  onCandle(candle: Candle): void {
    // Delegate buffer management, feed health, regime classification, and
    // auto-switch state machine to the shared controller.
    const result = this.ctrl.processCandle(candle, this.currentPosition !== null);
    if (result === null) return; // stale feed — hold position, skip evaluation

    const { regime } = result;

    // Strategy-based signal evaluation (only when onSignal is not the signal source)
    if (!this.ctrl.getStrategy()) {
      log.warn(
        { pair: candle.pair, regime, bufferLen: this.ctrl.getCandleBuffer().length },
        '[PAPER] No strategy set — candle processed but no signal evaluation',
      );
      return;
    }
    if (!this.onSignal) {
      const instrument = candle.pair === 'ETH-USD' ? this.config.ethProductId : this.config.btcProductId;
      const timeframe = candle.timeframe as Timeframe;
      const signals = this.ctrl.getStrategy()!.evaluate(
        this.ctrl.getCandleBuffer(),
        candle.pair as TradingPair,
        timeframe,
        undefined,
        regime,
      );
      if (signals.length === 0) {
        log.info(
          { pair: candle.pair, strategyName: this.ctrl.getStrategy()!.name, regime, bufferLen: this.ctrl.getCandleBuffer().length },
          '[PAPER] No signals emitted this candle',
        );
      }
      for (const signal of signals) {
        if (signal.direction === 'long' || signal.direction === 'short') {
          log.info(
            {
              instrument: candle.pair,
              strategyName: signal.strategyName,
              direction: signal.direction,
              reasoning: signal.reasoning,
              confidence: signal.confidence,
              timestamp: signal.timestamp,
              event: 'entry-signal',
            },
            'Entry signal received',
          );
          if (this.currentPosition === null) {
            const direction: PerpDirection = signal.direction;
            this.openPaperPosition(instrument, direction, '0.01', this.config.defaultLeverage ?? 5, candle.close).catch(
              (err) => {
                log.error(
                  { err: err instanceof Error ? err.message : String(err) },
                  '[PAPER] strategy openPaperPosition failed',
                );
              },
            );
          }
        } else if (signal.direction === 'close') {
          if (this.currentPosition !== null) {
            this.closePaperPosition(candle.close, 'strategy-signal');
          }
        }
      }
    }
  }

  // ── Position management ───────────────────────────────────────────────────

  /**
   * Open a simulated paper position at the current mark price.
   * Persists to PerpStateStore — no REST calls made.
   *
   * If a riskGate is configured, check() is called before the liquidation calc.
   */
  async openPaperPosition(
    instrument: string,
    direction: PerpDirection,
    size: string,
    leverage: number,
    markPrice: string,
    options?: {
      /** Total account equity for exposure/loss cap checks. Defaults to '1000000'. */
      accountValue?: string;
      /** Fraction of notional to use as max-loss estimate (default 0.02 = 2%). */
      stopDistancePct?: number;
      /** Bot-internal margin policy; included in entry log and session. */
      marginMode?: 'isolated' | 'cross';
    },
  ): Promise<PerpSession> {
    if (this.currentPosition !== null) {
      throw new Error('Paper position already open — close existing position first');
    }

    const accountValue = options?.accountValue;
    const stopDistancePct = options?.stopDistancePct;
    const marginMode = options?.marginMode;

    // Risk gate check (before liquidation calc)
    if (this._riskGate) {
      const stopPct = d(String(stopDistancePct ?? 0.02));
      const proposedNotional = d(size).mul(d(markPrice));
      const proposedMaxLoss = proposedNotional.mul(stopPct);
      const tpPct = d(String(this.config.tpTargetPct ?? 2.0)).div(d('100'));
      const expectedGain = proposedNotional.mul(tpPct);
      const gateResult = await this._riskGate.check({
        instrument,
        proposedNotional: proposedNotional.toFixed(8),
        proposedMaxLoss: proposedMaxLoss.toFixed(8),
        accountValue: accountValue ?? '1000000',
        expectedGain: expectedGain.toFixed(8),
      });
      if (!gateResult.approved) {
        throw new Error(`PerpRiskGate rejected paper entry: ${gateResult.rejectReason}`);
      }
    }

    const mmr = d(this.config.defaultMaintenanceMarginRate);
    const liqPrice = calcLiquidationPrice(d(markPrice), leverage, direction, mmr);

    log.info(
      {
        instrument,
        direction,
        leverage,
        marginMode: marginMode ?? 'unknown',
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
      marginMode,
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
   *
   * After close, any pending regime strategy switch is executed immediately
   * (position is no longer blocking it).
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

    // Record closed trade for analytics (Phase 32)
    this.stateStore.recordTrade({
      sessionId: session.id,
      instrument: session.instrument,
      direction: session.direction,
      leverage: session.leverage,
      entryPrice: paperEntryPrice,
      exitPrice: markPrice,
      size: session.size,
      cumulativeFundingCost: session.cumulativeFundingCost ?? '0.00000000',
      realizedPnl,
      openedAt: session.openedAt,
      closedAt,
      closeReason,
    });

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

    // Record realized loss to risk gate for daily loss cap tracking (Check 5)
    if (this._riskGate) {
      const lossUsd = Math.max(0, -parseFloat(realizedPnl));
      this._riskGate.recordRealizedLoss(lossUsd);
    }

    this.emit('positionClosed', session);

    const closedSession = { ...session };
    this.currentPosition = null;
    this._fundingRateTracker.reset();

    // Execute any pending regime strategy switch now that position is closed
    this.ctrl.firePendingSwitchIfIdle(false);

    return closedSession;
  }

  // ── Reconnection re-hydration ────────────────────────────────────────────

  /**
   * Re-hydrate in-memory state from DB after IntxClient reconnection.
   * Prevents stale cached markPrice/fundingCost from producing bad signals.
   * Called when IntxClient emits 'reconnected'.
   */
  private _handleReconnection(): void {
    if (!this.currentPosition) {
      log.info('IntxClient reconnected — no open position, nothing to re-hydrate');
      return;
    }

    const session = this.currentPosition.session;
    const dbSession = this.stateStore.getOpenSession(session.instrument);
    if (dbSession) {
      if (dbSession.markPrice) {
        session.markPrice = dbSession.markPrice;
      }
      if (dbSession.cumulativeFundingCost) {
        session.cumulativeFundingCost = dbSession.cumulativeFundingCost;
      }
      log.info(
        {
          sessionId: session.id,
          markPrice: dbSession.markPrice,
          cumulativeFundingCost: dbSession.cumulativeFundingCost,
        },
        'IntxClient reconnected — session state re-hydrated from DB',
      );
    } else {
      log.warn(
        { sessionId: session.id },
        'IntxClient reconnected — no matching open session in DB for re-hydration',
      );
    }
  }

  // ── Funding helpers ───────────────────────────────────────────────────────

  private _computeUnrealizedPnl(session: PerpSession, cumulativeFundingCost: string): string {
    if (!session.markPrice) return cumulativeFundingCost;
    const markPriceD = d(session.markPrice);
    const entryD = d(session.entryPrice);
    const sizeD = d(session.size);
    const pricePnl = session.direction === 'long'
      ? markPriceD.minus(entryD).mul(sizeD)
      : entryD.minus(markPriceD).mul(sizeD);
    return pricePnl.plus(d(cumulativeFundingCost)).toFixed(8);
  }

  private _handleFundingRate(evt: IntxFundingRateEvent): void {
    if (evt.isStale) return;  // preserve stale guard (must be first check)
    if (!this.currentPosition) {
      // No position open — emit market-rate-only update so dashboard panel stays live.
      // NOTE: evt.instrument is always 'FCM' (account-level channel); use config instrument.
      this.emit('fundingUpdate', {
        sessionId: null,
        instrument: this.config.btcProductId,
        currentFundingRate: evt.fundingRate,
        cumulativeFundingCost: '0.00000000',
        cumulativeFundingPct: '0.00000000',
      });
      return;
    }
    const session = this.currentPosition.session;
    // NOTE: evt.instrument is always 'FCM' (account-level channel) — do NOT filter by instrument
    const update = this._fundingRateTracker.onFundingEvent(evt, session);
    const unrealizedPnl = this._computeUnrealizedPnl(session, update.cumulativeFundingCost);
    this.stateStore.updateSession(session.id, {
      cumulativeFundingCost: update.cumulativeFundingCost,
      unrealizedPnl,
    });
    this.emit('fundingUpdate', {
      sessionId: session.id,
      instrument: session.instrument,
      currentFundingRate: update.currentFundingRate,
      cumulativeFundingCost: update.cumulativeFundingCost,
      cumulativeFundingPct: update.cumulativeFundingPct,
      unrealizedPnl,
    });
    if (update.drainTriggered && !this._fundingDrainInProgress && !this._emergencyCloseInProgress) {
      this._fundingDrainInProgress = true;
      log.warn(
        { sessionId: session.id, cumulativeFundingPct: update.cumulativeFundingPct },
        'FUNDING_DRAIN_EXIT triggered',
      );
      this.emit('fundingDrain', session, { cumulativeFundingCost: update.cumulativeFundingCost });
      const markPrice = session.markPrice ?? session.entryPrice;
      try {
        this.closePaperPosition(markPrice, 'FUNDING_DRAIN_EXIT');
      } finally {
        this._fundingDrainInProgress = false;
      }
    }
  }

  /**
   * Simulate one funding payment for the current open position.
   *
   * Called by setInterval every paperFundingIntervalMs (default 8 h).
   * Fetches the live funding rate from the Coinbase REST API and calculates
   * the dollar payment for the current position size and mark price.
   *
   * Sign convention:
   *   rate > 0 → longs pay shorts: long payment is negative (cost), short is positive (income)
   *   rate < 0 → shorts pay longs: short payment is negative (cost), long is positive (income)
   */
  private async _applyPaperFunding(): Promise<void> {
    if (!this.currentPosition) return;
    const session = this.currentPosition.session;

    const rate = await this.intxClient.fetchFundingRate(session.instrument);
    if (rate === 0) return;

    const markPrice = session.markPrice ?? session.entryPrice;
    const notionalD = d(session.size).mul(d(markPrice));
    const rateD = d(String(rate));
    const paymentD = session.direction === 'long'
      ? rateD.mul(notionalD).negated()
      : rateD.mul(notionalD);

    log.info(
      {
        sessionId: session.id,
        instrument: session.instrument,
        fundingRate: rate,
        notional: notionalD.toFixed(2),
        payment: paymentD.toFixed(8),
      },
      '[PAPER] Simulated funding payment applied',
    );

    this._handleFundingRate({
      instrument: 'FCM',
      fundingRate: paymentD.toFixed(8),
      isFinal: true,
      timestamp: Date.now(),
      isStale: false,
    });
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
   *
   * NOTE: Regime classification does NOT happen here — only in onCandle().
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

      // Fix DASH-01: update in-memory session so _computeUnrealizedPnl uses current price
      session.markPrice = evt.markPrice;
      // Emit mark-price-driven P&L update for real-time dashboard chart
      const unrealizedPnl = this._computeUnrealizedPnl(
        session,
        session.cumulativeFundingCost ?? '0.00000000',
      );
      this.emit('markPriceUpdate', {
        sessionId: session.id,
        instrument: session.instrument,
        markPrice: evt.markPrice,
        unrealizedPnl,
      });

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

    // Step 3: optional signal directive (imperative onSignal path — unaffected by regime switch)
    if (this.onSignal) {
      const directive = this.onSignal(evt.instrument, evt.markPrice);
      switch (directive) {
        case 'open-long':
          this.openPaperPosition(evt.instrument, 'long', '0.01', this.config.defaultLeverage ?? 5, evt.markPrice).catch((err) => {
            log.error({ err: err instanceof Error ? err.message : String(err) }, '[PAPER] openPaperPosition failed');
          });
          break;
        case 'open-short':
          this.openPaperPosition(evt.instrument, 'short', '0.01', this.config.defaultLeverage ?? 5, evt.markPrice).catch((err) => {
            log.error({ err: err instanceof Error ? err.message : String(err) }, '[PAPER] openPaperPosition failed');
          });
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

  // ── Regime auto-switch helpers ────────────────────────────────────────────

  // ── Accessors ─────────────────────────────────────────────────────────────

  getCurrentSession(): PerpSession | null {
    return this.currentPosition?.session ?? null;
  }

  isPositionOpen(): boolean {
    return this.currentPosition !== null;
  }
}
