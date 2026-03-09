---
phase: 28-post-only-limit-order-engine
plan: 01
subsystem: perp
tags: [fcm, post-only, limit-order, order-engine, websocket, sqlite, drizzle]

# Dependency graph
requires:
  - phase: 27-perp-position-execution
    provides: IntxClient, PerpStateStore, PerpPositionManager, PerpSession, PerpOrder types
provides:
  - PerpOrderEngine class with post-only limit entry loop (submitEntryOrder, cancelAllOpenOrders)
  - FcmOrderFillEvent type and orderFill event on IntxClient via user channel WebSocket
  - PerpOrderEngineEvents interface
  - fcmConfigSchema extended with order timing/sizing fields (repriceTimeoutMs, maxRepriceAttempts, entryOrderTimeoutMs, tpTargetPct, atrMultiplier, stopLimitSlippagePct)
  - perpOrders schema with limitPrice and stopPrice columns
  - getOpenOrdersBySession() on PerpStateStore
affects:
  - 28-02-PLAN.md (ratchet stop uses limitPrice/stopPrice from DB; reads PerpOrderEngine events)
  - 28-03-PLAN.md (full perp engine integration)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - post-only limit order with cancel-reprice loop (NON_RETRYABLE abort, mid-price retry)
    - DB-before-API idempotency for every order placement attempt
    - Fill detection via typed orderFill EventEmitter event (WebSocket user channel)
    - Migration guard pattern: pragma_table_info column count check before ALTER TABLE

key-files:
  created:
    - src/perp/order-engine.ts
  modified:
    - src/perp/config.ts
    - src/perp/types.ts
    - src/data/storage/schema.ts
    - src/data/storage/db.ts
    - src/perp/perp-state-store.ts
    - src/perp/intx-client.ts
    - src/perp/index.ts

key-decisions:
  - "PerpOrderEngine allocates sessionId upfront (crypto.randomUUID) before any order attempt — ensures session ID is consistent across reprice loops"
  - "NON_RETRYABLE_REASONS set: INSUFFICIENT_FUND, INVALID_SIZE, INVALID_PRICE, INVALID_PRODUCT — abort immediately without retrying"
  - "Fill detection uses repriceTimeoutMs (60s default) not entryOrderTimeoutMs — repriceTimeoutMs governs per-attempt fill wait, entryOrderTimeoutMs governs total loop"
  - "cancelOrders() public method added to IntxClient for batch cancel — cancelAllOpenOrders never accesses restClient directly"
  - "Migration guard uses pragma_table_info count instead of try/catch for limit_price/stop_price columns — more explicit than the existing tournaments pattern"

patterns-established:
  - "OrderError class with isRetryable flag for structured error handling in order loop"
  - "FcmOrderFillEvent matched by clientOrderId OR exchangeOrderId for robustness"

# Metrics
duration: 6min
completed: 2026-03-09
---

# Phase 28 Plan 01: Post-Only Limit Order Engine Foundation Summary

**Post-only limit entry loop via FCM WebSocket user channel: cancel-reprice with NON_RETRYABLE abort, DB-before-API idempotency, and typed orderFill event detection**

## Performance

- **Duration:** ~6 min
- **Started:** 2026-03-09T21:03:52Z
- **Completed:** 2026-03-09T21:09:28Z
- **Tasks:** 2
- **Files modified:** 9 (7 modified, 2 created including test files)

## Accomplishments
- Extended fcmConfigSchema with 6 new fields (repriceTimeoutMs, maxRepriceAttempts, entryOrderTimeoutMs, tpTargetPct, atrMultiplier, stopLimitSlippagePct)
- Added FcmOrderFillEvent, PerpOrderEngineEvents to types.ts; extended PerpOrder with limitPrice/stopPrice; added postOnly to PlaceOrderParams; extended IntxClientEvents with orderFill
- Added limit_price/stop_price columns to perpOrders schema with fresh-install CREATE TABLE and migrated-DB ALTER TABLE guard; getOpenOrdersBySession() added to PerpStateStore
- Added user channel subscription and orderFill event emission to IntxClient; cancelOrders() batch public method; post_only passes through from PlaceOrderParams
- Implemented PerpOrderEngine with submitEntryOrder() (post-only loop) and cancelAllOpenOrders() (uses public cancelOrders method, never restClient)

## Task Commits

Each task was committed atomically:

1. **Task 1: Extend config, types, schema, and state store** - `3db4803` (feat)
2. **Task 2: Add user channel subscription to IntxClient and implement PerpOrderEngine** - `f9a0b3d` (feat)

**Plan metadata:** (docs commit — see below)

## Files Created/Modified
- `src/perp/config.ts` - Added 6 new order timing/sizing fields to fcmConfigSchema
- `src/perp/types.ts` - Added FcmOrderFillEvent, PerpOrderEngineEvents, extended PerpOrder/PlaceOrderParams/IntxClientEvents
- `src/data/storage/schema.ts` - Added limitPrice/stopPrice to perpOrders table definition
- `src/data/storage/db.ts` - Added limit_price/stop_price to CREATE TABLE SQL; migration guard via pragma_table_info
- `src/perp/perp-state-store.ts` - Added getOpenOrdersBySession(); updated persistOrder() and rowToOrder() for limitPrice/stopPrice
- `src/perp/intx-client.ts` - User channel subscription, orderFill event, subscribeUserChannel(), cancelOrders(), post_only passthrough
- `src/perp/order-engine.ts` - NEW: PerpOrderEngine class with post-only entry loop and cancelAllOpenOrders
- `src/perp/index.ts` - Export PerpOrderEngine, FcmOrderFillEvent, PerpOrderEngineEvents
- `src/perp/__tests__/paper-perp-engine.test.ts` - Updated makeConfig() with new required fields
- `src/perp/__tests__/position-manager.test.ts` - Updated makeConfig() with new required fields

## Decisions Made
- PerpOrderEngine allocates sessionId upfront before any order attempt — consistent session ID across reprice loops
- NON_RETRYABLE_REASONS: INSUFFICIENT_FUND, INVALID_SIZE, INVALID_PRICE, INVALID_PRODUCT — abort immediately
- Fill detection uses repriceTimeoutMs (60s default) per-attempt, entryOrderTimeoutMs (300s) total loop timeout
- cancelOrders() public batch method on IntxClient; cancelAllOpenOrders never accesses restClient directly
- Migration guard uses pragma_table_info count for cleaner column existence check

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed TypeScript errors in existing perp tests after extending FcmConfig**
- **Found during:** Task 1 (Extend config, types, schema, and state store)
- **Issue:** Adding new required fields to fcmConfigSchema changed the FcmConfig TypeScript type. Existing test makeConfig() factory functions in paper-perp-engine.test.ts and position-manager.test.ts returned objects missing the new fields, causing TS2322 type assignment errors.
- **Fix:** Added the 6 new fields with their default values to makeConfig() in both test files (tpTargetPct: 2.0, atrMultiplier: 2.0, stopLimitSlippagePct: 0.1, repriceTimeoutMs: 60000, maxRepriceAttempts: 20, entryOrderTimeoutMs: 300000)
- **Files modified:** src/perp/__tests__/paper-perp-engine.test.ts, src/perp/__tests__/position-manager.test.ts
- **Verification:** npx tsc --noEmit passes; all 37 perp tests pass
- **Committed in:** 3db4803 (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 - Bug)
**Impact on plan:** Essential fix to maintain TypeScript correctness after schema extension. No scope creep.

## Issues Encountered
None beyond the auto-fixed test config update.

## Next Phase Readiness
- ORDER-01 and ORDER-02 satisfied: post-only entry loop with cancel-reprice ready
- All schema, config, type extensions in place for Plan 02 (ratchet stop, TP/SL orders)
- getOpenOrdersBySession() returns PerpOrder objects with limitPrice/stopPrice populated (required by Plan 02 ratchet recovery)
- No blockers

---
*Phase: 28-post-only-limit-order-engine*
*Completed: 2026-03-09*
