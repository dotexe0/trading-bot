/**
 * Tests for ExitConfigStore -- persistence layer for optimized exit configs.
 */

import fs from 'node:fs';
import { describe, it, expect, afterEach } from 'vitest';
import { ExitConfigStore } from '../optimizer-store.js';
import { parseExitConfig } from '../../risk/exit-logic/config.js';
import type { OptimizedExitParams } from '../types.js';

// ── Helpers ────────────────────────────────────────────────────────

function tmpDbPath(): string {
  return `/tmp/optimizer-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
}

function makeParams(overrides: Partial<OptimizedExitParams> = {}): OptimizedExitParams {
  return {
    strategyName: 'sma-crossover',
    strategyConfigHash: 'abc123hash',
    exitConfig: parseExitConfig({
      exits: {
        atrStop: { enabled: true, atrPeriod: 14, atrMultiple: 2.0 },
        trailing: { enabled: true, activateAfterPct: 0.02, trailAtrMultiple: 2.0 },
        partial: { enabled: true, profitTargetPct: 0.03, closeFraction: 0.5 },
        time: { enabled: true, maxCandlesHeld: 20, pnlThresholdPct: 0.0 },
      },
    }),
    profitFactor: 2.35,
    searchedAt: Date.now(),
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────

describe('ExitConfigStore', () => {
  let store: ExitConfigStore;
  let dbPath: string;

  afterEach(() => {
    try { store?.close(); } catch { /* ignore */ }
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  });

  it('save() then getForStrategy() returns matching params', () => {
    dbPath = tmpDbPath();
    store = new ExitConfigStore({ dbPath });

    const params = makeParams();
    store.save(params);

    const result = store.getForStrategy('sma-crossover', 'abc123hash');
    expect(result).not.toBeNull();
    expect(result!.strategyName).toBe('sma-crossover');
    expect(result!.strategyConfigHash).toBe('abc123hash');
    expect(result!.profitFactor).toBeCloseTo(2.35, 2);
    expect(result!.exitConfig.exits.atrStop.enabled).toBe(true);
    expect(result!.exitConfig.exits.atrStop.atrMultiple).toBe(2.0);
    expect(result!.exitConfig.exits.trailing.activateAfterPct).toBe(0.02);
  });

  it('getForStrategy() with different hash returns null (staleness check)', () => {
    dbPath = tmpDbPath();
    store = new ExitConfigStore({ dbPath });

    const params = makeParams({ strategyConfigHash: 'hash-v1' });
    store.save(params);

    const result = store.getForStrategy('sma-crossover', 'hash-v2-different');
    expect(result).toBeNull();
  });

  it('double save with same strategy+hash upserts (one row, updated pf)', () => {
    dbPath = tmpDbPath();
    store = new ExitConfigStore({ dbPath });

    const first = makeParams({ profitFactor: 1.5 });
    store.save(first);

    const second = makeParams({ profitFactor: 3.0 });
    store.save(second);

    const result = store.getForStrategy('sma-crossover', 'abc123hash');
    expect(result).not.toBeNull();
    expect(result!.profitFactor).toBeCloseTo(3.0, 2);

    // Only one row for this strategy
    const list = store.listForStrategy('sma-crossover');
    expect(list.length).toBe(1);
  });

  it('listForStrategy() returns all entries sorted newest first', () => {
    dbPath = tmpDbPath();
    store = new ExitConfigStore({ dbPath });

    const older = makeParams({
      strategyConfigHash: 'hash-old',
      profitFactor: 1.0,
      searchedAt: 1000,
    });
    const newer = makeParams({
      strategyConfigHash: 'hash-new',
      profitFactor: 2.0,
      searchedAt: 2000,
    });

    store.save(older);
    store.save(newer);

    const list = store.listForStrategy('sma-crossover');
    expect(list.length).toBe(2);
    expect(list[0].searchedAt).toBe(2000);
    expect(list[1].searchedAt).toBe(1000);
  });

  it('save() with profitFactor=0 stores and retrieves as 0 (not NaN)', () => {
    dbPath = tmpDbPath();
    store = new ExitConfigStore({ dbPath });

    const params = makeParams({ profitFactor: 0 });
    store.save(params);

    const result = store.getForStrategy('sma-crossover', 'abc123hash');
    expect(result).not.toBeNull();
    expect(result!.profitFactor).toBe(0);
    expect(Number.isNaN(result!.profitFactor)).toBe(false);
  });
});
