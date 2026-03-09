/**
 * CLI entry point for running a perp strategy tournament.
 *
 * Usage: npm run tournament:perp
 *        npm run tournament:perp -- --perp-pair BTC-USD --days 90 --top-n 3
 *
 * Uses BTC-USD spot candle history to evaluate perp-momentum and
 * perp-mean-reversion strategies via walk-forward validation.
 * Produces a separate 'Perp Tournament Leaderboard' distinct from
 * the spot leaderboard.
 */

import { Command } from 'commander';
import { loadConfig } from '../core/config.js';
import { ConfigError } from '../core/errors.js';
import { out } from './shared/output.js';
import { runPerpTournament } from '../perp/perp-tournament-runner.js';
import { createPerpRegistry } from '../perp/strategies/index.js';

const program = new Command();

program
  .name('tournament:perp')
  .description('Run a walk-forward tournament across perp strategies (perp-momentum, perp-mean-reversion)')
  .option('--perp-pair <pair>', 'Spot pair to use as candle source for perp tournament', 'BTC-USD')
  .option('-t, --timeframe <tf>', 'Candle timeframe', '1h')
  .option('--days <days>', 'Number of days of history to evaluate', '90')
  .option('--capital <amount>', 'Initial capital per strategy', '10000')
  .option('--top-n <n>', 'Number of top strategies to show', '3')
  .option('--mc', 'Enable Monte Carlo simulation for tournament ranking')
  .action(async (opts) => {
    let config;
    try {
      config = loadConfig();
    } catch (error) {
      if (error instanceof ConfigError) {
        out.error(error.message);
        process.exit(1);
      }
      throw error;
    }

    try {
      const days = parseInt(opts.days, 10);
      const pair = opts.perpPair as string;
      const timeframe = opts.timeframe as string;
      const capital = opts.capital as string;
      const topN = parseInt(opts.topN, 10);
      const perpRegistry = createPerpRegistry();

      out.step(1, 3, `Loading candles for ${pair} ${timeframe} (${days} days)`);

      out.step(2, 3, 'Configuring perp tournament');

      out.step(3, 3, `Running perp tournament (${perpRegistry.list().length} strategies)`);

      const result = await runPerpTournament({
        pair,
        timeframe,
        days,
        capital,
        topN,
        mc: Boolean(opts.mc),
        dbPath: config.database.path,
      });

      out.banner('Perp Tournament Leaderboard');
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

      if (result.regimeLeaderboards) {
        console.log('');
        out.banner('Regime-Specific Winners');
        const regimes = ['TRENDING', 'RANGING', 'VOLATILE'] as const;
        for (const regime of regimes) {
          const regimeEntries = result.regimeLeaderboards[regime];
          if (regimeEntries.length === 0) {
            out.info(
              `${regime}: insufficient trades — fallback: ${result.regimeLeaderboards.fallbackEntry.strategyName}`,
            );
          } else {
            out.table(`${regime} #1`, regimeEntries[0].strategyName);
            out.table('  Regime Sharpe', regimeEntries[0].regimeSharpeRatio.toFixed(4));
            out.table('  Trade Count', String(regimeEntries[0].regimeTradeCount));
          }
          console.log('');
        }
      }

      out.success('Perp tournament complete');
    } catch (error) {
      out.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

await program.parseAsync(process.argv);
