/**
 * Dashboard server bootstrap.
 *
 * Creates a Fastify instance with CORS, WebSocket, and static file plugins.
 * Wires engine events to the WebSocket broadcaster for real-time updates.
 * Registers all REST route modules under the /api prefix.
 */

import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyCors from '@fastify/cors';
import type { FastifyInstance } from 'fastify';
import type { EventEmitter } from 'node:events';
import { createModuleLogger } from '../../core/logger.js';
import type { DashboardConfig } from './config.js';
import type { LiveStateStore } from '../../live/state-store.js';
import type { SessionStore } from '../../paper/session-store.js';
import type { ActivationBridge } from '../../tournament/activation-bridge.js';
import type { RiskManager } from '../../risk/risk-manager.js';
import type { BacktestStore } from '../../backtest/backtest-store.js';
import type { CorrelationStore } from '../../correlation/correlation-store.js';
import type { CandleRepository } from '../../data/storage/candle-repo.js';
import type { PaperTradingEngine } from '../../paper/paper-engine.js';
import {
  toApiSession,
  toApiPaperSession,
  toApiTrade,
  toApiPaperTrade,
} from './types.js';
import type { ApiTrade, ApiEquityPoint, ApiStrategyInfo, WsCommand } from './types.js';
import { WsBroadcaster } from './ws/broadcaster.js';
import { wsHandler } from './ws/handler.js';
import { registerSessionRoutes } from './routes/sessions.js';
import { registerTradeRoutes } from './routes/trades.js';
import { registerEquityRoutes } from './routes/equity.js';
import { registerPositionRoutes } from './routes/positions.js';
import { registerRiskRoutes } from './routes/risk.js';
import { registerStrategyRoutes } from './routes/strategies.js';
import { registerKillSwitchRoutes } from './routes/kill-switch.js';
import { registerBacktestRoutes } from './routes/backtests.js';
import { registerPortfolioRoutes } from './routes/portfolio.js';
import { registerCandleRoutes } from './routes/candles.js';
import { registerEquitySummaryRoute } from './routes/equity-summary.js';

const log = createModuleLogger('dashboard-server');

// ── Types ────────────────────────────────────────────────────────────

export interface DashboardDeps {
  liveStateStore: LiveStateStore;
  sessionStore: SessionStore;
  activationBridge: ActivationBridge;
  riskManager?: RiskManager;
  /** Engine event emitters to subscribe to for real-time broadcasting. */
  engines: EventEmitter[];
  /** Callback to start a strategy by name. Returns session info. */
  engineFactory?: (strategyName: string, configOverride?: Record<string, unknown>) => Promise<{ sessionId: string }>;
  backtestStore?: BacktestStore;
  correlationStore?: CorrelationStore;
  repo?: CandleRepository;
  /** Live reference to all active paper engines — used by positions endpoint. */
  paperEngines?: PaperTradingEngine[];
  /** Optional perp engine event emitters (PerpPositionManager instances) for real-time perp broadcasting. */
  perpEngines?: EventEmitter[];
}

export interface RouteDeps {
  liveStateStore: LiveStateStore;
  sessionStore: SessionStore;
  activationBridge: ActivationBridge;
  riskManager?: RiskManager;
  engineFactory?: (strategyName: string, configOverride?: Record<string, unknown>) => Promise<{ sessionId: string }>;
  backtestStore?: BacktestStore;
  correlationStore?: CorrelationStore;
  repo?: CandleRepository;
  /** Live reference to all active paper engines — used by positions endpoint. */
  paperEngines?: PaperTradingEngine[];
}

export interface DashboardServer {
  app: FastifyInstance;
  broadcaster: WsBroadcaster;
  start: () => Promise<string>;
  close: () => Promise<void>;
}

// ── Event-to-WS mapping ─────────────────────────────────────────────

const ENGINE_EVENT_MAP: Record<string, string> = {
  orderSubmitted: 'orderSubmitted',
  orderFilled: 'orderFilled',
  orderCancelled: 'orderCancelled',
  orderFailed: 'orderFailed',
  reconciliation: 'reconciliation',
  shutdown: 'shutdown',
  error: 'error',
  started: 'engineStarted',
  stopped: 'engineStopped',
  priceTick: 'priceTick',
  equityUpdate: 'equityUpdate',
  circuitBreaker: 'circuitBreaker',
  riskUpdate: 'riskUpdate',
};

// ── Server Factory ───────────────────────────────────────────────────

/**
 * Create and configure the dashboard server.
 *
 * Does NOT call listen() -- caller must invoke start() on the returned object.
 */
export async function createDashboardServer(
  config: DashboardConfig,
  deps: DashboardDeps,
): Promise<DashboardServer> {
  const app = Fastify({
    logger: false, // We use our own Pino logger
  });

  // Register plugins
  if (config.isDev) {
    await app.register(fastifyCors, { origin: true });
  }

  await app.register(fastifyWebsocket);

  // In production, serve static files from dist/dashboard
  if (!config.isDev) {
    try {
      const fastifyStatic = await import('@fastify/static');
      const path = await import('node:path');
      await app.register(fastifyStatic.default, {
        root: path.resolve('dist/dashboard'),
        prefix: '/',
      });
    } catch {
      log.warn('Static file serving not available (dist/dashboard not found)');
    }
  }

  // Instantiate broadcaster
  const broadcaster = new WsBroadcaster();

  // Wire engine events to broadcaster
  for (const engine of deps.engines) {
    for (const [engineEvent, wsType] of Object.entries(ENGINE_EVENT_MAP)) {
      engine.on(engineEvent, (...args: unknown[]) => {
        broadcaster.broadcast(wsType as any, args.length === 1 ? args[0] : args);
      });
    }
  }

  // Wire perp engine events to broadcaster — separate from spot ENGINE_EVENT_MAP
  const PERP_EVENT_MAP: Record<string, string> = {
    fundingUpdate: 'perpFundingUpdate',
    positionOpened: 'perpPositionUpdate',
    positionClosed: 'perpPositionUpdate',
    exposureUpdate: 'perpExposureUpdate',
  };
  for (const engine of (deps.perpEngines ?? [])) {
    for (const [engineEvent, wsType] of Object.entries(PERP_EVENT_MAP)) {
      engine.on(engineEvent, (...args: unknown[]) => {
        broadcaster.broadcast(wsType as any, args.length === 1 ? args[0] : args);
      });
    }
  }

  // Build route dependencies
  const routeDeps: RouteDeps = {
    liveStateStore: deps.liveStateStore,
    sessionStore: deps.sessionStore,
    activationBridge: deps.activationBridge,
    riskManager: deps.riskManager,
    engineFactory: deps.engineFactory,
    backtestStore: deps.backtestStore,
    correlationStore: deps.correlationStore,
    repo: deps.repo,
    paperEngines: deps.paperEngines,
  };

  // Register WebSocket handler
  await wsHandler(app, {
    broadcaster,
    getSnapshot: () => buildSnapshot(routeDeps),
    onCommand: (cmd, ws) => handleCommand(cmd, routeDeps, broadcaster),
  });

  // Register REST routes
  await registerSessionRoutes(app, routeDeps);
  await registerTradeRoutes(app, routeDeps);
  await registerEquityRoutes(app, routeDeps);
  await registerPositionRoutes(app, routeDeps);
  await registerRiskRoutes(app, routeDeps);
  await registerStrategyRoutes(app, routeDeps);
  await registerKillSwitchRoutes(app, routeDeps);
  await registerBacktestRoutes(app, routeDeps);
  await registerPortfolioRoutes(app, routeDeps);
  await registerCandleRoutes(app, routeDeps);
  await registerEquitySummaryRoute(app, routeDeps);

  // Health check
  app.get('/api/health', async () => {
    return {
      status: 'ok',
      uptime: process.uptime(),
      wsClients: broadcaster.getClientCount(),
    };
  });

  return {
    app,
    broadcaster,
    start: async () => {
      const address = await app.listen({ port: config.port, host: config.host });
      log.info({ address, port: config.port }, 'Dashboard server started');
      return address;
    },
    close: async () => {
      broadcaster.closeAll();
      await app.close();
      log.info('Dashboard server closed');
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

function buildSnapshot(deps: RouteDeps) {
  const liveSessions = deps.liveStateStore.listSessions('running').map(toApiSession);
  const paperSessions = deps.sessionStore.listSessions('running').map(toApiPaperSession);
  const sessions = [...liveSessions, ...paperSessions];

  let trades: ApiTrade[] = [];
  let equity: ApiEquityPoint[] = [];
  if (sessions.length > 0) {
    const activeId = sessions[0].id;
    const activeMode = sessions[0].mode;
    if (activeMode === 'live') {
      trades = deps.liveStateStore.getSessionTrades(activeId).map(toApiTrade);
      equity = deps.liveStateStore.getSessionEquity(activeId).map((ep) => ({
        timestamp: ep.timestamp,
        equity: ep.equity.toString(),
      }));
    } else {
      trades = deps.sessionStore.getSessionTrades(activeId).map((t) => toApiPaperTrade(activeId, t));
      equity = deps.sessionStore.getSessionEquity(activeId).map((ep) => ({
        timestamp: ep.timestamp,
        equity: ep.equity.toString(),
      }));
    }
  }

  const engines = deps.activationBridge.getActiveEngines();
  const strategies: ApiStrategyInfo[] = [];
  for (const [name, handle] of engines) {
    strategies.push({ name, sessionId: handle.sessionId, status: 'running' as const });
  }

  const risk = deps.riskManager
    ? (() => {
        const state = deps.riskManager!.getCurrentRiskState();
        return {
          circuitBreakerTripped: state.circuitBreakerTripped,
          currentDrawdownPct: state.currentDrawdownPct,
          currentExposurePct: state.currentExposurePct,
          thresholds: {
            maxDrawdownPct: state.thresholds.maxDrawdownPct,
            maxExposurePct: state.thresholds.maxExposurePct,
            maxDailyLossPct: state.thresholds.maxDailyLossPct,
            maxPositionCount: state.thresholds.maxPositionCount,
          },
        };
      })()
    : undefined;

  return { sessions, trades, equity, strategies, risk };
}

async function handleCommand(
  cmd: WsCommand,
  deps: RouteDeps,
  broadcaster: WsBroadcaster,
): Promise<void> {
  try {
    switch (cmd.action) {
      case 'killSwitch': {
        const count = await deps.activationBridge.deactivateAll();
        broadcaster.broadcast('shutdown', { enginesStoppedCount: count });
        break;
      }
      case 'startStrategy': {
        const name = cmd.params?.['name'] as string;
        if (!name || !deps.engineFactory) break;
        await deps.engineFactory(name);
        break;
      }
      case 'stopStrategy': {
        const name = cmd.params?.['name'] as string;
        if (!name) break;
        const engines = deps.activationBridge.getActiveEngines();
        const handle = engines.get(name);
        if (handle) await handle.stop();
        break;
      }
    }
  } catch (err) {
    log.error({ err, action: cmd.action }, 'Error handling WS command');
    broadcaster.broadcast('error', {
      message: err instanceof Error ? err.message : 'Unknown error',
    });
  }
}
