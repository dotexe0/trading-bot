/**
 * Barrel export for the perp (perpetual futures) module.
 *
 * Imports from src/perp/intx-client.ts, src/perp/config.ts, src/perp/types.ts,
 * src/perp/position-manager.ts, src/perp/perp-state-store.ts, src/perp/liquidation-calc.ts.
 */

export { IntxClient } from './intx-client.js';
export { PaperPerpEngine } from './paper-perp-engine.js';
export type { PaperPerpEngineOptions } from './paper-perp-engine.js';
export type { IntxConfig } from './config.js';
export { intxConfigSchema } from './config.js';
export { PerpPositionManager } from './position-manager.js';
export { PerpStateStore } from './perp-state-store.js';
export { calcLiquidationPrice, calcLiquidationDistance } from './liquidation-calc.js';
export { PerpOrderEngine } from './order-engine.js';
export { TrailingStopManager } from './trailing-stop.js';
export type { TrailingStopState } from './trailing-stop.js';
export { PerpRiskGate } from './perp-risk-gate.js';
export type { PerpRiskGateOptions } from './perp-risk-gate.js';
export { computeLeverage } from './leverage-sizer.js';
export type { LeverageConfig } from './leverage-sizer.js';
export { getMarginMode } from './margin-mode.js';
export type { MarginMode } from './margin-mode.js';
export { PerpMomentumStrategy, PerpMeanReversionStrategy, createPerpRegistry, createLivePerpRegistry } from './strategies/index.js';
export type {
  IntxMarkPriceEvent,
  IntxFundingRateEvent,
  IntxClientEvents,
  IntxAccountState,
  PlaceOrderParams,
  CancelOrderParams,
  PerpSession,
  PerpOrder,
  PerpDirection,
  PerpSessionStatus,
  PerpPositionManagerEvents,
  FcmOrderFillEvent,
  PerpOrderEngineEvents,
  RiskGateResult,
  PerpRiskGateParams,
} from './types.js';
