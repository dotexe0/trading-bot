# Crypto Trading Bot

## What This Is

A quant-grade cryptocurrency trading bot targeting Coinbase Advanced Trade API, built with TypeScript/Node.js. It runs automated trading strategies on BTC-USD, ETH-USD, BTC-PERP, and ETH-PERP, selected through empirical backtesting tournaments with walk-forward validation. The system covers the full lifecycle: historical data ingestion, technical indicator computation, strategy evaluation, fee-aware backtesting, Monte Carlo robustness testing, risk management with correlation-aware sizing, paper trading, live trading, regime-aware strategy selection, live auto-switching, exit optimization, fee-aware perpetual futures trading with leverage/margin management, funding rate tracking, four perp strategies optimized per regime, a real-time dashboard with funding rate history, P&L curve, and leverage utilization charts, per-trade fee attribution in `npm run report`, entry-signal structured logging, per-strategy performance dashboard panel, spot fee-drag gate, configurable strategy params via `.env`, and a pre-live gate that prevents live activation without demonstrated paper profitability. Running `npm start` executes the full adaptive pipeline end-to-end.

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
- ✓ Funding panel emits live funding rate data continuously, even with no position open — v2.0
- ✓ Live `fundingRateProvider` wired in `start.ts` for PerpPositionManager — v2.0
- ✓ ETH-PERP candle feed routed to perp engines alongside BTC-USD — v2.0
- ✓ Dynamic FCM fee fetch at startup via `fetchFeeConfig()`; FeeConfig singleton available to all subsystems — v2.0
- ✓ Backtest P&L deducts taker fee at entry and exit; rate sourced from FeeConfig — v2.0
- ✓ `PerformanceMetrics` tracks `totalFees` and `fundingCost` as separate, never-merged fields — v2.0
- ✓ PerpRiskGate Check 4 (`FEE_DRAG_EXCESSIVE`): rejects entries where expected gain < round-trip fee — v2.0
- ✓ `FundingRateArbitrageStrategy`: implied funding carry signal, regime-gated RANGING/VOLATILE — v2.0
- ✓ `BasisTradeStrategy`: Z-score of rolling basis from `markPrice/indexPrice` — v2.0
- ✓ Perp tournament runs in regime-aware mode; `regimeLeaderboards` wired to `PaperPerpEngine` and `PerpPositionManager` — v2.0
- ✓ Funding rate history histogram (`HistogramSeries`) in dashboard — v2.0
- ✓ Per-position P&L curve (`BaselineSeries`) with 1/min server-side downsampling — v2.0
- ✓ Leverage utilization history (`AreaSeries`) from `perpExposureUpdate` events — v2.0
- ✓ Dashboard P&L and funding cost update live during active perp positions — mark price events throttled at 5s — v2.1
- ✓ All three perp panels show "last updated" timestamp; stale panels immediately visible — v2.1
- ✓ `npm run report` (spot + perp) prints per-trade gross P&L, total fees, funding cost, net P&L — v2.1
- ✓ Entry-signal Pino INFO record with instrument, strategy, direction, and key indicator values — v2.1
- ✓ Dashboard "Strategy Performance" panel: per-strategy win rate, avg gross/net P&L, avg fees, fee-drag ratio — v2.1
- ✓ SpotSignalGate: ATR-estimated expected move must exceed configurable multiple of round-trip fee — v2.1
- ✓ Key spot strategy params (RSI, BB period, Z-score window, fee-drag multiple, ATR period) configurable via `.env` — v2.1
- ✓ PreLiveGate: `npm start` with live mode fails fast (before engine init) when paper net P&L is below threshold — v2.1
- ✓ Dashboard "Live Readiness" panel: GO/NO-GO badge, paper track record, risk config, fee tier; auto-updates via WS — v2.1

### Active

<!-- Next milestone requirements defined via /gsd:new-milestone -->

### Out of Scope

- Mobile app — web dashboard works on mobile browser
- Altcoins beyond BTC/ETH — keeping universe small for reliability
- High-frequency/market-making — latency requirements incompatible with local deployment
- Push notifications (Discord/Telegram) — dashboard-only monitoring, deferred to v2.0+
- Cloud deployment — runs locally, cloud is a future consideration
- AI/ML price prediction — overfitting trap for personal use
- Multi-exchange support — Coinbase only reduces complexity
- Options (calls/puts) — different pricing model (Black-Scholes, Greeks); deferred to v3.0+
- Advanced analytics (Sortino, Calmar, Omega) — deferred to v3.0+

## Context

Shipped v2.1 with ~83,873 LOC TypeScript across 69 test files, 870 tests.

**v1.0 baseline:** 55,764 LOC, 149 files, 773 tests
**v1.1 additions:** +5,520 net lines, 68 files changed, 444 tests passing
**v1.2 additions:** +3,340 net lines, 30 files changed, 527 tests passing
**v1.3 additions:** +4,225 net lines, 49 files changed, 638 tests passing
**v1.4 additions:** +11,542 net lines, 66 files changed, 1,122 tests passing
**v1.5 additions:** +446/−113 lines, 11 files changed, 789 tests passing
**v2.0 additions:** +2,465/−88 lines, 41 files changed, 845 tests passing (6 phases, 16 plans)
**v2.1 additions:** +1,939/−48 lines, 30 files changed, 870 tests passing (4 phases, 9 plans)

**Tech stack:** TypeScript/Node.js (ESM), better-sqlite3 + Drizzle ORM, Fastify + React 19 + Vite 6, Lightweight Charts v5, decimal.js, simple-statistics, fast-technical-indicators, coinbase-api (tiagosiebler), Zod v4, Pino, Vitest.

**Architecture:** Event-driven with interface abstraction — strategy code runs identically in backtest, paper, and live modes. EventEmitter pipeline connects trading engines to dashboard via WebSocket. All subsystems in a single Node.js process (avoids SQLite BUSY). ExitLogicManager is stateful per-position, instantiated at entry, providing priority-ordered exits (partial > trailing > atrStop > time) across all engines. Auto-switching state machine in spot and perp engines consults regimeLeaderboards on every candle, defers swaps while positions are open, and enforces a 10-candle cooldown. Perp system runs alongside spot: PerpPositionManager handles live FCM orders, PaperPerpEngine handles simulation (zero REST calls), PerpRiskGate gates every entry, and FundingRateTracker monitors drain exit triggers. SpotSignalGate gates spot entries by ATR-estimated fee drag. PreLiveGate runs at startup to enforce minimum paper track record before live mode is allowed. `npm start` runs the full adaptive pipeline: sync → optimize exits → spot tournament → perp tournament → pre-live gate check → activate engines → dashboard.

**Test coverage:** 870 tests across 69 test files (all passing).

## Constraints

- **Tech stack**: TypeScript/Node.js — developer preference
- **Exchange**: Coinbase Advanced Trade API only
- **Latency**: Not optimized for sub-second execution; intraday to swing timeframes
- **Budget**: Minimal infrastructure cost — local deployment, free data tiers
- **Security**: API keys in .env, never in source control
- **No new npm scripts**: All monitoring and diagnostics surface in dashboard panels; only `npm run report` may be extended

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
| FeeConfig from `fetchFeeConfig()` at startup (v2.0) | Dynamic fee vs hardcoded constant — fee changes per tier | ✓ Good — `FCM_FALLBACK_TAKER_RATE` as safe startup default |
| Fee threshold FIXED CONSTANT not swept param (v2.0) | Swept fee thresholds cause catastrophic OOS Sharpe collapse (anti-overfitting) | ✓ Good — enforced in PerpRiskGate Check 4 |
| `fundingCost` and `totalFees` NEVER merged (v2.0) | Fee double-counting corrupts P&L accuracy fundamentally | ✓ Good — separate fields in `BacktestResult` and `PerformanceMetrics` |
| `FundingRateArbitrageStrategy` always returns [] in tournamentMode (v2.0) | Tournament has no real FCM funding flow → spurious signals | ✓ Good — live-only strategy, tournament-safe guard |
| `BasisTradeStrategy` SD=0 guard for constant basis (v2.0) | FCM `indexPrice === markPrice` in practice → Z-score undefined | ✓ Good — returns [] gracefully, wired for future FCM fix |
| `executeStrategySwitch` regime? param optional (v2.0) | Backward-compat with all existing callers not yet regime-aware | ✓ Good — zero breaking changes |
| Dual-listener on `fundingUpdate` (v2.0) | `PERP_EVENT_MAP` handles `perpFundingUpdate`; separate handles histogram + P&L | ✓ Good — no event name collisions |
| P&L ring buffer 1440 pts at 1/min throttle (v2.0) | Exactly 24h coverage; monotonic second guard prevents duplicate chart timestamps | ✓ Good — no data loss, no Lightweight Charts errors |
| `IntxClient` emits `fundingRate` on any `futures_balance_summary` message (v2.0) | `funding_hold` is null/0 in paper mode without real FCM position — histogram would show "awaiting data" forever | ✓ Good — histogram stays live with zero bars when no position |
| `session.markPrice` mutated in-memory before `_computeUnrealizedPnl` (v2.1) | `stateStore.updateSession` persists to DB only — in-memory object was stale, P&L always computed as 0 | ✓ Good — root cause of DASH-01; one-line fix unlocked all P&L chart updates |
| Two independent P&L throttle paths (v2.1) | `markPriceUpdate` at 5s for chart responsiveness; `fundingUpdate` at 60s for ring buffer accuracy | ✓ Good — chart feels live without ring buffer thrashing |
| `lastUpdatedAt?: number` pattern on all perp panels (v2.1) | `undefined` = "Awaiting data"; number = formatted HH:MM:SS timestamp | ✓ Good — stale panels immediately distinguishable |
| Entry-signal log before `isFlat()` guard in spot engine (v2.1) | Logs even when position blocks entry — surfaces what would have been entered if flat | ✓ Good — DIAG-02 captures both blocked and executed signals |
| `strategyName` optional field through full pipeline (v2.1) | Backward compat with live trades lacking `entryFill.signal.strategyName` | ✓ Good — Strategy Performance panel excludes nameless strategies |
| SpotSignalGate mirrors PerpRiskGate Check 4 with `lte()` semantics (v2.1) | Spot taker 0.0075 (not FCM 0.0003); equal-to-fee also rejected | ✓ Good — consistent gate semantics across spot and perp |
| `spotStrategyOverrides` in config with Zod defaults (v2.1) | `.default({ feeDragMultiple: 2.0, feeDragAtrPeriod: 14 })` not `.default({})` — TS requires explicit inner values | ✓ Good — backward-compat; undefined overrides use registry defaults |
| PreLiveGate reads SessionStore (spot) + PerpStateStore (perp) separately (v2.1) | Unified P&L across markets; each market checked independently with decimal.js aggregation | ✓ Good — gate fails fast if EITHER market has negative track record |
| LiveReadinessPanel auto-updates via `orderFilled` WS → `setTrades()` → `useMemo` (v2.1) | No new WS events; re-uses existing pipeline to recompute gate status on trade close | ✓ Good — zero infrastructure cost; panel stays live |

---
*Last updated: 2026-03-22 after v2.1 Pre-Live Reliability milestone complete*
