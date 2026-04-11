# Scoring, Sizing, and Monitoring Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add tournament quality filters (Sortino/Calmar), ATR-based volatility sizing, exponential drawdown recovery scaling, trade journal metadata, and rolling drift detection.

**Architecture:** Five independent phases that compose together. Phase 1 adds metrics + filters to tournament scoring. Phase 2 adds ATR input to PositionSizer for risk-per-trade sizing. Phase 3 adds exponential recovery scaling via MaxDrawdownRule. Phase 4 adds strategy/regime/exit_reason columns to trade tables. Phase 5 adds a DriftDetector that monitors rolling performance against tournament baseline. All features are opt-in with kill switches.

**Tech Stack:** TypeScript, Vitest, Zod, decimal.js, better-sqlite3/Drizzle, React

---

## Task 1: Add Sortino and Calmar ratios to PerformanceMetrics

**Files:**
- Modify: `src/backtest/metrics.ts:16-43` (PerformanceMetrics interface)
- Modify: `src/backtest/metrics.ts:53-74` (calculate method)
- Test: `src/backtest/__tests__/metrics.test.ts`

**Step 1: Write failing tests for Sortino and Calmar**

Add to `src/backtest/__tests__/metrics.test.ts`:

```typescript
describe('Sortino ratio', () => {
  it('computes Sortino using only downside deviation', () => {
    // Equity curve: 10000 -> 10100 -> 10050 -> 10200 -> 10150 -> 10300
    // Daily returns: +1%, -0.5%, +1.49%, -0.49%, +1.48%
    // Only negative returns: -0.5%, -0.49% contribute to downside dev
    const calc = new MetricsCalculator();
    const equityCurve: EquityPoint[] = [
      { timestamp: 0, equity: d(10000) },
      { timestamp: DAY_MS, equity: d(10100) },
      { timestamp: DAY_MS * 2, equity: d(10050) },
      { timestamp: DAY_MS * 3, equity: d(10200) },
      { timestamp: DAY_MS * 4, equity: d(10150) },
      { timestamp: DAY_MS * 5, equity: d(10300) },
    ];

    const result = calc.calculate(
      makeResult({ equityCurve, trades: [makeTrade(300)] }),
      '10000',
    );

    // Sortino should be > Sharpe because downside dev < total stddev
    expect(result.sortinoRatio).toBeGreaterThan(result.sharpeRatio);
    expect(result.sortinoRatio).toBeGreaterThan(0);
  });

  it('returns 0 when no downside deviation', () => {
    // All positive returns
    const equityCurve: EquityPoint[] = [
      { timestamp: 0, equity: d(10000) },
      { timestamp: DAY_MS, equity: d(10100) },
      { timestamp: DAY_MS * 2, equity: d(10200) },
    ];

    const result = calc.calculate(
      makeResult({ equityCurve, trades: [makeTrade(200)] }),
      '10000',
    );

    expect(result.sortinoRatio).toBe(0); // no downside = 0 (division by zero guard)
  });

  it('returns 0 with fewer than 2 equity points', () => {
    const result = calc.calculate(
      makeResult({ equityCurve: [{ timestamp: 0, equity: d(10000) }], trades: [] }),
      '10000',
    );
    expect(result.sortinoRatio).toBe(0);
  });
});

describe('Calmar ratio', () => {
  it('computes CAGR / maxDrawdownPct', () => {
    const result = calc.calculate(
      makeResult({
        equityCurve: [
          { timestamp: 0, equity: d(10000) },
          { timestamp: DAY_MS * 365, equity: d(12000) },
        ],
        trades: [makeTrade(2000)],
        startTimestamp: 0,
        endTimestamp: DAY_MS * 365,
      }),
      '10000',
    );

    // CAGR ~20%, maxDrawdownPct from the curve
    // Calmar = |CAGR| / maxDrawdownPct
    expect(result.calmarRatio).toBeGreaterThan(0);
  });

  it('returns 0 when maxDrawdownPct is zero', () => {
    // Monotonically increasing equity = no drawdown
    const result = calc.calculate(
      makeResult({
        equityCurve: [
          { timestamp: 0, equity: d(10000) },
          { timestamp: DAY_MS, equity: d(10100) },
          { timestamp: DAY_MS * 2, equity: d(10200) },
        ],
        trades: [makeTrade(200)],
      }),
      '10000',
    );

    expect(result.calmarRatio).toBe(0); // no drawdown = division by zero guard
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/backtest/__tests__/metrics.test.ts`
Expected: FAIL -- `sortinoRatio` and `calmarRatio` do not exist on PerformanceMetrics

**Step 3: Add Sortino and Calmar to PerformanceMetrics interface and calculate()**

In `src/backtest/metrics.ts`, add to `PerformanceMetrics` interface (after `sharpeRatio`):

```typescript
/** Annualized Sortino ratio using only downside deviation, sqrt(365) */
sortinoRatio: number;
/** Calmar ratio: |CAGR| / maxDrawdownPct */
calmarRatio: number;
```

Add to `calculate()` return object (after `sharpeRatio`):

```typescript
sortinoRatio: this.calcSortinoRatio(equityCurve),
calmarRatio: this.calcCalmarRatio(
  this.calcCAGR(finalEquity, capital, result.startTimestamp, result.endTimestamp),
  this.calcMaxDrawdown(equityCurve).percentage,
),
```

Add private methods:

```typescript
private calcSortinoRatio(equityCurve: EquityPoint[]): number {
  if (equityCurve.length < 2) return 0;

  const dailyEquity = this.resampleDaily(equityCurve);
  if (dailyEquity.length < 2) return 0;

  const dailyReturns: number[] = [];
  for (let i = 1; i < dailyEquity.length; i++) {
    const prev = dailyEquity[i - 1];
    const curr = dailyEquity[i];
    if (prev === 0) continue;
    dailyReturns.push((curr - prev) / prev);
  }

  if (dailyReturns.length < 2) return 0;

  const mean = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;

  // Downside deviation: only negative returns
  const downsideSquared = dailyReturns
    .filter(r => r < 0)
    .reduce((acc, r) => acc + r * r, 0);

  if (downsideSquared === 0) return 0;

  const downsideDev = Math.sqrt(downsideSquared / (dailyReturns.length - 1));

  return (mean / downsideDev) * Math.sqrt(365);
}

private calcCalmarRatio(cagr: Decimal, maxDrawdownPct: Decimal): number {
  if (maxDrawdownPct.isZero()) return 0;
  return cagr.abs().div(maxDrawdownPct).toNumber();
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/backtest/__tests__/metrics.test.ts`
Expected: PASS

**Step 5: Fix any downstream type errors from new PerformanceMetrics fields**

Run: `npx tsc --noEmit`

Any `makeMetrics()` helpers in test files will need `sortinoRatio: 0, calmarRatio: 0` added. Key files:
- `src/tournament/__tests__/tournament-runner.test.ts:19-36`

**Step 6: Commit**

```
git add src/backtest/metrics.ts src/backtest/__tests__/metrics.test.ts
git commit -m "feat: add Sortino and Calmar ratios to PerformanceMetrics"
```

---

## Task 2: Add quality filter thresholds to tournament config and runner

**Files:**
- Modify: `src/tournament/config.ts:14-54` (Zod schema)
- Modify: `src/tournament/tournament-runner.ts:186-202` (disqualification logic)
- Test: `src/tournament/__tests__/tournament-runner.test.ts`

**Step 1: Write failing tests for quality filters**

Add to `src/tournament/__tests__/tournament-runner.test.ts`. Tests should verify:
- Strategy with `profitFactor < 1.1` is disqualified with reason containing 'Profit factor'
- Strategy with `sortinoRatio < 0` is disqualified with reason containing 'Sortino'
- Strategy with `calmarRatio < 0.5` is disqualified with reason containing 'Calmar'
- Strategy meeting all thresholds is not disqualified
- Config with all-zero thresholds (`{ minSortino: 0, minCalmar: 0, minProfitFactor: 0 }`) disables filtering

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/tournament/__tests__/tournament-runner.test.ts`
Expected: FAIL -- qualityFilters not in config schema

**Step 3: Add qualityFilters to tournament config schema**

In `src/tournament/config.ts`, add inside `tournamentConfigSchema` (after `monteCarlo`):

```typescript
/** Quality filter thresholds -- strategies below any threshold are disqualified */
qualityFilters: z
  .object({
    /** Minimum OOS Sortino ratio. Default 0 (non-negative). */
    minSortino: z.number().default(0),
    /** Minimum OOS Calmar ratio. Default 0.5. */
    minCalmar: z.number().min(0).default(0.5),
    /** Minimum OOS profit factor. Default 1.1. */
    minProfitFactor: z.number().min(0).default(1.1),
  })
  .optional(),
```

**Step 4: Add quality filter logic to tournament-runner.ts**

In `src/tournament/tournament-runner.ts`, after the existing disqualification loop (line ~202) and before the `const qualified = ...` line, add:

```typescript
// Quality filter: disqualify strategies below metric thresholds
const qf = config.qualityFilters;
if (qf) {
  for (const entry of entries) {
    if (entry.disqualified) continue;

    if (qf.minSortino > 0 && entry.oosMetrics.sortinoRatio < qf.minSortino) {
      entry.disqualified = true;
      entry.disqualifyReason = `Sortino ${entry.oosMetrics.sortinoRatio.toFixed(2)} below min ${qf.minSortino}`;
    } else if (qf.minCalmar > 0 && entry.oosMetrics.calmarRatio < qf.minCalmar) {
      entry.disqualified = true;
      entry.disqualifyReason = `Calmar ${entry.oosMetrics.calmarRatio.toFixed(2)} below min ${qf.minCalmar}`;
    } else if (qf.minProfitFactor > 0 && entry.oosMetrics.profitFactor.toNumber() < qf.minProfitFactor) {
      entry.disqualified = true;
      entry.disqualifyReason = `Profit factor ${entry.oosMetrics.profitFactor.toFixed(2)} below min ${qf.minProfitFactor}`;
    }
  }
}
```

**Step 5: Run tests to verify they pass**

Run: `npx vitest run src/tournament/__tests__/tournament-runner.test.ts`
Expected: PASS

**Step 6: Run type check**

Run: `npx tsc --noEmit`

**Step 7: Commit**

```
git add src/tournament/config.ts src/tournament/tournament-runner.ts src/tournament/__tests__/tournament-runner.test.ts
git commit -m "feat: add quality filter thresholds (Sortino/Calmar/PF) to tournament"
```

---

## Task 3: Volatility-targeted position sizing

**Files:**
- Modify: `src/risk/types.ts:123-141` (RiskConfig)
- Modify: `src/risk/config.ts:13-57` (Zod schema)
- Modify: `src/risk/position-sizer.ts:40-95` (calculate method)
- Test: `src/risk/__tests__/position-sizer.test.ts`

**Step 1: Write failing tests for ATR-based sizing**

Add to `src/risk/__tests__/position-sizer.test.ts`:

```typescript
describe('volatility-targeted sizing', () => {
  it('uses ATR-based sizing when volatilitySizing enabled and ATR provided', () => {
    const config = makeRiskConfig({
      volatilitySizing: true,
      riskPerTradePct: 0.01,
      atrStopMultiple: 2.0,
    });
    const sizer = new PositionSizer(config);

    // equity=10000, price=50000, ATR=1000
    // riskAmount = 10000 * 0.01 = 100
    // stopDistance = 1000 * 2.0 = 2000
    // quantity = 100 / 2000 = 0.05
    const result = sizer.calculate(d(10000), d(50000), null, undefined, undefined, d(1000));
    expect(result.quantity.toNumber()).toBeCloseTo(0.05, 6);
  });

  it('produces larger position when ATR is low', () => {
    const config = makeRiskConfig({ volatilitySizing: true, riskPerTradePct: 0.01, atrStopMultiple: 2.0 });
    const sizer = new PositionSizer(config);

    const lowVol = sizer.calculate(d(10000), d(50000), null, undefined, undefined, d(500));
    const highVol = sizer.calculate(d(10000), d(50000), null, undefined, undefined, d(2000));

    expect(lowVol.quantity.toNumber()).toBeGreaterThan(highVol.quantity.toNumber());
  });

  it('falls back to fixed-fraction when ATR is undefined', () => {
    const config = makeRiskConfig({ volatilitySizing: true, riskPerTradePct: 0.01 });
    const sizer = new PositionSizer(config);

    const result = sizer.calculate(d(10000), d(50000), null);
    expect(result.method).toBe('fixed-fraction');
  });

  it('ignores ATR when volatilitySizing is false', () => {
    const config = makeRiskConfig({ volatilitySizing: false });
    const sizer = new PositionSizer(config);

    const withAtr = sizer.calculate(d(10000), d(50000), null, undefined, undefined, d(1000));
    const withoutAtr = sizer.calculate(d(10000), d(50000), null);
    expect(withAtr.quantity.toString()).toBe(withoutAtr.quantity.toString());
  });

  it('caps ATR-based size at maxPositionPct', () => {
    const config = makeRiskConfig({
      volatilitySizing: true,
      riskPerTradePct: 0.05,
      maxPositionPct: 0.25,
      atrStopMultiple: 2.0,
    });
    const sizer = new PositionSizer(config);

    // Very small ATR -> huge position -> should be capped
    const result = sizer.calculate(d(10000), d(50000), null, undefined, undefined, d(10));
    const maxQty = d(10000).mul(d(0.25)).div(d(50000));
    expect(result.quantity.lte(maxQty)).toBe(true);
    expect(result.cappedBy).toBe('maxPositionPct');
  });

  it('composes with confidence scaling', () => {
    const config = makeRiskConfig({
      volatilitySizing: true,
      riskPerTradePct: 0.01,
      confidenceFloor: 0.3,
      atrStopMultiple: 2.0,
    });
    const sizer = new PositionSizer(config);

    const full = sizer.calculate(d(10000), d(50000), null, undefined, 1.0, d(1000));
    const half = sizer.calculate(d(10000), d(50000), null, undefined, 0.5, d(1000));

    expect(half.quantity.toNumber()).toBeLessThan(full.quantity.toNumber());
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/risk/__tests__/position-sizer.test.ts`
Expected: FAIL -- `volatilitySizing` not in RiskConfig, calculate() doesn't accept 6th param

**Step 3: Add config fields**

In `src/risk/types.ts` `RiskConfig` interface, add:

```typescript
/** Enable ATR-based volatility-targeted position sizing. Default false. */
volatilitySizing?: boolean;
/** Risk per trade as fraction of equity (e.g., 0.01 = 1%). Used when volatilitySizing is true. */
riskPerTradePct?: number;
/** ATR multiple for stop distance calculation. Default 2.0. */
atrStopMultiple?: number;
```

In `src/risk/config.ts` Zod schema, add:

```typescript
/** Enable ATR-based volatility-targeted sizing. */
volatilitySizing: z.boolean().default(false),
/** Risk per trade as fraction of equity. Only used when volatilitySizing is true. */
riskPerTradePct: z.number().min(0.001).max(0.1).default(0.01),
/** ATR multiple for stop distance in volatility sizing. */
atrStopMultiple: z.number().min(0.5).max(5.0).default(2.0),
```

**Step 4: Add ATR param to PositionSizer.calculate()**

In `src/risk/position-sizer.ts`, modify `calculate()` signature to add 6th param `atr?: Decimal`.

Add ATR-based sizing at the top of the method, BEFORE the existing method selection block:

```typescript
let baseResult: PositionSizeResult;

// Volatility-targeted sizing: risk a fixed % of equity per trade
if (this.config.volatilitySizing && atr && atr.gt(ZERO)) {
  const riskPct = d(this.config.riskPerTradePct ?? 0.01);
  const atrMultiple = d(this.config.atrStopMultiple ?? 2.0);
  const stopDistance = atr.mul(atrMultiple);
  const riskAmount = equity.mul(riskPct);
  let quantity = riskAmount.div(stopDistance);
  let appliedPct = quantity.mul(price).div(equity);
  let cappedBy: string | undefined;

  if (appliedPct.gt(this.maxPositionPct)) {
    appliedPct = this.maxPositionPct;
    quantity = equity.mul(appliedPct).div(price);
    cappedBy = 'maxPositionPct';
  }

  baseResult = {
    method: 'fixed-fraction',
    rawKellyPct: ZERO,
    appliedPct,
    quantity,
    cappedBy,
  };
} else if (this.config.sizingMethod === 'fixed-fraction') {
  baseResult = this.fixedFraction(equity, price);
} else if (!this.canUseKelly(stats)) {
  baseResult = this.fixedFraction(equity, price);
} else {
  baseResult = this.kelly(equity, price, stats!);
}
```

**Step 5: Run tests to verify they pass**

Run: `npx vitest run src/risk/__tests__/position-sizer.test.ts`
Expected: PASS

**Step 6: Update makeRiskConfig helpers in other test files**

Any `makeRiskConfig()` that manually constructs RiskConfig needs the new optional fields. Check:
- `src/risk/__tests__/risk-manager.test.ts`
- `src/risk/__tests__/rules.test.ts`

**Step 7: Wire ATR into spot and perp engines**

In `src/spot/spot-trading-engine.ts`, where `positionSizer.calculate()` is called for entry sizing, compute ATR from the indicator engine and pass it as the 6th argument.

Same pattern in `src/perp/perp-trading-engine.ts` and `src/backtest/engine.ts`.

**Step 8: Run full test suite and type check**

Run: `npx tsc --noEmit && npx vitest run`
Expected: All pass

**Step 9: Commit**

```
git add src/risk/types.ts src/risk/config.ts src/risk/position-sizer.ts \
  src/risk/__tests__/position-sizer.test.ts \
  src/spot/spot-trading-engine.ts src/perp/perp-trading-engine.ts src/backtest/engine.ts
git commit -m "feat: ATR-based volatility-targeted position sizing"
```

---

## Task 4: Drawdown recovery scaling

**Files:**
- Modify: `src/risk/types.ts` (RiskConfig)
- Modify: `src/risk/config.ts` (Zod schema)
- Modify: `src/risk/rules/max-drawdown.ts` (getRecoveryScale)
- Modify: `src/risk/risk-manager.ts` (expose getDrawdownRecoveryScale)
- Test: new `src/risk/__tests__/drawdown-recovery.test.ts`

**Step 1: Write failing tests**

Create `src/risk/__tests__/drawdown-recovery.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { d } from '../../core/decimal.js';
import { MaxDrawdownRule } from '../rules/max-drawdown.js';
import type { RiskContext } from '../types.js';

function makeContext(equity: number, peak: number, maxDD = 0.10): RiskContext {
  return {
    signal: {
      strategyName: 'test', pair: 'BTC-USD', timeframe: '1h',
      timestamp: Date.now(), direction: 'long', confidence: 1,
    } as any,
    proposedQuantity: d(1),
    proposedPrice: d(50000),
    currentEquity: d(equity),
    peakEquity: d(peak),
    cashBalance: d(equity),
    openPositionCount: 0,
    totalExposure: d(0),
    dailyPnL: d(0),
    riskConfig: {
      sizingMethod: 'half-kelly', kellyFraction: 0.5, fixedFractionPct: 0.02,
      maxPositionPct: 0.25, minTradesForKelly: 30,
      stopLoss: { type: 'fixed', percentage: 0.05 },
      maxDrawdownPct: maxDD, maxDailyLossPct: 0.05, maxExposurePct: 0.95,
      maxPositionCount: 4, circuitBreakerCooldownMs: 0, confidenceFloor: 0.3,
      drawdownRecoveryScaling: true,
    } as any,
    timestamp: Date.now(),
  };
}

describe('MaxDrawdownRule.getRecoveryScale', () => {
  it('returns 1.0 at 0% drawdown', () => {
    const rule = new MaxDrawdownRule();
    rule.evaluate(makeContext(10000, 10000));
    expect(rule.getRecoveryScale(0.10, true)).toBeCloseTo(1.0);
  });

  it('returns ~0.75 at 5% drawdown with 10% maxDD', () => {
    const rule = new MaxDrawdownRule();
    rule.evaluate(makeContext(9500, 10000));
    expect(rule.getRecoveryScale(0.10, true)).toBeCloseTo(0.75, 2);
  });

  it('returns ~0.36 at 8% drawdown', () => {
    const rule = new MaxDrawdownRule();
    rule.evaluate(makeContext(9200, 10000));
    expect(rule.getRecoveryScale(0.10, true)).toBeCloseTo(0.36, 2);
  });

  it('returns 0 at maxDD', () => {
    const rule = new MaxDrawdownRule();
    rule.evaluate(makeContext(9000, 10000));
    expect(rule.getRecoveryScale(0.10, true)).toBeCloseTo(0.0, 2);
  });

  it('returns 1.0 when feature disabled', () => {
    const rule = new MaxDrawdownRule();
    rule.evaluate(makeContext(9500, 10000));
    expect(rule.getRecoveryScale(0.10, false)).toBe(1.0);
  });

  it('clamps scale to [0, 1]', () => {
    const rule = new MaxDrawdownRule();
    rule.evaluate(makeContext(8000, 10000)); // 20% DD > 10% maxDD
    const scale = rule.getRecoveryScale(0.10, true);
    expect(scale).toBeGreaterThanOrEqual(0);
    expect(scale).toBeLessThanOrEqual(1);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/risk/__tests__/drawdown-recovery.test.ts`
Expected: FAIL -- `getRecoveryScale` does not exist

**Step 3: Add config fields**

In `src/risk/types.ts` `RiskConfig`, add:

```typescript
/** Enable exponential drawdown recovery scaling. Default false. */
drawdownRecoveryScaling?: boolean;
```

In `src/risk/config.ts`, add:

```typescript
/** Gradually reduce position size as drawdown deepens. scale = 1 - (dd/maxDD)^2. */
drawdownRecoveryScaling: z.boolean().default(false),
```

**Step 4: Add getRecoveryScale() to MaxDrawdownRule**

In `src/risk/rules/max-drawdown.ts`, add method after `reset()`:

```typescript
/**
 * Get exponential recovery scale based on current drawdown.
 * Returns 1.0 if feature is disabled.
 */
getRecoveryScale(maxDrawdownPct: number, enabled: boolean): number {
  if (!enabled) return 1.0;
  if (maxDrawdownPct <= 0) return 1.0;

  const ddPct = this.lastDrawdownPct / 100;
  const ratio = ddPct / maxDrawdownPct;
  const scale = 1 - ratio * ratio;
  return Math.max(0, Math.min(1, scale));
}
```

**Step 5: Expose via RiskManager**

In `src/risk/risk-manager.ts`, add method:

```typescript
getDrawdownRecoveryScale(): number {
  return this.maxDrawdown.getRecoveryScale(
    this.config.maxDrawdownPct,
    this.config.drawdownRecoveryScaling ?? false,
  );
}
```

**Step 6: Run tests to verify they pass**

Run: `npx vitest run src/risk/__tests__/drawdown-recovery.test.ts`
Expected: PASS

**Step 7: Wire into engines**

In spot/perp/backtest engines, after `positionSizer.calculate()`, multiply quantity by recovery scale:

```typescript
const recoveryScale = this.riskManager.getDrawdownRecoveryScale();
if (recoveryScale < 1.0) {
  quantity = quantity.mul(d(recoveryScale));
}
```

**Step 8: Run full test suite and type check**

Run: `npx tsc --noEmit && npx vitest run`

**Step 9: Commit**

```
git add src/risk/types.ts src/risk/config.ts src/risk/rules/max-drawdown.ts \
  src/risk/risk-manager.ts src/risk/__tests__/drawdown-recovery.test.ts \
  src/spot/spot-trading-engine.ts src/perp/perp-trading-engine.ts src/backtest/engine.ts
git commit -m "feat: exponential drawdown recovery scaling"
```

---

## Task 5: Trade journal metadata columns

**Files:**
- Modify: `src/data/storage/schema.ts:58-80` (paperTrades table)
- Modify: `src/paper/session-store.ts:106-125` (recordTrade)
- Modify: `src/perp/perp-state-store.ts:21-35` (PerpTradeRecord -- add strategyName, regimeAtEntry)
- Modify: `src/spot/spot-trading-engine.ts:979-1048` (pass metadata)
- Modify: `src/perp/perp-trading-engine.ts:709-722` (pass metadata)
- Modify: `src/dashboard/ui/src/types.ts:60-81` (TradeData)
- Modify: `src/dashboard/ui/src/components/TradeHistory.tsx`
- Modify: `src/dashboard/server/routes/trades.ts`

**Step 1: Add columns to Drizzle schema**

In `src/data/storage/schema.ts` paperTrades table, add after `holdingPeriodMs`:

```typescript
strategyName: text('strategy_name'),
regimeAtEntry: text('regime_at_entry'),
exitReason: text('exit_reason'),
```

**Step 2: Add migration in SessionStore constructor**

In `src/paper/session-store.ts` constructor, after `initializeSchema()`:

```typescript
const migrateCols = [
  { col: 'strategy_name', type: 'TEXT' },
  { col: 'regime_at_entry', type: 'TEXT' },
  { col: 'exit_reason', type: 'TEXT' },
];
for (const { col, type } of migrateCols) {
  try {
    this.sqlite.exec(`ALTER TABLE paper_trades ADD COLUMN ${col} ${type}`);
  } catch {
    // Column already exists
  }
}
```

**Step 3: Update recordTrade to accept metadata**

In `src/paper/session-store.ts`, add optional 3rd param:

```typescript
recordTrade(
  sessionId: string,
  trade: Trade,
  metadata?: { strategyName?: string; regimeAtEntry?: string; exitReason?: string },
): void {
  this.db.insert(paperTrades).values({
    // ... existing fields ...
    strategyName: metadata?.strategyName ?? null,
    regimeAtEntry: metadata?.regimeAtEntry ?? null,
    exitReason: metadata?.exitReason ?? null,
  }).run();
}
```

**Step 4: Add strategyName and regimeAtEntry to PerpTradeRecord**

In `src/perp/perp-state-store.ts`, perp already has `closeReason`. Add:

```typescript
strategyName?: string;
regimeAtEntry?: string;
```

Add same ALTER TABLE migration in PerpStateStore constructor for `perp_trades` table: `strategy_name TEXT`, `regime_at_entry TEXT`.

**Step 5: Thread metadata from spot engine**

In `src/spot/spot-trading-engine.ts` `recordTrade()`, determine exit reason from `purpose` param:

```typescript
const exitReason = purpose === 'STOP_LOSS' ? 'STOP_LOSS'
  : purpose === 'PARTIAL_EXIT' ? 'PARTIAL_EXIT'
  : 'SIGNAL';
```

For exit-logic exits called at line 585 with `__exit-logic-${exitAction.reason}`, extract the reason from the strategy name prefix.

Pass to paper stateStore.recordTrade:
```typescript
this.stateStore.recordTrade(this.session.id, trade, {
  strategyName: this.strategy.name,
  regimeAtEntry: this.currentRegime ?? undefined,
  exitReason,
});
```

For live mode recordTrade call, add the same fields to the object literal.

**Step 6: Thread metadata from perp engine**

In `src/perp/perp-trading-engine.ts` `recordTrade()` call at line 709, add:

```typescript
strategyName: this.strategyController?.currentStrategyName,
regimeAtEntry: this.strategyController?.currentRegime,
```

**Step 7: Update dashboard TradeData type**

In `src/dashboard/ui/src/types.ts`, add to `TradeData`:

```typescript
regimeAtEntry?: string;
exitReason?: string;
```

(Note: `strategyName` already exists in TradeData)

**Step 8: Update TradeHistory component**

In `src/dashboard/ui/src/components/TradeHistory.tsx`:
- Add Strategy, Regime, Exit Reason columns
- Add strategy and regime dropdown filters
- Regime column colored: green=TRENDING, blue=RANGING, red=VOLATILE
- NULL values display as "--"

**Step 9: Update trade REST route**

In `src/dashboard/server/routes/trades.ts`, include `strategy_name`, `regime_at_entry`, `exit_reason` in SELECT and map to response fields.

**Step 10: Run full test suite and type check**

Run: `npx tsc --noEmit && npx vitest run`

**Step 11: Commit**

```
git add src/data/storage/schema.ts src/paper/session-store.ts \
  src/perp/perp-state-store.ts src/spot/spot-trading-engine.ts \
  src/perp/perp-trading-engine.ts src/dashboard/ui/src/types.ts \
  src/dashboard/ui/src/components/TradeHistory.tsx \
  src/dashboard/server/routes/trades.ts
git commit -m "feat: trade journal metadata (strategy, regime, exit reason)"
```

---

## Task 6: Rolling drift detection

**Files:**
- Create: `src/risk/drift-detector.ts`
- Modify: `src/risk/types.ts` (RiskConfig)
- Modify: `src/risk/config.ts` (Zod schema)
- Modify: `src/risk/index.ts` (export)
- Create: `src/risk/__tests__/drift-detector.test.ts`

**Step 1: Write failing tests**

Create `src/risk/__tests__/drift-detector.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { DriftDetector } from '../drift-detector.js';

describe('DriftDetector', () => {
  it('does not flag drift before window is full', () => {
    const dd = new DriftDetector({ windowSize: 5, sharpeThreshold: 0.5, winRateTolerance: 0.15 });
    dd.setBaseline({ sharpeRatio: 2.0, winRate: 0.6 });

    dd.recordTrade(0.01);
    dd.recordTrade(-0.005);
    dd.recordTrade(0.02);
    dd.recordTrade(0.015);

    expect(dd.checkDrift()).toBeNull();
  });

  it('detects Sharpe drift when rolling Sharpe drops below threshold', () => {
    const dd = new DriftDetector({ windowSize: 5, sharpeThreshold: 0.5, winRateTolerance: 0.15 });
    dd.setBaseline({ sharpeRatio: 2.0, winRate: 0.6 });

    for (let i = 0; i < 5; i++) dd.recordTrade(-0.02);

    const drift = dd.checkDrift();
    expect(drift).not.toBeNull();
    expect(drift!.type).toBe('sharpe');
  });

  it('detects win rate drift', () => {
    const dd = new DriftDetector({ windowSize: 5, sharpeThreshold: 0.5, winRateTolerance: 0.15 });
    dd.setBaseline({ sharpeRatio: 0.5, winRate: 0.7 });

    dd.recordTrade(0.01);
    dd.recordTrade(-0.01);
    dd.recordTrade(-0.01);
    dd.recordTrade(-0.01);
    dd.recordTrade(-0.01);

    const drift = dd.checkDrift();
    expect(drift).not.toBeNull();
    expect(drift!.type).toBe('winRate');
  });

  it('returns null when performance is acceptable', () => {
    const dd = new DriftDetector({ windowSize: 5, sharpeThreshold: 0.5, winRateTolerance: 0.15 });
    dd.setBaseline({ sharpeRatio: 1.0, winRate: 0.5 });

    dd.recordTrade(0.02);
    dd.recordTrade(0.01);
    dd.recordTrade(0.015);
    dd.recordTrade(-0.005);
    dd.recordTrade(0.02);

    expect(dd.checkDrift()).toBeNull();
  });

  it('setBaseline resets the window', () => {
    const dd = new DriftDetector({ windowSize: 3, sharpeThreshold: 0.5, winRateTolerance: 0.15 });
    dd.setBaseline({ sharpeRatio: 2.0, winRate: 0.7 });

    dd.recordTrade(-0.02);
    dd.recordTrade(-0.02);
    dd.recordTrade(-0.02);
    expect(dd.checkDrift()).not.toBeNull();

    dd.setBaseline({ sharpeRatio: -1.0, winRate: 0.1 });
    expect(dd.checkDrift()).toBeNull(); // window was reset, not full
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/risk/__tests__/drift-detector.test.ts`
Expected: FAIL -- module not found

**Step 3: Implement DriftDetector**

Create `src/risk/drift-detector.ts`:

```typescript
/**
 * DriftDetector -- monitors rolling trade performance against tournament baseline.
 *
 * Maintains a fixed-size window of recent trade returns. Once full,
 * compares rolling Sharpe and win rate against the OOS baseline.
 */

export interface DriftConfig {
  windowSize: number;
  sharpeThreshold: number;
  winRateTolerance: number;
}

export interface DriftBaseline {
  sharpeRatio: number;
  winRate: number;
}

export interface DriftResult {
  type: 'sharpe' | 'winRate';
  rolling: number;
  baseline: number;
  threshold: number;
}

export class DriftDetector {
  private readonly config: DriftConfig;
  private readonly window: number[] = [];
  private baseline: DriftBaseline | null = null;

  constructor(config: DriftConfig) {
    this.config = config;
  }

  setBaseline(baseline: DriftBaseline): void {
    this.baseline = baseline;
    this.window.length = 0;
  }

  recordTrade(returnPct: number): void {
    this.window.push(returnPct);
    if (this.window.length > this.config.windowSize) {
      this.window.shift();
    }
  }

  checkDrift(): DriftResult | null {
    if (!this.baseline) return null;
    if (this.window.length < this.config.windowSize) return null;

    const mean = this.window.reduce((a, b) => a + b, 0) / this.window.length;
    const variance = this.window.reduce((acc, r) => acc + (r - mean) ** 2, 0) / (this.window.length - 1);
    const stdDev = Math.sqrt(variance);
    const rollingSharpe = stdDev > 0 ? mean / stdDev : 0;
    const rollingAnnualized = rollingSharpe * Math.sqrt(365);

    const sharpeFloor = this.config.sharpeThreshold * this.baseline.sharpeRatio;
    if (rollingAnnualized < sharpeFloor) {
      return {
        type: 'sharpe',
        rolling: rollingAnnualized,
        baseline: this.baseline.sharpeRatio,
        threshold: sharpeFloor,
      };
    }

    const rollingWinRate = this.window.filter(r => r > 0).length / this.window.length;
    const winRateFloor = this.baseline.winRate - this.config.winRateTolerance;
    if (rollingWinRate < winRateFloor) {
      return {
        type: 'winRate',
        rolling: rollingWinRate,
        baseline: this.baseline.winRate,
        threshold: winRateFloor,
      };
    }

    return null;
  }
}
```

**Step 4: Add config to RiskConfig and Zod**

In `src/risk/types.ts`:

```typescript
driftDetection?: {
  enabled: boolean;
  windowSize: number;
  sharpeThreshold: number;
  winRateTolerance: number;
};
```

In `src/risk/config.ts`:

```typescript
driftDetection: z
  .object({
    enabled: z.boolean().default(false),
    windowSize: z.number().int().min(5).max(100).default(20),
    sharpeThreshold: z.number().min(0).max(1).default(0.5),
    winRateTolerance: z.number().min(0).max(0.5).default(0.15),
  })
  .optional(),
```

In `src/risk/index.ts`:

```typescript
export { DriftDetector } from './drift-detector.js';
export type { DriftConfig, DriftBaseline, DriftResult } from './drift-detector.js';
```

**Step 5: Run tests to verify they pass**

Run: `npx vitest run src/risk/__tests__/drift-detector.test.ts`
Expected: PASS

**Step 6: Wire into engines**

In spot and perp engines:
- Import DriftDetector
- Create instance in constructor if `riskConfig.driftDetection?.enabled`
- Call `setBaseline()` with tournament winner's OOS Sharpe and win rate
- Call `recordTrade(pnlPct)` on each trade close
- Check `checkDrift()` after recording. If non-null, emit `strategyDrift` event

**Step 7: Add WebSocket event mapping**

In `src/dashboard/server/index.ts`, add `strategyDrift` to ENGINE_EVENT_MAP for both spot and perp.

**Step 8: Add dashboard warning banner**

In `src/dashboard/ui/src/components/StrategiesPanel.tsx`:
- Listen for `strategyDrift` WebSocket message
- Show amber warning: "Strategy underperforming (rolling Sharpe: X vs baseline: Y)"
- Clear on `strategySwitch` event

**Step 9: Run full test suite and type check**

Run: `npx tsc --noEmit && npx vitest run`

**Step 10: Commit**

```
git add src/risk/drift-detector.ts src/risk/__tests__/drift-detector.test.ts \
  src/risk/types.ts src/risk/config.ts src/risk/index.ts \
  src/spot/spot-trading-engine.ts src/perp/perp-trading-engine.ts \
  src/dashboard/server/index.ts src/dashboard/ui/src/components/StrategiesPanel.tsx
git commit -m "feat: rolling strategy drift detection with dashboard warning"
```

---

## Final Verification

After all 6 tasks:

1. `npx tsc --noEmit` -- zero new type errors
2. `npx vitest run` -- all tests pass
3. Kill switches: `qualityFilters` omitted, `volatilitySizing: false`, `drawdownRecoveryScaling: false`, `driftDetection.enabled: false` -- all features disabled by default
4. Existing behavior unchanged when all features disabled
