/**
 * Position REST routes.
 *
 * GET /api/positions -- all open positions across active sessions
 */

import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from '../index.js';
import { d, ZERO } from '../../../core/decimal.js';

export interface ApiPosition {
  sessionId: string;
  orderId: string;
  pair: string;
  side: string;
  entryPrice: string;
  currentPrice: string;
  quantity: string;
  unrealizedPnl: string;
  unrealizedPnlPct: string;
  strategyName: string;
  createdAt: number;
}

export async function registerPositionRoutes(
  app: FastifyInstance,
  deps: RouteDeps,
): Promise<void> {
  app.get('/api/positions', async () => {
    const runningSessions = deps.liveStateStore.listSessions('running');
    const positions: ApiPosition[] = [];

    for (const session of runningSessions) {
      const trades = deps.liveStateStore.getSessionTrades(session.id);

      for (const trade of trades) {
        if (trade.exitTimestamp) continue; // already closed

        const entryPrice = d(trade.entryPrice);
        const quantity = d(trade.entryQuantity);
        const currentPrice = entryPrice; // best available without live feed access

        const rawPnl = trade.entrySide === 'BUY'
          ? currentPrice.minus(entryPrice).mul(quantity)
          : entryPrice.minus(currentPrice).mul(quantity);
        const cost = entryPrice.mul(quantity);
        const pnlPct = cost.isZero() ? ZERO : rawPnl.div(cost).mul(100);

        positions.push({
          sessionId: session.id,
          orderId: trade.entryOrderId,
          pair: session.pair,
          side: trade.entrySide,
          entryPrice: trade.entryPrice,
          currentPrice: currentPrice.toFixed(8),
          quantity: trade.entryQuantity,
          unrealizedPnl: rawPnl.toFixed(8),
          unrealizedPnlPct: pnlPct.toFixed(4),
          strategyName: session.strategyName,
          createdAt: trade.entryTimestamp,
        });
      }
    }

    return positions;
  });
}
