# Roadmap: Crypto Trading Bot

## Milestones

- **v1.0 MVP** — Phases 1-11 (shipped 2026-02-19) — [Archive](milestones/v1.0-ROADMAP.md)
- **v1.1 Operational + Advanced** — Phases 12-16 (in progress)

## Phases

<details>
<summary>v1.0 MVP (Phases 1-11) — SHIPPED 2026-02-19</summary>

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

### v1.1 Operational + Advanced (In Progress)

**Milestone Goal:** Make the bot runnable with a single command, add Monte Carlo robustness testing, market regime detection, correlation-aware sizing, and enhanced dashboard visualizations.

- [x] **Phase 12: CLI & Operations** (2/2 plans) — completed 2026-02-21
- [x] **Phase 13: Monte Carlo Simulation** (2/2 plans) — completed 2026-02-24
- [x] **Phase 14: Regime Detection** - Market state classification with backward-compatible strategy integration
- [ ] **Phase 15: Correlation-Aware Sizing** - Cross-asset correlation adjustment for position sizing
- [ ] **Phase 16: Enhanced Dashboard** - Backtest visualization, strategy hot-reload, and portfolio heat map

## Phase Details

### Phase 12: CLI & Operations
**Goal**: User can operate the entire bot from the command line — individual subsystem commands and a single orchestrator that starts everything in the right order
**Depends on**: v1.0 complete (wraps existing BacktestEngine, TournamentRunner, LiveTradingEngine, etc.)
**Requirements**: OPS-01, OPS-02, OPS-03, OPS-04, OPS-05, OPS-06, OPS-07, OPS-08
**Success Criteria** (what must be TRUE):
  1. User can run `npm run sync`, `npm run backtest`, `npm run tournament`, `npm run paper`, `npm run live`, and `npm run dashboard` as individual commands that each start the corresponding subsystem
  2. User can run `npm start` and the orchestrator starts data sync, runs a tournament, activates winners, and launches the dashboard — all in dependency order
  3. Pressing Ctrl+C during orchestration gracefully stops all running processes without orphaned child processes
  4. Each CLI command provides clear terminal output (colored status, errors, progress) so the user knows what is happening
**Plans**: TBD

Plans:
- [ ] 12-01: Individual CLI commands and package.json scripts
- [ ] 12-02: Orchestrator with process management and graceful shutdown

### Phase 13: Monte Carlo Simulation
**Goal**: User can assess strategy robustness by running Monte Carlo simulations that randomize trade sequences and produce statistical confidence intervals
**Depends on**: Phase 12 (CLI commands for backtest exist), v1.0 BacktestEngine
**Requirements**: MC-01, MC-02, MC-03, MC-04
**Success Criteria** (what must be TRUE):
  1. User can run Monte Carlo simulation on any completed backtest and see percentile distributions (5th, 25th, 50th, 75th, 95th) for Sharpe ratio, max drawdown, and total return
  2. Tournament ranking incorporates Monte Carlo confidence intervals so strategies with unstable results are penalized
  3. Monte Carlo results are persisted to the database and can be retrieved for any past backtest run
**Plans**: 2 plans in 2 waves

Plans:
- [ ] 13-01: Monte Carlo engine — types, Zod config, MonteCarloEngine with Fisher-Yates trade shuffling and percentile extraction (TDD)
- [ ] 13-02: Tournament integration and database persistence — MonteCarloStore, tournament composite scoring, CLI --mc flags

### Phase 14: Regime Detection
**Goal**: System classifies market conditions as trending, ranging, or volatile — and passes this context to strategies without breaking existing strategy code
**Depends on**: v1.0 Indicator Engine (ATR, ADX available)
**Requirements**: REG-01, REG-02, REG-03, REG-04
**Success Criteria** (what must be TRUE):
  1. System produces a current regime classification (TRENDING, RANGING, or VOLATILE) based on ATR and ADX indicators before each strategy evaluation
  2. Regime is passed as an optional parameter to IStrategy.evaluate() and all 5 existing strategies continue to work unchanged (backward-compatible)
  3. Regime history is persisted to the database and available for backtesting analysis (user can query regime at any historical point)
**Plans**: TBD

Plans:
- [ ] 14-01: Regime classifier module and strategy interface extension
- [ ] 14-02: Database persistence and backtest integration

### Phase 15: Correlation-Aware Sizing
**Goal**: Position sizer reduces allocation when BTC and ETH are highly correlated, preventing overexposure to what is effectively one bet
**Depends on**: Phase 14 (regime detection for full adaptive pipeline), v1.0 PositionSizer
**Requirements**: CORR-01, CORR-02, CORR-03, CORR-04
**Success Criteria** (what must be TRUE):
  1. System computes rolling Pearson correlation between BTC and ETH returns with a configurable window (minimum 30 days)
  2. When both BTC and ETH positions are open simultaneously, position sizes are reduced proportionally to their correlation coefficient
  3. Correlation snapshots are persisted to the database for auditing and historical analysis
**Plans**: 3 plans in 3 waves

Plans:
- [ ] 15-01-PLAN.md — CorrelationCalculator TDD: pure Pearson math, types, Zod config, daysToCandles utility
- [ ] 15-02-PLAN.md — CorrelationStore + schema: correlation_snapshots table, Drizzle definition, raw SQL, store tests
- [ ] 15-03-PLAN.md — Engine wiring: PositionSizer extension, paper/live integration, barrel export

### Phase 16: Enhanced Dashboard
**Goal**: Dashboard gains backtest trade visualization, live strategy configuration changes, and a portfolio heat map — building on existing React + Lightweight Charts + WebSocket infrastructure
**Depends on**: Phase 13 (backtest results for visualization), Phase 15 (correlation data for heat map), v1.0 Dashboard
**Requirements**: EDASH-01, EDASH-02, EDASH-03
**Success Criteria** (what must be TRUE):
  1. User can view any backtest result as a price chart with trade entry/exit markers overlaid, showing where the strategy bought and sold
  2. User can modify strategy configuration parameters in the dashboard and apply changes without restarting the bot (hot-reload)
  3. User can view a portfolio heat map showing current allocation percentages and correlation strength between BTC and ETH
**Plans**: TBD

Plans:
- [ ] 16-01: Backtest visualization component and API endpoint
- [ ] 16-02: Strategy hot-reload with chokidar file watching
- [ ] 16-03: Portfolio heat map component

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
| 13. Monte Carlo Simulation | v1.1 | 2/2 | Complete | 2026-02-24 |
| 14. Regime Detection | v1.1 | 0/2 | Not started | - |
| 15. Correlation-Aware Sizing | v1.1 | 0/3 | Not started | - |
| 16. Enhanced Dashboard | v1.1 | 0/3 | Not started | - |
