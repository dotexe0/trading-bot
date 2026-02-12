/**
 * TournamentScheduler -- periodic tournament re-runs on rolling windows.
 *
 * Runs tournaments on a configurable interval, computing the date range
 * from a rolling lookback window (endMs = now, startMs = now - lookbackMs).
 * Prevents overlapping runs and optionally activates top-N strategies.
 */

import { z } from 'zod';
import { createModuleLogger } from '../core/logger.js';
import type { Candle, TradingPair, Timeframe } from '../core/types.js';
import type { TournamentConfig } from './config.js';
import { walkForwardConfigSchema } from '../backtest/walk-forward.js';
import { DEFAULT_FEE_MAKER, DEFAULT_FEE_TAKER } from '../backtest/types.js';
import type { TournamentRunner } from './tournament-runner.js';
import type { TournamentStore } from './tournament-store.js';
import type { ActivationBridge, EngineHandle } from './activation-bridge.js';

const log = createModuleLogger('tournament-scheduler');

// ── Config Schema ────────────────────────────────────────────────────

/**
 * Base tournament config WITHOUT startMs/endMs (those are computed from rolling window).
 * Cannot use tournamentConfigSchema.omit() because Zod v4 disallows .omit() on refined schemas.
 */
const baseTournamentConfigSchema = z.object({
  pair: z.enum(['BTC-USD', 'ETH-USD']),
  timeframe: z.enum(['1m', '5m', '15m', '1h', '4h', '1D']),
  walkForward: walkForwardConfigSchema,
  initialCapital: z.string().default('10000'),
  slippageBps: z.number().min(0).max(100).default(5),
  feeTierMaker: z.number().min(0).max(0.1).default(DEFAULT_FEE_MAKER),
  feeTierTaker: z.number().min(0).max(0.1).default(DEFAULT_FEE_TAKER),
  topN: z.number().int().min(1).max(10).default(3),
  activationMode: z.enum(['paper', 'live', 'none']).default('none'),
  strategyConfigs: z.array(z.record(z.string(), z.unknown())).optional(),
});

export const schedulerConfigSchema = z.object({
  /** How often to re-run tournaments (ms). Min 1 minute. */
  intervalMs: z.number().int().min(60_000),
  /** Rolling lookback window size (ms). Min 1 day. */
  lookbackMs: z.number().int().min(86_400_000),
  /** Base tournament config without date range (computed from rolling window). */
  tournamentConfig: baseTournamentConfigSchema,
});

export type SchedulerConfig = z.infer<typeof schedulerConfigSchema>;

// ── TournamentScheduler ──────────────────────────────────────────────

export class TournamentScheduler {
  private readonly runner: TournamentRunner;
  private readonly store: TournamentStore;
  private readonly bridge: ActivationBridge;
  private readonly candleLoader: (
    pair: TradingPair,
    timeframe: Timeframe,
    startMs: number,
    endMs: number,
  ) => Candle[];
  private readonly engineFactory?: (
    strategyConfig: Record<string, unknown>,
    tournamentConfig: TournamentConfig,
  ) => Promise<EngineHandle>;

  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private config: SchedulerConfig | null = null;

  constructor(deps: {
    runner: TournamentRunner;
    store: TournamentStore;
    bridge: ActivationBridge;
    candleLoader: (
      pair: TradingPair,
      timeframe: Timeframe,
      startMs: number,
      endMs: number,
    ) => Candle[];
    engineFactory?: (
      strategyConfig: Record<string, unknown>,
      tournamentConfig: TournamentConfig,
    ) => Promise<EngineHandle>;
  }) {
    this.runner = deps.runner;
    this.store = deps.store;
    this.bridge = deps.bridge;
    this.candleLoader = deps.candleLoader;
    this.engineFactory = deps.engineFactory;
  }

  /**
   * Start the scheduler. Runs a tournament immediately, then on interval.
   */
  start(config: SchedulerConfig): void {
    const parsed = schedulerConfigSchema.parse(config);
    this.config = parsed;

    // Run immediately (fire-and-forget)
    this.tick().catch((err) =>
      log.error({ err }, 'Initial tournament failed'),
    );

    // Set recurring interval
    this.timer = setInterval(
      () => this.tick().catch((err) => log.error({ err }, 'Scheduled tournament failed')),
      parsed.intervalMs,
    );

    log.info(
      {
        intervalMs: parsed.intervalMs,
        lookbackMs: parsed.lookbackMs,
        pair: parsed.tournamentConfig.pair,
        timeframe: parsed.tournamentConfig.timeframe,
      },
      'Tournament scheduler started',
    );
  }

  /**
   * Stop the scheduler. Clears the interval timer.
   */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    log.info('Tournament scheduler stopped');
  }

  /**
   * Check if the scheduler is currently active.
   */
  isRunning(): boolean {
    return this.timer !== null;
  }

  // ── Private ──────────────────────────────────────────────────────

  private async tick(): Promise<void> {
    if (this.running) {
      log.warn('Previous tournament still in progress, skipping tick');
      return;
    }

    if (!this.config) {
      log.error('Scheduler tick called without config');
      return;
    }

    this.running = true;
    try {
      const endMs = Date.now();
      const startMs = endMs - this.config.lookbackMs;

      // Load candles for the rolling window
      const candles = this.candleLoader(
        this.config.tournamentConfig.pair,
        this.config.tournamentConfig.timeframe,
        startMs,
        endMs,
      );

      // Build full tournament config with computed date range
      const fullConfig: TournamentConfig = {
        ...this.config.tournamentConfig,
        startMs,
        endMs,
      } as TournamentConfig;

      // Run tournament
      const result = await this.runner.run(fullConfig, candles);

      // Save result
      this.store.saveTournament(result);

      // Activate if requested
      const activationMode = this.config.tournamentConfig.activationMode;
      if (activationMode !== 'none') {
        if (this.engineFactory) {
          await this.bridge.activate(result, activationMode, this.engineFactory);
        } else {
          log.warn(
            'Activation requested but no engineFactory provided, skipping activation',
          );
        }
      }

      const topStrategy = result.leaderboard[0];
      log.info(
        {
          tournamentId: result.id,
          topStrategy: topStrategy?.strategyName ?? 'none',
          topSharpe: topStrategy?.oosMetrics.sharpeRatio.toFixed(4) ?? 'N/A',
          strategies: result.strategiesEvaluated,
        },
        'Scheduled tournament complete',
      );
    } finally {
      this.running = false;
    }
  }
}
