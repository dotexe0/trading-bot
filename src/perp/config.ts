/**
 * Zod schema for Coinbase FCM (Futures Commission Merchant) configuration.
 *
 * FCM is available to US users via the Advanced Trade API.
 * Uses the same credentials as spot trading (COINBASE_API_KEY_NAME / COINBASE_API_KEY_SECRET).
 *
 * Fail-fast validation: when FCM_ENABLED=true, apiKey and apiSecret are required.
 * Throws ConfigError-compatible Zod errors on missing fields.
 */

import { z } from 'zod';

export const fcmConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    apiKey: z.string().optional(),     // populated from COINBASE_API_KEY_NAME
    apiSecret: z.string().optional(),  // populated from COINBASE_API_KEY_SECRET
    testnet: z.boolean().default(false),
    btcProductId: z.string().default('BIP-20DEC30-CDE'),
    ethProductId: z.string().default('ETP-20DEC30-CDE'),
    liquidationSafetyThresholdPct: z.number().default(5.0),
    defaultMaintenanceMarginRate: z.string().default('0.0333'),
    tpTargetPct: z.number().default(2.0),
    atrMultiplier: z.number().default(2.0),
    stopLimitSlippagePct: z.number().default(0.1),
    repriceTimeoutMs: z.number().default(60000),
    maxRepriceAttempts: z.number().default(20),
    entryOrderTimeoutMs: z.number().default(300000),
    maxLeverageCap: z.number().int().min(1).max(20).default(5),
    defaultLeverage: z.number().int().min(1).max(20).default(3),
    /** Timeframe for scalping strategy tournament evaluation. Default '5m'. */
    scalpingTimeframe: z.enum(['1m', '5m']).default('5m'),
    leverageByRegime: z.object({
      VOLATILE: z.number().int().min(1).max(10).default(2),
      TRENDING: z.number().int().min(1).max(20).default(5),
      RANGING: z.number().int().min(1).max(10).default(3),
    }).default({ VOLATILE: 2, TRENDING: 5, RANGING: 3 }),
    marginUtilizationCeiling: z.number().min(0.1).max(1.0).default(0.8),
    perpExposureCapPct: z.number().min(0.1).max(1.0).default(0.5),
    perpMaxLossPct: z.number().min(0.001).max(0.2).default(0.02),
    fundingDrainThresholdPct: z.number().min(0.001).max(0.1).default(0.005),
    perpMode: z.enum(['paper', 'live', 'none']).default('none'),

    /** Max wall-clock seconds to wait for an entry fill before cancelling */
    orderMaxWaitSeconds: z.number().int().min(5).max(300).default(60),

    /** Max retries for a failed close order before triggering emergency close */
    orderCloseMaxRetries: z.number().int().min(1).max(10).default(3),

    /** Maximum cumulative daily realized loss in USD before blocking new entries.
     *  Resets at midnight UTC. Default $500 -- appropriate for $1K-$10K accounts. */
    maxDailyLossUsd: z.number().positive().default(500),

    /** Base position size in contracts (e.g. 0.01 BTC). Scaled by signal confidence. */
    basePositionSize: z.number().positive().default(0.01),
    /** Minimum confidence floor for position size scaling (0-1). At floor, size = floor * base. */
    confidenceFloor: z.number().min(0).max(1).default(0.3),
  })
  .refine(
    (data) => !data.enabled || (!!data.apiKey && !!data.apiSecret),
    {
      message: 'COINBASE_API_KEY_NAME and COINBASE_API_KEY_SECRET are required when FCM_ENABLED=true',
      path: ['apiKey'],
    },
  )
  .refine(
    (data) => data.perpMode === 'none' || data.enabled === true,
    {
      message: 'FCM_ENABLED=true is required when PERP_MODE is paper or live',
      path: ['perpMode'],
    },
  );

export type FcmConfig = z.infer<typeof fcmConfigSchema>;
// Backward-compat alias — existing code referencing IntxConfig still compiles
export type IntxConfig = FcmConfig;
export const intxConfigSchema = fcmConfigSchema;
