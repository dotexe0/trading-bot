/**
 * Tests for TournamentStore -- verifies SQLite persistence of
 * tournament results and active strategy lifecycle.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { d, ZERO } from '../../core/decimal.js';
import type { PerformanceMetrics } from '../../backtest/metrics.js';
import type { TournamentResult, LeaderboardEntry } from '../types.js';
import type { TournamentConfig } from '../config.js';
import { TournamentStore } from '../tournament-store.js';

// ── Helpers ────────────────────────────────────────────────────────

function makeMetrics(overrides: Partial<PerformanceMetrics> = {}): PerformanceMetrics {
  return {
    totalReturn: d('0.15'),
    cagr: d('0.08'),
    sharpeRatio: 1.8,
    maxDrawdown: d('200'),
    maxDrawdownPct: d('0.02'),
    winRate: d('0.65'),
    profitFactor: d('2.1'),
    totalTrades: 15,
    totalFees: d('12.5'),
    fundingCost: ZERO,
    avgTradeReturn: d('0.015'),
    bestTrade: d('80'),
    worstTrade: d('-45'),
    ...overrides,
  };
}

function makeEntry(rank: number, name: string, oosSharpe: number): LeaderboardEntry {
  return {
    rank,
    strategyName: name,
    strategyConfig: { strategy: name, period: 14 },
    oosMetrics: makeMetrics({ sharpeRatio: oosSharpe }),
    isMetrics: makeMetrics({ sharpeRatio: oosSharpe * 1.5 }),
    robustnessRatio: 1 / 1.5,
    windowCount: 3,
  };
}

function makeConfig(): TournamentConfig {
  return {
    pair: 'BTC-USD',
    timeframe: '1h',
    startMs: 1000000,
    endMs: 9000000,
    walkForward: {
      trainWindowMs: 3000000,
      validateWindowMs: 1500000,
      stepMs: 1500000,
    },
    initialCapital: '10000',
    slippageBps: 5,
    feeTierMaker: 0.0035,
    feeTierTaker: 0.0075,
    topN: 3,
    activationMode: 'none',
  };
}

function makeResult(id: string, timestamp: number): TournamentResult {
  return {
    id,
    config: makeConfig(),
    leaderboard: [
      makeEntry(1, 'rsi-mean-reversion', 2.5),
      makeEntry(2, 'macd-momentum', 1.8),
      makeEntry(3, 'sma-crossover', 1.2),
    ],
    runTimestamp: timestamp,
    durationMs: 5000,
    strategiesEvaluated: 3,
  };
}

// ── Tests ──────────────────────────────────────────────────────────

describe('TournamentStore', () => {
  let store: TournamentStore;

  beforeEach(() => {
    store = new TournamentStore({ dbPath: ':memory:' });
  });

  afterEach(() => {
    store.close();
  });

  describe('tournament persistence', () => {
    it('saveTournament + getTournament round-trip preserves all fields', () => {
      const result = makeResult('t-001', 1700000000000);
      store.saveTournament(result);

      const loaded = store.getTournament('t-001');
      expect(loaded).not.toBeNull();
      expect(loaded!.id).toBe('t-001');
      expect(loaded!.runTimestamp).toBe(1700000000000);
      expect(loaded!.durationMs).toBe(5000);
      expect(loaded!.strategiesEvaluated).toBe(3);
      expect(loaded!.config.pair).toBe('BTC-USD');
      expect(loaded!.leaderboard).toHaveLength(3);
    });

    it('round-trip preserves Decimal metrics in leaderboard entries', () => {
      const result = makeResult('t-002', 1700000000000);
      store.saveTournament(result);

      const loaded = store.getTournament('t-002')!;
      const entry = loaded.leaderboard[0];

      // Verify Decimal fields survived serialization
      expect(entry.oosMetrics.totalReturn.toString()).toBe('0.15');
      expect(entry.oosMetrics.cagr.toString()).toBe('0.08');
      expect(entry.oosMetrics.maxDrawdown.toString()).toBe('200');
      expect(entry.oosMetrics.winRate.toString()).toBe('0.65');
      expect(entry.oosMetrics.profitFactor.toString()).toBe('2.1');
      expect(entry.oosMetrics.totalFees.toString()).toBe('12.5');
      expect(entry.oosMetrics.bestTrade.toString()).toBe('80');
      expect(entry.oosMetrics.worstTrade.toString()).toBe('-45');

      // Verify number fields
      expect(entry.oosMetrics.sharpeRatio).toBe(2.5);
      expect(entry.oosMetrics.totalTrades).toBe(15);
    });

    it('getTournament returns null for non-existent ID', () => {
      expect(store.getTournament('nonexistent')).toBeNull();
    });

    it('getLatestTournament returns most recent by timestamp', () => {
      store.saveTournament(makeResult('t-old', 1700000000000));
      store.saveTournament(makeResult('t-new', 1700000100000));
      store.saveTournament(makeResult('t-mid', 1700000050000));

      const latest = store.getLatestTournament();
      expect(latest).not.toBeNull();
      expect(latest!.id).toBe('t-new');
    });

    it('getLatestTournament returns null when empty', () => {
      expect(store.getLatestTournament()).toBeNull();
    });

    it('listTournaments returns all in descending order', () => {
      store.saveTournament(makeResult('t-1', 1700000000000));
      store.saveTournament(makeResult('t-2', 1700000200000));
      store.saveTournament(makeResult('t-3', 1700000100000));

      const all = store.listTournaments();
      expect(all).toHaveLength(3);
      expect(all[0].id).toBe('t-2');
      expect(all[1].id).toBe('t-3');
      expect(all[2].id).toBe('t-1');
    });

    it('listTournaments respects limit', () => {
      store.saveTournament(makeResult('t-1', 1700000000000));
      store.saveTournament(makeResult('t-2', 1700000200000));
      store.saveTournament(makeResult('t-3', 1700000100000));

      const limited = store.listTournaments(2);
      expect(limited).toHaveLength(2);
      expect(limited[0].id).toBe('t-2');
      expect(limited[1].id).toBe('t-3');
    });
  });

  describe('active strategy management', () => {
    it('saveActiveStrategies creates activation records', () => {
      const entries = [
        makeEntry(1, 'rsi-mean-reversion', 2.5),
        makeEntry(2, 'macd-momentum', 1.8),
      ];

      store.saveActiveStrategies('t-001', entries, 'paper');

      const active = store.getActiveStrategies('paper');
      expect(active).toHaveLength(2);
      expect(active[0].strategyName).toBe('rsi-mean-reversion');
      expect(active[0].activationMode).toBe('paper');
      expect(active[0].tournamentId).toBe('t-001');
      expect(active[0].deactivatedAt).toBeNull();
    });

    it('saveActiveStrategies deactivates previous active strategies for same mode', () => {
      const entries1 = [makeEntry(1, 'strategy-a', 2.0)];
      const entries2 = [makeEntry(1, 'strategy-b', 2.5)];

      store.saveActiveStrategies('t-001', entries1, 'paper');
      store.saveActiveStrategies('t-002', entries2, 'paper');

      const active = store.getActiveStrategies('paper');
      expect(active).toHaveLength(1);
      expect(active[0].strategyName).toBe('strategy-b');
      expect(active[0].tournamentId).toBe('t-002');
    });

    it('saveActiveStrategies does not deactivate different mode', () => {
      const paperEntries = [makeEntry(1, 'paper-strat', 2.0)];
      const liveEntries = [makeEntry(1, 'live-strat', 2.5)];

      store.saveActiveStrategies('t-001', paperEntries, 'paper');
      store.saveActiveStrategies('t-002', liveEntries, 'live');

      const paper = store.getActiveStrategies('paper');
      const live = store.getActiveStrategies('live');
      expect(paper).toHaveLength(1);
      expect(live).toHaveLength(1);
      expect(paper[0].strategyName).toBe('paper-strat');
      expect(live[0].strategyName).toBe('live-strat');
    });

    it('getActiveStrategies without mode returns all active', () => {
      store.saveActiveStrategies('t-001', [makeEntry(1, 'paper-strat', 2.0)], 'paper');
      store.saveActiveStrategies('t-002', [makeEntry(1, 'live-strat', 2.5)], 'live');

      const all = store.getActiveStrategies();
      expect(all).toHaveLength(2);
    });

    it('deactivateAll sets deactivatedAt on all active records', () => {
      store.saveActiveStrategies('t-001', [makeEntry(1, 'a', 2.0)], 'paper');
      store.saveActiveStrategies('t-002', [makeEntry(1, 'b', 2.5)], 'live');

      store.deactivateAll();

      const active = store.getActiveStrategies();
      expect(active).toHaveLength(0);
    });

    it('deactivateAll with mode only deactivates that mode', () => {
      store.saveActiveStrategies('t-001', [makeEntry(1, 'a', 2.0)], 'paper');
      store.saveActiveStrategies('t-002', [makeEntry(1, 'b', 2.5)], 'live');

      store.deactivateAll('paper');

      const paper = store.getActiveStrategies('paper');
      const live = store.getActiveStrategies('live');
      expect(paper).toHaveLength(0);
      expect(live).toHaveLength(1);
    });

    it('activation record contains correct oosSharpe and rank', () => {
      const entries = [makeEntry(2, 'test-strat', 1.75)];
      store.saveActiveStrategies('t-001', entries, 'paper');

      const active = store.getActiveStrategies('paper');
      expect(active[0].oosSharpe).toBeCloseTo(1.75);
      expect(active[0].rank).toBe(2);
      expect(active[0].strategyConfig).toEqual({ strategy: 'test-strat', period: 14 });
    });
  });
});
