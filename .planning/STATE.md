# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-03-14)

**Core value:** The bot must reliably execute trades with correct position sizing, risk limits, and stop-losses -- never losing more than configured risk parameters allow.
**Current focus:** v2.0 Perp First-Class — Phase 38: Fee-Aware Backtest

## Current Position

Phase: 38 of 41 (Fee-Aware Backtest)
Plan: 1 of TBD
Status: In Progress
Last activity: 2026-03-15 — 38-01 complete (fundingCost in BacktestResult/PerformanceMetrics, ZERO-wired in engine+walk-forward, FCM fee fix in perp-tournament-runner, TournamentStore serialization roundtrip; 799 tests passing)

Progress: [██████████████████░░░░░░░░░░░░] ~57% (37/~63 total plans est.)

## Performance Metrics

**v1.5 Totals:**
- 4 plans completed across 2 phases
- 11 files changed, +446/−113 lines
- 789 tests passing (64 test files)
- Timeline: 1 day (2026-03-14)

## Accumulated Context

### Decisions

All v1.0–v1.5 decisions logged in PROJECT.md Key Decisions table.

**v2.0 pre-execution notes (from research):**
- INFRA-01: DONE (36-01) — Removed `if (!this.currentPosition) return` guard from `_onFundingRate` in paper-perp-engine.ts
- INFRA-02: DONE (36-02) — IntxClient.getLastFundingRate() wired to fundingRateProvider in start.ts (both paper + live branches)
- INFRA-03: DONE (36-02) — perpLiveFeed.start() now routes both BTC-USD and ETH-USD
- FEES-01: DONE (37-01) — IntxClient.fetchFeeConfig() wraps getTransactionSummary({product_type:'FUTURE',product_venue:'FCM'}); FeeConfig interface and DEFAULT_FEE_CONFIG in src/perp/fee-config.ts
- FEES-01-TESTS: DONE (37-02) — 5 TDD tests for fetchFeeConfig() in intx-client.test.ts; mockGetTransactionSummary wired via vi.hoisted()
- FEES-04: Fee threshold is a FIXED CONSTANT from FeeConfig, NOT a swept parameter (anti-overfitting, Pitfall 2)
- FEES-02/03: `fundingCost` and `totalFees` MUST be separate fields — never merge (fee double-counting is Pitfall 1)
- FEES-04: Fee threshold is a FIXED CONSTANT from FeeConfig, NOT a swept parameter (anti-overfitting, Pitfall 2)
- STRAT-01/02: Run `scripts/verify-index-price.ts` before writing any strategy logic — if indexPrice === markPrice, both strategies return null signals
- DASH-01: `isFinal=true` FCM funding events only; step interpolation; HistogramSeries
- DASH-02: Server-side 1/minute max downsampling; BaselineSeries; ring buffer 1440 pts
- DASH-03: AreaSeries on existing `perpExposureUpdate` events; explicit zero-point broadcast on position close
- [Phase 37]: feeConfig optional on PerpTournamentOptions, feeTierTaker/Maker wired to parseTournamentConfig — backward-compatible injection pattern for FCM fee rates
- [38-01]: fundingCost: Decimal added to BacktestResult and PerformanceMetrics; always ZERO in backtest/walk-forward; TournamentStore serializes/deserializes with ?? '0' backward-compat fallback; perp tournament now uses FCM_FALLBACK_TAKER_RATE (0.0003) not spot 0.0075

### Open Issues / Tech Debt

- fast-technical-indicators createRequire workaround (inherited, low priority)
- `indexPrice` FCM field distinctness from `markPrice` unconfirmed — must verify via script before Phase 39 strategy logic
- `IntxFundingRateEvent.isFinal` reliable population in practice unconfirmed — verify in 8h paper mode before finalizing Phase 41 chart

### Blockers

None.

## Session Continuity

Last session: 2026-03-15
Stopped at: Phase 38 Plan 01 complete. fundingCost interfaces wired. FCM fee fix applied. 799 tests passing. Ready for Phase 38 Plan 02.
