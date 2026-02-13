# Roadmap: Crypto Trading Bot

## Overview

This roadmap takes the project from zero to a fully automated crypto trading bot in 9 phases, following the natural dependency chain of quantitative trading systems. Data flows into indicators, indicators feed strategies, strategies are validated by backtesting, risk management gates all execution, paper trading validates the system safely, live trading deploys it for real, tournaments optimize strategy selection, and the dashboard provides monitoring and control. Each phase delivers a complete, testable capability that the next phase builds upon.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Foundation & Data Pipeline** - Project scaffolding, core infrastructure, and historical data ingestion
- [x] **Phase 2: Indicator Engine** - Technical indicator calculations across multiple timeframes
- [x] **Phase 3: Strategy Framework** - Typed strategy interface and built-in strategy implementations
- [x] **Phase 4: Backtesting Engine** - Event-driven historical replay with performance metrics
- [x] **Phase 5: Risk Management** - Position sizing, stop-losses, and portfolio-level circuit breakers
- [x] **Phase 6: Paper Trading** - Simulated trading against live market data
- [x] **Phase 7: Live Trading** - Real order execution via Coinbase Advanced Trade API
- [x] **Phase 8: Tournament & Strategy Selection** - Automated strategy ranking and deployment
- [ ] **Phase 9: Dashboard & Monitoring** - Web UI for monitoring, control, and visualization

## Phase Details

### Phase 1: Foundation & Data Pipeline
**Goal**: System can fetch, store, validate, and serve multi-timeframe OHLCV candle data for BTC-USD and ETH-USD
**Depends on**: Nothing (first phase)
**Requirements**: CORE-01, CORE-02, CORE-03, CORE-04, CORE-05, DATA-01, DATA-02, DATA-03, DATA-04, DATA-05, DATA-06, DATA-07
**Success Criteria** (what must be TRUE):
  1. Running a CLI command downloads historical BTC-USD and ETH-USD candles and stores them in a local SQLite database
  2. System produces candles at 1m, 5m, 15m, 1h, 4h, and 1D timeframes from raw 1-minute data
  3. Re-running data fetch only downloads missing/new candles (incremental updates work, gaps are detected and filled)
  4. All timestamps are Unix milliseconds UTC, all financial values use decimal precision math, and configuration is validated at startup via schema
  5. API keys are loaded from .env (not in source control) and all operations produce structured JSON logs
**Plans:** 2 plans

Plans:
- [x] 01-01-PLAN.md -- Project scaffolding, core types, config system, logging, decimal math, and SQLite database layer
- [x] 01-02-PLAN.md -- Data providers (Coinbase + CryptoCompare), validation, gap detection, aggregation, pipeline, and CLI commands

### Phase 2: Indicator Engine
**Goal**: System calculates all required technical indicators on any timeframe of candle data
**Depends on**: Phase 1
**Requirements**: INDI-01, INDI-02, INDI-03, INDI-04, INDI-05, INDI-06, INDI-07
**Success Criteria** (what must be TRUE):
  1. Given a series of candles, system returns correct SMA, EMA, RSI, MACD, Bollinger Bands, Stochastic, and ATR values
  2. Indicator periods are configurable (not hardcoded) and invalid configurations are rejected at startup
  3. System can compute the same indicator across multiple timeframes simultaneously (e.g., RSI on 1h and 4h candles at the same point in time)
**Plans:** 1 plan

Plans:
- [x] 02-01-PLAN.md -- Indicator types, config validation, adapters, engine (all 7 indicators), and TDD tests with multi-timeframe support

### Phase 3: Strategy Framework
**Goal**: Strategies can be written against a typed interface, configured with parameters, and produce trading signals
**Depends on**: Phase 2
**Requirements**: STRT-01, STRT-02, STRT-03, STRT-04, STRT-05
**Success Criteria** (what must be TRUE):
  1. A typed strategy interface exists and all 5 built-in strategies (SMA crossover, RSI mean-reversion, MACD momentum, Bollinger breakout, multi-timeframe trend) implement it
  2. Each strategy generates signals containing direction (long/short/close), a confidence score, and a human-readable reasoning string
  3. Strategy parameters are configurable via schema-validated configuration, and invalid parameters are rejected at startup
  4. Strategy code is environment-agnostic -- it receives candle data and returns signals, with no knowledge of whether it runs in backtest, paper, or live mode
**Plans:** 2 plans

Plans:
- [x] 03-01-PLAN.md -- Strategy types, config schemas, registry, base class, and foundation tests
- [x] 03-02-PLAN.md -- Five built-in strategy implementations, tests, and default registry

### Phase 4: Backtesting Engine
**Goal**: User can replay historical data through strategies to evaluate their performance with realistic trade simulation
**Depends on**: Phase 3
**Requirements**: BACK-01, BACK-02, BACK-03, BACK-04, BACK-05, BACK-06
**Success Criteria** (what must be TRUE):
  1. Running a backtest replays candles in chronological order and strategies only see data available at each point in time (no lookahead bias)
  2. Simulated fills account for configurable slippage and Coinbase fee tiers, and all financial math uses decimal precision
  3. Backtest output includes Sharpe ratio, max drawdown, win rate, profit factor, CAGR, and total return
  4. Walk-forward optimization runs: train on window A, validate on window B, roll forward -- producing out-of-sample performance metrics
  5. Comparison reports rank multiple strategies side-by-side on the same date range
**Plans:** 2 plans

Plans:
- [x] 04-01-PLAN.md -- Backtest types, fill simulator, portfolio tracker, and event-driven engine with lookahead prevention
- [x] 04-02-PLAN.md -- Performance metrics (Sharpe, drawdown, CAGR, etc.), walk-forward validation, and strategy comparison reports

### Phase 5: Risk Management
**Goal**: Every trade decision passes through a risk framework that enforces position-level and portfolio-level limits before execution
**Depends on**: Phase 4
**Requirements**: RISK-01, RISK-02, RISK-03, RISK-04, RISK-05, RISK-06, RISK-07
**Success Criteria** (what must be TRUE):
  1. Position sizes are calculated using Kelly criterion or fixed-fraction method based on strategy statistics, and never exceed configured maximums
  2. Every open position has a stop-loss (fixed percentage or trailing), and stops are enforced automatically
  3. Trading halts automatically when portfolio drawdown exceeds the configured max drawdown threshold (circuit breaker activates)
  4. Daily loss limit, maximum total exposure cap, and maximum position count are all enforced and cannot be bypassed
  5. Every risk check produces a structured log entry with the rule name, input values, threshold, and approve/reject decision
**Plans:** 2 plans

Plans:
- [x] 05-01-PLAN.md -- Risk types, config schema, position sizing (Kelly/fixed-fraction), and stop-loss tracker
- [x] 05-02-PLAN.md -- Portfolio-level risk rules, RiskManager orchestrator, structured logging, and BacktestEngine integration

### Phase 6: Paper Trading
**Goal**: User can run strategies against live market data with simulated execution to validate the system before risking real capital
**Depends on**: Phase 5
**Requirements**: PAPR-01, PAPR-02, PAPR-03, PAPR-04
**Success Criteria** (what must be TRUE):
  1. Strategies process live market data and execute trades against a virtual balance with simulated order fills
  2. Simulated fills include realistic slippage and fees matching Coinbase fee tiers
  3. System connects to Coinbase sandbox for exchange-level paper trading (realistic order book interaction)
  4. Paper trading results (trades, positions, PnL) are stored in the same format as live trading results and can be analyzed identically
**Plans:** 2 plans

Plans:
- [x] 06-01-PLAN.md -- Paper trading types, config, live data feed (WebSocket + REST fallback), database schema, and session persistence
- [x] 06-02-PLAN.md -- PaperTradingEngine (real-time strategy loop with risk management), Coinbase sandbox validation, and barrel export

### Phase 7: Live Trading
**Goal**: System places and manages real orders on Coinbase, handling the full order lifecycle including failures, restarts, and graceful shutdown
**Depends on**: Phase 6
**Requirements**: LIVE-01, LIVE-02, LIVE-03, LIVE-04, LIVE-05, LIVE-06
**Success Criteria** (what must be TRUE):
  1. System places market and limit orders via Coinbase Advanced Trade REST API and receives real-time updates via WebSocket
  2. System periodically reconciles its internal position/order state with actual exchange state, detecting and logging any discrepancies
  3. On shutdown, system cancels pending orders, ensures stops are set on open positions, and closes WebSocket connections cleanly
  4. After a restart, system resumes from persisted state without placing duplicate orders or losing track of open positions
  5. API rate limits are respected via request queuing with exponential backoff -- no requests are dropped or rejected
**Plans:** 3 plans

Plans:
- [x] 07-01-PLAN.md -- Live trading types, config, rate limiter, database schema, and state persistence store
- [x] 07-02-PLAN.md -- OrderManager with REST order submission, WebSocket user channel tracking, and reconciliation
- [x] 07-03-PLAN.md -- LiveTradingEngine with candle pipeline, graceful shutdown, restart recovery, and barrel export

### Phase 8: Tournament & Strategy Selection
**Goal**: System automatically identifies the best-performing strategies through backtesting tournaments and deploys them
**Depends on**: Phase 7
**Requirements**: TOURN-01, TOURN-02, TOURN-03, TOURN-04
**Success Criteria** (what must be TRUE):
  1. Running a tournament backtests all registered strategies on a configurable date range and produces a ranked leaderboard
  2. Rankings use risk-adjusted return (Sharpe ratio) with walk-forward validation to prevent overfitting
  3. Top-N strategies are automatically activated for paper or live trading based on tournament results
  4. Tournaments re-run periodically on a rolling basis, and strategy rankings update accordingly
**Plans:** 2 plans

Plans:
- [x] 08-01-PLAN.md -- Tournament types, config, runner, store, and database schema (ranking + persistence)
- [x] 08-02-PLAN.md -- Activation bridge, tournament scheduler, and barrel export (automation + deployment)

### Phase 9: Dashboard & Monitoring
**Goal**: User can monitor portfolio performance, view positions and trades, control strategies, and trigger emergency actions through a web interface
**Depends on**: Phase 7 (can begin alongside Phase 8)
**Requirements**: DASH-01, DASH-02, DASH-03, DASH-04, DASH-05, DASH-06, DASH-07, DASH-08
**Success Criteria** (what must be TRUE):
  1. User opens a web browser and sees an equity curve chart showing portfolio value over time
  2. User can view open positions (entry price, current price, unrealized PnL), trade history (with filtering/sorting), and real-time BTC-USD/ETH-USD price charts
  3. User can start and stop individual strategies from the dashboard
  4. User can trigger an emergency kill switch that cancels all orders and closes all positions
  5. Dashboard shows current risk status (drawdown level, exposure, active circuit breakers) and all data updates in real-time via WebSocket
**Plans:** 3 plans

Plans:
- [ ] 09-01-PLAN.md -- Fastify backend server with REST endpoints, WebSocket broadcaster, and engine event wiring
- [ ] 09-02-PLAN.md -- React frontend with Vite, price charts (Lightweight Charts v5), equity curve, positions table, trade history
- [ ] 09-03-PLAN.md -- Strategy controls, kill switch, risk gauges, circuit breaker banner, and real-time WebSocket updates

## Progress

**Execution Order:**
Phases execute in numeric order: 1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7 -> 8 -> 9

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Foundation & Data Pipeline | 2/2 | Complete | 2026-02-09 |
| 2. Indicator Engine | 1/1 | Complete | 2026-02-09 |
| 3. Strategy Framework | 2/2 | Complete | 2026-02-09 |
| 4. Backtesting Engine | 2/2 | Complete | 2026-02-10 |
| 5. Risk Management | 2/2 | Complete | 2026-02-10 |
| 6. Paper Trading | 2/2 | Complete | 2026-02-11 |
| 7. Live Trading | 3/3 | Complete | 2026-02-11 |
| 8. Tournament & Strategy Selection | 2/2 | Complete | 2026-02-12 |
| 9. Dashboard & Monitoring | 0/3 | Not started | - |
