/**
 * Zod-validated configuration loading from environment variables.
 *
 * Loads .env via dotenv, maps env vars to a structured config object,
 * and validates with zod. Throws ConfigError on validation failure.
 */

import 'dotenv/config';
import { z } from 'zod';
import { ConfigError } from './errors.js';

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
});

export type Config = z.infer<typeof configSchema>;

/**
 * Load and validate configuration from environment variables.
 *
 * Env var mapping:
 * - COINBASE_API_KEY_NAME -> coinbase.apiKeyName
 * - COINBASE_API_KEY_SECRET -> coinbase.apiKeySecret
 * - CRYPTOCOMPARE_API_KEY -> cryptoCompare.apiKey
 * - DB_PATH -> database.path
 * - TRADING_PAIRS -> data.pairs (comma-separated)
 * - HISTORY_DAYS -> data.historyDays (parsed as int)
 * - LOG_LEVEL -> logging.level
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
    data: {
      pairs: env.TRADING_PAIRS
        ? env.TRADING_PAIRS.split(',').map((s) => s.trim())
        : ['BTC-USD', 'ETH-USD'],
      historyDays: env.HISTORY_DAYS ? parseInt(env.HISTORY_DAYS, 10) : 365,
    },
    logging: {
      level: env.LOG_LEVEL ?? 'info',
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
