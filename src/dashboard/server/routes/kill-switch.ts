/**
 * Kill switch REST route.
 *
 * POST /api/kill-switch -- stops ALL active engines via ActivationBridge.
 * This is the REST fallback; the primary kill switch goes through WebSocket.
 */

import type { FastifyInstance } from 'fastify';
import { createModuleLogger } from '../../../core/logger.js';
import type { RouteDeps } from '../index.js';

const log = createModuleLogger('route-kill-switch');

export async function registerKillSwitchRoutes(
  app: FastifyInstance,
  deps: RouteDeps,
): Promise<void> {
  app.post('/api/kill-switch', async () => {
    log.warn('Kill switch activated via REST API');

    const count = await deps.activationBridge.deactivateAll();

    log.info({ enginesStoppedCount: count }, 'Kill switch complete');
    return { success: true, enginesStoppedCount: count };
  });
}
