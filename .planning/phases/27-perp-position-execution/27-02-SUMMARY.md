---
phase: 27-perp-position-execution
plan: 02
subsystem: trading
tags: [perp, paper-mode, crash-recovery, intx, sqlite, liquidation, cli]

requires:
  - phase: 27-perp-position-execution
    plan: 01
    provides: PerpPositionManager, PerpStateStore, liquidation-calc, IntxClient placeOrder/cancelOrder

provides:
  - PaperPerpEngine: mark-price-driven perp simulation with zero REST order calls
  - PerpPositionManager.recoverFromRestart(): reconcile DB sessions with INTX on restart
  - PerpStateStore.getAllOpenSessions(): query all status='open' sessions
  - perp:paper CLI: standalone passive paper mode monitoring mark-price stream

affects:
  - 28-perp-risk-management

tech-stack:
  added: []
  patterns:
    - "PaperPerpEngine subscribes to markPrice events only — zero placeOrder/cancelOrder calls in any paper path"
    - "onSignal callback for injected signal logic; absent = passive monitoring mode"
    - "createSession receives spread copy (snapshot) to prevent mutation aliasing after close"
    - "recoverFromRestart: PENDING orders marked FAILED before any session restore decision (conservative)"
    - "getAllOpenSessions: used by recovery to iterate all open sessions in one query"

key-files:
  created:
    - src/perp/paper-perp-engine.ts
    - src/perp/__tests__/paper-perp-engine.test.ts
    - src/cli/perp-paper.ts
  modified:
    - src/perp/position-manager.ts
    - src/perp/perp-state-store.ts
    - src/perp/__tests__/position-manager.test.ts
    - src/perp/index.ts
    - package.json

key-decisions:
  - "PaperPerpEngine does NOT reuse PerpPositionManager — separate class guarantees zero REST calls in paper path"
  - "createSession receives a spread copy not the live reference — prevents status mutation aliasing in tests and production"
  - "recoverFromRestart marks PENDING orders FAILED before restoring session — conservative prevents double-entry"
  - "getAllOpenSessions added to PerpStateStore (not in original plan) — required by recovery to iterate all instruments"

duration: 5min
completed: 2026-03-09
---

# Phase 27 Plan 02: Paper Perp Mode and Crash Recovery Summary

**PaperPerpEngine mark-price simulator with zero REST calls, PerpPositionManager.recoverFromRestart() reconciling INTX positions on restart, and perp:paper CLI for passive monitoring**

## Performance

- **Duration:** ~5 min
- **Started:** 2026-03-09T16:00:18Z
- **Completed:** 2026-03-09T16:05:45Z
- **Tasks:** 2
- **Files modified:** 8

## Accomplishments

- Built PaperPerpEngine with openPaperPosition/closePaperPosition lifecycle driven entirely by markPrice events — placeOrder/cancelOrder are never called in any paper code path
- Emergency close guard (_emergencyCloseInProgress flag, finally block reset) mirrors PerpPositionManager pattern
- Passive monitoring mode (no onSignal) and signal-injected mode (onSignal callback) supported
- Added recoverFromRestart() to PerpPositionManager: queries all open DB sessions, reconciles with INTX via getAccountState(), marks externally-closed sessions as closed, marks PENDING orders FAILED
- Added getAllOpenSessions() to PerpStateStore to support recovery across all instruments in one query
- perp:paper CLI starts paper engine against mark-price stream with SIGINT/SIGTERM graceful shutdown
- 10 new tests: 6 paper-perp-engine tests + 4 recovery tests; full suite 675 tests across 57 files

## Task Commits

Each task was committed atomically:

1. **Task 1: PaperPerpEngine — mark-price simulation with state persistence** - `8c1529c` (feat)
2. **Task 2: recoverFromRestart(), getAllOpenSessions(), and perp:paper CLI** - `e231a40` (feat)

**Plan metadata:** (docs commit follows)

## Files Created/Modified

- `src/perp/paper-perp-engine.ts` — PaperPerpEngine class: markPrice-only simulation, openPaperPosition/closePaperPosition, emergency close, onSignal callback
- `src/perp/__tests__/paper-perp-engine.test.ts` — 6 tests: round-trip, emergency close, stale ignored, double-open guard, short PnL, no placeOrder calls
- `src/cli/perp-paper.ts` — Standalone CLI: loads config, starts IntxClient + PaperPerpEngine, passive monitoring mode, SIGINT/SIGTERM graceful shutdown
- `src/perp/position-manager.ts` — Added recoverFromRestart() and ZERO import; PENDING orders → FAILED before session restore
- `src/perp/perp-state-store.ts` — Added getAllOpenSessions() method for recovery
- `src/perp/__tests__/position-manager.test.ts` — 4 recovery tests appended: restored, external_close, PENDING→FAILED, no sessions
- `src/perp/index.ts` — Added PaperPerpEngine and PaperPerpEngineOptions to barrel export
- `package.json` — Added perp:paper npm script

## Decisions Made

- PaperPerpEngine is a separate class from PerpPositionManager — guarantees zero REST calls in paper path without risk of future placeOrder accidental call
- `createSession` receives a spread copy (`{ ...session }`) — prevents mutation aliasing when `session.status` is later changed in `closePaperPosition`
- `recoverFromRestart` marks PENDING orders FAILED conservatively — prevents double-entry even if exchange received the original order
- `getAllOpenSessions` added to PerpStateStore (deviation) — required to iterate all open sessions across instruments without knowing instrument names upfront

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical Functionality] Added getAllOpenSessions() to PerpStateStore**
- **Found during:** Task 2 (implementing recoverFromRestart)
- **Issue:** recoverFromRestart needs to find all open sessions without knowing instrument names; existing `getOpenSession(instrument)` requires an instrument argument
- **Fix:** Added `getAllOpenSessions(): PerpSession[]` querying `WHERE status = 'open'`
- **Files modified:** src/perp/perp-state-store.ts
- **Commit:** e231a40

**2. [Rule 1 - Bug] createSession receives spread copy to prevent mutation aliasing**
- **Found during:** Task 1 test execution (test 1 failed: `status: 'closed'` instead of `'open'`)
- **Issue:** `createSession(session)` stores a reference; when `closePaperPosition` later sets `session.status = 'closed'`, the mock call argument also shows closed
- **Fix:** Changed to `createSession({ ...session })` so the stored snapshot is immutable
- **Files modified:** src/perp/paper-perp-engine.ts
- **Commit:** 8c1529c (fix applied before commit)

## Issues Encountered

None beyond auto-fixed deviations above.

## User Setup Required

None — perp:paper CLI requires `INTX_ENABLED=true` and valid INTX credentials at runtime, same as perp:status.

## Next Phase Readiness

- PaperPerpEngine fully functional for testnet paper trading sessions
- recoverFromRestart() handles crash/restart scenarios before real funds are at risk
- perp:paper CLI entry point ready for testnet validation
- Ready for Phase 28: perp risk management (position sizing, max drawdown, daily loss limits)
- No blockers.

---
*Phase: 27-perp-position-execution*
*Completed: 2026-03-09*

## Self-Check: PASSED

All key files present. Both task commits verified (8c1529c, e231a40). 675 tests passing across 57 test files.
