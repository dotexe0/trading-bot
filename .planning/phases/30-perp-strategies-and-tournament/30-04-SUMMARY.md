---
phase: 30-perp-strategies-and-tournament
plan: "04"
subsystem: perp
tags: [perp, regime, strategy-switch, paper-engine, position-manager]
dependency_graph:
  requires: ["30-03"]
  provides: ["regime-auto-switch in PaperPerpEngine", "regime-auto-switch in PerpPositionManager"]
  affects: ["src/perp/paper-perp-engine.ts", "src/perp/position-manager.ts", "src/perp/types.ts"]
tech_stack:
  added: []
  patterns: ["regime-aware strategy auto-switch state machine (from LiveTradingEngine)"]
key_files:
  created: []
  modified:
    - src/perp/paper-perp-engine.ts
    - src/perp/position-manager.ts
    - src/perp/types.ts
decisions:
  - "30-04: PaperPerpEngine deferral guard uses this.currentPosition (PaperPerpPosition | null) — the correct field for paper engine open-position state"
  - "30-04: PerpPositionManager deferral guard uses this.currentSession (PerpSession | null) — consistent with all existing code in that class"
  - "30-04: pendingSwitch also fires in closePaperPosition/closePosition (not only in onCandle) so deferred switches execute immediately when position closes via mark-price triggers"
  - "30-04: strategySwitch event added to PerpPositionManagerEvents interface — required for typed emit() override to compile"
  - "30-04: Internal registry built via createLivePerpRegistry(fundingRateProvider ?? () => null) when regimeLeaderboards provided but no explicit strategyRegistry — callers may override by passing pre-built registry"
metrics:
  duration_seconds: 291
  completed_date: "2026-03-09"
  tasks_completed: 2
  files_changed: 3
---

# Phase 30 Plan 04: Regime Auto-Switch State Machine for Perp Engines Summary

Wired regime-aware strategy auto-switch into both PaperPerpEngine and PerpPositionManager, mirroring the pattern from LiveTradingEngine, with 10-candle cooldown and open-position deferral guard.

## What Was Built

### Task 1: Regime auto-switch in PaperPerpEngine

Added the full regime auto-switch state machine to `PaperPerpEngine`:

- New constructor options: `regimeLeaderboards`, `strategyRegistry`, `initialStrategy`, `fundingRateProvider`
- New public method: `onCandle(candle: Candle): void` — rolling 100-candle buffer, regime classification via `RegimeClassifier`, 10-candle cooldown, deferred switch when position open
- New private fields: `strategy`, `regimeLeaderboards`, `currentRegime`, `cooldownCandlesRemaining`, `pendingSwitch`, `strategyRegistry`, `classifier`, `candleBuffer`
- Module-level constant: `STRATEGY_SWITCH_COOLDOWN_CANDLES = 10`
- Private helpers: `resolveRegimeWinner(regime)`, `executeStrategySwitch(config)`
- Deferral guard uses `this.currentPosition === null` (PaperPerpPosition | null — the correct field)
- Pending switch fires both in `onCandle()` post-regime-check AND in `closePaperPosition()` when position closes via emergency close path
- Existing `onSignal` callback path remains unaffected
- `strategySwitch` event added to `PerpPositionManagerEvents` in `types.ts`

### Task 2: Regime auto-switch in PerpPositionManager

Mirrored identical state machine in `PerpPositionManager`:

- Same constructor options, fields, constant, and helpers
- `onCandle(candle: Candle): void` with identical regime classification and switch logic
- Deferral guard uses `this.currentSession === null` (PerpSession | null — the correct field for this class)
- Pending switch fires both in `onCandle()` AND in `closePosition()` when position closes
- Strategy signal evaluation routes to `openPosition`/`closePosition` without modifying those methods
- All existing `openPosition`, `closePosition`, `executeEmergencyClose`, `recoverFromRestart` methods unchanged

## Decisions Made

| Decision | Rationale |
|----------|-----------|
| `currentPosition` guard in PaperPerpEngine | PaperPerpEngine tracks state via `PaperPerpPosition | null`; using `currentSession` would be a type error |
| `currentSession` guard in PerpPositionManager | PerpPositionManager tracks state via `PerpSession | null`; plan explicitly required this distinction |
| `pendingSwitch` fires in close methods too | Emergency close and strategy-signal close bypass `onCandle()`, so the deferred switch must also fire there |
| `strategySwitch` added to `PerpPositionManagerEvents` | Typed `emit()` override requires all events to be in the interface; prevents TS compilation error |
| Internal `createLivePerpRegistry` when no registry supplied | Ensures funding adjustments fire at runtime even when caller doesn't explicitly provide a registry |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] Added `strategySwitch` to `PerpPositionManagerEvents`**
- **Found during:** Task 1
- **Issue:** `PaperPerpEngine.emit('strategySwitch', ...)` uses the typed `emit()` override which requires `strategySwitch` to be declared in `PerpPositionManagerEvents`. Without it, TypeScript compile would fail.
- **Fix:** Added `strategySwitch: [{ newStrategy: string }]` to the interface in `src/perp/types.ts`
- **Files modified:** `src/perp/types.ts`
- **Commit:** a6d50d4

**2. [Rule 1 - Bug] `pendingSwitch` also fires in `closePaperPosition`/`closePosition`**
- **Found during:** Tasks 1 and 2
- **Issue:** The plan's `onCandle()` pseudo-code checks `pendingSwitch` after the regime block. However, if a position is closed via emergency close (mark-price path, not `onCandle()`), the pending switch would never execute until the next candle. This breaks the "switch executes when the position closes" guarantee.
- **Fix:** Added `pendingSwitch` fire-and-clear block at the end of both `closePaperPosition()` and `closePosition()`.
- **Files modified:** `src/perp/paper-perp-engine.ts`, `src/perp/position-manager.ts`
- **Commits:** a6d50d4, b3a78ba

## Verification Results

```
npx tsc --noEmit  → 0 errors (excluding pre-existing dashboard/ui JSX config issues)
npx vitest run    → 728/728 tests pass (59 test files)

grep -n "pendingSwitch" src/perp/paper-perp-engine.ts src/perp/position-manager.ts  → appears in both
grep -n "onCandle" src/perp/paper-perp-engine.ts src/perp/position-manager.ts        → public method in both
grep -n "STRATEGY_SWITCH_COOLDOWN_CANDLES" ...                                        → constant in both files
grep -n "currentPosition" src/perp/paper-perp-engine.ts                              → deferral guard uses currentPosition
grep -n "currentSession" src/perp/position-manager.ts                                → deferral guard uses currentSession
```

## Self-Check: PASSED

- `src/perp/paper-perp-engine.ts` — exists, contains `onCandle`, `pendingSwitch`, `STRATEGY_SWITCH_COOLDOWN_CANDLES`
- `src/perp/position-manager.ts` — exists, contains `onCandle`, `pendingSwitch`, `STRATEGY_SWITCH_COOLDOWN_CANDLES`
- `src/perp/types.ts` — exists, contains `strategySwitch` in `PerpPositionManagerEvents`
- Commits: a6d50d4 (Task 1), b3a78ba (Task 2)
