/**
 * Risk REST routes.
 *
 * GET /api/risk -- current risk status with circuit breaker state and thresholds
 * GET /api/risk/events -- placeholder for recent circuit breaker events
 */

import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from '../index.js';
import type { ApiRiskStatus } from '../types.js';

export async function registerRiskRoutes(
  app: FastifyInstance,
  deps: RouteDeps,
): Promise<void> {
  app.get('/api/risk', async (): Promise<ApiRiskStatus> => {
    const cbState = deps.riskManager
      ? deps.riskManager.getCircuitBreakerState()
      : { tripped: false };

    return {
      circuitBreakerTripped: cbState.tripped,
      thresholds: {},
    };
  });

  app.get('/api/risk/events', async () => {
    // Risk events log is not currently persisted by the RiskManager.
    // Return empty array; future enhancement can add event persistence.
    return [];
  });
}
