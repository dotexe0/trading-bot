# Design: Funding-Extreme Contrarian Strategy + Funding Data Layer

**Date:** 2026-05-27
**Status:** Approved design — pre-implementation.
**Companion files:** `docs/plans/2026-05-26-native-higher-tf-fetch-design.md` (the analogous candle-history work whose lessons this design re-applies).

## Goal

Add the bot's first genuinely funding-rate-driven strategy, grounded in a real perpetual-funding dataset, validated under the same multi-window walk-forward + min-trades + Monte Carlo gates that this session's investigation established as the bar for deployment.

## Why this exists (mechanism, not curve-fitting)

Perp funding is the price of leverage demand: longs pay shorts (or vice versa) every funding interval. When the rate sits at an extreme percentile of its recent distribution, one side is crowded and over-paying to maintain positions — historically that crowding precedes the squeeze in the opposite direction (long-liquidation flushes after extreme positive funding; short squeezes after extreme negative). This is the most-documented funding-derived edge in crypto and has a clean economic prior with a small parameter surface.

## Data — what's confirmed obtainable

Spike on 2026-05-27 (`logs/` not committed) found:

- **Binance:** HTTP 451 (geo-blocked here). Bybit: 403. Neither viable.
- **OKX:** public funding history accessible, but capped at **~90 days, 8h cadence** (271 points). Too shallow.
- **Coinbase INTX public endpoint** `GET https://api.international.coinbase.com/api/v1/instruments/{instrument}/funding` — **HTTP 200, no auth, not geo-blocked**, returns `{event_time, funding_rate, mark_price}`. Depth probe: **27,901 records per instrument back to 2023-03-22 (~3.19 years), hourly cadence** (27,895 of 27,901 intervals are exactly 1h; a handful of 0/2/3h gaps).

That dataset is more than enough for the walk-forward + 30-OOS-trades validation regime, and it is Coinbase-native (minimal basis vs the FCM perps the bot trades).

## Scope decision (made in brainstorm)

Funding is used as a **predictive signal** for the existing FCM perp markets the bot already trades. We are **not** trading INTX perps directly (which would require INTX-enabled non-US trading access and would generate too few round-trips for the validation bar). The funding rate is a feature, not a carry.

## Architecture

Four independently-testable units. Each has one clear purpose and a well-defined interface.

### Unit 1 — Funding data layer

**Provider** (`src/data/providers/intx-funding.ts`, new):
- Class `IntxFundingProvider` with `fetchFundingHistory(pair: TradingPair, startMs, endMs): Promise<FundingPoint[]>`.
- Pages the INTX endpoint with `result_limit=300` (confirmed accepted) and `result_offset` (newest-first), terminating when the page is empty or when `event_time < startMs`.
- Maps `BTC-USD → BTC-PERP`, `ETH-USD → ETH-PERP`.
- Injectable HTTP client (`fetch`-shaped interface) for tests, mirroring how `CoinbaseProvider` now accepts an injected `ProductCandlesClient`.
- 35 ms throttle between pages, 429 retry, 3 attempts — same defensive shape as `CoinbaseProvider`.

**Storage** (`src/data/storage/schema.ts` + `src/data/storage/funding-rate-repo.ts`, new):
- Table `funding_rates`:
  ```sql
  CREATE TABLE funding_rates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pair TEXT NOT NULL,         -- 'BTC-USD' | 'ETH-USD'
    timestamp INTEGER NOT NULL, -- Unix ms (start of funding interval)
    funding_rate TEXT NOT NULL, -- decimal string (decimal.js precision)
    mark_price TEXT NOT NULL    -- decimal string
  );
  CREATE UNIQUE INDEX idx_funding_unique ON funding_rates (pair, timestamp);
  CREATE INDEX idx_funding_pair_ts ON funding_rates (pair, timestamp);
  ```
- `FundingRateRepository` mirrors `CandleRepository`: `insertFundingRates`, `getFundingRates(pair, startMs, endMs)`, `getEarliestTimestamp(pair)`, `getLatestTimestamp(pair)`, `getCount(pair)`.

**Sync** (`src/data/funding-pipeline.ts`, new):
- `FundingPipeline.syncPair(pair)`: forward top-up (latest stored → now) **plus backward backfill** (configured-target → earliest stored) — the same two-pass shape forced on us by the candle-backfill bug earlier in this session. Self-limits via empty-page termination.
- New config: `data.fundingHistoryDays` (default 1095 = 3 years, matching `nativeHistoryDays`); env `FUNDING_HISTORY_DAYS`.
- Wired into `npm run fetch` after the candle sync, and exposed standalone as `npm run fetch:funding`.

**Validation**: timestamps must be ms; funding_rate parses as a finite number; mark_price > 0. Invalid rows rejected with a count log, valid rows stored.

### Unit 2 — Lookahead-safe funding accessor

**Interface** (`src/perp/funding-history.ts`, new):
```ts
export interface FundingHistory {
  /** Funding rates with timestamp ≤ asOfMs, within the lookback window. */
  ratesAsOf(asOfMs: number, lookbackMs: number): number[];
  /** Most-recent funding rate at or before asOfMs (null if none). */
  rateAt(asOfMs: number): number | null;
}
```

**Two implementations:**
- `HistoricalFundingHistory(sortedSeries: FundingPoint[])` — binary search over the stored series. Lookahead-safe by construction: the strategy passes `candles[last].timestamp` (the current replay bar), and the binary search returns only rates with `timestamp ≤ asOfMs`. Used in backtest/tournament.
- `LiveFundingHistory(rollingBuffer)` — backed by a bounded ring buffer fed from the live funding sync. Used in live trading.

This unit replaces the existing `fundingRateProvider: () => null` dead-end that made every funding-aware strategy a no-op in backtest.

### Unit 3 — `FundingExtremeContrarianStrategy`

**File**: `src/perp/strategies/funding-extreme-contrarian.ts` (new), implements `IStrategy`.

**Per-candle evaluation:**
1. `t = candles[last].timestamp`.
2. `window = fundingHistory.ratesAsOf(t, lookbackMs)` — default `lookbackMs = 30 * 86_400_000` (30 days, ~720 hourly points).
3. Guard: if `window.length < minWindowSamples` (default 200), return `[]`.
4. `current = fundingHistory.rateAt(t)`; guard `null`.
5. Compute `percentile = rank(current, window) / window.length` (strict-less + 0.5×equal for stability).
6. Signal:
   - `percentile ≥ upperPct` (default 0.90) → **SHORT**, `confidence = clamp((percentile - upperPct) / (1 - upperPct), 0.01, 1)`.
   - `percentile ≤ lowerPct` (default 0.10) → **LONG**, `confidence = clamp((lowerPct - percentile) / lowerPct, 0.01, 1)`.
   - else `[]`.

**Exits** (composed via `ExitLogicManager` as today + one funding-native exit):
- Regime-scaled ATR stop (existing v3.0 wiring).
- Time stop (existing).
- **Funding-normalized exit**: emit close signal when `percentile` returns inside `[neutralLow, neutralHigh]` (defaults 0.4 / 0.6). This is the unique-to-this-strategy exit — close the contrarian bet when the crowding it fades has dissipated.

**Params (deliberately small):**
| name | default | rationale |
|---|---|---|
| `lookbackMs` | 30d | Standard rolling window, captures one funding regime. |
| `upperPct` | 0.90 | Decile extreme — fewer params than absolute thresholds. |
| `lowerPct` | 0.10 | Symmetric. |
| `neutralLow/High` | 0.4 / 0.6 | "Reverted toward mean." |
| `minWindowSamples` | 200 | Refuse to act before the distribution is meaningfully populated (~8 days). |

Zod schema co-located, registered into `createPerpRegistry` (tournament mode: real historical accessor) and `createLivePerpRegistry` (live accessor).

**No regime gate.** Unlike `funding-rate-arb` (which restricts itself to RANGING/VOLATILE), the crowding-reversal thesis applies across all regimes — and adding a regime filter would add a parameter and shrink an already-narrow signal surface. The strategy ignores the optional `regime` arg.

### Unit 4 — Perp-tournament wiring

`src/perp/perp-tournament-runner.ts`:
- For each pair, load the full stored funding series (`fundingRepo.getFundingRates(pair, 0, Date.now())`) once.
- Build a `HistoricalFundingHistory` over that series.
- Inject the `FundingHistory` accessor **only into the new contrarian strategy's factory**. Existing funding-aware strategies (`funding-rate-arb`, `perp-mean-reversion`) keep their current no-arg `fundingRateProvider: () => null` in tournament mode and remain behaviourally unchanged by this design — migrating them to the new accessor is future work, deliberately deferred to avoid invalidating their already-validated configs.
- The strategy then produces real signals during backtest and flows through the unchanged 5-window walk-forward, `minOosTrades` gate (default 30), and optional MC.

No change to `BacktestEngine` or `WalkForwardRunner` — the funding context lives on the strategy instance, not the engine signature.

## Data flow

```
INTX public REST  ──fetch──▶  IntxFundingProvider  ──validate──▶  FundingRateRepository
                                                                          │
                                  (npm run fetch / fetch:funding sync)    ▼
                                                                   funding_rates table
                                                                          │
                                                                          ▼
Perp tournament for pair X:  load full series  ──▶  HistoricalFundingHistory (asOf-only)
                                                          │
                                                          ▼  injected at strategy build
                                FundingExtremeContrarianStrategy.evaluate(candles[0..i])
                                                          │
                                                          ▼
                                        BacktestEngine → WalkForwardRunner →
                                        TournamentRunner.disqualify (minOosTrades, edge floor) →
                                        selectDeployableEntries (hold cash if nothing clears)
```

## Validation plan (the bar this design must clear)

No deployment is implied by shipping the code. The strategy is "evidence-pending" until:
1. Aggregate OOS Sharpe > 0 in the 5-window walk-forward on **both** BTC-PERP and ETH-PERP at 1h.
2. Aggregate OOS trade count ≥ 30 on each (the `minOosTrades` gate this session added).
3. MC p5 Sharpe ≥ 0 on each.
4. Per-window OOS Sharpe positive in at least 3 of 5 windows (consistency, the bollinger lesson).

If any of these fail, the strategy is logged as "validated negative" and the bot holds cash on it — not deployed. This is an acceptable, documented outcome.

## Risks / honest caveats

- **Source vs trading basis**: INTX funding is the signal; the bot trades FCM perps. Small basis. Acceptable for a signal-only design; flagged in code comments.
- **Threshold sensitivity**: If decile thresholds yield < 30 OOS trades, the disciplined response is to loosen toward quartiles, **not** to keep deciles and squint. Threshold-loosening is itself a multiple-comparisons risk and is bounded by the spec to *one* loosening attempt.
- **Funding regime shift**: Funding distributions have widened since 2023. The 30-day rolling lookback adapts naturally; this is preferable to fixed absolute thresholds.
- **Anomalous intervals**: ~6 non-hourly gaps in 28k points. The accessor binary-searches by timestamp and is robust to gaps; no special handling needed.

## Testing (TDD per unit)

| Unit | Failing-test list |
|---|---|
| Provider | (a) forwards `result_limit`/`result_offset` to the HTTP client; (b) terminates pagination when a page comes back empty; (c) terminates when `event_time < startMs`; (d) maps `BTC-USD` ↔ `BTC-PERP`. |
| Repo | round-trip insert + range query; unique index dedupes; earliest/latest timestamps. |
| Pipeline | forward top-up reaches `now`; **backward backfill** extends earlier even when shallow data is pre-seeded (regression test mirroring the candle backfill fix). |
| `FundingHistory` accessor | (a) `ratesAsOf(t, L)` returns only rates with `ts ≤ t` (lookahead-safety assertion); (b) returns last N within lookback; (c) `rateAt(t)` returns the most-recent ≤ t. |
| Strategy | (a) emits SHORT at constructed top-decile; (b) emits LONG at constructed bottom-decile; (c) emits `[]` between thresholds; (d) emits `[]` when window samples < min; (e) confidence scales with extremity; (f) funding-normalized exit fires on percentile return to neutral band. |
| Tournament wiring | running the perp tournament with the new strategy produces ≥ 1 non-empty signal across the test horizon (proves the historical accessor is wired, not null). |

## Out of scope

- Carry-harvesting (collecting funding by holding INTX perp positions) — would need INTX trading access and inherently produces too few round-trips for the validation bar.
- Funding-derived exit *enhancements* to other existing strategies — possible follow-on once the data layer exists; not in this design.
- Cross-exchange funding aggregation — OKX is too shallow and Binance/Bybit blocked; not worth the added basis complexity.

## What "done" looks like

- Funding history fetched, stored, and accessible via the repo for both pairs.
- `FundingExtremeContrarianStrategy` registered in the perp registry, fully unit-tested, and producing signals in backtest.
- Perp tournament runs it through the standard validation pipeline.
- A run of `npm run tournament:perp` (or equivalent) prints the strategy's per-window OOS Sharpes and `disqualifyReason` if any.
- The strategy is either (a) green-lit by the validation gates → kept registered for the deployment pipeline, or (b) rejected → kept in the repo as a validated-negative reference, bot holds cash on it.
