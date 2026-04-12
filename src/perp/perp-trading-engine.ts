/**
 * PerpTradingEngine — unified perpetual futures engine for paper and live modes.
 *
 * Replaces both PaperPerpEngine and PerpPositionManager by injecting an
 * IPerpOrderExecutor that handles the fill mechanism:
 *   - PaperPerpOrderExecutor: instant simulated fills at mark price
 *   - LivePerpOrderExecutor:  real FCM API calls with order persistence
 *
 * All strategy evaluation, risk checks, liquidation monitoring, funding tracking,
 * regime auto-switch, and event emission live here — never in the executor.
 *
 * The `mode` flag is only checked in lifecycle methods (start/stop), never in
 * the hot path (onCandle, position open/close).
 */

import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { d } from '../core/decimal.js';
import { createModuleLogger } from '../core/logger.js';
import { TIMEFRAME_MS } from '../core/types.js';
import { calcLiquidationPrice, calcLiquidationDistance } from './liquidation-calc.js';
import { PerpStrategyController } from './perp-strategy-controller.js';
import { FundingRateTracker } from './funding-tracker.js';
import type { IPerpOrderExecutor } from './order-executor.js';
import type { IntxClient } from './intx-client.js';
import type { PerpStateStore } from './perp-state-store.js';
import type { IntxConfig } from './config.js';
import type { PerpRiskGate } from './perp-risk-gate.js';
import type { IStrategy } from '../strategies/types.js';
import type { StrategyRegistry } from '../strategies/registry.js';
import type { RegimeLeaderboards } from '../tournament/types.js';
import type { CandleRepository } from '../data/storage/candle-repo.js';
import type { Candle, TradingPair, Timeframe } from '../core/types.js';
import type {
  PerpSession,
  PerpDirection,
  PerpEngineEvents,
  IntxMarkPriceEvent,
  IntxFundingRateEvent,
} from './types.js';
import type { FeedHealthMonitor } from '../core/feed-health.js';
import { computeLeverage } from './leverage-sizer.js';
import { MarketRegime } from '../regime/types.js';

const log = createModuleLogger('perp-trading-engine');

// ── Options ───────────────────────────────────────────────────────────

export interface PerpTradingEngineOptions {
  mode: 'paper' | 'live';
  executor: IPerpOrderExecutor;
  intxClient: IntxClient;
  stateStore: PerpStateStore;
  config: IntxConfig;
  tradingPair: TradingPair;
  timeframe: Timeframe;
  candleRepo?: CandleRepository;
  riskGate?: PerpRiskGate;
  /**
   * Optional signal callback (imperative path). Called on each markPrice event.
   * When not provided, the engine uses strategy-based signal evaluation via onCandle().
   */
  onSignal?: (
    instrument: string,
    markPrice: string,
  ) => 'open-long' | 'open-short' | 'close' | 'hold';
  regimeLeaderboards?: RegimeLeaderboards;
  strategyRegistry?: StrategyRegistry;
  initialStrategy?: IStrategy;
  fundingRateProvider?: () => number | null;
  fundingTracker?: FundingRateTracker;
  feedHealthMonitor?: FeedHealthMonitor;
  /** Optional LiveDataFeed for multi-timeframe confirmation candles. */
  confirmationFeed?: import('../paper/live-data-feed.js').LiveDataFeed;
  /** Timeframe of the confirmation feed (e.g., '4h'). */
  confirmationTimeframe?: Timeframe;
  /** Optional cross-asset signal bus for BTC/ETH confirmation. */
  crossAssetBus?: import('../risk/cross-asset-signal-bus.js').CrossAssetSignalBus;
  /**
   * Paper-only: interval between simulated funding payments (default 8h).
   * Ignored in live mode (real funding events from WebSocket).
   */
  paperFundingIntervalMs?: number;
}

// ── Engine ────────────────────────────────────────────────────────────

export class PerpTradingEngine extends EventEmitter {
  private readonly mode: 'paper' | 'live';
  private readonly executor: IPerpOrderExecutor;
  private intxClient: IntxClient;
  private stateStore: PerpStateStore;
  private config: IntxConfig;
  private onSignal?: PerpTradingEngineOptions['onSignal'];
  private _riskGate: PerpRiskGate | null;

  private readonly tradingPair: TradingPair;
  private readonly timeframe: Timeframe;
  private readonly instrument: string;
  private readonly candleRepo?: CandleRepository;

  private currentSession: PerpSession | null = null;
  /** Paper-only: entry price snapshot (mark price at simulated entry). */
  private _paperEntryPrice: string | null = null;
  private _started = false;
  private _emergencyCloseInProgress = false;
  private _onMarkPrice: ((evt: IntxMarkPriceEvent) => void) | null = null;
  private _fundingRateTracker: FundingRateTracker;
  private _fundingDrainInProgress = false;
  private _onFundingRate: ((evt: IntxFundingRateEvent) => void) | null = null;

  // Paper-only: simulated funding timer
  private _paperFundingTimer: ReturnType<typeof setInterval> | null = null;
  private readonly _paperFundingIntervalMs: number;

  // Live-only: FCM balance monitor
  private _balanceTimer?: ReturnType<typeof setInterval>;
  private _lastKnownAvailableFunds?: string;

  // Multi-timeframe confirmation
  private readonly confirmationFeed?: import('../paper/live-data-feed.js').LiveDataFeed;
  private readonly confirmationTimeframe?: Timeframe;
  private confirmationBuffer: Map<string, import('../core/types.js').Candle[]> = new Map();

  // Cross-asset signal confirmation
  private readonly crossAssetBus?: import('../risk/cross-asset-signal-bus.js').CrossAssetSignalBus;

  private readonly ctrl: PerpStrategyController;

  /** Typed emit override — matches PerpEngineEvents interface. */
  override emit<K extends keyof PerpEngineEvents>(
    event: K,
    ...args: PerpEngineEvents[K]
  ): boolean {
    return super.emit(event, ...args);
  }

  constructor(options: PerpTradingEngineOptions) {
    super();
    this.mode = options.mode;
    this.executor = options.executor;
    this.intxClient = options.intxClient;
    this.stateStore = options.stateStore;
    this.config = options.config;
    this.onSignal = options.onSignal;
    this._riskGate = options.riskGate ?? null;

    this.tradingPair = options.tradingPair;
    this.timeframe = options.timeframe;
    this.instrument = options.tradingPair === 'ETH-USD'
      ? options.config.ethProductId
      : options.config.btcProductId;
    this.candleRepo = options.candleRepo;

    this._fundingRateTracker = options.fundingTracker
      ?? new FundingRateTracker({ drainThresholdPct: options.config.fundingDrainThresholdPct });
    this.confirmationFeed = options.confirmationFeed;
    this.confirmationTimeframe = options.confirmationTimeframe;
    this.crossAssetBus = options.crossAssetBus;

    this.ctrl = new PerpStrategyController({
      regimeLeaderboards: options.regimeLeaderboards,
      strategyRegistry: options.strategyRegistry,
      initialStrategy: options.initialStrategy,
      fundingRateProvider: options.fundingRateProvider,
      feedHealthMonitor: options.feedHealthMonitor,
      logPrefix: this.mode === 'paper' ? '[PAPER]' : '[LIVE]',
      onStrategySwitch: (name) => this.emit('strategySwitch', { newStrategy: name }),
    });
    this._paperFundingIntervalMs = options.paperFundingIntervalMs ?? 28_800_000;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  start(): void {
    if (this._started) throw new Error('PerpTradingEngine already started');
    this._started = true;

    this._onMarkPrice = (evt: IntxMarkPriceEvent) => this._handleMarkPrice(evt);
    this.intxClient.on('markPrice', this._onMarkPrice);

    // Re-hydrate in-memory state from DB on IntxClient reconnection
    this.intxClient.on('reconnected', () => this._handleReconnection());

    this._onFundingRate = (evt: IntxFundingRateEvent) => this._handleFundingRate(evt);
    this.intxClient.on('fundingRate', this._onFundingRate);

    // Wire confirmation feed for multi-timeframe data
    if (this.confirmationFeed && this.confirmationTimeframe) {
      const confTf = this.confirmationTimeframe;
      this.confirmationFeed.on('candle', (candle: Candle) => {
        const key = `${candle.pair}:${confTf}`;
        let buf = this.confirmationBuffer.get(key);
        if (!buf) {
          buf = [];
          this.confirmationBuffer.set(key, buf);
        }
        buf.push(candle);
        while (buf.length > 100) {
          buf.shift();
        }
      });
      this.confirmationFeed.start([this.tradingPair], 60000);
    }

    // Paper-only: simulated funding timer
    if (this.mode === 'paper') {
      this._paperFundingTimer = setInterval(() => {
        void this._applyPaperFunding();
      }, this._paperFundingIntervalMs);
    }

    // Re-hydrate from DB: recover or clean up sessions left open by a previous run
    this._rehydrateFromDb();

    // Preload candle buffer with historical data
    this._preloadBuffer();

    log.info(
      { mode: this.mode, tradingPair: this.tradingPair, instrument: this.instrument, timeframe: this.timeframe },
      'PerpTradingEngine started',
    );
  }

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
    this.confirmationFeed?.stop();
    this._started = false;
    log.info({ mode: this.mode }, 'PerpTradingEngine stopped');
  }

  // ── Re-hydration from DB ──────────────────────────────────────────────

  /**
   * Re-hydrate open sessions from DB on startup.
   * Filters by this engine's instrument to prevent cross-pair contamination.
   */
  private _rehydrateFromDb(): void {
    const openSessions = this.stateStore.getAllOpenSessions()
      .filter((s) => s.instrument === this.instrument || s.instrument === this.tradingPair);

    if (openSessions.length === 0) return;

    // Sort descending by openedAt — keep the most recent, close the rest as orphans
    openSessions.sort((a, b) => b.openedAt - a.openedAt);

    const STALE_SESSION_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

    for (const orphan of openSessions.slice(1)) {
      this.stateStore.updateSession(orphan.id, {
        status: 'closed',
        closedAt: Date.now(),
        closeReason: 'engine-restart',
      });
      log.info({ sessionId: orphan.id, instrument: orphan.instrument }, 'Closed orphaned session on restart');
    }

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
        'Closed stale session on startup (older than 7 days)',
      );
      return;
    }

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
      log.info({ sessionId: session.id, correctedInstrument }, 'Corrected session instrument on restart');
    }

    this.currentSession = session;
    this._paperEntryPrice = session.entryPrice;

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
      'Re-hydrated open position from DB on startup',
    );
  }

  // ── Live-only: FCM recovery ───────────────────────────────────────────

  /**
   * Reconcile internal state with FCM on startup after a crash or restart.
   * Live-only — paper mode returns no-op result.
   */
  async recoverFromRestart(): Promise<{ restored: boolean; closedExternally: boolean }> {
    if (this.mode === 'paper') {
      return { restored: false, closedExternally: false };
    }

    const openSessions = this.stateStore.getAllOpenSessions()
      .filter((s) => s.instrument === this.instrument);

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

      // Clean up orphaned OPEN orders
      const openOrders = this.stateStore.getOpenOrdersBySession(dbSession.id);
      const exchangePos = positions.find((p) => p.product_id === dbSession.instrument);
      const contracts = exchangePos?.number_of_contracts;
      const isZeroOnExchange = !exchangePos || Number(contracts) === 0;

      for (const order of openOrders) {
        if (isZeroOnExchange) {
          log.warn(
            { orderId: order.id, instrument: order.instrument, sessionId: dbSession.id },
            'Orphaned OPEN order on restart — marking FAILED (exchange position gone)',
          );
          this.stateStore.persistOrder({ ...order, status: 'FAILED', updatedAt: Date.now() });
        }
      }

      const isLongOnExchange = !isZeroOnExchange && exchangePos?.side === 'LONG';
      const isShortOnExchange = !isZeroOnExchange && exchangePos?.side === 'SHORT';

      const sessionMatchesExchange =
        (dbSession.direction === 'long' && isLongOnExchange) ||
        (dbSession.direction === 'short' && isShortOnExchange);

      if (sessionMatchesExchange) {
        // Size verification (0.1% relative tolerance)
        const dbSize = d(dbSession.size);
        const exchangeSize = d(contracts ?? '0');
        const sizeDiff = dbSize.minus(exchangeSize).abs();
        const sizeTolerance = dbSize.mul(d('0.001'));

        if (sizeDiff.greaterThan(sizeTolerance)) {
          log.error(
            { dbSize: dbSize.toString(), exchangeSize: exchangeSize.toString(), sessionId: dbSession.id },
            'ALERT: Perp position size mismatch DB vs exchange -- triggering emergency close',
          );
          this.currentSession = dbSession;
          await this._executeEmergencyClose(
            exchangePos!.current_price ?? dbSession.entryPrice,
            '0',
          );
          return { restored: false, closedExternally: false };
        }

        // Entry price verification (1% tolerance)
        const dbEntry = d(dbSession.entryPrice);
        const exchangeEntry = d(exchangePos!.avg_entry_price ?? '0');
        if (!exchangeEntry.isZero()) {
          const priceDiff = dbEntry.minus(exchangeEntry).abs().div(dbEntry);
          if (priceDiff.greaterThan(d('0.01'))) {
            log.error(
              { dbEntry: dbEntry.toString(), exchangeEntry: exchangeEntry.toString(), sessionId: dbSession.id },
              'ALERT: Perp entry price mismatch DB vs exchange -- triggering emergency close',
            );
            this.currentSession = dbSession;
            await this._executeEmergencyClose(
              exchangePos!.current_price ?? dbSession.entryPrice,
              '0',
            );
            return { restored: false, closedExternally: false };
          }
        }

        // Position still open and verified — restore
        this.currentSession = dbSession;
        restored = true;
        log.info(
          { sessionId: dbSession.id, instrument: dbSession.instrument, direction: dbSession.direction },
          'recoverFromRestart: session restored from DB — exchange position confirmed open and verified',
        );
      } else {
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

  // ── Buffer preload ────────────────────────────────────────────────────

  private _preloadBuffer(): void {
    if (!this.candleRepo) {
      log.warn(
        { tradingPair: this.tradingPair, timeframe: this.timeframe },
        'No candleRepo provided — buffer starts empty, signals delayed until warm-up',
      );
      return;
    }

    const bufferSize = 100;
    const timeframeMs = TIMEFRAME_MS[this.timeframe];
    const now = Date.now();
    const startMs = now - timeframeMs * bufferSize;

    const historical = this.candleRepo.getCandles(this.tradingPair, this.timeframe, startMs, now);
    if (historical.length === 0) {
      log.warn(
        { tradingPair: this.tradingPair, timeframe: this.timeframe },
        'No historical candles found — run `npm run sync` first',
      );
      return;
    }

    const complete = historical.filter((c) => c.timestamp + timeframeMs <= now);
    const seeded = complete.length > bufferSize
      ? complete.slice(complete.length - bufferSize)
      : complete;

    this.ctrl.seedBuffer(seeded);

    const strategy = this.ctrl.getStrategy();
    const minCandles = strategy?.minCandles ?? 0;
    log.info(
      {
        tradingPair: this.tradingPair,
        timeframe: this.timeframe,
        seeded: seeded.length,
        minCandles,
        ready: seeded.length >= minCandles,
      },
      'Buffer preloaded — strategy ready to signal immediately',
    );
  }

  // ── Candle ingestion ──────────────────────────────────────────────────

  private buildAdditionalCandles(pair: TradingPair): Map<Timeframe, Candle[]> | undefined {
    if (!this.confirmationTimeframe) return undefined;
    const key = `${pair}:${this.confirmationTimeframe}`;
    const buf = this.confirmationBuffer.get(key);
    if (!buf || buf.length === 0) return undefined;
    const map = new Map<Timeframe, Candle[]>();
    map.set(this.confirmationTimeframe, buf);
    return map;
  }

  onCandle(candle: Candle): void {
    if (candle.pair !== this.tradingPair) return;

    const result = this.ctrl.processCandle(candle, this.currentSession !== null);
    if (result === null) return;

    const { regime } = result;

    if (!this.ctrl.getStrategy()) {
      log.warn(
        { pair: candle.pair, regime, bufferLen: this.ctrl.getCandleBuffer().length },
        'No strategy set — candle processed but no signal evaluation',
      );
      return;
    }
    if (!this.onSignal) {
      const instrument = this.instrument;
      const timeframe = candle.timeframe as Timeframe;
      const additionalCandles = this.buildAdditionalCandles(candle.pair as TradingPair);
      const signals = this.ctrl.getStrategy()!.evaluate(
        this.ctrl.getCandleBuffer(),
        candle.pair as TradingPair,
        timeframe,
        additionalCandles,
        regime,
      );
      if (signals.length === 0) {
        log.info(
          { pair: candle.pair, strategyName: this.ctrl.getStrategy()!.name, regime, bufferLen: this.ctrl.getCandleBuffer().length },
          'No signals emitted this candle',
        );
      }
      for (const signal of signals) {
        // Cross-asset signal confirmation: publish and adjust confidence
        let effectiveConfidence = signal.confidence;
        if (this.crossAssetBus) {
          this.crossAssetBus.publish(candle.pair as TradingPair, signal.direction, signal.confidence, candle.timestamp);
          const adjustment = this.crossAssetBus.getConfirmation(candle.pair as TradingPair, signal.direction, candle.timestamp);
          effectiveConfidence = Math.max(0, Math.min(1, signal.confidence + adjustment));
        }

        if ((signal.direction === 'long' || signal.direction === 'short') && this.currentSession === null) {
          const direction: PerpDirection = signal.direction;
          const leverage = (regime !== undefined && this.config.leverageByRegime)
            ? computeLeverage(regime as MarketRegime, effectiveConfidence, this.config as any)
            : (this.config.defaultLeverage ?? 5);
          this.openPosition(instrument, direction, '0.01', leverage, candle.close).catch(
            (err) => {
              log.error(
                { err: err instanceof Error ? err.message : String(err) },
                'strategy openPosition failed',
              );
            },
          );
        } else if (signal.direction === 'close' && this.currentSession !== null) {
          this.closePosition(candle.close, 'strategy-signal').catch(
            (err) => {
              log.error(
                { err: err instanceof Error ? err.message : String(err) },
                'strategy closePosition failed',
              );
            },
          );
        }
      }
    }
  }

  // ── Position management ───────────────────────────────────────────────

  async openPosition(
    instrument: string,
    direction: PerpDirection,
    size: string,
    leverage: number,
    markPrice: string,
    options?: {
      accountValue?: string;
      stopDistancePct?: number;
      marginMode?: 'isolated' | 'cross';
    },
  ): Promise<PerpSession> {
    if (this.currentSession !== null) {
      throw new Error('Position already open — close existing position first');
    }

    const accountValue = options?.accountValue;
    const stopDistancePct = options?.stopDistancePct;
    const marginMode = options?.marginMode;

    // Risk gate check
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
        accountValue: accountValue ?? (this.mode === 'paper' ? '1000000' : '0'),
        expectedGain: expectedGain.toFixed(8),
      });
      if (!gateResult.approved) {
        throw new Error(`PerpRiskGate rejected entry: ${gateResult.rejectReason}`);
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
        entryPrice: markPrice,
        liquidationPrice: liqPrice.toFixed(8),
      },
      'Liquidation price computed before entry',
    );

    // Delegate fill to executor
    const fill = await this.executor.openPosition({
      instrument,
      direction,
      size,
      leverage,
      entryPrice: markPrice,
      marginMode,
    });

    const session: PerpSession = {
      id: crypto.randomUUID(),
      instrument,
      direction,
      entryPrice: fill.fillPrice,
      size,
      leverage,
      liquidationPrice: liqPrice.toFixed(8),
      maintenanceMarginRate: mmr.toFixed(8),
      marginMode,
      markPrice,
      status: 'open',
      openedAt: Date.now(),
    };

    this.stateStore.createSession({ ...session });
    this.currentSession = session;
    this._paperEntryPrice = fill.fillPrice;

    this.emit('positionOpened', session);

    // Emit exposure update for dashboard
    const notional = d(session.size).mul(d(session.entryPrice));
    this.emit('exposureUpdate', {
      totalNotionalUsd: notional.toFixed(2),
      exposureCapUsd: '0.00',
      utilizationPct: '0.00',
    });

    return session;
  }

  async closePosition(markPrice: string, reason?: string): Promise<PerpSession> {
    if (!this.currentSession) {
      throw new Error('No open position to close');
    }

    const session = this.currentSession;

    // Delegate fill to executor
    const fill = await this.executor.closePosition({
      session,
      markPrice,
      reason,
    });

    // Cleanup orders (TP + stop) — live only via executor
    if (this.executor.cleanupOrders) {
      await this.executor.cleanupOrders(session.id);
    }

    // Compute realized PnL
    const entryD = d(session.entryPrice);
    const exitD = d(fill.fillPrice);
    const sizeD = d(session.size);
    const pricePnl = session.direction === 'long'
      ? exitD.minus(entryD).mul(sizeD)
      : entryD.minus(exitD).mul(sizeD);
    const fundingAdj = d(session.cumulativeFundingCost ?? '0');
    const realizedPnl = pricePnl.plus(fundingAdj).toFixed(8);

    const closedAt = Date.now();
    const closeReason = reason ?? 'manual';

    session.status = 'closed';
    session.closedAt = closedAt;
    session.closeReason = closeReason;

    this.stateStore.updateSession(session.id, { status: 'closed', closedAt, closeReason });

    // Record closed trade for analytics
    this.stateStore.recordTrade({
      sessionId: session.id,
      instrument: session.instrument,
      direction: session.direction,
      leverage: session.leverage,
      entryPrice: session.entryPrice,
      exitPrice: fill.fillPrice,
      size: session.size,
      cumulativeFundingCost: session.cumulativeFundingCost ?? '0.00000000',
      realizedPnl,
      openedAt: session.openedAt,
      closedAt,
      closeReason,
      strategyName: this.ctrl.getStrategy()?.name,
      regimeAtEntry: this.ctrl.getCurrentRegime(),
    });

    log.info(
      {
        instrument: session.instrument,
        direction: session.direction,
        entryPrice: session.entryPrice,
        exitPrice: fill.fillPrice,
        realizedPnl,
      },
      'Position closed',
    );

    // Record realized loss to risk gate for daily loss cap tracking
    if (this._riskGate) {
      const lossUsd = Math.max(0, -parseFloat(realizedPnl));
      this._riskGate.recordRealizedLoss(lossUsd);
    }

    this.emit('positionClosed', session);
    this.emit('exposureUpdate', {
      totalNotionalUsd: '0.00',
      exposureCapUsd: '0.00',
      utilizationPct: '0.00',
    });

    const closedSession = { ...session };
    this.currentSession = null;
    this._paperEntryPrice = null;
    this._fundingRateTracker.reset();

    // Execute any pending regime strategy switch
    this.ctrl.firePendingSwitchIfIdle(false);

    return closedSession;
  }

  // ── Close with retry (live mode) ──────────────────────────────────────

  async closePositionWithRetry(reason?: string): Promise<PerpSession> {
    const markPrice = this.currentSession?.markPrice ?? this.currentSession?.entryPrice ?? '0';
    const maxRetries = this.config.orderCloseMaxRetries;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await this.closePosition(markPrice, reason);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        log.warn(
          { attempt, maxRetries, sessionId: this.currentSession?.id, reason, err: lastError.message },
          'Close order failed -- retrying',
        );
        await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt - 1)));
      }
    }

    // All retries exhausted -- emergency close
    log.error(
      {
        sessionId: this.currentSession?.id,
        instrument: this.currentSession?.instrument,
        attempts: maxRetries,
        lastError: lastError?.message,
      },
      'EMERGENCY CLOSE: all close retries exhausted',
    );

    try {
      return await this.closePosition(markPrice, 'EMERGENCY_CLOSE');
    } catch (emergencyErr) {
      log.error(
        { err: emergencyErr instanceof Error ? emergencyErr.message : String(emergencyErr) },
        'CRITICAL: Emergency close also failed -- engine halted',
      );
      throw emergencyErr;
    }
  }

  // ── Emergency close ───────────────────────────────────────────────────

  private async _executeEmergencyClose(
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
      await this.closePosition(markPrice, 'EMERGENCY_CLOSE');
    } finally {
      this._emergencyCloseInProgress = false;
    }
  }

  // ── Mark price handler ────────────────────────────────────────────────

  private _handleMarkPrice(evt: IntxMarkPriceEvent): void {
    if (evt.isStale) return;

    if (this.currentSession && evt.instrument === this.currentSession.instrument) {
      const session = this.currentSession;
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

      // Update in-memory session for real-time P&L
      session.markPrice = evt.markPrice;
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
          'LIQUIDATION_RISK: emergency close triggered',
        );

        this.emit('emergencyClose', session, {
          markPrice: evt.markPrice,
          distancePct: distancePct.toFixed(4),
        });

        if (this.mode === 'paper') {
          // Paper: synchronous close
          try {
            void this.closePosition(evt.markPrice, 'EMERGENCY_CLOSE');
          } finally {
            this._emergencyCloseInProgress = false;
          }
        } else {
          // Live: async close with retry
          this._executeEmergencyClose(evt.markPrice, distancePct.toFixed(4)).catch((err) => {
            log.error({ err: err instanceof Error ? err.message : String(err) }, 'Emergency close failed');
          });
        }
        return;
      }
    }

    // Optional signal directive (imperative onSignal path)
    if (this.onSignal) {
      const directive = this.onSignal(evt.instrument, evt.markPrice);
      switch (directive) {
        case 'open-long':
          this.openPosition(evt.instrument, 'long', '0.01', this.config.defaultLeverage ?? 5, evt.markPrice).catch((err) => {
            log.error({ err: err instanceof Error ? err.message : String(err) }, 'openPosition failed');
          });
          break;
        case 'open-short':
          this.openPosition(evt.instrument, 'short', '0.01', this.config.defaultLeverage ?? 5, evt.markPrice).catch((err) => {
            log.error({ err: err instanceof Error ? err.message : String(err) }, 'openPosition failed');
          });
          break;
        case 'close':
          if (this.currentSession) {
            this.closePosition(evt.markPrice).catch((err) => {
              log.error({ err: err instanceof Error ? err.message : String(err) }, 'closePosition failed');
            });
          }
          break;
        case 'hold':
          break;
      }
    }
  }

  // ── Funding rate handler ──────────────────────────────────────────────

  private _handleFundingRate(evt: IntxFundingRateEvent): void {
    if (evt.isStale) return;
    if (!this.currentSession) {
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

      if (this.mode === 'paper') {
        const drainMarkPrice = session.markPrice ?? session.entryPrice;
        try {
          void this.closePosition(drainMarkPrice, 'FUNDING_DRAIN_EXIT');
        } finally {
          this._fundingDrainInProgress = false;
        }
      } else {
        this.closePositionWithRetry('FUNDING_DRAIN_EXIT').catch((err) => {
          log.error(
            { err: err instanceof Error ? err.message : String(err) },
            'FUNDING_DRAIN_EXIT: closePosition failed after retries',
          );
        }).finally(() => {
          this._fundingDrainInProgress = false;
        });
      }
    }
  }

  // ── Paper-only: simulated funding ─────────────────────────────────────

  private async _applyPaperFunding(): Promise<void> {
    if (!this.currentSession) return;
    const session = this.currentSession;

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

  // ── Reconnection re-hydration ─────────────────────────────────────────

  private _handleReconnection(): void {
    if (!this.currentSession) {
      log.info('IntxClient reconnected — no open position, nothing to re-hydrate');
      return;
    }

    const dbSession = this.stateStore.getOpenSession(this.currentSession.instrument);
    if (dbSession) {
      if (dbSession.markPrice) {
        this.currentSession.markPrice = dbSession.markPrice;
      }
      if (dbSession.cumulativeFundingCost) {
        this.currentSession.cumulativeFundingCost = dbSession.cumulativeFundingCost;
      }
      log.info(
        {
          sessionId: this.currentSession.id,
          markPrice: dbSession.markPrice,
          cumulativeFundingCost: dbSession.cumulativeFundingCost,
        },
        'IntxClient reconnected — session state re-hydrated from DB',
      );
    } else {
      log.warn(
        { sessionId: this.currentSession.id },
        'IntxClient reconnected — no matching open session in DB for re-hydration',
      );
    }
  }

  // ── Funding helpers ───────────────────────────────────────────────────

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

  // ── Live-only: FCM balance monitor ────────────────────────────────────

  startBalanceMonitor(intervalMs = 15 * 60 * 1000): void {
    void this._checkBalance();
    this._balanceTimer = setInterval(() => void this._checkBalance(), intervalMs);
  }

  stopBalanceMonitor(): void {
    if (this._balanceTimer !== undefined) {
      clearInterval(this._balanceTimer);
      this._balanceTimer = undefined;
    }
  }

  private async _checkBalance(): Promise<void> {
    try {
      const state = await this.intxClient.getAccountState();
      const summary = (state.balances ?? state.summary) as Record<string, any>;

      const raw =
        summary?.cfm_usd_balance?.value ??
        summary?.available_margin?.value ??
        summary?.futures_buying_power?.value;

      const available = raw != null ? String(raw) : undefined;
      if (available === undefined) return;

      if (
        this._lastKnownAvailableFunds !== undefined &&
        this._lastKnownAvailableFunds !== available
      ) {
        const prev = parseFloat(this._lastKnownAvailableFunds);
        const curr = parseFloat(available);
        const delta = curr - prev;
        log.info(
          `FCM balance update: $${available}` +
            ` (was $${this._lastKnownAvailableFunds},` +
            ` ${delta >= 0 ? '+' : ''}${delta.toFixed(2)})`,
        );
        this.emit('fcmBalanceChanged', { previous: this._lastKnownAvailableFunds, current: available });
      }
      this._lastKnownAvailableFunds = available;
    } catch (err) {
      log.warn(`FCM balance check failed: ${String(err)}`);
    }
  }

  // ── Accessors ─────────────────────────────────────────────────────────

  getCurrentSession(): PerpSession | null {
    return this.currentSession;
  }

  isPositionOpen(): boolean {
    return this.currentSession !== null && this.currentSession.status === 'open';
  }
}
