# Roadmap: Crypto Trading Bot

## Milestones

- ✅ **v1.0 MVP** — Phases 1-11 (shipped 2026-02-19) — [Archive](milestones/v1.0-ROADMAP.md)
- ✅ **v1.1 Operational + Advanced** — Phases 12-16 (shipped 2026-02-26) — [Archive](milestones/v1.1-ROADMAP.md)
- ✅ **v1.2 Smarter Exits + Analytics** — Phases 17-18 (shipped 2026-02-28) — [Archive](milestones/v1.2-ROADMAP.md)
- [ ] **v1.3 Adaptive Intelligence** — Phases 19-25 (in progress)

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

### v1.3 Adaptive Intelligence (Phases 19-25) — IN PROGRESS

- [x] **Phase 19: Indicator Additions** (1/1 plans) — new indicator wrappers and volume adapter — completed 2026-03-01
- [x] **Phase 20: Mean Reversion Strategy** (2/2 plans) — Z-score strategy targeting RANGING regime — completed 2026-03-01
- [x] **Phase 21: Momentum Breakout Strategy** (2/2 plans) — volume-confirmed breakout targeting TRENDING regime — completed 2026-03-01
- [x] **Phase 22: Exit Config Optimizer** (2/2 plans) — grid search over exit params with walk-forward validation — completed 2026-03-02
- [x] **Phase 23: Regime-Aware Tournament** (2/2 plans) — per-regime leaderboards and strategy winners — completed 2026-03-07
- [ ] **Phase 24: Live Strategy Auto-Switching** (0/3 plans) — regime-driven strategy swaps in paper and live engines
- [ ] **Phase 25: Pipeline Integration** (0/1 plans) — extended npm start with optimize and regime tournament steps

---

### Phase 19: Indicator Additions

**Goal**: User can compute standard deviation, highest/lowest N-candle ranges, and extract volume arrays using the existing indicator engine
**Depends on**: None (foundation for v1.3)
**Plans**: 1

Plans:
- [ ] 19-01-PLAN.md — SD, Highest, Lowest indicators + extractVolumes adapter + tests

**Success Criteria:**
1. Rolling standard deviation indicator is available via the indicator engine using the same createRequire pattern as existing indicators (SMA, EMA, etc.)
2. Highest and lowest N-candle indicators return correct breakout/support levels through the indicator engine
3. `extractVolumes()` adapter in `src/indicators/adapters.ts` returns a volume array from candle data, matching the `extractCloses()` pattern
4. All new indicators are registered in the `IndicatorName` union and have Zod config schemas

**Requirements:** INDIC-01, INDIC-02, INDIC-03

---

### Phase 20: Mean Reversion Strategy

**Goal**: User can backtest a mean reversion strategy that buys when price is statistically cheap and sells when statistically expensive, activating only in RANGING markets
**Depends on**: Phase 19 (SD indicator for Z-score computation)
**Plans**: 2

Plans:
- [ ] 20-01-PLAN.md — Z-score mean reversion strategy implementation + config + registry
- [ ] 20-02-PLAN.md — Comprehensive test suite + config validation + registry integration tests

**Success Criteria:**
1. Mean reversion strategy generates BUY signals when Z-score drops below the negative threshold and SELL signals when Z-score rises above the positive threshold
2. Strategy skips signal generation in TRENDING and VOLATILE regimes, only activating in RANGING
3. Z-score at candle `i` does not change when candle `i+1` is appended (causality test passes -- no lookahead bias)
4. Strategy implements `IStrategy` interface and runs identically in backtest, paper, and live modes

**Requirements:** STRAT-01, STRAT-02, STRAT-03

---

### Phase 21: Momentum Breakout Strategy

**Goal**: User can backtest a momentum breakout strategy that confirms price breakouts with volume, activating only in TRENDING markets, bringing total competing strategies to 7
**Depends on**: Phase 19 (highest/lowest indicators, extractVolumes adapter)
**Plans**: 2

Plans:
- [ ] 21-01-PLAN.md — MomentumBreakoutStrategy class + config schema + registry registration (7th strategy)
- [ ] 21-02-PLAN.md — Comprehensive test suite + volume confirmation tests + causality + config.test.ts additions

**Success Criteria:**
1. Momentum breakout generates BUY when price exceeds N-candle highest with volume above 1.5x rolling average, and SELL when price breaks below N-candle lowest with volume confirmation
2. Strategy activates only in TRENDING regime with configurable breakout window, volume window, and volume multiplier
3. Both new strategies (mean reversion + momentum breakout) implement `IStrategy` and are registered in the strategy registry
4. Tournament runs with all 7 strategies competing (5 original + 2 new) and produces valid rankings

**Requirements:** STRAT-04, STRAT-05, STRAT-06, STRAT-07

---

### Phase 22: Exit Config Optimizer

**Goal**: User can auto-tune exit parameters (ATR stop, trailing profit, partial exit, time exit) per strategy via grid search, with the best configs automatically applied before tournaments
**Depends on**: Phases 20-21 (strategies must exist to optimize their exits)
**Plans**: 2

Plans:
- [ ] 22-01-PLAN.md — ExitConfigOptimizer class + ExitConfigStore + schema table + tests
- [ ] 22-02-PLAN.md — npm run optimize CLI + tournament pre-run exit config loading

**Success Criteria:**
1. User runs `npm run optimize` and the optimizer performs grid search over all 4 exit parameter types for each strategy
2. Optimizer uses walk-forward train/validate split internally -- optimization metric is profit factor on out-of-sample data only
3. Best exit params per strategy are persisted in SQLite with a strategy config hash, and stale configs are detected when strategy params change
4. Optimized exit configs are automatically loaded and applied to strategy configs before any tournament run
5. Running `npm run optimize` with no candle data in the database produces a clear skip message rather than crashing

**Requirements:** OPT-01, OPT-02, OPT-03, OPT-04, OPT-05

---

### Phase 23: Regime-Aware Tournament

**Goal**: Tournament produces separate winning strategies for TRENDING, RANGING, and VOLATILE regimes, enabling the bot to select the best strategy for current market conditions
**Depends on**: Phase 22 (optimized exits improve tournament accuracy)
**Plans**: 2

**Success Criteria:**
1. Tournament tracks per-regime performance and produces separate leaderboards for TRENDING, RANGING, and VOLATILE alongside the existing overall leaderboard
2. Regime labels are pre-computed once over the full candle series before walk-forward splitting, ensuring consistent regime assignment across all windows
3. `TournamentResult` exposes `regimeLeaderboards` with per-regime ranked strategies that downstream consumers (auto-switcher, dashboard) can read
4. When a regime has fewer than the minimum trade threshold, the overall tournament winner is used as fallback for that regime

**Requirements:** TOURN-01, TOURN-02, TOURN-03, TOURN-04

---

### Phase 24: Live Strategy Auto-Switching

**Goal**: Paper and live trading engines automatically switch to the best strategy for the current market regime, deferring swaps when positions are open and throttling to prevent thrashing
**Depends on**: Phase 23 (regime leaderboards provide the winner map to consult)
**Plans**: 3

Plans:
- [ ] 24-01-PLAN.md — PaperTradingEngine auto-switch state machine (fields, methods, onCandle wiring)
- [ ] 24-02-PLAN.md — Paper auto-switch test suite (5 tests covering all LIVE-01 through LIVE-05)
- [ ] 24-03-PLAN.md — LiveTradingEngine port + live tests + CLI wiring for paper and live

**Success Criteria:**
1. When the market regime changes, the engine swaps to that regime's winning strategy from the tournament leaderboard
2. If a position is open when a regime change occurs, the switch is deferred until the position closes (EXIT or STOP_LOSS fill), then executes
3. A 10-candle cooldown is enforced after each strategy switch -- no additional switches occur during the cooldown window
4. Auto-switching works correctly in PaperTradingEngine and is validated there before being active in LiveTradingEngine
5. A strategy switch does not transfer ExitLogicManager state -- the next trade entry after a switch creates a fresh ExitLogicManager instance

**Requirements:** LIVE-01, LIVE-02, LIVE-03, LIVE-04, LIVE-05

---

### Phase 25: Pipeline Integration

**Goal**: User runs `npm start` and the full adaptive pipeline executes in order: sync, optimize exits, regime-aware tournament, activate per-regime winners, then trade with auto-switching
**Depends on**: Phase 24 (all subsystems must exist to wire together)
**Plans**: 1

**Success Criteria:**
1. `npm start` executes the extended pipeline: sync -> optimize exits -> regime-aware tournament -> activate per-regime winners -> paper/live + dashboard
2. Each pipeline step validates its prerequisites before running (e.g., optimizer skips if no candle data; tournament skips if fewer than 2 strategies have results)
3. `npm run optimize` and `npm run tournament` are available as standalone commands that run independently of the full pipeline

**Requirements:** PIPE-01, PIPE-02, PIPE-03

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
| 24. Live Strategy Auto-Switching | v1.3 | 0/3 | Pending | — |
| 25. Pipeline Integration | v1.3 | 0/1 | Pending | — |
