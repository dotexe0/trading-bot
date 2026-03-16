/**
 * PerpPositionManager -- open/close/emergency-close lifecycle for INTX perp positions.
 *
 * Provides:
 *  - openPosition():  IOC market entry with pre-entry liquidation price logging
 *  - closePosition(): close_only:true IOC market exit
 *  - executeEmergencyClose(): triggered when liquidation distance falls below threshold
 *  - start()/stop():  subscribe/unsubscribe markPrice events from IntxClient
 *  - onCandle():      candle ingestion for regime-aware strategy auto-switch
 *
 * Safety guarantees:
 *  - stateStore.persistOrder() is called BEFORE every API order submission (idempotency)
 *  - calcLiquidationPrice is called and logged before every openPosition() API call
 *  - Emergency close uses a guard flag (_emergencyCloseInProgress) reset in a finally block
 *
 * Regime auto-switch:
 *  - When regimeLeaderboards is provided, the manager classifies market regime on each
 *    candle (onCandle()) and switches the active strategy to the leaderboard winner for
 *    the new regime.
 *  - A 10-candle cooldown prevents rapid strategy thrashing.
 *  - Switches are deferred while a position is open (currentSession !== null); they fire
 *    when the position closes.
 *  - Regime classification fires ONLY in onCandle(), never in _handleMarkPrice().
 */

import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { d } from '../core/decimal.js';
import { createModuleLogger } from '../core/logger.js';
import { calcLiquidationPrice, calcLiquidationDistance } from './liquidation-calc.js';
import { RegimeClassifier } from '../regime/classifier.js';
import { createLivePerpRegistry } from './strategies/index.js';
import { FundingRateTracker } from './funding-tracker.js';
import type { IntxClient } from './intx-client.js';
import type { PerpStateStore } from './perp-state-store.js';
import type { IntxConfig } from './config.js';
import type { PerpOrderEngine } from './order-engine.js';
import type { PerpRiskGate } from './perp-risk-gate.js';
import type { IStrategy } from '../strategies/types.js';
import type { StrategyRegistry } from '../strategies/registry.js';
import type { RegimeLeaderboards } from '../tournament/types.js';
import type { MarketRegime } from '../regime/types.js';
import type { Candle, TradingPair, Timeframe } from '../core/types.js';
import type {
  PerpSession,
  PerpOrder,
  PerpPositionManagerEvents,
  PerpDirection,
  IntxFundingRateEvent,
} from './types.js';
import type { IntxMarkPriceEvent } from './types.js';

const log = createModuleLogger('perp-position-manager');

/** Number of candles to wait after a strategy switch before allowing another switch. */
const STRATEGY_SWITCH_COOLDOWN_CANDLES = 10;

export interface PerpPositionManagerOptions {
  intxClient: IntxClient;
  stateStore: PerpStateStore;
  config: IntxConfig;
  sessionId?: string;
  orderEngine?: PerpOrderEngine; // optional: if provided, closeAndCleanup() called on all close paths
  riskGate?: PerpRiskGate;       // optional: if provided, check() called before every openPosition() API call
  /**
   * Optional regime leaderboards from the latest tournament.
   * When provided, enables automatic strategy switching on regime changes.
   * Must be used together with a strategyRegistry (or fundingRateProvider).
   */
  regimeLeaderboards?: RegimeLeaderboards;
  /**
   * Optional pre-built strategy registry for regime auto-switch.
   * If omitted but regimeLeaderboards is provided, the manager will build
   * one internally via createLivePerpRegistry(fundingRateProvider ?? () => null).
   *
   * Callers may also pass a createLivePerpRegistry(provider) result directly
   * to ensure funding adjustments fire at runtime.
   */
  strategyRegistry?: StrategyRegistry;
  /**
   * Optional initial strategy to use before the first regime classification.
   * When set, this strategy is used for signal evaluation via onCandle() until
   * a regime switch occurs.
   */
  initialStrategy?: IStrategy;
  /**
   * Optional funding rate provider for strategies created during regime switches.
   * Used when building the internal registry via createLivePerpRegistry().
   * If strategyRegistry is provided, this field is ignored.
   *
   * KEY INVARIANT: strategies created via executeStrategySwitch() must receive a
   * real fundingRateProvider (not () => null) so funding adjustments fire at runtime.
   * PerpPositionManager manages live FCM orders and receives real-time funding rate
   * data; that rate must flow through to strategies created via executeStrategySwitch().
   */
  fundingRateProvider?: () => number | null;
  /**
   * Optional pre-built FundingRateTracker instance. If not provided, one is
   * created from config.fundingDrainThresholdPct. Useful for testing with
   * controlled drain trigger behavior.
   */
  fundingTracker?: FundingRateTracker;
}

export class PerpPositionManager extends EventEmitter {
  private intxClient: IntxClient;
  private stateStore: PerpStateStore;
  private config: IntxConfig;
  private botSessionId: string;
  private _orderEngine: PerpOrderEngine | null;

  private _riskGate: PerpRiskGate | null;

  private currentSession: PerpSession | null = null;
  private _emergencyCloseInProgress = false;
  private _onMarkPrice: ((evt: IntxMarkPriceEvent) => void) | null = null;
  private _fundingRateTracker: FundingRateTracker;
  private _fundingDrainInProgress = false;
  private _onFundingRate: ((evt: IntxFundingRateEvent) => void) | null = null;

  // ── Regime auto-switch state ───────────────────────────────────────────────
  /** Active strategy for candle-based signal evaluation. */
  private strategy: IStrategy | null = null;
  /** Regime leaderboards — null when feature is disabled. */
  private regimeLeaderboards: RegimeLeaderboards | null;
  /** Last observed market regime (undefined before first candle classification). */
  private currentRegime: MarketRegime | undefined = undefined;
  /** Candles remaining in cooldown after a strategy switch. */
  private cooldownCandlesRemaining = 0;
  /** Deferred switch config when a position was open at regime-change time. */
  private pendingSwitch: { strategyConfig: Record<string, unknown>; regime?: MarketRegime } | null = null;
  /** Registry used to instantiate new strategies on regime switch. */
  private strategyRegistry: StrategyRegistry | null;
  /** Classifies market regime from candle history. */
  private readonly classifier = new RegimeClassifier();
  /** Rolling candle buffer — max 100 candles. */
  private candleBuffer: Candle[] = [];

  /** Typed emit override. */
  override emit<K extends keyof PerpPositionManagerEvents>(
    event: K,
    ...args: PerpPositionManagerEvents[K]
  ): boolean {
    return super.emit(event, ...args);
  }

  constructor(options: PerpPositionManagerOptions) {
    super();
    this.intxClient = options.intxClient;
    this.stateStore = options.stateStore;
    this.config = options.config;
    this.botSessionId = options.sessionId ?? crypto.randomUUID();
    this._orderEngine = options.orderEngine ?? null;
    this._riskGate = options.riskGate ?? null;

    // Funding rate tracker
    this._fundingRateTracker = options.fundingTracker
      ?? new FundingRateTracker({ drainThresholdPct: options.config.fundingDrainThresholdPct });

    // Regime auto-switch wiring
    this.regimeLeaderboards = options.regimeLeaderboards ?? null;
    this.strategy = options.initialStrategy ?? null;

    if (options.regimeLeaderboards) {
      // Callers may supply a pre-built createLivePerpRegistry(provider) result.
      // If not, build one internally using the supplied fundingRateProvider.
      // The key invariant: strategies created via executeStrategySwitch() must
      // receive a real fundingRateProvider so funding adjustments fire at runtime.
      this.strategyRegistry = options.strategyRegistry
        ?? createLivePerpRegistry(options.fundingRateProvider ?? (() => null));
    } else {
      this.strategyRegistry = options.strategyRegistry ?? null;
    }
  }

  /**
   * Subscribe to markPrice events from IntxClient to monitor liquidation distance.
   */
  start(): void {
    this._onMarkPrice = (evt: IntxMarkPriceEvent) => {
      if (evt.isStale) return;

      const session = this.currentSession;
      if (!session || evt.instrument !== session.instrument) return;

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

      // Fix DASH-01 parity: update in-memory session so _computeUnrealizedPnl uses current price
      session.markPrice = evt.markPrice;
      // Emit mark-price-driven P&L update for real-time dashboard
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

      if (
        distancePct.lt(d(this.config.liquidationSafetyThresholdPct)) &&
        !this._emergencyCloseInProgress
      ) {
        this.executeEmergencyClose(evt.markPrice, distancePct.toFixed(4)).catch((err) => {
          log.error({ err: err instanceof Error ? err.message : String(err) }, 'Emergency close failed');
        });
      }
    };

    this.intxClient.on('markPrice', this._onMarkPrice);

    this._onFundingRate = (evt: IntxFundingRateEvent) => {
      if (evt.isStale) return;  // preserve stale guard (must be first check)
      if (!this.currentSession) {
        // No session open — emit market-rate-only update so dashboard panel stays live.
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
      const session = this.currentSession;
      // NOTE: evt.instrument is always 'FCM' — do NOT filter by instrument
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
        log.warn({ sessionId: session.id }, 'FUNDING_DRAIN_EXIT triggered');
        this.emit('fundingDrain', session, { cumulativeFundingCost: update.cumulativeFundingCost });
        this.closePosition('FUNDING_DRAIN_EXIT').catch((err) => {
          log.error(
            { err: err instanceof Error ? err.message : String(err) },
            'FUNDING_DRAIN_EXIT: closePosition failed',
          );
        }).finally(() => {
          this._fundingDrainInProgress = false;
        });
      }
    };
    this.intxClient.on('fundingRate', this._onFundingRate);
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
  }

  // ── Candle ingestion ──────────────────────────────────────────────────────

  /**
   * Process a completed candle.
   *
   * - Appends to the rolling candle buffer (max 100 candles).
   * - Classifies market regime — ONLY here, never in _handleMarkPrice / mark-price handler.
   * - Applies regime auto-switch logic when regimeLeaderboards is configured:
   *   switches strategy to the regime winner on regime change, with a 10-candle
   *   cooldown; defers the switch if a position is currently open (currentSession !== null).
   * - If a pendingSwitch exists and no position is open, executes it.
   * - If a strategy is set, evaluates it and routes signals to openPosition/closePosition.
   *
   * NOTE: PerpPositionManager tracks open positions via this.currentSession: PerpSession | null.
   * The open-position deferral guard uses currentSession === null (NOT currentPosition).
   */
  onCandle(candle: Candle): void {
    // Maintain rolling buffer (max 100 candles)
    this.candleBuffer.push(candle);
    if (this.candleBuffer.length > 100) {
      this.candleBuffer.shift();
    }

    // Classify regime from candle history (only here — never in mark-price handler)
    const regime = this.classifier.classify(this.candleBuffer);

    // Regime auto-switch logic (identical to PaperPerpEngine / LiveTradingEngine pattern)
    if (this.regimeLeaderboards) {
      if (this.cooldownCandlesRemaining > 0) {
        this.cooldownCandlesRemaining--;
      }
      if (
        regime !== undefined &&
        this.currentRegime !== undefined &&
        regime !== this.currentRegime &&
        this.cooldownCandlesRemaining === 0
      ) {
        const winnerConfig = this.resolveRegimeWinner(regime);
        if (winnerConfig) {
          if (this.currentSession === null) {
            this.executeStrategySwitch(winnerConfig, regime);
          } else {
            this.pendingSwitch = { strategyConfig: winnerConfig, regime };
            log.info(
              { regime, currentStrategy: this.strategy?.name },
              'Regime changed with open position -- switch deferred until position closes',
            );
          }
        }
      }
      if (regime !== undefined) {
        this.currentRegime = regime;
      }
    }

    // Execute any pending switch now that position may have closed
    if (this.pendingSwitch && this.currentSession === null) {
      this.executeStrategySwitch(this.pendingSwitch.strategyConfig, this.pendingSwitch.regime);
      this.pendingSwitch = null;
    }

    // Strategy-based signal evaluation (signal evaluation only — routing to open/close)
    if (this.strategy) {
      const timeframe = candle.timeframe as Timeframe;
      const signals = this.strategy.evaluate(
        this.candleBuffer,
        candle.pair as TradingPair,
        timeframe,
        undefined,
        regime,
      );
      for (const signal of signals) {
        if ((signal.direction === 'long' || signal.direction === 'short') && this.currentSession === null) {
          // Route open signal — caller provides entryPrice from candle close
          const direction: PerpDirection = signal.direction;
          this.openPosition({
            instrument: candle.pair,
            direction,
            size: '0.01',
            leverage: 5,
            entryPrice: candle.close,
          }).catch((err) => {
            log.error(
              { err: err instanceof Error ? err.message : String(err) },
              'strategy onCandle openPosition failed',
            );
          });
        } else if (signal.direction === 'close' && this.currentSession !== null) {
          // Route close signal
          this.closePosition('strategy-signal').catch((err) => {
            log.error(
              { err: err instanceof Error ? err.message : String(err) },
              'strategy onCandle closePosition failed',
            );
          });
        }
      }
    }
  }

  /**
   * Open a long or short position on INTX.
   *
   * 1. Guards against duplicate open positions.
   * 2. Computes and logs liquidation price before any API call.
   * 3. Persists the order BEFORE calling the API (idempotency).
   * 4. Creates the PerpSession in the state store after a successful fill.
   */
  async openPosition(params: {
    instrument: string;
    direction: PerpDirection;
    size: string;
    leverage: number;
    entryPrice: string;
    maintenanceMarginRate?: string;
    /** Required when riskGate is set — total FCM account equity used for cap/loss checks. */
    accountValue?: string;
    /** Fraction of notional to use as max-loss estimate (default 0.02 = 2%). */
    stopDistancePct?: number;
    /** Bot-internal margin policy for this entry; included in entry log and session. */
    marginMode?: 'isolated' | 'cross';
  }): Promise<PerpSession> {
    if (this.currentSession !== null && this.currentSession.status === 'open') {
      throw new Error('Position already open for this instrument');
    }

    const { instrument, direction, size, leverage, entryPrice } = params;
    const mmr = d(params.maintenanceMarginRate ?? this.config.defaultMaintenanceMarginRate);

    // Risk gate check (before liquidation calc and any API call)
    if (this._riskGate) {
      const stopPct = d(String(params.stopDistancePct ?? 0.02));
      const proposedNotional = d(size).mul(d(entryPrice));
      const proposedMaxLoss = proposedNotional.mul(stopPct);
      const accountVal = params.accountValue ?? '0';
      const tpPct = d(String(this.config.tpTargetPct ?? 2.0)).div(d('100'));
      const expectedGain = proposedNotional.mul(tpPct);
      const gateResult = await this._riskGate.check({
        instrument,
        proposedNotional: proposedNotional.toFixed(8),
        proposedMaxLoss: proposedMaxLoss.toFixed(8),
        accountValue: accountVal,
        expectedGain: expectedGain.toFixed(8),
      });
      if (!gateResult.approved) {
        throw new Error(`PerpRiskGate rejected entry: ${gateResult.rejectReason}`);
      }
    }

    // Step: compute liquidation price before entry
    const liqPrice = calcLiquidationPrice(d(entryPrice), leverage, direction, mmr);
    log.info(
      {
        instrument,
        direction,
        entryPrice,
        leverage,
        marginMode: params.marginMode ?? 'unknown',
        liquidationPrice: liqPrice.toFixed(8),
      },
      'Liquidation price computed before entry',
    );

    // Build entry order (persisted BEFORE API call)
    const clientOrderId = crypto.randomUUID();
    const now = Date.now();
    const order: PerpOrder = {
      id: clientOrderId,
      clientOrderId,
      sessionId: this.botSessionId,
      instrument,
      side: direction === 'long' ? 'BUY' : 'SELL',
      size,
      status: 'PENDING',
      purpose: 'ENTRY',
      createdAt: now,
      updatedAt: now,
    };

    // Persist BEFORE API call
    this.stateStore.persistOrder(order);

    // Place order via IntxClient
    const result = await this.intxClient.placeOrder({
      productId: instrument,
      instrument,
      side: order.side,
      size,
      orderType: 'MARKET',
      clientOrderId,
    });

    // Update order with exchange data
    order.exchangeOrderId = result.orderId;
    order.status = 'FILLED';
    order.avgFillPrice = result.avgPrice;
    order.fee = result.fee;
    order.updatedAt = Date.now();
    this.stateStore.persistOrder(order);

    // Build session
    const sessionId = crypto.randomUUID();
    const session: PerpSession = {
      id: sessionId,
      instrument,
      direction,
      entryPrice: result.avgPrice,
      size,
      leverage,
      liquidationPrice: liqPrice.toFixed(8),
      maintenanceMarginRate: mmr.toFixed(8),
      marginMode: params.marginMode,
      status: 'open',
      openedAt: Date.now(),
    };

    this.currentSession = session;
    this.stateStore.createSession(session);

    this.emit('positionOpened', session);
    // Emit exposure update so dashboard meter shows active notional.
    // exposureCapUsd and utilizationPct are '0.00' because accountValue is not
    // stored on the instance (it is an optional caller param forwarded to riskGate only).
    const notional = d(session.size).mul(d(session.entryPrice));
    this.emit('exposureUpdate', {
      totalNotionalUsd: notional.toFixed(2),
      exposureCapUsd: '0.00',
      utilizationPct: '0.00',
    });
    return session;
  }

  /**
   * Close the current open position with a close_only:true exit order.
   *
   * After close, any pending regime strategy switch is executed immediately
   * (position is no longer blocking it).
   */
  async closePosition(reason?: string): Promise<PerpSession> {
    if (!this.currentSession) {
      throw new Error('No open position to close');
    }

    const session = this.currentSession;
    const { instrument, direction, size } = session;
    const closeSide = direction === 'long' ? 'SELL' : 'BUY';
    const clientOrderId = crypto.randomUUID();
    const now = Date.now();

    const closeOrder: PerpOrder = {
      id: clientOrderId,
      clientOrderId,
      sessionId: session.id,
      instrument,
      side: closeSide,
      size,
      status: 'PENDING',
      purpose: reason === 'EMERGENCY_CLOSE' ? 'EMERGENCY_CLOSE' : 'EXIT',
      createdAt: now,
      updatedAt: now,
    };

    // Persist BEFORE API call
    this.stateStore.persistOrder(closeOrder);

    // Place close order
    const result = await this.intxClient.placeOrder({
      productId: instrument,
      instrument,
      side: closeSide,
      size,
      orderType: 'MARKET',
      closeOnly: true,
      clientOrderId,
    });

    // Update close order
    closeOrder.exchangeOrderId = result.orderId;
    closeOrder.status = 'FILLED';
    closeOrder.avgFillPrice = result.avgPrice;
    closeOrder.fee = result.fee;
    closeOrder.updatedAt = Date.now();
    this.stateStore.persistOrder(closeOrder);

    // Cancel open orders (TP + stop) before marking session closed — ORDER-05
    if (this._orderEngine) {
      try {
        await this._orderEngine.closeAndCleanup(session.id);
      } catch (err) {
        log.warn({ err }, 'PerpPositionManager: order cleanup failed, proceeding with close');
      }
    }

    // Update session
    const closedAt = Date.now();
    const closeReason = reason ?? 'manual';
    session.status = 'closed';
    session.closedAt = closedAt;
    session.closeReason = closeReason;
    this.stateStore.updateSession(session.id, { status: 'closed', closedAt, closeReason });

    // Record closed trade for analytics (Phase 32)
    const exitPriceD = d(result.avgPrice);
    const entryPriceD = d(session.entryPrice);
    const sizeD = d(session.size);
    const pricePnl = session.direction === 'long'
      ? exitPriceD.minus(entryPriceD).mul(sizeD)
      : entryPriceD.minus(exitPriceD).mul(sizeD);
    const fundingAdj = d(session.cumulativeFundingCost ?? '0');
    const realizedPnl = pricePnl.plus(fundingAdj).toFixed(8);
    this.stateStore.recordTrade({
      sessionId: session.id,
      instrument: session.instrument,
      direction: session.direction,
      leverage: session.leverage,
      entryPrice: session.entryPrice,
      exitPrice: result.avgPrice,
      size: session.size,
      cumulativeFundingCost: session.cumulativeFundingCost ?? '0.00000000',
      realizedPnl,
      openedAt: session.openedAt,
      closedAt,
      closeReason,
    });

    this.emit('positionClosed', session);
    // Position closed — reset exposure to zero.
    this.emit('exposureUpdate', {
      totalNotionalUsd: '0.00',
      exposureCapUsd: '0.00',
      utilizationPct: '0.00',
    });

    const closedSession = { ...session };
    this.currentSession = null;
    this._fundingRateTracker.reset();

    // Execute any pending regime strategy switch now that position is closed
    if (this.pendingSwitch) {
      this.executeStrategySwitch(this.pendingSwitch.strategyConfig, this.pendingSwitch.regime);
      this.pendingSwitch = null;
    }

    return closedSession;
  }

  /**
   * Emergency close: triggered when liquidation distance falls below the safety threshold.
   * Logs LIQUIDATION_RISK, emits emergencyClose event, then closes the position.
   * The _emergencyCloseInProgress flag is reset in a finally block regardless of outcome.
   */
  private async executeEmergencyClose(
    markPrice: string,
    distancePct: string,
  ): Promise<void> {
    this._emergencyCloseInProgress = true;
    const session = this.currentSession!;

    log.warn(
      {
        instrument: session.instrument,
        markPrice,
        liquidationPrice: session.liquidationPrice,
        distancePct,
      },
      'LIQUIDATION_RISK: emergency close triggered',
    );

    this.emit('emergencyClose', session, { markPrice, distancePct });

    try {
      await this.closePosition('EMERGENCY_CLOSE');
    } finally {
      this._emergencyCloseInProgress = false;
    }
  }

  /**
   * Reconcile internal state with FCM on startup after a crash or restart.
   *
   * Strategy:
   * 1. Query PerpStateStore for any session with status='open'
   * 2. For each open session, call intxClient.getAccountState() and parse positions
   * 3. Match by product_id; check FCM position shape:
   *    - side === 'LONG' → still long on exchange
   *    - side === 'SHORT' → still short on exchange
   *    - missing or number_of_contracts === 0 → position closed externally
   * 4. If exchange confirms position open: restore this.currentSession from DB
   * 5. If exchange shows no position: mark session closed with closeReason='external_close'
   * 6. Check for PENDING orders: log at warn and mark FAILED (conservative; prevents double-entry)
   * 7. Log reconciliation result at info
   * 8. Return: { restored: boolean; closedExternally: boolean }
   */
  async recoverFromRestart(): Promise<{ restored: boolean; closedExternally: boolean }> {
    const openSessions = this.stateStore.getAllOpenSessions();

    if (openSessions.length === 0) {
      log.info('recoverFromRestart: no open sessions in DB — nothing to reconcile');
      return { restored: false, closedExternally: false };
    }

    const accountState = await this.intxClient.getAccountState();
    const positions = accountState.positions ?? [];

    let restored = false;
    let closedExternally = false;

    for (const dbSession of openSessions) {
      // Mark any PENDING orders as FAILED before doing anything else
      const pendingOrders = this.stateStore.getPendingOrders(dbSession.id);
      for (const order of pendingOrders) {
        log.warn(
          { clientOrderId: order.clientOrderId, instrument: order.instrument },
          'Unconfirmed PENDING order on restart — marking FAILED (conservative)',
        );
        this.stateStore.persistOrder({ ...order, status: 'FAILED', updatedAt: Date.now() });
      }

      // Find matching FCM position on exchange by product_id
      const exchangePos = positions.find((p) => p.product_id === dbSession.instrument);
      const contracts = exchangePos?.number_of_contracts;
      const isZeroOnExchange = !exchangePos || Number(contracts) === 0;

      const isLongOnExchange = !isZeroOnExchange && exchangePos?.side === 'LONG';
      const isShortOnExchange = !isZeroOnExchange && exchangePos?.side === 'SHORT';

      const sessionMatchesExchange =
        (dbSession.direction === 'long' && isLongOnExchange) ||
        (dbSession.direction === 'short' && isShortOnExchange);

      if (sessionMatchesExchange) {
        // Position still open — restore
        this.currentSession = dbSession;
        restored = true;
        log.info(
          { sessionId: dbSession.id, instrument: dbSession.instrument, direction: dbSession.direction },
          'recoverFromRestart: session restored from DB — exchange position confirmed open',
        );
      } else {
        // Position closed externally
        const closedAt = Date.now();
        this.stateStore.updateSession(dbSession.id, {
          status: 'closed',
          closedAt,
          closeReason: 'external_close',
        });
        closedExternally = true;
        log.info(
          { sessionId: dbSession.id, instrument: dbSession.instrument, numberOfContracts: contracts ?? '0' },
          'recoverFromRestart: session closed externally — marked closed in DB',
        );
      }
    }

    log.info(
      { restored, closedExternally, sessionsChecked: openSessions.length },
      'recoverFromRestart: reconciliation complete',
    );

    return { restored, closedExternally };
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

  // ── Regime auto-switch helpers ────────────────────────────────────────────

  /**
   * Resolve the best strategy config for the given regime from the leaderboard.
   * Returns entries[0].strategyConfig if the regime has at least one entry,
   * otherwise falls back to fallbackEntry.strategyConfig.
   */
  private resolveRegimeWinner(regime: MarketRegime): Record<string, unknown> | null {
    if (!this.regimeLeaderboards) return null;
    const entries = this.regimeLeaderboards[regime];
    if (entries && entries.length > 0) {
      return entries[0].strategyConfig;
    }
    return this.regimeLeaderboards.fallbackEntry.strategyConfig;
  }

  /**
   * Instantiate a new strategy from config, assign it, reset cooldown, emit event.
   */
  private executeStrategySwitch(strategyConfig: Record<string, unknown>, regime?: MarketRegime): void {
    this.strategy = this.strategyRegistry!.create(strategyConfig);
    this.cooldownCandlesRemaining = STRATEGY_SWITCH_COOLDOWN_CANDLES;
    const logMsg = regime
      ? `regime ${regime}: switching to ${this.strategy.name}`
      : 'Strategy switched due to regime change';
    log.info(
      { newStrategy: this.strategy.name, regime, cooldown: STRATEGY_SWITCH_COOLDOWN_CANDLES },
      logMsg,
    );
    this.emit('strategySwitch', { newStrategy: this.strategy.name });
  }

  // ── Accessors ──────────────────────────────────────────────────────

  getCurrentSession(): PerpSession | null {
    return this.currentSession;
  }

  isPositionOpen(): boolean {
    return this.currentSession !== null && this.currentSession.status === 'open';
  }
}
