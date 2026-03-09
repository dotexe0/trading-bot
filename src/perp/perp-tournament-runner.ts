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
}

/**
 * Run a walk-forward tournament using perp strategies and BTC-USD candles.
 *
 * - Creates a perp-specific registry (tournament mode: fundingRateProvider = () => null)
 * - Loads candles from local SQLite via CandleRepository
 * - Wires BacktestEngine + WalkForwardRunner + TournamentRunner
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
    });

    return await runner.run(tournamentConfig, candles);
  } finally {
    sqlite.close();
  }
}
