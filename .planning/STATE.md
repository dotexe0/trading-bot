# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-03-22)

**Core value:** The bot must reliably execute trades with correct position sizing, risk limits, and stop-losses -- never losing more than configured risk parameters allow.
**Current focus:** v2.2 Live Trading Hardening -- Phase 47 Slippage Tracking

## Current Position

Phase: 47 of 49 (Slippage Tracking) -- COMPLETE
Plan: 2 of 2
Status: Phase Complete
Last activity: 2026-03-22 -- Plan 47-02 complete (slippage display: CLI report table, dashboard PerformancePanel metric, TradeHistory column)

Progress: [███████████████░░░░░░░░░░░░░░░] 50% (2/4 phases complete, ready for Phase 48)

## Performance Metrics

**v2.1 Totals:**
- 9 plans completed across 4 phases
- 30 files changed, +1,939/-48 lines
- 870 tests passing (69 test files)
- Timeline: 2026-03-16 to 2026-03-22

**v2.1 Plan Details:**
- 42-01: 5 files, +146 lines, 849 tests, 3 min
- 42-02: 7 files, +117/-29 lines, 849 tests, 3 min
- 43-01: 1 file, +68 lines, 849 tests, 3 min
- 43-02: 3 files, +167/-15 lines, 851 tests, 4 min
- 43-03: 3 files, +81 lines, 834 tests, 5 min
- 44-01: 7 files, +278/-5 lines, 859 tests, 6 min
- 44-02: 9 files, +122/-11 lines, 859 tests, 5 min
- 45-01: 4 files, +609/-3 lines, 870 tests, 5 min
- 45-02: 6 files, +249 lines, 870 tests, 5 min

**v2.2 Plan Details:**
- 46-01: 2 files, +466 lines, 882 tests, 3 min
- 46-02: 8 files, +400 lines, 887 tests, 10 min
- 46-03: 4 files, +113 lines, 882 tests, 3 min
- 47-01: 7 files, +463 lines, 894 tests, 8 min
- 47-02: 5 files, +103 lines, 894 tests, 3 min

## Accumulated Context

### Decisions

All v1.0-v2.1 decisions logged in PROJECT.md Key Decisions table.
- 46-01: 2.5x stale multiplier (not 2.0x) for grace buffer against timer drift; 5x dead multiplier for DEAD severity; Date.now() receipt time not candle.timestamp
- 46-02: Guard after buffer.push() before signal eval (candles always buffered); optional chaining for backward compat; synchronous re-hydration on reconnect; 'feedHealth' as any for wave-2 parallel type
- 46-03: Two-color scheme (green LIVE, red STALE/DEAD -- no yellow); upsert-and-sort for feedHealth WS state; panel above LiveReadinessPanel for visibility
- 47-01: Stop-loss exitSignalPrice uses check.stopPrice not candle.close; signal prices null after restart recovery; slippage strings with 4 decimal bps / 8 decimal prices
- 47-02: CLI slippage table uses raw LiveTrade[] not normalized Trade[]; null-safe display for old data; round-trip = entry + exit bps with red/green coloring

### Open Issues / Tech Debt

- fast-technical-indicators createRequire workaround (inherited, low priority)
- `indexPrice` FCM field confirmed equal to `markPrice` in practice (strategies return [] -- wired for future FCM fix)

### Blockers

None.

## Session Continuity

Last session: 2026-03-22
Stopped at: Phase 47 Slippage Tracking complete (2/2 plans). 894 tests passing. Ready to proceed to Phase 48.
