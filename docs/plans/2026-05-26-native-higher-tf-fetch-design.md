# Design: Native Higher-Timeframe Candle Fetching

**Date:** 2026-05-26
**Status:** ✅ Implemented 2026-05-27 (TDD). See `coinbase.ts`, `pipeline.ts`, `config.ts` + tests in `providers.test.ts`, `pipeline.test.ts`, `config.test.ts`. Edge re-validation (#2) still pending — run `npm run fetch` to populate native history, then re-run multi-window walk-forward.
**Goal:** Fetch 1+ years of 1h/1D candle history (vs the current ~113 days) so out-of-sample edge validation has statistical power.

## Problem

The data pipeline fetches **1-minute** candles (`coinbase.ts` hardcodes `granularity: 'ONE_MINUTE'`) and aggregates every higher timeframe from them. Coinbase only retains ~3–4 months of 1-minute candles, so all timeframes — including the 1h workhorse the tournaments use — are capped at ~113 days. That is too little for multi-window walk-forward validation: OOS Sharpe swings wildly between window choices (see `2026-05-25-trading-loss-root-cause-diagnosis.md`), so no edge can be confirmed or denied with confidence.

Coinbase retains **native** 1h and 1D candles far longer than 1m. Fetching those directly lifts the ceiling.

## Decisions (from brainstorming)

- **Scope:** native long history for **1h and 1D** only. 4h is derived from native 1h (Coinbase has no native 4h). 1m/5m/15m stay recent-only (~113d) — scalping is inherently short-horizon and 1m retention is the hard limit.
- **Source of truth:** native fetch is the **sole** source for 1h/1D. Stop aggregating them from 1m. No dedup/boundary logic. (Coinbase's native 1h ≈ aggregating its own 1m.)
- **Depth:** walk backward until Coinbase returns an empty batch (auto-discovers the true retention limit), bounded by a generous cap. New `nativeHistoryDays` config, default **1095** (3yr), separate from the 1m `historyDays`.

## Architecture

Three touched units; **no schema change** (candles already keyed by `pair` + `timeframe`).

### 1. Provider — `src/data/providers/coinbase.ts`
Generalize `fetchCandles(pair, startMs, endMs)` to accept a **granularity** (e.g. `fetchCandles(pair, startMs, endMs, granularity = 'ONE_MINUTE')`) so existing callers are untouched. The current backward-paginated walk (350 candles/request, 35 ms throttle, 429 retry) is granularity-agnostic — a 350-candle batch is 350 hours or 350 days at coarser granularities.

**Fetch-until-empty:** terminate the backward walk when a batch returns 0 candles *or* the configured start bound is reached. This discovers Coinbase's real 1h/1D retention at runtime.

### 2. Pipeline — `src/data/pipeline.ts`
Per pair, `sync` becomes:
1. Fetch **1m** over `historyDays` → validate / gap-fill → aggregate to **5m/15m only** (no longer aggregate 1h/1D).
2. Fetch **native 1h** and **native 1D** over `nativeHistoryDays` (fetch-until-empty); store directly.
3. Derive **4h** from the stored native 1h via the existing `aggregateCandles(candles, '4h')` (already tested in the 4h-granularity fix).
4. Incremental resume per `(pair, timeframe)` from the latest stored timestamp, as today.

### 3. Config — `src/core/config.ts`
Add `data.nativeHistoryDays` (default `1095`) and `NATIVE_HISTORY_DAYS` env parsing, separate from `historyDays`.

## Data flow

```
sync → for each pair:
  fetch 1m [now - historyDays, now] → validate/gap-fill → aggregate 5m, 15m → store
  fetch native 1h [now - nativeHistoryDays, now] (until empty) → store
  fetch native 1D [now - nativeHistoryDays, now] (until empty) → store
  aggregate 4h from stored native 1h → store
```

## Error handling

- Empty batch terminates the backward walk cleanly (not an error).
- 429 rate-limit retry/backoff unchanged.
- A native-fetch failure logs and **preserves existing stored data** (never wipes).
- Existing candle validation (monotonic timestamps, OHLC sanity) applies to native candles too.

## Testing (TDD)

- **Provider:** granularity argument is forwarded to the Coinbase client; backward pagination **terminates on an empty batch**; the start-bound cap is respected. Mock client.
- **Pipeline:** 1h and 1D are populated from the native fetch and are **not** aggregated from 1m; 4h is aggregated from native 1h; 5m/15m are still aggregated from 1m. Mock provider + in-memory DB.
- `aggregateCandles` 1h→4h: already covered by the 4h-granularity fix.

## Out of scope

- No change to scalping timeframes (1m/5m/15m).
- No change to the tournament/strategy code — it reads candles by `(pair, timeframe)` and simply gets more 1h/1D rows.
- The actual edge re-validation (#2) is a follow-up that consumes this data.

## Honest caveat

Coinbase's true 1h/1D retention is unknown until the fetch runs — could be 1 year or several. The fetch-until-empty design adapts to whatever is available; the validation payoff depends on how much that turns out to be.
