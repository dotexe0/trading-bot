/**
 * LiveTradingEngine -- real-time live trading with real order execution.
 *
 * Mirrors PaperTradingEngine's event-driven architecture but replaces
 * FillSimulator with OrderManager for real exchange order submission.
 * Includes graceful shutdown state machine and restart recovery.
 *
 * Pipeline: LiveDataFeed -> candle buffer -> strategy evaluate ->
 * risk management -> OrderManager -> exchange.
 */

import { EventEmitter } from 'node:events';
import { d, ZERO } from '../core/decimal.js';
import type Decimal from 'decimal.js';
import type { Candle } from '../core/types.js';
import type { Signal } from '../strategies/types.js';
import type { IStrategy } from '../strategies/types.js';
import type { StrategyRegistry } from '../strategies/registry.js';
import type { IndicatorEngine } from '../indicators/engine.js';
import type { RiskManager } from '../risk/risk-manager.js';
import { PositionSizer } from '../risk/position-sizer.js';
import { StopLossTracker } from '../risk/stop-loss.js';
import type { RiskContext, StrategyStats } from '../risk/types.js';
import type { LiveDataFeed } from '../paper/live-data-feed.js';
import type { OrderManager } from './order-manager.js';
import type { LiveStateStore } from './state-store.js';
import type {
  LiveTradingConfig,
  LiveSession,
  LiveOrder,
  ShutdownState,
} from './types.js';
import { createModuleLogger } from '../core/logger.js';

const log = createModuleLogger('live-engine');

/** Default position size as fraction of equity when no risk manager is used. */
const DEFAULT_POSITION_SIZE_PCT = 0.95;

/** Minimum base size increments for supported pairs (v1 hardcoded). */
const BASE_INCREMENTS: Record<string, number> = {
  'BTC-USD': 0.00000001,
  'ETH-USD': 0.00000001,
};

// ── Types ───────────────────────────────────────────────────────────

export interface LiveTradingEngineOptions {
  config: LiveTradingConfig;
  liveFeed: LiveDataFeed;
  orderManager: OrderManager;
  stateStore: LiveStateStore;
  strategyRegistry: StrategyRegistry;
  indicatorEngine: IndicatorEngine;
  riskManager?: RiskManager;
  strategyStats?: StrategyStats;
  resumeSessionId?: string;
}

interface CurrentPosition {
  orderId: string;
  side: 'BUY' | 'SELL';
  quantity: Decimal;
  entryPrice: Decimal;
  pending: boolean;
}

// ── LiveTradingEngine ───────────────────────────────────────────────

export class LiveTradingEngine extends EventEmitter {
  private readonly config: LiveTradingConfig;
  private readonly liveFeed: LiveDataFeed;
  private readonly orderManager: OrderManager;
  private readonly stateStore: LiveStateStore;
  private readonly strategyRegistry: StrategyRegistry;
  private readonly indicatorEngine: IndicatorEngine;
  private readonly riskManager?: RiskManager;
  private readonly strategyStats?: StrategyStats;
  private readonly resumeSessionId?: string;

  private strategy!: IStrategy;
  private positionSizer?: PositionSizer;
  private stopLossTracker: StopLossTracker | null = null;
  private candleBuffer: Map<string, Candle[]> = new Map();
  private session: LiveSession | null = null;
  private isRunning = false;
  private shutdownState: ShutdownState = 'running';
  private positionDirection: 'long' | 'short' | null = null;
  private currentPosition: CurrentPosition | null = null;
  private reconciliationTimer: ReturnType<typeof setInterval> | null = null;
  private cashBalance: Decimal = ZERO;
  private peakEquity: Decimal = ZERO;
  private recoveryFailed = false;

  constructor(options: LiveTradingEngineOptions) {
    super();
    this.config = options.config;
    this.liveFeed = options.liveFeed;
    this.orderManager = options.orderManager;
    this.stateStore = options.stateStore;
    this.strategyRegistry = options.strategyRegistry;
    this.indicatorEngine = options.indicatorEngine;
    this.riskManager = options.riskManager;
    this.strategyStats = options.strategyStats;
    this.resumeSessionId = options.resumeSessionId;
  }

  // ── Public API ─────────────────────────────────────────────────────

  /**
   * Start the live trading engine.
   * Creates a new session or recovers from a previous one.
   */
  async start(): Promise<LiveSession> {
    // Create strategy from config
    this.strategy = this.strategyRegistry.create(this.config.strategyConfig);

    // Set up position sizer if risk manager available
    if (this.riskManager && this.config.riskConfig) {
      this.positionSizer = new PositionSizer(this.config.riskConfig);
    }

    // Initialize cash balance
    this.cashBalance = d(this.config.initialCapital);
    this.peakEquity = d(this.config.initialCapital);

    if (this.resumeSessionId) {
      // Restart recovery
      await this.recoverFromRestart(this.resumeSessionId);
      if (this.recoveryFailed) {
        // Recovery found unresolvable discrepancies -- don't start trading
        return this.session!;
      }
    } else {
      // Create new session
      this.session = this.stateStore.createSession(
        this.config,
        this.strategy.name,
      );
    }

    // Wire liveFeed 'candle' event
    this.liveFeed.on('candle', (candle: Candle) => this.onCandle(candle));
    this.liveFeed.on('error', (err: Error) => {
      log.error({ err, sessionId: this.session?.id }, 'LiveDataFeed error');
      this.emit('error', err);
    });

    // Wire orderManager events
    this.orderManager.on('orderFilled', (order: LiveOrder) =>
      this.onOrderFilled(order),
    );
    this.orderManager.on('orderFailed', (order: LiveOrder, error: Error) =>
      this.onOrderFailed(order, error),
    );

    // Start orderManager tracking
    this.orderManager.startTracking();

    // Start live feed
    this.liveFeed.start([this.config.pair], this.config.pollIntervalMs);

    // Start reconciliation interval
    this.reconciliationTimer = setInterval(
      () => {
        this.orderManager.reconcile().catch((err) => {
          log.error({ err }, 'Scheduled reconciliation failed');
        });
      },
      this.config.reconciliationIntervalMs,
    );

    this.isRunning = true;
    this.shutdownState = 'running';

    log.info(
      {
        sessionId: this.session!.id,
        strategy: this.strategy.name,
        pair: this.config.pair,
        timeframe: this.config.timeframe,
      },
      'Live trading engine started',
    );

    this.emit('started', this.session!);
    return this.session!;
  }

  /**
   * Stop the engine gracefully and return the session result.
   */
  async stop(): Promise<LiveSession> {
    await this.shutdown();
    return this.session!;
  }

  /** Get the current session, if any. */
  getSession(): LiveSession | null {
    return this.session;
  }

  /** Whether the engine is currently running. */
  get running(): boolean {
    return this.isRunning;
  }

  /** Current shutdown state. */
  getShutdownState(): ShutdownState {
    return this.shutdownState;
  }

  // ── Core: candle processing ────────────────────────────────────────

  /**
   * Process a completed candle through the trading pipeline.
   */
  onCandle(candle: Candle): void {
    if (!this.isRunning || !this.session) return;
    if (this.shutdownState !== 'running') return;

    log.debug(
      { pair: candle.pair, timestamp: candle.timestamp, close: candle.close },
      'Candle received',
    );

    // 1. Buffer management
    const key = `${candle.pair}:${candle.timeframe}`;
    let buffer = this.candleBuffer.get(key);
    if (!buffer) {
      buffer = [];
      this.candleBuffer.set(key, buffer);
    }

    buffer.push(candle);

    // Enforce sliding window
    while (buffer.length > this.config.bufferSize) {
      buffer.shift();
    }

    // Wait for enough data
    if (buffer.length < this.strategy.minCandles) {
      return;
    }

    // 2. Stop-loss check (before strategy evaluation)
    if (this.currentPosition && !this.currentPosition.pending && this.stopLossTracker) {
      const check = this.stopLossTracker.check({
        low: candle.low,
        high: candle.high,
        close: candle.close,
      });

      if (check.triggered) {
        log.warn(
          {
            sessionId: this.session.id,
            pair: candle.pair,
            stopPrice: check.stopPrice.toString(),
          },
          'Stop-loss triggered',
        );

        // Submit close order via OrderManager
        const closeSide = this.currentPosition.side === 'BUY' ? 'SELL' : 'BUY';
        this.orderManager
          .submitMarketOrder({
            pair: candle.pair,
            side: closeSide,
            baseSize: this.currentPosition.quantity.toFixed(8),
            purpose: 'STOP_LOSS',
          })
          .catch((err) => {
            log.error({ err }, 'Failed to submit stop-loss close order');
          });

        this.stopLossTracker = null;
        return; // Don't evaluate strategy after stop-loss
      }
    }

    // 3. Strategy evaluation
    const signals = this.strategy.evaluate(
      buffer,
      candle.pair,
      candle.timeframe,
    );

    // 4. Signal processing
    for (const signal of signals) {
      // Skip shorts if not allowed
      if (!this.config.allowShorts && signal.direction === 'short') {
        continue;
      }

      if (signal.direction === 'close') {
        this.processCloseSignal(signal, candle);
      } else {
        this.processEntrySignal(signal, candle);
      }
    }

    // 5. Equity recording (estimate from last known price + cash)
    const currentPrice = d(candle.close);
    let equity = this.cashBalance;
    if (this.currentPosition && !this.currentPosition.pending) {
      equity = equity.plus(this.currentPosition.quantity.mul(currentPrice));
    }
    if (equity.gt(this.peakEquity)) {
      this.peakEquity = equity;
    }

    this.stateStore.recordEquityPoint(
      this.session.id,
      candle.timestamp,
      equity.toFixed(2),
    );
  }

  // ── Private: signal processing ────────────────────────────────────

  private processEntrySignal(signal: Signal, candle: Candle): void {
    // Don't enter if already in position
    if (this.currentPosition !== null) return;

    const currentPrice = d(candle.close);
    let equity = this.cashBalance;
    let quantity: Decimal;

    if (this.riskManager && this.positionSizer && this.config.riskConfig) {
      // Risk-managed sizing
      const sizeResult = this.positionSizer.calculate(
        equity,
        currentPrice,
        this.strategyStats ?? null,
      );
      quantity = sizeResult.quantity;

      if (quantity.lte(ZERO)) return;

      // Build risk context
      const riskContext: RiskContext = {
        signal,
        proposedQuantity: quantity,
        proposedPrice: currentPrice,
        currentEquity: equity,
        peakEquity: this.peakEquity,
        cashBalance: this.cashBalance,
        openPositionCount: this.currentPosition ? 1 : 0,
        totalExposure: ZERO,
        dailyPnL: ZERO,
        riskConfig: this.config.riskConfig,
        timestamp: candle.timestamp,
      };

      const decision = this.riskManager.evaluate(riskContext);

      if (!decision.approved) {
        log.info(
          {
            sessionId: this.session?.id,
            reason: decision.rejectReason,
          },
          'Risk manager rejected entry',
        );
        return;
      }

      quantity = decision.finalQuantity;
    } else {
      // Simple sizing: default percentage of equity / price
      quantity = equity.mul(d(DEFAULT_POSITION_SIZE_PCT)).div(currentPrice);
      if (quantity.lte(ZERO)) return;
    }

    // Round quantity DOWN to base increment
    const pair = candle.pair;
    const increment = BASE_INCREMENTS[pair] ?? 0.00000001;
    const rawQty = quantity.toNumber();
    const roundedQty = Math.floor(rawQty / increment) * increment;
    if (roundedQty < increment) {
      log.warn({ pair, quantity: rawQty }, 'Quantity too small after rounding');
      return;
    }

    const side = signal.direction === 'long' ? 'BUY' : 'SELL';

    // Set pending position state
    this.currentPosition = {
      orderId: '',
      side: side as 'BUY' | 'SELL',
      quantity: d(roundedQty),
      entryPrice: currentPrice,
      pending: true,
    };
    this.positionDirection = signal.direction as 'long' | 'short';

    // Submit market order
    this.orderManager
      .submitMarketOrder({
        pair,
        side: side as 'BUY' | 'SELL',
        baseSize: roundedQty.toFixed(8),
        purpose: 'ENTRY',
      })
      .then((order) => {
        if (this.currentPosition?.pending) {
          this.currentPosition.orderId = order.orderId;
        }

        // Set up stop-loss tracker
        if (this.riskManager && this.config.riskConfig) {
          const direction = signal.direction as 'long' | 'short';
          this.stopLossTracker = new StopLossTracker(
            {
              type: this.config.riskConfig.stopLoss.type,
              percentage: d(this.config.riskConfig.stopLoss.percentage),
            },
            currentPrice,
            direction,
          );
        }

        log.info(
          {
            sessionId: this.session?.id,
            direction: signal.direction,
            quantity: roundedQty.toFixed(8),
            orderId: order.orderId,
          },
          'Entry order submitted',
        );
      })
      .catch((err) => {
        log.error({ err }, 'Failed to submit entry order');
        // Clear pending position on failure
        this.currentPosition = null;
        this.positionDirection = null;
      });
  }

  private processCloseSignal(signal: Signal, candle: Candle): void {
    // If no position, skip
    if (!this.currentPosition || this.currentPosition.pending) return;

    const closeSide = this.currentPosition.side === 'BUY' ? 'SELL' : 'BUY';

    this.orderManager
      .submitMarketOrder({
        pair: candle.pair,
        side: closeSide,
        baseSize: this.currentPosition.quantity.toFixed(8),
        purpose: 'EXIT',
      })
      .then((order) => {
        log.info(
          { sessionId: this.session?.id, orderId: order.orderId },
          'Exit order submitted',
        );
      })
      .catch((err) => {
        log.error({ err }, 'Failed to submit exit order');
      });

    // Clear stop-loss tracker
    this.stopLossTracker = null;
  }

  // ── Order event handlers ──────────────────────────────────────────

  private onOrderFilled(order: LiveOrder): void {
    if (!this.session) return;

    if (order.purpose === 'ENTRY') {
      // Confirm position with actual fill data
      const fillPrice = d(order.averageFillPrice ?? order.baseSize);
      const fillQty = d(order.filledSize);

      this.currentPosition = {
        orderId: order.orderId,
        side: order.side,
        quantity: fillQty,
        entryPrice: fillPrice,
        pending: false,
      };

      // Update cash balance (deduct cost + fees)
      const cost = fillPrice.mul(fillQty);
      const fees = d(order.totalFees);
      this.cashBalance = this.cashBalance.minus(cost).minus(fees);

      log.info(
        {
          sessionId: this.session.id,
          orderId: order.orderId,
          fillPrice: fillPrice.toString(),
          fillQty: fillQty.toString(),
          fees: fees.toString(),
        },
        'Entry order filled',
      );
    } else if (order.purpose === 'EXIT' || order.purpose === 'STOP_LOSS') {
      // Compute PnL
      if (this.currentPosition) {
        const exitPrice = d(order.averageFillPrice ?? '0');
        const exitQty = d(order.filledSize);
        const entryPrice = this.currentPosition.entryPrice;
        const entryQty = this.currentPosition.quantity;
        const fees = d(order.totalFees);

        // Credit cash for exit
        const exitValue = exitPrice.mul(exitQty);
        this.cashBalance = this.cashBalance.plus(exitValue).minus(fees);

        // Calculate PnL
        let pnl: Decimal;
        if (this.currentPosition.side === 'BUY') {
          pnl = exitPrice.minus(entryPrice).mul(exitQty).minus(fees);
        } else {
          pnl = entryPrice.minus(exitPrice).mul(exitQty).minus(fees);
        }

        // Record completed trade
        this.stateStore.recordTrade(this.session.id, {
          sessionId: this.session.id,
          entryOrderId: this.currentPosition.orderId,
          exitOrderId: order.orderId,
          entryTimestamp: order.createdAt,
          entryPrice: entryPrice.toFixed(8),
          entryFee: '0',
          entrySide: this.currentPosition.side,
          entryQuantity: entryQty.toFixed(8),
          exitTimestamp: order.updatedAt,
          exitPrice: exitPrice.toFixed(8),
          exitFee: fees.toFixed(8),
          exitSide: order.side,
          exitQuantity: exitQty.toFixed(8),
          pnl: pnl.toFixed(8),
          pnlPct: entryPrice.mul(entryQty).isZero()
            ? '0.0000'
            : pnl.div(entryPrice.mul(entryQty)).mul(100).toFixed(4),
          holdingPeriodMs: order.updatedAt - order.createdAt,
        });

        log.info(
          {
            sessionId: this.session.id,
            pnl: pnl.toString(),
            purpose: order.purpose,
          },
          'Position closed',
        );
      }

      // Clear position
      this.currentPosition = null;
      this.positionDirection = null;
      this.stopLossTracker = null;
    }

    this.emit('orderFilled', order);
  }

  private onOrderFailed(order: LiveOrder, error: Error): void {
    if (!this.session) return;

    log.error(
      {
        sessionId: this.session.id,
        orderId: order.orderId,
        purpose: order.purpose,
        error: error.message,
      },
      'Order failed',
    );

    if (order.purpose === 'ENTRY') {
      // Clear pending position state
      this.currentPosition = null;
      this.positionDirection = null;
    } else if (order.purpose === 'EXIT' || order.purpose === 'STOP_LOSS') {
      // CRITICAL: Position may be stuck -- trigger reconciliation
      log.error(
        {
          sessionId: this.session.id,
          orderId: order.orderId,
          purpose: order.purpose,
        },
        'CRITICAL: Exit/stop-loss order failed -- position may be stuck, triggering reconciliation',
      );
      this.orderManager.reconcile().catch((err) => {
        log.error({ err }, 'Emergency reconciliation failed after exit order failure');
      });
    }

    this.emit('orderFailed', order, error);
  }

  // ── Graceful Shutdown ─────────────────────────────────────────────

  /**
   * Graceful shutdown state machine.
   *
   * Sequence: blocking_signals -> cancelling_orders -> setting_stops ->
   * closing_connections -> done
   */
  async shutdown(): Promise<void> {
    if (this.shutdownState !== 'running') return;

    log.info({ sessionId: this.session?.id }, 'Starting graceful shutdown');

    const timeoutPromise = new Promise<void>((_, reject) => {
      setTimeout(
        () => reject(new Error('Shutdown timeout exceeded')),
        this.config.shutdownTimeoutMs,
      );
    });

    try {
      await Promise.race([this.doShutdown(), timeoutPromise]);
    } catch (err) {
      log.warn(
        { err },
        'Shutdown timeout exceeded, force-closing',
      );
      // Force close everything
      this.forceClose();
    }

    this.shutdownState = 'done';
    this.emit('shutdown', this.shutdownState);
  }

  private async doShutdown(): Promise<void> {
    // Step 1: Block signals
    this.shutdownState = 'blocking_signals';
    this.isRunning = false;

    // Clear reconciliation interval
    if (this.reconciliationTimer) {
      clearInterval(this.reconciliationTimer);
      this.reconciliationTimer = null;
    }

    // Step 2: Cancel all open/pending orders
    this.shutdownState = 'cancelling_orders';
    try {
      const cancelled = await this.orderManager.cancelAllOrders();
      log.info({ cancelled }, 'Cancelled open orders during shutdown');
    } catch (err) {
      log.error({ err }, 'Error cancelling orders during shutdown');
    }

    // Step 3: Set stop-losses on open positions
    this.shutdownState = 'setting_stops';
    if (this.currentPosition && !this.currentPosition.pending && this.config.enableStopLossOnShutdown) {
      try {
        await this.setShutdownStopLoss();
      } catch (err) {
        log.error({ err }, 'Error setting shutdown stop-loss, submitting market close');
        // Fall back to market close
        try {
          const closeSide = this.currentPosition!.side === 'BUY' ? 'SELL' : 'BUY';
          await this.orderManager.submitMarketOrder({
            pair: this.config.pair,
            side: closeSide,
            baseSize: this.currentPosition!.quantity.toFixed(8),
            purpose: 'EXIT',
          });
        } catch (closeErr) {
          log.error({ err: closeErr }, 'Failed to submit market close during shutdown');
        }
      }
    } else if (this.currentPosition && !this.currentPosition.pending && !this.config.enableStopLossOnShutdown) {
      // No stop-loss on shutdown: close position with market order
      try {
        const closeSide = this.currentPosition.side === 'BUY' ? 'SELL' : 'BUY';
        await this.orderManager.submitMarketOrder({
          pair: this.config.pair,
          side: closeSide,
          baseSize: this.currentPosition.quantity.toFixed(8),
          purpose: 'EXIT',
        });
      } catch (err) {
        log.error({ err }, 'Failed to submit market close during shutdown');
      }
    }

    // Step 4: Close connections
    this.shutdownState = 'closing_connections';
    this.liveFeed.stop();
    this.orderManager.stopTracking();

    // Persist final state
    if (this.session) {
      const lastPrice = this.getLastKnownPrice();
      let equity = this.cashBalance;
      if (this.currentPosition && !this.currentPosition.pending) {
        equity = equity.plus(this.currentPosition.quantity.mul(lastPrice));
      }
      this.stateStore.endSession(
        this.session.id,
        equity.toFixed(2),
        'shutdown',
      );
    }
  }

  private async setShutdownStopLoss(): Promise<void> {
    if (!this.currentPosition) return;

    const lastPrice = this.getLastKnownPrice();
    const stopPct = this.config.riskConfig?.stopLoss?.percentage ?? 0.05;

    let stopPrice: Decimal;
    let limitPrice: Decimal;
    let side: 'BUY' | 'SELL';

    if (this.currentPosition.side === 'BUY') {
      // Long position: stop below current price
      stopPrice = lastPrice.mul(d(1).minus(d(stopPct)));
      limitPrice = stopPrice.mul(d(0.998));
      side = 'SELL';
    } else {
      // Short position: stop above current price
      stopPrice = lastPrice.mul(d(1).plus(d(stopPct)));
      limitPrice = stopPrice.mul(d(1.002));
      side = 'BUY';
    }

    await this.orderManager.submitStopLimitOrder({
      pair: this.config.pair,
      side,
      baseSize: this.currentPosition.quantity.toFixed(8),
      stopPrice: stopPrice.toFixed(2),
      limitPrice: limitPrice.toFixed(2),
      purpose: 'STOP_LOSS',
    });

    log.info(
      {
        sessionId: this.session?.id,
        stopPrice: stopPrice.toFixed(2),
        limitPrice: limitPrice.toFixed(2),
        side,
      },
      'Shutdown stop-loss order placed',
    );
  }

  private forceClose(): void {
    this.isRunning = false;
    if (this.reconciliationTimer) {
      clearInterval(this.reconciliationTimer);
      this.reconciliationTimer = null;
    }
    try {
      this.liveFeed.stop();
    } catch {
      // ignore
    }
    try {
      this.orderManager.stopTracking();
    } catch {
      // ignore
    }
    if (this.session) {
      try {
        const lastPrice = this.getLastKnownPrice();
        let equity = this.cashBalance;
        if (this.currentPosition && !this.currentPosition.pending) {
          equity = equity.plus(this.currentPosition.quantity.mul(lastPrice));
        }
        this.stateStore.endSession(this.session.id, equity.toFixed(2), 'shutdown');
      } catch {
        // ignore
      }
    }
  }

  // ── Restart Recovery ──────────────────────────────────────────────

  /**
   * Recover state from a previous session after restart.
   *
   * Steps:
   * 1. Load session from stateStore
   * 2. Reconcile with exchange
   * 3. Reconstruct position from order history
   * 4. Check for unresolvable discrepancies
   */
  private async recoverFromRestart(sessionId: string): Promise<void> {
    log.info({ sessionId }, 'Starting restart recovery');

    // 1. Load session
    const session = this.stateStore.getSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found for restart recovery`);
    }
    if (session.status !== 'running' && session.status !== 'shutdown') {
      throw new Error(
        `Session ${sessionId} has status '${session.status}', cannot recover`,
      );
    }
    this.session = session;
    this.cashBalance = d(session.initialCapital);

    // 2. Run full reconciliation
    const report = await this.orderManager.reconcile();

    // 3. Reconstruct position from filled orders
    const trades = this.stateStore.getSessionTrades(sessionId);
    const filledEntryOrderIds = new Set(trades.map((t) => t.entryOrderId));
    const filledExitOrderIds = new Set(
      trades.filter((t) => t.exitOrderId).map((t) => t.exitOrderId),
    );

    // Check for pending orders (submitted before crash)
    const pendingOrders = this.stateStore.getPendingOrders(sessionId);
    if (pendingOrders.length > 0) {
      log.warn(
        { pendingCount: pendingOrders.length },
        'Found pending orders from before crash',
      );
    }

    // Look for open entry orders that haven't been exited
    // We reconstruct from the last entry without a matching exit
    const openOrders = this.stateStore.getOpenOrders(sessionId);

    // Find the most recent filled ENTRY that has no corresponding EXIT trade
    // Using trades to find unmatched entries
    let hasOpenPosition = false;
    for (const trade of trades) {
      if (!trade.exitTimestamp && trade.entryPrice) {
        // Open trade found
        hasOpenPosition = true;
        this.currentPosition = {
          orderId: trade.entryOrderId,
          side: trade.entrySide,
          quantity: d(trade.entryQuantity),
          entryPrice: d(trade.entryPrice),
          pending: false,
        };
        this.positionDirection = trade.entrySide === 'BUY' ? 'long' : 'short';

        // Re-create StopLossTracker
        if (this.riskManager && this.config.riskConfig) {
          this.stopLossTracker = new StopLossTracker(
            {
              type: this.config.riskConfig.stopLoss.type,
              percentage: d(this.config.riskConfig.stopLoss.percentage),
            },
            d(trade.entryPrice),
            this.positionDirection,
          );
        }
        break;
      }
    }

    // 4. Check for critical discrepancies
    const criticalDiscrepancies = report.discrepancies.filter(
      (d) => d.type === 'BALANCE_MISMATCH' || d.type === 'MISSING_FROM_EXCHANGE',
    );

    if (criticalDiscrepancies.length > 0) {
      log.error(
        {
          sessionId,
          discrepancies: criticalDiscrepancies,
        },
        'CRITICAL: Unresolvable discrepancies found during restart recovery -- NOT auto-trading',
      );
      this.isRunning = false;
      this.recoveryFailed = true;
      this.emit('error', new Error('Unresolvable discrepancies during restart recovery'));
      return;
    }

    // Recovery successful
    log.info(
      {
        sessionId,
        hasPosition: hasOpenPosition,
        positionSide: this.currentPosition?.side,
        positionQty: this.currentPosition?.quantity.toString(),
        reconciledDiscrepancies: report.discrepancies.length,
        pendingOrders: pendingOrders.length,
      },
      'Restart recovery complete',
    );
  }

  // ── Helpers ───────────────────────────────────────────────────────

  private getLastKnownPrice(): Decimal {
    for (const [, buffer] of this.candleBuffer) {
      if (buffer.length > 0) {
        return d(buffer[buffer.length - 1].close);
      }
    }
    return d(this.config.initialCapital);
  }
}
