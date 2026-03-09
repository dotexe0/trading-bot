/**
 * Zod schema for Coinbase International Exchange (INTX) configuration.
 *
 * Fail-fast validation: when INTX_ENABLED=true, all four credentials
 * (apiKey, apiSecret, apiPassphrase, portfolioId) are required.
 * Throws ConfigError-compatible Zod errors on missing fields.
 */

import { z } from 'zod';

export const intxConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    apiKey: z.string().optional(),
    apiSecret: z.string().optional(),
    apiPassphrase: z.string().optional(),
    portfolioId: z.string().optional(),
    testnet: z.boolean().default(false),
    liquidationSafetyThresholdPct: z.number().default(5.0),
    defaultMaintenanceMarginRate: z.string().default('0.0333'),
  })
  .refine(
    (data) =>
      !data.enabled ||
      (!!data.apiKey &&
        !!data.apiSecret &&
        !!data.apiPassphrase &&
        !!data.portfolioId),
    {
      message:
        'INTX_API_KEY, INTX_API_SECRET, INTX_API_PASSPHRASE, and INTX_PORTFOLIO_ID are required when INTX_ENABLED=true',
      path: ['apiKey'],
    },
  );

export type IntxConfig = z.infer<typeof intxConfigSchema>;
