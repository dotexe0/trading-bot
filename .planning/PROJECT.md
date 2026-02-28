# Crypto Trading Bot

## What This Is

A quant-grade cryptocurrency trading bot targeting Coinbase Advanced Trade API, built with TypeScript/Node.js. It runs automated trading strategies on BTC-USD and ETH-USD, selected through empirical backtesting tournaments with walk-forward validation. The system covers the full lifecycle: historical data ingestion, technical indicator computation, strategy evaluation, backtesting, Monte Carlo robustness testing, risk management with correlation-aware sizing, paper trading, live trading, tournament-based strategy selection with regime detection, and a real-time web dashboard with backtest visualization and portfolio heat map.

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

### Active

(None — define requirements for next milestone with `/gsd:new-milestone`)

### Out of Scope

- Mobile app — web dashboard works on mobile browser
- Altcoins beyond BTC/ETH — keeping universe small for reliability
- High-frequency/market-making — latency requirements incompatible with local deployment
- Push notifications (Discord/Telegram) — dashboard-only monitoring, deferred to v2.0+
- Cloud deployment — runs locally, cloud is a future consideration
- AI/ML price prediction — overfitting trap for personal use
- Multi-exchange support — Coinbase only reduces complexity
- Options/futures — different instruments with different risk models
- Advanced analytics (Sortino, Calmar, Omega) — deferred to v2.0+

## Context

Shipped v1.2 with ~30,600 LOC TypeScript across ~185 files.

**v1.0 baseline:** 55,764 LOC, 149 files, 773 tests
**v1.1 additions:** +5,520 net lines, 68 files changed, 444 tests passing
**v1.2 additions:** +3,340 net lines, 30 files changed, 527 tests passing

**Tech stack:** TypeScript/Node.js (ESM), better-sqlite3 + Drizzle ORM, Fastify + React 19 + Vite 6, Lightweight Charts v5, decimal.js, simple-statistics, fast-technical-indicators, coinbase-api (tiagosiebler), Zod v4, Pino, Vitest.

**Architecture:** Event-driven with interface abstraction — strategy code runs identically in backtest, paper, and live modes. EventEmitter pipeline connects trading engines to dashboard via WebSocket. All subsystems in a single Node.js process (avoids SQLite BUSY). ExitLogicManager is stateful per-position, instantiated at entry, providing priority-ordered exits (partial > trailing > atrStop > time) across all engines.

**Test coverage:** 527 tests across 49 test files (all passing).

## Constraints

- **Tech stack**: TypeScript/Node.js — developer preference
- **Exchange**: Coinbase Advanced Trade API only
- **Latency**: Not optimized for sub-second execution; intraday to swing timeframes
- **Budget**: Minimal infrastructure cost — local deployment, free data tiers
- **Security**: API keys in .env, never in source control

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| TypeScript/Node.js | Developer preference, good async I/O for WebSocket streams | ✓ Good — 27K LOC, type safety caught many bugs |
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
| pnlPct already a percentage string convention (v1.2) | TradeData.pnlPct is already a percentage (e.g., "5.0" = 5%) — no × 100 needed | ✓ Good — consistent with TradeHistory.tsx convention |

---
*Last updated: 2026-02-28 after v1.2 milestone completion*
