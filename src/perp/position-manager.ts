/**
 * PerpPositionManager -- open/close/emergency-close lifecycle for INTX perp positions.
 *
 * Provides:
 *  - openPosition():  IOC market entry with pre-entry liquidation price logging
 *  - closePosition(): close_only:true IOC market exit
 *  - executeEmergencyClose(): triggered when liquidation distance falls below threshold
 *  - start()/stop():  subscribe/unsubscribe markPrice events from IntxClient
 *
 * Safety guarantees:
 *  - stateStore.persistOrder() is called BEFORE every API order submission (idempotency)
 *  - calcLiquidationPrice is called and logged before every openPosition() API call
 *  - Emergency close uses a guard flag (_emergencyCloseInProgress) reset in a finally block
 */

import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { d } from '../core/decimal.js';
import { createModuleLogger } from '../core/logger.js';
import { calcLiquidationPrice, calcLiquidationDistance } from './liquidation-calc.js';
import type { IntxClient } from './intx-client.js';
import type { PerpStateStore } from './perp-state-store.js';
import type { IntxConfig } from './config.js';
import type { PerpOrderEngine } from './order-engine.js';
import type { PerpRiskGate } from './perp-risk-gate.js';
import type {
  PerpSession,
  PerpOrder,
  PerpPositionManagerEvents,
  PerpDirection,
} from './types.js';
import type { IntxMarkPriceEvent } from './types.js';

const log = createModuleLogger('perp-position-manager');

export interface PerpPositionManagerOptions {
  intxClient: IntxClient;
  stateStore: PerpStateStore;
  config: IntxConfig;
  sessionId?: string;
  orderEngine?: PerpOrderEngine; // optional: if provided, closeAndCleanup() called on all close paths
  riskGate?: PerpRiskGate;       // optional: if provided, check() called before every openPosition() API call
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
  }

  /**
   * Unsubscribe from markPrice events.
   */
  stop(): void {
    if (this._onMarkPrice) {
      this.intxClient.off('markPrice', this._onMarkPrice);
      this._onMarkPrice = null;
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
      const gateResult = await this._riskGate.check({
        instrument,
        proposedNotional: proposedNotional.toFixed(8),
        proposedMaxLoss: proposedMaxLoss.toFixed(8),
        accountValue: accountVal,
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
    return session;
  }

  /**
   * Close the current open position with a close_only:true exit order.
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

    this.emit('positionClosed', session);

    const closedSession = { ...session };
    this.currentSession = null;
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

  // ── Accessors ──────────────────────────────────────────────────────

  getCurrentSession(): PerpSession | null {
    return this.currentSession;
  }

  isPositionOpen(): boolean {
    return this.currentSession !== null && this.currentSession.status === 'open';
  }
}
