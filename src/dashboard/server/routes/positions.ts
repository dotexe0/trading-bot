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
    const positions: ApiPosition[] = [];

    // Live trading open positions
    const runningSessions = deps.liveStateStore.listSessions('running');
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

    // Paper trading open positions (from in-memory portfolio state)
    if (deps.paperEngines) {
      for (const engine of deps.paperEngines) {
        const pos = engine.getOpenPosition();
        if (!pos) continue;

        const entryPrice = d(pos.avgEntryPrice);
        const quantity = d(pos.quantity);
        // Use entry price as current price (best available from route context)
        const rawPnl = ZERO;
        const pnlPct = ZERO;

        positions.push({
          sessionId: pos.sessionId,
          orderId: `paper-${pos.sessionId}`,
          pair: pos.pair,
          side: pos.side === 'long' ? 'BUY' : 'SELL',
          entryPrice: entryPrice.toFixed(8),
          currentPrice: entryPrice.toFixed(8),
          quantity: quantity.toFixed(8),
          unrealizedPnl: rawPnl.toFixed(8),
          unrealizedPnlPct: pnlPct.toFixed(4),
          strategyName: pos.strategyName,
          createdAt: pos.entryTimestamp,
        });
      }
    }

    return positions;
  });
}
