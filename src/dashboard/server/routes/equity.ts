/**
 * Equity REST routes.
 *
 * GET /api/sessions/:id/equity -- equity curve for charting
 */

import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from '../index.js';
import type { ApiEquityPoint } from '../types.js';

export async function registerEquityRoutes(
  app: FastifyInstance,
  deps: RouteDeps,
): Promise<void> {
  app.get<{
    Params: { id: string };
  }>('/api/sessions/:id/equity', async (request) => {
    const { id } = request.params;

    // Try live equity first
    const liveEquity = deps.liveStateStore.getSessionEquity(id);
    if (liveEquity.length > 0) {
      return liveEquity.map(
        (ep): ApiEquityPoint => ({
          timestamp: ep.timestamp,
          equity: ep.equity.toString(),
        }),
      );
    }

    // Try paper equity
    const paperEquity = deps.sessionStore.getSessionEquity(id);
    return paperEquity.map(
      (ep): ApiEquityPoint => ({
        timestamp: ep.timestamp,
        equity: ep.equity.toString(),
      }),
    );
  });
}
