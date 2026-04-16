/**
 * SpotTradingEngine — unified spot trading engine for paper and live modes.
 *
 * Replaces both PaperTradingEngine and LiveTradingEngine by injecting an
 * ISpotOrderExecutor that handles the fill mechanism:
 *   - PaperSpotOrderExecutor: simulated fills via FillSimulator (synchronous)
 *   - LiveSpotOrderExecutor:  real Coinbase API via OrderManager (async)
 *
 * All strategy evaluation, risk checks, exit logic, regime auto-switch,
 * buffer management, and event emission live here — never in the executor.
 *
 * The `mode` flag is only checked in lifecycle methods (start/stop/shutdown)
 * and trade recording — never in the hot path (onCandle, signal processing).
 */

import { EventEmitter } from 'node:events';
import { d, ZERO } from '../core/decimal.js';
import type Decimal from 'decimal.js';
import { TIMEFRAME_MS } from '../core/types.js';
import type { Candle, TradingPair, Timeframe } from '../core/types.js';
import type { Signal, IStrategy } from '../strategies/types.js';
import type { StrategyRegistry } from '../strategies/registry.js';
import type { IndicatorEngine } from '../indicators/engine.js';
import type { RiskManager } from '../risk/risk-manager.js';
import { PositionSizer } from '../risk/position-sizer.js';
import { StopLossTracker } from '../risk/stop-loss.js';
import { DriftDetector } from '../risk/drift-detector.js';
import type { RiskContext, StrategyStats } from '../risk/types.js';
import type { LiveDataFeed } from '../paper/live-data-feed.js';
import type { ISpotOrderExecutor, SpotFillResult } from './order-executor.js';
import { createModuleLogger } from '../core/logger.js';
import { RegimeClassifier } from '../regime/classifier.js';
import { CorrelationCalculator, CorrelationStore } from '../correlation/index.js';
import type { CorrelationConfig } from '../correlation/index.js';
import { ExitLogicManager, parseExitConfig } from '../risk/exit-logic/index.js';
import type { ExitConfig } from '../risk/exit-logic/types.js';
import type { RegimeLeaderboards } from '../tournament/types.js';
import type { SpotSignalGate } from '../risk/spot-signal-gate.js';
import type { FeedHealthMonitor } from '../core/feed-health.js';
import type { CrossAssetSignalBus } from '../risk/cross-asset-signal-bus.js';
import type { CandleRepository } from '../data/storage/candle-repo.js';
import type { OrderManager } from '../live/order-manager.js';
import type { ShutdownState, LiveOrder } from '../live/types.js';
import type { SimulatedFill, Trade } from '../backtest/types.js';

const log = createModuleLogger('spot-trading-engine');

/** Default position size as fraction of equity when no risk manager is used. */
const DEFAULT_POSITION_SIZE_PCT = 0.95;

/** Number of candles to wait after a strategy switch before allowing another switch. */
const STRATEGY_SWITCH_COOLDOWN_CANDLES = 10;

// ── Minimal store interface (satisfied by both SessionStore and LiveStateStore) ──

export interface ISpotStateStore {
  createSession(config: any, strategyName: string): { id: string; [k: string]: any };
  endSession(sessionId: string, finalEquity: string, status: string): void;
  recordEquityPoint(sessionId: string, timestamp: number, equity: any): void;
  recordTrade(sessionId: string, trade: any, metadata?: any): void;
  getSession(sessionId: string): any;
  getSessionTrades(sessionId: string): any[];
  getResult?(sessionId: string): any;
  close(): void;
  // Live-only (order tracking for recovery)
  getPendingOrders?(sessionId: string): any[];
  getOpenOrders?(sessionId: string): any[];
  updateOrderStatus?(orderId: string, data: any): void;
  listSessions?(status?: string): any[];
}

// ── Position tracking ─────────────────────────────────────────────────

interface SpotPosition {
  direction: 'long' | 'short';
  side: 'BUY' | 'SELL';
  quantity: Decimal;
  entryPrice: Decimal;
  entryFee: Decimal;
  entryTimestamp: number;
  entrySignal: Signal;
  entrySignalPrice?: Decimal;
  orderId?: string;
  partialExitFired: boolean;
}

// ── Options ───────────────────────────────────────────────────────────

export interface SpotTradingEngineOptions {
  mode: 'paper' | 'live';
  executor: ISpotOrderExecutor;
  config: {
    pair: TradingPair;
    timeframe: Timeframe;
    strategyConfig: Record<string, unknown>;
    initialCapital: string;
    allowShorts: boolean;
    slippageBps: number;
    feeTierMaker: number;
    feeTierTaker: number;
    assumeTaker: boolean;
    bufferSize: number;
    riskConfig?: any;
    pollIntervalMs: number;
    // Live-only config fields (ignored in paper mode)
    reconciliationIntervalMs?: number;
    shutdownTimeoutMs?: number;
    enableStopLossOnShutdown?: boolean;
    orderMaxWaitSeconds?: number;
    orderCloseMaxRetries?: number;
  };
  liveFeed: LiveDataFeed;
  stateStore: ISpotStateStore;
  strategyRegistry: StrategyRegistry;
  indicatorEngine: IndicatorEngine;
  riskManager?: RiskManager;
  strategyStats?: StrategyStats;
  candleRepo?: CandleRepository;
  regimeLeaderboards?: RegimeLeaderboards;
  spotSignalGate?: SpotSignalGate;
  feedHealthMonitor?: FeedHealthMonitor;
  correlationConfig?: CorrelationConfig;
  correlationDbPath?: string;
  /** Optional second LiveDataFeed for multi-timeframe confirmation candles. */
  confirmationFeed?: LiveDataFeed;
  /** Timeframe of the confirmation feed (e.g., '4h' when primary is '1h'). */
  confirmationTimeframe?: Timeframe;
  /** Optional cross-asset signal bus for BTC/ETH confirmation. */
  crossAssetBus?: CrossAssetSignalBus;
  /** Enable limit entry orders (default: false — uses market orders). */
  useLimitEntries?: boolean;
  /** Offset below/above close price for limit entries (decimal, e.g. 0.001 = 0.1%). Default: 0.001. */
  limitEntryOffsetPct?: number;
  /** Max time to wait for limit fill before fallback (ms). Default: 60000. */
  limitEntryTimeoutMs?: number;
  /** Fall back to market order if limit times out. Default: true. */
  limitEntryFallbackToMarket?: boolean;
  /** Live-only: OrderManager for reconciliation, shutdown stop-loss, and recovery. */
  orderManager?: OrderManager;
  /** Live-only: resume a previous session on restart. */
  resumeSessionId?: string;
}

// ── Engine ────────────────────────────────────────────────────────────

export class SpotTradingEngine extends EventEmitter {
  readonly mode: 'paper' | 'live';
  private readonly executor: ISpotOrderExecutor;
  private readonly config: SpotTradingEngineOptions['config'];
  private readonly liveFeed: LiveDataFeed;
  private readonly stateStore: ISpotStateStore;
  private readonly strategyRegistry: StrategyRegistry;
  private readonly indicatorEngine: IndicatorEngine;
  private readonly riskManager?: RiskManager;
  private readonly strategyStats?: StrategyStats;
  private readonly candleRepo?: CandleRepository;
  private readonly regimeLeaderboards?: RegimeLeaderboards;
  private readonly spotSignalGate?: SpotSignalGate;
  private readonly feedHealthMonitor?: FeedHealthMonitor;
  private readonly orderManager?: OrderManager;
  private readonly resumeSessionId?: string;

  // Drift detection
  private driftDetector: DriftDetector | null = null;

  // Strategy state
  private strategy!: IStrategy;
  private positionSizer?: PositionSizer;
  private stopLossTrackers: Map<string, StopLossTracker> = new Map();
  private exitManager: ExitLogicManager | null = null;
  private exitConfig: ExitConfig | null = null;
  private hasExits = false;

  // Buffer & session
  private candleBuffer: Map<string, Candle[]> = new Map();
  private session: { id: string; [k: string]: any } | null = null;
  private isRunning = false;

  // Position tracking (replaces both PortfolioTracker and CurrentPosition)
  private currentPosition: SpotPosition | null = null;
  private cashBalance: Decimal = ZERO;
  private peakEquity: Decimal = ZERO;

  // Multi-timeframe confirmation
  private readonly confirmationFeed?: LiveDataFeed;
  private readonly confirmationTimeframe?: Timeframe;
  private confirmationBuffer: Map<string, Candle[]> = new Map();

  // Cross-asset signal confirmation
  private readonly crossAssetBus?: CrossAssetSignalBus;

  // Limit entry config
  private readonly useLimitEntries: boolean;
  private readonly limitEntryOffsetPct: number;
  private readonly limitEntryTimeoutMs: number;
  private readonly limitEntryFallbackToMarket: boolean;

  // Regime auto-switch
  private readonly classifier = new RegimeClassifier();
  private correlationCalculator?: CorrelationCalculator;
  private correlationStore?: CorrelationStore;
  private currentRegime: import('../regime/types.js').MarketRegime | undefined = undefined;
  private pendingSwitch: { strategyConfig: Record<string, unknown> } | null = null;
  private cooldownCandlesRemaining: number = 0;

  // Live-only state
  private shutdownState: ShutdownState = 'running';
  private reconciliationTimer: ReturnType<typeof setInterval> | null = null;
  private entrySignalPrice: Decimal | null = null;
  private exitSignalPrice: Decimal | null = null;
  private recoveryFailed = false;

  // Guards against concurrent async entry/close races
  private _entryPending = false;
  private _closePending = false;

  constructor(options: SpotTradingEngineOptions) {
    super();
    this.mode = options.mode;
    this.executor = options.executor;
    this.config = options.config;
    this.liveFeed = options.liveFeed;
    this.stateStore = options.stateStore;
    this.strategyRegistry = options.strategyRegistry;
    this.indicatorEngine = options.indicatorEngine;
    this.riskManager = options.riskManager;
    this.strategyStats = options.strategyStats;
    this.candleRepo = options.candleRepo;
    this.regimeLeaderboards = options.regimeLeaderboards;
    this.spotSignalGate = options.spotSignalGate;
    this.feedHealthMonitor = options.feedHealthMonitor;
    this.orderManager = options.orderManager;
    this.resumeSessionId = options.resumeSessionId;

    this.confirmationFeed = options.confirmationFeed;
    this.confirmationTimeframe = options.confirmationTimeframe;
    this.crossAssetBus = options.crossAssetBus;
    this.useLimitEntries = options.useLimitEntries ?? false;
    this.limitEntryOffsetPct = options.limitEntryOffsetPct ?? 0.001;
    this.limitEntryTimeoutMs = options.limitEntryTimeoutMs ?? 60000;
    this.limitEntryFallbackToMarket = options.limitEntryFallbackToMarket ?? true;

    if (options.correlationConfig?.enabled) {
      this.correlationCalculator = new CorrelationCalculator(
        options.correlationConfig.windowCandles,
      );
      this.correlationStore = new CorrelationStore({
        dbPath: options.correlationDbPath,
      });
    }

    if (this.config.riskConfig?.driftDetection?.enabled) {
      this.driftDetector = new DriftDetector({
        windowSize: this.config.riskConfig.driftDetection.windowSize,
        sharpeThreshold: this.config.riskConfig.driftDetection.sharpeThreshold,
        winRateTolerance: this.config.riskConfig.driftDetection.winRateTolerance,
      });
    }
  }

  // ── Public API ─────────────────────────────────────────────────────

  async start(): Promise<{ id: string }> {
    // Create strategy from config
    this.strategy = this.strategyRegistry.create(this.config.strategyConfig);

    // Extract exit config from strategy config
    const rawExits = this.config.strategyConfig.exits;
    this.exitConfig = parseExitConfig(rawExits !== undefined ? { exits: rawExits } : {});
    this.hasExits = this.exitConfig.exits.trailing.enabled || this.exitConfig.exits.partial.enabled ||
                    this.exitConfig.exits.time.enabled || this.exitConfig.exits.atrStop.enabled;

    // Set up position sizer if risk manager available
    if (this.riskManager && this.config.riskConfig) {
      this.positionSizer = new PositionSizer(this.config.riskConfig);
    }

    // Set drift detection baseline from tournament data
    this.updateDriftBaseline();

    // Initialize cash
    this.cashBalance = d(this.config.initialCapital);
    this.peakEquity = d(this.config.initialCapital);

    // Live-only: restart recovery
    if (this.mode === 'live' && this.resumeSessionId) {
      await this.recoverFromRestart(this.resumeSessionId);
      if (this.recoveryFailed) {
        return this.session!;
      }
    }

    if (!this.session) {
      this.session = this.stateStore.createSession(
        this.config as any,
        this.strategy.name,
      );
    }

    // Preload historical candles into buffer
    this.preloadBuffer();

    // Wire live feed events
    this.liveFeed.on('candle', (candle: Candle) => this.onCandle(candle));
    this.liveFeed.on('wsError', (err: Error) => {
      log.warn({ err: err.message, sessionId: this.session?.id }, 'LiveDataFeed WebSocket error (transient, REST fallback active)');
    });

    // Wire confirmation feed for multi-timeframe data
    if (this.confirmationFeed && this.confirmationTimeframe) {
      this.confirmationFeed.on('candle', (candle: Candle) => {
        const key = `${candle.pair}:${this.confirmationTimeframe}`;
        let buf = this.confirmationBuffer.get(key);
        if (!buf) {
          buf = [];
          this.confirmationBuffer.set(key, buf);
        }
        buf.push(candle);
        while (buf.length > this.config.bufferSize) {
          buf.shift();
        }
      });
      this.confirmationFeed.start([this.config.pair], this.config.pollIntervalMs);
    }

    // Live-only: wire OrderManager events for tracking
    if (this.mode === 'live' && this.orderManager) {
      this.orderManager.on('orderSubmitted', (order: LiveOrder) =>
        this.emit('orderSubmitted', order),
      );
      this.orderManager.on('orderCancelled', (order: LiveOrder) =>
        this.emit('orderCancelled', order),
      );
      this.orderManager.on('reconciliation', (report: unknown) =>
        this.emit('reconciliation', report),
      );
      this.orderManager.startTracking();

      // Start reconciliation interval
      this.reconciliationTimer = setInterval(
        () => {
          this.orderManager!.reconcile().catch((err) => {
            log.error({ err }, 'Scheduled reconciliation failed');
          });
        },
        this.config.reconciliationIntervalMs ?? 60000,
      );
    }

    // Start live feed
    this.liveFeed.start([this.config.pair], this.config.pollIntervalMs);
    this.isRunning = true;
    this.shutdownState = 'running';

    log.info(
      {
        mode: this.mode,
        sessionId: this.session.id,
        strategy: this.strategy.name,
        pair: this.config.pair,
        timeframe: this.config.timeframe,
      },
      'SpotTradingEngine started',
    );

    this.emit('started', this.session);
    return this.session;
  }

  async stop(): Promise<void> {
    if (this.mode === 'live') {
      await this.shutdown();
    } else {
      // Paper: force-close position and clean up
      this.isRunning = false;
      this.liveFeed.stop();
      this.confirmationFeed?.stop();
      this.correlationStore?.close();

      if (this.currentPosition) {
        await this.forceClosePosition();
      }

      if (this.session) {
        const lastPrice = this.getLastKnownPrice();
        const equity = this.currentEquity(lastPrice);
        this.stateStore.endSession(this.session.id, equity.toString(), 'stopped');
      }

      log.info({ mode: this.mode, sessionId: this.session?.id }, 'SpotTradingEngine stopped');
      this.emit('stopped', this.session);
    }
  }

  getSession(): { id: string; [k: string]: any } | null {
    return this.session;
  }

  get running(): boolean {
    return this.isRunning;
  }

  getShutdownState(): ShutdownState {
    return this.shutdownState;
  }

  /**
   * Get the current open position info for dashboard display.
   * Returns null if flat.
   */
  getOpenPosition(): {
    sessionId: string;
    strategyName: string;
    pair: string;
    side: 'long' | 'short';
    quantity: string;
    avgEntryPrice: string;
    entryTimestamp: number;
  } | null {
    if (!this.session || !this.currentPosition) return null;
    return {
      sessionId: this.session.id,
      strategyName: this.strategy.name,
      pair: this.config.pair,
      side: this.currentPosition.direction,
      quantity: this.currentPosition.quantity.abs().toString(),
      avgEntryPrice: this.currentPosition.entryPrice.toString(),
      entryTimestamp: this.currentPosition.entryTimestamp,
    };
  }

  /** Get the current buffer size for a given key. For testing only. */
  getBufferSize(key: string): number {
    return this.candleBuffer.get(key)?.length ?? 0;
  }

  // ── Core: candle processing ────────────────────────────────────────

  onCandle(candle: Candle): void {
    if (!this.isRunning || !this.session) return;
    if (this.mode === 'live' && this.shutdownState !== 'running') return;

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
    while (buffer.length > this.config.bufferSize) {
      buffer.shift();
    }

    // Feed health guard
    if (this.feedHealthMonitor?.isStale(candle.pair)) {
      log.warn(
        { pair: candle.pair, timestamp: candle.timestamp },
        'Feed stale — skipping signal evaluation (holding existing positions)',
      );
      return;
    }

    // Wait for enough data
    if (buffer.length < this.strategy.minCandles) {
      return;
    }

    // 2. Exit logic / stop-loss check (before strategy evaluation)
    if (this.currentPosition) {
      this.checkExitLogic(candle, buffer);
      // If position was closed by exit logic, skip strategy eval
      if (!this.currentPosition) return;
    }

    // 3. Regime-change auto-switch
    const regime = this.classifier.classify(buffer);
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
          if (this.isFlat()) {
            this.executeStrategySwitch(winnerConfig);
          } else {
            this.pendingSwitch = { strategyConfig: winnerConfig };
            log.info(
              { regime, currentStrategy: this.strategy.name },
              'Regime changed with open position -- switch deferred until position closes',
            );
          }
        }
      }
      if (regime !== undefined) {
        this.currentRegime = regime;
      }
    }

    // 4. Strategy evaluation
    const additionalCandles = this.buildAdditionalCandles(candle.pair);
    const signals = this.strategy.evaluate(
      buffer,
      candle.pair,
      candle.timeframe,
      additionalCandles,
      regime,
    );

    if (signals.length === 0) {
      log.info(
        { pair: candle.pair, strategyName: this.strategy.name, regime, bufferLen: buffer.length },
        'No signals emitted this candle',
      );
    }

    for (const signal of signals) {
      if (!this.config.allowShorts && signal.direction === 'short') {
        continue;
      }
      if (signal.direction === 'close') {
        this.processCloseSignal(signal, candle);
      } else {
        this.processEntrySignal(signal, candle);
      }
    }

    // 5. Equity recording
    const currentPrice = d(candle.close);
    const equity = this.currentEquity(currentPrice);
    if (equity.gt(this.peakEquity)) {
      this.peakEquity = equity;
    }

    this.stateStore.recordEquityPoint(
      this.session.id,
      candle.timestamp,
      this.mode === 'paper' ? equity : equity.toFixed(2),
    );

    this.emit('priceTick', {
      pair: candle.pair,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
      timestamp: candle.timestamp,
    });

    this.emit('equityUpdate', {
      sessionId: this.session.id,
      timestamp: candle.timestamp,
      equity: this.mode === 'paper' ? equity.toString() : equity.toFixed(2),
    });

    if (this.riskManager) {
      const riskState = this.riskManager.getCurrentRiskState();
      const exposurePct = this.currentPosition && equity.gt(ZERO)
        ? this.currentPosition.quantity.abs().mul(currentPrice).div(equity).mul(100).toNumber()
        : 0;
      this.emit('riskUpdate', { ...riskState, currentExposurePct: exposurePct });
    }
  }

  // ── Exit logic ────────────────────────────────────────────────────

  private checkExitLogic(candle: Candle, buffer: Candle[]): void {
    if (!this.currentPosition) return;

    if (this.hasExits && this.exitManager && this.exitConfig) {
      const atrOutput = this.indicatorEngine.compute(
        { name: 'ATR', period: this.exitConfig.exits.atrStop.atrPeriod },
        buffer,
      );
      const currentAtr = atrOutput.values.length > 0
        ? d(atrOutput.values[atrOutput.values.length - 1] as number)
        : null;

      const exitAction = this.exitManager.check({
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        timestamp: candle.timestamp,
      }, currentAtr);

      if (exitAction.type === 'full_exit') {
        log.warn(
          { sessionId: this.session?.id, pair: candle.pair, reason: exitAction.reason },
          'Exit logic triggered (full)',
        );
        this.executeClose(candle, exitAction.fillPrice.toFixed(8), 'EXIT', `__exit-logic-${exitAction.reason}`);
        this.exitManager = null;
        return;
      } else if (exitAction.type === 'partial_exit') {
        log.info(
          { sessionId: this.session?.id, pair: candle.pair, fraction: exitAction.fraction.toString() },
          'Exit logic triggered (partial)',
        );
        this.executePartialClose(candle, exitAction.fraction, exitAction.fillPrice.toFixed(8));
      }
    } else if (!this.hasExits) {
      // Backward-compat: StopLossTracker
      for (const [trackerKey, tracker] of this.stopLossTrackers) {
        const check = tracker.check({
          low: candle.low,
          high: candle.high,
          close: candle.close,
        });

        if (check.triggered) {
          log.warn(
            { sessionId: this.session?.id, pair: candle.pair, stopPrice: check.stopPrice.toString() },
            'Stop-loss triggered',
          );
          this.executeClose(candle, check.stopPrice.toFixed(8), 'STOP_LOSS', '__stop-loss');
          this.stopLossTrackers.delete(trackerKey);
          return;
        }
      }
    }
  }

  // ── Signal processing ─────────────────────────────────────────────

  private processEntrySignal(signal: Signal, candle: Candle): void {
    if (signal.direction === 'long' || signal.direction === 'short') {
      log.info(
        {
          instrument: candle.pair,
          strategyName: signal.strategyName,
          direction: signal.direction,
          confidence: signal.confidence,
          timestamp: signal.timestamp,
          event: 'entry-signal',
        },
        'Entry signal received',
      );
    }

    if (!this.isFlat() || this._entryPending) return;

    const currentPrice = d(candle.close);
    const equity = this.currentEquity(currentPrice);

    // Spot fee-drag gate
    if (this.spotSignalGate) {
      const key = `${candle.pair}:${candle.timeframe}`;
      const buf = this.candleBuffer.get(key) ?? [];
      const atrOutput = this.indicatorEngine.compute({ name: 'ATR', period: this.spotSignalGate.atrPeriod }, buf);
      const currentAtr = atrOutput.values.length > 0
        ? d(atrOutput.values[atrOutput.values.length - 1] as number)
        : null;
      const notional = equity.mul(d(String(DEFAULT_POSITION_SIZE_PCT)));
      const gateResult = this.spotSignalGate.check(currentAtr, currentPrice, notional);
      if (!gateResult.approved) return;
    }

    let quantity: Decimal;

    // Correlation discount
    let correlationScalar: Decimal | undefined;
    if (this.correlationCalculator) {
      const otherPair = this.config.pair === 'BTC-USD' ? 'ETH-USD' : 'BTC-USD';
      const otherKey = `${otherPair}:${this.config.timeframe}`;
      const thisKey = `${this.config.pair}:${this.config.timeframe}`;
      const otherBuf = this.candleBuffer.get(otherKey) ?? [];
      const thisBuf = this.candleBuffer.get(thisKey) ?? [];
      if (otherBuf.length >= 2) {
        const snapshot = this.correlationCalculator.compute(
          this.config.pair === 'BTC-USD' ? thisBuf : otherBuf,
          this.config.pair === 'BTC-USD' ? otherBuf : thisBuf,
        );
        if (snapshot) {
          const r = snapshot.correlation;
          const scalar = Math.max(0, 1 - Math.max(0, r));
          correlationScalar = d(scalar);
          this.correlationStore?.save(snapshot, this.config.timeframe);
        }
      }
    }

    // Cross-asset signal confirmation: publish this signal, read adjustment
    let effectiveConfidence = signal.confidence;
    if (this.crossAssetBus) {
      this.crossAssetBus.publish(this.config.pair, signal.direction, signal.confidence, candle.timestamp);
      const adjustment = this.crossAssetBus.getConfirmation(this.config.pair, signal.direction, candle.timestamp);
      effectiveConfidence = Math.max(0, Math.min(1, signal.confidence + adjustment));
    }

    if (this.riskManager && this.positionSizer && this.config.riskConfig) {
      // Get current ATR for volatility sizing
      const atrForSizing = (() => {
        const atrPeriod = this.exitConfig?.exits?.atrStop?.atrPeriod ?? 14;
        const key = `${candle.pair}:${candle.timeframe}`;
        const buf = this.candleBuffer.get(key) ?? [];
        const atrOutput = this.indicatorEngine.compute({ name: 'ATR', period: atrPeriod }, buf);
        return atrOutput.values.length > 0 ? d(atrOutput.values[atrOutput.values.length - 1] as number) : undefined;
      })();

      const sizeResult = this.positionSizer.calculate(
        equity,
        currentPrice,
        this.strategyStats ?? null,
        correlationScalar,
        effectiveConfidence,
        atrForSizing,
      );
      quantity = sizeResult.quantity;
      if (quantity.lte(ZERO)) return;

      const riskContext: RiskContext = {
        signal,
        proposedQuantity: quantity,
        proposedPrice: currentPrice,
        currentEquity: equity,
        peakEquity: this.peakEquity,
        cashBalance: this.cashBalance,
        openPositionCount: this.isFlat() ? 0 : 1,
        totalExposure: this.isFlat()
          ? ZERO
          : this.currentPosition!.quantity.abs().mul(currentPrice).div(equity),
        dailyPnL: ZERO,
        riskConfig: this.config.riskConfig,
        timestamp: candle.timestamp,
      };

      const decision = this.riskManager.evaluate(riskContext);
      if (!decision.approved) {
        log.info(
          { sessionId: this.session?.id, reason: decision.rejectReason },
          'Risk manager rejected entry',
        );
        if (this.riskManager.getCircuitBreakerState().tripped) {
          this.emit('circuitBreaker', {
            type: 'MAX_DRAWDOWN',
            message: decision.rejectReason ?? 'Circuit breaker tripped',
            timestamp: candle.timestamp,
            resolution: 'PENDING',
          });
        }
        return;
      }
      quantity = decision.finalQuantity;

      // Apply drawdown recovery scaling
      const recoveryScale = this.riskManager.getDrawdownRecoveryScale();
      if (recoveryScale < 1.0) {
        quantity = quantity.mul(d(recoveryScale));
        log.info({ recoveryScale: recoveryScale.toFixed(4) }, 'Drawdown recovery scaling applied');
      }
    } else {
      quantity = equity.mul(d(DEFAULT_POSITION_SIZE_PCT)).div(currentPrice);
      if (quantity.lte(ZERO)) return;
    }

    // Execute the entry fill via the executor (limit or market)
    const fillCandle: Candle = { ...candle, open: candle.close };
    this.entrySignalPrice = currentPrice;
    this._entryPending = true;

    this.attemptEntryFill(signal, fillCandle, quantity)
      .then((fill) => {
        this._entryPending = false;
        if (!fill) return; // limit entry missed with no fallback
        // Update position state
        this.currentPosition = {
          direction: signal.direction as 'long' | 'short',
          side: fill.side === 'buy' ? 'BUY' : 'SELL',
          quantity: fill.quantity,
          entryPrice: fill.fillPrice,
          entryFee: fill.fee,
          entryTimestamp: fill.fillTimestamp,
          entrySignal: signal,
          entrySignalPrice: this.entrySignalPrice ?? undefined,
          orderId: fill.orderId,
          partialExitFired: false,
        };

        // Update cash balance
        const cost = fill.fillPrice.mul(fill.quantity);
        this.cashBalance = this.cashBalance.minus(cost).minus(fill.fee);

        // Set up exit logic or stop-loss tracker
        this.setupExitTracking(signal.direction as 'long' | 'short', fill.fillPrice, candle);

        this.emit('orderFilled', {
          purpose: 'ENTRY',
          pair: candle.pair,
          side: signal.direction,
          fillPrice: fill.fillPrice.toString(),
          quantity: fill.quantity.toString(),
          fee: fill.fee.toString(),
          timestamp: fill.fillTimestamp,
          orderId: fill.orderId,
        });

        log.info(
          {
            sessionId: this.session?.id,
            mode: this.mode,
            direction: signal.direction,
            quantity: fill.quantity.toString(),
            fillPrice: fill.fillPrice.toString(),
            fee: fill.fee.toString(),
            orderId: fill.orderId,
          },
          'Entry fill executed',
        );
      })
      .catch((err) => {
        this._entryPending = false;
        log.error({ err: err instanceof Error ? err.message : String(err) }, 'Failed to execute entry order');
        this.entrySignalPrice = null;
      });
  }

  private processCloseSignal(signal: Signal, candle: Candle): void {
    if (this.isFlat() || this._closePending) return;
    this.exitSignalPrice = d(candle.close);
    this.executeClose(candle, candle.close, 'EXIT', signal.strategyName);
    this.stopLossTrackers.clear();
    this.exitManager = null;
  }

  /**
   * Execute a full position close. Used by exit logic, stop-loss, and close signals.
   */
  private executeClose(
    candle: Candle,
    fillPrice: string,
    purpose: 'EXIT' | 'STOP_LOSS',
    strategyName: string,
  ): void {
    if (!this.currentPosition || !this.session) return;
    this._closePending = true;

    const position = this.currentPosition;
    const closeSide = position.side === 'BUY' ? 'SELL' : 'BUY';
    const closeSignal: Signal = {
      strategyName,
      pair: candle.pair,
      timeframe: candle.timeframe,
      timestamp: candle.timestamp,
      direction: 'close',
      confidence: 1,
      reasoning: `${purpose} close`,
    };

    const fillCandle: Candle = { ...candle, open: fillPrice, close: fillPrice };

    // Use retry for live, direct for paper
    const closePromise = this.executor.executeCloseWithRetry
      ? this.executor.executeCloseWithRetry({
          pair: candle.pair,
          closeSide: closeSide as 'BUY' | 'SELL',
          baseSize: position.quantity.toFixed(8),
          purpose,
          maxRetries: this.config.orderCloseMaxRetries ?? 3,
        })
      : this.executor.executeOrder({
          signal: closeSignal,
          candle: fillCandle,
          quantity: position.quantity,
          purpose,
        });

    closePromise
      .then((fill) => {
        this._closePending = false;
        this.applyClose(fill, position, candle, purpose, closeSignal);
      })
      .catch((err) => {
        this._closePending = false;
        log.error({ err: err instanceof Error ? err.message : String(err), purpose }, 'Failed to execute close order');
      });
  }

  /**
   * Apply the close fill: compute PnL, record trade, clear position, emit events.
   */
  private applyClose(
    fill: SpotFillResult,
    position: SpotPosition,
    candle: Candle,
    purpose: 'EXIT' | 'STOP_LOSS' | 'PARTIAL_EXIT',
    closeSignal: Signal,
  ): void {
    if (!this.session) return;

    const exitPrice = fill.fillPrice;
    const exitQty = fill.quantity;
    const exitFee = fill.fee;

    // Credit cash
    const exitValue = exitPrice.mul(exitQty);
    this.cashBalance = this.cashBalance.plus(exitValue).minus(exitFee);

    // Compute PnL
    let pnl: Decimal;
    if (position.side === 'BUY') {
      pnl = exitPrice.minus(position.entryPrice).mul(exitQty).minus(exitFee).minus(position.entryFee);
    } else {
      pnl = position.entryPrice.minus(exitPrice).mul(exitQty).minus(exitFee).minus(position.entryFee);
    }

    const entryCost = position.entryPrice.mul(position.quantity);
    const pnlPct = entryCost.isZero() ? ZERO : pnl.div(entryCost).mul(d(100));
    const holdingPeriodMs = fill.fillTimestamp - position.entryTimestamp;

    // Record trade (mode-specific format)
    this.recordTrade(position, fill, pnl, pnlPct, holdingPeriodMs, closeSignal, purpose);

    // Drift detection
    if (this.driftDetector) {
      this.driftDetector.recordTrade(pnlPct.toNumber());
      const drift = this.driftDetector.checkDrift();
      if (drift) {
        this.emit('strategyDrift', {
          type: drift.type,
          rolling: drift.rolling,
          baseline: drift.baseline,
          threshold: drift.threshold,
          strategyName: this.strategy.name,
        });
      }
    }

    // Emit events
    this.emit('orderFilled', {
      purpose,
      pair: candle.pair,
      side: fill.side === 'buy' ? 'BUY' : 'SELL',
      fillPrice: exitPrice.toString(),
      quantity: exitQty.toString(),
      fee: exitFee.toString(),
      timestamp: fill.fillTimestamp,
      orderId: fill.orderId,
    });

    log.info(
      {
        sessionId: this.session.id,
        mode: this.mode,
        pnl: pnl.toString(),
        purpose,
      },
      'Position closed',
    );

    // Clear position
    this.currentPosition = null;
    this.stopLossTrackers.clear();
    this.exitManager = null;
    this.entrySignalPrice = null;
    this.exitSignalPrice = null;
    this.checkAndExecutePendingSwitch();
  }

  /**
   * Execute a partial close (exit logic only).
   */
  private executePartialClose(candle: Candle, fraction: Decimal, fillPrice: string): void {
    if (!this.currentPosition || !this.session) return;

    const position = this.currentPosition;
    const partialQty = position.quantity.mul(fraction);
    const closeSide = position.side === 'BUY' ? 'SELL' : 'BUY';

    const partialSignal: Signal = {
      strategyName: '__exit-logic-partial',
      pair: candle.pair,
      timeframe: candle.timeframe,
      timestamp: candle.timestamp,
      direction: 'close',
      confidence: 1,
      reasoning: `Partial exit at ${fillPrice}`,
    };

    const fillCandle: Candle = { ...candle, open: fillPrice, close: fillPrice };

    const closePromise = this.executor.executeCloseWithRetry
      ? this.executor.executeCloseWithRetry({
          pair: candle.pair,
          closeSide: closeSide as 'BUY' | 'SELL',
          baseSize: partialQty.toFixed(8),
          purpose: 'EXIT',
          maxRetries: this.config.orderCloseMaxRetries ?? 3,
        })
      : this.executor.executeOrder({
          signal: partialSignal,
          candle: fillCandle,
          quantity: partialQty,
          purpose: 'EXIT',
        });

    closePromise
      .then((fill) => {
        // Reduce position quantity (don't clear)
        this.currentPosition!.quantity = this.currentPosition!.quantity.minus(fill.quantity);
        this.currentPosition!.partialExitFired = true;

        // Credit cash
        const exitValue = fill.fillPrice.mul(fill.quantity);
        this.cashBalance = this.cashBalance.plus(exitValue).minus(fill.fee);

        this.emit('orderFilled', {
          purpose: 'PARTIAL_EXIT',
          pair: candle.pair,
          side: fill.side === 'buy' ? 'BUY' : 'SELL',
          fillPrice: fill.fillPrice.toString(),
          quantity: fill.quantity.toString(),
          fee: fill.fee.toString(),
          timestamp: fill.fillTimestamp,
        });
      })
      .catch((err) => {
        log.error({ err: err instanceof Error ? err.message : String(err) }, 'Failed to submit partial exit order');
      });
  }

  // ── Trade recording ───────────────────────────────────────────────

  private recordTrade(
    position: SpotPosition,
    exitFill: SpotFillResult,
    pnl: Decimal,
    pnlPct: Decimal,
    holdingPeriodMs: number,
    exitSignal: Signal,
    purpose: string,
  ): void {
    if (!this.session) return;

    // Derive exit reason from purpose and exit signal name
    let exitReason: string;
    if (purpose === 'STOP_LOSS') {
      exitReason = 'STOP_LOSS';
    } else if (purpose === 'PARTIAL_EXIT') {
      exitReason = 'PARTIAL_EXIT';
    } else if (exitSignal.strategyName.startsWith('__exit-logic-')) {
      exitReason = exitSignal.strategyName.replace('__exit-logic-', '');
    } else {
      exitReason = 'SIGNAL';
    }

    const tradeMetadata = {
      strategyName: this.strategy.name,
      regimeAtEntry: this.currentRegime ?? undefined,
      exitReason,
    };

    if (this.mode === 'paper') {
      // Paper: Trade type with SimulatedFill objects
      const entrySimFill: SimulatedFill = {
        signal: position.entrySignal,
        fillPrice: position.entryPrice,
        fillTimestamp: position.entryTimestamp,
        fee: position.entryFee,
        quantity: position.quantity,
        side: position.side === 'BUY' ? 'buy' : 'sell',
      };
      const exitSimFill: SimulatedFill = {
        signal: exitSignal,
        fillPrice: exitFill.fillPrice,
        fillTimestamp: exitFill.fillTimestamp,
        fee: exitFill.fee,
        quantity: exitFill.quantity,
        side: exitFill.side,
      };
      const trade: Trade = {
        entryFill: entrySimFill,
        exitFill: exitSimFill,
        pnl,
        pnlPct,
        holdingPeriodMs,
      };
      this.stateStore.recordTrade(this.session.id, trade, tradeMetadata);
    } else {
      // Live: LiveTrade with flat string fields + slippage
      const entrySlippageBps = position.entrySignalPrice
        ? this.computeSlippageBps(position.entrySignalPrice, position.entryPrice, position.side)
        : null;
      const exitSlippageBps = this.exitSignalPrice
        ? this.computeSlippageBps(this.exitSignalPrice, exitFill.fillPrice, exitFill.side === 'buy' ? 'BUY' : 'SELL')
        : null;

      this.stateStore.recordTrade(this.session.id, {
        sessionId: this.session.id,
        entryOrderId: position.orderId ?? '',
        exitOrderId: exitFill.orderId ?? '',
        entryTimestamp: position.entryTimestamp,
        entryPrice: position.entryPrice.toFixed(8),
        entryFee: position.entryFee.toFixed(8),
        entrySide: position.side,
        entryQuantity: position.quantity.toFixed(8),
        exitTimestamp: exitFill.fillTimestamp,
        exitPrice: exitFill.fillPrice.toFixed(8),
        exitFee: exitFill.fee.toFixed(8),
        exitSide: exitFill.side === 'buy' ? 'BUY' : 'SELL',
        exitQuantity: exitFill.quantity.toFixed(8),
        pnl: pnl.toFixed(8),
        pnlPct: pnlPct.toFixed(4),
        holdingPeriodMs,
        signalPrice: position.entrySignalPrice?.toFixed(8),
        exitSignalPrice: this.exitSignalPrice?.toFixed(8),
        entrySlippageBps: entrySlippageBps?.toFixed(4),
        exitSlippageBps: exitSlippageBps?.toFixed(4),
        strategyName: tradeMetadata.strategyName,
        regimeAtEntry: tradeMetadata.regimeAtEntry,
        exitReason: tradeMetadata.exitReason,
        entryConfidence: position.entrySignal.confidence,
        entryFillType: this.useLimitEntries ? 'limit' : 'market',
      });
    }
  }

  // ── Exit tracking setup ───────────────────────────────────────────

  private setupExitTracking(direction: 'long' | 'short', entryPrice: Decimal, candle: Candle): void {
    if (this.hasExits && this.exitConfig) {
      const key = `${candle.pair}:${candle.timeframe}`;
      const buf = this.candleBuffer.get(key) ?? [];
      const entryAtrOutput = this.indicatorEngine.compute(
        { name: 'ATR', period: this.exitConfig.exits.atrStop.atrPeriod },
        buf,
      );
      const entryAtr = entryAtrOutput.values.length > 0
        ? d(entryAtrOutput.values[entryAtrOutput.values.length - 1] as number)
        : null;
      this.exitManager = new ExitLogicManager(
        this.exitConfig,
        entryPrice,
        direction,
        entryAtr,
        this.currentRegime,
      );
    } else if (this.riskManager && this.config.riskConfig) {
      const tracker = new StopLossTracker(
        {
          type: this.config.riskConfig.stopLoss.type,
          percentage: d(this.config.riskConfig.stopLoss.percentage),
        },
        entryPrice,
        direction,
      );
      this.stopLossTrackers.set(this.config.pair, tracker);
    }
  }

  // ── Entry fill helpers ──────────────────────────────────────────────

  private async attemptEntryFill(
    signal: Signal,
    fillCandle: Candle,
    quantity: Decimal,
  ): Promise<SpotFillResult | null> {
    // Try limit entry first if enabled and executor supports it
    if (this.useLimitEntries && this.executor.executeLimitEntry) {
      const closePrice = d(fillCandle.close);
      const isLong = signal.direction === 'long';
      // Long: limit below close; Short: limit above close
      const offset = closePrice.mul(d(this.limitEntryOffsetPct));
      const limitPrice = isLong
        ? closePrice.minus(offset)
        : closePrice.plus(offset);

      const limitResult = await this.executor.executeLimitEntry({
        signal,
        candle: fillCandle,
        quantity,
        limitPrice,
        timeoutMs: this.limitEntryTimeoutMs,
      });

      if (limitResult) return limitResult;

      // Limit entry missed — fall back to market if configured
      if (!this.limitEntryFallbackToMarket) {
        log.info(
          { pair: fillCandle.pair, limitPrice: limitPrice.toString() },
          'Limit entry missed, no fallback to market',
        );
        return null;
      }
      log.info(
        { pair: fillCandle.pair, limitPrice: limitPrice.toString() },
        'Limit entry missed — falling back to market order',
      );
    }

    return this.executor.executeOrder({ signal, candle: fillCandle, quantity, purpose: 'ENTRY' });
  }

  // ── Multi-timeframe helpers ─────────────────────────────────────────

  private buildAdditionalCandles(pair: TradingPair): Map<Timeframe, Candle[]> | undefined {
    if (!this.confirmationTimeframe) return undefined;
    const key = `${pair}:${this.confirmationTimeframe}`;
    const buf = this.confirmationBuffer.get(key);
    if (!buf || buf.length === 0) return undefined;
    const map = new Map<Timeframe, Candle[]>();
    map.set(this.confirmationTimeframe, buf);
    return map;
  }

  // ── Regime auto-switch ───────────────────────────��────────────────

  private resolveRegimeWinner(
    regime: import('../regime/types.js').MarketRegime,
  ): Record<string, unknown> | null {
    if (!this.regimeLeaderboards) return null;
    const entries = this.regimeLeaderboards[regime];
    if (entries && entries.length > 0) {
      return entries[0].strategyConfig;
    }
    return this.regimeLeaderboards.fallbackEntry.strategyConfig;
  }

  private executeStrategySwitch(strategyConfig: Record<string, unknown>): void {
    this.strategy = this.strategyRegistry.create(strategyConfig);
    this.exitManager = null;
    this.stopLossTrackers.clear();
    this.cooldownCandlesRemaining = STRATEGY_SWITCH_COOLDOWN_CANDLES;
    this.updateDriftBaseline();
    log.info(
      { newStrategy: this.strategy.name, cooldown: STRATEGY_SWITCH_COOLDOWN_CANDLES },
      'Strategy switched due to regime change',
    );
    this.emit('strategySwitch', { newStrategy: this.strategy.name });
  }

  private updateDriftBaseline(): void {
    if (!this.driftDetector || !this.regimeLeaderboards) return;
    // Try current regime's leaderboard first
    if (this.currentRegime) {
      const entries = this.regimeLeaderboards[this.currentRegime];
      if (entries && entries.length > 0) {
        const entry = entries.find(e => e.strategyName === this.strategy.name) ?? entries[0];
        this.driftDetector.setBaseline({
          sharpeRatio: entry.regimeSharpeRatio,
          winRate: entry.regimeWinRate,
        });
        return;
      }
    }
    // Fallback to overall OOS metrics
    const fb = this.regimeLeaderboards.fallbackEntry;
    this.driftDetector.setBaseline({
      sharpeRatio: fb.oosMetrics.sharpeRatio,
      winRate: fb.oosMetrics.winRate.toNumber(),
    });
  }

  private checkAndExecutePendingSwitch(): void {
    if (this.pendingSwitch && this.isFlat()) {
      this.executeStrategySwitch(this.pendingSwitch.strategyConfig);
      this.pendingSwitch = null;
    }
  }

  // ── Buffer preload ────────────────────────────────────────────────

  private preloadBuffer(): void {
    if (!this.candleRepo) {
      log.warn(
        { pair: this.config.pair, timeframe: this.config.timeframe },
        'No candleRepo provided — buffer starts empty, signals will be delayed until warm-up completes',
      );
      return;
    }

    const { pair, timeframe, bufferSize } = this.config;
    const timeframeMs = TIMEFRAME_MS[timeframe];
    const now = Date.now();
    const startMs = now - timeframeMs * bufferSize;

    const historical = this.candleRepo.getCandles(pair, timeframe, startMs, now);

    if (historical.length === 0) {
      log.warn({ pair, timeframe }, 'No historical candles found in database — buffer starts empty');
      return;
    }

    const complete = historical.filter((c) => c.timestamp + timeframeMs <= now);
    const seeded = complete.length > bufferSize
      ? complete.slice(complete.length - bufferSize)
      : complete;

    const key = `${pair}:${timeframe}`;
    this.candleBuffer.set(key, seeded);

    log.info(
      {
        pair,
        timeframe,
        seeded: seeded.length,
        minCandles: this.strategy.minCandles,
        ready: seeded.length >= this.strategy.minCandles,
      },
      seeded.length >= this.strategy.minCandles
        ? 'Buffer preloaded — strategy ready to signal immediately'
        : 'Buffer preloaded — still warming up',
    );
  }

  // ── Live-only: graceful shutdown ──────────────────────────────────

  private async shutdown(): Promise<void> {
    if (this.shutdownState !== 'running') return;

    log.info({ sessionId: this.session?.id }, 'Starting graceful shutdown');

    const timeoutMs = this.config.shutdownTimeoutMs ?? 30000;
    const timeoutPromise = new Promise<void>((_, reject) => {
      setTimeout(() => reject(new Error('Shutdown timeout exceeded')), timeoutMs);
    });

    try {
      await Promise.race([this.doShutdown(), timeoutPromise]);
    } catch (err) {
      log.warn({ err }, 'Shutdown timeout exceeded, force-closing');
      this.forceCloseLifecycle();
    }

    this.shutdownState = 'done';
    this.emit('stopped', this.session);
    this.emit('shutdown', this.shutdownState);
  }

  private async doShutdown(): Promise<void> {
    // Step 1: Block signals
    this.shutdownState = 'blocking_signals';
    this.isRunning = false;

    if (this.reconciliationTimer) {
      clearInterval(this.reconciliationTimer);
      this.reconciliationTimer = null;
    }

    // Step 2: Cancel open orders
    this.shutdownState = 'cancelling_orders';
    if (this.orderManager) {
      try {
        const cancelled = await this.orderManager.cancelAllOrders();
        log.info({ cancelled }, 'Cancelled open orders during shutdown');
      } catch (err) {
        log.error({ err }, 'Error cancelling orders during shutdown');
      }
    }

    // Step 3: Handle open position
    this.shutdownState = 'setting_stops';
    if (this.currentPosition) {
      if (this.config.enableStopLossOnShutdown && this.orderManager) {
        try {
          await this.setShutdownStopLoss();
        } catch (err) {
          log.error({ err }, 'Error setting shutdown stop-loss, submitting market close');
          await this.submitShutdownMarketClose();
        }
      } else {
        await this.submitShutdownMarketClose();
      }
    }

    // Step 4: Close connections
    this.shutdownState = 'closing_connections';
    this.liveFeed.stop();
    this.confirmationFeed?.stop();
    this.orderManager?.stopTracking();
    this.correlationStore?.close();

    if (this.session) {
      const lastPrice = this.getLastKnownPrice();
      const equity = this.currentEquity(lastPrice);
      this.stateStore.endSession(this.session.id, equity.toFixed(2), 'shutdown');
    }
  }

  private async setShutdownStopLoss(): Promise<void> {
    if (!this.currentPosition || !this.orderManager) return;

    const lastPrice = this.getLastKnownPrice();
    const stopPct = this.config.riskConfig?.stopLoss?.percentage ?? 0.05;

    let stopPrice: Decimal;
    let limitPrice: Decimal;
    let side: 'BUY' | 'SELL';

    if (this.currentPosition.side === 'BUY') {
      stopPrice = lastPrice.mul(d(1).minus(d(stopPct)));
      limitPrice = stopPrice.mul(d(0.998));
      side = 'SELL';
    } else {
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

    log.info({ stopPrice: stopPrice.toFixed(2), side }, 'Shutdown stop-loss order placed');
  }

  private async submitShutdownMarketClose(): Promise<void> {
    if (!this.currentPosition || !this.orderManager) return;
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

  private forceCloseLifecycle(): void {
    this.isRunning = false;
    if (this.reconciliationTimer) {
      clearInterval(this.reconciliationTimer);
      this.reconciliationTimer = null;
    }
    try { this.liveFeed.stop(); } catch { /* ignore */ }
    try { this.confirmationFeed?.stop(); } catch { /* ignore */ }
    try { this.orderManager?.stopTracking(); } catch { /* ignore */ }
    if (this.session) {
      try {
        const lastPrice = this.getLastKnownPrice();
        const equity = this.currentEquity(lastPrice);
        this.stateStore.endSession(this.session.id, equity.toFixed(2), 'shutdown');
      } catch { /* ignore */ }
    }
  }

  // ── Paper-only: force close on stop ───────────────────────────────

  private async forceClosePosition(): Promise<void> {
    if (!this.currentPosition || !this.session) return;

    const lastPrice = this.getLastKnownPrice();
    const position = this.currentPosition;
    const priceStr = lastPrice.toString();

    const closeSignal: Signal = {
      strategyName: '__force-close',
      pair: this.config.pair,
      timeframe: this.config.timeframe,
      timestamp: Date.now(),
      direction: 'close',
      confidence: 1,
      reasoning: 'Engine stopped: force-close open position',
    };

    const fillCandle: Candle = {
      pair: this.config.pair,
      timeframe: this.config.timeframe,
      timestamp: Date.now(),
      open: priceStr,
      high: priceStr,
      low: priceStr,
      close: priceStr,
      volume: '0',
    };

    try {
      const fill = await this.executor.executeOrder({
        signal: closeSignal,
        candle: fillCandle,
        quantity: position.quantity,
        purpose: 'EXIT',
      });

      this.applyClose(fill, position, fillCandle, 'EXIT', closeSignal);
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'Failed to force-close position');
    }
  }

  // ── Live-only: restart recovery ───────────────────────────────────

  private async recoverFromRestart(sessionId: string): Promise<void> {
    log.info({ sessionId }, 'Starting restart recovery');

    const session = this.stateStore.getSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found for restart recovery`);
    }
    if (session.status !== 'running' && session.status !== 'shutdown') {
      throw new Error(`Session ${sessionId} has status '${session.status}', cannot recover`);
    }
    this.session = session;
    this.cashBalance = d(session.initialCapital);

    // Run reconciliation
    if (!this.orderManager) {
      throw new Error('OrderManager required for live restart recovery');
    }
    const report = await this.orderManager.reconcile();

    // Reconstruct position from trades
    const trades = this.stateStore.getSessionTrades(sessionId);
    let hasOpenPosition = false;

    for (const trade of trades) {
      if (!trade.exitTimestamp && trade.entryPrice) {
        hasOpenPosition = true;
        this.currentPosition = {
          direction: trade.entrySide === 'BUY' ? 'long' : 'short',
          side: trade.entrySide,
          quantity: d(trade.entryQuantity),
          entryPrice: d(trade.entryPrice),
          entryFee: d(trade.entryFee ?? '0'),
          entryTimestamp: trade.entryTimestamp,
          entrySignal: { strategyName: 'recovered', pair: this.config.pair, timeframe: this.config.timeframe, timestamp: trade.entryTimestamp, direction: trade.entrySide === 'BUY' ? 'long' : 'short', confidence: 1 } as Signal,
          orderId: trade.entryOrderId,
          partialExitFired: false,
        };

        // Re-create exit tracking
        if (this.hasExits && this.exitConfig) {
          this.exitManager = new ExitLogicManager(
            this.exitConfig,
            d(trade.entryPrice),
            this.currentPosition.direction,
            null,
            this.currentRegime,
          );
        } else if (this.riskManager && this.config.riskConfig) {
          this.stopLossTrackers.set(this.config.pair, new StopLossTracker(
            {
              type: this.config.riskConfig.stopLoss.type,
              percentage: d(this.config.riskConfig.stopLoss.percentage),
            },
            d(trade.entryPrice),
            this.currentPosition.direction,
          ));
        }
        break;
      }
    }

    // Ghost PENDING order cleanup
    if (this.stateStore.getPendingOrders) {
      const pendingOrders = this.stateStore.getPendingOrders(sessionId);
      for (const order of pendingOrders) {
        try {
          const exOrderResponse = await this.orderManager.queryOrderStatus(order.orderId);
          const exOrder = exOrderResponse.order;
          const mappedStatus = this.orderManager.mapExchangeStatus(exOrder.status);
          this.stateStore.updateOrderStatus?.(order.orderId, {
            status: mappedStatus,
            filledSize: exOrder.filled_size,
            filledValue: exOrder.filled_value,
            averageFillPrice: exOrder.average_filled_price,
            totalFees: exOrder.fee,
          });
          if (mappedStatus === 'FILLED') {
            log.warn({ orderId: order.orderId }, 'Ghost PENDING order was actually FILLED -- synced');
          }
        } catch (err) {
          this.stateStore.updateOrderStatus?.(order.orderId, { status: 'FAILED' });
          log.warn({ orderId: order.orderId }, 'Ghost PENDING order unreachable -- marking FAILED');
        }
      }
    }

    // Position field-level verification
    if (hasOpenPosition && this.currentPosition) {
      const openTrade = trades.find((t: any) => !t.exitTimestamp);
      const entryOrderId = openTrade?.entryOrderId;

      if (entryOrderId) {
        try {
          const exOrderResponse = await this.orderManager.queryOrderStatus(entryOrderId);
          const exOrder = exOrderResponse.order;

          // Size verification (0.1% tolerance)
          const dbQty = this.currentPosition.quantity;
          const exchangeQty = d(exOrder.filled_size ?? '0');
          const sizeDiff = dbQty.minus(exchangeQty).abs();
          const sizeTolerance = dbQty.mul(d('0.001'));

          if (sizeDiff.greaterThan(sizeTolerance)) {
            log.error({ sessionId, dbQuantity: dbQty.toString(), exchangeFilledSize: exchangeQty.toString() },
              'ALERT: Spot position size mismatch DB vs exchange -- recovery failed');
            this.isRunning = false;
            this.recoveryFailed = true;
            this.emit('error', new Error('ALERT: Spot position size mismatch DB vs exchange'));
            return;
          }

          // Entry price verification (1% tolerance)
          const dbPrice = this.currentPosition.entryPrice;
          const exchangePrice = d(exOrder.average_filled_price ?? '0');
          if (!exchangePrice.isZero()) {
            const priceDiff = dbPrice.minus(exchangePrice).abs().div(dbPrice);
            if (priceDiff.greaterThan(d('0.01'))) {
              log.error({ sessionId, dbEntryPrice: dbPrice.toString(), exchangeAvgPrice: exchangePrice.toString() },
                'ALERT: Spot entry price mismatch DB vs exchange -- recovery failed');
              this.isRunning = false;
              this.recoveryFailed = true;
              this.emit('error', new Error('ALERT: Spot entry price mismatch DB vs exchange'));
              return;
            }
          }

          log.info({ sessionId, entryOrderId }, 'Position verified against exchange');
        } catch (err) {
          log.error({ sessionId, entryOrderId, err: err instanceof Error ? err.message : String(err) },
            'ALERT: Failed to verify position against exchange -- recovery failed');
          this.isRunning = false;
          this.recoveryFailed = true;
          this.emit('error', new Error('ALERT: Failed to verify position against exchange'));
          return;
        }
      }
    }

    // Check for critical discrepancies
    const criticalDiscrepancies = report.discrepancies.filter(
      (disc: any) => disc.type === 'BALANCE_MISMATCH' || disc.type === 'MISSING_FROM_EXCHANGE',
    );

    if (criticalDiscrepancies.length > 0) {
      log.error({ sessionId, discrepancies: criticalDiscrepancies },
        'CRITICAL: Unresolvable discrepancies found during restart recovery');
      this.isRunning = false;
      this.recoveryFailed = true;
      this.emit('error', new Error('Unresolvable discrepancies during restart recovery'));
      return;
    }

    this.entrySignalPrice = null;
    this.exitSignalPrice = null;

    log.info(
      { sessionId, hasPosition: hasOpenPosition, positionSide: this.currentPosition?.side },
      'Restart recovery complete',
    );
  }

  // ── Slippage ──────────────────────────────────────────────────────

  private computeSlippageBps(signalPrice: Decimal, fillPrice: Decimal, side: 'BUY' | 'SELL'): Decimal {
    if (signalPrice.isZero()) return ZERO;
    if (side === 'BUY') {
      return fillPrice.minus(signalPrice).div(signalPrice).mul(d(10000));
    }
    return signalPrice.minus(fillPrice).div(signalPrice).mul(d(10000));
  }

  // ── Helpers ───────────────────────────────────────────────────────

  isFlat(): boolean {
    return this.currentPosition === null;
  }

  currentEquity(price: Decimal): Decimal {
    let equity = this.cashBalance;
    if (this.currentPosition) {
      equity = equity.plus(this.currentPosition.quantity.mul(price));
    }
    return equity;
  }

  private getLastKnownPrice(): Decimal {
    for (const [, buffer] of this.candleBuffer) {
      if (buffer.length > 0) {
        return d(buffer[buffer.length - 1].close);
      }
    }
    return d(this.config.initialCapital);
  }
}
