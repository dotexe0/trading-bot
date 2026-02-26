/**
 * CLI entry point for backtesting a strategy.
 *
 * Usage: npm run backtest -- -s sma-crossover
 *        npm run backtest -- -s rsi-mean-reversion -p ETH-USD --start 2025-06-01
 */

import { Command } from 'commander';
import { bootstrap } from './shared/bootstrap.js';
import { out } from './shared/output.js';
import { BacktestEngine } from '../backtest/engine.js';
import { parseBacktestConfig } from '../backtest/types.js';
import { RiskManager } from '../risk/risk-manager.js';
import { parseRiskConfig } from '../risk/config.js';
import { MonteCarloEngine } from '../montecarlo/monte-carlo-engine.js';
import { MonteCarloStore } from '../montecarlo/monte-carlo-store.js';
import { RegimeStore } from '../regime/regime-store.js';
import { MarketRegime } from '../regime/types.js';
import { BacktestStore } from '../backtest/backtest-store.js';

const program = new Command();

program
  .name('backtest')
  .description('Run a backtest for a given strategy on historical candle data')
  .requiredOption('-s, --strategy <name>', 'Strategy name (e.g. sma-crossover)')
  .option('-p, --pair <pair>', 'Trading pair', 'BTC-USD')
  .option('-t, --timeframe <tf>', 'Candle timeframe', '1h')
  .option('--start <date>', 'Start date (YYYY-MM-DD)', '2025-01-01')
  .option('--end <date>', 'End date (YYYY-MM-DD)', new Date().toISOString().split('T')[0])
  .option('--capital <amount>', 'Initial capital', '10000')
  .option('--mc [iterations]', 'Run Monte Carlo simulation after backtest (default: 1000 iterations)')
  .action(async (opts) => {
    const { config, dbConn, repo, registry, indicatorEngine } = bootstrap();

    try {
      const startMs = new Date(opts.start).getTime();
      const endMs = new Date(opts.end).getTime();
      const pair = opts.pair as 'BTC-USD' | 'ETH-USD';
      const timeframe = opts.timeframe as '1m' | '5m' | '15m' | '1h' | '4h' | '1D';
      const capital = opts.capital as string;
      const strategyName = opts.strategy as string;
      const runMC = opts.mc !== undefined;
      const totalSteps = runMC ? 3 : 2;

      out.step(1, totalSteps, `Loading candles for ${pair} ${timeframe}`);
      const candles = repo.getCandles(pair, timeframe, startMs, endMs);
      out.info(`${candles.length} candles loaded`);

      if (candles.length === 0) {
        out.warn('No candles found. Run `npm run sync` first.');
        process.exit(1);
      }

      out.step(2, totalSteps, `Running backtest with strategy: ${strategyName}`);

      const riskConfig = parseRiskConfig({});
      const riskManager = new RiskManager(riskConfig);
      const engine = new BacktestEngine({
        strategyRegistry: registry,
        indicatorEngine,
        riskManager,
        riskConfig,
      });

      const backtestConfig = parseBacktestConfig({
        pair,
        timeframe,
        startMs,
        endMs,
        initialCapital: capital,
        strategyConfig: { strategy: strategyName },
      });

      const result = engine.run(backtestConfig, candles);

      // Persist backtest result
      const backtestStore = new BacktestStore();
      const backtestId = backtestStore.save(result);
      backtestStore.close();
      out.info(`Backtest saved (id: ${backtestId})`);

      out.banner('Backtest Results');
      out.table('Strategy', strategyName);
      out.table('Pair', pair);
      out.table('Timeframe', timeframe);
      out.table('Period', `${opts.start} to ${opts.end}`);
      out.table('Trades', String(result.trades.length));
      out.table('Final Equity', `$${result.finalEquity.toFixed(2)}`);
      out.table('Total Fees', `$${result.totalFees.toFixed(2)}`);
      out.success('Backtest complete');

      // Display regime breakdown if available
      if (result.regimeBreakdown && result.regimeBreakdown.length > 0) {
        out.banner('Regime Breakdown');
        for (const rb of result.regimeBreakdown) {
          console.log(`  ${rb.regime}:`);
          console.log(`    Time:       ${(rb.timePct * 100).toFixed(1)}%`);
          console.log(`    Trades:     ${rb.tradeCount}`);
          console.log(`    Win Rate:   ${(rb.winRate * 100).toFixed(1)}%`);
          console.log(`    Sharpe:     ${rb.sharpeRatio.toFixed(4)}`);
        }
        console.log('');
      }

      // Persist regime history if available
      if (result.regimeTimeline && result.regimeTimeline.length > 0) {
        const regimeStore = new RegimeStore();
        regimeStore.saveBatch(
          result.regimeTimeline.map((r) => ({
            pair,
            timeframe,
            timestamp: r.timestamp,
            regime: r.regime as MarketRegime,
          })),
        );
        regimeStore.close();
        out.info(`${result.regimeTimeline.length} regime labels persisted`);
      }

      // Optional Monte Carlo simulation
      if (runMC) {
        const mcIterations =
          typeof opts.mc === 'string' ? parseInt(opts.mc, 10) : 1000;
        const mcMinTrades = 15;

        out.step(3, totalSteps, `Running Monte Carlo simulation (${mcIterations} iterations)`);

        if (result.trades.length < mcMinTrades) {
          out.warn(
            `Insufficient trades (${result.trades.length}) for Monte Carlo simulation. ` +
            `Minimum required: ${mcMinTrades}`,
          );
        } else {
          const mcEngine = new MonteCarloEngine({
            iterations: mcIterations,
            minTrades: mcMinTrades,
          });

          const mcResult = mcEngine.run(result, strategyName);

          // Persist result
          const mcStore = new MonteCarloStore();
          mcStore.save(mcResult);
          mcStore.close();

          // Display results
          out.banner('Monte Carlo Results');
          out.table('Iterations', String(mcResult.iterations));
          out.table('Trade Count', String(mcResult.tradeCount));

          console.log('');
          console.log('Sharpe Ratio Distribution:');
          console.log(`  p5 (worst):   ${mcResult.sharpeDistribution.p5.toFixed(4)}`);
          console.log(`  p25:          ${mcResult.sharpeDistribution.p25.toFixed(4)}`);
          console.log(`  p50 (median): ${mcResult.sharpeDistribution.p50.toFixed(4)}`);
          console.log(`  p75:          ${mcResult.sharpeDistribution.p75.toFixed(4)}`);
          console.log(`  p95 (best):   ${mcResult.sharpeDistribution.p95.toFixed(4)}`);

          console.log('');
          console.log('Max Drawdown Distribution:');
          console.log(`  p5 (best):    ${(mcResult.maxDrawdownDistribution.p5 * 100).toFixed(2)}%`);
          console.log(`  p50 (median): ${(mcResult.maxDrawdownDistribution.p50 * 100).toFixed(2)}%`);
          console.log(`  p95 (worst):  ${(mcResult.maxDrawdownDistribution.p95 * 100).toFixed(2)}%`);

          console.log('');
          console.log('Total Return Distribution:');
          console.log(`  p5 (worst):   ${(mcResult.totalReturnDistribution.p5 * 100).toFixed(2)}%`);
          console.log(`  p50 (median): ${(mcResult.totalReturnDistribution.p50 * 100).toFixed(2)}%`);
          console.log(`  p95 (best):   ${(mcResult.totalReturnDistribution.p95 * 100).toFixed(2)}%`);

          out.success('Monte Carlo simulation complete');
        }
      }
    } catch (error) {
      out.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    } finally {
      dbConn.sqlite.close();
    }
  });

await program.parseAsync(process.argv);
