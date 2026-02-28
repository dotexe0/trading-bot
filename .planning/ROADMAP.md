# Roadmap: Crypto Trading Bot

## Milestones

- ✅ **v1.0 MVP** — Phases 1-11 (shipped 2026-02-19) — [Archive](milestones/v1.0-ROADMAP.md)
- ✅ **v1.1 Operational + Advanced** — Phases 12-16 (shipped 2026-02-26) — [Archive](milestones/v1.1-ROADMAP.md)
- 🚧 **v1.2 Smarter Exits + Analytics** — Phases 17-18 (in progress)

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

### 🚧 v1.2 Smarter Exits + Analytics (In Progress)

**Milestone Goal:** Improve paper/live trading profitability through configurable exit logic (trailing targets, partial exits, time stops, ATR-dynamic stops) and add performance analytics to measure the improvement across CLI and dashboard.

#### Phase 17: Exit Logic Engine

**Goal**: Users can configure smarter exit behaviors — trailing profit targets, partial position exits, time-based stale-trade exits, and ATR-dynamic stop distances — and these behaviors execute identically in backtest, paper, and live modes.
**Depends on**: Phases 1-16 (backtest engine, risk manager, strategy signal pipeline all exist)
**Requirements**: EXIT-01, EXIT-02, EXIT-03, EXIT-04
**Success Criteria** (what must be TRUE):
  1. User configures a trailing profit target (activate %, trail %) and backtesting shows the position follows price upward and exits only on reversal past the trail threshold — not at a fixed target
  2. User configures a partial exit (M% at first target) and a backtest trade log shows two exit events for a single entry: a partial close at the target and a final close of the remainder at a later price
  3. User configures a time-based exit (N candles, break-even threshold) and stalled positions in backtest close automatically at candle N when P&L is below threshold — no manual intervention needed
  4. User configures ATR stop multiplier and backtest trade records show stop distances that vary candle-to-candle with ATR (wider during high-volatility periods, tighter during calm) rather than a fixed percentage
  5. Exit behaviors configured for backtest produce equivalent behavior in paper and live modes — same parameters, same exit conditions, no mode-specific code paths needed

**Plans**: 3 plans

Plans:
- [x] 17-01-PLAN.md — ExitConfig types/schema, AtrDynamicStop (EXIT-04), PortfolioTracker.applyPartialClose(), exits merged into strategy schemas
- [x] 17-02-PLAN.md — TrailingProfitExit (EXIT-01), PartialPositionExit (EXIT-02), TimeBasedExit (EXIT-03), ExitLogicManager assembly
- [x] 17-03-PLAN.md — Wire ExitLogicManager into BacktestEngine, PaperTradingEngine, LiveTradingEngine; add PARTIAL_EXIT to OrderPurpose

#### Phase 18: Performance Analytics

**Goal**: Users can measure the impact of exit logic improvements through a CLI performance report and a live dashboard panel — both drawing from the same trade data to show win rate, avg win/loss, and best/worst trades.
**Depends on**: Phase 17 (exit logic generates richer trade records needed for meaningful analytics)
**Requirements**: PERF-01, PERF-02, PERF-03
**Success Criteria** (what must be TRUE):
  1. Running `npm run report` (or equivalent CLI command) prints win rate, average win, average loss, and win/loss ratio per strategy for any completed backtest or paper/live session — output is human-readable in the terminal
  2. The CLI report (or a dedicated `--trades` flag) shows the top N best and worst individual trades for a session, each with timestamp, pair, entry price, exit price, and P&L percentage — sorted by P&L descending/ascending
  3. The dashboard performance metrics panel displays win rate, avg win/loss ratio, and trade count for the active session and updates in real time as new trades complete — visible without navigating away from the main view
  4. All three analytics surfaces (CLI report, trade viewer, dashboard panel) read from the same underlying data (SessionStore / LiveStateStore trades) with no duplicate data pipeline

**Plans**: 2 plans

Plans:
- [ ] 18-01-PLAN.md — Shared analytics module (computePerformanceReport, normalization functions) and CLI report command
- [ ] 18-02-PLAN.md — Dashboard PerformancePanel component with real-time updates via orderFilled trade refresh

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
| 18. Performance Analytics | v1.2 | 0/2 | Not started | - |
