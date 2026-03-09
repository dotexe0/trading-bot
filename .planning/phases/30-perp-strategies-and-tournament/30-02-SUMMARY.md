---
phase: 30-perp-strategies-and-tournament
plan: "02"
subsystem: perp
tags: [mean-reversion, z-score, funding-rate, strategy, tdd, vitest]

# Dependency graph
requires:
  - phase: 30-perp-strategies-and-tournament
    provides: PerpMomentumStrategy with fundingRateProvider pattern (30-01)
  - phase: strategies
    provides: IStrategy interface, Signal type, ZScoreMeanReversionStrategy pattern

provides:
  - PerpMeanReversionStrategy implementing IStrategy
  - Z-score mean reversion with funding rate adjustment for perp futures
  - 27 vitest tests covering all behaviors including causality and determinism

affects: [30-03, tournament-runner, strategy-registry]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "PerpMeanReversionStrategy: no regime filter, fundingRateProvider callback, _applyFundingAdjustment private method"
    - "Funding adjustment formula: adjustment = Math.min(|rate|/threshold, 0.5); adjustedConfidence = rawConfidence * (1 - adjustment)"
    - "Clamped confidence: Math.round(Math.min(Math.max(value, 0.01), 1) * 100) / 100"

key-files:
  created:
    - src/perp/strategies/perp-mean-reversion.ts
    - src/perp/strategies/__tests__/perp-mean-reversion.test.ts
  modified: []

key-decisions:
  - "No regime filter on PerpMeanReversionStrategy — perp strategies activate in TRENDING, RANGING, VOLATILE (consistent with PerpMomentumStrategy)"
  - "Funding adjustment formula identical to PerpMomentumStrategy — >= for threshold comparison on long, <= -threshold for short"
  - "fundingRateProvider returns null in tournament/paper mode — no adjustment applied, enables zero-dependency testing"
  - "minCandles = period + 1 (same as ZScoreMeanReversionStrategy spot counterpart)"

patterns-established:
  - "Perp strategy pattern: no regime filter + fundingRateProvider callback + _applyFundingAdjustment"

# Metrics
duration: 3min
completed: 2026-03-09
---

# Phase 30 Plan 02: Perp Mean Reversion Strategy Summary

**Z-score mean reversion strategy for perp futures with funding rate confidence adjustment, no regime filter, 27 tests passing (TDD RED→GREEN)**

## Performance

- **Duration:** ~3 min
- **Started:** 2026-03-09T23:26:54Z
- **Completed:** 2026-03-09T23:29:13Z
- **Tasks:** 2 (TDD RED + GREEN; no REFACTOR needed)
- **Files modified:** 2

## Accomplishments

- PerpMeanReversionStrategy implementing IStrategy — name='perp-mean-reversion', minCandles=period+1
- Z-score computation via IndicatorEngine SMA + SD; signals on |zScore| > threshold
- No regime filter — signals generated in TRENDING, RANGING, VOLATILE market conditions
- Funding rate adjustment: long penalized when rate >= fundingThreshold, short penalized when rate <= -fundingThreshold; max 50% reduction
- 27 vitest tests covering signal generation, no-regime-filter, funding adjustment (null/positive/negative rates), causality, determinism, edge cases, signal fields

## Task Commits

Each TDD phase committed atomically:

1. **TDD RED: Failing tests** - `bbf3068` (test)
2. **TDD GREEN: Implementation** - `8e01d90` (feat)

## Files Created/Modified

- `src/perp/strategies/perp-mean-reversion.ts` — PerpMeanReversionStrategy class with _applyFundingAdjustment
- `src/perp/strategies/__tests__/perp-mean-reversion.test.ts` — 27 tests (constructor, signal gen, funding adj, causality, edge cases, signal fields)

## Decisions Made

- No regime filter — consistent with PerpMomentumStrategy; perp strategies need signals in any market condition for leveraged execution
- Funding adjustment formula identical to PerpMomentumStrategy — uses `>=` for threshold comparison (rate at threshold triggers 50% max reduction, consistent with 30-01 decision)
- fundingRateProvider returns null → no adjustment (tournament-safe pattern)

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Both perp strategies complete (PerpMomentumStrategy + PerpMeanReversionStrategy)
- Tournament runner (30-03) can import both strategies
- fundingRateProvider pattern established — tournament runner injects null provider

---
*Phase: 30-perp-strategies-and-tournament*
*Completed: 2026-03-09*
