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
    // 1. Compute BTC/ETH allocation from open live positions
    const sessions = deps.liveStateStore.listSessions('running');
    let btcValueUsd = 0;
    let ethValueUsd = 0;

    for (const session of sessions) {
      const trades = deps.liveStateStore.getSessionTrades(session.id);
      for (const trade of trades) {
        // Open positions have no exitTimestamp
        if (trade.exitTimestamp !== undefined && trade.exitTimestamp !== null) continue;
        const value = Number(trade.entryPrice) * Number(trade.entryQuantity);
        if (session.pair === 'BTC-USD') btcValueUsd += value;
        else if (session.pair === 'ETH-USD') ethValueUsd += value;
      }
    }

    const totalValue = btcValueUsd + ethValueUsd;
    const btcPct = totalValue > 0 ? (btcValueUsd / totalValue) * 100 : 0;
    const ethPct = totalValue > 0 ? (ethValueUsd / totalValue) * 100 : 0;

    // 2. Get latest correlation from CorrelationStore (1h timeframe)
    const corrSnapshot = deps.correlationStore?.getLatest('1h') ?? null;

    log.debug({ btcPct, ethPct, correlation: corrSnapshot?.correlation ?? null }, 'Portfolio heatmap requested');

    return {
      assets: [
        { pair: 'BTC-USD', allocationPct: btcPct, valueUsd: btcValueUsd.toFixed(2) },
        { pair: 'ETH-USD', allocationPct: ethPct, valueUsd: ethValueUsd.toFixed(2) },
      ],
      totalValueUsd: totalValue.toFixed(2),
      noPositions: totalValue === 0,
      correlation: corrSnapshot?.correlation ?? null,
      correlationTimestamp: corrSnapshot?.timestamp ?? null,
    };
  });
}
