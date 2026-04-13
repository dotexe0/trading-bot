# Paper Funding Simulation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Simulate realistic 8-hour funding payments in paper perp mode by fetching the live funding rate from Coinbase's product REST endpoint and applying it periodically to the open position.

**Architecture:** `IntxClient` gains `fetchFundingRate(productId)` which calls the existing `getProduct` REST endpoint and parses `future_product_details.perpetual_details.funding_rate`. `PaperPerpEngine` runs a `setInterval` (default 8 h) that, on each tick, fetches the rate, calculates the dollar payment (signed for long/short), and routes it through the existing `_handleFundingRate` path — so `FundingRateTracker` accumulates it and existing drain-exit logic fires unchanged.

**Tech Stack:** TypeScript, better-sqlite3, coinbase-api `CBAdvancedTradeClient`, vitest fake timers

---

### Task 1: Add `fetchFundingRate()` to `IntxClient`

**Files:**
- Modify: `src/perp/intx-client.ts` (after `fetchFeeConfig`, ~line 311)
- Test: `src/perp/__tests__/intx-client.test.ts`

#### Context
`CBAdvancedTradeClient.getProduct({ product_id })` returns an `AdvTradeProduct` object. For perpetual futures the response includes:
```
future_product_details.perpetual_details.funding_rate  // string decimal, e.g. "0.0001"
```
The method must never throw — funding fetch failure must not crash the engine.

**Step 1: Write the failing test**

In `src/perp/__tests__/intx-client.test.ts`, add a new `describe('fetchFundingRate')` block:

```typescript
describe('fetchFundingRate', () => {
  it('returns parsed rate from perpetual_details.funding_rate', async () => {
    const client = makeTestClient();
    (client as any).restClient.getProduct = vi.fn().mockResolvedValue({
      future_product_details: {
        perpetual_details: { funding_rate: '0.0001' },
      },
    });
    const rate = await client.fetchFundingRate('BIP-20DEC30-CDE');
    expect(rate).toBeCloseTo(0.0001);
  });

  it('returns 0 when perpetual_details is absent', async () => {
    const client = makeTestClient();
    (client as any).restClient.getProduct = vi.fn().mockResolvedValue({
      future_product_details: {},
    });
    const rate = await client.fetchFundingRate('BIP-20DEC30-CDE');
    expect(rate).toBe(0);
  });

  it('returns 0 when getProduct throws', async () => {
    const client = makeTestClient();
    (client as any).restClient.getProduct = vi.fn().mockRejectedValue(new Error('network'));
    const rate = await client.fetchFundingRate('BIP-20DEC30-CDE');
    expect(rate).toBe(0);
  });
});
```

**Step 2: Run test to verify it fails**
```bash
cd A:/fun/trading-bot && npx vitest run src/perp/__tests__/intx-client.test.ts --reporter=verbose
```
Expected: FAIL — `client.fetchFundingRate is not a function`

**Step 3: Implement `fetchFundingRate`**

In `src/perp/intx-client.ts`, add after `fetchFeeConfig` (~line 311):

```typescript
/**
 * Fetch the current perpetual funding rate for a product via REST.
 *
 * Calls getProduct and parses future_product_details.perpetual_details.funding_rate.
 * Returns the rate as a decimal (e.g., 0.0001 = 0.01% per 8h funding period).
 * Returns 0 on any error or missing field — never throws.
 */
async fetchFundingRate(productId: string): Promise<number> {
  try {
    const product = await this.restClient.getProduct({ product_id: productId });
    const raw = (product as any)?.future_product_details?.perpetual_details?.funding_rate;
    if (!raw) return 0;
    const rate = parseFloat(String(raw));
    return Number.isFinite(rate) ? rate : 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ productId, err: message }, 'fetchFundingRate: REST call failed — returning 0');
    return 0;
  }
}
```

**Step 4: Run test to verify it passes**
```bash
cd A:/fun/trading-bot && npx vitest run src/perp/__tests__/intx-client.test.ts --reporter=verbose
```
Expected: all intx-client tests PASS

**Step 5: Commit**
```bash
git add src/perp/intx-client.ts src/perp/__tests__/intx-client.test.ts
git commit -m "feat(intx-client): add fetchFundingRate() via getProduct REST endpoint"
```

---

### Task 2: Extract `_handleFundingRate` method in `PaperPerpEngine`

**Files:**
- Modify: `src/perp/paper-perp-engine.ts`

#### Context
Currently `start()` assigns a long arrow function to `this._onFundingRate`. That logic needs to be callable from the paper funding timer too. This task extracts it to a named private method — **zero behavior change**, pure refactor.

**Step 1: Extract the handler body**

In `src/perp/paper-perp-engine.ts`:

1. Add a new private method `_handleFundingRate(evt: IntxFundingRateEvent): void` whose body is the entire current arrow function body inside `this._onFundingRate = (evt) => { ... }`.

2. Replace `this._onFundingRate`'s body with a single call:
```typescript
this._onFundingRate = (evt: IntxFundingRateEvent) => this._handleFundingRate(evt);
```

The complete `_handleFundingRate` method (copy verbatim from the arrow function):

```typescript
private _handleFundingRate(evt: IntxFundingRateEvent): void {
  if (evt.isStale) return;
  if (!this.currentPosition) {
    this.emit('fundingUpdate', {
      sessionId: null,
      instrument: this.config.btcProductId,
      currentFundingRate: evt.fundingRate,
      cumulativeFundingCost: '0.00000000',
      cumulativeFundingPct: '0.00000000',
    });
    return;
  }
  const session = this.currentPosition.session;
  const update = this._fundingRateTracker.onFundingEvent(evt, session);
  const unrealizedPnl = this._computeUnrealizedPnl(session, update.cumulativeFundingCost);
  this.stateStore.updateSession(session.id, {
    cumulativeFundingCost: update.cumulativeFundingCost,
    unrealizedPnl,
  });
  this.emit('fundingUpdate', {
    sessionId: session.id,
    instrument: session.instrument,
    currentFundingRate: update.currentFundingRate,
    cumulativeFundingCost: update.cumulativeFundingCost,
    cumulativeFundingPct: update.cumulativeFundingPct,
    unrealizedPnl,
  });
  if (update.drainTriggered && !this._fundingDrainInProgress && !this._emergencyCloseInProgress) {
    this._fundingDrainInProgress = true;
    log.warn(
      { sessionId: session.id, cumulativeFundingPct: update.cumulativeFundingPct },
      'FUNDING_DRAIN_EXIT triggered',
    );
    this.emit('fundingDrain', session, { cumulativeFundingCost: update.cumulativeFundingCost });
    const markPrice = session.markPrice ?? session.entryPrice;
    try {
      this.closePaperPosition(markPrice, 'FUNDING_DRAIN_EXIT');
    } finally {
      this._fundingDrainInProgress = false;
    }
  }
}
```

**Step 2: Run all tests to verify no regressions**
```bash
cd A:/fun/trading-bot && npx vitest run --reporter=verbose 2>&1 | tail -8
```
Expected: all tests PASS (same count as before)

**Step 3: Commit**
```bash
git add src/perp/paper-perp-engine.ts
git commit -m "refactor(perp-engine): extract _handleFundingRate method (no behavior change)"
```

---

### Task 3: Add paper funding simulation timer to `PaperPerpEngine`

**Files:**
- Modify: `src/perp/paper-perp-engine.ts`
- Modify: `src/perp/__tests__/paper-perp-engine.test.ts`

#### Context
`makeIntxClient()` in the test file needs `fetchFundingRate` added so tests don't crash when the engine calls it. The new tests use `vi.useFakeTimers()` to advance the clock without waiting real time.

**Payment sign convention** (critical — get this wrong and long positions appear to earn funding):
- Funding rate > 0 means longs pay shorts
  - Long:  payment = `-(rate × notional)` — negative = paying = drain possible
  - Short: payment = `+(rate × notional)` — positive = receiving
- Funding rate < 0 means shorts pay longs (reverse of above)

**Step 1: Update `makeIntxClient()` mock in test file**

In `src/perp/__tests__/paper-perp-engine.test.ts`, add `fetchFundingRate` to the returned mock:

```typescript
function makeIntxClient() {
  const emitter = new EventEmitter();
  const placeOrder = vi.fn().mockResolvedValue({ ... });    // unchanged
  const cancelOrder = vi.fn().mockResolvedValue(undefined); // unchanged
  const fetchFundingRate = vi.fn().mockResolvedValue(0);    // ADD THIS
  return Object.assign(emitter, { placeOrder, cancelOrder, fetchFundingRate }) as any;
}
```

**Step 2: Write the failing tests**

Add a new `describe('paper funding simulation')` block at the end of `src/perp/__tests__/paper-perp-engine.test.ts`:

```typescript
describe('paper funding simulation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits fundingUpdate after one interval when position is open and rate is non-zero', async () => {
    const intxClient = makeIntxClient();
    const stateStore = makeStateStore();
    const config = makeConfig();
    intxClient.fetchFundingRate = vi.fn().mockResolvedValue(0.0001); // 0.01% rate

    const engine = new PaperPerpEngine({
      intxClient, stateStore, config,
      paperFundingIntervalMs: 1000,
    });
    engine.start();
    await engine.openPaperPosition(config.btcProductId, 'long', '0.01', 5, '80000');

    const updates: any[] = [];
    engine.on('fundingUpdate', (u) => updates.push(u));

    await vi.advanceTimersByTimeAsync(1000);

    expect(updates.length).toBeGreaterThanOrEqual(1);
    // Long pays when rate > 0 → cumulativeFundingCost is negative
    expect(parseFloat(updates[0].cumulativeFundingCost)).toBeLessThan(0);
    engine.stop();
  });

  it('does not emit fundingUpdate when no position is open', async () => {
    const intxClient = makeIntxClient();
    const stateStore = makeStateStore();
    const config = makeConfig();
    intxClient.fetchFundingRate = vi.fn().mockResolvedValue(0.0001);

    const engine = new PaperPerpEngine({
      intxClient, stateStore, config,
      paperFundingIntervalMs: 1000,
    });
    engine.start();

    const fundingUpdatesWithSession: any[] = [];
    engine.on('fundingUpdate', (u) => { if (u.sessionId !== null) fundingUpdatesWithSession.push(u); });

    await vi.advanceTimersByTimeAsync(1000);

    expect(fundingUpdatesWithSession).toHaveLength(0);
    engine.stop();
  });

  it('short position receives funding (positive cost) when rate is positive', async () => {
    const intxClient = makeIntxClient();
    const stateStore = makeStateStore();
    const config = makeConfig();
    intxClient.fetchFundingRate = vi.fn().mockResolvedValue(0.0001);

    const engine = new PaperPerpEngine({
      intxClient, stateStore, config,
      paperFundingIntervalMs: 1000,
    });
    engine.start();
    await engine.openPaperPosition(config.btcProductId, 'short', '0.01', 5, '80000');

    const updates: any[] = [];
    engine.on('fundingUpdate', (u) => updates.push(u));

    await vi.advanceTimersByTimeAsync(1000);

    expect(updates.length).toBeGreaterThanOrEqual(1);
    // Short receives when rate > 0 → cumulativeFundingCost is positive
    expect(parseFloat(updates[0].cumulativeFundingCost)).toBeGreaterThan(0);
    engine.stop();
  });

  it('does not emit when fetchFundingRate returns 0', async () => {
    const intxClient = makeIntxClient();
    const stateStore = makeStateStore();
    const config = makeConfig();
    intxClient.fetchFundingRate = vi.fn().mockResolvedValue(0);

    const engine = new PaperPerpEngine({
      intxClient, stateStore, config,
      paperFundingIntervalMs: 1000,
    });
    engine.start();
    await engine.openPaperPosition(config.btcProductId, 'long', '0.01', 5, '80000');

    const updates: any[] = [];
    engine.on('fundingUpdate', (u) => { if (u.sessionId !== null) updates.push(u); });

    await vi.advanceTimersByTimeAsync(1000);

    expect(updates).toHaveLength(0);
    engine.stop();
  });

  it('clears timer on stop()', async () => {
    const intxClient = makeIntxClient();
    const stateStore = makeStateStore();
    const config = makeConfig();
    intxClient.fetchFundingRate = vi.fn().mockResolvedValue(0.0001);

    const engine = new PaperPerpEngine({
      intxClient, stateStore, config,
      paperFundingIntervalMs: 1000,
    });
    engine.start();
    await engine.openPaperPosition(config.btcProductId, 'long', '0.01', 5, '80000');
    engine.stop();

    const updates: any[] = [];
    engine.on('fundingUpdate', (u) => { if (u.sessionId !== null) updates.push(u); });

    // Advance past where timer would have fired — should not fire since stopped
    await vi.advanceTimersByTimeAsync(5000);

    expect(updates).toHaveLength(0);
  });
});
```

**Step 3: Run tests to verify they fail**
```bash
cd A:/fun/trading-bot && npx vitest run src/perp/__tests__/paper-perp-engine.test.ts --reporter=verbose 2>&1 | grep "paper funding"
```
Expected: FAIL — `paperFundingIntervalMs` unknown, timer not implemented

**Step 4: Implement paper funding timer**

In `src/perp/paper-perp-engine.ts`:

**4a.** Add to `PaperPerpEngineOptions`:
```typescript
/**
 * Interval between simulated funding payments in ms.
 * Defaults to 28_800_000 (8 hours) — matches real perpetual funding cadence.
 * Override to a shorter value in tests.
 */
paperFundingIntervalMs?: number;
```

**4b.** Add private fields (after `_fundingDrainInProgress`):
```typescript
private _paperFundingTimer: ReturnType<typeof setInterval> | null = null;
private readonly _paperFundingIntervalMs: number;
```

**4c.** Add to constructor (after `this.feedHealthMonitor = ...`):
```typescript
this._paperFundingIntervalMs = options.paperFundingIntervalMs ?? 28_800_000;
```

**4d.** Add to `start()`, after the reconnected listener:
```typescript
// Paper funding simulation: apply 8h funding payment on each interval
this._paperFundingTimer = setInterval(() => {
  void this._applyPaperFunding();
}, this._paperFundingIntervalMs);
```

**4e.** Add to `stop()`, before `this._started = false`:
```typescript
if (this._paperFundingTimer) {
  clearInterval(this._paperFundingTimer);
  this._paperFundingTimer = null;
}
```

**4f.** Add the `_applyPaperFunding()` method (place it after `_handleFundingRate`):
```typescript
/**
 * Simulate one funding payment for the current open position.
 *
 * Called by setInterval every paperFundingIntervalMs (default 8 h).
 * Fetches the live funding rate from the Coinbase REST API and calculates
 * the dollar payment for the current position size and mark price.
 *
 * Sign convention:
 *   rate > 0 → longs pay shorts: long payment is negative (cost), short is positive (income)
 *   rate < 0 → shorts pay longs: short payment is negative (cost), long is positive (income)
 */
private async _applyPaperFunding(): Promise<void> {
  if (!this.currentPosition) return;
  const session = this.currentPosition.session;

  const rate = await this.intxClient.fetchFundingRate(session.instrument);
  if (rate === 0) return;

  const markPrice = session.markPrice ?? session.entryPrice;
  const notional = parseFloat(session.size) * parseFloat(markPrice);
  const sign = session.direction === 'long' ? -1 : 1;
  const payment = sign * rate * notional;

  log.info(
    {
      sessionId: session.id,
      instrument: session.instrument,
      fundingRate: rate,
      notional: notional.toFixed(2),
      payment: payment.toFixed(8),
    },
    '[PAPER] Simulated funding payment applied',
  );

  this._handleFundingRate({
    instrument: 'FCM',
    fundingRate: payment.toFixed(8),
    isFinal: true,
    timestamp: Date.now(),
    isStale: false,
  });
}
```

**4g.** Add `fetchFundingRate` to the `IntxClient` type used by the engine — check that `IntxClient` interface includes this method (it should after Task 1).

**Step 5: Run tests to verify they pass**
```bash
cd A:/fun/trading-bot && npx vitest run src/perp/__tests__/paper-perp-engine.test.ts --reporter=verbose 2>&1 | tail -20
```
Expected: all paper-perp-engine tests PASS including the new `paper funding simulation` block

**Step 6: Run full suite**
```bash
cd A:/fun/trading-bot && npx vitest run 2>&1 | tail -6
```
Expected: all tests PASS

**Step 7: Commit**
```bash
git add src/perp/paper-perp-engine.ts src/perp/__tests__/paper-perp-engine.test.ts
git commit -m "feat(perp-engine): simulate 8h funding payments in paper mode

Fetches live per-instrument funding rate from Coinbase getProduct REST
endpoint every 8 hours (configurable via paperFundingIntervalMs).
Calculates signed dollar payment (long pays when rate > 0, short receives)
and routes through existing FundingRateTracker so drain-exit logic fires."
```
