# Phase 26: FCM API Client - Research

**Researched:** 2026-03-10
**Domain:** Coinbase FCM (Futures Commission Merchant) REST + WebSocket client via `coinbase-api` SDK
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md — FCM-corrected)

### Locked Decisions

#### Credential Setup
- FCM reuses existing COINBASE_API_KEY_NAME / COINBASE_API_KEY_SECRET — no separate FCM credentials
- Testnet/mainnet switchable via FCM_TESTNET=true env flag
- Fail fast at startup if FCM_ENABLED=true but credentials missing — ConfigError, not a warning
- FCM_ENABLED=true env flag (renamed from INTX_ENABLED)

#### WebSocket Resilience
- Auto-reconnect with exponential backoff when stream drops
- Max reconnect attempt cap — after N failures, log fatal and stop the perp subsystem
- On reconnect, emit a reconnect event so consumers can re-subscribe themselves
- Stale data flagging during reconnect gap (Claude's discretion, implemented as isStale boolean on events)

#### IntxClient Interface Shape
- Streaming market data exposed via EventEmitter — matches ENGINE_EVENT_MAP pattern
- Singleton — one shared IntxClient instance; single WebSocket connection
- REST surface includes account query (balance, margin, open positions) AND order management (placeOrder, cancelOrder, placeStopOrder, cancelOrders)
- All perp type definitions in src/perp/types.ts

### Claude's Discretion
- Stale data flagging during reconnect gap — mark last-known values as stale (implemented: isStale boolean)
- Exact reconnect backoff parameters and max attempt count (implemented: 1s initial, 2x multiplier, ±20% jitter, 30s cap, 10 max attempts)
- perp:status CLI output format — table with --json flag override
- Internal WebSocket subscription management

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope.
</user_constraints>

---

## Summary

**This phase is substantially already implemented.** The codebase already contains `src/perp/intx-client.ts` (FCM-targeting `IntxClient`), `src/perp/config.ts` (`fcmConfigSchema`), `src/perp/types.ts` (all event/order/position types), `src/cli/perp-status.ts` (CLI command), and `src/perp/__tests__/intx-client.test.ts` (13 tests). The planning task is to verify the implementation is correct against the real SDK APIs and document any remaining gaps, not to design from scratch.

The key FCM-vs-INTX distinction: FCM uses `CBAdvancedTradeClient` (same as spot), not `CBInternationalClient`. The SDK method for balance is `getFuturesBalanceSummary()` returning `{ balance_summary: AdvTradeFuturesBalance }`. Positions: `getFuturesPositions()` returning `{ positions: AdvTradeFuturesPosition[] }`. Orders: `submitOrder()` and `cancelOrders()` on the same client, already used for spot. This is confirmed directly from `CBAdvancedTradeClient.d.ts` in the installed package (v1.1.11).

**Critical finding — no FCM testnet:** The `exchangeSandboxURLMap` in the SDK's `requestUtils.js` maps `advancedTrade` to `'NoSandboxAvailable'`. The Advanced Trade API sandbox (api-sandbox.coinbase.com) does not support FCM/CFM futures endpoints per official documentation. FCM_TESTNET=true is a config flag but has no actual effect on the CBAdvancedTradeClient routing — it stays on the production URL. The WebSocket URL map for `advTradeMarketData` and `advTradeUserData` also shows `testnet: 'NotAvailable'`. This is a significant gap: FCM development must be done against production with real funds, or the testnet flag is used only for branching test mock paths.

**Primary recommendation:** The implementation in `intx-client.ts` is architecturally correct. Planning tasks should focus on: (1) verifying the ticker channel event shape against live/mock data, (2) clarifying the FCM_TESTNET flag's actual behavior, (3) ensuring the test suite covers the `user` channel order fill path, and (4) adding the perp:status CLI npm script to package.json if not present.

---

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `coinbase-api` | 1.1.11 (installed) | `CBAdvancedTradeClient` REST + `WebsocketClient` WS | Already installed; covers all FCM endpoints |
| Node.js `events` | built-in | EventEmitter base for `IntxClient` | Matches existing ENGINE_EVENT_MAP pattern |
| `zod` | installed | `fcmConfigSchema` / `intxConfigSchema` validation | Matches `src/core/config.ts` pattern |
| `commander` | installed | `perp:status` CLI command | Matches existing CLI pattern |
| Node.js `crypto` | built-in | `crypto.randomUUID()` for client order IDs | Used in `placeOrder()` |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `pino` via `createModuleLogger` | installed | Structured logging | All logging — `createModuleLogger('fcm-client')` |
| `vitest` | installed | Unit tests with fake timers | All tests — mock `coinbase-api` module |

**Installation:** No new packages needed. All required libraries are already installed.

---

## Architecture Patterns

### Actual Project Structure (Already Implemented)
```
src/perp/
├── types.ts             # All FCM/perp type definitions
├── config.ts            # fcmConfigSchema + intxConfigSchema alias
├── intx-client.ts       # IntxClient class — FCM REST + WebSocket
├── index.ts             # Barrel export
└── __tests__/
    └── intx-client.test.ts  # 13 tests, all mocked
src/cli/
└── perp-status.ts       # perp:status CLI command
src/core/
└── config.ts            # Loads FCM_ENABLED, FCM_TESTNET from env, wires into intx: field
```

### Pattern 1: CBAdvancedTradeClient for FCM REST
**What:** FCM uses `CBAdvancedTradeClient` with apiKey + apiSecret (JWT/CDP auth, no passphrase). FCM endpoints are prefixed `/api/v3/brokerage/cfm/`.
**Key difference from old INTX research:** No `apiPassphrase` required. No `useSandbox` effect on FCM.

```typescript
// Source: node_modules/coinbase-api/dist/mjs/CBAdvancedTradeClient.d.ts (installed v1.1.11)
import { CBAdvancedTradeClient } from 'coinbase-api';

const restClient = new CBAdvancedTradeClient({
  apiKey: config.apiKey!,    // COINBASE_API_KEY_NAME
  apiSecret: config.apiSecret!,  // COINBASE_API_KEY_SECRET
  // useSandbox has NO effect for advancedTrade — maps to 'NoSandboxAvailable'
});

// FCM account state
const { balance_summary } = await restClient.getFuturesBalanceSummary();
const { positions } = await restClient.getFuturesPositions();
const { position } = await restClient.getFuturesPosition({ product_id: 'BIP-20DEC30-CDE' });

// FCM order placement
const response = await restClient.submitOrder({
  client_order_id: crypto.randomUUID(),
  product_id: 'BIP-20DEC30-CDE',
  side: 'BUY',
  order_configuration: {
    market_market_ioc: { quote_size: '100' }
  }
});

// FCM order cancellation
await restClient.cancelOrders({ order_ids: ['order-id-1'] });
```

### Pattern 2: WebsocketClient for FCM Streaming
**What:** FCM market data uses `advTradeMarketData` WsKey (public ticker). FCM account data uses `advTradeUserData` WsKey (authenticated, futures_balance_summary + user channels). The WS URL for both is `wss://advanced-trade-ws.coinbase.com` / `wss://advanced-trade-ws-user.coinbase.com` — no testnet URL exists.

```typescript
// Source: node_modules/coinbase-api/dist/mjs/lib/websocket/websocket-util.js (installed v1.1.11)
import { WebsocketClient } from 'coinbase-api';

const wsClient = new WebsocketClient({
  apiKey: config.apiKey!,
  apiSecret: config.apiSecret!,
});

// Ticker for FCM mark price — uses advTradeMarketData WsKey (public)
wsClient.subscribe(
  { topic: 'ticker', payload: { product_ids: ['BIP-20DEC30-CDE', 'ETP-20DEC30-CDE'] } },
  'advTradeMarketData',
);

// FCM balance summary — uses advTradeUserData WsKey (authenticated)
wsClient.subscribe(
  { topic: 'futures_balance_summary', payload: { product_ids: [] } },
  'advTradeUserData',
);

// User channel for order fills — uses advTradeUserData WsKey (authenticated)
wsClient.subscribe(
  { topic: 'user', payload: { product_ids: ['BIP-20DEC30-CDE', 'ETP-20DEC30-CDE'] } },
  'advTradeUserData',
);

wsClient.on('update', (data: any) => {
  if (data?.channel === 'ticker') { /* handle mark price */ }
  if (data?.channel === 'futures_balance_summary') { /* handle FCM balance */ }
  if (data?.channel === 'user') { /* handle order fills */ }
});
```

### Pattern 3: IntxClient Typed EventEmitter Singleton
**What:** The class is already implemented in `src/perp/intx-client.ts` using this pattern. The class extends `EventEmitter` with an overridden typed `emit()`.

```typescript
// Source: src/perp/intx-client.ts (existing implementation)
export class IntxClient extends EventEmitter {
  override emit<K extends keyof IntxClientEvents>(
    event: K, ...args: IntxClientEvents[K]
  ): boolean {
    return super.emit(event, ...args);
  }
  // Events: markPrice, fundingRate, orderFill, connected, disconnected,
  //         reconnected, reconnectFailed, error
}
```

### Pattern 4: Exponential Backoff Reconnect (Already Implemented)
**Parameters in `src/perp/intx-client.ts`:**
- Initial delay: 1,000 ms
- Multiplier: 2x
- Jitter: ±20% of computed delay
- Cap: 30,000 ms
- Max attempts: 10 (after 10 failures: emit `reconnectFailed`, set `stopped = true`, log fatal)

**How it works:** `close` event increments `reconnectAttempts`, schedules a delayed `_subscribe()` call. `open` event resets `reconnectAttempts = 0`. After 10 `close` events without a successful `open`, `reconnectFailed` fires.

### Pattern 5: FCM Ticker Event Shape (Key Uncertainty)
**What:** The `ticker` channel delivers price updates. For FCM futures products (BIP-20DEC30-CDE, ETP-20DEC30-CDE), the field that represents mark price within a ticker event is uncertain.

**What's confirmed:** The SDK parses `data.events[].tickers[].price` for standard ticker updates. The `intx-client.ts` implementation uses `t.price ?? t.mark_price ?? t.last_trade_price` as a fallback chain. The Coinbase Advanced Trade ticker channel for spot products uses `price` as the last trade price, not a dedicated `mark_price` field.

**Risk:** For FCM futures products, `price` from the ticker channel may be last trade price, not the exchange's official mark price. True mark price for FCM may only be available via the `mark_prices` channel (a separate channel not currently subscribed). This is a LOW confidence area.

### Pattern 6: perp:status CLI (Already Implemented)
**What:** `src/cli/perp-status.ts` uses `Commander`, loads config, creates `IntxClient`, calls `getAccountState()`, prints formatted output or JSON via `--json` flag. npm script: `"perp:status": "tsx src/cli/perp-status.ts"`.

### Anti-Patterns to Avoid
- **Using `CBInternationalClient` for FCM:** CBInternationalClient requires `apiPassphrase` and connects to `api.international.coinbase.com`. FCM uses `CBAdvancedTradeClient` at `api.coinbase.com`. These are different exchanges.
- **Assuming useSandbox works for FCM:** `exchangeSandboxURLMap.advancedTrade = 'NoSandboxAvailable'` — the SDK throws or silently falls back. FCM has no sandbox.
- **Using module-level singleton constructor:** `IntxClient` must be instantiated inside the action callback after `loadConfig()`. Instantiating at module load time runs before dotenv populates env vars.
- **Subscribing futures_balance_summary to advTradeMarketData WsKey:** This channel requires authentication — it must go to `advTradeUserData`.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| JWT/CDP auth for AT REST calls | Custom auth header builder | `CBAdvancedTradeClient` handles signing | AT uses EC private key JWT — wrong algorithm order causes silent 401 |
| WebSocket auth on subscribe | Manual JWT in subscribe message | `WebsocketClient` with AT credentials | SDK generates signed subscribe message automatically |
| WebSocket URL selection (market vs user) | Manual URL routing | SDK routes ticker to `advTradeMarketData`, futures_balance_summary to `advTradeUserData` | Automatic via `PRIVATE_WS_KEYS` detection in SDK |
| Client order ID generation | Custom ID format | `crypto.randomUUID()` | AT requires client_order_id; UUID is simplest valid format |

**Key insight:** `CBAdvancedTradeClient` and `WebsocketClient` together handle all auth, URL routing, and request serialization. The custom code is the EventEmitter wrapper, typed event surface, reconnect counter, config integration, and FCM response mapping.

---

## Common Pitfalls

### Pitfall 1: FCM Has No Testnet
**What goes wrong:** Setting `FCM_TESTNET=true` has no effect on `CBAdvancedTradeClient` — the SDK maps `advancedTrade` REST to `'NoSandboxAvailable'` and WebSocket URLs also have `testnet: 'NotAvailable'`. The client will still connect to production.
**Why it happens:** Coinbase's Advanced Trade API sandbox (`api-sandbox.coinbase.com`) does not support CFM futures endpoints per official docs.
**How to avoid:** Document that FCM_TESTNET is a no-op for network routing. Use unit tests with mocked SDK to validate logic. Accept that FCM integration testing requires a real account. Flag this clearly in .env.example.
**Warning signs:** Expecting sandbox behavior but seeing live market data.

### Pitfall 2: `futures_balance_summary` Funding Rate is Aggregate Hold, Not Per-Product Rate
**What goes wrong:** The `fundingRate` event emitted by `IntxClient` uses `fcm_balance_summary.funding_hold` — this is the total USD amount currently held for funding across all FCM positions, not the annualized rate for BTC or ETH specifically.
**Why it happens:** FCM does not expose a per-product funding rate via WebSocket the way INTX's `FUNDING` channel did. The `futures_balance_summary` contains `funding_hold` (a USD amount).
**How to avoid:** Consumers expecting a `fundingRate` as a percentage (e.g., 0.0001 = 0.01%) must understand they're getting a USD hold amount, not a rate. The `isFinal: false` value in the emitted event correctly signals this is not a settled rate. For true funding rate data, use the REST endpoint for the specific product (not implemented in this phase).
**Warning signs:** Dashboard showing unreasonably large "funding rate" values; confusion between USD amount and percentage.

### Pitfall 3: Ticker Channel `price` vs `mark_price` for FCM Products
**What goes wrong:** The `ticker` channel for FCM futures products (BIP-20DEC30-CDE) may emit `price` as last trade price, not official mark price. The existing implementation uses `t.price` as the mark price.
**Why it happens:** FCM perpetual-style futures have a distinct mark price calculated by the exchange that differs from the last trade price. The ticker channel's `price` field for futures may not be the mark price.
**How to avoid:** When testing against live data, verify whether the `mark_prices` channel provides a more accurate signal. The `mark_prices` channel (separate from `ticker`) may be needed for true mark price data.
**Warning signs:** Mark price shown in dashboard significantly diverges from exchange-reported mark price.

### Pitfall 4: `user` Channel Order Fill Filtering
**What goes wrong:** The `user` channel sends all order state updates (OPEN, PENDING, CANCELLED, FILLED), not just fills. The `intx-client.ts` filters for `o.status === 'FILLED'` to emit `orderFill` events, but the status field name and value may vary by update type.
**Why it happens:** The AT `user` channel order update shape can have `status` as `FILLED`, `OPEN`, `CANCEL_QUEUED`, etc. — the filtering must be precise to avoid false fill signals.
**How to avoid:** The current filter `o.status === 'FILLED'` is the correct approach. Also verify `o.order_id` is present (existing code does this). Test with the mock to confirm the fill path.
**Warning signs:** `orderFill` events firing for non-filled orders; missing fill events for completed orders.

### Pitfall 5: IntxClient Double-Start Guard
**What goes wrong:** Calling `start()` twice throws `'FcmClient already started'`. This is by design, but callers that restart on error must call `stop()` first.
**Why it happens:** The `ws` field is checked as the guard — if not null, throws.
**How to avoid:** In any restart logic (reconnect after fatal, test cleanup), always call `stop()` before `start()`. The test suite already covers this (Test 8).

---

## Code Examples

Verified from installed package source:

### AdvTradeFuturesBalance shape (confirmed from types/response/advanced-trade-client.d.ts)
```typescript
// Source: node_modules/coinbase-api/dist/mjs/types/response/advanced-trade-client.d.ts
interface AdvTradeFuturesBalance {
  futures_buying_power: { value: string; currency: string };
  total_usd_balance: { value: string; currency: string };
  cbi_usd_balance: { value: string; currency: string };
  cfm_usd_balance: { value: string; currency: string };
  total_open_orders_hold_amount: { value: string; currency: string };
  unrealized_pnl: { value: string; currency: string };
  daily_realized_pnl: { value: string; currency: string };
  initial_margin: { value: string; currency: string };
  available_margin: { value: string; currency: string };
  liquidation_threshold: { value: string; currency: string };
  liquidation_buffer_amount: { value: string; currency: string };
  liquidation_buffer_percentage: string;
  intraday_margin_window_measure: { /* margin_window_type, margin_level, ... */ };
  overnight_margin_window_measure: { /* margin_window_type, margin_level, ... */ };
}
```

### AdvTradeFuturesPosition shape (confirmed from types/response/advanced-trade-client.d.ts)
```typescript
// Source: node_modules/coinbase-api/dist/mjs/types/response/advanced-trade-client.d.ts
interface AdvTradeFuturesPosition {
  product_id: string;         // e.g. 'BIP-20DEC30-CDE'
  expiration_time: string;
  side: 'UNKNOWN' | 'LONG' | 'SHORT';
  number_of_contracts: string;
  current_price: string;
  avg_entry_price: string;
  unrealized_pnl: string;
  daily_realized_pnl: string;
}
```

### getAccountState() mapping pattern (existing implementation)
```typescript
// Source: src/perp/intx-client.ts (existing)
async getAccountState(): Promise<IntxAccountState> {
  const [balanceSummary, positions] = await Promise.all([
    this.restClient.getFuturesBalanceSummary(),
    this.restClient.getFuturesPositions(),
  ]);
  return {
    balances: (balanceSummary as any)?.balance_summary ?? balanceSummary,
    positions: (positions as any)?.positions ?? positions ?? [],
    summary: (balanceSummary as any)?.balance_summary ?? balanceSummary,
  };
}
```

### submitOrder for FCM futures (confirmed from CBAdvancedTradeClient.d.ts)
```typescript
// Source: node_modules/coinbase-api/dist/mjs/types/request/advanced-trade-client.d.ts
// product_type field confirms FCM futures support
interface SubmitAdvTradeOrderRequest {
  client_order_id: string;
  product_id: string;
  side: 'BUY' | 'SELL';
  order_configuration: { /* market_market_ioc | limit_limit_gtc | stop_limit_stop_limit_gtc | ... */ };
  product_type?: 'UNKNOWN_PRODUCT_TYPE' | 'SPOT' | 'FUTURE';
  // Note: product_type is optional; FCM futures route automatically by product_id
}
```

### cancelOrders signature (confirmed from CBAdvancedTradeClient.d.ts)
```typescript
// Source: node_modules/coinbase-api/dist/mjs/CBAdvancedTradeClient.d.ts
cancelOrders(params: { order_ids: string[] }): Promise<AdvTradeCancelOrdersResponse>;
```

### .env additions (FCM-corrected)
```bash
# ── Coinbase FCM (Futures Commission Merchant) — Perpetual Futures ──────────────
# Reuses COINBASE_API_KEY_NAME / COINBASE_API_KEY_SECRET — no separate FCM keys.
# FCM_TESTNET=true is a NO-OP — there is no FCM sandbox/testnet endpoint.
FCM_ENABLED=false
FCM_TESTNET=false
```

### perp:status CLI usage (existing implementation)
```bash
npm run perp:status            # formatted table output
npm run perp:status -- --json  # raw JSON output
```

---

## State of the Art

| Old Approach (INTX) | Current Approach (FCM) | Impact |
|---------------------|------------------------|--------|
| `CBInternationalClient` with apiPassphrase | `CBAdvancedTradeClient` with existing COINBASE_* credentials | No separate credentials needed |
| INTX REST: `getPortfolioDetails()`, `getPortfolioBalances()` | FCM REST: `getFuturesBalanceSummary()`, `getFuturesPositions()` | Different method names, different response shapes |
| INTX WsKey: `internationalMarketData` | FCM WsKeys: `advTradeMarketData` (ticker), `advTradeUserData` (user + balance) | Split across two authenticated connections |
| INTX WebSocket channels: `RISK`, `FUNDING` (uppercase) | FCM WebSocket channels: `ticker`, `futures_balance_summary`, `user` (lowercase) | Different channel names and shapes |
| INTX sandbox URL: `https://api-n5e1.coinbase.com` | FCM: No sandbox available | FCM testing requires production API |
| Separate INTX product IDs: `BTC-PERP`, `ETH-PERP` | FCM product IDs: `BIP-20DEC30-CDE`, `ETP-20DEC30-CDE` | Different product IDs on the exchange |

**Deprecated/outdated in old RESEARCH.md:**
- `CBInternationalClient`: Only relevant for INTX (non-US). Not used in FCM path.
- `apiPassphrase`: INTX-only credential. FCM uses CDP JWT (key name + EC private key).
- `internationalMarketData` WsKey: INTX-only. FCM uses advTradeMarketData/advTradeUserData.
- `INTX_PORTFOLIO_ID`: INTX requires a portfolio UUID; FCM has no equivalent portfolio scoping.
- `RISK`, `FUNDING` channel names: INTX-only. FCM uses `ticker`, `futures_balance_summary`.

---

## Open Questions

1. **Is `ticker` channel `price` the FCM mark price or last trade price?**
   - What we know: For spot products (BTC-USD), `ticker.price` is last trade price. FCM futures have a distinct exchange-calculated mark price.
   - What's unclear: Whether subscribing to `ticker` for `BIP-20DEC30-CDE` returns mark price or last trade price in the `price` field. The `mark_prices` channel (separate AT WebSocket channel) may be more appropriate.
   - Recommendation: During integration, compare `ticker.price` for BIP-20DEC30-CDE against the price shown on `coinbase.com/advanced-trade/futures/BIP-20DEC30-CDE`. If they diverge, add a `mark_prices` subscription. The current fallback chain `t.price ?? t.mark_price ?? t.last_trade_price` in the implementation is reasonable.
   - **Confidence:** LOW — not verifiable without live data.

2. **FCM_TESTNET flag behavior**
   - What we know: The SDK's `exchangeSandboxURLMap.advancedTrade = 'NoSandboxAvailable'` and `WS_URL_MAP.advTradeMarketData.testnet = 'NotAvailable'`. Official AT sandbox docs confirm FCM/CFM futures endpoints are not available in sandbox.
   - What's unclear: Whether there is any undocumented sandbox for FCM, or whether Coinbase plans to add one.
   - Recommendation: Document `FCM_TESTNET=true` in .env.example as "reserved for future use — no FCM sandbox currently exists." The flag can remain in the config schema for forward compatibility but should log a warning when set to true.
   - **Confidence:** HIGH — directly verified in SDK source and official docs.

3. **`futures_balance_summary` WebSocket channel: subscription timing**
   - What we know: The channel is authenticated (advTradeUserData). The subscription uses `product_ids: []` (empty array) as shown in the existing implementation.
   - What's unclear: Whether the empty `product_ids` array is the correct subscription format for this channel, or whether it requires specific product IDs or no `product_ids` key at all.
   - Recommendation: The existing implementation with `product_ids: []` matches patterns seen in the SDK examples. If no events arrive after subscribing, try omitting the `product_ids` field entirely.
   - **Confidence:** MEDIUM — pattern matches SDK usage, not verified against live response.

---

## Sources

### Primary (HIGH confidence)
- `node_modules/coinbase-api/dist/mjs/CBAdvancedTradeClient.d.ts` (installed v1.1.11) — confirmed `getFuturesBalanceSummary()`, `getFuturesPositions()`, `getFuturesPosition()`, `submitOrder()`, `cancelOrders()` signatures
- `node_modules/coinbase-api/dist/mjs/types/response/advanced-trade-client.d.ts` (installed v1.1.11) — confirmed `AdvTradeFuturesBalance` and `AdvTradeFuturesPosition` shapes
- `node_modules/coinbase-api/dist/mjs/lib/websocket/websocket-util.js` (installed v1.1.11) — confirmed `WS_KEY_MAP` names (`advTradeMarketData`, `advTradeUserData`), WS URLs (no testnet for advTrade WsKeys)
- `node_modules/coinbase-api/dist/mjs/lib/requestUtils.js` (installed v1.1.11) — confirmed `exchangeSandboxURLMap.advancedTrade = 'NoSandboxAvailable'`
- `src/perp/intx-client.ts` — existing FCM implementation to verify against
- `src/perp/__tests__/intx-client.test.ts` — 13 tests, existing test coverage map

### Secondary (MEDIUM confidence)
- `https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/websocket/websocket-channels` — confirmed `futures_balance_summary` channel exists, sends balance updates; `user` channel confirmed for order fills
- `https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/sandbox` — confirmed AT sandbox does NOT support FCM/CFM futures endpoints
- WebSearch (coinbase.com/advanced-trade/futures/BIP-20DEC30-CDE) — confirmed `BIP-20DEC30-CDE` is nano BTC perp (1/100th BTC, 5-year cash-settled, 24/7 trading via CDE)

### Tertiary (LOW confidence)
- WebSearch inference: `ETP-20DEC30-CDE` is nano ETH perp (0.1 ETH/contract) — product page not directly verified but consistent with the BTC product naming pattern and project MEMORY.md
- `ticker` channel behavior for FCM futures products vs spot products — not verified from primary source; behavior may differ for futures product IDs

---

## Metadata

**Confidence breakdown:**
- SDK method names and signatures: HIGH — confirmed from installed package .d.ts
- Response type shapes: HIGH — confirmed from installed package .d.ts
- WebSocket WsKey routing: HIGH — confirmed from installed JS source
- No FCM sandbox: HIGH — confirmed from SDK source + official docs
- Ticker channel = mark price for FCM products: LOW — not verifiable without live data
- futures_balance_summary subscription format: MEDIUM — matches SDK patterns
- ETP-20DEC30-CDE product details: LOW (MEDIUM via MEMORY.md) — single source

**Research date:** 2026-03-10
**Valid until:** 2026-04-10 (30 days — coinbase-api v1.1.11 is installed and pinned; FCM API is stable)
