# Phase 26: INTX API Client - Context

**Gathered:** 2026-03-08
**Status:** Ready for planning

<domain>
## Phase Boundary

FCM (Coinbase Financial Markets) REST + WebSocket connectivity — authenticate, query account state, and stream real-time mark price and aggregate funding hold for BTC and ETH FCM perp products. Uses existing Advanced Trade credentials (no separate FCM keys). No position management, no order placement, no P&L logic in this phase.

</domain>

<decisions>
## Implementation Decisions

### Credential Setup
- FCM reuses existing `COINBASE_API_KEY_NAME` / `COINBASE_API_KEY_SECRET` — no separate FCM credentials needed. FCM is accessed via the same `CBAdvancedTradeClient` cfm/* endpoints as Advanced Trade.
- Testnet/mainnet switchable via env flag `FCM_TESTNET=true` — note: no real FCM testnet/sandbox exists; this flag gates mock/dev paths only, not a real sandbox endpoint.
- Feature gated by `FCM_ENABLED=true` — fail fast at startup if FCM is enabled but required credentials (`COINBASE_API_KEY_NAME`, `COINBASE_API_KEY_SECRET`) are missing; clear error, not a warning.

### WebSocket Resilience
- Auto-reconnect with exponential backoff when stream drops
- Max reconnect attempt cap — after N failures, log a fatal error and stop the perp subsystem (researcher determines reasonable cap)
- On reconnect, emit a reconnect event so consumers can re-subscribe themselves — consumers are responsible for replaying their subscriptions, not the client
- Stale data handling during reconnect: Claude's discretion (see below)

### IntxClient Interface Shape
- Streaming market data exposed via EventEmitter — matches the existing ENGINE_EVENT_MAP pattern; IntxClient emits typed events
- Singleton — one shared IntxClient instance used by all subsystems (perp engine, dashboard, CLI); single WebSocket connection to FCM
- REST surface includes account query (balance, margin, open positions) AND stub signatures for order management (placeOrder, cancelOrder) — full interface shape defined now even if order methods are not implemented until Phase 27+
- All FCM/perp type definitions in an isolated module (e.g. `src/perp/types.ts`) — keeps perp types cleanly separated from spot types

### FCM API Limitations (discovered during implementation)
- The `futures_balance_summary` WebSocket channel provides ONE account-level `funding_hold` aggregate across all FCM positions — not separate per-instrument 8-hour funding rates for BTC-PERP and ETH-PERP. FCM WebSocket does not provide per-instrument funding rates. The aggregate value is sufficient for FundingRateTracker (phase 31).
- FCM ticker does not split mark price and index price into separate fields — both `markPrice` and `indexPrice` are populated from the same `price` field; documented via code comment.

### Claude's Discretion
- Stale data flagging during reconnect gap — whether to mark last-known values as stale or silently pause events
- Exact reconnect backoff parameters and max attempt count
- perp:status CLI output format (table vs JSON, exact fields shown) — not discussed, Claude decides
- Internal WebSocket subscription management implementation details

</decisions>

<specifics>
## Specific Ideas

- The existing `coinbase-api` (tiagosiebler) SDK is already used for Advanced Trade — FCM uses the same `CBAdvancedTradeClient` with cfm/* endpoint methods, no separate library needed.
- FCM_ENABLED flag keeps naming consistent with existing feature-flag patterns in the codebase.
- The singleton pattern matches how the existing bot manages shared resources (single process, single SQLite connection, single Fastify instance).

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 26-intx-api-client*
*Context gathered: 2026-03-08*
