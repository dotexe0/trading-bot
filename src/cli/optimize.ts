/**
 * CLI entry point for optimizing exit parameters via grid search.
 *
 * Usage: npm run optimize
 *        npm run optimize -- -p ETH-USD --days 180 --force
 */

import { Command } from 'commander';
import { bootstrap } from './shared/bootstrap.js';
import { out } from './shared/output.js';
import { BacktestEngine } from '../backtest/engine.js';
import { MetricsCalculator } from '../backtest/metrics.js';
import { WalkForwardRunner } from '../backtest/walk-forward.js';
import { RiskManager } from '../risk/risk-manager.js';
import { parseRiskConfig } from '../risk/config.js';
import { parseBacktestConfig } from '../backtest/types.js';
import {
  ExitConfigOptimizer,
  ExitConfigStore,
  hashStrategyConfig,
  DEFAULT_GRID,
} from '../optimizer/index.js';
import type { OptimizerConfig } from '../optimizer/index.js';

const program = new Command();

const gridComboCount =
  DEFAULT_GRID.atrMultiples.length *
  DEFAULT_GRID.trailActivatePcts.length *
  DEFAULT_GRID.partialTargetPcts.length *
  DEFAULT_GRID.maxCandlesHeld.length;

program
  .name('optimize')
  .description('Optimize exit parameters for all strategies via grid search')
  .option('-p, --pair <pair>', 'Trading pair', 'BTC-USD')
  .option('-t, --timeframe <tf>', 'Candle timeframe', '1h')
  .option('--days <days>', 'Number of days of history to evaluate', '90')
  .option('--capital <amount>', 'Initial capital per strategy', '10000')
  .option('--force', 'Bypass cache and always re-run grid search')
  .action(async (opts) => {
    const { config, dbConn, repo, registry, indicatorEngine } = bootstrap();

    let exitStore: ExitConfigStore | undefined;
    try {
      exitStore = new ExitConfigStore({ dbPath: config.database.path });

      const days = parseInt(opts.days, 10);
      const endMs = Date.now();
      const startMs = endMs - days * 86400000;
      const pair = opts.pair as 'BTC-USD' | 'ETH-USD';
      const timeframe = opts.timeframe as '1m' | '5m' | '15m' | '1h' | '4h' | '1D';
      const capital = opts.capital as string;

      out.step(1, 3, `Loading candles for ${pair} ${timeframe} (${days} days)`);
      const candles = repo.getCandles(pair, timeframe, startMs, endMs);
      out.info(`${candles.length} candles loaded`);

      if (candles.length === 0) {
        out.warn('No candles found. Run `npm run sync` first. Skipping optimization.');
        return;
      }

      out.step(2, 3, 'Building optimizer infrastructure');

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

      // Compute walk-forward window durations from data range
      const totalMs = endMs - startMs;
      const trainWindowMs = Math.floor((totalMs * 0.7) / 3);
      const validateWindowMs = Math.floor((totalMs * 0.3) / 3);
      const stepMs = trainWindowMs + validateWindowMs;

      const optimizer = new ExitConfigOptimizer({ walkForwardRunner });
      const optimizerConfig: OptimizerConfig = {
        grid: DEFAULT_GRID,
        minTradesFloor: 5,
      };

      out.step(3, 3, `Optimizing ${registry.list().length} strategies`);
      out.banner('Exit Config Optimizer');

      for (const strategyName of registry.list()) {
        const strategyBaseConfig = { strategy: strategyName };
        const hash = hashStrategyConfig(
          strategyBaseConfig as Record<string, unknown>,
        );

        // Cache check (skip unless --force)
        if (!opts.force) {
          const cached = exitStore.getForStrategy(strategyName, hash);
          if (cached) {
            out.info(strategyName + ': exit config up to date, skipping');
            continue;
          }
        }

        out.info(strategyName + ': running grid search...');

        const baseConfig = parseBacktestConfig({
          pair,
          timeframe,
          startMs,
          endMs,
          initialCapital: capital,
          strategyConfig: { strategy: strategyName },
        });

        const wfConfig = { trainWindowMs, validateWindowMs, stepMs };
        const result = optimizer.optimize(
          baseConfig,
          strategyName,
          candles,
          wfConfig,
          optimizerConfig,
        );

        result.strategyConfigHash = hash;
        exitStore.save(result);

        out.table(
          strategyName,
          'PF: ' +
            result.profitFactor.toFixed(4) +
            ' (searched ' +
            gridComboCount +
            ' combos)',
        );
      }

      out.success('Optimization complete');
    } catch (error) {
      out.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    } finally {
      if (exitStore) exitStore.close();
      dbConn.sqlite.close();
    }
  });

await program.parseAsync(process.argv);
