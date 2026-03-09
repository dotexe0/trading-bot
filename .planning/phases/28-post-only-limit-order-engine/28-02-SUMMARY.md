---
phase: 28-post-only-limit-order-engine
plan: "02"
subsystem: perp
tags:
  - trailing-stop
  - take-profit
  - order-lifecycle
  - ratchet
  - cleanup
dependency_graph:
  requires:
    - 28-01  # PerpOrderEngine base, IntxClient, FCM user channel
  provides:
    - TrailingStopManager (pure ratchet, src/perp/trailing-stop.ts)
    - placePostFillOrders() on PerpOrderEngine (TP + trailing stop placement)
    - closeAndCleanup() on PerpOrderEngine (cancel all open orders on close)
    - PerpPositionManager wired to closeAndCleanup on all close paths
  affects:
    - src/perp/order-engine.ts
    - src/perp/intx-client.ts
    - src/perp/position-manager.ts
    - src/perp/index.ts
tech_stack:
  added: []
  patterns:
    - ratchet guard with _ratchetInProgress + _pendingMarkPrice queue
    - persist-before-API-call idempotency on all order placements
    - optional dependency injection (orderEngine in PerpPositionManager)
    - EventEmitter markPrice listener for ratchet loop with explicit attach/detach
key_files:
  created:
    - src/perp/trailing-stop.ts
  modified:
    - src/perp/order-engine.ts
    - src/perp/intx-client.ts
    - src/perp/position-manager.ts
    - src/perp/index.ts
decisions:
  - "28-02: TrailingStopManager is a pure class (no EventEmitter, no I/O) — caller drives ratchet loop in order-engine.ts"
  - "28-02: executeEmergencyClose delegates to closePosition() — single cleanup call in closePosition covers both normal and emergency close paths"
  - "28-02: placePostFillOrders TP failure is logged but does not block stop placement — stop is more critical for risk management"
  - "28-02: closeAndCleanup cancels by tracked exchange IDs + DB query for TAKE_PROFIT/STOP_LOSS orders — covers ratcheted stops that created new DB records"
metrics:
  duration: "~4 minutes"
  completed: "2026-03-09"
  tasks: 3
  files: 5
---

# Phase 28 Plan 02: Post-Fill Order Lifecycle Summary

ATR-based trailing stop-limit with ratchet logic, take-profit limit placement, and full order cleanup on position close — completing ORDER-03, ORDER-04, and ORDER-05.

## What Was Built

### Task 1: TrailingStopManager (src/perp/trailing-stop.ts)

Pure ratchet logic class with no I/O:

- `initialize(entryPrice, atr)` — sets initial stop ATR trail distance below entry (long) or above (short)
- `ratchet(markPrice, atr)` — returns new stop state only when price moves favorably; never retreats
- Thread-safety via `_ratchetInProgress` guard + `_pendingMarkPrice` queue
- `_computeLimit()` — limit price = stopPrice ± slippage for stop-limit orders
- All arithmetic via `d()` (Decimal.js) — no floats

### Task 2: Extended PerpOrderEngine (src/perp/order-engine.ts)

Three new capabilities added to `PerpOrderEngine`:

**A. `placePostFillOrders(session, atr)`**
- Places TP limit order (LIMIT, no post_only — taker OK for close orders)
- TP price: long = entry * (1 + tpTargetPct/100), short = entry * (1 - tpTargetPct/100)
- Initializes TrailingStopManager, places initial stop-limit order (stop_limit_stop_limit_gtc)
- Idempotent: `_tpOrderPlaced` flag + DB check prevents double-placement
- TP failure logged but does not block stop placement
- Persist-before-API-call on both TP and stop orders

**B. Ratchet loop (_startRatchetLoop / _stopRatchetLoop)**
- Attaches to `intxClient.markPrice` events
- On each favorable price: cancel old stop → place new stop → update DB
- `_ratchetLoopActive` flag, clean detach via `removeListener` on `_stopRatchetLoop`
- `setCurrentAtr(atr)` public method for orchestrator to push updated ATR values

**C. `closeAndCleanup(sessionId)`**
- Stops ratchet loop
- Batch cancels TP and stop orders by tracked exchange IDs
- Marks all TAKE_PROFIT/STOP_LOSS orders CANCELLED in DB
- Resets state flags

Also added `placeStopOrder()` to `IntxClient` for stop_limit_stop_limit_gtc orders with configurable stop_direction.

Exports added to `src/perp/index.ts`: `TrailingStopManager`, `TrailingStopState`.

### Task 3: PerpPositionManager Wiring (src/perp/position-manager.ts)

- `orderEngine?: PerpOrderEngine` added to `PerpPositionManagerOptions`
- `_orderEngine: PerpOrderEngine | null` instance field
- `closePosition()` now calls `this._orderEngine.closeAndCleanup(session.id)` before marking session closed
- Covers both normal close path and emergency close path (`executeEmergencyClose` delegates to `closePosition`)
- Guard `if (this._orderEngine)` — class remains usable without orderEngine

## Decisions Made

1. **Pure class for TrailingStopManager** — no EventEmitter, no I/O. The ratchet loop lives in `order-engine.ts` where it has access to API calls. This keeps the math testable in isolation.

2. **Single cleanup point in closePosition()** — `executeEmergencyClose` already delegates to `closePosition('EMERGENCY_CLOSE')`, so wiring cleanup in `closePosition` covers both paths without double-cleanup risk.

3. **TP failure does not block stop** — The trailing stop is the critical risk-management order. If TP placement fails, we log the error but still place the stop.

4. **closeAndCleanup uses both tracked IDs and DB query** — The tracked exchange IDs (`_tpExchangeOrderId`, `_stopExchangeOrderId`) cover the currently active orders. The DB query for TAKE_PROFIT/STOP_LOSS purpose covers any ratcheted stop orders that were placed as new DB records during the session.

## Deviations from Plan

None — plan executed exactly as written.

## Verification

- `npx tsc --noEmit` passes with 0 errors (excluding pre-existing dashboard/ui JSX errors unrelated to this plan)
- `TrailingStopManager.initialize()` sets stop below entry for long, above for short ✓
- `ratchet()` returns null when mark price does not improve stop; returns new state when favorable ✓
- Stop never retreats (long: only increases; short: only decreases) ✓
- `placePostFillOrders()` places TP (limit_limit_gtc) and stop (stop_limit_stop_limit_gtc) ✓
- `_tpOrderPlaced` guard prevents double-placement ✓
- Ratchet loop active after `placePostFillOrders()` ✓
- `closeAndCleanup()` cancels both TP and stop, stops ratchet loop ✓
- `intx-client.ts`: `placeStopOrder()` uses stop_limit_stop_limit_gtc with stop_direction ✓
- `position-manager.ts`: constructor accepts optional orderEngine ✓
- Both positionClosed and emergencyClose paths call `orderEngine.closeAndCleanup()` ✓
- `index.ts`: `TrailingStopManager`, `TrailingStopState`, `PerpOrderEngine` all exported ✓

## Self-Check: PASSED

Files verified:
- `src/perp/trailing-stop.ts` — FOUND
- `src/perp/order-engine.ts` — FOUND (placePostFillOrders, setCurrentAtr, closeAndCleanup present)
- `src/perp/intx-client.ts` — FOUND (placeStopOrder present)
- `src/perp/position-manager.ts` — FOUND (closeAndCleanup wired in closePosition)
- `src/perp/index.ts` — FOUND (TrailingStopManager, TrailingStopState exported)

Commits verified:
- `2d30aed` feat(28-02): add TrailingStopManager pure ratchet logic
- `900daa8` feat(28-02): extend PerpOrderEngine with post-fill orders, ratchet loop, cleanup
- `6ec5a24` feat(28-02): wire closeAndCleanup() into PerpPositionManager close paths
