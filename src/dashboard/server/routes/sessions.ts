/**
 * Session REST routes.
 *
 * GET /api/sessions -- combined live + paper sessions with mode discriminator
 * GET /api/sessions/:id -- single session by ID (tries live first, then paper)
 */

import type { FastifyInstance } from 'fastify';
import { createModuleLogger } from '../../../core/logger.js';
import type { RouteDeps } from '../index.js';
import { toApiSession, toApiPaperSession } from '../types.js';

const log = createModuleLogger('route-sessions');

export async function registerSessionRoutes(
  app: FastifyInstance,
  deps: RouteDeps,
): Promise<void> {
  app.get<{
    Querystring: { status?: string };
  }>('/api/sessions', async (request) => {
    const { status } = request.query;

    const liveSessions = deps.liveStateStore
      .listSessions(status)
      .map(toApiSession);

    const paperSessions = deps.sessionStore
      .listSessions(status)
      .map(toApiPaperSession);

    const all = [...liveSessions, ...paperSessions];
    // Most recent first so the current session appears at the top of the dashboard
    all.sort((a, b) => (b.startTime ?? 0) - (a.startTime ?? 0));
    return all;
  });

  app.get<{
    Params: { id: string };
  }>('/api/sessions/:id', async (request, reply) => {
    const { id } = request.params;

    // Try live store first
    const liveSession = deps.liveStateStore.getSession(id);
    if (liveSession) {
      return toApiSession(liveSession);
    }

    // Try paper store
    const paperSession = deps.sessionStore.getSession(id);
    if (paperSession) {
      return toApiPaperSession(paperSession);
    }

    return reply.status(404).send({ error: 'Session not found' });
  });
}
