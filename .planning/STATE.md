# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-03-13)

**Core value:** The bot must reliably execute trades with correct position sizing, risk limits, and stop-losses -- never losing more than configured risk parameters allow.
**Current focus:** v1.5 Perp End-to-End Integration — Phase 35: Pipeline Wiring and Activation

## Current Position

Phase: 35 of 35 (Perp Paper Trading Pipeline)
Plan: 2 of 2 in current phase
Status: Complete
Last activity: 2026-03-14 — Phase 35 Plan 02 complete (PIPE-01/02/03 structural tests, 789 tests passing, v1.5 milestone complete)

Progress: [██████████] 100% of v1.5

## Performance Metrics

**v1.4 Totals:**
- 8 phases, 18 plans completed
- 66 files changed, +11,542 net lines
- 1,122 tests passing (78 test files)
- Timeline: 2 days (2026-03-08 to 2026-03-10)

## Accumulated Context

### Decisions

All v1.0–v1.4 decisions logged in PROJECT.md Key Decisions table.

**v1.5 context (pre-execution):**
- INFRA-02: PerpStateStore must use `data/perp.db` — separate from `data/trading.db` to prevent SQLITE_BUSY during concurrent tournament writes
- INFRA-03: `intxClient.on('error', ...)` must be registered before `intxClient.start()` — Node.js throws uncaught exception on unhandled error events
- INFRA-04: Stop order in resources[] — perp engine first, then IntxClient (engine stops before client, client stops before dashboard)
- PIPE-02/03: All perp construction must be wrapped in `if (config.intx.enabled)` — prevents crash for spot-only users without FCM credentials
- PIPE-03: `recoverFromRestart()` must be called before `start()` on PerpPositionManager for live mode

**v1.5 Phase 34 Plan 01 decisions:**
- perpMode uses chained .refine() on fcmConfigSchema — not .omit() which breaks refined schemas (Zod v4 pitfall)
- perpDatabase.path defaults to ./data/perp.db isolated from ./data/trading.db (INFRA-02 implemented)
- PERP_MODE=none (default) allows spot-only users to run without FCM credentials — perp dormant
- intxClient.on('error') registered before start() in perp-paper.ts (INFRA-03 for perp-paper CLI)

**v1.5 Phase 34 Plan 02 decisions:**
- Perp wiring block placed before createDashboardServer call — dashboard resources.push stays last (INFRA-04)
- perpStateStore?.close() added after correlationStore/backtestStore closes in gracefulShutdown finally block
- Structural tests use lineOf(regex) helper to assert ordering invariants without process execution overhead

**v1.5 Phase 35 Plan 01 decisions:**
- perpActivationReady boolean flag used as activation sentinel — avoids double resource.push and sentinel-undefined confusion
- fundingRateProvider = () => null in npm start is correct for paper mode (FCM funding rate not yet integrated)
- perpLiveFeed declared inside if (perpActivationReady) block — avoids unnecessary WebSocket connections when not activating

**v1.5 Phase 35 Plan 02 decisions:**
- Used /await createDashboardServer\s*\(/ regex (not /createDashboardServer/) to skip import line — lineOf() must match call site not import
- Math.min(paperLine, liveLine) < clientLine pattern for mutually-exclusive if/else branch ordering tests

### Open Issues / Tech Debt

- fast-technical-indicators createRequire workaround (inherited, low priority)
- Paper trading profitability not yet measured — use `npm run report` after paper session
- PerpPositionManager.stop() async vs sync signature needs verification before Phase 35 planning

### Blockers

None.

## Session Continuity

Last session: 2026-03-14
Stopped at: Completed 35-02-PLAN.md (PIPE-01/02/03 structural tests, 789 tests passing, v1.5 Perp End-to-End Integration milestone complete)
