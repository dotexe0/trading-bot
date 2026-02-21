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
  .action(async (opts) => {
    const { config, dbConn, repo, registry, indicatorEngine } = bootstrap();

    try {
      const startMs = new Date(opts.start).getTime();
      const endMs = new Date(opts.end).getTime();
      const pair = opts.pair as 'BTC-USD' | 'ETH-USD';
      const timeframe = opts.timeframe as '1m' | '5m' | '15m' | '1h' | '4h' | '1D';
      const capital = opts.capital as string;
      const strategyName = opts.strategy as string;

      out.step(1, 2, `Loading candles for ${pair} ${timeframe}`);
      const candles = repo.getCandles(pair, timeframe, startMs, endMs);
      out.info(`${candles.length} candles loaded`);

      if (candles.length === 0) {
        out.warn('No candles found. Run `npm run sync` first.');
        process.exit(1);
      }

      out.step(2, 2, `Running backtest with strategy: ${strategyName}`);

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

      out.banner('Backtest Results');
      out.table('Strategy', strategyName);
      out.table('Pair', pair);
      out.table('Timeframe', timeframe);
      out.table('Period', `${opts.start} to ${opts.end}`);
      out.table('Trades', String(result.trades.length));
      out.table('Final Equity', `$${result.finalEquity.toFixed(2)}`);
      out.table('Total Fees', `$${result.totalFees.toFixed(2)}`);
      out.success('Backtest complete');
    } catch (error) {
      out.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    } finally {
      dbConn.sqlite.close();
    }
  });

await program.parseAsync(process.argv);
