# Design: Tournament Visibility & Ranking Fix

**Date:** 2026-03-27
**Status:** Approved

## Problem

1. Only 54 days of candle data → tournament OOS window has ~5 weeks, producing statistically meaningless results (8-trade OOS with 100% win rate → Sharpe 12.6, selected as winner despite IS Sharpe -1.9).
2. Tournament ranking uses raw OOS Sharpe only; robustness ratio (OOS/IS) is computed but ignored. Overfit strategies with negative robustness win.
3. UI `StrategyControls` only lists active engines (1 strategy). All 7 available strategies are invisible. No tournament leaderboard exists in the UI.

---

## Area 1: Historical Data

**Approach:** Set `HISTORY_DAYS=730` in `.env`.

The existing `DataPipeline` handles incremental backfill automatically — on next `npm start` it fetches from current data back to Mar 2024 and aggregates all timeframes. Two years gives the tournament 3 solid walk-forward windows (~8 months each at 70/30 IS/OOS split) instead of the current ~5-week OOS window.

**No code changes required.** One `.env` line.

---

## Area 2: Tournament Ranking Fix

**Approach:** Disqualify strategies with `robustnessRatio < 0` before sorting.

**Logic in `tournament-runner.ts`:**
1. After computing all leaderboard entries, split into `qualified` (robustnessRatio ≥ 0) and `disqualified` (robustnessRatio < 0).
2. Sort `qualified` by existing OOS Sharpe logic (or MC-adjusted score if enabled).
3. If ALL strategies are disqualified (possible on very short data), fall back to sorting all entries by IS Sharpe with a logged warning.
4. Append disqualified entries after qualified ones in the final leaderboard (ranked last).
5. Add `disqualified: boolean` and `disqualifyReason: string | null` fields to `LeaderboardEntry`.

**Effect on current data:** sma-crossover (robustness -6.61) would be disqualified. The next qualified strategy by OOS Sharpe wins.

**Test:** Add a unit test asserting that a strategy with negative robustness is ranked below all strategies with positive robustness.

---

## Area 3: UI — Combined Strategies Panel

### Backend

**New endpoint: `GET /api/tournament/latest`**
Returns the latest tournament result from `TournamentStore`:
```ts
{
  runAt: number;           // timestamp
  strategiesEvaluated: number;
  leaderboard: Array<{
    rank: number;
    strategyName: string;
    isSharpe: number;
    oosSharpe: number;
    robustnessRatio: number;
    oosTradeCount: number;
    oosWinRate: number;
    disqualified: boolean;
    disqualifyReason: string | null;
    active: boolean;       // currently running as paper/live engine
  }>;
}
```
Returns `null` body with 204 if no tournament has run.

**New endpoint: `GET /api/strategies/available`**
Returns all strategy names from the `StrategyRegistry`:
```ts
{ strategies: string[] }
```
Used to populate the table on first boot before any tournament has run.

### Frontend

**Replace** `StrategyControls` and `PerformancePanel` with a single `StrategiesPanel` component.

**Top half — Tournament Leaderboard:**
- Fetched from `GET /api/tournament/latest` on mount; re-fetched after each `strategyUpdate` WS event.
- Table columns: Rank | Strategy | IS Sharpe | OOS Sharpe | Robustness | OOS Trades | Win% | Status
- Status badge: `ACTIVE` (green), `DISQUALIFIED` (gray + tooltip "IS/OOS direction mismatch"), blank for other qualified strategies.
- Last tournament timestamp displayed above table.
- If no tournament data: shows strategy names from `GET /api/strategies/available` with all metric columns as `—`.

**Bottom half — Live Performance:**
- Existing `PerformancePanel` metrics moved in verbatim: win rate, avg win/loss, win/loss ratio, trade count, avg slippage grid, and per-strategy breakdown table.
- Derived from existing `trades` state via `useMemo` — no new data pipeline.

**Controls:**
- Start/stop toggle retained for the currently `ACTIVE` strategy only (stop requires inline confirmation, as before).
- No start buttons for non-active strategies — tournament owns selection.

### Files Changed
| File | Change |
|------|--------|
| `src/dashboard/server/routes/strategies.ts` | Add `GET /api/tournament/latest` and `GET /api/strategies/available` |
| `src/dashboard/ui/src/components/StrategiesPanel.tsx` | New — replaces StrategyControls + PerformancePanel |
| `src/dashboard/ui/src/components/StrategyControls.tsx` | Delete |
| `src/dashboard/ui/src/components/PerformancePanel.tsx` | Delete |
| `src/dashboard/ui/src/App.tsx` | Swap old components for `StrategiesPanel`, add tournament fetch |
| `src/dashboard/ui/src/types.ts` | Add `TournamentLeaderboard` and `AvailableStrategies` types |
| `src/tournament/types.ts` | Add `disqualified` and `disqualifyReason` to `LeaderboardEntry` |
| `src/tournament/tournament-runner.ts` | Apply disqualification filter before sort |
| `.env` | Set `HISTORY_DAYS=730` |

---

## Success Criteria

1. `npm start` with `HISTORY_DAYS=730` fetches ~2 years of candle data.
2. Tournament disqualifies any strategy with negative robustness ratio; the remaining strategies are ranked by OOS Sharpe.
3. Dashboard Strategies panel shows all 7 strategies with IS/OOS Sharpe, robustness, trade count, win rate, and status badge.
4. Active strategy is clearly highlighted; disqualified strategies are grayed out with reason.
5. Live performance metrics (win rate, avg win/loss, fee drag) appear in the bottom half of the same panel.
6. Unit test: negative-robustness strategy always ranks below positive-robustness strategies.
