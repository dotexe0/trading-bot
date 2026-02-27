import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from '../index.js';

/**
 * GET /api/portfolio/equity
 *
 * Returns the current total portfolio equity across all running sessions,
 * along with starting capital and P&L. Polled by the PortfolioStats bar.
 */
export async function registerEquitySummaryRoute(
  app: FastifyInstance,
  deps: RouteDeps,
): Promise<void> {
  app.get('/api/portfolio/equity', async () => {
    let totalEquity = 0;
    let totalInitialCapital = 0;

    // Paper sessions
    for (const session of deps.sessionStore.listSessions('running')) {
      const points = deps.sessionStore.getSessionEquity(session.id);
      const latestEquity = points.length > 0
        ? Number(points[points.length - 1].equity)
        : Number(session.initialCapital);
      totalEquity += latestEquity;
      totalInitialCapital += Number(session.initialCapital);
    }

    // Live sessions
    for (const session of deps.liveStateStore.listSessions('running')) {
      const points = deps.liveStateStore.getSessionEquity(session.id);
      if (points.length > 0) {
        totalEquity += Number(points[points.length - 1].equity);
      }
      // live sessions don't expose initialCapital the same way — skip for now
    }

    if (totalInitialCapital === 0 && totalEquity === 0) {
      return { equity: '0', initialCapital: '0', pnl: '0', pnlPct: '0' };
    }

    const pnl = totalEquity - totalInitialCapital;
    const pnlPct = totalInitialCapital > 0 ? (pnl / totalInitialCapital) * 100 : 0;

    return {
      equity: totalEquity.toFixed(2),
      initialCapital: totalInitialCapital.toFixed(2),
      pnl: pnl.toFixed(2),
      pnlPct: pnlPct.toFixed(4),
    };
  });
}
