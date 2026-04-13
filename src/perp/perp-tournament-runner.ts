/**
 * Perp Tournament Runner
 *
 * Thin wrapper that wires the perp-specific StrategyRegistry into the shared
 * TournamentRunner, enabling walk-forward tournament evaluation for perp
 * strategies (perp-momentum, perp-mean-reversion) using BTC-USD spot candles.
 *
 * Design: TournamentRunner itself is unchanged — only the registry and candle
 * source differ from the spot tournament.
 */

import { createDatabase, initializeSchema } from '../data/storage/db.js';
import { CandleRepository } from '../data/storage/candle-repo.js';
import { createPerpRegistry } from './strategies/index.js';
import { TournamentRunner } from '../tournament/tournament-runner.js';
import { parseTournamentConfig, type TournamentConfig } from '../tournament/config.js';
import type { TournamentResult } from '../tournament/types.js';
import { WalkForwardRunner } from '../backtest/walk-forward.js';
import { MetricsCalculator } from '../backtest/metrics.js';
import { BacktestEngine } from '../backtest/engine.js';
import { RiskManager } from '../risk/risk-manager.js';
import { parseRiskConfig } from '../risk/config.js';
import { IndicatorEngine } from '../indicators/engine.js';
import { FCM_FALLBACK_TAKER_RATE, FCM_FALLBACK_MAKER_RATE, type FeeConfig } from './fee-config.js';

export interface PerpTournamentOptions {
  /** Trading pair for candle source (perp tournament uses BTC-USD spot candles) */
  pair: string;
  /** Candle timeframe */
  timeframe: string;
  /** Number of historical days to evaluate */
  days: number;
  /** Initial capital per strategy backtest (as string) */
  capital: string;
  /** Number of top strategies to include in leaderboard */
  topN: number;
  /** Enable Monte Carlo simulation for tournament ranking */
  mc: boolean;
  /** Path to the SQLite database file */
  dbPath: string;
  /** Optional FeeConfig fetched from Coinbase API at startup. When provided,
   *  overrides the default Zod feeTierTaker (0.0075) with the real FCM rate. */
  feeConfig?: FeeConfig;
  /** Optional override for the parameter grid. Defaults to buildPerpParamGrid(). */
  paramGrid?: Record<string, unknown>[];
}

/**
 * Build the parameter grid for the perp tournament.
 *
 * Returns all strategy + param combinations to evaluate:
 *  - perp-momentum:        breakoutWindow [10,20,40] × volumeMultiplier [1.2,1.5,2.0] × maxHoldCandles [10,20,40] = 27 combos
 *  - perp-mean-reversion:  period [10,20,40] × threshold [1.0,1.5,2.0] = 9 combos
 *  - funding-rate-arb:     default only (provider is null in tournament mode) = 1 combo
 *  - basis-trade:          default only (provider is null in tournament mode) = 1 combo
 *  - perp-vwap-reversion:  vwapPeriod [10,15,20] × zScoreThreshold [1.0,1.5,2.0] × maxHoldCandles [5,8] = 18 combos
 *  - perp-micro-momentum:  [{fast:5,slow:12},{fast:8,slow:20},{fast:12,slow:26}] × rsiPeriod [7,14] × maxHoldCandles [5,10] = 12 combos
 *
 * Total: 68 combinations.
 */
export function buildPerpParamGrid(): Record<string, unknown>[] {
  const configs: Record<string, unknown>[] = [];

  for (const breakoutWindow of [10, 20, 40]) {
    for (const volumeMultiplier of [1.2, 1.5, 2.0]) {
      for (const maxHoldCandles of [10, 20, 40]) {
        configs.push({ strategy: 'perp-momentum', breakoutWindow, volumeMultiplier, maxHoldCandles });
      }
    }
  }

  for (const period of [10, 20, 40]) {
    for (const threshold of [1.0, 1.5, 2.0]) {
      configs.push({ strategy: 'perp-mean-reversion', period, threshold });
    }
  }

  configs.push({ strategy: 'funding-rate-arb' });
  configs.push({ strategy: 'basis-trade' });

  // perp-vwap-reversion: vwapPeriod [10,15,20] x zScoreThreshold [1.0,1.5,2.0] x maxHoldCandles [5,8] = 18 combos
  for (const vwapPeriod of [10, 15, 20]) {
    for (const zScoreThreshold of [1.0, 1.5, 2.0]) {
      for (const maxHoldCandles of [5, 8]) {
        configs.push({ strategy: 'perp-vwap-reversion', vwapPeriod, zScoreThreshold, maxHoldCandles });
      }
    }
  }

  // perp-micro-momentum: paired fast/slow EMA [{5,12},{8,20},{12,26}] x rsiPeriod [7,14] x maxHoldCandles [5,10] = 12 combos
  // IMPORTANT: each pair must satisfy fastEmaPeriod < slowEmaPeriod (Zod refinement constraint)
  for (const { fast: fastEmaPeriod, slow: slowEmaPeriod } of [
    { fast: 5, slow: 12 },
    { fast: 8, slow: 20 },
    { fast: 12, slow: 26 },
  ]) {
    for (const rsiPeriod of [7, 14]) {
      for (const maxHoldCandles of [5, 10]) {
        configs.push({ strategy: 'perp-micro-momentum', fastEmaPeriod, slowEmaPeriod, rsiPeriod, maxHoldCandles });
      }
    }
  }

  return configs;
}

/** Strategy names that require the scalping timeframe (1m/5m) for meaningful evaluation. */
export const SCALPING_STRATEGY_NAMES = ['perp-vwap-reversion', 'perp-micro-momentum'] as const;

/** Returns only the scalping subset of the perp param grid. */
export function buildScalpingParamGrid(): Record<string, unknown>[] {
  return buildPerpParamGrid().filter((c) =>
    SCALPING_STRATEGY_NAMES.includes(c.strategy as (typeof SCALPING_STRATEGY_NAMES)[number]),
  );
}

/** Returns only the non-scalping subset of the perp param grid. */
export function buildNonScalpingPerpParamGrid(): Record<string, unknown>[] {
  return buildPerpParamGrid().filter((c) =>
    !SCALPING_STRATEGY_NAMES.includes(c.strategy as (typeof SCALPING_STRATEGY_NAMES)[number]),
  );
}

/**
 * Run a walk-forward tournament using perp strategies and BTC-USD candles.
 *
 * - Creates a perp-specific registry (tournament mode: fundingRateProvider = () => null)
 * - Loads candles from local SQLite via CandleRepository
 * - Wires BacktestEngine + WalkForwardRunner + TournamentRunner
 * - Evaluates a full parameter grid (38 combos) via buildPerpParamGrid()
 * - Returns TournamentResult with a ranked perp leaderboard
 */
export async function runPerpTournament(
  opts: PerpTournamentOptions,
): Promise<TournamentResult> {
  const { db, sqlite } = createDatabase(opts.dbPath);
  initializeSchema(sqlite);

  try {
    const repo = new CandleRepository(db);
    const perpRegistry = createPerpRegistry();
    const indicatorEngine = new IndicatorEngine();

    const days = opts.days;
    const endMs = Date.now();
    const startMs = endMs - days * 86400000;
    const pair = opts.pair as 'BTC-USD' | 'ETH-USD';
    const timeframe = opts.timeframe as '1m' | '5m' | '15m' | '1h' | '4h' | '1D';

    const candles = repo.getCandles(pair, timeframe, startMs, endMs);

    const riskConfig = parseRiskConfig({});
    const riskManager = new RiskManager(riskConfig);

    const backtestEngine = new BacktestEngine({
      strategyRegistry: perpRegistry,
      indicatorEngine,
      riskManager,
      riskConfig,
    });

    const metricsCalculator = new MetricsCalculator();
    const walkForwardRunner = new WalkForwardRunner({
      engine: backtestEngine,
      metricsCalculator,
    });

    const runner = new TournamentRunner({
      walkForwardRunner,
      registry: perpRegistry,
      metricsCalculator,
    });

    // Compute walk-forward window durations: 70/30 IS/OOS split across 3 windows
    const totalMs = endMs - startMs;
    const trainWindowMs = Math.floor((totalMs * 0.7) / 3);
    const validateWindowMs = Math.floor((totalMs * 0.3) / 3);
    const stepMs = trainWindowMs + validateWindowMs;

    const tournamentConfig: TournamentConfig = parseTournamentConfig({
      pair,
      timeframe,
      startMs,
      endMs,
      initialCapital: opts.capital,
      topN: opts.topN,
      activationMode: 'none',
      strategyConfigs: opts.paramGrid ?? buildPerpParamGrid(),
      feeTierTaker: opts.feeConfig?.takerFeeRate ?? FCM_FALLBACK_TAKER_RATE,
      feeTierMaker: opts.feeConfig?.makerFeeRate ?? FCM_FALLBACK_MAKER_RATE,
      walkForward: {
        trainWindowMs,
        validateWindowMs,
        stepMs,
      },
      monteCarlo: opts.mc
        ? {
            enabled: true,
            iterations: 1000,
            minTrades: 15,
            rankingWeight: 0.3,
          }
        : undefined,
      qualityFilters: { minSortino: 0, minCalmar: 0.5, minProfitFactor: 1.1 },
    });

    return await runner.run(tournamentConfig, candles);
  } finally {
    sqlite.close();
  }
}
