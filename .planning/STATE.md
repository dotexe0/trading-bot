# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-03-08)

**Core value:** The bot must reliably execute trades with correct position sizing, risk limits, and stop-losses -- never losing more than configured risk parameters allow.
**Current focus:** v1.4 Perpetual Futures Trading — Phase 30 in progress (Perp Strategies and Tournament), Plan 3 of N complete

## Current Position

Phase: 30 of 33 (Perp Strategies and Tournament) — in progress
Plan: 3 complete in current phase
Status: Active
Last activity: 2026-03-09 — 30-03 complete (perp registry factories, config schema extension, npm run tournament:perp CLI)

Progress: [████░░░░░░] 69% of v1.4 (11/16 plans complete)

## Performance Metrics

**v1.0 Totals:**
- 11 phases, 22 plans completed
- 53 commits, 149 files, 55,764 LOC TypeScript
- 773 tests across 52 test files
- Timeline: 10 days (2026-02-09 to 2026-02-19)

**v1.1 Totals:**
- 5 phases, 12 plans completed
- 68 files changed, +5,520 net lines
- 444 tests passing (40 test files)
- Timeline: 6 days (2026-02-20 to 2026-02-26)

**v1.2 Totals:**
- 2 phases, 5 plans completed
- 30 files changed, +3,340 net lines
- 527 tests passing (49 test files)
- Timeline: 2 days (2026-02-27 to 2026-02-28)

**v1.3 Totals:**
- 7 phases, 14 plans completed
- 49 files changed, +4,225 net lines
- 638 tests passing (53 test files)
- Timeline: 8 days (2026-03-01 to 2026-03-08)

## Accumulated Context

### Decisions

All v1.0, v1.1, v1.2, and v1.3 decisions logged in PROJECT.md Key Decisions table.

**v1.4 Decisions:**

- 26-01: CBInternationalClient.getPortfolioDetails() used for single-call account state (balances + positions + summary)
- 26-01: IntxAccountState typed loosely (unknown) — Phase 27 tightens based on actual response shape
- 26-01: placeOrder/cancelOrder are explicit Phase-27 stubs (throw) — not omitted from interface
- 26-01: useSandbox mapped from config.testnet (INTX_TESTNET env var)
- 26-01: intxConfigSchema refine requires all four INTX credentials when enabled=true; path set to apiKey
- 26-02: vi.hoisted() required for WebsocketClient mock class — vi.mock factory hoisted before class declarations
- 26-02: MockWebsocketClient._instances static array tracks WS instances across tests without global leakage
- 26-02: perp:status uses out.banner/table/info + console.log(JSON.stringify) — out.header/label/section/json do not exist
- 26-02: internationalMarketData WsKey + uppercase RISK/FUNDING channel names (not lowercase)
- 27-01: IOC MARKET orders only for entry and exit — no partial fills to track, simplifies state
- 27-01: cancelOrder uses restClient.cancelOrder({ id, portfolio }) — INTX single-cancel API not bulk CancelINTXOrdersRequest
- 27-01: PerpStateStore.createSession() accepts fully-constructed PerpSession — store writes as-is, no ID/timestamp generation
- 27-01: closePosition() sets purpose='EMERGENCY_CLOSE' when reason='EMERGENCY_CLOSE', 'EXIT' otherwise
- 27-02: PaperPerpEngine is separate from PerpPositionManager — guarantees zero REST calls in paper path
- 27-02: createSession receives spread copy (not live reference) — prevents mutation aliasing after closePaperPosition
- 27-02: recoverFromRestart marks PENDING orders FAILED before session restore — conservative, prevents double-entry
- 27-02: getAllOpenSessions() added to PerpStateStore — required by recovery for all-instrument open session query
- 28-01: PerpOrderEngine allocates sessionId upfront before any order attempt — consistent session ID across reprice loops
- 28-01: NON_RETRYABLE_REASONS set (INSUFFICIENT_FUND, INVALID_SIZE, INVALID_PRICE, INVALID_PRODUCT) — abort immediately without retrying
- 28-01: Fill detection uses repriceTimeoutMs (60s) per-attempt, entryOrderTimeoutMs (300s) total loop timeout
- 28-01: cancelOrders() public batch method on IntxClient — cancelAllOpenOrders never accesses restClient directly
- 28-02: TrailingStopManager pure class (no EventEmitter) — ratchet loop lives in order-engine.ts for API access
- 28-02: closePosition() single cleanup point — executeEmergencyClose delegates to closePosition, preventing double-cleanup
- 28-02: TP failure does not block stop placement — trailing stop is critical risk-management order
- 28-02: closeAndCleanup uses tracked exchange IDs + DB query to cancel all TP/stop orders including ratcheted ones
- 29-01: computeLeverage clamps conviction to [0,1] before scaling — prevents out-of-range inputs from exceeding maxLeverageCap
- 29-01: Bot-internal leverage/margin mode — Coinbase FCM has no setLeverage or setMarginMode API; values are sizing multipliers and risk policy only
- 29-01: marginMode column nullable in perpSessions for backward-compat — legacy rows round-trip as undefined on PerpSession
- 29-02: openPaperPosition made async to support await riskGate.check() inline; _handleMarkPrice uses .catch() fire-and-forget for signal dispatch
- 29-02: Paper mode mock balance (initialMargin=0, availableMargin=1000000) always passes utilization; in-process sessions count toward notional cap
- 29-02: riskGate optional on both PerpPositionManager and PaperPerpEngine — null when absent; zero breaking changes for existing callers
- 30-01: fundingRateProvider uses >= for threshold comparison — rate at threshold triggers 50% max reduction (canonical test case: rate=threshold=0.01)
- 30-01: Plan annotation '25% reduction for rate=0.005' incorrect; formula gives no adjustment when rate < threshold; >= condition is correct
- 30-01: No regime filter on PerpMomentumStrategy — perp strategies activate in TRENDING, RANGING, VOLATILE (leveraged execution needs signals in any market)
- 30-01: fundingRateProvider injected via constructor — decouples from live data, enables tournament mode with null provider
- 30-02: No regime filter on PerpMeanReversionStrategy — consistent with PerpMomentumStrategy; perp strategies need signals in any market condition
- 30-02: Funding adjustment formula identical to PerpMomentumStrategy — >= threshold comparison for long, <= -threshold for short
- 30-02: minCandles = period + 1 (same as ZScoreMeanReversionStrategy spot counterpart)
- 30-03: createPerpRegistry() and createDefaultRegistry() are strictly separate instances — registry isolation invariant (no spot strategies in perp registry)
- 30-03: fundingRateProvider excluded from Zod schema — runtime-injected callback, not serializable config; only scalar params in schema
- 30-03: createLivePerpRegistry(provider) factory for live/paper engine use — injects real funding callback so FundingAdj fires at runtime
- 30-03: Perp tournament CLI omits ExitConfigStore — exit parameters from Zod schema defaults, no per-strategy exit config persistence for tournament
- 30-03: TournamentRunner unchanged — only registry and CLI differ from spot tournament (zero modification to core infrastructure)

### Open Issues / Tech Debt

- fast-technical-indicators createRequire workaround (inherited, low priority)
- Paper trading profitability not yet measured — use `npm run report` after paper session

### Blockers

None.

## Session Continuity

Last session: 2026-03-09
Stopped at: Completed 30-03-PLAN.md (perp registry factories, config schema extension, npm run tournament:perp CLI)
Resume with: `/gsd:execute-phase 30` (Phase 30: continue with next plan)
