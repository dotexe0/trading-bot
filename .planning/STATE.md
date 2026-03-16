# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-03-14)

**Core value:** The bot must reliably execute trades with correct position sizing, risk limits, and stop-losses -- never losing more than configured risk parameters allow.
**Current focus:** v2.0 Perp First-Class — Phase 41: Dashboard Time-Series Panels

## Current Position

Phase: 41 of 41 (Dashboard Time-Series Panels)
Plan: 3 of 3 (+ bug fixes)
Status: Complete
Last activity: 2026-03-15 — Phase 41 bug fixes: unrealizedPnl in PaperPerpEngine fundingUpdate emit; IntxClient emits fundingRate on any futures_balance_summary message

Progress: [██████████████████░░░░░░░░░░░░] ~58% (39/~63 total plans est.)

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
- [38-02]: FEES-02 test (engine.test.ts): higher feeTierTaker produces higher totalFees confirmed. FEES-03 tests (metrics.test.ts): fundingCost passthrough, independence from totalFees, Decimal type all verified. All 7 makeMetrics/makeResult helpers now include fundingCost: ZERO.
- [39-01]: FEES-04 enforced: PerpRiskGate Check 4 FEE_DRAG_EXCESSIVE uses fixed FeeConfig constant (not swept param). lte() semantics: equal-to-fee rejected. feeConfig optional in PerpRiskGateOptions → DEFAULT_FEE_CONFIG fallback. expectedGain computed from tpTargetPct at both callsites.
- [39-02]: FundingRateArbitrageStrategy: tournamentMode=true always returns []; regime gate RANGING/VOLATILE only; division guard for indexPrice=0; returns [] when indexPrice===markPrice (current FCM reality). BasisTradeStrategy: no regime filter (basis arb is regime-agnostic); SD=0 guard handles constant basis (FCM reality). markPriceProvider/basisProvider/tournamentMode excluded from Zod schemas (not serializable) — matches perp strategy pattern.
- [39-03]: createPerpRegistry() now has 4 strategies (perp-momentum, perp-mean-reversion, funding-rate-arb, basis-trade); createLivePerpRegistry() adds optional markPriceProvider second param (existing callers unchanged); tournament:perp exits 0 with all 4 strategies; scripts/verify-index-price.ts documents FCM indexPrice===markPrice static analysis finding.
- [40-01]: executeStrategySwitch regime? param optional (backward-compat); pendingSwitch type carries regime? so deferred switches preserve triggering regime; log format 'regime TRENDING: switching to PerpMomentumStrategy'; PerpPositionManager logs have no [PAPER] prefix per convention.
- [40-03]: Structural test scans 15 lines after constructor call instead of exact line — tolerates minor formatting changes.
- [Phase 40]: PERP-SW-02/PM-SW-02: Open position manually before regime candle to test deferred switch — avoids async timing issue with evaluate()-triggered openPaperPosition
- [41-01]: DASH-01/02 ring buffers sized 500 bars (funding) and 1440 pts (P&L — 24h at 1/min). Dual-listener on fundingUpdate: PERP_EVENT_MAP handles perpFundingUpdate; separate listener handles histogram + P&L. buildSnapshot() extended with optional ring buffer params (not closures). unrealizedPnl? optional in fundingUpdate type (no-session branch omits). Monotonic second guard on P&L broadcast prevents duplicate chart timestamps.
- [Phase 41]: FundingHistoryChart props use HistogramData[] directly (not PerpFundingBarPayload[]) — App.tsx converts at call site
- [Phase 41]: PnlCurveChart BaselineSeries baseValue: { type: 'price', price: 0 } — type discriminant required by BaseValuePrice
- [Phase 41]: LeverageHistoryChart is client-side only — no ring buffer hydration per DASH-03; chart shows empty on reconnect
- [41-03]: P&L ring buffer cleared on perpExposureUpdate utilizationPct === '0.00' (position close) — prevents cross-position P&L accumulation; also triggers setPnlData([])
- [41-03]: Monotonic timestamp guard for AreaSeries: nowSec > lastLeverageSecondRef ? nowSec : lastLeverageSecondRef + 1 — prevents duplicate chart timestamps
- [41-03]: App.tsx chart data flows two ways — snapshot/initial via state prop (triggers setData), real-time via ref.current?.addPoint() (zero re-renders)
- [41-bugfix]: PaperPerpEngine._onFundingRate() session-open branch missed unrealizedPnl in fundingUpdate emit — captured to local var, passed to both stateStore and emit. Server P&L chart was receiving undefined → 0.
- [41-bugfix]: IntxClient guard `if (summary?.funding_hold)` skipped null/zero funding_hold → no fundingRate events in paper mode without real FCM position → histogram showed "awaiting data" forever. Fixed to emit on any non-null futures_balance_summary message.

### Open Issues / Tech Debt

- fast-technical-indicators createRequire workaround (inherited, low priority)
- `indexPrice` FCM field distinctness from `markPrice` confirmed equal (strategies return [] in practice, wired for future FCM fix)

### Blockers

None.

## Session Continuity

Last session: 2026-03-15
Stopped at: Phase 41 complete including two runtime bug fixes found during human UAT. 845 tests passing (67 files). Ready for /gsd:complete-milestone.
