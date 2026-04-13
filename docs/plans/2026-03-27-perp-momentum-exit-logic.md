# Perp-Momentum Exit Logic Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add exit signal logic to `PerpMomentumStrategy` so the perp engine closes positions instead of holding them indefinitely.

**Architecture:** Make `PerpMomentumStrategy` stateful — track open direction, entry breakout level, and candle count. On each `evaluate()` call, check exit conditions first (bypassing the volume gate); only check entries when no position is open. Exit conditions: (1) close retraces back through the entry breakout level (breakout failed), (2) max hold candle limit reached (time stop). After an exit, do not re-enter on the same candle. The backtest engine calls `registry.create()` per run, so fresh instances are created for each tournament window — no `reset()` needed.

**Tech Stack:** TypeScript, Vitest, existing `IndicatorEngine`/`extractVolumes` utils

---

### Task 1: Add exit parameters to `PerpMomentumParams`

**Files:**
- Modify: `src/perp/strategies/perp-momentum.ts:25-36`

**Step 1: Write the failing test**

In `src/perp/strategies/__tests__/perp-momentum.test.ts`, add to the `constructor` describe block:

```typescript
it('accepts maxHoldCandles param and reflects it in construction', () => {
  const strat = new PerpMomentumStrategy({
    breakoutWindow: 5,
    volumeWindow: 5,
    volumeMultiplier: 1.5,
    fundingThreshold: 0.01,
    fundingRateProvider: makeFundingProvider(null),
    maxHoldCandles: 10,
  });
  expect(strat.name).toBe('perp-momentum'); // construction succeeds
});
```

**Step 2: Run test to confirm it fails**

```bash
cd A:/fun/trading-bot && npx vitest run src/perp/strategies/__tests__/perp-momentum.test.ts 2>&1 | tail -20
```

Expected: TypeScript compile error — `maxHoldCandles` not in `PerpMomentumParams`.

**Step 3: Add `maxHoldCandles` to `PerpMomentumParams` and constructor**

In `src/perp/strategies/perp-momentum.ts`, update the interface and constructor:

```typescript
interface PerpMomentumParams {
  breakoutWindow: number;
  volumeWindow: number;
  volumeMultiplier: number;
  fundingThreshold: number;
  fundingRateProvider: () => number | null;
  /** Max candles to hold a position before forcing close (time stop). Default: 20. */
  maxHoldCandles?: number;
}
```

Add private field and constructor assignment:
```typescript
private readonly maxHoldCandles: number;

// in constructor:
this.maxHoldCandles = config.maxHoldCandles ?? 20;
```

**Step 4: Run test to confirm it passes**

```bash
cd A:/fun/trading-bot && npx vitest run src/perp/strategies/__tests__/perp-momentum.test.ts 2>&1 | tail -20
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/perp/strategies/perp-momentum.ts src/perp/strategies/__tests__/perp-momentum.test.ts
git commit -m "feat(perp-momentum): add maxHoldCandles param (default 20)"
```

---

### Task 2: Add position state fields

**Files:**
- Modify: `src/perp/strategies/perp-momentum.ts` (class body)

**Step 1: Write the failing test**

Add a new describe block `position state tracking` in the test file:

```typescript
describe('position state tracking', () => {
  it('starts with no open position — first evaluate on breakout emits long, not close', () => {
    const strat = new PerpMomentumStrategy({
      breakoutWindow: 5, volumeWindow: 5, volumeMultiplier: 1.5,
      fundingThreshold: 0.01, fundingRateProvider: makeFundingProvider(null),
    });
    const candles = makeBreakoutCandles(8);
    const signals = strat.evaluate(candles, 'BTC-USD', '1h');
    expect(signals.some((s) => s.direction === 'close')).toBe(false);
    expect(signals.some((s) => s.direction === 'long')).toBe(true);
  });
});
```

**Step 2: Run test — confirm it passes already** (no state yet, so close is never emitted — this test should already pass)

```bash
cd A:/fun/trading-bot && npx vitest run src/perp/strategies/__tests__/perp-momentum.test.ts 2>&1 | tail -20
```

Expected: PASS (baseline check)

**Step 3: Add state fields to `PerpMomentumStrategy`**

Add three private mutable fields after the existing `private readonly` fields:

```typescript
// ── Position state (mutable — tracks open position across candle calls) ──
private _openDirection: 'long' | 'short' | null = null;
private _entryLevel: number = 0;   // resistanceLevel for long, supportLevel for short
private _candlesHeld: number = 0;
```

**Step 4: Run full test suite to confirm no regressions**

```bash
cd A:/fun/trading-bot && npx vitest run src/perp/strategies/__tests__/perp-momentum.test.ts 2>&1 | tail -20
```

Expected: all existing tests PASS (state fields are unused so far, no behavior change)

**Step 5: Commit**

```bash
git add src/perp/strategies/perp-momentum.ts
git commit -m "feat(perp-momentum): add position state fields (_openDirection, _entryLevel, _candlesHeld)"
```

---

### Task 3: Implement exit logic (reversal + time stop)

**Files:**
- Modify: `src/perp/strategies/perp-momentum.ts` (the `evaluate()` method)
- Modify: `src/perp/strategies/__tests__/perp-momentum.test.ts` (add exit tests)

**Step 1: Write the failing exit tests**

Add these to the `position state tracking` describe block:

```typescript
it('emits close when long and close drops back below entry resistance level', () => {
  const strat = new PerpMomentumStrategy({
    breakoutWindow: 5, volumeWindow: 5, volumeMultiplier: 1.5,
    fundingThreshold: 0.01, fundingRateProvider: makeFundingProvider(null),
    maxHoldCandles: 20,
  });

  // Candle 1-8: bullish breakout — opens long, entry resistance = 101
  const entryCandles = makeBreakoutCandles(8);
  // priorCandles for a breakout at makeBreakoutCandles: prior highs are all 101
  // so resistanceLevel = 101. long is entered, _entryLevel = 101.
  const entrySignals = strat.evaluate(entryCandles, 'BTC-USD', '1h');
  expect(entrySignals.some((s) => s.direction === 'long')).toBe(true);

  // Next candle: close = 99 (below entry resistance 101) → should emit close
  const exitCandles = [
    ...entryCandles,
    {
      pair: 'BTC-USD' as TradingPair,
      timeframe: '1h' as Timeframe,
      timestamp: entryCandles[entryCandles.length - 1].timestamp + 3_600_000,
      open: '99', high: '100', low: '98', close: '99',
      volume: '100',
    },
  ];
  const exitSignals = strat.evaluate(exitCandles, 'BTC-USD', '1h');
  expect(exitSignals.some((s) => s.direction === 'close')).toBe(true);
  expect(exitSignals.some((s) => s.direction === 'long')).toBe(false); // no re-entry same candle
});

it('emits close when short and close rises back above entry support level', () => {
  const strat = new PerpMomentumStrategy({
    breakoutWindow: 5, volumeWindow: 5, volumeMultiplier: 1.5,
    fundingThreshold: 0.01, fundingRateProvider: makeFundingProvider(null),
    maxHoldCandles: 20,
  });

  // Candle 1-8: bearish breakdown — opens short, entry support = 99
  const entryCandles = makeBreakdownCandles(8);
  const entrySignals = strat.evaluate(entryCandles, 'BTC-USD', '1h');
  expect(entrySignals.some((s) => s.direction === 'short')).toBe(true);

  // Next candle: close = 101 (above entry support 99) → should emit close
  const exitCandles = [
    ...entryCandles,
    {
      pair: 'BTC-USD' as TradingPair,
      timeframe: '1h' as Timeframe,
      timestamp: entryCandles[entryCandles.length - 1].timestamp + 3_600_000,
      open: '101', high: '102', low: '100', close: '101',
      volume: '100',
    },
  ];
  const exitSignals = strat.evaluate(exitCandles, 'BTC-USD', '1h');
  expect(exitSignals.some((s) => s.direction === 'close')).toBe(true);
  expect(exitSignals.some((s) => s.direction === 'short')).toBe(false);
});

it('emits close after maxHoldCandles exceeded even if price stays above entry level', () => {
  const strat = new PerpMomentumStrategy({
    breakoutWindow: 5, volumeWindow: 5, volumeMultiplier: 1.5,
    fundingThreshold: 0.01, fundingRateProvider: makeFundingProvider(null),
    maxHoldCandles: 3,
  });

  // Enter long
  const entryCandles = makeBreakoutCandles(8);
  strat.evaluate(entryCandles, 'BTC-USD', '1h');

  // Hold 3 candles above entry level (close = 130, entry resistance = 101 — stays above)
  let candles = entryCandles;
  let lastSignals: Signal[] = [];
  for (let i = 0; i < 3; i++) {
    candles = [
      ...candles,
      {
        pair: 'BTC-USD' as TradingPair,
        timeframe: '1h' as Timeframe,
        timestamp: candles[candles.length - 1].timestamp + 3_600_000,
        open: '130', high: '131', low: '129', close: '130',
        volume: '100',
      },
    ];
    lastSignals = strat.evaluate(candles, 'BTC-USD', '1h');
  }
  // After maxHoldCandles=3 holding candles, the 3rd should emit close
  expect(lastSignals.some((s) => s.direction === 'close')).toBe(true);
});

it('after close, re-entry fires on the next breakout candle', () => {
  const strat = new PerpMomentumStrategy({
    breakoutWindow: 5, volumeWindow: 5, volumeMultiplier: 1.5,
    fundingThreshold: 0.01, fundingRateProvider: makeFundingProvider(null),
    maxHoldCandles: 20,
  });

  // Enter long
  const entryCandles = makeBreakoutCandles(8);
  strat.evaluate(entryCandles, 'BTC-USD', '1h');

  // Exit: close drops below entry level
  const exitCandles = [
    ...entryCandles,
    {
      pair: 'BTC-USD' as TradingPair,
      timeframe: '1h' as Timeframe,
      timestamp: entryCandles[entryCandles.length - 1].timestamp + 3_600_000,
      open: '99', high: '100', low: '98', close: '99',
      volume: '100',
    },
  ];
  strat.evaluate(exitCandles, 'BTC-USD', '1h');

  // Re-entry: new breakout candle with volume spike
  const reentryCandles = [
    ...exitCandles,
    {
      pair: 'BTC-USD' as TradingPair,
      timeframe: '1h' as Timeframe,
      timestamp: exitCandles[exitCandles.length - 1].timestamp + 3_600_000,
      open: '101', high: '140', low: '100', close: '135',
      volume: '400',
    },
  ];
  const reentrySignals = strat.evaluate(reentryCandles, 'BTC-USD', '1h');
  expect(reentrySignals.some((s) => s.direction === 'long')).toBe(true);
  expect(reentrySignals.some((s) => s.direction === 'close')).toBe(false);
});
```

**Step 2: Run tests to confirm they fail**

```bash
cd A:/fun/trading-bot && npx vitest run src/perp/strategies/__tests__/perp-momentum.test.ts --reporter=verbose 2>&1 | grep -E "FAIL|✓|×|close"
```

Expected: 4 new tests FAIL (no close signals emitted yet)

**Step 3: Implement exit logic in `evaluate()`**

Replace the current `evaluate()` body in `src/perp/strategies/perp-momentum.ts`. The new structure:

```typescript
evaluate(
  candles: Candle[],
  pair: TradingPair,
  timeframe: Timeframe,
  _additionalCandles?: Map<Timeframe, Candle[]>,
  _regime?: unknown,
): Signal[] {
  // 1. Length guard
  if (candles.length < this.minCandles) return [];

  // 2. Build priorCandles (exclude current to avoid lookahead on levels)
  const priorCandles = candles.slice(0, -1);
  if (priorCandles.length < this.breakoutWindow) return [];

  // 3. Compute Highest and Lowest on prior candles
  const highestResult = this.engine.compute(
    { name: 'Highest', period: this.breakoutWindow },
    priorCandles,
  );
  const lowestResult = this.engine.compute(
    { name: 'Lowest', period: this.breakoutWindow },
    priorCandles,
  );
  const highestValues = highestResult.values as number[];
  const lowestValues = lowestResult.values as number[];
  if (highestValues.length === 0 || lowestValues.length === 0) return [];

  const resistanceLevel = highestValues[highestValues.length - 1];
  const supportLevel = lowestValues[lowestValues.length - 1];

  const lastCandle = candles[candles.length - 1];
  const currentClose = parseFloat(lastCandle.close);
  const currentHigh = parseFloat(lastCandle.high);
  const currentLow = parseFloat(lastCandle.low);
  const timestamp = lastCandle.timestamp;

  // ── 4. EXIT CHECK (runs before volume gate — exits don't need volume) ──
  if (this._openDirection !== null) {
    this._candlesHeld++;

    const reversalExit =
      (this._openDirection === 'long' && currentClose < this._entryLevel) ||
      (this._openDirection === 'short' && currentClose > this._entryLevel);
    const timeStop = this._candlesHeld >= this.maxHoldCandles;

    if (reversalExit || timeStop) {
      const reason = timeStop && !reversalExit ? 'TimeStop' : 'ReversalExit';
      this._openDirection = null;
      this._entryLevel = 0;
      this._candlesHeld = 0;
      return [{
        strategyName: this.name,
        pair,
        timeframe,
        timestamp,
        direction: 'close',
        confidence: 1,
        reasoning: `${reason}: close=${currentClose.toFixed(2)}, entryLevel=${this._entryLevel === 0 ? 'reset' : this._entryLevel.toFixed(2)}`,
      }];
    }
  }

  // ── 5. ENTRY CHECK (only when no open position) ────────────────────
  if (this._openDirection !== null) return []; // already in position, no exit triggered → hold

  // 6. Volume gate (entry-only)
  const volumes = extractVolumes(candles);
  const recentVolumes = volumes.slice(-this.volumeWindow);
  const avgVolume = recentVolumes.reduce((sum, v) => sum + v, 0) / recentVolumes.length;
  const currentVolume = volumes[volumes.length - 1];
  const volumeConfirmed = currentVolume >= avgVolume * this.volumeMultiplier;
  if (!volumeConfirmed) return [];

  // 7. Get funding rate
  const fundingRate = this.fundingRateProvider();

  const signals: Signal[] = [];

  // 8. LONG entry
  if (currentHigh > resistanceLevel) {
    const rawConfidence = Math.min((currentHigh - resistanceLevel) / resistanceLevel * 20, 1);
    const { confidence, fundingNote } = this._applyFundingAdjustment(rawConfidence, 'long', fundingRate);
    const baseReasoning = `Breakout above ${this.breakoutWindow}-candle high ${resistanceLevel.toFixed(2)}. High=${currentHigh.toFixed(2)}, Volume=${currentVolume.toFixed(0)} (${(currentVolume / avgVolume).toFixed(2)}x avg)`;
    signals.push({
      strategyName: this.name, pair, timeframe, timestamp,
      direction: 'long', confidence,
      reasoning: fundingNote ? `${baseReasoning}. ${fundingNote}` : baseReasoning,
    });
    this._openDirection = 'long';
    this._entryLevel = resistanceLevel;
    this._candlesHeld = 0;
  }

  // 9. SHORT entry
  if (currentLow < supportLevel) {
    const rawConfidence = Math.min((supportLevel - currentLow) / supportLevel * 20, 1);
    const { confidence, fundingNote } = this._applyFundingAdjustment(rawConfidence, 'short', fundingRate);
    const baseReasoning = `Breakdown below ${this.breakoutWindow}-candle low ${supportLevel.toFixed(2)}. Low=${currentLow.toFixed(2)}, Volume=${currentVolume.toFixed(0)} (${(currentVolume / avgVolume).toFixed(2)}x avg)`;
    signals.push({
      strategyName: this.name, pair, timeframe, timestamp,
      direction: 'short', confidence,
      reasoning: fundingNote ? `${baseReasoning}. ${fundingNote}` : baseReasoning,
    });
    // Only set state for short if long wasn't already set on this candle
    if (this._openDirection === null) {
      this._openDirection = 'short';
      this._entryLevel = supportLevel;
      this._candlesHeld = 0;
    }
  }

  return signals;
}
```

**Important:** Fix the reasoning string bug in the close signal — capture `_entryLevel` BEFORE resetting it:

```typescript
if (reversalExit || timeStop) {
  const reason = timeStop && !reversalExit ? 'TimeStop' : 'ReversalExit';
  const capturedEntryLevel = this._entryLevel; // capture before reset
  this._openDirection = null;
  this._entryLevel = 0;
  this._candlesHeld = 0;
  return [{
    strategyName: this.name,
    pair, timeframe, timestamp,
    direction: 'close',
    confidence: 1,
    reasoning: `${reason}: close=${currentClose.toFixed(2)}, entryLevel=${capturedEntryLevel.toFixed(2)}`,
  }];
}
```

**Step 4: Run exit tests**

```bash
cd A:/fun/trading-bot && npx vitest run src/perp/strategies/__tests__/perp-momentum.test.ts --reporter=verbose 2>&1 | tail -30
```

Expected: all 4 new tests PASS

**Step 5: Commit**

```bash
git add src/perp/strategies/perp-momentum.ts src/perp/strategies/__tests__/perp-momentum.test.ts
git commit -m "feat(perp-momentum): implement exit logic — reversal and time-stop close signals"
```

---

### Task 4: Fix the broken "stateless" test

The existing test `"evaluate with N candles then same N candles again produces identical results (stateless)"` now fails because the strategy is stateful — after the first call emits a `long`, the state is `_openDirection='long'`, so the second call with the same candles evaluates exit conditions instead.

**Files:**
- Modify: `src/perp/strategies/__tests__/perp-momentum.test.ts`

**Step 1: Run the full suite to see what breaks**

```bash
cd A:/fun/trading-bot && npx vitest run src/perp/strategies/__tests__/perp-momentum.test.ts --reporter=verbose 2>&1 | grep -E "FAIL|✗|×"
```

**Step 2: Replace the broken "stateless" test with a "determinism" test**

Find the test:
```typescript
it('evaluate with N candles then same N candles again produces identical results (stateless)', ...
```

Replace with:
```typescript
it('two fresh instances evaluate identically for the same candle sequence (deterministic)', () => {
  const makeStrat = () => new PerpMomentumStrategy({
    breakoutWindow: 5, volumeWindow: 5, volumeMultiplier: 1.5,
    fundingThreshold: 0.01, fundingRateProvider: makeFundingProvider(null),
  });
  const candles = makeBreakoutCandles(8);
  expect(makeStrat().evaluate(candles, 'BTC-USD', '1h'))
    .toEqual(makeStrat().evaluate(candles, 'BTC-USD', '1h'));
});

it('state accumulates correctly across sequential candle calls on the same instance', () => {
  const strat = new PerpMomentumStrategy({
    breakoutWindow: 5, volumeWindow: 5, volumeMultiplier: 1.5,
    fundingThreshold: 0.01, fundingRateProvider: makeFundingProvider(null),
    maxHoldCandles: 20,
  });
  // First call: no position — breakout candles → long signal emitted
  const entryCandles = makeBreakoutCandles(8);
  const sig1 = strat.evaluate(entryCandles, 'BTC-USD', '1h');
  expect(sig1.some((s) => s.direction === 'long')).toBe(true);

  // Second call with SAME candles: position is now 'long' → no re-entry (hold)
  const sig2 = strat.evaluate(entryCandles, 'BTC-USD', '1h');
  expect(sig2.some((s) => s.direction === 'long')).toBe(false);
  expect(sig2.some((s) => s.direction === 'close')).toBe(false); // still above entry level
});
```

**Step 3: Run suite**

```bash
cd A:/fun/trading-bot && npx vitest run src/perp/strategies/__tests__/perp-momentum.test.ts --reporter=verbose 2>&1 | tail -20
```

Expected: all tests PASS

**Step 4: Commit**

```bash
git add src/perp/strategies/__tests__/perp-momentum.test.ts
git commit -m "test(perp-momentum): replace stateless test with determinism + statefulness tests"
```

---

### Task 5: Update registry defaults to pass `maxHoldCandles`

Both `createPerpRegistry` and `createLivePerpRegistry` in `src/perp/strategies/index.ts` need to pass `maxHoldCandles` so the value is configurable per strategy config and has a sensible default.

**Files:**
- Modify: `src/perp/strategies/index.ts:38-47` and `:102-111`

**Step 1: Write a test that verifies the registry creates a working strategy**

Add to `src/perp/strategies/__tests__/perp-momentum.test.ts`:

```typescript
import { createPerpRegistry } from '../index.js';

describe('registry integration', () => {
  it('createPerpRegistry produces a perp-momentum strategy that emits close signals', () => {
    const registry = createPerpRegistry();
    const strat = registry.create({ strategy: 'perp-momentum' });

    // Enter long
    const entryCandles = makeBreakoutCandles(8);
    const entrySigs = strat.evaluate(entryCandles, 'BTC-USD', '1h');
    expect(entrySigs.some((s) => s.direction === 'long')).toBe(true);

    // Exit: price drops below resistance
    const exitCandles = [
      ...entryCandles,
      {
        pair: 'BTC-USD' as TradingPair,
        timeframe: '1h' as Timeframe,
        timestamp: entryCandles[entryCandles.length - 1].timestamp + 3_600_000,
        open: '99', high: '100', low: '98', close: '99',
        volume: '100',
      },
    ];
    const exitSigs = strat.evaluate(exitCandles, 'BTC-USD', '1h');
    expect(exitSigs.some((s) => s.direction === 'close')).toBe(true);
  });
});
```

**Step 2: Run test — confirm it passes** (registry already delegates to the constructor, which now has exit logic)

```bash
cd A:/fun/trading-bot && npx vitest run src/perp/strategies/__tests__/perp-momentum.test.ts --reporter=verbose 2>&1 | tail -20
```

Expected: PASS (no registry changes needed for exit logic — but we want to allow `maxHoldCandles` to be passed via `StrategyConfig`)

**Step 3: Update both registry factories to forward `maxHoldCandles` if present in config**

In `src/perp/strategies/index.ts`, update both `createPerpRegistry` and `createLivePerpRegistry` perp-momentum entries:

```typescript
registry.register('perp-momentum', (c: StrategyConfig) => {
  const cfg = c as Extract<StrategyConfig, { strategy: 'perp-momentum' }>;
  return new PerpMomentumStrategy({
    breakoutWindow: cfg.breakoutWindow ?? 20,
    volumeWindow: cfg.volumeWindow ?? 20,
    volumeMultiplier: cfg.volumeMultiplier ?? 1.5,
    fundingThreshold: cfg.fundingThreshold ?? 0.01,
    fundingRateProvider: () => null, // tournament-safe (same as before)
    maxHoldCandles: (cfg as Record<string, unknown>).maxHoldCandles as number | undefined ?? 20,
  });
});
```

Apply the same change to the `createLivePerpRegistry` version (with `fundingRateProvider` wired to the live provider).

**Step 4: Run full suite**

```bash
cd A:/fun/trading-bot && npx vitest run src/perp/strategies/__tests__/perp-momentum.test.ts --reporter=verbose 2>&1 | tail -20
```

Expected: all tests PASS

**Step 5: Commit**

```bash
git add src/perp/strategies/index.ts
git commit -m "feat(perp-registry): forward maxHoldCandles to PerpMomentumStrategy in both registry factories"
```

---

### Task 6: Run full test suite and verify no regressions

**Step 1: Run all perp tests**

```bash
cd A:/fun/trading-bot && npx vitest run src/perp --reporter=verbose 2>&1 | tail -40
```

Expected: all PASS

**Step 2: Run all project tests**

```bash
cd A:/fun/trading-bot && npm test 2>&1 | tail -30
```

Expected: all PASS — zero regressions

**Step 3: If any failures, fix them before committing**

Common regression to watch for: any test that constructs `PerpMomentumStrategy` without `maxHoldCandles` — that's fine, it defaults to 20. The only tests that need updating are those that relied on the "same instance, same candles → same result" property (statefulness tests).

**Step 4: Final commit if only test file changes**

```bash
git add -p  # stage only test fixes
git commit -m "test(perp): fix any remaining statefulness-related test regressions"
```
