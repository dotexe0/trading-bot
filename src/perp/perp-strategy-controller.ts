/**
 * PerpStrategyController
 *
 * Shared regime auto-switch logic extracted into PerpTradingEngine.
 * Eliminates duplication of:
 *  - Rolling candle buffer management
 *  - Feed health staleness guard
 *  - Regime classification and leaderboard lookup
 *  - Strategy switch with cooldown and pending-switch deferral
 *  - Strategy signal evaluation
 *
 * Usage:
 *   const ctrl = new PerpStrategyController({ ..., onStrategySwitch: (name) => this.emit('strategySwitch', ...) });
 *   const result = ctrl.processCandle(candle, isPositionOpen);
 *   if (!result) return; // stale feed
 *   // handle result.signals and result.regime
 */

import { createModuleLogger } from '../core/logger.js';
import { RegimeClassifier } from '../regime/classifier.js';
import { createLivePerpRegistry } from './strategies/index.js';
import type { IStrategy } from '../strategies/types.js';
import type { StrategyRegistry } from '../strategies/registry.js';
import type { RegimeLeaderboards } from '../tournament/types.js';
import type { MarketRegime } from '../regime/types.js';
import type { Candle } from '../core/types.js';
import type { FeedHealthMonitor } from '../core/feed-health.js';

const log = createModuleLogger('perp-strategy-controller');

const STRATEGY_SWITCH_COOLDOWN_CANDLES = 10;

export { STRATEGY_SWITCH_COOLDOWN_CANDLES };

// ── Options ────────────────────────────────────────────────────────────────────

export interface PerpStrategyControllerOptions {
  regimeLeaderboards?: RegimeLeaderboards;
  /**
   * Pre-built strategy registry. If omitted but regimeLeaderboards is provided,
   * one is created internally via createLivePerpRegistry(fundingRateProvider ?? () => null).
   */
  strategyRegistry?: StrategyRegistry;
  /**
   * Initial strategy to use before the first regime classification.
   */
  initialStrategy?: IStrategy;
  /**
   * Funding rate provider for strategies created during regime switches.
   * Used only when strategyRegistry is not provided.
   */
  fundingRateProvider?: () => number | null;
  /** When provided, skips signal evaluation when feed is stale. */
  feedHealthMonitor?: FeedHealthMonitor;
  /**
   * Prefix added to log messages — e.g. "[PAPER]". Defaults to "".
   */
  logPrefix?: string;
  /**
   * Called whenever the active strategy changes (regime switch or initial set).
   * Caller should emit 'strategySwitch' on the engine EventEmitter.
   */
  onStrategySwitch: (newStrategyName: string) => void;
}

// ── Result ─────────────────────────────────────────────────────────────────────

/** Returned by processCandle. null means feed is stale — caller should return early. */
export interface CandleProcessResult {
  regime: MarketRegime | undefined;
}

// ── Controller ─────────────────────────────────────────────────────────────────

export class PerpStrategyController {
  /** Active strategy for signal evaluation. */
  private strategy: IStrategy | null;
  /** Regime leaderboards — null when feature is disabled. */
  private regimeLeaderboards: RegimeLeaderboards | null;
  /** Last observed market regime. */
  private currentRegime: MarketRegime | undefined = undefined;
  /** Candles remaining in cooldown after a strategy switch. */
  private cooldownCandlesRemaining = 0;
  /** Deferred switch when a position was open at regime-change time. */
  private pendingSwitch: { strategyConfig: Record<string, unknown>; regime?: MarketRegime } | null = null;
  /** Registry used to instantiate new strategies on regime switch. */
  private strategyRegistry: StrategyRegistry | null;
  /** Classifies market regime from candle history. */
  private readonly classifier = new RegimeClassifier();
  /** Rolling candle buffer — max 100 candles. */
  private candleBuffer: Candle[] = [];
  private readonly feedHealthMonitor?: FeedHealthMonitor;
  private readonly logPrefix: string;
  private readonly onStrategySwitch: (name: string) => void;

  constructor(options: PerpStrategyControllerOptions) {
    this.regimeLeaderboards = options.regimeLeaderboards ?? null;
    this.strategy = options.initialStrategy ?? null;
    this.feedHealthMonitor = options.feedHealthMonitor;
    this.logPrefix = options.logPrefix ? `${options.logPrefix} ` : '';
    this.onStrategySwitch = options.onStrategySwitch;

    if (options.regimeLeaderboards) {
      this.strategyRegistry = options.strategyRegistry
        ?? createLivePerpRegistry(options.fundingRateProvider ?? (() => null));
    } else {
      this.strategyRegistry = options.strategyRegistry ?? null;
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Seed the candle buffer with historical data for immediate signal readiness.
   * Called during engine startup before live candles arrive.
   */
  seedBuffer(candles: Candle[]): void {
    // Replace buffer with seeded data, respecting max size
    this.candleBuffer = candles.length > 100
      ? candles.slice(candles.length - 100)
      : [...candles];
  }

  /**
   * Process a completed candle. Returns null if the feed is stale (caller
   * should return without opening/closing positions). Otherwise returns the
   * current regime and any signals emitted by the active strategy.
   *
   * @param isPositionOpen - Whether the engine currently has an open position.
   *   Used to decide whether to defer or immediately execute a regime switch.
   */
  processCandle(candle: Candle, isPositionOpen: boolean): CandleProcessResult | null {
    // Maintain rolling buffer (max 100 candles)
    this.candleBuffer.push(candle);
    if (this.candleBuffer.length > 100) {
      this.candleBuffer.shift();
    }

    // Feed health guard: skip signal evaluation on stale data
    if (this.feedHealthMonitor?.isStale(candle.pair)) {
      log.warn(
        { pair: candle.pair, timestamp: candle.timestamp },
        'Feed stale — skipping signal evaluation (holding existing positions)',
      );
      return null;
    }

    // Classify regime from candle history
    const regime = this.classifier.classify(this.candleBuffer);

    // Regime auto-switch logic
    if (this.regimeLeaderboards) {
      if (this.cooldownCandlesRemaining > 0) {
        this.cooldownCandlesRemaining--;
      }

      if (regime !== undefined && this.strategy === null) {
        // First regime observation: set initial strategy without triggering cooldown
        const winnerConfig = this.resolveRegimeWinner(regime);
        if (winnerConfig) {
          this.strategy = this.strategyRegistry!.create(winnerConfig);
          log.info(
            { newStrategy: this.strategy.name, regime },
            `${this.logPrefix}Initial strategy set from first regime observation`,
          );
          this.onStrategySwitch(this.strategy.name);
        }
      } else if (
        regime !== undefined &&
        this.currentRegime !== undefined &&
        regime !== this.currentRegime &&
        this.cooldownCandlesRemaining === 0
      ) {
        const winnerConfig = this.resolveRegimeWinner(regime);
        if (winnerConfig) {
          if (!isPositionOpen) {
            this.executeStrategySwitch(winnerConfig, regime);
          } else {
            this.pendingSwitch = { strategyConfig: winnerConfig, regime };
            log.info(
              { regime, currentStrategy: this.strategy?.name },
              `${this.logPrefix}Regime changed with open position -- switch deferred until position closes`,
            );
          }
        }
      }

      if (regime !== undefined) {
        this.currentRegime = regime;
      }
    }

    // Execute any pending switch now that position may have closed
    if (this.pendingSwitch && !isPositionOpen) {
      this.executeStrategySwitch(this.pendingSwitch.strategyConfig, this.pendingSwitch.regime);
      this.pendingSwitch = null;
    }

    return { regime };
  }

  /**
   * Fire any pending strategy switch immediately (e.g. when a position closes
   * mid-block, outside the normal candle flow).
   */
  firePendingSwitchIfIdle(isPositionOpen: boolean): void {
    if (this.pendingSwitch && !isPositionOpen) {
      this.executeStrategySwitch(this.pendingSwitch.strategyConfig, this.pendingSwitch.regime);
      this.pendingSwitch = null;
    }
  }

  getStrategy(): IStrategy | null {
    return this.strategy;
  }

  /** Override the active strategy directly. Used in tests to inject a specific strategy. */
  setStrategy(strategy: IStrategy): void {
    this.strategy = strategy;
  }

  getCandleBuffer(): Candle[] {
    return this.candleBuffer;
  }

  getCurrentRegime(): MarketRegime | undefined {
    return this.currentRegime;
  }

  getRegimeLeaderboards(): RegimeLeaderboards | null {
    return this.regimeLeaderboards;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private resolveRegimeWinner(regime: MarketRegime): Record<string, unknown> | null {
    if (!this.regimeLeaderboards) return null;
    const entries = this.regimeLeaderboards[regime];
    if (entries && entries.length > 0) {
      return entries[0].strategyConfig;
    }
    return this.regimeLeaderboards.fallbackEntry.strategyConfig;
  }

  private executeStrategySwitch(strategyConfig: Record<string, unknown>, regime?: MarketRegime): void {
    this.strategy = this.strategyRegistry!.create(strategyConfig);
    this.cooldownCandlesRemaining = STRATEGY_SWITCH_COOLDOWN_CANDLES;
    const msg = regime
      ? `${this.logPrefix}regime ${regime}: switching to ${this.strategy.name}`
      : `${this.logPrefix}Strategy switched due to regime change`;
    log.info(
      { newStrategy: this.strategy.name, regime, cooldown: STRATEGY_SWITCH_COOLDOWN_CANDLES },
      msg,
    );
    this.onStrategySwitch(this.strategy.name);
  }
}
