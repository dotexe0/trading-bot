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
} from './types.js';
