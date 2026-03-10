---
phase: 26-intx-api-client
plan: 01
subsystem: api
tags: [fcm, coinbase, futures, websocket, zod, vitest]

# Dependency graph
requires: []
provides:
  - "fcmConfigSchema with fail-fast refine (COINBASE_API_KEY_NAME/SECRET required when enabled=true)"
  - "IntxClient class using CBAdvancedTradeClient (not CBInternationalClient)"
  - "FcmOrderFillEvent, IntxMarkPriceEvent, IntxFundingRateEvent, IntxClientEvents types"
  - "FCM_ENABLED / FCM_TESTNET wired in core/config.ts (reuses spot credentials)"
  - "14 passing unit tests for schema validation, constructor guard, getAccountState, WS events, orderFill"
affects: [26-02, 27-01, 27-02, 28-01, 28-02, 29-01, 31-01, 31-02]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "vi.hoisted() for WS mock class so static _instances array tracks instances across tests"
    - "intxConfigSchema exported as backward-compat alias for fcmConfigSchema"
    - "Promise.all([getFuturesBalanceSummary, getFuturesPositions]) for getAccountState"

key-files:
  created: []
  modified:
    - src/perp/__tests__/intx-client.test.ts

key-decisions:
  - "fcmConfigSchema.refine() guard: when enabled=true, both apiKey and apiSecret must be present; error message references COINBASE_API_KEY_NAME and COINBASE_API_KEY_SECRET"
  - "IntxClient uses CBAdvancedTradeClient (not CBInternationalClient) — FCM is US-available via Advanced Trade API"
  - "intxConfigSchema is a backward-compat alias for fcmConfigSchema — no rename needed for downstream code"
  - "FCM credentials reuse COINBASE_API_KEY_NAME/SECRET — no separate FCM env vars"
  - "User channel FILLED-only filter: non-FILLED orders (OPEN, CANCELLED etc.) do not emit orderFill"

patterns-established:
  - "Test 14 pattern: emit 'update' on mock WS instance with channel='user', verify orderFill emission for FILLED and no emission for OPEN"

# Metrics
duration: 8min
completed: 2026-03-10
---

# Phase 26 Plan 01: FCM API Client Foundation Summary

**FCM config schema, IntxClient REST/WS layer, and 14-test suite verified against spec; Test 14 added for user-channel FILLED order fill emission**

## Performance

- **Duration:** ~8 min
- **Started:** 2026-03-10T11:17:10Z
- **Completed:** 2026-03-10T11:25:00Z
- **Tasks:** 2
- **Files modified:** 1

## Accomplishments

- Verified `fcmConfigSchema` / `intxConfigSchema` alias, product ID defaults (BIP-20DEC30-CDE, ETP-20DEC30-CDE), and fail-fast refine — all correct
- Verified `src/perp/types.ts` exports: `IntxMarkPriceEvent`, `IntxFundingRateEvent`, `FcmOrderFillEvent`, `IntxClientEvents`, `IntxAccountState`, `PlaceOrderParams`, `CancelOrderParams` — all present and correctly typed
- Verified `src/core/config.ts` wires `FCM_ENABLED` / `FCM_TESTNET` (not INTX_ENABLED), reuses `COINBASE_API_KEY_NAME` / `COINBASE_API_KEY_SECRET` for `intx.apiKey`/`intx.apiSecret`
- Verified `IntxClient` uses `CBAdvancedTradeClient`, constructor guard throws on `enabled=false`, `getAccountState()` calls `Promise.all([getFuturesBalanceSummary, getFuturesPositions])`, `cancelOrder/cancelOrders` use `restClient.cancelOrders`, `placeStopOrder` uses `stop_limit_stop_limit_gtc` — all correct
- Added Test 14: user channel FILLED order emits `orderFill` with all fields; OPEN order does NOT emit — 14/14 tests pass

## Task Commits

1. **Task 1: Verify fcmConfigSchema, types.ts, and core config wiring** - no file changes (verified correct as-is)
2. **Task 2: Verify IntxClient REST layer and add missing orderFill unit test** - `47371a6` (test)

**Plan metadata:** (docs commit below)

## Files Created/Modified

- `src/perp/__tests__/intx-client.test.ts` - Added Test 14 for user channel FILLED order fill emission (67 lines added)

## Decisions Made

- No new decisions — all spec requirements were already correctly implemented. Test 14 added to cover the user-channel orderFill path which had no existing test coverage.

## Deviations from Plan

None - plan executed exactly as written. All Task 1 files already matched spec. Task 2 added Test 14 as specified.

## Issues Encountered

- Pre-existing TypeScript error in `src/perp/__tests__/perp-state-store-trades.test.ts:118` (`createIntxClient` does not exist) — this error pre-existed before any changes in this plan and is out of scope. All tests run and pass via vitest despite this tsc error.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- FCM foundation fully verified: config schema, types, IntxClient REST layer, WebSocket streaming
- 14 unit tests passing including new orderFill coverage
- Ready for Phase 26 Plan 02: WebSocket streaming integration
- Ready for Phase 27: position execution on FCM

---
*Phase: 26-intx-api-client*
*Completed: 2026-03-10*
