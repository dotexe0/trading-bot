# Scoring, Sizing, and Monitoring Improvements (v3.1)

## Context

The bot has 50 phases shipped (v1.0-v3.0) with robust infrastructure. Five profitability improvements were just shipped (confidence-scaled sizing, regime-scaled stops, multi-timeframe confirmation, cross-asset signals, spot limit entries). This design covers the next tier: better strategy selection, smarter position sizing, and operational awareness.

---

## Phase 1: Better Tournament Scoring Metrics

**Approach**: Filter-then-rank. Add Sortino and Calmar to `PerformanceMetrics`. Use them plus existing profit factor as minimum quality thresholds. Strategies failing any threshold are disqualified before ranking by existing MC-adjusted Sharpe.

**New metrics in `MetricsCalculator`:**
- **Sortino ratio**: Same as Sharpe but denominator uses only negative return variance. `sortino = (mean / downsideDev) * sqrt(365)`
- **Calmar ratio**: `annualizedReturn / maxDrawdownPct`. Rewards high return relative to worst drawdown.

**Tournament filter thresholds** (added to tournament config with Zod schema):
- `minSortino: 0` (strategy shouldn't lose on a risk-adjusted downside basis)
- `minCalmar: 0.5` (return must be at least half the max drawdown)
- `minProfitFactor: 1.1` (gross wins must exceed gross losses by 10%)

Strategies failing any filter get `disqualified: true` with reason. Qualified strategies ranked by existing MC-adjusted Sharpe unchanged.

**Kill switch**: Set all thresholds to 0 (or omit from config -- defaults disable filtering).

**Changes**:

| File | Change |
|------|--------|
| `src/backtest/metrics.ts` | Add `sortinoRatio: number` and `calmarRatio: number` to `PerformanceMetrics`. Implement `calcSortinoRatio()` (downside deviation only) and `calcCalmarRatio()` (CAGR / maxDrawdownPct). |
| `src/tournament/config.ts` | Add `qualityFilters?: { minSortino, minCalmar, minProfitFactor }` to tournament config Zod schema with defaults that disable filtering. |
| `src/tournament/tournament-runner.ts` | After walk-forward, before ranking: disqualify strategies that fail any quality filter. Add filter reason to `disqualifyReason`. |
| `src/tournament/types.ts` | Add `sortinoRatio` and `calmarRatio` to `LeaderboardEntry` (sourced from OOS metrics). |

**Tests**: Sortino = 0 when no downside variance, Calmar = 0 when no drawdown, filter disqualifies low-PF strategy, filter passes good strategy, all-zero thresholds disable filtering.

---

## Phase 2: Volatility-Targeted Position Sizing (Fixed Risk Per Trade)

**Approach**: Each trade risks a fixed percentage of equity. Position size is derived from the ATR-based stop distance.

**Formula**:
```
riskAmount = equity * riskPerTradePct
stopDistance = ATR * atrMultiple
size = riskAmount / stopDistance
```

The sizing chain becomes:
1. **Base size**: `riskPerTradePct / stopDistance` (new -- ATR-based)
2. **Kelly cap**: If Kelly enabled and yields smaller size, use Kelly
3. **Confidence scale**: `size *= floor + (1 - floor) * confidence` (existing)
4. **Correlation discount**: `size *= correlationScalar` (existing)
5. **Drawdown recovery scale**: `size *= 1 - (dd/maxDD)^2` (new -- Phase 3)
6. **Max position cap**: Clamp to `maxPositionPct` (existing)

**Kill switch**: `volatilitySizing: false` (default) -- falls back to existing fixed-fraction/Kelly.

**Key constraint**: ATR may be unavailable (insufficient candle history). Fallback is existing fixed-fraction sizing.

**Changes**:

| File | Change |
|------|--------|
| `src/risk/types.ts` | Add `riskPerTradePct?: number` (default 0.01) and `volatilitySizing?: boolean` (default false) to `RiskConfig`. |
| `src/risk/config.ts` | Add Zod fields for both new config options. |
| `src/risk/position-sizer.ts` | Add 6th param `atr?: Decimal`. When `volatilitySizing=true` and ATR provided, compute base size as `equity * riskPerTradePct / (atr * atrMultiple)` instead of fixed-fraction. |
| `src/spot/spot-trading-engine.ts` | Pass current ATR from indicator buffer to `positionSizer.calculate()`. |
| `src/perp/perp-trading-engine.ts` | Same -- pass ATR to sizer. |
| `src/backtest/engine.ts` | Same -- pass ATR from indicator computation. |

**Tests**: ATR-based sizing produces larger position in low-vol, smaller in high-vol. Missing ATR falls back to fixed-fraction. volatilitySizing=false ignores ATR. ATR-based size still capped by maxPositionPct.

---

## Phase 3: Drawdown Recovery Scaling

**Approach**: Continuous exponential scaling that reduces position size as drawdown deepens.

**Formula**:
```
scale = 1 - (currentDrawdown / maxDrawdownPct) ^ 2
```

Examples with maxDrawdownPct = 10%:
- 0% drawdown: scale 1.0 (full size)
- 2% drawdown: scale 0.96
- 5% drawdown: scale 0.75
- 8% drawdown: scale 0.36
- 10% drawdown: scale 0.0 (circuit breaker trips)

Independent of the circuit breaker. The breaker still trips at maxDrawdownPct. Recovery scaling makes the approach gradual.

**Kill switch**: `drawdownRecoveryScaling: false` (default) -- `getRecoveryScale()` returns 1.0.

**Changes**:

| File | Change |
|------|--------|
| `src/risk/types.ts` | Add `drawdownRecoveryScaling?: boolean` (default false) to `RiskConfig`. |
| `src/risk/config.ts` | Add Zod field. |
| `src/risk/rules/max-drawdown.ts` | Add `getRecoveryScale(): number`. Uses already-tracked `lastDrawdownPct` and `maxDrawdownPct`. Returns `1 - (dd/maxDD)^2`, clamped to [0, 1]. Returns 1.0 if feature disabled. |
| `src/risk/risk-manager.ts` | Add `getDrawdownRecoveryScale(): number` that delegates to MaxDrawdownRule. |
| `src/spot/spot-trading-engine.ts` | After `positionSizer.calculate()`, multiply quantity by `riskManager.getDrawdownRecoveryScale()`. |
| `src/perp/perp-trading-engine.ts` | Same pattern. |
| `src/backtest/engine.ts` | Same pattern. |

**Tests**: 0% DD returns 1.0, 5% DD returns 0.75, 10% DD returns 0.0, feature disabled returns 1.0, scale correctly clamps to [0, 1].

---

## Phase 4: Trade Journal Enhancement

**Approach**: Add three columns to trade DB tables. Populate at recording time. Enhance existing TradeHistory dashboard panel.

**New columns** on `paper_trades` and `perp_trades`:
- `strategy_name TEXT` -- active strategy at entry
- `regime_at_entry TEXT` -- TRENDING/RANGING/VOLATILE at entry
- `exit_reason TEXT` -- SIGNAL, TRAILING_PROFIT, PARTIAL_EXIT, ATR_STOP, TIME_STOP, FUNDING_DRAIN, STOP_LOSS, MANUAL, EMERGENCY

**Changes**:

| File | Change |
|------|--------|
| `src/paper/session-store.ts` | ALTER TABLE ADD COLUMN for 3 fields. Update `recordTrade()` signature and INSERT. |
| `src/perp/perp-state-store.ts` | Same pattern for perp_trades. |
| `src/spot/spot-trading-engine.ts` | Pass strategy name, regime, and exit reason when recording trades. |
| `src/perp/perp-trading-engine.ts` | Same. |
| `src/backtest/engine.ts` | Same for backtest trade recording. |
| `src/dashboard/server/routes/trades.ts` | Include new fields in REST response. |
| `src/dashboard/ui/src/types.ts` | Add fields to trade type. |
| `src/dashboard/ui/src/components/TradeHistory.tsx` | Add Strategy, Regime, Exit Reason columns. Add strategy and regime dropdown filters. Regime uses color coding. Exit reason as compact badge. NULLs render as "--". |

**Tests**: Trade recorded with strategy/regime/exit_reason fields. Old trades with NULL fields don't break queries. REST API returns new fields.

---

## Phase 5: Strategy Parameter Drift Detection

**Approach**: Rolling performance window over last N trades. Compare against tournament OOS baseline. Emit warnings on degradation. Informational only -- no automatic action.

**Core component**: `DriftDetector` class.

**How it works**:
1. On each trade close, push return into rolling window (default 20 trades)
2. Once window full, compute rolling Sharpe and win rate
3. Compare against tournament OOS metrics:
   - Sharpe drift: rolling Sharpe < 0.5 * OOS Sharpe
   - Win rate drift: rolling win rate < OOS win rate - 0.15
4. If either true, emit `strategyDrift` event

**On drift**: Log WARN, emit event to dashboard. Dashboard shows amber warning banner on StrategiesPanel. No automatic switch.

**Kill switch**: `driftDetection.enabled: false` (default).

**Key constraint**: Window must be full (N trades) before any drift check fires.

**Changes**:

| File | Change |
|------|--------|
| New: `src/risk/drift-detector.ts` | `DriftDetector` class with `recordTrade()`, `setBaseline()`, `checkDrift()`. Rolling window of trade returns. |
| `src/risk/types.ts` | Add `driftDetection?: { enabled, windowSize, sharpeThreshold, winRateTolerance }` to `RiskConfig`. |
| `src/risk/config.ts` | Add Zod schema for drift detection config. |
| `src/risk/index.ts` | Export `DriftDetector`. |
| `src/spot/spot-trading-engine.ts` | Instantiate DriftDetector, call `recordTrade()` on close, `setBaseline()` from tournament. Emit `strategyDrift` on drift. |
| `src/perp/perp-trading-engine.ts` | Same. |
| `src/dashboard/server/index.ts` | Map `strategyDrift` event to WebSocket. |
| `src/dashboard/ui/src/components/StrategiesPanel.tsx` | Show amber warning banner on drift event. Clear on strategy switch. |

**Tests**: No drift with good performance. Drift detected when rolling Sharpe drops below threshold. No alert before window is full. Baseline update resets detection. Win rate drift detected independently.

---

## Sequencing

```
Phase 1 (tournament scoring) -- independent
Phase 2 (volatility sizing) -- independent
Phase 3 (drawdown recovery) -- independent, but sizes multiply with Phase 2
Phase 4 (trade journal) -- independent
Phase 5 (drift detection) -- depends on Phase 1 (needs Sortino/Calmar in metrics for richer baseline)
```

Phases 1-4 can be done in any order. Phase 5 after Phase 1.

## Verification

After each phase:
1. `npx tsc --noEmit` -- zero new type errors
2. `npx vitest run` -- all tests pass
3. Kill switch disables feature with no behavioral change
