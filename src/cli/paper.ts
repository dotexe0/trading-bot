/**
 * CLI entry point for paper trading.
 *
 * Usage: npm run paper -- -s sma-crossover
 *        npm run paper -- -s rsi-mean-reversion -p ETH-USD --capital 5000
 *
 * Runs until SIGINT (Ctrl+C). Prints session summary on exit.
 */

import { Command } from 'commander';
import { bootstrap } from './shared/bootstrap.js';
import { out } from './shared/output.js';
import { SpotTradingEngine, PaperSpotOrderExecutor } from '../spot/index.js';
import { FillSimulator } from '../backtest/fill-simulator.js';
import { SessionStore } from '../paper/session-store.js';
import { LiveDataFeed } from '../paper/live-data-feed.js';
import { parsePaperConfig } from '../paper/config.js';
import { TournamentStore } from '../tournament/tournament-store.js';

const program = new Command();

program
  .name('paper')
  .description('Start paper trading with a given strategy (simulated fills, real market data)')
  .requiredOption('-s, --strategy <name>', 'Strategy name (e.g. sma-crossover)')
  .option('-p, --pair <pair>', 'Trading pair', 'BTC-USD')
  .option('-t, --timeframe <tf>', 'Candle timeframe', '1h')
  .option('--capital <amount>', 'Initial capital', '10000')
  .action(async (opts) => {
    const { config, dbConn, repo, registry, indicatorEngine } = bootstrap();

    try {
      const pair = opts.pair as 'BTC-USD' | 'ETH-USD';
      const timeframe = opts.timeframe as '1m' | '5m' | '15m' | '1h' | '4h' | '1D';
      const capital = opts.capital as string;
      const strategyName = opts.strategy as string;

      const sessionStore = new SessionStore({ dbPath: config.database.path });
      const liveFeed = new LiveDataFeed({
        apiKey: config.coinbase.apiKeyName,
        apiSecret: config.coinbase.apiKeySecret,
      });

      const paperConfig = parsePaperConfig({
        pair,
        timeframe,
        strategyConfig: { strategy: strategyName },
        initialCapital: capital,
      });

      // Load regime leaderboards from latest tournament (if available)
      let regimeLeaderboards: import('../tournament/types.js').RegimeLeaderboards | undefined;
      {
        const tournamentStore = new TournamentStore({ dbPath: config.database.path });
        try {
          const latest = tournamentStore.getLatestTournament();
          if (latest?.regimeLeaderboards) {
            regimeLeaderboards = latest.regimeLeaderboards;
            out.info('Regime auto-switching enabled (tournament leaderboards loaded)');
          }
        } finally {
          tournamentStore.close();
        }
      }

      const engine = new SpotTradingEngine({
        mode: 'paper',
        executor: new PaperSpotOrderExecutor(new FillSimulator({
          slippageBps: paperConfig.slippageBps,
          feeTierMaker: paperConfig.feeTierMaker,
          feeTierTaker: paperConfig.feeTierTaker,
          assumeTaker: paperConfig.assumeTaker,
        })),
        config: paperConfig,
        liveFeed,
        stateStore: sessionStore,
        strategyRegistry: registry,
        indicatorEngine,
        candleRepo: repo,
        regimeLeaderboards,
      });

      // Register SIGINT handler for graceful shutdown
      let stopping = false;
      process.on('SIGINT', async () => {
        if (stopping) return;
        stopping = true;
        out.info('Shutting down paper trading...');
        try {
          const session = engine.getSession();
          await engine.stop();
          out.banner('Paper Trading Summary');
          if (session) {
            const trades = sessionStore.getSessionTrades(session.id);
            out.table('Trades', String(trades.length));
          }
          out.success('Paper trading stopped');
        } catch (err) {
          out.error(err instanceof Error ? err.message : String(err));
        } finally {
          dbConn.sqlite.close();
          process.exit(0);
        }
      });

      out.banner('Paper Trading');
      out.table('Strategy', strategyName);
      out.table('Pair', pair);
      out.table('Timeframe', timeframe);
      out.table('Capital', `$${capital}`);

      const session = await engine.start();
      out.success(`Session started: ${session.id}`);
      out.info('Press Ctrl+C to stop');

      // Block until SIGINT
      await new Promise(() => {});
    } catch (error) {
      out.error(error instanceof Error ? error.message : String(error));
      dbConn.sqlite.close();
      process.exit(1);
    }
  });

await program.parseAsync(process.argv);
