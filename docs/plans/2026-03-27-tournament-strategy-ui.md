# Tournament Visibility & Ranking Fix Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix tournament ranking to disqualify overfit strategies, expose all 7 strategies and tournament scores in the UI via a combined Strategies panel.

**Architecture:** Three independent layers — (1) one `.env` change for more data, (2) a ranking guard in `TournamentRunner` that filters negative-robustness strategies before sorting, (3) two new REST endpoints + a new `StrategiesPanel` React component that replaces `StrategyControls` and `PerformancePanel`.

**Tech Stack:** TypeScript, Node.js, Fastify, React 18, Vitest

---

## Task 1: Extend HISTORY_DAYS in .env

**Files:**
- Modify: `.env` (create if absent)

**Step 1: Check if .env exists**

```bash
ls A:/fun/trading-bot/.env 2>/dev/null || echo "not found"
```

**Step 2: Add or update HISTORY_DAYS**

If `.env` exists, find the `HISTORY_DAYS` line and set it to 730. If it does not exist, create the file with:

```
HISTORY_DAYS=730
```

**Step 3: Verify**

```bash
grep HISTORY_DAYS A:/fun/trading-bot/.env
```
Expected output: `HISTORY_DAYS=730`

**Step 4: Commit**

```bash
git add .env
git commit -m "config: set HISTORY_DAYS=730 for 2-year tournament window"
```

---

## Task 2: Add `disqualified` fields to `LeaderboardEntry`

**Files:**
- Modify: `src/tournament/types.ts`

**Step 1: Write the failing test** (in task 4 — write types first so the test can import them)

Add two optional fields to `LeaderboardEntry` after `windowCount`:

```typescript
/** True when robustnessRatio < 0 (IS and OOS point in opposite directions). */
disqualified: boolean;
/** Human-readable reason for disqualification, null when not disqualified. */
disqualifyReason: string | null;
```

**Step 2: Apply the change**

In `src/tournament/types.ts`, inside `LeaderboardEntry`, after the `windowCount` line add:

```typescript
  /** True when robustnessRatio < 0 (IS and OOS point in opposite directions). */
  disqualified: boolean;
  /** Human-readable reason for disqualification, null when not disqualified. */
  disqualifyReason: string | null;
```

**Step 3: Build check**

```bash
cd A:/fun/trading-bot && npx tsc --noEmit 2>&1 | head -20
```

Expected: errors about `disqualified` missing in existing assignments in `tournament-runner.ts` (they will be fixed in the next task).

**Step 4: Commit after task 3 fixes the errors (do not commit alone)**

---

## Task 3: Apply disqualification filter in `TournamentRunner`

**Files:**
- Modify: `src/tournament/tournament-runner.ts` lines 182–199

**Step 1: Locate the sort block**

The block starts with:
```typescript
// Extract entries from accumulators for sorting
const entries = accumulators.map((a) => a.entry);
```
and ends after rank assignment (`entries[i].rank = i + 1`).

**Step 2: Replace with disqualification-aware sort**

Replace the entire block (from `const entries = ...` through the rank loop) with:

```typescript
// Extract entries from accumulators for sorting
const entries = accumulators.map((a) => a.entry);

// Mark disqualified entries: robustness < 0 means IS and OOS point in opposite
// directions — the OOS result is a statistical fluke, not genuine edge.
for (const entry of entries) {
  if (entry.robustnessRatio < 0) {
    entry.disqualified = true;
    entry.disqualifyReason =
      `IS/OOS direction mismatch (robustness ${entry.robustnessRatio.toFixed(2)})`;
  } else {
    entry.disqualified = false;
    entry.disqualifyReason = null;
  }
}

const qualified = entries.filter((e) => !e.disqualified);
const disqualifiedEntries = entries.filter((e) => e.disqualified);

const sortFn = config.monteCarlo?.enabled
  ? (a: LeaderboardEntry, b: LeaderboardEntry) => {
      const scoreA = a.mcAdjustedScore ?? a.oosMetrics.sharpeRatio;
      const scoreB = b.mcAdjustedScore ?? b.oosMetrics.sharpeRatio;
      return scoreB - scoreA;
    }
  : (a: LeaderboardEntry, b: LeaderboardEntry) =>
      b.oosMetrics.sharpeRatio - a.oosMetrics.sharpeRatio;

if (qualified.length === 0) {
  // All strategies disqualified — fall back to IS Sharpe ranking across all entries
  log.warn(
    { strategies: entries.map((e) => e.strategyName) },
    'All strategies disqualified by robustness filter — falling back to IS Sharpe ranking',
  );
  entries.sort((a, b) => b.isMetrics.sharpeRatio - a.isMetrics.sharpeRatio);
} else {
  qualified.sort(sortFn);
  disqualifiedEntries.sort(sortFn);
  entries.length = 0;
  entries.push(...qualified, ...disqualifiedEntries);
}

// Assign ranks
for (let i = 0; i < entries.length; i++) {
  entries[i].rank = i + 1;
}
```

**Step 3: Build check**

```bash
cd A:/fun/trading-bot && npx tsc --noEmit 2>&1 | head -20
```

Expected: zero errors.

**Step 4: Commit**

```bash
git add src/tournament/types.ts src/tournament/tournament-runner.ts
git commit -m "feat(tournament): disqualify negative-robustness strategies before ranking"
```

---

## Task 4: Unit test — disqualification ranking

**Files:**
- Modify: `src/tournament/__tests__/tournament-runner.test.ts`

**Step 1: Write the failing test**

Add this `describe` block after the existing ranking tests (around line 147). The test file uses `makeWfResult(oosSharpe, isSharpes[])` and a mock `walkForwardRunner`. Follow the same mock pattern already used in the file.

```typescript
describe('disqualification filter', () => {
  it('ranks disqualified (negative robustness) strategy below qualified ones', async () => {
    // qualifiedStrategy: IS=2.0, OOS=1.5 → robustness = 0.75 (positive, qualified)
    // disqualifiedStrategy: IS=-1.0, OOS=3.0 → robustness = -3.0 (negative, disqualified)
    mockWalkForwardRunner.run
      .mockReturnValueOnce(makeWfResult(1.5, [2.0]))   // qualified
      .mockReturnValueOnce(makeWfResult(3.0, [-1.0])); // disqualified (higher OOS!)

    mockRegistry.list.mockReturnValue(['qualified-strat', 'disqualified-strat']);

    const result = await runner.run(config, candles);

    expect(result.leaderboard[0].strategyName).toBe('qualified-strat');
    expect(result.leaderboard[0].disqualified).toBe(false);
    expect(result.leaderboard[0].rank).toBe(1);

    expect(result.leaderboard[1].strategyName).toBe('disqualified-strat');
    expect(result.leaderboard[1].disqualified).toBe(true);
    expect(result.leaderboard[1].disqualifyReason).toMatch(/IS\/OOS direction mismatch/);
    expect(result.leaderboard[1].rank).toBe(2);
  });

  it('falls back to IS Sharpe when all strategies are disqualified', async () => {
    // both have negative robustness; higher IS Sharpe wins
    mockWalkForwardRunner.run
      .mockReturnValueOnce(makeWfResult(2.0, [-1.0]))  // IS=-1, OOS=2 → disqualified, IS=-1
      .mockReturnValueOnce(makeWfResult(1.0, [-0.5])); // IS=-0.5, OOS=1 → disqualified, IS=-0.5

    mockRegistry.list.mockReturnValue(['strat-a', 'strat-b']);

    const result = await runner.run(config, candles);

    // strat-b has higher IS Sharpe (-0.5 > -1), so it ranks first in fallback
    expect(result.leaderboard[0].strategyName).toBe('strat-b');
    expect(result.leaderboard[1].strategyName).toBe('strat-a');
    expect(result.leaderboard[0].disqualified).toBe(true);
  });
});
```

**Step 2: Run test to confirm it fails**

```bash
cd A:/fun/trading-bot && npx vitest run src/tournament/__tests__/tournament-runner.test.ts 2>&1 | tail -20
```

Expected: FAIL — `disqualified` is undefined.

**Step 3: Run tests again after Task 3 is applied**

```bash
cd A:/fun/trading-bot && npx vitest run src/tournament/__tests__/tournament-runner.test.ts 2>&1 | tail -20
```

Expected: all tests PASS.

**Step 4: Commit**

```bash
git add src/tournament/__tests__/tournament-runner.test.ts
git commit -m "test(tournament): verify disqualification ranking and IS-Sharpe fallback"
```

---

## Task 5: Add `tournamentStore` and `strategyRegistry` to `RouteDeps`

**Files:**
- Modify: `src/dashboard/server/index.ts`

**Step 1: Add imports at top of file**

Find the existing imports block and add (if not already present):

```typescript
import type { TournamentStore } from '../../tournament/tournament-store.js';
import type { StrategyRegistry } from '../../strategies/registry.js';
```

**Step 2: Add fields to `RouteDeps` interface** (around line 89)

Inside `export interface RouteDeps { ... }`, add after the last existing field:

```typescript
  /** Latest tournament results — used by /api/tournament/latest endpoint. */
  tournamentStore?: TournamentStore;
  /** All registered strategy names — used by /api/strategies/available endpoint. */
  strategyRegistry?: StrategyRegistry;
```

**Step 3: Build check**

```bash
cd A:/fun/trading-bot && npx tsc --noEmit 2>&1 | head -20
```

Expected: zero errors (the new fields are optional so no existing callers break).

**Step 4: Commit**

```bash
git add src/dashboard/server/index.ts
git commit -m "feat(dashboard): add tournamentStore and strategyRegistry to RouteDeps"
```

---

## Task 6: Wire `tournamentStore` and `strategyRegistry` into `routeDeps` in `start.ts`

**Files:**
- Modify: `src/cli/start.ts`

**Step 1: Locate `routeDeps` construction in `start.ts`**

Search for `const routeDeps` — it is around line 345 of the server index or constructed in `start.ts`. Find where `RouteDeps` is assembled (look for the object that includes `liveStateStore`, `sessionStore`, `activationBridge`).

**Step 2: Locate `tournamentStore` creation**

Search for `new TournamentStore` in `start.ts`. It is created inside the per-pair tournament loop. Move its construction to **before** the loop so it has file scope (it only needs a `db` reference which is available before the loop). The store is stateless between calls — creating it once is safe.

**Step 3: Add to `routeDeps`**

In the `routeDeps` object literal, add:

```typescript
tournamentStore,
strategyRegistry: registry,
```

**Step 4: Build check**

```bash
cd A:/fun/trading-bot && npx tsc --noEmit 2>&1 | head -20
```

Expected: zero errors.

**Step 5: Commit**

```bash
git add src/cli/start.ts
git commit -m "feat(dashboard): wire tournamentStore and strategyRegistry into route deps"
```

---

## Task 7: Add `GET /api/tournament/latest` and `GET /api/strategies/available`

**Files:**
- Modify: `src/dashboard/server/routes/strategies.ts`

**Step 1: Add the two new endpoints** at the end of `registerStrategyRoutes`, before the closing `}`:

```typescript
  /**
   * GET /api/tournament/latest
   * Returns the most recent tournament leaderboard with IS/OOS metrics,
   * robustness ratio, disqualification status, and active flag.
   * Returns 204 if no tournament has been run.
   */
  app.get('/api/tournament/latest', async (_request, reply) => {
    if (!deps.tournamentStore) {
      return reply.status(204).send();
    }
    const result = deps.tournamentStore.getLatestTournament();
    if (!result) {
      return reply.status(204).send();
    }

    const activeEngines = deps.activationBridge.getActiveEngines();
    const activeNames = new Set(activeEngines.keys());

    return {
      runAt: result.runTimestamp,
      strategiesEvaluated: result.strategiesEvaluated,
      leaderboard: result.leaderboard.map((e) => ({
        rank: e.rank,
        strategyName: e.strategyName,
        isSharpe: e.isMetrics.sharpeRatio,
        oosSharpe: e.oosMetrics.sharpeRatio,
        robustnessRatio: e.robustnessRatio,
        oosTradeCount: e.oosMetrics.totalTrades,
        oosWinRate: parseFloat(String(e.oosMetrics.winRate)),
        disqualified: e.disqualified,
        disqualifyReason: e.disqualifyReason,
        active: activeNames.has(e.strategyName),
      })),
    };
  });

  /**
   * GET /api/strategies/available
   * Returns all strategy names registered in the StrategyRegistry.
   * Used to populate the UI before any tournament has run.
   */
  app.get('/api/strategies/available', async () => {
    if (!deps.strategyRegistry) {
      return { strategies: [] as string[] };
    }
    return { strategies: deps.strategyRegistry.list() };
  });
```

**Step 2: Build check**

```bash
cd A:/fun/trading-bot && npx tsc --noEmit 2>&1 | head -20
```

Expected: zero errors.

**Step 3: Commit**

```bash
git add src/dashboard/server/routes/strategies.ts
git commit -m "feat(api): add /api/tournament/latest and /api/strategies/available endpoints"
```

---

## Task 8: Add frontend types for tournament leaderboard

**Files:**
- Modify: `src/dashboard/ui/src/types.ts`

**Step 1: Append to end of file**

```typescript
// ── Tournament Leaderboard ────────────────────────────────────────────

export interface TournamentLeaderboardEntry {
  rank: number;
  strategyName: string;
  isSharpe: number;
  oosSharpe: number;
  robustnessRatio: number;
  oosTradeCount: number;
  oosWinRate: number;
  disqualified: boolean;
  disqualifyReason: string | null;
  active: boolean;
}

export interface TournamentLeaderboard {
  runAt: number;
  strategiesEvaluated: number;
  leaderboard: TournamentLeaderboardEntry[];
}
```

**Step 2: Build check**

```bash
cd A:/fun/trading-bot && npx tsc --noEmit -p src/dashboard/ui/tsconfig.json 2>&1 | head -20
```

Expected: zero errors.

**Step 3: Commit**

```bash
git add src/dashboard/ui/src/types.ts
git commit -m "feat(ui): add TournamentLeaderboard frontend types"
```

---

## Task 9: Create `StrategiesPanel.tsx` (combined component)

**Files:**
- Create: `src/dashboard/ui/src/components/StrategiesPanel.tsx`

**Step 1: Write the component**

```tsx
/**
 * StrategiesPanel — Combined tournament leaderboard + live performance metrics.
 *
 * Top half: Tournament leaderboard showing all evaluated strategies with IS/OOS
 * Sharpe, robustness ratio, trade count, win rate, and status badges. Falls back
 * to listing available strategy names if no tournament has run.
 *
 * Bottom half: Live performance metrics and per-strategy breakdown derived from
 * the current session's completed trades (same logic as the old PerformancePanel).
 *
 * Controls: stop toggle for the active (RUNNING) strategy only.
 */

import React, { useState, useMemo } from 'react';
import type { TradeData, StrategyInfo, TournamentLeaderboard } from '../types.js';

interface StrategiesPanelProps {
  strategies: StrategyInfo[];
  trades: TradeData[];
  tournament: TournamentLeaderboard | null;
  availableStrategies: string[];
  onStop: (name: string) => Promise<void>;
}

interface StopState {
  pending: boolean;
  confirming: boolean;
}

function fmt(n: number, decimals = 2): string {
  return n.toFixed(decimals);
}

function colorPnl(n: number): React.CSSProperties {
  return { color: n >= 0 ? '#22c55e' : '#ef4444' };
}

export function StrategiesPanel({
  strategies,
  trades,
  tournament,
  availableStrategies,
  onStop,
}: StrategiesPanelProps): React.ReactElement {
  const [stopState, setStopState] = useState<Record<string, StopState>>({});

  function getStop(name: string): StopState {
    return stopState[name] ?? { pending: false, confirming: false };
  }

  function patchStop(name: string, patch: Partial<StopState>) {
    setStopState((prev) => ({ ...prev, [name]: { ...getStop(name), ...patch } }));
  }

  async function handleConfirmStop(name: string) {
    patchStop(name, { pending: true, confirming: false });
    try {
      await onStop(name);
    } finally {
      patchStop(name, { pending: false });
    }
  }

  // ── Build leaderboard rows ──────────────────────────────────────────
  const runningNames = new Set(
    strategies.filter((s) => s.status === 'running').map((s) => s.name),
  );

  // If tournament data exists, use it; otherwise fall back to availableStrategies
  const leaderboardRows = useMemo(() => {
    if (tournament) {
      return tournament.leaderboard.map((e) => ({
        strategyName: e.strategyName,
        rank: e.rank,
        isSharpe: e.isSharpe,
        oosSharpe: e.oosSharpe,
        robustnessRatio: e.robustnessRatio,
        oosTradeCount: e.oosTradeCount,
        oosWinRate: e.oosWinRate,
        disqualified: e.disqualified,
        disqualifyReason: e.disqualifyReason,
        active: runningNames.has(e.strategyName),
        hasTournamentData: true,
      }));
    }
    return availableStrategies.map((name, i) => ({
      strategyName: name,
      rank: i + 1,
      isSharpe: null,
      oosSharpe: null,
      robustnessRatio: null,
      oosTradeCount: null,
      oosWinRate: null,
      disqualified: false,
      disqualifyReason: null,
      active: runningNames.has(name),
      hasTournamentData: false,
    }));
  }, [tournament, availableStrategies, runningNames]);

  // ── Live performance metrics (from old PerformancePanel) ────────────
  const metrics = useMemo(() => {
    const completed = trades.filter((t) => t.pnl !== undefined && t.pnl !== null);
    if (completed.length === 0) return null;

    const wins = completed.filter((t) => parseFloat(t.pnl!) > 0);
    const losses = completed.filter((t) => parseFloat(t.pnl!) < 0);
    const winRate = wins.length / completed.length;
    const avgWinPct =
      wins.length > 0
        ? wins.reduce((s, t) => s + parseFloat(t.pnlPct!), 0) / wins.length
        : 0;
    const avgLossPct =
      losses.length > 0
        ? losses.reduce((s, t) => s + parseFloat(t.pnlPct!), 0) / losses.length
        : 0;
    const winLossRatio =
      Math.abs(avgLossPct) > 0
        ? Math.abs(avgWinPct) / Math.abs(avgLossPct)
        : avgWinPct > 0
        ? 999
        : 0;
    const withSlippage = completed.filter(
      (t) => t.entrySlippageBps !== undefined || t.exitSlippageBps !== undefined,
    );
    const avgSlippageBps =
      withSlippage.length > 0
        ? withSlippage.reduce(
            (s, t) =>
              s + parseFloat(t.entrySlippageBps ?? '0') + parseFloat(t.exitSlippageBps ?? '0'),
            0,
          ) / withSlippage.length
        : null;

    return { tradeCount: completed.length, winRate, avgWinPct, avgLossPct, winLossRatio, avgSlippageBps };
  }, [trades]);

  const strategyStats = useMemo(() => {
    const completed = trades.filter((t) => t.pnl !== undefined && t.pnl !== null && t.strategyName);
    if (completed.length === 0) return [];
    const groups = new Map<string, typeof completed>();
    for (const t of completed) {
      const name = t.strategyName!;
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name)!.push(t);
    }
    return Array.from(groups.entries()).map(([name, g]) => {
      const count = g.length;
      const wins = g.filter((t) => parseFloat(t.pnl!) > 0);
      const winRate = wins.length / count;
      const avgGrossPnl =
        g.reduce((s, t) => {
          const fees = parseFloat(t.entryFee) + parseFloat(t.exitFee ?? '0');
          return s + parseFloat(t.pnl!) + fees;
        }, 0) / count;
      const avgFees =
        g.reduce((s, t) => s + parseFloat(t.entryFee) + parseFloat(t.exitFee ?? '0'), 0) / count;
      const avgNetPnl = g.reduce((s, t) => s + parseFloat(t.pnl!), 0) / count;
      const feeDragRatio =
        Math.abs(avgGrossPnl) > 0
          ? Math.min((avgFees / Math.abs(avgGrossPnl)) * 100, 9999)
          : 0;
      return { name, count, winRate, avgGrossPnl, avgFees, avgNetPnl, feeDragRatio };
    });
  }, [trades]);

  // ── Render ──────────────────────────────────────────────────────────
  return (
    <div className="panel">
      <div className="panel-title">
        Strategies
        {tournament && (
          <span style={{ fontSize: '11px', color: '#64748b', fontWeight: 400, marginLeft: '8px' }}>
            Tournament run {new Date(tournament.runAt).toLocaleString()}
          </span>
        )}
      </div>

      {/* Tournament leaderboard */}
      <table style={{ width: '100%', fontSize: '12px', borderCollapse: 'collapse', marginBottom: '12px' }}>
        <thead>
          <tr style={{ color: '#64748b', textAlign: 'right' }}>
            <th style={{ textAlign: 'left', paddingBottom: '6px' }}>#</th>
            <th style={{ textAlign: 'left', paddingBottom: '6px', paddingRight: '8px' }}>Strategy</th>
            <th>IS Sharpe</th>
            <th>OOS Sharpe</th>
            <th>Robustness</th>
            <th>OOS Trades</th>
            <th>Win%</th>
            <th style={{ textAlign: 'right' }}>Status</th>
          </tr>
        </thead>
        <tbody>
          {leaderboardRows.map((row) => {
            const isRunning = row.active;
            const isDisqualified = row.disqualified;
            const rowStyle: React.CSSProperties = {
              textAlign: 'right',
              borderTop: '1px solid #1e293b',
              opacity: isDisqualified ? 0.45 : 1,
            };
            return (
              <tr key={row.strategyName} style={rowStyle}>
                <td style={{ textAlign: 'left', color: '#64748b' }}>{row.rank}</td>
                <td style={{ textAlign: 'left', paddingRight: '8px', color: '#cbd5e1' }}>
                  {row.strategyName}
                </td>
                <td style={row.isSharpe !== null ? colorPnl(row.isSharpe) : {}}>
                  {row.isSharpe !== null ? fmt(row.isSharpe) : '—'}
                </td>
                <td style={row.oosSharpe !== null ? colorPnl(row.oosSharpe) : {}}>
                  {row.oosSharpe !== null ? fmt(row.oosSharpe) : '—'}
                </td>
                <td style={row.robustnessRatio !== null ? colorPnl(row.robustnessRatio) : {}}>
                  {row.robustnessRatio !== null ? fmt(row.robustnessRatio) : '—'}
                </td>
                <td>{row.oosTradeCount ?? '—'}</td>
                <td>
                  {row.oosWinRate !== null ? (row.oosWinRate * 100).toFixed(1) + '%' : '—'}
                </td>
                <td>
                  {isRunning && (
                    <>
                      <span className="status-badge status-running" style={{ marginRight: '6px' }}>
                        ACTIVE
                      </span>
                      {(() => {
                        const s = getStop(row.strategyName);
                        if (s.confirming) {
                          return (
                            <span>
                              <button
                                className="btn-secondary btn-sm"
                                onClick={() => patchStop(row.strategyName, { confirming: false })}
                                style={{ marginRight: '4px' }}
                              >
                                Cancel
                              </button>
                              <button
                                className="btn-danger btn-sm"
                                onClick={() => handleConfirmStop(row.strategyName)}
                              >
                                Stop
                              </button>
                            </span>
                          );
                        }
                        return (
                          <button
                            className="toggle-switch toggle-on"
                            disabled={s.pending}
                            onClick={() => patchStop(row.strategyName, { confirming: true })}
                            title={`Stop ${row.strategyName}`}
                            aria-label={`Stop ${row.strategyName}`}
                          >
                            <span className="toggle-thumb" />
                          </button>
                        );
                      })()}
                    </>
                  )}
                  {isDisqualified && !isRunning && (
                    <span
                      className="status-badge"
                      style={{ background: '#334155', color: '#94a3b8', cursor: 'help' }}
                      title={row.disqualifyReason ?? 'Disqualified'}
                    >
                      DISQUALIFIED
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {/* Live performance (only when trades exist) */}
      {metrics && (
        <>
          <div className="panel-title" style={{ marginTop: '4px' }}>Live Performance</div>
          <div className="performance-grid">
            <div className="perf-stat">
              <div className="perf-stat-value">{(metrics.winRate * 100).toFixed(1)}%</div>
              <div className="perf-stat-label">Win Rate</div>
            </div>
            <div className="perf-stat">
              <div className="perf-stat-value" style={colorPnl(metrics.avgWinPct)}>
                {metrics.avgWinPct >= 0 ? '+' : ''}{fmt(metrics.avgWinPct)}%
              </div>
              <div className="perf-stat-label">Avg Win</div>
            </div>
            <div className="perf-stat">
              <div className="perf-stat-value" style={{ color: '#ef4444' }}>
                {fmt(metrics.avgLossPct)}%
              </div>
              <div className="perf-stat-label">Avg Loss</div>
            </div>
            <div className="perf-stat">
              <div className="perf-stat-value">{fmt(metrics.winLossRatio)}</div>
              <div className="perf-stat-label">Win/Loss</div>
            </div>
            <div className="perf-stat">
              <div className="perf-stat-value">{metrics.tradeCount}</div>
              <div className="perf-stat-label">Trades</div>
            </div>
            {metrics.avgSlippageBps !== null && (
              <div className="perf-stat">
                <div
                  className="perf-stat-value"
                  style={{ color: metrics.avgSlippageBps > 0 ? '#ef4444' : '#22c55e' }}
                >
                  {metrics.avgSlippageBps > 0 ? '+' : ''}{fmt(metrics.avgSlippageBps, 1)} bps
                </div>
                <div className="perf-stat-label">Avg Slippage</div>
              </div>
            )}
          </div>

          {strategyStats.length > 0 && (
            <>
              <div className="panel-title" style={{ marginTop: '12px' }}>Strategy Breakdown</div>
              <table style={{ width: '100%', fontSize: '12px', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ color: '#94a3b8', textAlign: 'right' }}>
                    <th style={{ textAlign: 'left', paddingBottom: '4px' }}>Strategy</th>
                    <th>Trades</th>
                    <th>Win%</th>
                    <th>Gross</th>
                    <th>Fees</th>
                    <th>Net</th>
                    <th>FeeDrag</th>
                  </tr>
                </thead>
                <tbody>
                  {strategyStats.map((s) => (
                    <tr key={s.name} style={{ textAlign: 'right', borderTop: '1px solid #1e293b' }}>
                      <td style={{ textAlign: 'left', paddingRight: '8px', color: '#cbd5e1' }}>
                        {s.name}
                      </td>
                      <td>{s.count}</td>
                      <td>{(s.winRate * 100).toFixed(1)}%</td>
                      <td style={colorPnl(s.avgGrossPnl)}>
                        {s.avgGrossPnl >= 0 ? '+' : ''}{s.avgGrossPnl.toFixed(4)}
                      </td>
                      <td style={{ color: '#f59e0b' }}>{s.avgFees.toFixed(4)}</td>
                      <td style={colorPnl(s.avgNetPnl)}>
                        {s.avgNetPnl >= 0 ? '+' : ''}{s.avgNetPnl.toFixed(4)}
                      </td>
                      <td style={{ color: s.feeDragRatio > 50 ? '#ef4444' : '#94a3b8' }}>
                        {s.feeDragRatio.toFixed(1)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}

      {!metrics && (
        <div className="empty-state" style={{ marginTop: '8px' }}>No completed trades</div>
      )}
    </div>
  );
}
```

**Step 2: Build check**

```bash
cd A:/fun/trading-bot && npx tsc --noEmit -p src/dashboard/ui/tsconfig.json 2>&1 | head -30
```

Expected: zero errors.

**Step 3: Commit**

```bash
git add src/dashboard/ui/src/components/StrategiesPanel.tsx
git commit -m "feat(ui): add StrategiesPanel combining tournament leaderboard and live performance"
```

---

## Task 10: Update `App.tsx` — swap in `StrategiesPanel`, fetch tournament data

**Files:**
- Modify: `src/dashboard/ui/src/App.tsx`

**Step 1: Add tournament state and available strategies state**

Find the existing `useState` declarations block and add:

```typescript
const [tournament, setTournament] = useState<TournamentLeaderboard | null>(null);
const [availableStrategies, setAvailableStrategies] = useState<string[]>([]);
```

**Step 2: Add import for new types and component**

Replace:
```typescript
import { StrategyControls } from './components/StrategyControls.js';
```
and:
```typescript
import { PerformancePanel } from './components/PerformancePanel.js';
```
with:
```typescript
import { StrategiesPanel } from './components/StrategiesPanel.js';
```

Add to the type imports from `'./types.js'`:
```typescript
  TournamentLeaderboard,
```

**Step 3: Add `fetchTournament` function** (alongside existing `handleStrategyStart`/`handleStrategyStop`):

```typescript
const fetchTournament = useCallback(async () => {
  try {
    const res = await fetch('/api/tournament/latest');
    if (res.status === 204) {
      setTournament(null);
      return;
    }
    const data = await res.json() as TournamentLeaderboard;
    setTournament(data);
  } catch {
    // non-fatal: tournament panel shows "—" placeholders
  }
}, []);

const fetchAvailableStrategies = useCallback(async () => {
  try {
    const res = await fetch('/api/strategies/available');
    if (!res.ok) return;
    const data = await res.json() as { strategies: string[] };
    setAvailableStrategies(data.strategies);
  } catch {
    // non-fatal
  }
}, []);
```

**Step 4: Fetch on mount**

Find the existing `useEffect` that fetches initial data (look for a `fetch('/api/...')` inside a `useEffect([], [])`) and add calls:

```typescript
fetchTournament();
fetchAvailableStrategies();
```

**Step 5: Re-fetch tournament on `strategyUpdate` WS events**

Find the WebSocket message handler where `engineStarted` or `engineStopped` messages are handled and add:

```typescript
fetchTournament();
```

after those cases (tournament active flags need refreshing when engines change).

**Step 6: Replace `<PerformancePanel>` and `<StrategyControls>` with `<StrategiesPanel>`**

Remove:
```tsx
<PerformancePanel trades={trades} />
```
and:
```tsx
<StrategyControls
  strategies={strategies}
  onStart={handleStrategyStart}
  onStop={handleStrategyStop}
/>
```

Add in their place (at whichever location makes sense in the layout — put it where `PerformancePanel` was):
```tsx
<StrategiesPanel
  strategies={strategies}
  trades={trades}
  tournament={tournament}
  availableStrategies={availableStrategies}
  onStop={handleStrategyStop}
/>
```

**Step 7: Build check**

```bash
cd A:/fun/trading-bot && npx tsc --noEmit -p src/dashboard/ui/tsconfig.json 2>&1 | head -30
```

Expected: zero errors.

**Step 8: Commit**

```bash
git add src/dashboard/ui/src/App.tsx
git commit -m "feat(ui): wire StrategiesPanel into App with tournament and available-strategies fetch"
```

---

## Task 11: Delete old components

**Files:**
- Delete: `src/dashboard/ui/src/components/StrategyControls.tsx`
- Delete: `src/dashboard/ui/src/components/PerformancePanel.tsx`

**Step 1: Delete files**

```bash
rm A:/fun/trading-bot/src/dashboard/ui/src/components/StrategyControls.tsx
rm A:/fun/trading-bot/src/dashboard/ui/src/components/PerformancePanel.tsx
```

**Step 2: Build check — confirm no remaining imports**

```bash
cd A:/fun/trading-bot && npx tsc --noEmit -p src/dashboard/ui/tsconfig.json 2>&1 | head -20
```

Expected: zero errors. If errors mention `StrategyControls` or `PerformancePanel`, there is a stale import somewhere — fix it.

**Step 3: Full test run**

```bash
cd A:/fun/trading-bot && npx vitest run 2>&1 | tail -20
```

Expected: all tests pass (no test files import the deleted components).

**Step 4: Commit**

```bash
git add -A
git commit -m "refactor(ui): remove StrategyControls and PerformancePanel (merged into StrategiesPanel)"
```

---

## Task 12: Build UI bundle and smoke test

**Step 1: Build UI**

```bash
cd A:/fun/trading-bot/src/dashboard/ui && npm run build 2>&1 | tail -20
```

Expected: build succeeds with no errors.

**Step 2: Full test suite**

```bash
cd A:/fun/trading-bot && npx vitest run 2>&1 | tail -10
```

Expected: all tests pass.

**Step 3: Final commit if anything was auto-fixed**

If the build produced updated files (e.g. `tsconfig.tsbuildinfo`):

```bash
git add -A
git commit -m "build: rebuild UI bundle after StrategiesPanel integration"
```
