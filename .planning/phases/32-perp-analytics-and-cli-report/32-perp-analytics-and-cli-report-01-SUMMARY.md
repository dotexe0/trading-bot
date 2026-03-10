---
phase: 32-perp-analytics-and-cli-report
plan: 01
subsystem: database
tags: [sqlite, drizzle-orm, perp-trading, tdd]

# Dependency graph
requires:
  - phase: 27-perp-position-manager
    provides: PerpStateStore, PerpSession, closePosition(), closePaperPosition()
  - phase: 31-funding-rate-tracking
    provides: cumulativeFundingCost field on session at close time
provides:
  - perpTrades SQLite table with 13 columns
  - PerpTradeRecord interface exported from perp-state-store.ts
  - PerpStateStore.recordTrade() insert method
  - PerpStateStore.listClosedTrades() select method
  - Both close paths (live + paper) write trade records on every position close
affects: 32-02 (CLI report reads listClosedTrades())

# Tech tracking
tech-stack:
  added: []
  patterns:
    - TDD red-green-refactor for store methods (rowToTrade follows rowToSession/rowToOrder pattern)
    - Per-task commit discipline: test commit then feat commit

key-files:
  created:
    - src/perp/__tests__/perp-state-store-trades.test.ts
  modified:
    - src/data/storage/schema.ts
    - src/data/storage/db.ts
    - src/perp/perp-state-store.ts
    - src/perp/position-manager.ts
    - src/perp/paper-perp-engine.ts
    - src/perp/__tests__/paper-perp-engine.test.ts
    - src/perp/__tests__/position-manager.test.ts

key-decisions:
  - "perpTrades table uses snake_case columns per project convention; Drizzle camelCase mapping via column defs"
  - "cumulativeFundingCost stored as NOT NULL TEXT; caller passes '0.00000000' when session had no funding events"
  - "realizedPnl in closePosition() computed as pricePnl + fundingAdj (same formula as paper engine)"
  - "rowToTrade() private mapper follows existing rowToSession/rowToOrder pattern for consistency"
  - "mock PerpStateStore in existing tests updated to include recordTrade: vi.fn() (Rule 2 auto-fix)"

patterns-established:
  - "Trade history pattern: updateSession() then recordTrade() on every close path"
  - "rowTo*() mapper pattern for all perp store tables"

# Metrics
duration: 4min
completed: 2026-03-10
---

# Phase 32 Plan 01: Perp Trades Table and Trade History Summary

**perpTrades SQLite table with Drizzle schema, PerpStateStore.recordTrade()/listClosedTrades(), wired into both live closePosition() and paper closePaperPosition() close paths**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-10T03:22:29Z
- **Completed:** 2026-03-10T03:26:00Z
- **Tasks:** 1 TDD task (RED + GREEN phases)
- **Files modified:** 7

## Accomplishments

- Added `perpTrades` Drizzle table to `schema.ts` with 13 columns and session index
- Added `CREATE TABLE IF NOT EXISTS perp_trades` block to `initializeSchema()` in `db.ts`
- Exported `PerpTradeRecord` interface from `perp-state-store.ts`; added `recordTrade()` insert and `listClosedTrades()` select methods with `rowToTrade()` private mapper
- Wired `stateStore.recordTrade()` into `PerpPositionManager.closePosition()` after `updateSession()` with computed realizedPnl
- Wired `stateStore.recordTrade()` into `PaperPerpEngine.closePaperPosition()` after `updateSession()` using the existing `realizedPnl` variable
- All 761 tests passing (61 files), zero regressions

## Task Commits

1. **RED phase: failing tests** - `c5e0cf4` (test)
2. **GREEN phase: full implementation** - `da71b1c` (feat)

## Files Created/Modified

- `src/perp/__tests__/perp-state-store-trades.test.ts` - 8 tests: round-trip, null guard, multi-row, closeReason, empty store, live close integration, paper close integration
- `src/data/storage/schema.ts` - Added `perpTrades` sqliteTable export
- `src/data/storage/db.ts` - Appended `CREATE TABLE IF NOT EXISTS perp_trades` + index to `initializeSchema()`
- `src/perp/perp-state-store.ts` - Added `PerpTradeRecord` interface, `recordTrade()`, `listClosedTrades()`, `rowToTrade()`
- `src/perp/position-manager.ts` - Added `recordTrade()` call in `closePosition()` with realizedPnl computation
- `src/perp/paper-perp-engine.ts` - Added `recordTrade()` call in `closePaperPosition()`
- `src/perp/__tests__/paper-perp-engine.test.ts` - Added `recordTrade: vi.fn()` to mock store
- `src/perp/__tests__/position-manager.test.ts` - Added `recordTrade: vi.fn()` to mock store

## Decisions Made

- `cumulativeFundingCost` stored as NOT NULL TEXT; callers pass `'0.00000000'` when no funding events fired — avoids null handling in analytics queries
- `realizedPnl` in `closePosition()` computed as `pricePnl + fundingAdj` using `d()` Decimal arithmetic, matching the paper engine formula
- `rowToTrade()` private mapper follows the `rowToSession()` / `rowToOrder()` pattern already established in the class

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Added `recordTrade: vi.fn()` to mock PerpStateStore in existing tests**
- **Found during:** GREEN phase (full suite run)
- **Issue:** `paper-perp-engine.test.ts` and `position-manager.test.ts` use handcrafted mock objects for `PerpStateStore`. Adding `recordTrade()` to production code caused `TypeError: this.stateStore.recordTrade is not a function` in both test files (7 test failures)
- **Fix:** Added `recordTrade: vi.fn()` to the `makeStateStore()` helper in both test files
- **Files modified:** `src/perp/__tests__/paper-perp-engine.test.ts`, `src/perp/__tests__/position-manager.test.ts`
- **Verification:** Full suite runs 761/761 passing
- **Committed in:** `da71b1c` (GREEN phase commit)

---

**Total deviations:** 1 auto-fixed (Rule 2 - missing mock method)
**Impact on plan:** Required for test correctness. No scope creep.

## Issues Encountered

None - plan executed smoothly following TDD flow.

## Next Phase Readiness

- `listClosedTrades()` is ready for Phase 32-02 to build the CLI analytics report
- Every future `closePosition()` or `closePaperPosition()` call automatically persists a trade record
- No blockers

---
*Phase: 32-perp-analytics-and-cli-report*
*Completed: 2026-03-10*

## Self-Check: PASSED

- FOUND: src/perp/__tests__/perp-state-store-trades.test.ts
- FOUND: src/data/storage/schema.ts (perpTrades export)
- FOUND: src/perp/perp-state-store.ts (recordTrade + listClosedTrades)
- FOUND: .planning/phases/32-perp-analytics-and-cli-report/32-perp-analytics-and-cli-report-01-SUMMARY.md
- FOUND commit: c5e0cf4 (test RED phase)
- FOUND commit: da71b1c (feat GREEN phase)
