# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-03-13)

**Core value:** The bot must reliably execute trades with correct position sizing, risk limits, and stop-losses -- never losing more than configured risk parameters allow.
**Current focus:** v1.5 Perp End-to-End Integration — Phase 34: Perp Infrastructure Foundation

## Current Position

Phase: 34 of 35 (Perp Infrastructure Foundation)
Plan: 1 of 2 in current phase
Status: In progress
Last activity: 2026-03-14 — Phase 34 Plan 01 complete (INFRA-01 perpMode validation, INFRA-02 DB isolation, INFRA-03 partial)

Progress: [█░░░░░░░░░] 5% of v1.5

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

### Open Issues / Tech Debt

- fast-technical-indicators createRequire workaround (inherited, low priority)
- Paper trading profitability not yet measured — use `npm run report` after paper session
- PerpPositionManager.stop() async vs sync signature needs verification before Phase 35 planning

### Blockers

None.

## Session Continuity

Last session: 2026-03-14
Stopped at: Completed 34-01-PLAN.md (INFRA-01 perpMode validation, INFRA-02 DB isolation, 9 new tests, 80 perp tests passing)
