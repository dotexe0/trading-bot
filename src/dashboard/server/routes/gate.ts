/**
 * Gate REST routes.
 *
 * GET /api/gate/status -- pre-live gate check result with paper track record,
 * risk config, and fee tier information.
 */

import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from '../index.js';
import { PreLiveGate } from '../../../risk/pre-live-gate.js';
import { DEFAULT_FEE_TAKER } from '../../../backtest/types.js';

export async function registerGateRoutes(
  app: FastifyInstance,
  deps: RouteDeps,
): Promise<void> {
  app.get('/api/gate/status', async () => {
    const gateConfig = deps.gateConfig ?? { minTrades: 20, minNetPnl: 0 };

    const gate = new PreLiveGate({
      sessionStore: deps.sessionStore,
      perpStateStore: deps.perpStateStore,
      minTrades: gateConfig.minTrades,
      minNetPnl: gateConfig.minNetPnl,
      lookbackTrades: gateConfig.lookbackTrades,
    });

    const result = gate.check('both');

    // Risk config from risk manager (same pattern as routes/risk.ts)
    const riskConfig: {
      maxDrawdownPct?: number;
      maxExposurePct?: number;
      maxDailyLossPct?: number;
      maxPositionCount?: number;
    } = {};

    if (deps.riskManager) {
      const state = deps.riskManager.getCurrentRiskState();
      riskConfig.maxDrawdownPct = state.thresholds.maxDrawdownPct;
      riskConfig.maxExposurePct = state.thresholds.maxExposurePct;
      riskConfig.maxDailyLossPct = state.thresholds.maxDailyLossPct;
      riskConfig.maxPositionCount = state.thresholds.maxPositionCount;
    }

    // Fee config: spot taker from API fetch (falls back to DEFAULT_FEE_TAKER)
    const feeConfig: {
      spotTakerRate: number;
      spotFeeSource?: string;
      perpTakerRate?: number;
      perpFeeSource?: string;
    } = {
      spotTakerRate: deps.spotFeeConfig?.takerFeeRate ?? DEFAULT_FEE_TAKER,
      spotFeeSource: deps.spotFeeConfig?.source,
    };

    if (deps.feeConfig) {
      feeConfig.perpTakerRate = deps.feeConfig.takerFeeRate;
      feeConfig.perpFeeSource = deps.feeConfig.source;
    }

    return {
      passed: result.passed,
      spotTradeCount: result.spotTradeCount,
      perpTradeCount: result.perpTradeCount,
      totalTradeCount: result.totalTradeCount,
      spotNetPnl: result.spotNetPnl,
      perpNetPnl: result.perpNetPnl,
      totalNetPnl: result.totalNetPnl,
      spotWinRate: result.spotWinRate,
      perpWinRate: result.perpWinRate,
      failReasons: result.failReasons,
      config: {
        minTrades: gateConfig.minTrades,
        minNetPnl: gateConfig.minNetPnl,
        lookbackTrades: gateConfig.lookbackTrades,
      },
      riskConfig,
      feeConfig,
    };
  });
}
