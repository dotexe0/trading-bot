# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-03-14)

**Core value:** The bot must reliably execute trades with correct position sizing, risk limits, and stop-losses -- never losing more than configured risk parameters allow.
**Current focus:** v2.0 Perp First-Class — Phase 40: Regime-Aware Perp Pipeline

## Current Position

Phase: 40 of 41 (Regime-Aware Perp Pipeline)
Plan: 1 of TBD
Status: In Progress
Last activity: 2026-03-15 — 40-01 complete (executeStrategySwitch regime param in PaperPerpEngine + PerpPositionManager; regime-prefixed log format; 835 tests passing)

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

### Open Issues / Tech Debt

- fast-technical-indicators createRequire workaround (inherited, low priority)
- `indexPrice` FCM field distinctness from `markPrice` confirmed equal (strategies return [] in practice, wired for future FCM fix)
- `IntxFundingRateEvent.isFinal` reliable population in practice unconfirmed — verify in 8h paper mode before finalizing Phase 41 chart

### Blockers

None.

## Session Continuity

Last session: 2026-03-15
Stopped at: Completed 40-01-PLAN.md. executeStrategySwitch regime param in PaperPerpEngine + PerpPositionManager; regime-prefixed log format; 835 tests passing.
