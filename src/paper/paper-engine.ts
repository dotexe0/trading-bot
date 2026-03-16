/**
 * PaperTradingEngine -- real-time paper trading with simulated fills.
 *
 * Connects LiveDataFeed (data in) through strategy evaluation and risk
 * management to SessionStore (data out). Reuses all existing backtest
 * infrastructure: FillSimulator, PortfolioTracker, RiskManager,
 * PositionSizer, StopLossTracker (or ExitLogicManager when exits config present).
 *
 * Key difference from BacktestEngine: signals are filled at the completed
 * candle's close price (with slippage), rather than next-bar open.
 *
 * PaperTradingResult.trades and .equityCurve are compatible with
 * MetricsCalculator.compute().
 */

import { EventEmitter } from 'node:events';
import { d, ZERO } from '../core/decimal.js';
import type Decimal from 'decimal.js';
import { TIMEFRAME_MS } from '../core/types.js';
import type { Candle } from '../core/types.js';
import type { Signal } from '../strategies/types.js';
import type { IStrategy } from '../strategies/types.js';
import { FillSimulator } from '../backtest/fill-simulator.js';
import { PortfolioTracker } from '../backtest/portfolio.js';
import type { StrategyRegistry } from '../strategies/registry.js';
import type { IndicatorEngine } from '../indicators/engine.js';
import type { RiskManager } from '../risk/risk-manager.js';
import { PositionSizer } from '../risk/position-sizer.js';
import { StopLossTracker } from '../risk/stop-loss.js';
import type { RiskContext, StrategyStats } from '../risk/types.js';
import type { LiveDataFeed } from './live-data-feed.js';
import type { SessionStore } from './session-store.js';
import type { PaperTradingConfig, PaperSession, PaperTradingResult } from './types.js';
import type { CandleRepository } from '../data/storage/candle-repo.js';
import { createModuleLogger } from '../core/logger.js';
import { RegimeClassifier } from '../regime/classifier.js';
import { CorrelationCalculator, CorrelationStore } from '../correlation/index.js';
import type { CorrelationConfig } from '../correlation/index.js';
import { ExitLogicManager, parseExitConfig } from '../risk/exit-logic/index.js';
import type { ExitConfig } from '../risk/exit-logic/types.js';
import type { RegimeLeaderboards } from '../tournament/types.js';
import type { SpotSignalGate } from '../risk/spot-signal-gate.js';

const log = createModuleLogger('paper-engine');

/** Default position size as fraction of equity when no risk manager is used. */
const DEFAULT_POSITION_SIZE_PCT = 0.95;

/** Number of candles to wait after a strategy switch before allowing another switch. */
const STRATEGY_SWITCH_COOLDOWN_CANDLES = 10;

export interface PaperTradingEngineOptions {
  config: PaperTradingConfig;
  liveFeed: LiveDataFeed;
  sessionStore: SessionStore;
  strategyRegistry: StrategyRegistry;
  indicatorEngine: IndicatorEngine;
  riskManager?: RiskManager;
  strategyStats?: StrategyStats;
  /** When provided with enabled=true, activates correlation-aware position sizing. */
  correlationConfig?: CorrelationConfig;
  /** Path to the SQLite database for storing correlation snapshots. */
  correlationDbPath?: string;
  /** Candle repository for preloading historical buffer on startup. */
  candleRepo?: CandleRepository;
  /** Regime leaderboards from the latest tournament. When provided, enables auto-switching. */
  regimeLeaderboards?: RegimeLeaderboards;
  /** When provided, blocks spot entry signals where expected move does not exceed fee drag. */
  spotSignalGate?: SpotSignalGate;
}

export class PaperTradingEngine extends EventEmitter {
  private readonly config: PaperTradingConfig;
  private readonly liveFeed: LiveDataFeed;
  private readonly sessionStore: SessionStore;
  private readonly strategyRegistry: StrategyRegistry;
  private readonly indicatorEngine: IndicatorEngine;
  private readonly riskManager?: RiskManager;
  private readonly strategyStats?: StrategyStats;

  private strategy!: IStrategy;
  private portfolio!: PortfolioTracker;
  private fillSimulator!: FillSimulator;
  private positionSizer?: PositionSizer;
  private stopLossTrackers: Map<string, StopLossTracker> = new Map();
  private exitManager: ExitLogicManager | null = null;
  private exitConfig: ExitConfig | null = null;
  private hasExits = false;
  private candleBuffer: Map<string, Candle[]> = new Map();
  private session: PaperSession | null = null;
  private isRunning = false;
  private positionDirection: 'long' | 'short' | null = null;
  private positionEntryTimestamp: number = 0;
  private readonly classifier = new RegimeClassifier();
  private correlationCalculator?: CorrelationCalculator;
  private correlationStore?: CorrelationStore;
  private readonly candleRepo?: CandleRepository;
  private readonly regimeLeaderboards?: RegimeLeaderboards;
  private readonly spotSignalGate?: SpotSignalGate;
  private currentRegime: import('../regime/types.js').MarketRegime | undefined = undefined;
  private pendingSwitch: { strategyConfig: Record<string, unknown> } | null = null;
  private cooldownCandlesRemaining: number = 0;

  constructor(options: PaperTradingEngineOptions) {
    super();
    this.config = options.config;
    this.liveFeed = options.liveFeed;
    this.sessionStore = options.sessionStore;
    this.strategyRegistry = options.strategyRegistry;
    this.indicatorEngine = options.indicatorEngine;
    this.riskManager = options.riskManager;
    this.strategyStats = options.strategyStats;
    this.candleRepo = options.candleRepo;
    this.regimeLeaderboards = options.regimeLeaderboards;
    this.spotSignalGate = options.spotSignalGate;

    if (options.correlationConfig?.enabled) {
      this.correlationCalculator = new CorrelationCalculator(
        options.correlationConfig.windowCandles,
      );
      this.correlationStore = new CorrelationStore({
        dbPath: options.correlationDbPath,
      });
    }
  }

  // ── Public API ─────────────────────────────────────────────────────

  /**
   * Start a paper trading session.
   * Creates the session, initializes all components, and wires up the live feed.
   */
  async start(): Promise<PaperSession> {
    // Create strategy from config
    this.strategy = this.strategyRegistry.create(this.config.strategyConfig);

    // Extract exit config from strategy config
    const rawExits = (this.config.strategyConfig as Record<string, unknown>).exits;
    this.exitConfig = parseExitConfig(rawExits !== undefined ? { exits: rawExits } : {});
    this.hasExits = this.exitConfig.exits.trailing.enabled || this.exitConfig.exits.partial.enabled ||
                    this.exitConfig.exits.time.enabled || this.exitConfig.exits.atrStop.enabled;

    // Create session
    this.session = this.sessionStore.createSession(
      this.config,
      this.strategy.name,
    );

    // Initialize portfolio and fill simulator
    this.portfolio = new PortfolioTracker(this.config.initialCapital);
    this.fillSimulator = new FillSimulator({
      slippageBps: this.config.slippageBps,
      feeTierMaker: this.config.feeTierMaker,
      feeTierTaker: this.config.feeTierTaker,
      assumeTaker: this.config.assumeTaker,
    });

    // Set up position sizer if risk manager available
    if (this.riskManager && this.config.riskConfig) {
      this.positionSizer = new PositionSizer(this.config.riskConfig);
    }

    // Preload historical candles into buffer so signals can fire immediately
    this.preloadBuffer();

    // Wire live feed events
    this.liveFeed.on('candle', (candle: Candle) => this.onCandle(candle));
    this.liveFeed.on('error', (err: Error) => {
      log.error({ err, sessionId: this.session?.id }, 'LiveDataFeed error');
      this.emit('error', err);
    });

    // Start live feed
    this.liveFeed.start([this.config.pair], this.config.pollIntervalMs);
    this.isRunning = true;

    log.info(
      {
        sessionId: this.session.id,
        strategy: this.strategy.name,
        pair: this.config.pair,
        timeframe: this.config.timeframe,
      },
      'Paper trading engine started',
    );

    this.emit('started', this.session);
    return this.session;
  }

  /**
   * Stop the paper trading session.
   * Force-closes any open position and returns the result.
   */
  async stop(): Promise<PaperTradingResult> {
    this.isRunning = false;
    this.liveFeed.stop();
    this.correlationStore?.close();

    if (!this.session) {
      throw new Error('No active session to stop');
    }

    // Force-close any open position
    if (!this.portfolio.isFlat()) {
      this.forceClosePosition();
    }

    // End session in store
    const finalEquity = this.portfolio.equity(this.getLastKnownPrice());
    this.sessionStore.endSession(
      this.session.id,
      finalEquity.toString(),
      'stopped',
    );

    // Get full result from session store
    const result = this.sessionStore.getResult(this.session.id);
    if (!result) {
      throw new Error(`Failed to retrieve result for session ${this.session.id}`);
    }

    log.info(
      {
        sessionId: this.session.id,
        trades: result.trades.length,
        finalEquity: result.finalEquity.toString(),
      },
      'Paper trading engine stopped',
    );

    this.emit('stopped', this.session);
    return result;
  }

  /** Get the current session, if any. */
  getSession(): PaperSession | null {
    return this.session;
  }

  /** Whether the engine is currently running. */
  get running(): boolean {
    return this.isRunning;
  }

  /**
   * Get the current open position, or null if the portfolio is flat.
   * Used by the dashboard positions endpoint to display paper positions.
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
    if (!this.session || this.portfolio.isFlat()) return null;
    const state = this.portfolio.getState();
    return {
      sessionId: this.session.id,
      strategyName: this.strategy.name,
      pair: this.config.pair,
      side: this.positionDirection ?? (state.position.gt(ZERO) ? 'long' : 'short'),
      quantity: state.position.abs().toString(),
      avgEntryPrice: state.avgEntryPrice.toString(),
      entryTimestamp: this.positionEntryTimestamp,
    };
  }

  // ── Core: candle processing ────────────────────────────────────────

  /**
   * Process a completed candle through the trading pipeline.
   *
   * Pipeline: buffer -> stop-loss check -> strategy evaluate ->
   * signal processing (risk -> fill -> portfolio) -> equity recording.
   */
  onCandle(candle: Candle): void {
    if (!this.isRunning || !this.session) return;

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

    // Enforce sliding window -- CRITICAL for memory leak prevention
    while (buffer.length > this.config.bufferSize) {
      buffer.shift();
    }

    // Wait for enough data
    if (buffer.length < this.strategy.minCandles) {
      return;
    }

    // 2. Exit logic / stop-loss check (before strategy evaluation)
    if (!this.portfolio.isFlat()) {
      if (this.hasExits && this.exitManager && this.exitConfig) {
        // Compute ATR for exit logic
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
            {
              sessionId: this.session.id,
              pair: candle.pair,
              reason: exitAction.reason,
              fillPrice: exitAction.fillPrice.toString(),
            },
            'Exit logic triggered (full)',
          );

          const exitSignal: Signal = {
            strategyName: `__exit-logic-${exitAction.reason}`,
            pair: candle.pair,
            timeframe: candle.timeframe,
            timestamp: candle.timestamp,
            direction: 'close',
            confidence: 1,
            reasoning: `Exit logic: ${exitAction.reason} at ${exitAction.fillPrice.toFixed(2)}`,
          };

          const positionSize = this.portfolio.getState().position.abs();
          const exitFillCandle: Candle = { ...candle, open: exitAction.fillPrice.toFixed(8) };
          const fill = this.fillSimulator.simulate(exitSignal, exitFillCandle, positionSize);
          this.portfolio.applyFill(fill);

          // Record completed trade
          this.recordLatestTrade();

          this.emit('orderFilled', {
            purpose: 'EXIT',
            pair: candle.pair,
            side: 'SELL',
            fillPrice: fill.fillPrice.toString(),
            quantity: fill.quantity.toString(),
            fee: fill.fee.toString(),
            timestamp: candle.timestamp,
          });

          this.exitManager = null;
          this.positionDirection = null;
          this.positionEntryTimestamp = 0;
          this.checkAndExecutePendingSwitch();
        } else if (exitAction.type === 'partial_exit') {
          log.info(
            {
              sessionId: this.session.id,
              pair: candle.pair,
              fillPrice: exitAction.fillPrice.toString(),
              fraction: exitAction.fraction.toString(),
            },
            'Exit logic triggered (partial)',
          );

          const partialSignal: Signal = {
            strategyName: '__exit-logic-partial',
            pair: candle.pair,
            timeframe: candle.timeframe,
            timestamp: candle.timestamp,
            direction: 'close',
            confidence: 1,
            reasoning: `Partial exit at ${exitAction.fillPrice.toFixed(2)}`,
          };

          const positionSize = this.portfolio.getState().position.abs();
          const partialFillCandle: Candle = { ...candle, open: exitAction.fillPrice.toFixed(8) };
          const partialFill = this.fillSimulator.simulate(partialSignal, partialFillCandle, positionSize);
          this.portfolio.applyPartialClose(partialFill, exitAction.fraction);

          // Record the partial close trade
          this.recordLatestTrade();

          this.emit('orderFilled', {
            purpose: 'PARTIAL_EXIT',
            pair: candle.pair,
            side: 'SELL',
            fillPrice: partialFill.fillPrice.toString(),
            quantity: partialFill.quantity.toString(),
            fee: partialFill.fee.toString(),
            timestamp: candle.timestamp,
          });

          // Do NOT clear exitManager -- position still open
        }
      } else if (!this.hasExits && this.riskManager) {
        // Backward-compat: use existing StopLossTracker path
        for (const [trackerKey, tracker] of this.stopLossTrackers) {
          const check = tracker.check({
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

            // Synthetic close signal at stop price
            const stopSignal: Signal = {
              strategyName: '__stop-loss',
              pair: candle.pair,
              timeframe: candle.timeframe,
              timestamp: candle.timestamp,
              direction: 'close',
              confidence: 1,
              reasoning: `Stop-loss triggered at ${check.stopPrice.toFixed(2)}`,
            };

            const positionSize = this.portfolio.getState().position.abs();

            // Fill candle with open = stop price for realistic fill
            const stopFillCandle: Candle = {
              ...candle,
              open: check.stopPrice.toFixed(8),
            };

            const fill = this.fillSimulator.simulate(stopSignal, stopFillCandle, positionSize);
            this.portfolio.applyFill(fill);

            // Record completed trade
            this.recordLatestTrade();

            this.emit('orderFilled', {
              purpose: 'STOP_LOSS',
              pair: candle.pair,
              side: 'SELL',
              fillPrice: fill.fillPrice.toString(),
              quantity: fill.quantity.toString(),
              fee: fill.fee.toString(),
              timestamp: candle.timestamp,
            });

            this.stopLossTrackers.delete(trackerKey);
            this.positionDirection = null;
            this.positionEntryTimestamp = 0;
            this.checkAndExecutePendingSwitch();
            break;
          }
        }
      }
    }

    // Regime-change auto-switch (only when regimeLeaderboards provided)
    const regime = this.classifier.classify(buffer);
    if (this.regimeLeaderboards) {
      // Decrement cooldown
      if (this.cooldownCandlesRemaining > 0) {
        this.cooldownCandlesRemaining--;
      }

      // Only trigger on known→known transitions (guard: both defined and different)
      if (
        regime !== undefined &&
        this.currentRegime !== undefined &&
        regime !== this.currentRegime &&
        this.cooldownCandlesRemaining === 0
      ) {
        const winnerConfig = this.resolveRegimeWinner(regime);
        if (winnerConfig) {
          if (this.portfolio.isFlat()) {
            this.executeStrategySwitch(winnerConfig);
          } else {
            // Position open: defer the switch
            this.pendingSwitch = { strategyConfig: winnerConfig };
            log.info(
              { regime, currentStrategy: this.strategy.name },
              'Regime changed with open position -- switch deferred until position closes',
            );
          }
        }
      }

      // Always update currentRegime to track transitions
      if (regime !== undefined) {
        this.currentRegime = regime;
      }
    }

    // 3. Strategy evaluation (pass regime as 5th argument)
    const signals = this.strategy.evaluate(
      buffer,
      candle.pair,
      candle.timeframe,
      undefined, // additionalCandles (not used by paper engine)
      regime,
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

    // 5. Equity recording
    const currentEquity = this.portfolio.equity(d(candle.close));
    this.sessionStore.recordEquityPoint(
      this.session.id,
      candle.timestamp,
      currentEquity,
    );

    log.debug(
      {
        sessionId: this.session.id,
        equity: currentEquity.toString(),
        timestamp: candle.timestamp,
      },
      'Equity recorded',
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
      sessionId: this.session!.id,
      timestamp: candle.timestamp,
      equity: currentEquity.toString(),
    });

    if (this.riskManager) {
      const riskState = this.riskManager.getCurrentRiskState();
      // Compute live exposure from current portfolio — riskManager.lastExposurePct
      // only updates during evaluate() (entry signals), so it stays 0 while in a
      // position. Override it here with the real mark-to-market exposure.
      const portfolioState = this.portfolio.getState();
      const exposurePct = !this.portfolio.isFlat() && currentEquity.gt(ZERO)
        ? portfolioState.position.abs().mul(d(candle.close)).div(currentEquity).mul(100).toNumber()
        : 0;
      this.emit('riskUpdate', { ...riskState, currentExposurePct: exposurePct });
    }
  }

  // ── Internal buffer access (for testing) ──────────────────────────

  /** Get the current buffer size for a given key. For testing only. */
  getBufferSize(key: string): number {
    return this.candleBuffer.get(key)?.length ?? 0;
  }

  // ── Private: buffer preload ────────────────────────────────────────

  /**
   * Seed the candle buffer with historical data from the database.
   *
   * Without preloading, the buffer starts empty and must accumulate candles
   * from the live feed in real time — meaning strategies that need 34+ candles
   * won't fire signals for 34+ hours on a 1h timeframe.
   *
   * Fetches up to bufferSize recent candles and populates the buffer so
   * signals can fire as soon as the first live candle arrives.
   */
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
      log.warn(
        { pair, timeframe },
        'No historical candles found in database — run `npm run sync` first. Buffer starts empty.',
      );
      return;
    }

    // Enforce bufferSize cap (getCandles returns ascending order)
    const seeded = historical.length > bufferSize
      ? historical.slice(historical.length - bufferSize)
      : historical;

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
        : 'Buffer preloaded — still warming up, signals fire after more candles arrive',
    );
  }

  // ── Private: signal processing ────────────────────────────────────

  private processCloseSignal(signal: Signal, candle: Candle): void {
    const positionSize = this.portfolio.getState().position.abs();
    if (positionSize.isZero()) return;

    // Fill candle: use completed candle close as the fill base price
    const fillCandle: Candle = {
      ...candle,
      open: candle.close,
    };

    const fill = this.fillSimulator.simulate(signal, fillCandle, positionSize);
    this.portfolio.applyFill(fill);

    // Record completed trade
    this.recordLatestTrade();

    this.emit('orderFilled', {
      purpose: 'EXIT',
      pair: candle.pair,
      side: signal.direction === 'close' ? 'SELL' : 'BUY',
      fillPrice: fill.fillPrice.toString(),
      quantity: fill.quantity.toString(),
      fee: fill.fee.toString(),
      timestamp: candle.timestamp,
    });

    // Clear stop-loss tracker and exit manager
    this.stopLossTrackers.clear();
    this.exitManager = null;
    this.positionDirection = null;
    this.positionEntryTimestamp = 0;
    this.checkAndExecutePendingSwitch();
  }

  private processEntrySignal(signal: Signal, candle: Candle): void {
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
    }

    // Don't enter if already in position
    if (!this.portfolio.isFlat()) return;

    const currentPrice = d(candle.close);
    const currentEquity = this.portfolio.equity(currentPrice);

    // Spot fee-drag gate: block entries where expected move <= round-trip fee
    if (this.spotSignalGate) {
      const key = `${candle.pair}:${candle.timeframe}`;
      const buf = this.candleBuffer.get(key) ?? [];
      const atrOutput = this.indicatorEngine.compute({ name: 'ATR', period: this.spotSignalGate.atrPeriod }, buf);
      const currentAtr = atrOutput.values.length > 0
        ? d(atrOutput.values[atrOutput.values.length - 1] as number)
        : null;
      const notional = currentEquity.mul(d(String(DEFAULT_POSITION_SIZE_PCT)));
      const gateResult = this.spotSignalGate.check(currentAtr, currentPrice, notional);
      if (!gateResult.approved) return;
    }

    let quantity: Decimal;

    // Compute correlation discount scalar when in multi-pair mode.
    // The discount fires when the other pair's candle buffer is populated
    // (indicating multi-pair operation). This avoids requiring cross-engine
    // state sharing to determine if the other pair is in a position.
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

    if (this.riskManager && this.positionSizer && this.config.riskConfig) {
      // Risk-managed sizing with optional correlation discount
      const sizeResult = this.positionSizer.calculate(
        currentEquity,
        currentPrice,
        this.strategyStats ?? null,
        correlationScalar,
      );
      quantity = sizeResult.quantity;

      if (quantity.lte(ZERO)) return;

      // Build risk context
      const state = this.portfolio.getState();
      const riskContext: RiskContext = {
        signal,
        proposedQuantity: quantity,
        proposedPrice: currentPrice,
        currentEquity,
        peakEquity: state.peakEquity,
        cashBalance: state.cashBalance,
        openPositionCount: this.portfolio.isFlat() ? 0 : 1,
        totalExposure: this.portfolio.isFlat()
          ? ZERO
          : state.position.abs().mul(currentPrice).div(currentEquity),
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
        if (this.riskManager!.getCircuitBreakerState().tripped) {
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
    } else {
      // Simple sizing: positionSizePct * equity / price
      quantity = currentEquity.mul(d(DEFAULT_POSITION_SIZE_PCT)).div(currentPrice);
      if (quantity.lte(ZERO)) return;
    }

    // Fill candle: completed candle close as fill base price
    const fillCandle: Candle = {
      ...candle,
      open: candle.close,
    };

    const fill = this.fillSimulator.simulate(signal, fillCandle, quantity);
    this.portfolio.applyFill(fill);
    this.positionEntryTimestamp = candle.timestamp;

    this.emit('orderFilled', {
      purpose: 'ENTRY',
      pair: candle.pair,
      side: signal.direction,
      fillPrice: fill.fillPrice.toString(),
      quantity: fill.quantity.toString(),
      fee: fill.fee.toString(),
      timestamp: candle.timestamp,
    });

    // Set up exit logic or stop-loss tracker for new position
    const direction = signal.direction as 'long' | 'short';
    this.positionDirection = direction;

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
        fill.fillPrice,
        direction,
        entryAtr,
      );
    } else if (this.riskManager && this.config.riskConfig) {
      const tracker = new StopLossTracker(
        {
          type: this.config.riskConfig.stopLoss.type,
          percentage: d(this.config.riskConfig.stopLoss.percentage),
        },
        fill.fillPrice,
        direction,
      );
      this.stopLossTrackers.set(this.config.pair, tracker);
    }

    log.info(
      {
        sessionId: this.session?.id,
        direction: signal.direction,
        quantity: fill.quantity.toString(),
        fillPrice: fill.fillPrice.toString(),
        fee: fill.fee.toString(),
      },
      'Entry fill executed',
    );
  }

  /**
   * Resolve the winning strategy config for a given regime from regimeLeaderboards.
   * Falls back to fallbackEntry when the regime has no entries.
   */
  private resolveRegimeWinner(
    regime: import('../regime/types.js').MarketRegime,
  ): Record<string, unknown> | null {
    if (!this.regimeLeaderboards) return null;
    const entries = this.regimeLeaderboards[regime];
    if (entries && entries.length > 0) {
      return entries[0].strategyConfig;
    }
    // Fallback: overall tournament winner
    return this.regimeLeaderboards.fallbackEntry.strategyConfig;
  }

  /**
   * Execute an immediate strategy switch.
   * Sets exitManager to null (LIVE-05: no state transfer).
   * Resets stopLossTrackers. Starts cooldown.
   */
  private executeStrategySwitch(strategyConfig: Record<string, unknown>): void {
    this.strategy = this.strategyRegistry.create(strategyConfig);
    this.exitManager = null; // LIVE-05: never transfer ExitLogicManager state
    this.stopLossTrackers.clear();
    this.cooldownCandlesRemaining = STRATEGY_SWITCH_COOLDOWN_CANDLES;
    log.info(
      { newStrategy: this.strategy.name, cooldown: STRATEGY_SWITCH_COOLDOWN_CANDLES },
      'Strategy switched due to regime change',
    );
    this.emit('strategySwitch', { newStrategy: this.strategy.name });
  }

  /**
   * Check if a pending switch can now execute (position is flat).
   * Called after every position close.
   */
  private checkAndExecutePendingSwitch(): void {
    if (this.pendingSwitch && this.portfolio.isFlat()) {
      this.executeStrategySwitch(this.pendingSwitch.strategyConfig);
      this.pendingSwitch = null;
    }
  }

  private forceClosePosition(): void {
    if (!this.session) return;

    const lastPrice = this.getLastKnownPrice();
    const closeSignal: Signal = {
      strategyName: '__force-close',
      pair: this.config.pair,
      timeframe: this.config.timeframe,
      timestamp: Date.now(),
      direction: 'close',
      confidence: 1,
      reasoning: 'Paper trading stopped: force-close open position',
    };

    const positionSize = this.portfolio.getState().position.abs();

    // Build a synthetic candle at last known price
    const priceStr = lastPrice.toString();
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

    const fill = this.fillSimulator.simulate(closeSignal, fillCandle, positionSize);
    this.portfolio.applyFill(fill);

    // Record the trade
    this.recordLatestTrade();

    this.stopLossTrackers.clear();
    this.exitManager = null;
    this.positionDirection = null;
    this.positionEntryTimestamp = 0;

    log.info(
      { sessionId: this.session.id, fillPrice: fill.fillPrice.toString() },
      'Position force-closed on stop',
    );
  }

  private recordLatestTrade(): void {
    if (!this.session) return;

    const trades = this.portfolio.getState().trades;
    if (trades.length === 0) return;

    const latestTrade = trades[trades.length - 1];
    this.sessionStore.recordTrade(this.session.id, latestTrade);
  }

  private getLastKnownPrice(): Decimal {
    // Get last candle from any buffer
    for (const [, buffer] of this.candleBuffer) {
      if (buffer.length > 0) {
        return d(buffer[buffer.length - 1].close);
      }
    }
    // Fallback to initial capital as price (shouldn't happen in normal use)
    return d(this.config.initialCapital);
  }
}
