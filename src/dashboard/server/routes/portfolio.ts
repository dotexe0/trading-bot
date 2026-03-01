/**
 * Portfolio REST routes.
 *
 * GET /api/portfolio/heatmap — returns BTC/ETH allocation percentages
 * and current Pearson correlation from CorrelationStore.
 */
import type { FastifyInstance } from 'fastify';
import { createModuleLogger } from '../../../core/logger.js';
import type { RouteDeps } from '../index.js';

const log = createModuleLogger('route-portfolio');

export async function registerPortfolioRoutes(
  app: FastifyInstance,
  deps: RouteDeps,
): Promise<void> {
  app.get('/api/portfolio/heatmap', async () => {
    // 1. Compute BTC/ETH position values from live and paper sessions
    let btcValueUsd = 0;
    let ethValueUsd = 0;

    // Live positions
    for (const session of deps.liveStateStore.listSessions('running')) {
      for (const trade of deps.liveStateStore.getSessionTrades(session.id)) {
        if (trade.exitTimestamp !== undefined && trade.exitTimestamp !== null) continue;
        const value = Number(trade.entryPrice) * Number(trade.entryQuantity);
        if (session.pair === 'BTC-USD') btcValueUsd += value;
        else if (session.pair === 'ETH-USD') ethValueUsd += value;
      }
    }

    // Paper positions — query engine portfolio state directly, since paper trades
    // are only written to the DB when they close (no open-trade records exist).
    if (deps.paperEngines) {
      for (const engine of deps.paperEngines) {
        const pos = engine.getOpenPosition();
        if (!pos) continue;
        const value = Number(pos.avgEntryPrice) * Number(pos.quantity);
        if (pos.pair === 'BTC-USD') btcValueUsd += value;
        else if (pos.pair === 'ETH-USD') ethValueUsd += value;
      }
    }

    // 2. Total portfolio equity (cash + positions) from latest equity point
    let totalEquityUsd = 0;
    for (const session of deps.sessionStore.listSessions('running')) {
      const equityPoints = deps.sessionStore.getSessionEquity(session.id);
      totalEquityUsd += equityPoints.length > 0
        ? Number(equityPoints[equityPoints.length - 1].equity)
        : Number(session.initialCapital);
    }
    for (const session of deps.liveStateStore.listSessions('running')) {
      const eq = deps.liveStateStore.getSessionEquity(session.id);
      if (eq.length > 0) totalEquityUsd += Number(eq[eq.length - 1].equity);
    }

    const positionTotal = btcValueUsd + ethValueUsd;
    const base = totalEquityUsd > 0 ? totalEquityUsd : positionTotal;
    const btcPct = base > 0 ? (btcValueUsd / base) * 100 : 0;
    const ethPct = base > 0 ? (ethValueUsd / base) * 100 : 0;

    // 3. Get latest correlation from CorrelationStore (1h timeframe)
    const corrSnapshot = deps.correlationStore?.getLatest('1h') ?? null;

    log.debug({ btcPct, ethPct, totalEquityUsd, correlation: corrSnapshot?.correlation ?? null }, 'Portfolio heatmap requested');

    return {
      assets: [
        { pair: 'BTC-USD', allocationPct: btcPct, valueUsd: btcValueUsd.toFixed(2) },
        { pair: 'ETH-USD', allocationPct: ethPct, valueUsd: ethValueUsd.toFixed(2) },
      ],
      totalValueUsd: (totalEquityUsd > 0 ? totalEquityUsd : positionTotal).toFixed(2),
      noPositions: positionTotal === 0,
      correlation: corrSnapshot?.correlation ?? null,
      correlationTimestamp: corrSnapshot?.timestamp ?? null,
    };
  });
}
