---
phase: 27-perp-position-execution
plan: 01
subsystem: trading
tags: [perp, intx, liquidation, position-manager, sqlite, drizzle, decimal.js]

requires:
  - phase: 26-intx-api-client
    provides: IntxClient REST wrapper with placeOrder/cancelOrder stubs, WebSocket markPrice feed

provides:
  - PerpPositionManager: open/close/emergency-close lifecycle with pre-entry liquidation logging
  - PerpStateStore: SQLite CRUD for perp_sessions and perp_orders tables
  - calcLiquidationPrice / calcLiquidationDistance pure math functions
  - perp_sessions and perp_orders DB tables via initializeSchema
  - PerpSession, PerpOrder, PerpDirection, PerpPositionManagerEvents types
  - IntxClient.placeOrder and cancelOrder real implementations (stubs replaced)

affects:
  - 27-02
  - 28-perp-risk-management

tech-stack:
  added: []
  patterns:
    - "persistOrder before placeOrder: order persisted to DB before every API call for idempotency"
    - "liquidation price computed and logged before every openPosition() API call"
    - "bound listener stored as instance field to allow clean removal in stop()"
    - "_emergencyCloseInProgress flag reset in finally block to allow future emergency closes"
    - "PerpStateStore mirrors LiveStateStore: createDatabase + initializeSchema in constructor"

key-files:
  created:
    - src/perp/liquidation-calc.ts
    - src/perp/perp-state-store.ts
    - src/perp/position-manager.ts
    - src/perp/__tests__/liquidation-calc.test.ts
    - src/perp/__tests__/position-manager.test.ts
  modified:
    - src/perp/types.ts
    - src/perp/config.ts
    - src/perp/intx-client.ts
    - src/perp/index.ts
    - src/data/storage/schema.ts
    - src/data/storage/db.ts

key-decisions:
  - "IOC MARKET orders only for entry and exit — no partial fills to track, simplifies state"
  - "closePosition() purpose field uses 'EMERGENCY_CLOSE' when reason='EMERGENCY_CLOSE', 'EXIT' otherwise"
  - "PerpStateStore.createSession() accepts fully-constructed PerpSession — store writes as-is, no ID/timestamp generation"
  - "cancelOrder uses restClient.cancelOrder({ id, portfolio }) — INTX single-cancel API not CancelINTXOrdersRequest (bulk)"

patterns-established:
  - "Perp order lifecycle: build PerpOrder → persistOrder → API call → update PerpOrder → persistOrder again"
  - "Liquidation distance monitoring via markPrice EventEmitter events from IntxClient"
  - "Emergency close guard: _emergencyCloseInProgress flag prevents double-trigger, finally block resets it"

duration: 10min
completed: 2026-03-09
---

# Phase 27 Plan 01: Perp Position Execution Foundation Summary

**PerpPositionManager with IOC market open/close/emergency-close, isolated-margin liquidation math, SQLite perp_sessions/perp_orders tables, and IntxClient placeOrder/cancelOrder replacing Phase-26 stubs**

## Performance

- **Duration:** ~10 min
- **Started:** 2026-03-09T15:50:59Z
- **Completed:** 2026-03-09T15:57:14Z
- **Tasks:** 2
- **Files modified:** 11

## Accomplishments

- Replaced placeOrder/cancelOrder stubs in IntxClient with real INTX REST implementations using SubmitINTXOrderRequest IOC market orders
- Built PerpPositionManager with open/close/emergency-close lifecycle: liquidation price logged before entry, persistOrder before every API call, _emergencyCloseInProgress flag reset in finally
- Created PerpStateStore mirroring LiveStateStore pattern with perp_sessions and perp_orders CRUD via Drizzle ORM
- Added perpSessions/perpOrders Drizzle table definitions and SQL CREATE TABLE blocks to initializeSchema
- 27 tests passing across 3 perp test files (6 liquidation-calc, 8 position-manager, 13 intx-client)

## Task Commits

Each task was committed atomically:

1. **Task 1: Types, config extension, DB schema, and liquidation-calc** - `6445c08` (feat)
2. **Task 2: IntxClient placeOrder/cancelOrder and PerpPositionManager** - `b8824aa` (feat)

**Plan metadata:** (docs commit follows)

## Files Created/Modified

- `src/perp/liquidation-calc.ts` - Pure functions: calcLiquidationPrice and calcLiquidationDistance (isolated-margin formula)
- `src/perp/perp-state-store.ts` - SQLite CRUD for perp_sessions and perp_orders via Drizzle ORM
- `src/perp/position-manager.ts` - PerpPositionManager: open/close/emergencyClose lifecycle, markPrice monitoring
- `src/perp/__tests__/liquidation-calc.test.ts` - 6 unit tests for liq price and distance calculations
- `src/perp/__tests__/position-manager.test.ts` - 8 tests for open/close/emergency/guards/distance/stop/flag-reset
- `src/perp/types.ts` - Added PerpSession, PerpOrder, PerpDirection, PerpSessionStatus, PerpPositionManagerEvents; closeOnly on PlaceOrderParams
- `src/perp/config.ts` - Added liquidationSafetyThresholdPct (default 5.0) and defaultMaintenanceMarginRate (default '0.0333')
- `src/perp/intx-client.ts` - Replaced placeOrder/cancelOrder stubs with real implementations
- `src/perp/index.ts` - Extended barrel export with new perp symbols
- `src/data/storage/schema.ts` - Added perpSessions and perpOrders Drizzle table definitions
- `src/data/storage/db.ts` - Added perp_sessions and perp_orders SQL to initializeSchema

## Decisions Made

- IOC MARKET orders only for both entry and exit — simplifies fill state tracking (no partial fills)
- `cancelOrder` uses `restClient.cancelOrder({ id, portfolio })` — the single-order cancel API, not the bulk `CancelINTXOrdersRequest`
- `PerpStateStore.createSession()` accepts a fully-constructed PerpSession; the caller (PerpPositionManager) sets all fields including id and openedAt
- `closePosition()` sets purpose='EMERGENCY_CLOSE' when `reason === 'EMERGENCY_CLOSE'`, 'EXIT' otherwise — distinguishes emergency exits in the audit trail

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- PerpPositionManager.openPosition() and closePosition() fully functional with real INTX order placement
- perp_sessions and perp_orders tables created on first run via initializeSchema
- Ready for Phase 27-02: position monitoring, PnL tracking, and live integration
- No blockers.

---
*Phase: 27-perp-position-execution*
*Completed: 2026-03-09*

## Self-Check: PASSED

All key files present. Both task commits verified (6445c08, b8824aa). 27 tests passing.
