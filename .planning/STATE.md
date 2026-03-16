# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-03-15)

**Core value:** The bot must reliably execute trades with correct position sizing, risk limits, and stop-losses -- never losing more than configured risk parameters allow.
**Current focus:** v2.1 Pre-Live Reliability — dashboard fixes + strategy quality

## Current Position

Phase: 43 — Trade Diagnostics
Plan: 02 complete
Status: In progress
Last activity: 2026-03-16 — 43-02 complete: entry-signal Pino INFO logging in spot + perp paper engines

Progress: [█████████████████████░░░░░░░░░] ~68% (42/~45 phases, 2/~8 plans est.)

## Performance Metrics

**v2.0 Totals:**
- 16 plans completed across 6 phases
- 41 files changed, +2,465/−88 lines
- 845 tests passing (67 test files)
- Timeline: 1 day (2026-03-15)

**v2.1 In-progress:**
- 42-01: 5 files changed, +146/−0 lines, 849 tests passing, 3 min
- 42-02: 7 files changed, +117/−29 lines, 849 tests passing, 3 min
- 43-01: 1 file changed, +68/−0 lines, 849 tests passing, 3 min
- 43-02: 3 files changed, +167/−15 lines, 851 tests passing, 4 min

## Accumulated Context

### Decisions

All v1.0–v2.0 decisions logged in PROJECT.md Key Decisions table.

**v2.0 pre-execution notes (from research):**
- INFRA-01: DONE (36-01) — Removed `if (!this.currentPosition) return` guard from `_onFundingRate` in paper-perp-engine.ts
- INFRA-02: DONE (36-02) — IntxClient.getLastFundingRate() wired to fundingRateProvider in start.ts (both paper + live branches)
- INFRA-03: DONE (36-02) — perpLiveFeed.start() now routes both BTC-USD and ETH-USD
- FEES-01: DONE (37-01) — IntxClient.fetchFeeConfig() wraps getTransactionSummary({product_type:'FUTURE',product_venue:'FCM'}); FeeConfig interface and DEFAULT_FEE_CONFIG in src/perp/fee-config.ts
- FEES-01-TESTS: DONE (37-02) — 5 TDD tests for fetchFeeConfig() in intx-client.test.ts; mockGetTransactionSummary wired via vi.hoisted()
- FEES-04: Fee threshold is a FIXED CONSTANT from FeeConfig, NOT a swept parameter (anti-overfitting, Pitfall 2)
- FEES-02/03: `fundingCost` and `totalFees` MUST be separate fields — never merge (fee double-counting is Pitfall 1)
- FEES-04: Fee threshold is a FIXED CONSTANT from FeeConfig, NOT a swept parameter (anti-overfitting, Pitfall 2)
- STRAT-01/02: Run `scripts/verify-index-price.ts` before writing any strategy logic — if indexPrice === markPrice, both strategies return null signals
- DASH-01: `isFinal=true` FCM funding events only; step interpolation; HistogramSeries
- DASH-02: Server-side 1/minute max downsampling; BaselineSeries; ring buffer 1440 pts
- DASH-03: AreaSeries on existing `perpExposureUpdate` events; explicit zero-point broadcast on position close
- [Phase 37]: feeConfig optional on PerpTournamentOptions, feeTierTaker/Maker wired to parseTournamentConfig — backward-compatible injection pattern for FCM fee rates
- [38-01]: fundingCost: Decimal added to BacktestResult and PerformanceMetrics; always ZERO in backtest/walk-forward; TournamentStore serializes/deserializes with ?? '0' backward-compat fallback; perp tournament now uses FCM_FALLBACK_TAKER_RATE (0.0003) not spot 0.0075
- [38-02]: FEES-02 test (engine.test.ts): higher feeTierTaker produces higher totalFees confirmed. FEES-03 tests (metrics.test.ts): fundingCost passthrough, independence from totalFees, Decimal type all verified. All 7 makeMetrics/makeResult helpers now include fundingCost: ZERO.
- [39-01]: FEES-04 enforced: PerpRiskGate Check 4 FEE_DRAG_EXCESSIVE uses fixed FeeConfig constant (not swept param). lte() semantics: equal-to-fee rejected. feeConfig optional in PerpRiskGateOptions → DEFAULT_FEE_CONFIG fallback. expectedGain computed from tpTargetPct at both callsites.
- [39-02]: FundingRateArbitrageStrategy: tournamentMode=true always returns []; regime gate RANGING/VOLATILE only; division guard for indexPrice=0; returns [] when indexPrice===markPrice (current FCM reality). BasisTradeStrategy: no regime filter (basis arb is regime-agnostic); SD=0 guard handles constant basis (FCM reality). markPriceProvider/basisProvider/tournamentMode excluded from Zod schemas (not serializable) — matches perp strategy pattern.
- [39-03]: createPerpRegistry() now has 4 strategies (perp-momentum, perp-mean-reversion, funding-rate-arb, basis-trade); createLivePerpRegistry() adds optional markPriceProvider second param (existing callers unchanged); tournament:perp exits 0 with all 4 strategies; scripts/verify-index-price.ts documents FCM indexPrice===markPrice static analysis finding.
- [40-01]: executeStrategySwitch regime? param optional (backward-compat); pendingSwitch type carries regime? so deferred switches preserve triggering regime; log format 'regime TRENDING: switching to PerpMomentumStrategy'; PerpPositionManager logs have no [PAPER] prefix per convention.
- [40-03]: Structural test scans 15 lines after constructor call instead of exact line — tolerates minor formatting changes.
- [Phase 40]: PERP-SW-02/PM-SW-02: Open position manually before regime candle to test deferred switch — avoids async timing issue with evaluate()-triggered openPaperPosition
- [41-01]: DASH-01/02 ring buffers sized 500 bars (funding) and 1440 pts (P&L — 24h at 1/min). Dual-listener on fundingUpdate: PERP_EVENT_MAP handles perpFundingUpdate; separate listener handles histogram + P&L. buildSnapshot() extended with optional ring buffer params (not closures). unrealizedPnl? optional in fundingUpdate type (no-session branch omits). Monotonic second guard on P&L broadcast prevents duplicate chart timestamps.
- [Phase 41]: FundingHistoryChart props use HistogramData[] directly (not PerpFundingBarPayload[]) — App.tsx converts at call site
- [Phase 41]: PnlCurveChart BaselineSeries baseValue: { type: 'price', price: 0 } — type discriminant required by BaseValuePrice
- [Phase 41]: LeverageHistoryChart is client-side only — no ring buffer hydration per DASH-03; chart shows empty on reconnect
- [41-03]: P&L ring buffer cleared on perpExposureUpdate utilizationPct === '0.00' (position close) — prevents cross-position P&L accumulation; also triggers setPnlData([])
- [41-03]: Monotonic timestamp guard for AreaSeries: nowSec > lastLeverageSecondRef ? nowSec : lastLeverageSecondRef + 1 — prevents duplicate chart timestamps
- [41-03]: App.tsx chart data flows two ways — snapshot/initial via state prop (triggers setData), real-time via ref.current?.addPoint() (zero re-renders)
- [41-bugfix]: PaperPerpEngine._onFundingRate() session-open branch missed unrealizedPnl in fundingUpdate emit — captured to local var, passed to both stateStore and emit. Server P&L chart was receiving undefined → 0.
- [41-bugfix]: IntxClient guard `if (summary?.funding_hold)` skipped null/zero funding_hold → no fundingRate events in paper mode without real FCM position → histogram showed "awaiting data" forever. Fixed to emit on any non-null futures_balance_summary message.

**v2.1 execution notes (42-01):**
- [42-01]: DASH-01 root cause: session.markPrice never updated in memory — stateStore.updateSession persists to DB only, does not mutate in-memory session object. Fixed by adding `session.markPrice = evt.markPrice` before `_computeUnrealizedPnl` call in both engines.
- [42-01]: PerpPositionManagerEvents now has markPriceUpdate: [{sessionId, instrument, markPrice, unrealizedPnl}] — emitted on every non-stale mark price tick when a position is open.
- [42-01]: `session.cumulativeFundingCost ?? '0.00000000'` guard required before first funding event fires.

**v2.1 execution notes (42-02):**
- [42-02]: Two independent P&L throttle paths: MARK_PRICE_PNL_THROTTLE_MS=5s (markPriceUpdate) and PNL_THROTTLE_MS=60s (fundingUpdate) — same pnlRingBuffer, different rates.
- [42-02]: perpMarkPriceUpdate added as proper WsMessageType member — no as any cast needed on broadcaster.broadcast().
- [42-02]: App.tsx perpMarkPriceUpdate case merges partial update via prev.map() — only updates markPrice/unrealizedPnl fields, preserves all other position data.
- [42-02]: lastUpdatedAt?: number pattern on all three perp panels — shows 'Updated: HH:MM:SS' or 'Awaiting data' based on undefined state.

**v2.1 execution notes (43-01):**
- [43-01]: DIAG-01 per-trade fee attribution: perp branch shows grossPnl (realizedPnl), fundingCost (cumulativeFundingCost), estimatedFees as "N/A (paper)", netPnl = gross+funding; spot branch shows grossPnl (pnl+fees), totalFees (entry+exit), netPnl (pnl)
- [43-01]: Tables print by default (not behind --trades flag) per DIAG-01 requirement
- [43-01]: Perp taker fees not stored in perp_trades for paper mode — shown as "N/A (paper)" to avoid fabricating data

**v2.1 execution notes (43-02):**
- [43-02]: DIAG-02 entry-signal log placed before isFlat() guard in spot engine (logs even when position blocks entry); inside long/short guard in perp engine (only actionable directions)
- [43-02]: vi.hoisted + vi.mock pattern for createModuleLogger interception -- required because module-level `const log = createModuleLogger()` runs before test body

**v2.1 roadmap notes (revised 2026-03-15):**
- Constraint: No new `npm run` scripts. All strategy performance stats, paper performance summaries, and live readiness status go in the dashboard as auto-updating panels. Only `npm run report` may be extended (DIAG-01).
- Phase 42 (DASH-01/02/03): Investigate why unrealizedPnl and fundingCost arrive as 0 in dashboard despite v2.0 fixes; the [41-bugfix] notes are starting context — trace the full WS event path from PaperPerpEngine emit through WsBroadcaster to React panel.
- Phase 43 (DIAG-01): Per-trade fee attribution extends existing `npm run report` output (gross P&L, fees, funding cost, net P&L per trade).
- Phase 43 (DIAG-02): Signal logging uses existing Pino instance at INFO level — no new scripts or log levels.
- Phase 43 (DIAG-03): "Strategy Performance" dashboard panel — per-strategy win rate, avg gross/net P&L, avg fees, fee-drag ratio; auto-updates via WebSocket as paper trades close. This is NOT a CLI command.
- Phase 44 (SIG-01): Spot fee gate mirrors PerpRiskGate Check 4 — ATR-estimated expected move vs round-trip fee; uses existing FeeConfig from startup; configurable multiple via env/config.
- Phase 44 (SIG-02): Strategy params currently hardcoded in strategy files; need config injection pattern via .env or config file; must be backward-compatible (defaults preserve existing behavior).
- Phase 45 (GATE-01): Gate check runs inside `npm start` startup sequence — reads paper trade history from DB; configurable threshold (min trades + min net P&L); fails fast before any engine init.
- Phase 45 (GATE-02): "Live Readiness" dashboard panel — go/no-go indicator, paper track record summary, risk config values, fee tier confirmation; auto-updates as new paper trades complete. This is NOT a CLI command.

### Open Issues / Tech Debt

- fast-technical-indicators createRequire workaround (inherited, low priority)
- `indexPrice` FCM field distinctness from `markPrice` confirmed equal (strategies return [] in practice, wired for future FCM fix)
- Phase 42 DASH-01/02/03 fully resolved: engine emits markPriceUpdate → server broadcasts perpPnlUpdate (5s) + perpMarkPriceUpdate → panels update with timestamps

### Blockers

None.

## Session Continuity

Last session: 2026-03-16
Stopped at: Completed 43-02-PLAN.md. Entry-signal Pino INFO logging added to spot paper-engine.ts (processEntrySignal) and perp paper-perp-engine.ts (onCandle). 2 tests added. 851 tests passing.
