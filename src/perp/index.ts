/**
 * Barrel export for the perp (perpetual futures) module.
 *
 * Imports from src/perp/intx-client.ts, src/perp/config.ts, src/perp/types.ts.
 */

export { IntxClient } from './intx-client.js';
export type { IntxConfig } from './config.js';
export { intxConfigSchema } from './config.js';
export type {
  IntxMarkPriceEvent,
  IntxFundingRateEvent,
  IntxClientEvents,
  IntxAccountState,
  PlaceOrderParams,
  CancelOrderParams,
} from './types.js';
