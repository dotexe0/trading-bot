/**
 * Tests for TournamentScheduler -- verifies periodic execution,
 * rolling window computation, overlap prevention, and activation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { d, ZERO } from '../../core/decimal.js';
import type { Candle } from '../../core/types.js';
import type { PerformanceMetrics } from '../../backtest/metrics.js';
import type { TournamentResult, LeaderboardEntry } from '../types.js';
import type { TournamentConfig } from '../config.js';
import type { TournamentRunner } from '../tournament-runner.js';
import type { TournamentStore } from '../tournament-store.js';
import type { ActivationBridge, EngineHandle } from '../activation-bridge.js';
import { TournamentScheduler } from '../tournament-scheduler.js';
import type { SchedulerConfig } from '../tournament-scheduler.js';

// ── Helpers ────────────────────────────────────────────────────────

function makeMetrics(overrides: Partial<PerformanceMetrics> = {}): PerformanceMetrics {
  return {
    totalReturn: d('0.1'),
    cagr: d('0.05'),
    sharpeRatio: 1.5,
    maxDrawdown: d('100'),
    maxDrawdownPct: d('0.01'),
    winRate: d('0.6'),
    profitFactor: d('1.5'),
    totalTrades: 10,
    totalFees: d('5'),
    fundingCost: ZERO,
    avgTradeReturn: d('0.01'),
    bestTrade: d('50'),
    worstTrade: d('-30'),
    ...overrides,
  };
}

function makeEntry(rank: number, name: string, oosSharpe = 1.5): LeaderboardEntry {
  return {
    rank,
    strategyName: name,
    strategyConfig: { strategy: name },
    oosMetrics: makeMetrics({ sharpeRatio: oosSharpe }),
    isMetrics: makeMetrics({ sharpeRatio: 1.0 }),
    robustnessRatio: oosSharpe / 1.0,
    windowCount: 3,
  };
}

function makeTournamentResult(): TournamentResult {
  return {
    id: 'tourn-001',
    config: {
      pair: 'BTC-USD',
      timeframe: '1h',
      startMs: 1000,
      endMs: 2000,
      walkForward: { trainWindowMs: 500, validateWindowMs: 200, stepMs: 200 },
      initialCapital: '10000',
      slippageBps: 5,
      feeTierMaker: 0.004,
      feeTierTaker: 0.006,
      topN: 3,
      activationMode: 'paper',
    } as TournamentConfig,
    leaderboard: [
      makeEntry(1, 'strat-a', 2.0),
      makeEntry(2, 'strat-b', 1.5),
    ],
    runTimestamp: Date.now(),
    durationMs: 5000,
    strategiesEvaluated: 2,
  };
}

const BASE_TOURNAMENT_CONFIG = {
  pair: 'BTC-USD' as const,
  timeframe: '1h' as const,
  walkForward: { trainWindowMs: 500_000, validateWindowMs: 200_000, stepMs: 200_000 },
  initialCapital: '10000',
  slippageBps: 5,
  feeTierMaker: 0.004,
  feeTierTaker: 0.006,
  topN: 3,
  activationMode: 'paper' as const,
};

const SCHEDULER_CONFIG: SchedulerConfig = {
  intervalMs: 60_000, // 1 minute
  lookbackMs: 86_400_000, // 1 day
  tournamentConfig: BASE_TOURNAMENT_CONFIG,
};

// ── Tests ──────────────────────────────────────────────────────────

describe('TournamentScheduler', () => {
  let runner: TournamentRunner;
  let store: TournamentStore;
  let bridge: ActivationBridge;
  let candleLoader: ReturnType<typeof vi.fn>;
  let engineFactory: ReturnType<typeof vi.fn>;
  let scheduler: TournamentScheduler;

  beforeEach(() => {
    vi.useFakeTimers();

    runner = {
      run: vi.fn().mockResolvedValue(makeTournamentResult()),
    } as unknown as TournamentRunner;

    store = {
      saveTournament: vi.fn(),
      deactivateAll: vi.fn(),
      saveActiveStrategies: vi.fn(),
    } as unknown as TournamentStore;

    bridge = {
      activate: vi.fn().mockResolvedValue({
        activated: [],
        deactivated: 0,
        mode: 'paper',
      }),
    } as unknown as ActivationBridge;

    candleLoader = vi.fn().mockReturnValue([] as Candle[]);

    engineFactory = vi.fn().mockResolvedValue({
      sessionId: 'sess-1',
      strategyName: 'strat-a',
      stop: vi.fn(),
    } as EngineHandle);

    scheduler = new TournamentScheduler({
      runner,
      store,
      bridge,
      candleLoader: candleLoader as unknown as typeof scheduler['candleLoader' & keyof typeof scheduler],
      engineFactory: engineFactory as unknown as typeof scheduler['engineFactory' & keyof typeof scheduler],
    } as ConstructorParameters<typeof TournamentScheduler>[0]);
  });

  afterEach(() => {
    scheduler.stop();
    vi.useRealTimers();
  });

  it('runs tournament immediately on start()', async () => {
    scheduler.start(SCHEDULER_CONFIG);

    // Flush the immediate tick promise
    await vi.advanceTimersByTimeAsync(0);

    expect(runner.run).toHaveBeenCalledTimes(1);
  });

  it('sets interval that triggers subsequent runs', async () => {
    scheduler.start(SCHEDULER_CONFIG);

    // Flush initial tick
    await vi.advanceTimersByTimeAsync(0);
    expect(runner.run).toHaveBeenCalledTimes(1);

    // Advance by one interval
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runner.run).toHaveBeenCalledTimes(2);

    // Advance again
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runner.run).toHaveBeenCalledTimes(3);
  });

  it('computes correct rolling window from Date.now() - lookbackMs', async () => {
    const NOW = 1_700_000_000_000;
    vi.setSystemTime(NOW);

    scheduler.start(SCHEDULER_CONFIG);
    await vi.advanceTimersByTimeAsync(0);

    expect(candleLoader).toHaveBeenCalledWith(
      'BTC-USD',
      '1h',
      NOW - 86_400_000, // startMs
      NOW, // endMs
    );
  });

  it('prevents overlapping runs when previous tick still in progress', async () => {
    // Make runner.run hang until we resolve it
    let resolveRun!: (value: TournamentResult) => void;
    (runner.run as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise((resolve) => { resolveRun = resolve; }),
    );

    scheduler.start(SCHEDULER_CONFIG);

    // Start initial tick (it's now stuck waiting for resolveRun)
    await vi.advanceTimersByTimeAsync(0);

    // Trigger interval tick -- should be skipped because initial is still running
    await vi.advanceTimersByTimeAsync(60_000);

    // runner.run was only called once (the initial tick that's still pending)
    expect(runner.run).toHaveBeenCalledTimes(1);

    // Now resolve the pending run
    resolveRun(makeTournamentResult());
    await vi.advanceTimersByTimeAsync(0);
  });

  it('stop() clears interval and prevents further runs', async () => {
    scheduler.start(SCHEDULER_CONFIG);
    await vi.advanceTimersByTimeAsync(0);
    expect(scheduler.isRunning()).toBe(true);

    scheduler.stop();
    expect(scheduler.isRunning()).toBe(false);

    // Advance time -- no more runs
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runner.run).toHaveBeenCalledTimes(1); // Only initial
  });

  it('saves tournament result to store after each run', async () => {
    scheduler.start(SCHEDULER_CONFIG);
    await vi.advanceTimersByTimeAsync(0);

    expect(store.saveTournament).toHaveBeenCalledTimes(1);
    expect(store.saveTournament).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'tourn-001' }),
    );
  });

  it('calls activation when activationMode is not none', async () => {
    scheduler.start(SCHEDULER_CONFIG);
    await vi.advanceTimersByTimeAsync(0);

    expect(bridge.activate).toHaveBeenCalledTimes(1);
    expect(bridge.activate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'tourn-001' }),
      'paper',
      engineFactory,
    );
  });

  it('skips activation when activationMode is none', async () => {
    const noneConfig: SchedulerConfig = {
      ...SCHEDULER_CONFIG,
      tournamentConfig: {
        ...BASE_TOURNAMENT_CONFIG,
        activationMode: 'none',
      },
    };

    scheduler.start(noneConfig);
    await vi.advanceTimersByTimeAsync(0);

    expect(bridge.activate).not.toHaveBeenCalled();
    // Tournament should still run and be saved
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(store.saveTournament).toHaveBeenCalledTimes(1);
  });
});
