# Crypto Trading Bot

## What This Is

A quant-grade cryptocurrency trading bot targeting Coinbase Advanced Trade API, built with TypeScript/Node.js. It runs automated trading strategies on BTC-USD, ETH-USD, BTC-PERP, and ETH-PERP, selected through empirical backtesting tournaments with walk-forward validation. The system covers the full lifecycle: historical data ingestion, technical indicator computation, strategy evaluation, backtesting, Monte Carlo robustness testing, risk management with correlation-aware sizing, paper trading, live trading, regime-aware tournament-based strategy selection, live strategy auto-switching, exit parameter optimization, perpetual futures trading with leverage/margin management and funding rate tracking, separate analytics, and a real-time web dashboard with perp panels. Running `npm start` executes the full adaptive pipeline end-to-end.

## Core Value

The bot must reliably execute trades with correct position sizing, risk limits, and stop-losses — never losing more than configured risk parameters allow, even during system failures or market volatility.

## Requirements

### Validated

- ✓ Historical data pipeline with multi-timeframe aggregation and validation — v1.0
- ✓ 7 technical indicators (SMA, EMA, RSI, MACD, Bollinger Bands, Stochastic, ATR) with multi-timeframe support — v1.0
- ✓ 5 built-in strategies with typed interface and schema-validated configuration — v1.0
- ✓ Event-driven backtesting with walk-forward optimization and no lookahead bias — v1.0
- ✓ Full risk framework: Kelly criterion sizing, trailing stops, drawdown circuit breaker, exposure caps — v1.0
- ✓ Paper trading with local simulation and Coinbase sandbox integration — v1.0
- ✓ Live trading with crash recovery, reconciliation, and graceful shutdown — v1.0
- ✓ Tournament-based strategy selection with automated deployment — v1.0
- ✓ Real-time web dashboard with price charts, equity curves, strategy controls, and kill switch — v1.0
- ✓ All financial math uses decimal precision (decimal.js, 20-digit precision) — v1.0
- ✓ Single CLI orchestrator (`npm start`) starts entire system in dependency order — v1.1
- ✓ Individual CLI commands (`npm run sync/backtest/tournament/paper/live/dashboard`) for each subsystem — v1.1
- ✓ Monte Carlo simulation with Fisher-Yates shuffling and percentile distributions for strategy robustness — v1.1
- ✓ Tournament ranking uses MC-adjusted composite p5 Sharpe scoring — v1.1
- ✓ Market regime classification (TRENDING/RANGING/VOLATILE) via ADX+ATR, backward-compatible — v1.1
- ✓ Rolling Pearson correlation between BTC and ETH with configurable window — v1.1
- ✓ Correlation-aware position sizing (PositionSizer scales down when assets are correlated) — v1.1
- ✓ Backtest visualization in dashboard with BacktestViewer — v1.1
- ✓ Strategy hot-reload via PATCH API without bot restart — v1.1
- ✓ Portfolio heat map with HSL tile colors and correlation badge overlay — v1.1
- ✓ Trailing profit target exit (EXIT-01): activation gate, HWM tracking, ATR-based trail — v1.2
- ✓ Partial position exit at profit target with breakeven stop adjustment (EXIT-02) — v1.2
- ✓ Time-based stale position exit after N candles with PnL threshold (EXIT-03) — v1.2
- ✓ ATR-dynamic stop-loss with fallback to percentage when ATR unavailable (EXIT-04) — v1.2
- ✓ CLI performance report (`npm run report`) with win rate, avg win/loss, best/worst trades — v1.2
- ✓ Dashboard PerformancePanel with real-time useMemo metrics and orderFilled trade refresh — v1.2
- ✓ Z-score mean reversion strategy (6th) — regime-filtered to RANGING only — v1.3
- ✓ Momentum breakout strategy with volume confirmation (7th) — regime-filtered to TRENDING only — v1.3
- ✓ Exit config optimizer: grid search over all 4 exit param types with walk-forward validation — v1.3
- ✓ Regime-aware tournament: separate TRENDING/RANGING/VOLATILE leaderboards — v1.3
- ✓ Live auto-switching: engine swaps to regime's best strategy on change, defers if position open, 10-candle cooldown — v1.3
- ✓ `npm start` extended to 4-step pipeline: sync → optimize exits → regime tournament → dashboard — v1.3
- ✓ FCM connectivity via Advanced Trade API; IntxClient wraps CBAdvancedTradeClient for perp isolation — v1.4
- ✓ WebSocket streams for real-time mark price, index price, and funding rate (BTC-PERP, ETH-PERP) — v1.4
- ✓ `npm run perp:status` — FCM account balance, available margin, and open positions — v1.4
- ✓ PerpPositionManager: open/close/emergency-close long and short positions with pre-entry liquidation logging — v1.4
- ✓ PaperPerpEngine: mark-price-driven perp simulation with zero REST calls — v1.4
- ✓ Crash recovery: recoverFromRestart() reconciles DB sessions with FCM on restart — v1.4
- ✓ Post-only limit entry loop with cancel-and-reprice; NON_RETRYABLE_REASONS abort immediately — v1.4
- ✓ TP limit order + ATR trailing stop-limit ratchet; full order cleanup on position close — v1.4
- ✓ computeLeverage() and getMarginMode(): regime + conviction → integer leverage; isolated/cross policy — v1.4
- ✓ PerpRiskGate: margin utilization, exposure cap, and max-loss gate before every order — v1.4
- ✓ PerpMomentumStrategy + PerpMeanReversionStrategy: LONG/SHORT signals with funding-rate confidence adjustment — v1.4
- ✓ `npm run tournament:perp` — perp-specific walk-forward tournament with separate leaderboard — v1.4
- ✓ Regime auto-switch in PaperPerpEngine and PerpPositionManager with 10-candle cooldown — v1.4
- ✓ FundingRateTracker: cumulative cost per position, FUNDING_DRAIN_EXIT trigger — v1.4
- ✓ perpTrades SQLite table; `npm run report --type perp` with directional win rate, leverage, funding stats — v1.4
- ✓ Dashboard perp panels: PerpPositionsPanel, PerpFundingPanel, PerpLeverageMeter via WebSocket — v1.4

- ✓ `perpMode` (paper|live|none) in FCM config schema with cross-field refine — PERP_MODE=live without FCM_ENABLED fails at startup — v1.5
- ✓ PerpStateStore isolated to `data/perp.db` (separate from `data/trading.db`) — prevents SQLITE_BUSY — v1.5
- ✓ IntxClient error listener registered before `.start()` — transient FCM errors no longer crash the process — v1.5
- ✓ Correct shutdown ordering: perp engine → IntxClient → dashboard — no "Database is not open" on exit — v1.5
- ✓ `npm start` runs perp tournament (PIPE-01) and captures regime leaderboards for engine use — v1.5
- ✓ `npm start` launches PaperPerpEngine with BTC-USD candle routing when PERP_MODE=paper — v1.5
- ✓ `npm start` launches PerpPositionManager with recoverFromRestart() when PERP_MODE=live — v1.5
- ✓ `--skip-perp-tournament` flag skips tournament step, activates engine without leaderboards — v1.5
- ✓ Zero-trade guard: engine does not activate when perp tournament produces no OOS trades — v1.5

### Active

<!-- v1.6 and beyond — to be defined with /gsd:new-milestone -->

### Out of Scope

- Mobile app — web dashboard works on mobile browser
- Altcoins beyond BTC/ETH — keeping universe small for reliability
- High-frequency/market-making — latency requirements incompatible with local deployment
- Push notifications (Discord/Telegram) — dashboard-only monitoring, deferred to v2.0+
- Cloud deployment — runs locally, cloud is a future consideration
- AI/ML price prediction — overfitting trap for personal use
- Multi-exchange support — Coinbase only reduces complexity
- Options (calls/puts) — different pricing model (Black-Scholes, Greeks); deferred to v2.0+
- Advanced analytics (Sortino, Calmar, Omega) — deferred to v2.0+

## Context

Shipped v1.4 with ~65,166 LOC TypeScript across 78 test files, 1,122 tests.

**v1.0 baseline:** 55,764 LOC, 149 files, 773 tests
**v1.1 additions:** +5,520 net lines, 68 files changed, 444 tests passing
**v1.2 additions:** +3,340 net lines, 30 files changed, 527 tests passing
**v1.3 additions:** +4,225 net lines, 49 files changed, 638 tests passing
**v1.4 additions:** +11,542 net lines, 66 files changed, 1,122 tests passing

**Tech stack:** TypeScript/Node.js (ESM), better-sqlite3 + Drizzle ORM, Fastify + React 19 + Vite 6, Lightweight Charts v5, decimal.js, simple-statistics, fast-technical-indicators, coinbase-api (tiagosiebler), Zod v4, Pino, Vitest.

**Architecture:** Event-driven with interface abstraction — strategy code runs identically in backtest, paper, and live modes. EventEmitter pipeline connects trading engines to dashboard via WebSocket. All subsystems in a single Node.js process (avoids SQLite BUSY). ExitLogicManager is stateful per-position, instantiated at entry, providing priority-ordered exits (partial > trailing > atrStop > time) across all engines. Auto-switching state machine in spot and perp engines consults regimeLeaderboards on every candle, defers swaps while positions are open, and enforces a 10-candle cooldown. Perp system runs alongside spot: PerpPositionManager handles live FCM orders, PaperPerpEngine handles simulation (zero REST calls), PerpRiskGate gates every entry, and FundingRateTracker monitors drain exit triggers. `npm start` runs the full adaptive pipeline: sync → optimize exits → spot tournament → perp tournament → activate engines → dashboard.

**v1.5 additions:** +446/−113 lines, 11 files changed, 789 tests passing (11 new structural tests).

**Test coverage:** 789 tests across 64 test files (all passing).

## Constraints

- **Tech stack**: TypeScript/Node.js — developer preference
- **Exchange**: Coinbase Advanced Trade API only
- **Latency**: Not optimized for sub-second execution; intraday to swing timeframes
- **Budget**: Minimal infrastructure cost — local deployment, free data tiers
- **Security**: API keys in .env, never in source control

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| TypeScript/Node.js | Developer preference, good async I/O for WebSocket streams | ✓ Good — 35K LOC, type safety caught many bugs |
| Coinbase Advanced Trade API | Current primary Coinbase trading API | ✓ Good — REST + WebSocket worked well |
| BTC + ETH only | High liquidity, simpler universe management | ✓ Good — kept scope manageable |
| better-sqlite3 | Synchronous API fast for backtest loops | ✓ Good — zero overhead in hot path |
| decimal.js (20-digit precision) | Financial math must not use floats | ✓ Good — 0.1+0.2=0.3 confirmed |
| Custom backtest engine | No good TS backtesting library exists | ✓ Good — full control over event replay |
| fast-technical-indicators | ESM-compatible drop-in for technicalindicators | ⚠️ Revisit — required createRequire workaround for broken ESM entry |
| Fastify + React + Lightweight Charts | Dashboard stack | ✓ Good — fast server, imperative chart refs for real-time updates |
| coinbase-api (tiagosiebler) | Well-maintained Coinbase SDK | ✓ Good — handles auth, WebSocket reconnect |
| Event-driven architecture | Strategy code identical in backtest/paper/live | ✓ Good — core architectural win |
| Tournament-based strategy selection | Let data decide — removes emotional bias | ✓ Good — walk-forward prevents overfitting |
| Kelly criterion position sizing | Optimal geometric growth rate | ✓ Good — half-Kelly default is conservative |
| Single-process architecture (v1.1) | All subsystems in one Node.js process | ✓ Good — avoids SQLite BUSY errors, simplifies shutdown |
| Push-order shutdown (v1.1) | Engines stop before dashboard | ✓ Good — avoids race conditions on Ctrl+C |
| Composite MC p5 Sharpe (v1.1) | 30% MC weight, penalize unstable strategies | ✓ Good — conservative default from research |
| Optional regime param on IStrategy (v1.1) | Backward-compatible regime detection | ✓ Good — all 5 strategies work unchanged |
| Native number in MC hot loop (v1.1) | Performance in simulation loop | ✓ Good — 1000 iter × 50 trades < 5ms |
| Conditional pre-script UI build (v1.1) | Only rebuild when index.html missing | ✓ Good — fast `npm start` on subsequent runs |
| ExitLogicManager stateful per-position (v1.2) | Single interface for all exit types, instantiated at entry | ✓ Good — clean separation, all engines use same interface |
| Priority tree: partial > trailing > atrStop > time (v1.2) | Partial first captures profit; trailing tracks peak; ATR provides dynamic floor; time prevents dead capital | ✓ Good — intuitive priority, no conflicts |
| Breakeven floor after partial exit (v1.2) | ATR stop floored at entryPrice after partial fires | ✓ Good — prevents stop sliding below entry after taking partial profit |
| Client-side useMemo for dashboard metrics (v1.2) | Avoids new WS events, REST endpoints, or duplicate data pipeline | ✓ Good — zero infrastructure cost, instant updates |
| SD uses close prices for Z-score (v1.3) | Mean reversion requires close-price standard deviation | ✓ Good — consistent with Z-score conventions |
| Prior-candle breakout in momentum strategy (v1.3) | Highest/Lowest on candles.slice(0,-1) avoids tautology | ✓ Good — signals are genuine breakouts |
| Exits excluded from strategy config hash (v1.3) | Prevents infinite re-optimization loop | ✓ Good — optimizer only re-runs when strategy params change |
| regimeLeaderboards optional on all engine options (v1.3) | Backward compat — absent means behavior unchanged | ✓ Good — zero breaking changes across existing code |
| First undefined-to-known transition does NOT switch (v1.3) | Requires currentRegime !== undefined to trigger | ✓ Good — prevents spurious switch on first candle |
| ExitLogicManager cleared on strategy switch (v1.3) | State never transferred across strategies | ✓ Good — prevents stale exit state corrupting new strategy |
| checkAndExecutePendingSwitch at all close paths (v1.3) | Paper: 3 close paths; Live: onOrderFilled EXIT/STOP_LOSS | ✓ Good — deferred switch fires reliably on position close |
| CBAdvancedTradeClient for FCM (v1.4) | FCM available via Advanced Trade API using same spot credentials; no separate CBInternationalClient needed | ✓ Good — single credential set, simpler auth path |
| IOC MARKET orders only for perp entry/exit (v1.4) | No partial fills to track; simplifies position state management | ✓ Good — clean fill semantics, no partial-fill edge cases |
| PaperPerpEngine separate from PerpPositionManager (v1.4) | Guarantees zero REST calls in paper path; no placeOrder/cancelOrder in simulation | ✓ Good — safe to run paper without FCM credentials |
| Bot-internal leverage and margin mode (v1.4) | Coinbase FCM has no setLeverage or setMarginMode API; values are sizing policy only | ✓ Good — avoids confusion; explicit in logs |
| PerpRiskGate optional injection on both engines (v1.4) | null when absent; zero breaking changes for existing callers | ✓ Good — backward-compat; risk gate is opt-in |
| No blended P&L metric in report (v1.4) | Spot and perp P&L separate; early return enforces separation | ✓ Good — no accidental cross-contamination of performance |
| PERP_EVENT_MAP local const (v1.4) | Not merged into ENGINE_EVENT_MAP; prevents spot event name collisions | ✓ Good — clean isolation between spot and perp event pipelines |
| createLivePerpRegistry(provider) factory (v1.4) | Injects real funding callback so funding adjustment fires at runtime; null in tournament | ✓ Good — decoupled; tournament mode and live mode use same strategies |
| FundingRateTracker optional injection (v1.4) | Test control without real notional math; drain guard checks both drain and emergency flags | ✓ Good — concurrent close races prevented |
| perpMode chained .refine() on fcmConfigSchema (v1.5) | Not .omit() — documented Zod v4 pitfall breaks refined schemas | ✓ Good — clean cross-field validation |
| perpActivationReady boolean sentinel (v1.5) | Avoids double resources.push and sentinel-undefined confusion in zero-trade and error paths | ✓ Good — clear activation gate |
| fundingRateProvider = () => null in npm start (v1.5) | FCM funding rate not yet integrated into start.ts; FundingRateTracker handles drain internally via events | ✓ Good — correct for paper mode; live can wire later |
| Separate data/perp.db for PerpStateStore (v1.5) | Prevents SQLITE_BUSY with concurrent spot tournament writes | ✓ Good — zero contention confirmed |

---
*Last updated: 2026-03-14 after v1.5 milestone — Perp End-to-End Integration shipped*
