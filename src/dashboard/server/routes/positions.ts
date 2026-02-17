/**
 * Position REST routes.
 *
 * GET /api/positions -- all open positions across active sessions
 */

import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from '../index.js';
import { toApiOrder } from '../types.js';

export interface ApiPosition {
  sessionId: string;
  orderId: string;
  productId: string;
  side: string;
  entryPrice: string;
  quantity: string;
  createdAt: number;
}

export async function registerPositionRoutes(
  app: FastifyInstance,
  deps: RouteDeps,
): Promise<void> {
  app.get('/api/positions', async () => {
    // Get all running live sessions
    const runningSessions = deps.liveStateStore.listSessions('running');
    const positions: ApiPosition[] = [];

    for (const session of runningSessions) {
      // Open orders with ENTRY purpose that haven't been exited
      const openOrders = deps.liveStateStore.getOpenOrders(session.id);
      const trades = deps.liveStateStore.getSessionTrades(session.id);
      const exitedEntryIds = new Set(trades.map((t) => t.entryOrderId));

      for (const order of openOrders) {
        if (order.purpose === 'ENTRY' && !exitedEntryIds.has(order.orderId) && order.status === 'FILLED') {
          positions.push({
            sessionId: session.id,
            orderId: order.orderId,
            productId: order.productId,
            side: order.side,
            entryPrice: order.averageFillPrice ?? order.baseSize,
            quantity: order.filledSize,
            createdAt: order.createdAt,
          });
        }
      }

      // Also check filled entry orders
      const allTrades = deps.liveStateStore.getSessionTrades(session.id);
      for (const trade of allTrades) {
        if (!trade.exitTimestamp) {
          positions.push({
            sessionId: session.id,
            orderId: trade.entryOrderId,
            productId: session.pair,
            side: trade.entrySide,
            entryPrice: trade.entryPrice,
            quantity: trade.entryQuantity,
            createdAt: trade.entryTimestamp,
          });
        }
      }
    }

    return positions;
  });
}
