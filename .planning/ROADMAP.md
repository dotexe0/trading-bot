# Roadmap: Crypto Trading Bot

## Milestones

- ✅ **v1.0 MVP** — Phases 1-11 (shipped 2026-02-19) — [Archive](milestones/v1.0-ROADMAP.md)
- ✅ **v1.1 Operational + Advanced** — Phases 12-16 (shipped 2026-02-26) — [Archive](milestones/v1.1-ROADMAP.md)
- ✅ **v1.2 Smarter Exits + Analytics** — Phases 17-18 (shipped 2026-02-28) — [Archive](milestones/v1.2-ROADMAP.md)
- ✅ **v1.3 Adaptive Intelligence** — Phases 19-25 (shipped 2026-03-08) — [Archive](milestones/v1.3-ROADMAP.md)
- 🚧 **v1.4 Perpetual Futures Trading** — Phases 26-33 (in progress)

## Phases

<details>
<summary>✅ v1.0 MVP (Phases 1-11) — SHIPPED 2026-02-19</summary>

- [x] Phase 1: Foundation & Data Pipeline (2/2 plans) — completed 2026-02-09
- [x] Phase 2: Indicator Engine (1/1 plan) — completed 2026-02-09
- [x] Phase 3: Strategy Framework (2/2 plans) — completed 2026-02-09
- [x] Phase 4: Backtesting Engine (2/2 plans) — completed 2026-02-10
- [x] Phase 5: Risk Management (2/2 plans) — completed 2026-02-10
- [x] Phase 6: Paper Trading (2/2 plans) — completed 2026-02-11
- [x] Phase 7: Live Trading (3/3 plans) — completed 2026-02-11
- [x] Phase 8: Tournament & Strategy Selection (2/2 plans) — completed 2026-02-12
- [x] Phase 9: Dashboard & Monitoring (3/3 plans) — completed 2026-02-17
- [x] Phase 10: Dashboard API Data Fixes (1/1 plan) — completed 2026-02-18
- [x] Phase 11: Dashboard WebSocket Pipeline (2/2 plans) — completed 2026-02-19

</details>

<details>
<summary>✅ v1.1 Operational + Advanced (Phases 12-16) — SHIPPED 2026-02-26</summary>

- [x] **Phase 12: CLI & Operations** (2/2 plans) — completed 2026-02-21
- [x] **Phase 13: Monte Carlo Simulation** (2/2 plans) — completed 2026-02-25
- [x] **Phase 14: Regime Detection** (2/2 plans) — completed 2026-02-25
- [x] **Phase 15: Correlation-Aware Sizing** (3/3 plans) — completed 2026-02-25
- [x] **Phase 16: Enhanced Dashboard** (3/3 plans) — completed 2026-02-26

</details>

<details>
<summary>✅ v1.2 Smarter Exits + Analytics (Phases 17-18) — SHIPPED 2026-02-28</summary>

- [x] **Phase 17: Exit Logic Engine** (3/3 plans) — completed 2026-02-27
- [x] **Phase 18: Performance Analytics** (2/2 plans) — completed 2026-02-28

</details>

<details>
<summary>✅ v1.3 Adaptive Intelligence (Phases 19-25) — SHIPPED 2026-03-08</summary>

- [x] **Phase 19: Indicator Additions** (1/1 plans) — completed 2026-03-01
- [x] **Phase 20: Mean Reversion Strategy** (2/2 plans) — completed 2026-03-01
- [x] **Phase 21: Momentum Breakout Strategy** (2/2 plans) — completed 2026-03-01
- [x] **Phase 22: Exit Config Optimizer** (2/2 plans) — completed 2026-03-02
- [x] **Phase 23: Regime-Aware Tournament** (2/2 plans) — completed 2026-03-07
- [x] **Phase 24: Live Strategy Auto-Switching** (3/3 plans) — completed 2026-03-08
- [x] **Phase 25: Pipeline Integration** (1/1 plans) — completed 2026-03-08

</details>

### 🚧 v1.4 Perpetual Futures Trading (In Progress)

**Milestone Goal:** Add Coinbase INTX perpetual futures (BTC-PERP, ETH-PERP) as a second trading system running alongside existing spot. Post-only limit order entries with cancel-and-reprice logic, ATR-based trailing stop-limit exits, configurable leverage with regime-driven margin mode, two perp-specific IStrategy-compatible strategies evaluated in the existing tournament, funding rate tracking with hold-time exit trigger, separate analytics, and three new dashboard panels.

- [ ] **Phase 26: INTX API Client** — Coinbase INTX REST + WebSocket connectivity, credentials, account balance, and real-time mark/index/funding streams for BTC-PERP and ETH-PERP
- [ ] **Phase 27: Perp Position Execution** — Open/close long and short positions, liquidation price calculation, paper perp mode, crash recovery and reconciliation, emergency close on low liquidation distance
- [ ] **Phase 28: Post-Only Limit Order Engine** — Cancel-and-reprice entry loop, immediate take-profit limit order after fill, ATR-based trailing stop-limit, and full order cleanup on position close
- [ ] **Phase 29: Leverage and Margin Risk Layer** — Configurable leverage with regime-driven sizing, isolated/cross margin mode switching, per-trade max loss and total exposure cap enforcement
- [ ] **Phase 30: Perp Strategies and Tournament** — Two perp-specific IStrategy implementations generating LONG/SHORT signals with funding-rate confidence adjustment, evaluated in existing tournament pipeline with separate perp leaderboard
- [ ] **Phase 31: Funding Rate Tracking** — Real-time cumulative funding cost per position, P&L component logging, and funding-drain exit trigger
- [ ] **Phase 32: Perp Analytics and CLI Report** — Separate SQLite table for perp trade records, `npm run report` perp section with directional win rate and funding stats, enforced P&L separation from spot
- [ ] **Phase 33: Dashboard Perp Panels** — Open positions panel with live unrealized P&L and liquidation price, real-time funding rate display, and leverage utilization meter

---

#### Phase 26: INTX API Client

**Goal:** The bot can authenticate to Coinbase INTX and stream live market data for BTC-PERP and ETH-PERP, independently of the existing Advanced Trade integration.

**Depends on:** Phase 25 (existing spot system is the integration baseline)

**Requirements:** INTX-01, INTX-02, INTX-03, INTX-04

**Success Criteria** (what must be TRUE):
1. Bot connects to INTX REST and WebSocket using a separate credential set stored in `.env`; existing Advanced Trade credentials are not shared or affected
2. `npm run perp:status` (or equivalent CLI) prints current INTX account balance, available margin, and any open positions from a live or testnet account
3. WebSocket subscription streams real-time mark price, index price, and 8-hour funding rate for both BTC-PERP and ETH-PERP; values update on each event and are observable in logs
4. All INTX API interactions are encapsulated behind a typed `IntxClient` interface, keeping INTX code isolated from the Advanced Trade code path

**Plans:** 2 plans

Plans:
- [ ] 26-01-PLAN.md — Perp module foundation: types, config schema with fail-fast validation, IntxClient REST account query and order stubs, unit tests
- [ ] 26-02-PLAN.md — WebSocket RISK + FUNDING stream with exponential backoff reconnect, stale-data flagging, and perp:status CLI command

---

#### Phase 27: Perp Position Execution

**Goal:** The bot can open and close long and short positions on INTX, calculates and logs liquidation price before every entry, and recovers correctly from crashes.

**Depends on:** Phase 26 (INTX connectivity required)

**Requirements:** PERP-01, PERP-02, PERP-03, PERP-04, RISK-03, RISK-04

**Success Criteria** (what must be TRUE):
1. Bot opens a long or short position on BTC-PERP or ETH-PERP and the resulting position is visible in the INTX account (or testnet simulation in paper mode)
2. Liquidation price is computed and logged before every entry; the log line includes instrument, direction, entry price, leverage, and liquidation price
3. Paper perp mode completes a full round-trip (open → fill → close) using mark-price simulation without touching live INTX funds
4. After a simulated crash and restart, the bot reconciles with INTX, restores open position state, and resumes without duplicating orders
5. Bot triggers an emergency close and logs a `LIQUIDATION_RISK` warning when liquidation distance falls below the configured safety threshold

**Plans:** TBD

Plans:
- [ ] 27-01: Perp position manager — open/close long/short, liquidation price calc, liquidation distance monitor, emergency close
- [ ] 27-02: Paper perp mode and crash recovery — mark-price simulation, state persistence, reconciliation on restart

---

#### Phase 28: Post-Only Limit Order Engine

**Goal:** All perp entries use post-only limit orders with automatic cancel-and-reprice; filled positions immediately get a take-profit limit order and an ATR-based trailing stop-limit; all orders are cleaned up when the position closes.

**Depends on:** Phase 27 (position manager must exist before order layer)

**Requirements:** ORDER-01, ORDER-02, ORDER-03, ORDER-04, ORDER-05

**Success Criteria** (what must be TRUE):
1. Every perp entry order is submitted as post-only; if it would execute as a taker, it is cancelled and the bot logs a `REPRICE` event rather than taking the fill
2. When an unfilled entry order exceeds the configured timeout, the bot cancels it and submits a new post-only limit at the current mid-price; this cycle repeats until the order fills or the signal is withdrawn
3. Within one candle of a position fill, the bot has placed a take-profit limit order at the configured price target on the INTX order book
4. The trailing stop-limit ratchets in the position's favour as mark price moves; the stop price never retreats; ATR sets the trail distance
5. When a position closes by any path (manual, stop hit, TP hit, emergency close), all associated open orders (TP + stop) are cancelled before the position record is marked closed

**Plans:** TBD

Plans:
- [ ] 28-01: Post-only entry loop — maker-only submission, cancel-and-reprice on timeout or taker-would-fill
- [ ] 28-02: TP limit order and ATR trailing stop-limit — post-fill order placement, ratchet logic, full cleanup on close

---

#### Phase 29: Leverage and Margin Risk Layer

**Goal:** The bot configures leverage and margin mode per trade based on regime, enforces per-trade and total exposure limits, and rejects entries that would breach those limits.

**Depends on:** Phase 27 (position manager), Phase 28 (order engine)

**Requirements:** MARGIN-01, MARGIN-02, MARGIN-03, MARGIN-04, RISK-01, RISK-02

**Success Criteria** (what must be TRUE):
1. In VOLATILE regime, positions are opened under isolated margin; in TRENDING and RANGING regimes, positions use cross-margin; the margin mode applied matches the current regime and is logged at entry
2. Leverage applied to a trade is within the configured maximum cap and scales down based on regime and signal conviction; the leverage value used appears in the entry log
3. A new perp entry is rejected with a logged `MARGIN_UTILIZATION_EXCEEDED` reason when current margin utilization is at or above the configured ceiling
4. A new perp entry is rejected with a logged `EXPOSURE_CAP_EXCEEDED` reason when adding the position would push total open perp notional above the configured percentage of account value
5. Per-trade max loss for perps is computed from the risk framework (consistent with Kelly sizing) and enforced before order placement; entries that exceed the limit are blocked

**Plans:** TBD

Plans:
- [ ] 29-01: Leverage and margin mode — per-trade leverage sizing, regime-to-margin-mode mapping, isolated/cross switching
- [ ] 29-02: Perp risk gates — margin utilization ceiling, total exposure cap, per-trade max loss enforcement

---

#### Phase 30: Perp Strategies and Tournament

**Goal:** At least two perp-specific strategies implementing IStrategy generate LONG and SHORT signals, adjust confidence based on current funding rate direction, and compete in the existing tournament pipeline with a separate perp leaderboard.

**Depends on:** Phase 29 (risk layer must gate entries before strategies can run live), Phase 26 (funding rate stream for confidence adjustment)

**Requirements:** STRAT-01, STRAT-02, STRAT-03, STRAT-04

**Success Criteria** (what must be TRUE):
1. Two perp strategies (e.g., `PerpMomentumStrategy`, `PerpMeanReversionStrategy`) each produce LONG, SHORT, and HOLD signals via the standard `IStrategy.evaluate()` interface; they pass the same no-lookahead-bias test pattern used for spot strategies
2. When the current funding rate strongly opposes the intended direction (e.g., high positive funding on a LONG signal), strategy confidence is reduced and the reduction is visible in signal metadata logs
3. Running `npm run tournament -- --perp` completes a walk-forward tournament using only perp strategies and produces a perp-specific leaderboard separate from the spot leaderboard
4. The perp leaderboard integrates with the regime-aware auto-switch state machine in the perp paper and live engines, using the same cooldown and deferral guards as the spot system

**Plans:** TBD

Plans:
- [ ] 30-01: Perp strategy implementations — PerpMomentumStrategy and PerpMeanReversionStrategy with funding-rate confidence adjustment
- [ ] 30-02: Perp tournament integration — perp leaderboard, walk-forward validation, regime-aware auto-switch wiring

---

#### Phase 31: Funding Rate Tracking

**Goal:** Every open perp position has real-time cumulative funding cost tracked as a P&L component; when that cost crosses a configurable threshold, the position is closed early.

**Depends on:** Phase 27 (positions must exist before funding can be tracked), Phase 26 (funding rate stream)

**Requirements:** FUNDING-01, FUNDING-02, FUNDING-03

**Success Criteria** (what must be TRUE):
1. For every open perp position, the current 8-hour funding rate and cumulative funding paid-to-date are visible in logs and updated on each funding event
2. Cumulative funding cost is recorded as a signed P&L component on the position record (negative when paid, positive when received) and included in the position's unrealized P&L calculation
3. When cumulative funding cost for a position exceeds the configured threshold (e.g., 0.5% of position value), the bot closes the position immediately and logs a `FUNDING_DRAIN_EXIT` reason

**Plans:** TBD

Plans:
- [ ] 31-01: Funding rate tracker — per-position cumulative funding cost, P&L component integration, and funding-drain exit trigger

---

#### Phase 32: Perp Analytics and CLI Report

**Goal:** Perp trades are stored separately from spot trades in their own SQLite table, and `npm run report` includes a perp-specific section with directional win rates, average leverage, and total funding paid.

**Depends on:** Phase 27 (positions produce trade records), Phase 31 (funding cost is part of each trade record)

**Requirements:** ANALYTICS-01, ANALYTICS-02, ANALYTICS-03

**Success Criteria** (what must be TRUE):
1. Each closed perp trade is stored in a dedicated `perp_trades` SQLite table containing: instrument, direction, leverage used, entry/exit prices, cumulative funding paid, and realized P&L
2. `npm run report` outputs a perp section showing win rate by direction (long vs short), average leverage across all trades, total funding paid, and net perp P&L
3. Spot P&L and perp P&L are reported in separate sections with separate totals; no blended summary metric combines them

**Plans:** TBD

Plans:
- [ ] 32-01: Perp trade record schema and storage — `perp_trades` table, Drizzle schema, write path from position close
- [ ] 32-02: CLI report perp section — directional win rate, average leverage, funding stats, separate P&L totals

---

#### Phase 33: Dashboard Perp Panels

**Goal:** The dashboard displays three live perp panels: open positions with unrealized P&L and liquidation price, real-time funding rates for both instruments, and a leverage utilization meter.

**Depends on:** Phase 32 (analytics data model), Phase 27 (position data), Phase 26 (funding rate stream)

**Requirements:** DASH-01, DASH-02, DASH-03

**Success Criteria** (what must be TRUE):
1. The dashboard shows an open positions panel listing each perp position with instrument, direction, leverage, current mark price, unrealized P&L, liquidation price, and cumulative funding cost; the panel updates in real time via WebSocket
2. The dashboard shows the current 8-hour funding rate for BTC-PERP and ETH-PERP, updated on each funding rate event from the INTX stream
3. The dashboard shows a leverage utilization meter displaying total open perp notional as a percentage of the configured maximum exposure cap; the meter updates when positions open or close

**Plans:** TBD

Plans:
- [ ] 33-01: Perp WebSocket events — extend ENGINE_EVENT_MAP with `perpPositionUpdate`, `perpFundingUpdate`, `perpExposureUpdate`
- [ ] 33-02: Perp dashboard panels — PerpPositionsPanel, PerpFundingPanel, PerpLeverageMeter React components

---

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Foundation & Data Pipeline | v1.0 | 2/2 | Complete | 2026-02-09 |
| 2. Indicator Engine | v1.0 | 1/1 | Complete | 2026-02-09 |
| 3. Strategy Framework | v1.0 | 2/2 | Complete | 2026-02-09 |
| 4. Backtesting Engine | v1.0 | 2/2 | Complete | 2026-02-10 |
| 5. Risk Management | v1.0 | 2/2 | Complete | 2026-02-10 |
| 6. Paper Trading | v1.0 | 2/2 | Complete | 2026-02-11 |
| 7. Live Trading | v1.0 | 3/3 | Complete | 2026-02-11 |
| 8. Tournament & Strategy Selection | v1.0 | 2/2 | Complete | 2026-02-12 |
| 9. Dashboard & Monitoring | v1.0 | 3/3 | Complete | 2026-02-17 |
| 10. Dashboard API Data Fixes | v1.0 | 1/1 | Complete | 2026-02-18 |
| 11. Dashboard WebSocket Pipeline | v1.0 | 2/2 | Complete | 2026-02-19 |
| 12. CLI & Operations | v1.1 | 2/2 | Complete | 2026-02-21 |
| 13. Monte Carlo Simulation | v1.1 | 2/2 | Complete | 2026-02-25 |
| 14. Regime Detection | v1.1 | 2/2 | Complete | 2026-02-25 |
| 15. Correlation-Aware Sizing | v1.1 | 3/3 | Complete | 2026-02-25 |
| 16. Enhanced Dashboard | v1.1 | 3/3 | Complete | 2026-02-26 |
| 17. Exit Logic Engine | v1.2 | 3/3 | Complete | 2026-02-27 |
| 18. Performance Analytics | v1.2 | 2/2 | Complete | 2026-02-28 |
| 19. Indicator Additions | v1.3 | 1/1 | Complete | 2026-03-01 |
| 20. Mean Reversion Strategy | v1.3 | 2/2 | Complete | 2026-03-01 |
| 21. Momentum Breakout Strategy | v1.3 | 2/2 | Complete | 2026-03-01 |
| 22. Exit Config Optimizer | v1.3 | 2/2 | Complete | 2026-03-02 |
| 23. Regime-Aware Tournament | v1.3 | 2/2 | Complete | 2026-03-07 |
| 24. Live Strategy Auto-Switching | v1.3 | 3/3 | Complete | 2026-03-08 |
| 25. Pipeline Integration | v1.3 | 1/1 | Complete | 2026-03-08 |
| 26. INTX API Client | v1.4 | 0/2 | Not started | - |
| 27. Perp Position Execution | v1.4 | 0/2 | Not started | - |
| 28. Post-Only Limit Order Engine | v1.4 | 0/2 | Not started | - |
| 29. Leverage and Margin Risk Layer | v1.4 | 0/2 | Not started | - |
| 30. Perp Strategies and Tournament | v1.4 | 0/2 | Not started | - |
| 31. Funding Rate Tracking | v1.4 | 0/1 | Not started | - |
| 32. Perp Analytics and CLI Report | v1.4 | 0/2 | Not started | - |
| 33. Dashboard Perp Panels | v1.4 | 0/2 | Not started | - |
