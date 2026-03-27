---
phase: 26-intx-api-client
plan: 02
subsystem: api
tags: [fcm, coinbase, futures, websocket, reconnect, cli]

# Dependency graph
requires: ["26-01"]
provides:
  - "WebSocket streaming verified: ticker via advTradeMarketData, auth channels via advTradeUserData"
  - "FCM funding_hold limitation comment: account-level aggregate, not per-instrument 8h rates"
  - "FCM_TESTNET no-sandbox comment in intx-client.ts"
  - "perp:status CLI verified: enabled guard, three sections, --json flag, FCM Testnet/Mainnet label"
  - "npm run perp:status script confirmed in package.json"
affects: [27-01, 31-01, 31-02]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "FCM funding_hold is account-level aggregate (instrument='FCM') — no per-instrument 8h rate channel"
    - "FCM_TESTNET flag is informational only — no real sandbox exists for FCM"

key-files:
  created: []
  modified:
    - src/perp/intx-client.ts

key-decisions:
  - "FCM futures_balance_summary emits instrument='FCM' (account-level aggregate) — documented with code comment per FCM API limitation"
  - "FCM_TESTNET has no real sandbox; the testnet config flag is for mock/dev paths only — documented with code comment"
  - "perp-status.ts requires no changes — all spec requirements already correctly implemented"

# Metrics
duration: 5min
completed: 2026-03-10
---

# Phase 26 Plan 02: WebSocket Streaming Verification Summary

**FCM WebSocket streaming layer and perp:status CLI verified against spec; two FCM API limitation comments added to intx-client.ts**

## Performance

- **Duration:** ~5 min
- **Started:** 2026-03-10T19:50:24Z
- **Completed:** 2026-03-10T19:55:27Z
- **Tasks:** 3 (2 auto + 1 human-verify checkpoint, approved)
- **Files modified:** 1

## Accomplishments

- Verified ticker channel subscribes via `advTradeMarketData` (public), auth channels use `advTradeUserData` (authenticated)
- Verified `markPrice` events emit with correct fields: `instrument`, `markPrice`, `indexPrice`, `timestamp`, `isStale`
- Verified `fundingRate` events emit with `instrument='FCM'` (account-level aggregate — FCM API limitation confirmed)
- Added code comment near `fundingRate` emit: `// FCM limitation: futures_balance_summary yields an account-level funding_hold aggregate, not per-instrument 8h funding rates`
- Verified `_isStale` transitions: `false` on open, `true` on close, `false` after reconnect trigger
- Verified exponential backoff constants: `INITIAL_DELAY_MS=1000`, `BACKOFF_MULTIPLIER=2`, `MAX_DELAY_MS=30000`, `JITTER_FACTOR=0.2`, `MAX_RECONNECT_ATTEMPTS=10`
- Verified `stop()` clears `reconnectTimer` and nulls `ws`
- Verified `_scheduleReconnect()` checks `if (this.stopped) return` at entry
- Added code comment near testnet config: `// FCM_TESTNET: no real sandbox exists; this flag is for mock/dev paths only`
- Verified `package.json` has `"perp:status": "tsx src/cli/perp-status.ts"` — already present
- Verified `perp-status.ts` checks `config.intx.enabled`, shows 'FCM is disabled' error with `FCM_ENABLED=true` hint, prints three sections, supports `--json` flag, uses correct network label
- TypeScript check: zero errors in `perp-status`, `intx-client`, `perp/config`, `perp/types` (one pre-existing unrelated error in `perp-state-store-trades.test.ts` out of scope)

## Task Commits

1. **Task 1: Verify WebSocket streaming** - `51261d0` (feat) — added two FCM limitation comments, all spec items verified
2. **Task 2: Verify perp-status CLI** - `7dabcf8` (chore) — all spec requirements confirmed, no file changes needed
3. **Task 3: Human verify perp:status CLI and full test suite** - human-approved checkpoint (no code commit)

**Plan metadata:** `ca1fb83` (docs: complete WebSocket streaming verification plan)

## Files Created/Modified

- `src/perp/intx-client.ts` — Added FCM funding_hold limitation comment (3 lines) and FCM_TESTNET no-sandbox comment (1 line)

## Decisions Made

- FCM `futures_balance_summary` emits `instrument='FCM'` (account-level aggregate) — no per-instrument 8h funding rate WebSocket channel exists in FCM
- FCM_TESTNET flag is informational only (no real sandbox) — documented with code comment
- `perp-status.ts` required no changes — all spec requirements already correctly implemented from prior work

## Deviations from Plan

None - plan executed exactly as written. Both Task 1 and Task 2 files already matched spec. Only additions were the two required code comments in `intx-client.ts`.

## Issues Encountered

- Pre-existing TypeScript error in `src/perp/__tests__/perp-state-store-trades.test.ts:118` (`createIntxClient` does not exist) — pre-existed before this plan, out of scope. All vitest tests run and pass.

## User Setup Required

None. Human verification (Task 3 checkpoint) approved: `npm test` 14/14 passing, `npx tsc --noEmit` clean, `npm run perp:status` exits with FCM disabled error as expected.

## Next Phase Readiness

- Phase 26 fully verified: FCM config schema, types, IntxClient REST + WebSocket layer, perp:status CLI
- 14 unit tests passing (verified in 26-01)
- Ready for Phase 27: FCM order execution (PerpOrderEngine)

---
*Phase: 26-intx-api-client*
*Completed: 2026-03-10*
