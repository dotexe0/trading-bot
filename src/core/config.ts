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
    /**
     * History window (days) for native 1h/1D fetching. Separate from the 1m
     * `historyDays` because Coinbase retains coarse candles far longer; the
     * fetch walks back until empty, bounded by this generous cap. Default 3 years.
     */
    nativeHistoryDays: z.number().int().positive().default(1095),
  }),
  logging: z.object({
    level: z
      .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
      .default('info'),
  }),
  intx: intxConfigSchema,
  spotStrategyOverrides: z.object({
    rsiPeriod: z.number().int().positive().optional(),
    bbPeriod: z.number().int().positive().optional(),
    zScoreWindow: z.number().int().positive().optional(),
    feeDragMultiple: z.number().positive().default(2.0),
    feeDragAtrPeriod: z.number().int().positive().default(14),
    momentumBreakoutWindow: z.number().int().positive().optional(),
    momentumVolumeWindow: z.number().int().positive().optional(),
    momentumVolumeMultiplier: z.number().positive().optional(),
    /** Enable limit entry orders instead of market orders (default: false). */
    useLimitEntries: z.boolean().default(false),
    /** Offset below/above close price for limit entries (decimal, e.g. 0.001 = 0.1%). Default: 0.001. */
    limitEntryOffsetPct: z.number().min(0).max(0.05).default(0.001),
    /** Max time to wait for limit fill before fallback (ms). Default: 60000. */
    limitEntryTimeoutMs: z.number().int().positive().default(60000),
    /** Fall back to market order if limit times out. Default: true. */
    limitEntryFallbackToMarket: z.boolean().default(true),
  }).default({ feeDragMultiple: 2.0, feeDragAtrPeriod: 14, useLimitEntries: false, limitEntryOffsetPct: 0.001, limitEntryTimeoutMs: 60000, limitEntryFallbackToMarket: true }),
  preLiveGate: z.object({
    minTrades: z.number().int().min(0).default(20),
    minNetPnl: z.number().default(0),
    lookbackTrades: z.number().int().positive().optional(),
  }).default({ minTrades: 20, minNetPnl: 0 }),
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
 * - NATIVE_HISTORY_DAYS -> data.nativeHistoryDays (parsed as int, default 1095 = 3yr)
 * - LOG_LEVEL -> logging.level
 * - FCM_ENABLED -> intx.enabled (default false)
 * - FCM_TESTNET -> intx.testnet (default false)
 * - PERP_MODE -> intx.perpMode (default 'none', options: 'none'|'paper'|'live')
 * - PERP_DB_PATH -> perpDatabase.path (default './data/perp.db')
 * (FCM reuses COINBASE_API_KEY_NAME / COINBASE_API_KEY_SECRET — no separate FCM keys needed)
 *
 * Spot strategy overrides (all optional — omit to use built-in Zod defaults):
 * - SPOT_RSI_PERIOD -> spotStrategyOverrides.rsiPeriod
 * - SPOT_BB_PERIOD -> spotStrategyOverrides.bbPeriod
 * - SPOT_ZSCORE_WINDOW -> spotStrategyOverrides.zScoreWindow
 * - SPOT_FEE_DRAG_MULTIPLE -> spotStrategyOverrides.feeDragMultiple (default 2.0)
 * - SPOT_FEE_DRAG_ATR_PERIOD -> spotStrategyOverrides.feeDragAtrPeriod (default 14)
 * - SPOT_MOMENTUM_BREAKOUT_WINDOW -> spotStrategyOverrides.momentumBreakoutWindow (default 10)
 * - SPOT_MOMENTUM_VOLUME_WINDOW -> spotStrategyOverrides.momentumVolumeWindow (default 10)
 * - SPOT_MOMENTUM_VOLUME_MULTIPLIER -> spotStrategyOverrides.momentumVolumeMultiplier (default 1.5)
 * - SPOT_USE_LIMIT_ENTRIES -> spotStrategyOverrides.useLimitEntries (default false)
 * - SPOT_LIMIT_ENTRY_OFFSET_PCT -> spotStrategyOverrides.limitEntryOffsetPct (default 0.001 = 0.1%)
 * - SPOT_LIMIT_ENTRY_TIMEOUT_MS -> spotStrategyOverrides.limitEntryTimeoutMs (default 60000)
 * - SPOT_LIMIT_ENTRY_FALLBACK -> spotStrategyOverrides.limitEntryFallbackToMarket (default true)
 *
 * Pre-live gate thresholds (all optional — omit to use built-in Zod defaults):
 * - GATE_MIN_TRADES -> preLiveGate.minTrades (default 20)
 * - GATE_MIN_NET_PNL -> preLiveGate.minNetPnl (default 0)
 * - GATE_LOOKBACK_TRADES -> preLiveGate.lookbackTrades (optional, limit to last N trades)
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
      nativeHistoryDays: env.NATIVE_HISTORY_DAYS
        ? parseInt(env.NATIVE_HISTORY_DAYS, 10)
        : 1095,
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
    spotStrategyOverrides: {
      rsiPeriod: env.SPOT_RSI_PERIOD ? parseInt(env.SPOT_RSI_PERIOD, 10) : undefined,
      bbPeriod: env.SPOT_BB_PERIOD ? parseInt(env.SPOT_BB_PERIOD, 10) : undefined,
      zScoreWindow: env.SPOT_ZSCORE_WINDOW ? parseInt(env.SPOT_ZSCORE_WINDOW, 10) : undefined,
      feeDragMultiple: env.SPOT_FEE_DRAG_MULTIPLE ? parseFloat(env.SPOT_FEE_DRAG_MULTIPLE) : undefined,
      feeDragAtrPeriod: env.SPOT_FEE_DRAG_ATR_PERIOD ? parseInt(env.SPOT_FEE_DRAG_ATR_PERIOD, 10) : undefined,
      momentumBreakoutWindow: env.SPOT_MOMENTUM_BREAKOUT_WINDOW ? parseInt(env.SPOT_MOMENTUM_BREAKOUT_WINDOW, 10) : undefined,
      momentumVolumeWindow: env.SPOT_MOMENTUM_VOLUME_WINDOW ? parseInt(env.SPOT_MOMENTUM_VOLUME_WINDOW, 10) : undefined,
      momentumVolumeMultiplier: env.SPOT_MOMENTUM_VOLUME_MULTIPLIER ? parseFloat(env.SPOT_MOMENTUM_VOLUME_MULTIPLIER) : undefined,
      useLimitEntries: env.SPOT_USE_LIMIT_ENTRIES === 'true' ? true : undefined,
      limitEntryOffsetPct: env.SPOT_LIMIT_ENTRY_OFFSET_PCT ? parseFloat(env.SPOT_LIMIT_ENTRY_OFFSET_PCT) : undefined,
      limitEntryTimeoutMs: env.SPOT_LIMIT_ENTRY_TIMEOUT_MS ? parseInt(env.SPOT_LIMIT_ENTRY_TIMEOUT_MS, 10) : undefined,
      limitEntryFallbackToMarket: env.SPOT_LIMIT_ENTRY_FALLBACK === 'false' ? false : undefined,
    },
    preLiveGate: {
      minTrades: env.GATE_MIN_TRADES ? parseInt(env.GATE_MIN_TRADES, 10) : undefined,
      minNetPnl: env.GATE_MIN_NET_PNL ? parseFloat(env.GATE_MIN_NET_PNL) : undefined,
      lookbackTrades: env.GATE_LOOKBACK_TRADES ? parseInt(env.GATE_LOOKBACK_TRADES, 10) : undefined,
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
