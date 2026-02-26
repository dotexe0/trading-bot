/**
 * Strategy REST routes.
 *
 * GET /api/strategies -- list active engines from ActivationBridge
 * POST /api/strategies/:name/start -- start a strategy via engine factory
 * POST /api/strategies/:name/stop -- stop a strategy via engine handle
 * PATCH /api/strategies/:name/config -- hot-reload strategy config without bot restart
 */

import type { FastifyInstance } from 'fastify';
import { createModuleLogger } from '../../../core/logger.js';
import type { RouteDeps } from '../index.js';
import type { ApiStrategyInfo } from '../types.js';
import { strategyConfigSchema } from '../../../strategies/config.js';

const log = createModuleLogger('route-strategies');

export async function registerStrategyRoutes(
  app: FastifyInstance,
  deps: RouteDeps,
): Promise<void> {
  app.get('/api/strategies', async (): Promise<ApiStrategyInfo[]> => {
    const engines = deps.activationBridge.getActiveEngines();
    const strategies: ApiStrategyInfo[] = [];

    for (const [name, handle] of engines) {
      strategies.push({
        name,
        sessionId: handle.sessionId,
        status: 'running',
      });
    }

    return strategies;
  });

  app.post<{
    Params: { name: string };
  }>('/api/strategies/:name/start', async (request, reply) => {
    const { name } = request.params;

    if (!deps.engineFactory) {
      return reply.status(503).send({ error: 'Engine factory not configured' });
    }

    try {
      const result = await deps.engineFactory(name);
      log.info({ strategy: name, sessionId: result.sessionId }, 'Strategy started via API');
      return { success: true, sessionId: result.sessionId };
    } catch (err) {
      log.error({ strategy: name, err }, 'Failed to start strategy');
      return reply.status(500).send({
        error: err instanceof Error ? err.message : 'Failed to start strategy',
      });
    }
  });

  app.post<{
    Params: { name: string };
  }>('/api/strategies/:name/stop', async (request, reply) => {
    const { name } = request.params;

    const engines = deps.activationBridge.getActiveEngines();
    const handle = engines.get(name);

    if (!handle) {
      return reply.status(404).send({ error: `Strategy '${name}' not found or not running` });
    }

    try {
      await handle.stop();
      log.info({ strategy: name }, 'Strategy stopped via API');
      return { success: true };
    } catch (err) {
      log.error({ strategy: name, err }, 'Failed to stop strategy');
      return reply.status(500).send({
        error: err instanceof Error ? err.message : 'Failed to stop strategy',
      });
    }
  });

  app.patch<{
    Params: { name: string };
    Body: unknown;
  }>('/api/strategies/:name/config', async (request, reply) => {
    const { name } = request.params;

    // 1. Validate incoming config with existing Zod discriminated union schema
    const parseResult = strategyConfigSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Invalid strategy config',
        details: parseResult.error.issues.map(i => `${i.path.join('.')}: ${i.message}`),
      });
    }
    const newConfig = parseResult.data;

    // 2. Stop existing engine if running (graceful)
    const engines = deps.activationBridge.getActiveEngines();
    const handle = engines.get(name);
    if (handle) {
      try {
        await handle.stop();
      } catch (err) {
        log.warn({ strategy: name, err }, 'Error stopping engine before config reload');
      }
    }

    // 3. Restart with new config via engineFactory
    if (!deps.engineFactory) {
      return reply.status(503).send({ error: 'Engine factory not configured — hot-reload unavailable in standalone dashboard mode' });
    }

    try {
      const result = await deps.engineFactory(name, newConfig as Record<string, unknown>);
      log.info({ strategy: name, sessionId: result.sessionId }, 'Strategy config updated via hot-reload');
      return { success: true, sessionId: result.sessionId };
    } catch (err) {
      log.error({ strategy: name, err }, 'Failed to restart engine with new config');
      return reply.status(500).send({
        error: err instanceof Error ? err.message : 'Failed to restart strategy',
      });
    }
  });
}
