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
import { IntxClient, PaperPerpEngine, PerpPositionManager } from '../perp/index.js';
import { PerpStateStore } from '../perp/perp-state-store.js';
import { runPerpTournament } from '../perp/perp-tournament-runner.js';
import type { FeeConfig } from '../perp/fee-config.js';
import { CBAdvancedTradeClient } from 'coinbase-api';
import type { Candle } from '../core/types.js';
import type { EventEmitter } from 'node:events';
import {
  ExitConfigOptimizer,
  ExitConfigStore,
  hashStrategyConfig,
  DEFAULT_GRID,
} from '../optimizer/index.js';
import type { OptimizerConfig } from '../optimizer/index.js';
import { parseBacktestConfig, DEFAULT_FEE_TAKER, DEFAULT_FEE_MAKER } from '../backtest/types.js';
import type { RegimeLeaderboards } from '../tournament/types.js';
import { SpotSignalGate } from '../risk/spot-signal-gate.js';
import { PreLiveGate } from '../risk/pre-live-gate.js';
import { FeedHealthMonitor } from '../core/feed-health.js';

// ── Resource tracking ──────────────────────────────────────────────

interface Stoppable {
  name: string;
  stop: () => Promise<void>;
}

const resources: Stoppable[] = [];
let isShuttingDown = false;
let correlationStore: CorrelationStore | undefined;
let backtestStore: BacktestStore | undefined;
let perpStateStore: PerpStateStore | undefined;

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

  // Stop engines first (cease trading), then dashboard
  for (const r of resources) {
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
  try { perpStateStore?.close(); } catch { /* ignore */ }

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
  .option('-p, --pair <pair>', 'Restrict to a single trading pair (default: all pairs in config)')
  .option('-t, --timeframe <tf>', 'Candle timeframe', '1h')
  .option('--days <days>', 'Lookback days for tournament data', '90')
  .option('--capital <amount>', 'Initial capital', '10000')
  .option('--top-n <n>', 'How many tournament winners to activate', '1')
  .option('--port <port>', 'Dashboard port', '3001')
  .option('--skip-sync', 'Skip data sync step (for quick restarts)')
  .option('--skip-optimize', 'Skip exit config optimization step (uses cached configs if available)')
  .option('--skip-perp-tournament', 'Skip perp tournament step (uses no regime leaderboards)')
  .option('--mode <mode>', 'Activation mode: paper, live, or none', 'paper')
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

    const timeframe = opts.timeframe as '1m' | '5m' | '15m' | '1h' | '4h' | '1D';
    const days = parseInt(opts.days, 10);
    const capital = opts.capital as string;
    const topN = parseInt(opts.topN, 10);
    const port = parseInt(opts.port, 10);
    const skipSync = opts.skipSync === true;
    const skipOptimize = opts.skipOptimize === true;
    const skipPerpTournament = opts.skipPerpTournament === true;
    const mode = opts.mode as 'paper' | 'none' | 'live';

    // Determine which pairs to trade: --pair overrides, otherwise all configured pairs
    const tradingPairs: ('BTC-USD' | 'ETH-USD')[] = opts.pair
      ? [opts.pair as 'BTC-USD' | 'ETH-USD']
      : config.data.pairs;

    const totalSteps = 4;
    const endMs = Date.now();
    const startMs = endMs - days * 86_400_000;
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

      // ── Step 2: Optimize Exits ─────────────────────────────────

      if (skipOptimize) {
        out.step(2, totalSteps, 'Skipping exit optimization (--skip-optimize)');
      } else {
        out.step(2, totalSteps, 'Optimizing exit parameters...');

        const exitConfigStore = new ExitConfigStore({ dbPath: config.database.path });
        try {
          const riskConfigOpt = parseRiskConfig({});
          const riskManagerOpt = new RiskManager(riskConfigOpt);
          const backtestEngineOpt = new BacktestEngine({
            strategyRegistry: registry,
            indicatorEngine,
            riskManager: riskManagerOpt,
            riskConfig: riskConfigOpt,
          });
          const metricsCalcOpt = new MetricsCalculator();
          const wfRunnerOpt = new WalkForwardRunner({
            engine: backtestEngineOpt,
            metricsCalculator: metricsCalcOpt,
          });
          const optimizer = new ExitConfigOptimizer({ walkForwardRunner: wfRunnerOpt });
          const optimizerConfig: OptimizerConfig = {
            grid: DEFAULT_GRID,
            minTradesFloor: 5,
          };

          for (const tradePair of tradingPairs) {
            const candlesOpt = repo.getCandles(tradePair, timeframe, startMs, endMs);
            if (candlesOpt.length === 0) {
              out.warn(`No candles for ${tradePair} — skipping optimizer`);
              continue;
            }

            const totalMsOpt = endMs - startMs;
            const trainWindowMsOpt = Math.floor((totalMsOpt * 0.7) / 3);
            const validateWindowMsOpt = Math.floor((totalMsOpt * 0.3) / 3);
            const stepMsOpt = trainWindowMsOpt + validateWindowMsOpt;
            const wfConfig = { trainWindowMs: trainWindowMsOpt, validateWindowMs: validateWindowMsOpt, stepMs: stepMsOpt };

            for (const strategyName of registry.list()) {
              const strategyBaseConfig = { strategy: strategyName };
              const hash = hashStrategyConfig(strategyBaseConfig as Record<string, unknown>);
              const cached = exitConfigStore.getForStrategy(strategyName, hash);
              if (cached) {
                out.info(strategyName + ': exit config up to date, skipping');
                continue;
              }
              out.info(strategyName + ': running grid search...');
              const baseConfig = parseBacktestConfig({
                pair: tradePair,
                timeframe,
                startMs,
                endMs,
                initialCapital: capital,
                strategyConfig: { strategy: strategyName },
              });
              const result = optimizer.optimize(baseConfig, strategyName, candlesOpt, wfConfig, optimizerConfig);
              result.strategyConfigHash = hash;
              exitConfigStore.save(result);
              out.table(strategyName, 'PF: ' + result.profitFactor.toFixed(4));
            }
          }
          out.success('Exit optimization complete');
        } finally {
          exitConfigStore.close();
        }
      }

      // ── Step 3: Tournament + Activation (per pair) ────────────

      out.step(3, totalSteps, `Running tournament for ${tradingPairs.join(', ')}...`);

      const riskConfig = parseRiskConfig({});
      const riskManager = new RiskManager(riskConfig);

      // Feed health monitoring for all instruments (spot pairs use 1m candles = 60_000ms interval)
      const feedHealthMonitor = new FeedHealthMonitor();
      feedHealthMonitor.register('BTC-USD', 60_000);
      feedHealthMonitor.register('ETH-USD', 60_000);

      // Fetch real spot taker fee from Coinbase API — never throws, falls back to constant
      let spotTakerFeeRate = DEFAULT_FEE_TAKER;
      let spotFeeSource: 'api' | 'fallback' = 'fallback';
      try {
        const cbClient = new CBAdvancedTradeClient({
          apiKey: config.coinbase.apiKeyName,
          apiSecret: config.coinbase.apiKeySecret,
        });
        const summary = await cbClient.getTransactionSummary({ product_type: 'SPOT' });
        const raw = (summary as any)?.fee_tier?.taker_fee_rate;
        const parsed = typeof raw === 'string' && raw.length > 0 ? parseFloat(raw) : NaN;
        if (Number.isFinite(parsed) && parsed > 0 && parsed < 0.1) {
          spotTakerFeeRate = parsed;
          spotFeeSource = 'api';
        }
      } catch { /* use fallback */ }
      out.info(`Spot taker fee: ${(spotTakerFeeRate * 100).toFixed(4)}% (source: ${spotFeeSource})`);

      // Spot fee-drag gate: blocks entries whose expected move <= round-trip fee * multiple
      const spotSignalGate = new SpotSignalGate({
        takerFeeRate: spotTakerFeeRate,
        feeDragMultiple: config.spotStrategyOverrides.feeDragMultiple,
        atrPeriod: config.spotStrategyOverrides.feeDragAtrPeriod,
      });

      const spotFeeConfig: LiveFeeSnapshot = { takerFeeRate: spotTakerFeeRate, makerFeeRate: DEFAULT_FEE_MAKER, source: spotFeeSource };

      const backtestEngine = new BacktestEngine({
        strategyRegistry: registry,
        indicatorEngine,
        riskManager,
        riskConfig,
        spotSignalGate,
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
      const trainWindowMs = Math.floor((totalMs * 0.7) / 3);
      const validateWindowMs = Math.floor((totalMs * 0.3) / 3);
      const stepMs = trainWindowMs + validateWindowMs;

      const tournamentStore = new TournamentStore({
        dbPath: config.database.path,
      });
      const activationBridge = new ActivationBridge({
        store: tournamentStore,
      });
      const sessionStore = new SessionStore({
        dbPath: config.database.path,
      });

      // Recover any sessions left running by a previous crashed/orphaned process
      const recovered = sessionStore.recoverRunningSessions();
      if (recovered > 0) {
        out.warn(`Recovered ${recovered} orphaned session(s) from previous run`);
      }

      // ── Pre-Live Gate Check ──────────────────────────────────────────
      const isSpotLive = mode === 'live';
      const isPerpLive = config.intx.enabled && config.intx.perpMode === 'live';

      if (isSpotLive || isPerpLive) {
        // Create perpStateStore early when needed for perp gate check (reused later by perp engine block)
        if (isPerpLive && !perpStateStore) {
          perpStateStore = new PerpStateStore({ dbPath: config.perpDatabase.path });
        }

        const gateMode = (isSpotLive && isPerpLive) ? 'both' : isSpotLive ? 'spot' : 'perp';
        const gate = new PreLiveGate({
          sessionStore,
          perpStateStore: isPerpLive ? perpStateStore : undefined,
          minTrades: config.preLiveGate.minTrades,
          minNetPnl: config.preLiveGate.minNetPnl,
          lookbackTrades: config.preLiveGate.lookbackTrades,
        });

        const gateResult = gate.check(gateMode);

        if (!gateResult.passed) {
          out.error('');
          out.error('PRE-LIVE GATE FAILED:');
          for (const reason of gateResult.failReasons) {
            out.error(`  - ${reason}`);
          }
          out.error('');
          out.error('Run paper mode first to build a track record before activating live trading.');
          dbConn.sqlite.close();
          process.exit(1);
        }

        out.success(`Pre-live gate passed (${gateResult.totalTradeCount} trades, net P&L: $${gateResult.totalNetPnl})`);
      }

      let anyCandles = false;

      // Run tournament and activate winner for each configured trading pair
      for (const tradePair of tradingPairs) {
        const candles = repo.getCandles(tradePair, timeframe, startMs, endMs);
        out.info(`${candles.length} candles loaded for ${tradePair} ${timeframe}`);

        if (candles.length === 0) {
          out.warn(`No candle data for ${tradePair} — skipping (run \`npm run sync\` first)`);
          continue;
        }
        anyCandles = true;

        if (registry.list().length < 2) {
          out.warn(`Only ${registry.list().length} strategy registered for ${tradePair} — skipping tournament`);
          continue;
        }

        // Load optimized exit configs for this tournament run
        let strategyConfigs: Record<string, unknown>[] | undefined;
        {
          const exitStore = new ExitConfigStore({ dbPath: config.database.path });
          try {
            const configs = registry.list().map((strategyName) => {
              const baseStratConfig = { strategy: strategyName };
              const hash = hashStrategyConfig(baseStratConfig as Record<string, unknown>);
              const optimized = exitStore.getForStrategy(strategyName, hash);
              if (optimized) {
                return { ...baseStratConfig, exits: optimized.exitConfig.exits };
              }
              return baseStratConfig;
            });
            if (configs.some((c) => 'exits' in c)) {
              strategyConfigs = configs;
            }
          } finally {
            exitStore.close();
          }
        }

        // Apply spot strategy parameter overrides from env/config (SIG-02)
        if (strategyConfigs) {
          const overrides = config.spotStrategyOverrides;
          strategyConfigs = strategyConfigs.map((cfg) => {
            const s = cfg.strategy as string;
            const merged = { ...cfg };
            if (s === 'rsi-mean-reversion' && overrides.rsiPeriod !== undefined) {
              merged.period = overrides.rsiPeriod;
            }
            if (s === 'bollinger-breakout' && overrides.bbPeriod !== undefined) {
              merged.period = overrides.bbPeriod;
            }
            if (s === 'z-score-mean-reversion' && overrides.zScoreWindow !== undefined) {
              merged.period = overrides.zScoreWindow;
            }
            return merged;
          });
        }

        const tournamentConfig = parseTournamentConfig({
          pair: tradePair,
          timeframe,
          startMs,
          endMs,
          initialCapital: capital,
          topN,
          activationMode: 'none',
          walkForward: { trainWindowMs, validateWindowMs, stepMs },
          strategyConfigs,
        });

        const result = await runner.run(tournamentConfig, candles);
        tournamentStore.saveTournament(result);

        out.info(
          `${result.strategiesEvaluated} strategies evaluated for ${tradePair} in ${(result.durationMs / 1000).toFixed(1)}s`,
        );
        for (const entry of result.leaderboard.slice(0, topN)) {
          const sharpe = entry.oosMetrics.sharpeRatio.toFixed(4);
          out.table(`#${entry.rank}`, `${entry.strategyName} [${tradePair}] (OOS Sharpe: ${sharpe})`);
        }

        if (mode === 'paper') {
          for (const entry of result.leaderboard.slice(0, topN)) {
            const liveFeed = new LiveDataFeed({
              apiKey: config.coinbase.apiKeyName,
              apiSecret: config.coinbase.apiKeySecret,
              timeframe,
            });

            // Wire candle events to feed health monitor
            liveFeed.on('candle', (candle: Candle) => {
              feedHealthMonitor.onCandle(candle.pair);
            });

            const paperConfig = parsePaperConfig({
              pair: tradePair,
              timeframe,
              strategyConfig: entry.strategyConfig,
              initialCapital: capital,
            });

            const engine = new PaperTradingEngine({
              config: paperConfig,
              liveFeed,
              sessionStore,
              strategyRegistry: registry,
              indicatorEngine,
              riskManager,
              candleRepo: repo,
              regimeLeaderboards: result.regimeLeaderboards,
              spotSignalGate,
              feedHealthMonitor,
            });

            const session = await engine.start();
            paperEngines.push(engine);

            const engineKey = `${entry.strategyName}:${tradePair}`;
            const stopEngine = async (): Promise<void> => { await engine.stop(); };
            resources.push({
              name: `paper-engine:${engineKey}`,
              stop: stopEngine,
            });

            activationBridge.addEngine(engineKey, {
              sessionId: session.id,
              strategyName: engineKey,
              stop: stopEngine,
            });

            out.table('  Activated', `${entry.strategyName} [${tradePair}] (session: ${session.id})`);
          }
        }
      }

      if (!anyCandles) {
        out.error('No candle data available for any pair. Run `npm run sync` first.');
        dbConn.sqlite.close();
        process.exit(1);
      }

      if (mode === 'none') {
        out.info('Activation mode: none (display only)');
      }

      out.success('Tournament and activation complete');

      // ── Step 4: Dashboard ──────────────────────────────────────

      out.step(4, totalSteps, 'Starting dashboard...');

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

      // Perp engine wiring (populated when FCM is enabled — Phase 26/27 integration)
      const perpEngineEmitters: EventEmitter[] = [];

      // GATE-02: Hoist feeConfig for dashboard — assigned inside FCM block if enabled
      let dashboardFeeConfig: LiveFeeSnapshot | undefined;
      // Hoisted for fee refresh service (assigned inside FCM block when enabled)
      let perpClientForFeeRefresh: import('../perp/intx-client.js').IntxClient | undefined;
      // Mutable live fee snapshots — mutated in-place by FeeRefreshService every 6h
      type LiveFeeSnapshot = import('../core/fee-refresh-service.js').LiveFeeSnapshot;

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
          timeframe,
        });

        // Wire candle events to feed health monitor
        liveFeed.on('candle', (candle: Candle) => {
          feedHealthMonitor.onCandle(candle.pair);
        });

        const paperConfig = parsePaperConfig({
          pair: tradingPairs[0], // default to first configured pair for ad-hoc starts
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
          candleRepo: repo,
          spotSignalGate,
          feedHealthMonitor,
        });
        const session = await engine.start();
        paperEngines.push(engine);
        resources.push({
          name: `paper-engine:${strategyName}`,
          stop: async () => { await engine.stop(); },
        });
        return { sessionId: session.id };
      };

      // ── Perp engine wiring (INFRA-03: error listener, INFRA-04: shutdown order) ──
      if (config.intx.enabled && config.intx.perpMode !== 'none') {
        const perpClient = new IntxClient(config.intx);
        perpClientForFeeRefresh = perpClient;

        // INFRA-03: error listener MUST be registered before .start() to prevent
        // Node.js from throwing an uncaught exception on unhandled 'error' events.
        perpClient.on('error', (err: Error) => {
          out.warn(`IntxClient error — perp subsystem affected, spot continues: ${err.message}`);
        });

        if (!perpStateStore) {
          perpStateStore = new PerpStateStore({ dbPath: config.perpDatabase.path });
        }

        await perpClient.start();

        // Wire IntxClient markPrice events to feed health monitor
        perpClient.on('markPrice', (evt: { instrument: string }) => {
          feedHealthMonitor.onMarkPrice(evt.instrument);
        });

        // Register perp instruments for feed health monitoring
        feedHealthMonitor.register(config.intx.btcProductId, 60_000);
        feedHealthMonitor.register(config.intx.ethProductId, 60_000);

        // FEES-01: Fetch actual FCM taker fee rate before tournament or engine construction.
        // fetchFeeConfig() never throws — returns DEFAULT_FEE_CONFIG on any API failure.
        const feeConfig: FeeConfig = await perpClient.fetchFeeConfig();
        out.info(
          `FCM taker fee loaded: ${(feeConfig.takerFeeRate * 100).toFixed(4)}% taker` +
          ` (source: ${feeConfig.source})`,
        );

        // GATE-02: expose FCM fee config to dashboard (mutable — FeeRefreshService updates in-place)
        dashboardFeeConfig = {
          takerFeeRate: feeConfig.takerFeeRate,
          makerFeeRate: feeConfig.makerFeeRate,
          source: (feeConfig.source as 'api' | 'fallback') ?? 'api',
        };

        // PIPE-01: Run perp tournament to get regime leaderboards
        let perpRegimeLeaderboards: RegimeLeaderboards | undefined;
        let perpActivationReady = false;

        if (!skipPerpTournament) {
          try {
            const perpResult = await runPerpTournament({
              pair: 'BTC-USD',
              timeframe,
              days,
              capital,
              topN,
              mc: false,
              dbPath: config.database.path,
              feeConfig,   // FEES-01: pass fetched fee rate
            });
            perpRegimeLeaderboards = perpResult.regimeLeaderboards;
            out.info(
              `${perpResult.strategiesEvaluated} perp strategies evaluated in ${(perpResult.durationMs / 1000).toFixed(1)}s`,
            );
            for (const entry of perpResult.leaderboard.slice(0, topN)) {
              const sharpe = entry.oosMetrics.sharpeRatio.toFixed(4);
              out.table(`#${entry.rank}`, `${entry.strategyName} [PERP] (OOS Sharpe: ${sharpe})`);
            }
            const hasOosTrades = perpResult.leaderboard.some(
              (e) => e.oosMetrics.totalTrades > 0,
            );
            if (hasOosTrades) {
              out.success('Perp tournament complete');
              perpActivationReady = true;
            } else {
              out.warn('Perp tournament produced zero OOS trades — perp engine will not activate');
            }
          } catch (perpErr) {
            out.warn(
              `Perp tournament failed: ${perpErr instanceof Error ? perpErr.message : String(perpErr)} — perp engine will not activate`,
            );
          }
        } else {
          out.info('Skipping perp tournament (--skip-perp-tournament)');
          perpActivationReady = true;
        }

        // PIPE-02/03: Activate perp engine only when tournament succeeded with OOS trades
        // (or --skip-perp-tournament was passed)
        if (perpActivationReady) {
          const fundingRateProvider = (): number | null => perpClient.getLastFundingRate();

          const perpLiveFeed = new LiveDataFeed({
            apiKey: config.coinbase.apiKeyName,
            apiSecret: config.coinbase.apiKeySecret,
            timeframe,
          });

          // Wire perp LiveDataFeed candle events to feed health monitor
          perpLiveFeed.on('candle', (candle: Candle) => {
            feedHealthMonitor.onCandle(candle.pair);
          });

          if (config.intx.perpMode === 'paper') {
            // PIPE-02: PaperPerpEngine
            const paperPerpEngine = new PaperPerpEngine({
              intxClient: perpClient,
              stateStore: perpStateStore!,
              config: config.intx,
              regimeLeaderboards: perpRegimeLeaderboards,
              fundingRateProvider,
              feedHealthMonitor,
            });

            paperPerpEngine.start();
            perpEngineEmitters.push(paperPerpEngine);

            perpLiveFeed.on('candle', (candle: Candle) => {
              paperPerpEngine.onCandle(candle);
            });
            perpLiveFeed.start(['BTC-USD', 'ETH-USD'], undefined);

            // INFRA-04: engine stops BEFORE perp-intx-client (engine pushed first)
            resources.push({
              name: 'paper-perp-engine',
              stop: async () => {
                paperPerpEngine.stop();
                perpLiveFeed.stop();
              },
            });

            out.table('  Activated', 'PaperPerpEngine [BTC-PERP]');
          } else if (config.intx.perpMode === 'live') {
            // PIPE-03: PerpPositionManager
            const perpManager = new PerpPositionManager({
              intxClient: perpClient,
              stateStore: perpStateStore!,
              config: config.intx,
              regimeLeaderboards: perpRegimeLeaderboards,
              fundingRateProvider,
              feedHealthMonitor,
            });

            // PIPE-03: recoverFromRestart() BEFORE start()
            const recovery = await perpManager.recoverFromRestart();
            if (recovery.restored) {
              out.info('PerpPositionManager: open position restored from previous run');
            }
            if (recovery.closedExternally) {
              out.warn('PerpPositionManager: position was closed externally since last run');
            }

            perpManager.start();
            perpManager.startBalanceMonitor(); // every 15 min
            perpEngineEmitters.push(perpManager);

            perpLiveFeed.on('candle', (candle: Candle) => {
              perpManager.onCandle(candle);
            });
            perpLiveFeed.start(['BTC-USD', 'ETH-USD'], undefined);

            // INFRA-04: engine stops BEFORE perp-intx-client
            resources.push({
              name: 'perp-position-manager',
              stop: async () => {
                perpManager.stopBalanceMonitor();
                perpManager.stop();
                perpLiveFeed.stop();
              },
            });

            out.table('  Activated', 'PerpPositionManager [BTC-PERP] (live)');
          }
        }

        // INFRA-04: perp-intx-client always pushed after engine (engine stops first, then client, then dashboard)
        resources.push({
          name: 'perp-intx-client',
          stop: async () => perpClient.stop(),
        });
      }

      // Start feed health monitor and register for shutdown
      feedHealthMonitor.start();
      resources.push({ name: 'FeedHealthMonitor', stop: async () => feedHealthMonitor.stop() });

      // Start fee refresh service (every 6h) — spot always, FCM only when enabled
      const { FeeRefreshService } = await import('../core/fee-refresh-service.js');
      const cbFeeClient = new CBAdvancedTradeClient({
        apiKey: config.coinbase.apiKeyName,
        apiSecret: config.coinbase.apiKeySecret,
      });
      const feeRefreshService = new FeeRefreshService(
        cbFeeClient,
        spotSignalGate,
        spotFeeConfig,
        perpClientForFeeRefresh,
        dashboardFeeConfig,
      );
      feeRefreshService.start();
      resources.push({ name: 'FeeRefreshService', stop: async () => feeRefreshService.stop() });

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
        paperEngines,
        perpEngines: perpEngineEmitters,
        perpStateStore,
        gateConfig: config.preLiveGate,
        feeConfig: dashboardFeeConfig,
        spotFeeConfig,
        feedHealthMonitor,
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
