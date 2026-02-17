/**
 * Trade REST routes.
 *
 * GET /api/sessions/:id/trades -- paginated trades for a session
 */

import type { FastifyInstance } from 'fastify';
import { createModuleLogger } from '../../../core/logger.js';
import type { RouteDeps } from '../index.js';
import { toApiTrade, toApiPaperTrade } from '../types.js';

const log = createModuleLogger('route-trades');

export async function registerTradeRoutes(
  app: FastifyInstance,
  deps: RouteDeps,
): Promise<void> {
  app.get<{
    Params: { id: string };
    Querystring: {
      sort?: string;
      order?: 'asc' | 'desc';
      limit?: string;
      offset?: string;
    };
  }>('/api/sessions/:id/trades', async (request) => {
    const { id } = request.params;
    const { order = 'asc', limit: limitStr = '100', offset: offsetStr = '0' } = request.query;
    const limit = parseInt(limitStr, 10) || 100;
    const offset = parseInt(offsetStr, 10) || 0;

    // Try live trades first
    const liveTrades = deps.liveStateStore.getSessionTrades(id);
    if (liveTrades.length > 0) {
      let trades = liveTrades.map(toApiTrade);
      trades.sort((a, b) =>
        order === 'desc'
          ? b.entryTimestamp - a.entryTimestamp
          : a.entryTimestamp - b.entryTimestamp,
      );
      return trades.slice(offset, offset + limit);
    }

    // Try paper trades
    const paperTrades = deps.sessionStore.getSessionTrades(id);
    let trades = paperTrades.map((t) => toApiPaperTrade(id, t));
    trades.sort((a, b) =>
      order === 'desc'
        ? b.entryTimestamp - a.entryTimestamp
        : a.entryTimestamp - b.entryTimestamp,
    );
    return trades.slice(offset, offset + limit);
  });
}
