---
phase: 32-perp-analytics-and-cli-report
plan: "02"
subsystem: cli
tags: [cli, analytics, perp, report, decimal]

# Dependency graph
requires:
  - phase: 32-01
    provides: PerpStateStore.listClosedTrades() and PerpTradeRecord type
provides:
  - "--type perp branch in npm run report CLI with directional win rates, avg leverage, net funding cost, and net P&L"
affects: [33-live-perp-engine]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "perp CLI branch follows same else-if chain pattern as spot/paper/live branches in report.ts"
    - "early return from perp branch prevents any spot computePerformanceReport() call — zero blending possible"
    - "perpStore.close() always in finally — safe resource cleanup regardless of error path"

key-files:
  created: []
  modified:
    - src/cli/report.ts

key-decisions:
  - "No blended total metric — perp P&L and spot P&L are strictly separate sections with mandatory early return"
  - "Zero trades emits out.warn and returns (exit 0) — consistent with how spot handles empty sessions"
  - "d()/ZERO from core/decimal.ts used for all aggregate math — avoids float imprecision in win-rate and P&L sums"

patterns-established:
  - "Perp CLI branch: new perpStore, try/finally close(), early return before spot code"

# Metrics
duration: 10min
completed: 2026-03-10
---

# Phase 32 Plan 02: Perp Analytics CLI Report Summary

**--type perp branch added to npm run report: reads listClosedTrades(), prints directional win rates, avg leverage, net funding cost, and net P&L with no blended spot metrics**

## Performance

- **Duration:** ~10 min
- **Started:** 2026-03-09T20:20:00Z
- **Completed:** 2026-03-10T04:11:53Z
- **Tasks:** 2 (1 auto + 1 checkpoint:human-verify)
- **Files modified:** 1

## Accomplishments
- Extended `src/cli/report.ts` with a `--type perp` else-if branch that reads all closed perp trades via `PerpStateStore.listClosedTrades()`
- Computes and prints: total trade count, long win rate, short win rate, avg leverage, net funding cost, net P&L — all using `d()` Decimal arithmetic
- Zero trades case emits `out.warn('No perp trades found.')` and exits cleanly (exit 0)
- ANALYTICS-03 compliance: early return before `computePerformanceReport()` guarantees spot metrics never appear in the perp path
- Human verification checkpoint passed — user confirmed correct output for both empty and populated perp_trades cases

## Task Commits

Each task was committed atomically:

1. **Task 1: Add --type perp branch to report.ts** - `081ef99` (feat)
2. **Task 2: Verify perp report CLI output** - checkpoint:human-verify — user approved

**Plan metadata:** (docs commit — this summary)

## Files Created/Modified
- `src/cli/report.ts` — Added `PerpStateStore` and `d()/ZERO` imports; extended `--type` option description to include `perp`; added perp analytics branch with `try/finally perpStore.close()`

## Decisions Made
- No blended total metric — the early return pattern is the enforcement mechanism, not a conditional check
- `d()/ZERO` used consistently for all aggregate math to match precision guarantees established in 32-01
- `out.warn` for zero-trades case matches the user-visible warning pattern used elsewhere in the CLI

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Phase 32 complete. Both plans (perpTrades table + CLI report) are done.
- Phase 33 (live perp engine) can now use `listClosedTrades()` for post-session reporting without any additional plumbing.
- `npm run report -- --type perp` is ready for use after any paper or live perp session.

---
*Phase: 32-perp-analytics-and-cli-report*
*Completed: 2026-03-10*
