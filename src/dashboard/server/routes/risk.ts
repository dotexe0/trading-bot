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
    if (deps.riskManager) {
      const state = deps.riskManager.getCurrentRiskState();
      return {
        circuitBreakerTripped: state.circuitBreakerTripped,
        currentDrawdownPct: state.currentDrawdownPct,
        currentExposurePct: state.currentExposurePct,
        thresholds: {
          maxDrawdownPct: state.thresholds.maxDrawdownPct,
          maxExposurePct: state.thresholds.maxExposurePct,
          maxDailyLossPct: state.thresholds.maxDailyLossPct,
          maxPositionCount: state.thresholds.maxPositionCount,
        },
      };
    }

    return {
      circuitBreakerTripped: false,
      currentDrawdownPct: 0,
      currentExposurePct: 0,
      thresholds: {},
    };
  });

  app.get('/api/risk/events', async () => {
    // Risk events log is not currently persisted by the RiskManager.
    // Return empty array; future enhancement can add event persistence.
    return [];
  });
}
