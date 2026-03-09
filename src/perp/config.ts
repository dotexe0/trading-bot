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
  })
  .refine(
    (data) => !data.enabled || (!!data.apiKey && !!data.apiSecret),
    {
      message: 'COINBASE_API_KEY_NAME and COINBASE_API_KEY_SECRET are required when FCM_ENABLED=true',
      path: ['apiKey'],
    },
  );

export type FcmConfig = z.infer<typeof fcmConfigSchema>;
// Backward-compat alias — existing code referencing IntxConfig still compiles
export type IntxConfig = FcmConfig;
export const intxConfigSchema = fcmConfigSchema;
