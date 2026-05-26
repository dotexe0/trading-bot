# Diagnosis: Why the Bot Deploys Losing Strategies

**Date:** 2026-05-25
**Status:** Findings — pre-fix. No code changed.
**Trigger:** User report "we always lose on every trade" + request to "improve trading accuracy to make profit with leveraged trading."
**Method:** Systematic debugging (root-cause investigation) against live DB, 490 MB runtime log, and source.

---

## TL;DR

The bot does **not** lose on every trade — the realized record is roughly break-even. The real, evidence-backed defect is in **strategy selection**: a flawed robustness filter **discards the one strategy with a genuine out-of-sample edge** (`perp-mean-reversion`), and when every candidate is disqualified the pipeline **deploys the most overfit loser anyway** instead of holding cash. Leverage must not be added until selection only deploys positive-expectancy strategies.

---

## Evidence

### Realized trade record (all closed trades, ever)

| Market | Trades | Win rate | Net P&L |
|--------|--------|----------|---------|
| Spot paper (`trading.db`) | 9 | 44% (4 win) | −$130 |
| Perp paper (`perp.db`) | 6 | 83% (5 win) | **+$8** |

Paper equity over ~6 weeks: $10,000 → ~$10,043 (≈ flat). The "lose every trade" perception comes from the bot **currently running and deploying a measured-negative strategy**, not from the closed record.

### Smoking gun (live log, most recent tournament)

```
All strategies disqualified by robustness filter — falling back to IS Sharpe ranking
Tournament complete — topStrategy: perp-micro-momentum, topSharpe: -1.8783
```

The engine then immediately opened a leveraged short with that −1.88-Sharpe strategy.

### Per-strategy out-of-sample Sharpe (from log)

`perp-mean-reversion` — **profitable out-of-sample**, repeatedly, across parameter sets:
```
oosSharpe:  +0.85  +0.36  +1.41  +2.59  +1.97   (also some negative configs)
robustnessRatio: -0.15  -0.08  -0.70  -0.86  -0.37   → implies IS Sharpe ≈ -3.0
```
Interpretation: lost in training, **won on unseen data**. This is the only strategy with a real profit record (+$8, 5/6 wins live). It is disqualified every time.

`perp-vwap-reversion` — OOS Sharpe −3.0 to −4.0 (genuinely bad).
`perp-micro-momentum` — OOS Sharpe −1.0 to −4.5, IS also negative (genuinely bad). This is what gets deployed.

### Fallback frequency

`falling back to IS Sharpe ranking`: **54 occurrences** out of **236 completed tournaments (23%)**. Roughly one in four deployments selected a strategy that failed every quality check.

### Data coverage

BTC/ETH, 2026-02-02 → 2026-05-25 (~3.7 months). Walk-forward uses **2 windows**. OOS samples are small and noisy (Sharpe values of exactly 1.0000, one-off 4.19, many 0.0000 = never traded OOS).

---

## Root Causes (ranked by impact)

### 1. Robustness filter discards profitable-OOS strategies — `src/tournament/tournament-runner.ts:195`

```ts
} else if (entry.robustnessRatio < 0) {   // robustnessRatio = oosSharpe / avgIsSharpe
  entry.disqualified = true;
  entry.disqualifyReason = `IS/OOS direction mismatch (robustness ${...})`;
}
```

A negative ratio occurs in **two opposite** situations:
- **IS +, OOS −** = overfit → *should* disqualify ✓
- **IS −, OOS +** = profitable on unseen data → **should NOT disqualify** ✗ (this is the desirable, non-overfit case)

The filter treats both as flukes, deleting the genuine edge (`perp-mean-reversion`).

### 2. No edge-floor; overfit-seeking fallback — `tournament-runner.ts:240-246`

```ts
if (qualified.length === 0) {
  // deploys anyway, ranked by IN-SAMPLE Sharpe
  entries.sort((a, b) => b.isMetrics.sharpeRatio - a.isMetrics.sharpeRatio);
}
```

When nothing qualifies, the pipeline (a) **still returns a deployable winner** rather than "hold cash", and (b) ranks the disqualified set by **in-sample** Sharpe — actively preferring the most overfit candidate. `start.ts` then activates a live engine with it regardless of expectancy.

### 3. Evaluation is statistically underpowered

~3.7 months of data and 2 walk-forward windows make OOS Sharpe noisy and frequently empty. Edge/robustness/quality decisions rest on coin-flip-grade samples. Regime-gated strategies (z-score, momentum-breakout, multi-timeframe-trend) often produce zero OOS trades and are auto-disqualified.

### 4. Secondary

- **Spot shorting enabled** (`allowShorts:true`) — Coinbase spot cannot short; the largest spot losers were all shorts, so live behavior would diverge from paper.
- **4h live feed uses `SIX_HOUR` granularity** — wrong-resolution candles feeding signals.
- **12 of 20 sessions ended with `null` final equity** — unclean restarts/crashes.

---

## Recommended fix sequence (correct order of operations)

1. **Fix selection (highest impact, smallest change).**
   - Robustness filter: only disqualify the overfit quadrant (IS +, OOS −), not IS −/OOS +. Better: judge primarily on OOS expectancy.
   - Edge-floor: if no strategy clears a real OOS bar (e.g. OOS Sharpe > threshold, default > 0), **deploy nothing / hold cash** instead of falling back to IS ranking.
   - Regression tests for both (project rule: bug fixes ship with tests).
   - *Expected effect:* bot deploys `perp-mean-reversion` when it qualifies, and stays flat otherwise — stops deploying `vwap`/`micro-momentum` losers.

2. **Strengthen evaluation.** More history and/or more walk-forward windows so "is this an edge?" is answered reliably, not on 2 noisy windows.

3. **Then scale with leverage.** Only after selection reliably deploys positive-OOS strategies does conviction/Kelly-based leverage on the validated edge make sense. Leverage amplifies whatever expectancy exists — it must be positive first.

---

## Resolution — selection fix applied 2026-05-25

Running bot (PID 47352 tree) stopped first. Then, via TDD (tests written and watched fail before each change):

- **`tournament/config.ts`** — added `minOosSharpe` (edge floor, default `0`).
- **`tournament/tournament-runner.ts`**:
  - Disqualification now judged on out-of-sample expectancy: disqualify when `totalTrades === 0` or `oosSharpe <= minOosSharpe`. **Removed** the `robustnessRatio < 0` disqualification that discarded IS-negative/OOS-positive generalizers (the bug that threw out mean-reversion).
  - **Removed** the in-sample-Sharpe fallback. The leaderboard is always ranked by OOS; when nothing qualifies, every entry stays disqualified (no fabricated deployable winner) and a "holding cash" warning is logged.
  - Added `selectDeployableEntries()` — single source of truth for "what may trade" (non-disqualified entries).
  - Regime leaderboards now apply the same edge floor per regime, so the auto-switcher can't deploy a regime-negative strategy.
- **`tournament/activation-bridge.ts`** — `activate()` deploys only `selectDeployableEntries(...)`; activates nothing (holds cash) when all disqualified.
- **`cli/start.ts`** — spot `activatable` and perp activation gate + winner selection (paper and live) now use `selectDeployableEntries` instead of `totalTrades > 0`.

**Verification:** `tsc --noEmit` clean; full suite **1092 passed** (added/rewrote tests in `tournament-runner.test.ts` and `activation-bridge.test.ts`; updated `start-perp-wiring.test.ts` and config-literal helpers).

**Net effect:** the bot now deploys a strategy only when it has demonstrated positive out-of-sample expectancy (e.g. `perp-mean-reversion`), and holds cash otherwise instead of deploying losers like the −1.88-Sharpe `perp-micro-momentum`. Steps 2 (stronger evaluation) and 3 (leverage) remain.

## Step 2 (stronger evaluation) + secondary fixes — applied 2026-05-25

All via TDD; full suite 1100 passing, `tsc` clean.

**Stronger evaluation (step 2):**
- Added `splitWalkForward(totalMs, windowCount=5)` in `backtest/walk-forward.ts` and wired it into both the spot pipeline (`start.ts`) and `perp-tournament-runner.ts`, replacing the inline 3-window split. More out-of-sample slices ⇒ OOS Sharpe is less swayed by one lucky split.

**Empirical re-run (the actual validation):**
- Re-ran the perp tournament on 90 days of BTC-USD 1h under 4–5 windows. **The earlier apparent edge does not hold up.** `perp-mean-reversion` dropped from +2.59 OOS Sharpe (2-window split) to ~**+0.2 to +0.37** (4 windows); the run's top strategy was `perp-micro-momentum` at **+0.64** — versus **−1.88** in the live bot's own run. The numbers swing wildly with the evaluation window.
- **Conclusion:** there is **no strong, stable edge** on this data — only small, window-sensitive positive blips. The selection fix guarantees the bot deploys the best *positive*-OOS strategy (or holds cash), but it cannot manufacture a durable edge. **Leverage remains unjustified.** The real bottleneck is data quantity (~3.7 months) — confirming the edge would require materially more history.

**Secondary fixes (c):**
- **Spot shorting** — `allowShorts` added to tournament config (default true=perp); spot tournament + spot paper now set `false` (Coinbase spot can't short, so paper matches live).
- **4h granularity** — `live-data-feed.ts` no longer mislabels SIX_HOUR candles as 4h; it polls `ONE_HOUR` and aggregates to true 4h via `aggregateToClosedCandles` (drops the still-open window).
- **Restart stability** — investigation found **no crashes** (the 16 "fatal" log lines are FCM reconnect-exhaustion of the perp subsystem; zero uncaught exceptions). `null final_equity` sessions come from unclean kills (`recoverRunningSessions` marks orphans stopped without final equity). Added a fallback in `getLastFinalEquity` so equity carry-forward survives unclean shutdowns via the last equity snapshot.

## Caveats / honesty

- 9 + 6 = 15 closed trades total is too few to *prove* a durable edge — and step 2's re-run confirms the suspicion: the edge is not robust under proper evaluation.
- Fixing selection stops the bleeding and stops discarding any genuine edge. It does not manufacture profit. With no validated edge, the honest posture is: **paper-trade, gather more data, do not add leverage.**
