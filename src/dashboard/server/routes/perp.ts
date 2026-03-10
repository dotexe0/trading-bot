/**
 * Perp REST routes -- hydration endpoint for dashboard perp panels.
 */
import type { FastifyInstance } from 'fastify';
import type { PerpStateStore } from '../../../perp/perp-state-store.js';

export interface PerpRouteDeps {
  perpStateStore?: PerpStateStore;
}

export async function registerPerpRoutes(
  app: FastifyInstance,
  deps: PerpRouteDeps,
): Promise<void> {
  app.get('/api/perp/positions', async () => {
    if (!deps.perpStateStore) return [];
    return deps.perpStateStore.getAllOpenSessions();
  });
}
