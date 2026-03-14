/**
 * Zod-validated configuration loading from environment variables.
 *
 * Loads .env via dotenv, maps env vars to a structured config object,
 * and validates with zod. Throws ConfigError on validation failure.
 */

import 'dotenv/config';
import { z } from 'zod';
import { ConfigError } from './errors.js';
import { intxConfigSchema } from '../perp/config.js';

const configSchema = z.object({
  coinbase: z.object({
    apiKeyName: z.string().min(1, 'COINBASE_API_KEY_NAME is required'),
    apiKeySecret: z.string().min(1, 'COINBASE_API_KEY_SECRET is required'),
  }),
  cryptoCompare: z.object({
    apiKey: z.string().default(''),
  }),
  database: z.object({
    path: z.string().default('./data/trading.db'),
  }),
  perpDatabase: z.object({
    path: z.string().default('./data/perp.db'),
  }),
  data: z.object({
    pairs: z
      .array(z.enum(['BTC-USD', 'ETH-USD']))
      .default(['BTC-USD', 'ETH-USD']),
    historyDays: z.number().int().positive().default(365),
  }),
  logging: z.object({
    level: z
      .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
      .default('info'),
  }),
  intx: intxConfigSchema,
});

export type Config = z.infer<typeof configSchema>;

/**
 * Load and validate configuration from environment variables.
 *
 * Env var mapping:
 * - COINBASE_API_KEY_NAME -> coinbase.apiKeyName (also reused as intx.apiKey for FCM)
 * - COINBASE_API_KEY_SECRET -> coinbase.apiKeySecret (also reused as intx.apiSecret for FCM)
 * - CRYPTOCOMPARE_API_KEY -> cryptoCompare.apiKey
 * - DB_PATH -> database.path
 * - TRADING_PAIRS -> data.pairs (comma-separated)
 * - HISTORY_DAYS -> data.historyDays (parsed as int)
 * - LOG_LEVEL -> logging.level
 * - FCM_ENABLED -> intx.enabled (default false)
 * - FCM_TESTNET -> intx.testnet (default false)
 * - PERP_MODE -> intx.perpMode (default 'none', options: 'none'|'paper'|'live')
 * - PERP_DB_PATH -> perpDatabase.path (default './data/perp.db')
 * (FCM reuses COINBASE_API_KEY_NAME / COINBASE_API_KEY_SECRET — no separate FCM keys needed)
 *
 * @throws ConfigError on validation failure
 */
export function loadConfig(): Config {
  const env = process.env;

  const rawConfig = {
    coinbase: {
      apiKeyName: env.COINBASE_API_KEY_NAME ?? '',
      apiKeySecret: env.COINBASE_API_KEY_SECRET ?? '',
    },
    cryptoCompare: {
      apiKey: env.CRYPTOCOMPARE_API_KEY ?? '',
    },
    database: {
      path: env.DB_PATH ?? './data/trading.db',
    },
    perpDatabase: {
      path: env.PERP_DB_PATH ?? './data/perp.db',
    },
    data: {
      pairs: env.TRADING_PAIRS
        ? env.TRADING_PAIRS.split(',').map((s) => s.trim())
        : ['BTC-USD', 'ETH-USD'],
      historyDays: env.HISTORY_DAYS ? parseInt(env.HISTORY_DAYS, 10) : 365,
    },
    logging: {
      level: env.LOG_LEVEL ?? 'info',
    },
    intx: {
      enabled: env.FCM_ENABLED === 'true',
      apiKey: env.COINBASE_API_KEY_NAME,
      apiSecret: env.COINBASE_API_KEY_SECRET,
      testnet: env.FCM_TESTNET === 'true',
      perpMode: env.PERP_MODE ?? 'none',
    },
  };

  const result = configSchema.safeParse(rawConfig);

  if (!result.success) {
    const formatted = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new ConfigError(`Configuration validation failed:\n${formatted}`);
  }

  return result.data;
}
