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
import type { SpotTradingEngine } from '../../spot/spot-trading-engine.js';
import type { PerpStateStore } from '../../perp/perp-state-store.js';
import type { FeedHealthMonitor, FeedHealthState } from '../../core/feed-health.js';
import type { TournamentStore } from '../../tournament/tournament-store.js';
import type { StrategyRegistry } from '../../strategies/registry.js';
import type { TournamentResult } from '../../tournament/types.js';
import {
  toApiSession,
  toApiPaperSession,
  toApiTrade,
  toApiPaperTrade,
  toApiPerpTrade,
} from './types.js';
import type { ApiTrade, ApiEquityPoint, ApiStrategyInfo, WsCommand, SystemHealthPayload } from './types.js';
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
import { registerPerpRoutes } from './routes/perp.js';
import { registerGateRoutes } from './routes/gate.js';

const log = createModuleLogger('dashboard-server');

// ── Ring Buffer ──────────────────────────────────────────────────────

class RingBuffer<T> {
  private items: T[] = [];
  constructor(private readonly maxSize: number) {}
  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.maxSize) this.items.shift();
  }
  toArray(): T[] { return [...this.items]; }
}

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
  paperEngines?: SpotTradingEngine[];
  /** Optional perp engine event emitters for real-time perp broadcasting. */
  perpEngines?: EventEmitter[];
  perpStateStore?: PerpStateStore;
  gateConfig?: { minTrades: number; minNetPnl: number; lookbackTrades?: number };
  feeConfig?: { takerFeeRate: number; makerFeeRate: number; source: string };
  spotFeeConfig?: { takerFeeRate: number; makerFeeRate: number; source: string };
  /** When provided, enables feed health broadcasting and snapshot inclusion. */
  feedHealthMonitor?: FeedHealthMonitor;
  /** Latest tournament results — used by /api/tournament/latest endpoint. */
  tournamentStore?: TournamentStore;
  /** All registered strategy names — used by /api/strategies/available endpoint. */
  strategyRegistry?: StrategyRegistry;
  /** Perp tournament result from the most recent perp tournament run. */
  perpTournamentResult?: TournamentResult;
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
  paperEngines?: SpotTradingEngine[];
  perpStateStore?: PerpStateStore;
  gateConfig?: { minTrades: number; minNetPnl: number; lookbackTrades?: number };
  feeConfig?: { takerFeeRate: number; makerFeeRate: number; source: string };
  spotFeeConfig?: { takerFeeRate: number; makerFeeRate: number; source: string };
  /** Latest tournament results — used by /api/tournament/latest endpoint. */
  tournamentStore?: TournamentStore;
  /** All registered strategy names — used by /api/strategies/available endpoint. */
  strategyRegistry?: StrategyRegistry;
  /** Perp tournament result from the most recent perp tournament run. */
  perpTournamentResult?: TournamentResult;
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
  strategyDrift: 'strategyDrift',
  strategySwitch: 'strategySwitch',
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

  // Ring buffers for perp time-series panels (DASH-01 and DASH-02)
  const fundingRingBuffer = new RingBuffer<{ instrument: string; time: number; value: number; color: string }>(500);
  const pnlRingBuffer = new RingBuffer<{ time: number; value: number }>(1440);
  let _lastPnlBroadcastMs = 0;
  let _lastPnlBroadcastSecond = 0;
  const PNL_THROTTLE_MS = 60_000;
  const MARK_PRICE_PNL_THROTTLE_MS = 5_000; // 5s — separate from fundingUpdate 60s path
  let _lastMarkPricePnlBroadcastMs = 0;
  let _lastMarkPricePnlBroadcastSecond = 0;

  // Cache latest funding rate per instrument — populated from fundingUpdate events, included in snapshot
  const lastKnownFundingRates = new Map<string, { instrument: string; currentFundingRate: string; cumulativeFundingCost: string }>();

  // Recovery state tracking for SystemHealth panel
  let currentRecoveryState: 'NORMAL' | 'RECOVERING' | 'RECONCILIATION_NEEDED' = 'NORMAL';
  let lastReconciliationAt: number | null = null;

  function broadcastSystemHealth(): void {
    const riskState = deps.riskManager?.getCurrentRiskState();
    const feedStatuses = deps.feedHealthMonitor?.getAllStatuses() ?? [];
    const payload: SystemHealthPayload = {
      recoveryState: currentRecoveryState,
      lastReconciliationAt,
      feedHealth: feedStatuses.map(s => ({
        instrument: s.instrument,
        status: s.status,
        lastCandleAt: s.lastCandleAt,
        lastMarkPriceAt: s.lastMarkPriceAt,
      })),
      riskProximity: {
        currentDrawdownPct: riskState?.currentDrawdownPct ?? 0,
        maxDrawdownPct: riskState?.thresholds.maxDrawdownPct ?? 20,
        currentExposurePct: riskState?.currentExposurePct ?? 0,
        maxExposurePct: riskState?.thresholds.maxExposurePct ?? 80,
      },
    };
    broadcaster.broadcast('systemHealth', payload);
  }

  // Wire engine events to broadcaster
  for (const engine of deps.engines) {
    for (const [engineEvent, wsType] of Object.entries(ENGINE_EVENT_MAP)) {
      engine.on(engineEvent, (...args: unknown[]) => {
        broadcaster.broadcast(wsType as any, args.length === 1 ? args[0] : args);
      });
    }
  }

  // Recovery state tracking — spot engines only (PerpTradingEngine does not emit reconciliation/started)
  for (const engine of deps.engines) {
    engine.on('reconciliation', () => {
      lastReconciliationAt = Date.now();
      broadcastSystemHealth();
    });
    engine.on('started', () => {
      if (currentRecoveryState === 'RECOVERING') {
        currentRecoveryState = 'NORMAL';
        broadcastSystemHealth();
      }
    });
    engine.on('error', () => {
      currentRecoveryState = 'RECONCILIATION_NEEDED';
      broadcastSystemHealth();
    });
    engine.on('riskUpdate', () => {
      broadcastSystemHealth();
    });
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

  // Additional fundingUpdate listener for DASH-01 (funding histogram), DASH-02 (P&L curve),
  // and snapshot hydration cache. Separate from PERP_EVENT_MAP perpFundingUpdate broadcast.
  for (const engine of (deps.perpEngines ?? [])) {
    engine.on('fundingUpdate', (payload: { instrument?: string; currentFundingRate?: string; cumulativeFundingCost?: string; unrealizedPnl?: string }) => {
      const now = Date.now();
      const instrument = payload.instrument ?? 'UNKNOWN';
      const rawRate = parseFloat(payload.currentFundingRate ?? '0');

      // Cache latest rate per instrument so new dashboard clients get it immediately via snapshot
      if (payload.instrument) {
        lastKnownFundingRates.set(payload.instrument, {
          instrument: payload.instrument,
          currentFundingRate: payload.currentFundingRate ?? '0',
          cumulativeFundingCost: payload.cumulativeFundingCost ?? '0',
        });
      }

      // DASH-01: funding rate histogram bar
      const bar = {
        instrument,
        time: Math.floor(now / 1000),
        value: Math.abs(rawRate),
        color: rawRate < 0 ? '#22c55e' : '#ef4444',
      };
      fundingRingBuffer.push(bar);
      broadcaster.broadcast('perpFundingHistory' as any, bar);

      // DASH-02: P&L curve (throttled to 1/minute)
      if (now - _lastPnlBroadcastMs >= PNL_THROTTLE_MS) {
        _lastPnlBroadcastMs = now;
        let broadcastSecond = Math.floor(now / 1000);
        if (broadcastSecond <= _lastPnlBroadcastSecond) {
          broadcastSecond = _lastPnlBroadcastSecond + 1;
        }
        _lastPnlBroadcastSecond = broadcastSecond;
        const pnlValue = parseFloat(payload.unrealizedPnl ?? '0');
        const point = { time: broadcastSecond, value: pnlValue };
        pnlRingBuffer.push(point);
        broadcaster.broadcast('perpPnlUpdate' as any, point);
      }
    });
  }

  // markPriceUpdate → perpPnlUpdate (5s real-time path, separate from fundingUpdate 60s path)
  // Also broadcasts perpMarkPriceUpdate so the positions table shows live unrealized P&L.
  for (const engine of (deps.perpEngines ?? [])) {
    engine.on('markPriceUpdate', (payload: {
      sessionId: string;
      instrument: string;
      markPrice: string;
      unrealizedPnl: string;
    }) => {
      const now = Date.now();

      // Real-time P&L chart update (5s throttle, separate ring buffer push)
      if (now - _lastMarkPricePnlBroadcastMs >= MARK_PRICE_PNL_THROTTLE_MS) {
        _lastMarkPricePnlBroadcastMs = now;
        let broadcastSecond = Math.floor(now / 1000);
        if (broadcastSecond <= _lastMarkPricePnlBroadcastSecond) {
          broadcastSecond = _lastMarkPricePnlBroadcastSecond + 1;
        }
        _lastMarkPricePnlBroadcastSecond = broadcastSecond;
        const pnlValue = parseFloat(payload.unrealizedPnl);
        const point = { time: broadcastSecond, value: pnlValue };
        pnlRingBuffer.push(point);
        broadcaster.broadcast('perpPnlUpdate', point);
      }

      // Live positions table update — broadcast partial update keyed by sessionId.
      // App.tsx merges this into the existing positions map.
      broadcaster.broadcast('perpMarkPriceUpdate', {
        id: payload.sessionId,
        markPrice: payload.markPrice,
        unrealizedPnl: payload.unrealizedPnl,
      });
    });
  }

  // Wire feed health monitor to broadcaster
  if (deps.feedHealthMonitor) {
    deps.feedHealthMonitor.on('healthChange', (state: FeedHealthState) => {
      broadcaster.broadcast('feedHealth' as any, {
        instrument: state.instrument,
        status: state.status,
        lastCandleAt: state.lastCandleAt,
        lastMarkPriceAt: state.lastMarkPriceAt,
      });
    });
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
    perpStateStore: deps.perpStateStore,
    gateConfig: deps.gateConfig,
    feeConfig: deps.feeConfig,
    spotFeeConfig: deps.spotFeeConfig,
    tournamentStore: deps.tournamentStore,
    strategyRegistry: deps.strategyRegistry,
    perpTournamentResult: deps.perpTournamentResult,
  };

  // Register WebSocket handler
  await wsHandler(app, {
    broadcaster,
    getSnapshot: () => buildSnapshot(routeDeps, fundingRingBuffer, pnlRingBuffer, deps.feedHealthMonitor, {
      recoveryState: currentRecoveryState,
      lastReconciliationAt,
    }, lastKnownFundingRates),
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
  await registerPerpRoutes(app, routeDeps);
  await registerGateRoutes(app, routeDeps);

  // Health check
  app.get('/api/health', async () => {
    return {
      status: 'ok',
      uptime: process.uptime(),
      wsClients: broadcaster.getClientCount(),
    };
  });

  // Reset paper trading history (paper mode only)
  app.post('/api/reset-paper', async (_req, reply) => {
    // Guard: refuse if any live session is running
    const liveSessions = deps.liveStateStore.listSessions('running');
    if (liveSessions.length > 0) {
      return reply.code(403).send({ error: 'Cannot reset while live sessions are running' });
    }
    // Guard: refuse if any paper session is still running (FK constraint would fail)
    const paperSessions = deps.sessionStore.listSessions('running');
    if (paperSessions.length > 0) {
      return reply.code(403).send({ error: 'Cannot reset while paper sessions are running — stop engines first' });
    }
    const spotCounts = deps.sessionStore.resetPaperHistory();
    const perpCounts = deps.perpStateStore?.resetHistory() ?? {};
    return { cleared: { ...spotCounts, ...perpCounts } };
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

function buildSnapshot(
  deps: RouteDeps,
  fundingRingBuffer?: RingBuffer<{ instrument: string; time: number; value: number; color: string }>,
  pnlRingBuffer?: RingBuffer<{ time: number; value: number }>,
  feedHealthMonitor?: FeedHealthMonitor,
  recoveryInfo?: { recoveryState: 'NORMAL' | 'RECOVERING' | 'RECONCILIATION_NEEDED'; lastReconciliationAt: number | null },
  knownFundingRates?: Map<string, { instrument: string; currentFundingRate: string; cumulativeFundingCost: string }>,
) {
  const liveSessions = deps.liveStateStore.listSessions('running').map(toApiSession);
  const paperSessions = deps.sessionStore.listSessions('running').map(toApiPaperSession);
  const sessions = [...liveSessions, ...paperSessions];

  let trades: ApiTrade[] = [];
  let equity: ApiEquityPoint[] = [];
  // Aggregate trades from ALL running sessions (not just the first)
  for (const session of sessions) {
    if (session.mode === 'live') {
      trades.push(...deps.liveStateStore.getSessionTrades(session.id).map(toApiTrade));
    } else {
      trades.push(...deps.sessionStore.getSessionTrades(session.id).map((t) => toApiPaperTrade(session.id, t)));
    }
  }
  // Include perp closed trades
  if (deps.perpStateStore) {
    trades.push(...deps.perpStateStore.listClosedTrades().map(toApiPerpTrade));
  }
  // Sort all trades by entry time descending
  trades.sort((a, b) => b.entryTimestamp - a.entryTimestamp);
  // Equity: use first session (primary) for equity curve
  if (sessions.length > 0) {
    const activeId = sessions[0].id;
    const activeMode = sessions[0].mode;
    if (activeMode === 'live') {
      equity = deps.liveStateStore.getSessionEquity(activeId).map((ep) => ({
        timestamp: ep.timestamp,
        equity: ep.equity.toString(),
      }));
    } else {
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

  return {
    sessions, trades, equity, strategies, risk,
    perpFundingHistory: fundingRingBuffer?.toArray() ?? [],
    perpPnlHistory: pnlRingBuffer?.toArray() ?? [],
    perpFundingRates: knownFundingRates ? Array.from(knownFundingRates.values()) : [],
    feedHealth: feedHealthMonitor?.getAllStatuses().map(s => ({
      instrument: s.instrument,
      status: s.status,
      lastCandleAt: s.lastCandleAt,
      lastMarkPriceAt: s.lastMarkPriceAt,
    })) ?? [],
    systemHealth: (() => {
      const riskState = deps.riskManager?.getCurrentRiskState?.();
      const feedStatuses = feedHealthMonitor?.getAllStatuses() ?? [];
      return {
        recoveryState: recoveryInfo?.recoveryState ?? 'NORMAL',
        lastReconciliationAt: recoveryInfo?.lastReconciliationAt ?? null,
        feedHealth: feedStatuses.map(s => ({
          instrument: s.instrument,
          status: s.status,
          lastCandleAt: s.lastCandleAt,
          lastMarkPriceAt: s.lastMarkPriceAt,
        })),
        riskProximity: {
          currentDrawdownPct: riskState?.currentDrawdownPct ?? 0,
          maxDrawdownPct: riskState?.thresholds.maxDrawdownPct ?? 20,
          currentExposurePct: riskState?.currentExposurePct ?? 0,
          maxExposurePct: riskState?.thresholds.maxExposurePct ?? 80,
        },
      };
    })(),
  };
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
