/**
 * Tests for ActivationBridge -- verifies engine lifecycle management,
 * factory invocation, store persistence, and error handling.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { d, ZERO } from '../../core/decimal.js';
import type { PerformanceMetrics } from '../../backtest/metrics.js';
import type { TournamentResult, LeaderboardEntry } from '../types.js';
import type { TournamentConfig } from '../config.js';
import type { TournamentStore } from '../tournament-store.js';
import { ActivationBridge } from '../activation-bridge.js';
import type { EngineHandle } from '../activation-bridge.js';

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

function makeResult(
  topN: number,
  entries: LeaderboardEntry[],
): TournamentResult {
  return {
    id: 'tournament-001',
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
      topN,
      activationMode: 'paper',
    } as TournamentConfig,
    leaderboard: entries,
    runTimestamp: Date.now(),
    durationMs: 5000,
    strategiesEvaluated: entries.length,
  };
}

function makeMockStore(): TournamentStore {
  return {
    deactivateAll: vi.fn(),
    saveActiveStrategies: vi.fn(),
  } as unknown as TournamentStore;
}

function makeEngineHandle(name: string, sessionId: string): EngineHandle {
  return {
    sessionId,
    strategyName: name,
    stop: vi.fn().mockResolvedValue(undefined),
  };
}

// ── Tests ──────────────────────────────────────────────────────────

describe('ActivationBridge', () => {
  let store: TournamentStore;
  let bridge: ActivationBridge;

  beforeEach(() => {
    store = makeMockStore();
    bridge = new ActivationBridge({ store });
  });

  it('stops previously running engines before starting new ones', async () => {
    const factory = vi.fn()
      .mockResolvedValueOnce(makeEngineHandle('strat-a', 'sess-a1'))
      .mockResolvedValueOnce(makeEngineHandle('strat-b', 'sess-b1'))
      .mockResolvedValueOnce(makeEngineHandle('strat-a', 'sess-a2'))
      .mockResolvedValueOnce(makeEngineHandle('strat-b', 'sess-b2'));

    const entries = [
      makeEntry(1, 'strat-a', 2.0),
      makeEntry(2, 'strat-b', 1.5),
    ];
    const result = makeResult(2, entries);

    // First activation
    await bridge.activate(result, 'paper', factory);
    expect(bridge.getActiveEngines().size).toBe(2);

    // Second activation should stop the first set
    const activationResult = await bridge.activate(result, 'paper', factory);
    expect(activationResult.deactivated).toBe(2);
    expect(activationResult.activated.length).toBe(2);
  });

  it('calls engineFactory for each top-N entry', async () => {
    const factory = vi.fn()
      .mockResolvedValueOnce(makeEngineHandle('strat-a', 'sess-a'))
      .mockResolvedValueOnce(makeEngineHandle('strat-b', 'sess-b'))
      .mockResolvedValueOnce(makeEngineHandle('strat-c', 'sess-c'));

    const entries = [
      makeEntry(1, 'strat-a', 2.0),
      makeEntry(2, 'strat-b', 1.5),
      makeEntry(3, 'strat-c', 1.0),
    ];
    const result = makeResult(3, entries);

    await bridge.activate(result, 'paper', factory);

    expect(factory).toHaveBeenCalledTimes(3);
    expect(factory).toHaveBeenCalledWith(
      { strategy: 'strat-a' },
      result.config,
    );
    expect(factory).toHaveBeenCalledWith(
      { strategy: 'strat-b' },
      result.config,
    );
    expect(factory).toHaveBeenCalledWith(
      { strategy: 'strat-c' },
      result.config,
    );
  });

  it('saves active strategies to store with correct data', async () => {
    const factory = vi.fn()
      .mockResolvedValueOnce(makeEngineHandle('strat-a', 'sess-a'))
      .mockResolvedValueOnce(makeEngineHandle('strat-b', 'sess-b'));

    const entries = [
      makeEntry(1, 'strat-a', 2.0),
      makeEntry(2, 'strat-b', 1.5),
    ];
    const result = makeResult(2, entries);

    await bridge.activate(result, 'paper', factory);

    expect(store.saveActiveStrategies).toHaveBeenCalledWith(
      'tournament-001',
      entries,
      'paper',
    );
  });

  it('deactivateAll() stops all engines and returns count', async () => {
    const handleA = makeEngineHandle('strat-a', 'sess-a');
    const handleB = makeEngineHandle('strat-b', 'sess-b');
    const factory = vi.fn()
      .mockResolvedValueOnce(handleA)
      .mockResolvedValueOnce(handleB);

    const entries = [
      makeEntry(1, 'strat-a', 2.0),
      makeEntry(2, 'strat-b', 1.5),
    ];
    const result = makeResult(2, entries);

    await bridge.activate(result, 'paper', factory);
    expect(bridge.getActiveEngines().size).toBe(2);

    const count = await bridge.deactivateAll();
    expect(count).toBe(2);
    expect(handleA.stop).toHaveBeenCalled();
    expect(handleB.stop).toHaveBeenCalled();
    expect(bridge.getActiveEngines().size).toBe(0);
  });

  it('activate() with N > leaderboard.length uses all available entries', async () => {
    const factory = vi.fn()
      .mockResolvedValueOnce(makeEngineHandle('strat-a', 'sess-a'));

    const entries = [makeEntry(1, 'strat-a', 2.0)];
    // topN = 5 but only 1 entry in leaderboard
    const result = makeResult(5, entries);

    const activationResult = await bridge.activate(result, 'live', factory);

    expect(factory).toHaveBeenCalledTimes(1);
    expect(activationResult.activated.length).toBe(1);
    expect(activationResult.mode).toBe('live');
  });

  it('engineFactory failure for one strategy does not prevent others', async () => {
    const factory = vi.fn()
      .mockResolvedValueOnce(makeEngineHandle('strat-a', 'sess-a'))
      .mockRejectedValueOnce(new Error('Engine startup failed'))
      .mockResolvedValueOnce(makeEngineHandle('strat-c', 'sess-c'));

    const entries = [
      makeEntry(1, 'strat-a', 2.0),
      makeEntry(2, 'strat-b', 1.5),
      makeEntry(3, 'strat-c', 1.0),
    ];
    const result = makeResult(3, entries);

    const activationResult = await bridge.activate(result, 'paper', factory);

    // strat-b failed but strat-a and strat-c should be active
    expect(activationResult.activated.length).toBe(2);
    expect(activationResult.activated[0].strategyName).toBe('strat-a');
    expect(activationResult.activated[1].strategyName).toBe('strat-c');
    expect(bridge.getActiveEngines().size).toBe(2);
  });
});
