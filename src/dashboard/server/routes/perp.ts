/**
 * Perp REST routes -- hydration endpoint for dashboard perp panels.
 */
import type { FastifyInstance } from 'fastify';
import type { PerpStateStore } from '../../../perp/perp-state-store.js';
import type { TournamentResult } from '../../../tournament/types.js';

export interface PerpRouteDeps {
  perpStateStore?: PerpStateStore;
  perpTournamentResult?: TournamentResult;
}

export async function registerPerpRoutes(
  app: FastifyInstance,
  deps: PerpRouteDeps,
): Promise<void> {
  app.get('/api/perp/positions', async () => {
    if (!deps.perpStateStore) return [];
    return deps.perpStateStore.getAllOpenSessions();
  });

  app.get('/api/perp/tournament/latest', async (_request, reply) => {
    if (!deps.perpTournamentResult) return reply.status(204).send();
    const result = deps.perpTournamentResult;
    return {
      runAt: result.runTimestamp,
      strategiesEvaluated: result.strategiesEvaluated,
      leaderboard: result.leaderboard.map((e) => ({
        rank: e.rank,
        strategyName: e.strategyName,
        strategyConfig: e.strategyConfig,
        isSharpe: e.isMetrics.sharpeRatio,
        oosSharpe: e.oosMetrics.sharpeRatio,
        robustnessRatio: e.robustnessRatio,
        oosTradeCount: e.oosMetrics.totalTrades,
        oosWinRate: parseFloat(String(e.oosMetrics.winRate)),
        disqualified: e.disqualified,
        disqualifyReason: e.disqualifyReason ?? null,
      })),
    };
  });
}
