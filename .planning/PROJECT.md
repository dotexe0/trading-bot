# Crypto Trading Bot

## What This Is

A quant-grade cryptocurrency trading bot targeting Coinbase Advanced Trade API, built with TypeScript/Node.js. It runs automated trading strategies on BTC and ETH pairs, selected through empirical backtesting tournaments. The system covers the full lifecycle: historical data collection, backtesting, paper trading, live trading, and a web dashboard for monitoring and control.

## Core Value

The bot must reliably execute trades with correct position sizing, risk limits, and stop-losses — never losing more than configured risk parameters allow, even during system failures or market volatility.

## Requirements

### Validated

(None yet — ship to validate)

### Active

- [ ] Backtest multiple strategies against historical BTC/ETH data
- [ ] Tournament-based strategy selection — data picks the winners
- [ ] Multi-timeframe analysis (1m to 1D candles)
- [ ] Full risk framework: position-level stops + portfolio-level circuit breakers
- [ ] Paper trading with local simulation and Coinbase sandbox
- [ ] Fully automated live trading via Coinbase Advanced Trade API
- [ ] Web dashboard with PnL metrics, equity curves, and strategy controls
- [ ] Historical data pipeline: external providers for bulk + Coinbase for recent, cached locally
- [ ] Kelly criterion or fixed-fraction position sizing
- [ ] Max drawdown circuit breaker and exposure caps

### Out of Scope

- Mobile app — web dashboard is sufficient for v1
- Altcoins beyond BTC/ETH — keeping universe small for reliability
- High-frequency/market-making — latency requirements incompatible with local deployment
- Push notifications (Discord/Telegram/email) — dashboard-only monitoring for v1
- Cloud deployment — runs locally, cloud is a future consideration
- Manual trade approval workflow — fully automated, no semi-auto mode

## Context

- **Exchange**: Coinbase Advanced Trade (REST + WebSocket APIs)
- **Asset universe**: BTC-USD and ETH-USD pairs only
- **Capital range**: $1K-$10K — meaningful but manageable risk
- **Deployment**: Local machine, always-on during trading
- **Data sources**: CryptoCompare or similar for deep historical data, Coinbase API for recent/live data, SQLite or similar for local cache
- **Strategy philosophy**: Strategy-agnostic framework. Momentum, mean reversion, and other approaches compete in backtesting tournaments. Best empirical performers get deployed.
- **Paper trading**: Dual-mode — local simulation engine for fast iteration, plus Coinbase sandbox for realistic order fill testing

## Constraints

- **Tech stack**: TypeScript/Node.js — developer preference
- **Exchange**: Coinbase Advanced Trade API only — no multi-exchange support
- **Latency**: Not optimized for sub-second execution; intraday to swing timeframes
- **Budget**: Minimal infrastructure cost — local deployment, free data tiers where possible
- **Security**: API keys must be stored securely, never in source control

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| TypeScript/Node.js | Developer preference, good async I/O for WebSocket streams | — Pending |
| Coinbase Advanced Trade API | Current primary Coinbase trading API | — Pending |
| BTC + ETH only | High liquidity, simpler universe management, lower complexity | — Pending |
| Tournament-based strategy selection | Let data decide — removes emotional bias from strategy choice | — Pending |
| Local deployment | Lower cost, acceptable for non-HFT strategies | — Pending |
| Full risk framework | $1K-$10K capital requires disciplined risk management | — Pending |

---
*Last updated: 2026-02-09 after initialization*
