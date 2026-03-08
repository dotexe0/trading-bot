/**
 * CLI entry point for running a strategy tournament.
 *
 * Usage: npm run tournament
 *        npm run tournament -- -p ETH-USD --days 180 --top-n 5
 */

import { Command } from 'commander';
import { bootstrap } from './shared/bootstrap.js';
import { out } from './shared/output.js';
import { BacktestEngine } from '../backtest/engine.js';
import { MetricsCalculator } from '../backtest/metrics.js';
import { WalkForwardRunner } from '../backtest/walk-forward.js';
import { TournamentRunner } from '../tournament/tournament-runner.js';
import { parseTournamentConfig } from '../tournament/config.js';
import { RiskManager } from '../risk/risk-manager.js';
import { parseRiskConfig } from '../risk/config.js';
import { ExitConfigStore, hashStrategyConfig } from '../optimizer/index.js';

const program = new Command();

program
  .name('tournament')
  .description('Run a walk-forward tournament across all registered strategies')
  .option('-p, --pair <pair>', 'Trading pair', 'BTC-USD')
  .option('-t, --timeframe <tf>', 'Candle timeframe', '1h')
  .option('--days <days>', 'Number of days of history to evaluate', '90')
  .option('--capital <amount>', 'Initial capital per strategy', '10000')
  .option('--top-n <n>', 'Number of top strategies to show', '3')
  .option('--mc', 'Enable Monte Carlo simulation for tournament ranking')
  .action(async (opts) => {
    const { config, dbConn, repo, registry, indicatorEngine } = bootstrap();

    try {
      const days = parseInt(opts.days, 10);
      const endMs = Date.now();
      const startMs = endMs - days * 86400000;
      const pair = opts.pair as 'BTC-USD' | 'ETH-USD';
      const timeframe = opts.timeframe as '1m' | '5m' | '15m' | '1h' | '4h' | '1D';
      const capital = opts.capital as string;
      const topN = parseInt(opts.topN, 10);

      out.step(1, 3, `Loading candles for ${pair} ${timeframe} (${days} days)`);
      const candles = repo.getCandles(pair, timeframe, startMs, endMs);
      out.info(`${candles.length} candles loaded`);

      if (candles.length === 0) {
        out.warn('No candles found. Run `npm run sync` first.');
        process.exit(1);
      }

      out.step(2, 3, 'Configuring tournament');

      const riskConfig = parseRiskConfig({});
      const riskManager = new RiskManager(riskConfig);

      const backtestEngine = new BacktestEngine({
        strategyRegistry: registry,
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
        registry,
        metricsCalculator,
      });

      // Compute walk-forward window durations from data range
      const totalMs = endMs - startMs;
      const trainWindowMs = Math.floor(totalMs * 0.7 / 3);
      const validateWindowMs = Math.floor(totalMs * 0.3 / 3);
      const stepMs = trainWindowMs + validateWindowMs;

      // Load optimized exit configs and merge into strategy configs
      const exitStore = new ExitConfigStore({ dbPath: config.database.path });
      let strategyConfigs: Record<string, unknown>[] | undefined;
      try {
        const configs = registry.list().map((strategyName) => {
          const baseStratConfig = { strategy: strategyName };
          const hash = hashStrategyConfig(baseStratConfig as Record<string, unknown>);
          const optimized = exitStore.getForStrategy(strategyName, hash);
          if (optimized) {
            out.info(strategyName + ': applying optimized exit config');
            return { ...baseStratConfig, exits: optimized.exitConfig.exits };
          }
          return baseStratConfig;
        });
        // Only set strategyConfigs if at least one strategy has optimized exits
        if (configs.some((c) => 'exits' in c)) {
          strategyConfigs = configs;
        }
      } finally {
        exitStore.close();
      }

      const tournamentConfig = parseTournamentConfig({
        pair,
        timeframe,
        startMs,
        endMs,
        initialCapital: capital,
        topN,
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
        strategyConfigs,
      });

      out.step(3, 3, `Running tournament (${registry.list().length} strategies)`);
      const result = await runner.run(tournamentConfig, candles);

      out.banner('Tournament Leaderboard');
      out.info(`${result.strategiesEvaluated} strategies evaluated in ${(result.durationMs / 1000).toFixed(1)}s`);
      console.log('');

      for (const entry of result.leaderboard.slice(0, topN)) {
        const sharpe = entry.oosMetrics.sharpeRatio.toFixed(4);
        const robustness = entry.robustnessRatio.toFixed(4);
        const maxDd = entry.oosMetrics.maxDrawdownPct.mul(100).toFixed(2);
        const winRate = entry.oosMetrics.winRate.mul(100).toFixed(1);

        out.table(`#${entry.rank}`, entry.strategyName);
        out.table('  OOS Sharpe', sharpe);
        if (opts.mc && entry.mcAdjustedScore !== undefined) {
          out.table('  MC Adj Score', entry.mcAdjustedScore.toFixed(4));
          out.table('  MC p5 Sharpe', entry.mcResult?.sharpeDistribution.p5.toFixed(4) ?? 'N/A');
        }
        out.table('  Robustness', robustness);
        out.table('  Max DD', `${maxDd}%`);
        out.table('  Win Rate', `${winRate}%`);
        console.log('');
      }

      out.success('Tournament complete');
    } catch (error) {
      out.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    } finally {
      dbConn.sqlite.close();
    }
  });

await program.parseAsync(process.argv);
