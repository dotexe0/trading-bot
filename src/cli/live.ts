/**
 * CLI entry point for live trading.
 *
 * Usage: npm run live -- -s sma-crossover --confirm-live
 *
 * SAFETY: Requires --confirm-live flag. Without it, the command prints
 * a warning and exits with code 1.
 *
 * Runs until SIGINT (Ctrl+C). Graceful shutdown closes positions.
 */

import crypto from 'node:crypto';
import { Command } from 'commander';
import { CBAdvancedTradeClient, WebsocketClient } from 'coinbase-api';
import { bootstrap } from './shared/bootstrap.js';
import { out } from './shared/output.js';
import { LiveTradingEngine } from '../live/live-engine.js';
import { LiveStateStore } from '../live/state-store.js';
import { LiveDataFeed } from '../paper/live-data-feed.js';
import { OrderManager } from '../live/order-manager.js';
import { RateLimiter } from '../live/rate-limiter.js';
import { parseLiveConfig } from '../live/config.js';
import { RiskManager } from '../risk/risk-manager.js';
import { parseRiskConfig } from '../risk/config.js';
import { TournamentStore } from '../tournament/tournament-store.js';
import { SpotSignalGate } from '../risk/spot-signal-gate.js';
import { DEFAULT_FEE_TAKER } from '../backtest/types.js';

const program = new Command();

program
  .name('live')
  .description('Start live trading with real money on Coinbase')
  .requiredOption('-s, --strategy <name>', 'Strategy name (e.g. sma-crossover)')
  .option('-p, --pair <pair>', 'Trading pair', 'BTC-USD')
  .option('-t, --timeframe <tf>', 'Candle timeframe', '1h')
  .option('--capital <amount>', 'Initial capital', '10000')
  .option('--confirm-live', 'Confirm that you want to trade with real money')
  .action(async (opts) => {
    // SAFETY: Require explicit confirmation
    if (!opts.confirmLive) {
      out.error('Live trading uses real money. Pass --confirm-live to proceed.');
      process.exit(1);
    }

    const { config, dbConn, registry, indicatorEngine } = bootstrap();

    try {
      const pair = opts.pair as 'BTC-USD' | 'ETH-USD';
      const timeframe = opts.timeframe as '1m' | '5m' | '15m' | '1h' | '4h' | '1D';
      const capital = opts.capital as string;
      const strategyName = opts.strategy as string;

      const stateStore = new LiveStateStore({ dbPath: config.database.path });
      const liveFeed = new LiveDataFeed({
        apiKey: config.coinbase.apiKeyName,
        apiSecret: config.coinbase.apiKeySecret,
      });

      const restClient = new CBAdvancedTradeClient({
        apiKey: config.coinbase.apiKeyName,
        apiSecret: config.coinbase.apiKeySecret,
      });

      const wsClient = new WebsocketClient({
        apiKey: config.coinbase.apiKeyName,
        apiSecret: config.coinbase.apiKeySecret,
      });

      const rateLimiter = new RateLimiter();
      const sessionId = crypto.randomUUID();

      const orderManager = new OrderManager({
        restClient,
        wsClient,
        rateLimiter,
        stateStore,
        sessionId,
        pairs: [pair],
      });

      const riskConfig = parseRiskConfig({});
      const riskManager = new RiskManager(riskConfig);

      // Spot fee-drag gate: blocks entries whose expected move <= round-trip fee * multiple
      const spotSignalGate = new SpotSignalGate({
        takerFeeRate: DEFAULT_FEE_TAKER,
        feeDragMultiple: config.spotStrategyOverrides.feeDragMultiple,
        atrPeriod: config.spotStrategyOverrides.feeDragAtrPeriod,
      });

      const liveConfig = parseLiveConfig({
        pair,
        timeframe,
        strategyConfig: { strategy: strategyName },
        initialCapital: capital,
        riskConfig,
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

      const engine = new LiveTradingEngine({
        config: liveConfig,
        liveFeed,
        orderManager,
        stateStore,
        strategyRegistry: registry,
        indicatorEngine,
        riskManager,
        regimeLeaderboards,
        spotSignalGate,
      });

      // Register SIGINT handler for graceful shutdown
      let stopping = false;
      process.on('SIGINT', async () => {
        if (stopping) return;
        stopping = true;
        out.info('Shutting down live trading...');
        try {
          await engine.stop();
          out.success('Live trading stopped');
        } catch (err) {
          out.error(err instanceof Error ? err.message : String(err));
        } finally {
          stateStore.close();
          dbConn.sqlite.close();
          process.exit(0);
        }
      });

      out.banner('LIVE Trading');
      out.warn('REAL MONEY MODE');
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
