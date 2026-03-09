---
phase: 30-perp-strategies-and-tournament
plan: "03"
subsystem: trading-strategies
tags: [perp, tournament, walk-forward, strategy-registry, zod]

# Dependency graph
requires:
  - phase: 30-01
    provides: PerpMomentumStrategy with funding rate adjustment
  - phase: 30-02
    provides: PerpMeanReversionStrategy with Z-score and funding rate adjustment
provides:
  - createPerpRegistry() factory returning StrategyRegistry with perp-momentum and perp-mean-reversion
  - createLivePerpRegistry(provider) factory wiring real funding rate callback for live/paper engines
  - strategyConfigSchema extended with perpMomentumSchema and perpMeanReversionSchema
  - runPerpTournament() wrapper wiring TournamentRunner with perp registry
  - npm run tournament:perp CLI command producing 'Perp Tournament Leaderboard'
affects:
  - 30-04 (live/paper engines should use createLivePerpRegistry)
  - 31+ (perp tournament results feed strategy activation decisions)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - Separate StrategyRegistry instances for perp vs spot (registry isolation invariant)
    - fundingRateProvider = () => null for tournament/backtest mode (tournament-safe null pattern)
    - Config schema extended with non-serializable fields excluded (fundingRateProvider is runtime injection only)
    - Perp tournament reuses TournamentRunner unchanged; only registry and CLI differ

key-files:
  created:
    - src/perp/strategies/index.ts
    - src/perp/perp-tournament-runner.ts
    - src/cli/perp-tournament.ts
  modified:
    - src/strategies/config.ts
    - src/perp/index.ts
    - package.json

key-decisions:
  - "createPerpRegistry() and createDefaultRegistry() are strictly separate instances — no spot strategies in perp registry and vice versa"
  - "fundingRateProvider not included in Zod schema — it is a runtime-injected callback, not serializable config"
  - "perpMomentumSchema and perpMeanReversionSchema added to strategyConfigSchema discriminated union so parseStrategyConfig handles perp configs"
  - "Perp tournament CLI omits ExitConfigStore — exit parameters come from Zod schema defaults, no per-strategy exit config persistence needed"
  - "runPerpTournament closes SQLite in finally block — resource safety regardless of tournament outcome"
  - "TournamentRunner unchanged — only registry and CLI differ from spot tournament (zero modification to core infrastructure)"

patterns-established:
  - "Registry isolation: perp registry never imports or reuses createDefaultRegistry; each domain has its own StrategyRegistry instance"
  - "Live vs tournament factory split: createPerpRegistry for backtest (null funding), createLivePerpRegistry(provider) for production"

# Metrics
duration: 4min
completed: 2026-03-09
---

# Phase 30 Plan 03: Perp Strategies Barrel, Registry Factories, and Tournament CLI Summary

**Separate perp StrategyRegistry with tournament-safe null funding provider and live provider injection, Zod schema extension for perp strategies, and `npm run tournament:perp` CLI producing a distinct 'Perp Tournament Leaderboard' via walk-forward validation**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-09T23:31:51Z
- **Completed:** 2026-03-09T23:35:26Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments

- Created `src/perp/strategies/index.ts` with `createPerpRegistry()` (tournament mode: null funding) and `createLivePerpRegistry(provider)` (live mode: real funding callback) — complete registry isolation from spot strategies
- Extended `strategyConfigSchema` discriminated union with `perpMomentumSchema` and `perpMeanReversionSchema` so `parseStrategyConfig({ strategy: 'perp-momentum' })` succeeds; `fundingRateProvider` excluded from schema (runtime injection only)
- Created `runPerpTournament()` wrapper in `src/perp/perp-tournament-runner.ts` using 70/30 IS/OOS walk-forward split; TournamentRunner used as-is with zero modifications
- Created `src/cli/perp-tournament.ts` with `--perp-pair`, `--days`, `--capital`, `--top-n`, `--mc` options; banner reads 'Perp Tournament Leaderboard'; success message 'Perp tournament complete'
- Added `tournament:perp` script to `package.json`; all 53 existing perp strategy tests pass; TypeScript compiles clean

## Task Commits

Each task was committed atomically:

1. **Task 1: Perp strategies barrel and config schema extension** - `a073a1e` (feat)
2. **Task 2: Perp tournament runner, CLI, and package.json script** - `f2f1027` (feat)

**Plan metadata:** (pending — docs commit)

## Files Created/Modified

- `src/perp/strategies/index.ts` — Barrel exporting PerpMomentumStrategy, PerpMeanReversionStrategy, createPerpRegistry(), createLivePerpRegistry()
- `src/strategies/config.ts` — Added perpMomentumSchema and perpMeanReversionSchema to discriminated union
- `src/perp/index.ts` — Added barrel exports for perp strategy classes and factory functions
- `src/perp/perp-tournament-runner.ts` — runPerpTournament() wrapping TournamentRunner with perp registry
- `src/cli/perp-tournament.ts` — CLI entry point for `npm run tournament:perp`
- `package.json` — Added `tournament:perp` script

## Decisions Made

- `createPerpRegistry()` and `createDefaultRegistry()` are strictly separate instances — registry isolation is a critical invariant preventing spot strategy contamination of perp results
- `fundingRateProvider` excluded from Zod schema — it is a runtime-injected callback, not serializable config; only scalar params in schema
- `perpMomentumSchema` and `perpMeanReversionSchema` added to `strategyConfigSchema` discriminated union so `parseStrategyConfig` handles perp configs for tournament pipeline
- Perp tournament CLI deliberately omits `ExitConfigStore` — perp strategies use exit parameters from Zod schema defaults; no per-strategy exit config persistence needed for tournament path
- `runPerpTournament` closes SQLite in `finally` block for resource safety regardless of tournament outcome
- `TournamentRunner` unchanged — only the registry and CLI entry differ from the spot tournament

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None - `npx tsx --eval` does not work for ESM modules; used a project-local `.mts` temp file for verification, then deleted before commit. No impact on deliverables.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `createLivePerpRegistry(fundingRateProvider)` is ready for plan 30-04 (live/paper engine integration)
- Perp tournament (`npm run tournament:perp`) is fully functional — produces ranked perp leaderboard from BTC-USD candle history
- TypeScript compiles clean; 53 perp strategy tests passing

---
*Phase: 30-perp-strategies-and-tournament*
*Completed: 2026-03-09*

## Self-Check: PASSED

- FOUND: src/perp/strategies/index.ts
- FOUND: src/perp/perp-tournament-runner.ts
- FOUND: src/cli/perp-tournament.ts
- FOUND: .planning/phases/30-perp-strategies-and-tournament/30-03-SUMMARY.md
- FOUND: commit a073a1e (Task 1)
- FOUND: commit f2f1027 (Task 2)
