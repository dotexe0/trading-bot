/**
 * Full-lifecycle orchestrator: sync -> tournament -> activate -> dashboard.
 *
 * Usage: npm start
 *        npm start -- --skip-sync --mode none --days 30
 *
 * Runs the complete bot lifecycle in a single Node.js process to avoid
 * SQLite BUSY errors (better-sqlite3 does not support concurrent writers).
 *
 * Ctrl+C triggers graceful shutdown that stops all engines in reverse
 * order, closes the dashboard, and releases the database connection.
 */

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { Command } from 'commander';
import { bootstrap } from './shared/bootstrap.js';
import { out } from './shared/output.js';
import { DataPipeline } from '../data/pipeline.js';
import { BacktestEngine } from '../backtest/engine.js';
import { MetricsCalculator } from '../backtest/metrics.js';
import { WalkForwardRunner } from '../backtest/walk-forward.js';
import { TournamentRunner } from '../tournament/tournament-runner.js';
import { parseTournamentConfig } from '../tournament/config.js';
import { TournamentStore } from '../tournament/tournament-store.js';
import { ActivationBridge } from '../tournament/activation-bridge.js';
import { PaperTradingEngine } from '../paper/paper-engine.js';
import { parsePaperConfig } from '../paper/config.js';
import { SessionStore } from '../paper/session-store.js';
import { LiveDataFeed } from '../paper/live-data-feed.js';
import { LiveStateStore } from '../live/state-store.js';
import { createDashboardServer } from '../dashboard/server/index.js';
import { dashboardConfigSchema } from '../dashboard/server/config.js';
import { RiskManager } from '../risk/risk-manager.js';
import { parseRiskConfig } from '../risk/config.js';
import { CorrelationStore } from '../correlation/correlation-store.js';
import { BacktestStore } from '../backtest/backtest-store.js';
import type { EventEmitter } from 'node:events';

// ── Resource tracking ──────────────────────────────────────────────

interface Stoppable {
  name: string;
  stop: () => Promise<void>;
}

const resources: Stoppable[] = [];
let isShuttingDown = false;
let correlationStore: CorrelationStore | undefined;
let backtestStore: BacktestStore | undefined;

// ── Graceful shutdown ──────────────────────────────────────────────

async function gracefulShutdown(
  signal: string,
  dbClose: () => void,
): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  out.warn(`Received ${signal}, shutting down gracefully...`);

  const timer = setTimeout(() => {
    out.error('Shutdown timeout (15s), forcing exit');
    process.exit(1);
  }, 15_000);

  // Stop resources in reverse order (dashboard first, then engines)
  for (const r of [...resources].reverse()) {
    try {
      out.info(`Stopping ${r.name}...`);
      await r.stop();
      out.success(`${r.name} stopped`);
    } catch (err) {
      out.error(`Failed to stop ${r.name}: ${err}`);
    }
  }

  try { correlationStore?.close(); } catch { /* ignore */ }
  try { backtestStore?.close(); } catch { /* ignore */ }

  try {
    dbClose();
  } catch {
    /* ignore */
  }
  clearTimeout(timer);
  out.success('Shutdown complete');
  process.exit(0);
}

// ── Commander setup ────────────────────────────────────────────────

const program = new Command();

program
  .name('start')
  .description('Start the trading bot orchestrator (sync -> tournament -> activate -> dashboard)')
  .option('-p, --pair <pair>', 'Trading pair for tournament', 'BTC-USD')
  .option('-t, --timeframe <tf>', 'Candle timeframe', '1h')
  .option('--days <days>', 'Lookback days for tournament data', '90')
  .option('--capital <amount>', 'Initial capital', '10000')
  .option('--top-n <n>', 'How many tournament winners to activate', '1')
  .option('--port <port>', 'Dashboard port', '3001')
  .option('--skip-sync', 'Skip data sync step (for quick restarts)')
  .option('--mode <mode>', 'Activation mode: paper or none', 'paper')
  .action(async (opts) => {
    // ── Step 0: Bootstrap ──────────────────────────────────────────

    const { config, dbConn, repo, registry, indicatorEngine } = bootstrap();

    // Register signal handlers
    process.on('SIGINT', () =>
      gracefulShutdown('SIGINT', () => dbConn.sqlite.close()),
    );
    process.on('SIGTERM', () =>
      gracefulShutdown('SIGTERM', () => dbConn.sqlite.close()),
    );

    out.banner('Trading Bot Orchestrator');

    const pair = opts.pair as 'BTC-USD' | 'ETH-USD';
    const timeframe = opts.timeframe as '1m' | '5m' | '15m' | '1h' | '4h' | '1D';
    const days = parseInt(opts.days, 10);
    const capital = opts.capital as string;
    const topN = parseInt(opts.topN, 10);
    const port = parseInt(opts.port, 10);
    const skipSync = opts.skipSync === true;
    const mode = opts.mode as 'paper' | 'none';

    const totalSteps = 4;
    const paperEngines: PaperTradingEngine[] = [];

    try {
      // ── Step 1: Data Sync ──────────────────────────────────────

      if (skipSync) {
        out.step(1, totalSteps, 'Skipping data sync (--skip-sync)');
      } else {
        out.step(1, totalSteps, 'Syncing historical data...');
        try {
          const pipeline = new DataPipeline(config, repo);
          await pipeline.runAllPairs();
          out.success('Data sync complete');
        } catch (syncErr) {
          out.error(
            `Data sync failed: ${syncErr instanceof Error ? syncErr.message : String(syncErr)}`,
          );
          out.error('Cannot proceed with stale data. Exiting.');
          dbConn.sqlite.close();
          process.exit(1);
        }
      }

      // ── Step 2: Tournament ─────────────────────────────────────

      out.step(2, totalSteps, 'Running tournament...');

      const endMs = Date.now();
      const startMs = endMs - days * 86_400_000;

      const candles = repo.getCandles(pair, timeframe, startMs, endMs);
      out.info(`${candles.length} candles loaded for ${pair} ${timeframe}`);

      if (candles.length === 0) {
        out.error('No candle data available. Run `npm run sync` first.');
        dbConn.sqlite.close();
        process.exit(1);
      }

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
      });

      // Compute walk-forward window durations from data range
      const totalMs = endMs - startMs;
      const trainWindowMs = Math.floor((totalMs * 0.7) / 3);
      const validateWindowMs = Math.floor((totalMs * 0.3) / 3);
      const stepMs = trainWindowMs + validateWindowMs;

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
      });

      const result = await runner.run(tournamentConfig, candles);

      out.info(
        `${result.strategiesEvaluated} strategies evaluated in ${(result.durationMs / 1000).toFixed(1)}s`,
      );
      for (const entry of result.leaderboard.slice(0, topN)) {
        const sharpe = entry.oosMetrics.sharpeRatio.toFixed(4);
        out.table(`#${entry.rank}`, `${entry.strategyName} (OOS Sharpe: ${sharpe})`);
      }
      out.success('Tournament complete');

      // ── Step 3: Activate winners ───────────────────────────────

      out.step(3, totalSteps, 'Activating winning strategies...');

      const tournamentStore = new TournamentStore({
        dbPath: config.database.path,
      });
      const activationBridge = new ActivationBridge({
        store: tournamentStore,
      });
      const sessionStore = new SessionStore({
        dbPath: config.database.path,
      });

      if (mode === 'none') {
        out.info('Activation mode: none (display only)');
      } else if (mode === 'paper') {
        // Engine factory creates a PaperTradingEngine per strategy
        const engineFactory = async (
          stratConfig: Record<string, unknown>,
          _tournConfig: typeof tournamentConfig,
        ) => {
          const liveFeed = new LiveDataFeed({
            apiKey: config.coinbase.apiKeyName,
            apiSecret: config.coinbase.apiKeySecret,
          });

          const paperConfig = parsePaperConfig({
            pair,
            timeframe,
            strategyConfig: stratConfig,
            initialCapital: capital,
          });

          const engine = new PaperTradingEngine({
            config: paperConfig,
            liveFeed,
            sessionStore,
            strategyRegistry: registry,
            indicatorEngine,
            riskManager,
          });

          const session = await engine.start();
          paperEngines.push(engine);

          // Register engine as a stoppable resource
          resources.push({
            name: `paper-engine:${(stratConfig as Record<string, unknown>).strategy ?? 'unknown'}`,
            stop: async () => {
              await engine.stop();
            },
          });

          return {
            sessionId: session.id,
            strategyName:
              (stratConfig as Record<string, unknown>).strategy as string ??
              'unknown',
            stop: async () => {
              await engine.stop();
            },
          };
        };

        const activationResult = await activationBridge.activate(
          result,
          'paper',
          engineFactory,
        );

        for (const a of activationResult.activated) {
          out.table('  Activated', `${a.strategyName} (session: ${a.sessionId})`);
        }
      }

      out.success('Activation complete');

      // ── Step 4: Dashboard ──────────────────────────────────────

      out.step(4, totalSteps, 'Starting dashboard...');

      // Auto-build UI if Vite bundle is missing
      if (!fs.existsSync('dist/dashboard/index.html')) {
        out.info('Building dashboard UI...');
        spawnSync('npm', ['--prefix', 'src/dashboard/ui', 'run', 'build'], { stdio: 'inherit' });
      }

      const liveStateStore = new LiveStateStore({
        dbPath: config.database.path,
      });

      const dashboardConfig = dashboardConfigSchema.parse({
        port,
        host: '0.0.0.0',
        isDev: false,
      });

      // Collect engine EventEmitters from activated paper engines
      const engines: EventEmitter[] = paperEngines;

      // Instantiate stores for dashboard routes
      correlationStore = new CorrelationStore({ dbPath: config.database.path });
      backtestStore = new BacktestStore({ dbPath: config.database.path });

      // Dashboard engine factory: supports hot-reload of strategy config via PATCH endpoint.
      // Creates a new PaperTradingEngine with the supplied config override, then registers
      // it as a stoppable resource so graceful shutdown covers the new engine.
      const dashboardEngineFactory = async (
        strategyName: string,
        configOverride?: Record<string, unknown>,
      ): Promise<{ sessionId: string }> => {
        const stratConfig: Record<string, unknown> = configOverride ?? { strategy: strategyName };

        const liveFeed = new LiveDataFeed({
          apiKey: config.coinbase.apiKeyName,
          apiSecret: config.coinbase.apiKeySecret,
        });
        const paperConfig = parsePaperConfig({
          pair,
          timeframe,
          strategyConfig: stratConfig,
          initialCapital: capital,
        });
        const engine = new PaperTradingEngine({
          config: paperConfig,
          liveFeed,
          sessionStore,
          strategyRegistry: registry,
          indicatorEngine,
          riskManager,
        });
        const session = await engine.start();
        paperEngines.push(engine);
        resources.push({
          name: `paper-engine:${strategyName}`,
          stop: async () => { await engine.stop(); },
        });
        return { sessionId: session.id };
      };

      const server = await createDashboardServer(dashboardConfig, {
        liveStateStore,
        sessionStore,
        activationBridge,
        riskManager,
        engines,
        engineFactory: dashboardEngineFactory,
        correlationStore,
        backtestStore,
        repo,
      });

      await server.start();

      // Register dashboard as a stoppable resource
      resources.push({
        name: 'dashboard',
        stop: async () => server.close(),
      });

      out.success(`Dashboard running at http://localhost:${port}`);
      out.banner('Bot is running. Press Ctrl+C to stop.');

      // ── Step 5: Block forever ──────────────────────────────────

      await new Promise(() => {});
    } catch (error) {
      if (!isShuttingDown) {
        out.error(
          error instanceof Error ? error.message : String(error),
        );
        dbConn.sqlite.close();
        process.exit(1);
      }
    }
  });

await program.parseAsync(process.argv);
