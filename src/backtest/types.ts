/**
 * Backtest types and configuration schema.
 *
 * Defines BacktestConfig (Zod-validated), SimulatedFill, Trade (round-trip),
 * EquityPoint, and BacktestResult.
 */

import { z } from 'zod';
import type { Decimal } from 'decimal.js';
import type { TradingPair, Timeframe } from '../core/types.js';
import type { Signal } from '../strategies/types.js';
import type { MarketRegime } from '../regime/types.js';

// ── Fee tier constants ────────────────────────────────────────────────

/** Coinbase Advanced Trade fee tiers (maker / taker) */
export const COINBASE_FEE_TIERS = [
  { name: 'Intro 1', maker: 0.006, taker: 0.008 },
  { name: 'Intro 2', maker: 0.0035, taker: 0.0075 },
  { name: 'Intro 3', maker: 0.0025, taker: 0.007 },
  { name: 'Advanced 1', maker: 0.002, taker: 0.006 },
  { name: 'Advanced 2', maker: 0.001, taker: 0.004 },
  { name: 'Advanced 3', maker: 0.0, taker: 0.002 },
] as const;

/** Default fee rates: Coinbase VIP 4 tier (fetched live at startup via getTransactionSummary) */
export const DEFAULT_FEE_MAKER = 0.00025;
export const DEFAULT_FEE_TAKER = 0.00065;

// ── Zod schema for BacktestConfig ─────────────────────────────────────

export const backtestConfigSchema = z
  .object({
    pair: z.enum(['BTC-USD', 'ETH-USD']),
    timeframe: z.enum(['1m', '5m', '15m', '1h', '4h', '1D']),
    startMs: z.number().int().positive(),
    endMs: z.number().int().positive(),
    initialCapital: z.string().default('10000'),
    strategyConfig: z.record(z.string(), z.unknown()),
    slippageBps: z.number().min(0).max(100).default(5),
    feeTierMaker: z.number().min(0).max(0.1).default(DEFAULT_FEE_MAKER),
    feeTierTaker: z.number().min(0).max(0.1).default(DEFAULT_FEE_TAKER),
    assumeTaker: z.boolean().default(true),
    positionSizePct: z.number().min(0.01).max(1).default(0.95),
    allowShorts: z.boolean().default(true),
    additionalTimeframes: z
      .array(z.enum(['1m', '5m', '15m', '1h', '4h', '1D']))
      .optional(),
  })
  .refine((d) => d.startMs < d.endMs, {
    message: 'startMs must be less than endMs',
    path: ['startMs'],
  });

/** Validated BacktestConfig type */
export type BacktestConfig = z.infer<typeof backtestConfigSchema>;

/**
 * Parse and validate a raw backtest config.
 * Throws on invalid input with descriptive error messages.
 */
export function parseBacktestConfig(raw: unknown): BacktestConfig {
  const result = backtestConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map(
      (i) => `${i.path.join('.')}: ${i.message}`,
    );
    throw new Error(`Invalid backtest config: ${issues.join('; ')}`);
  }
  return result.data;
}

// ── Trade simulation types ────────────────────────────────────────────

/** Result of simulating a fill at a given price with slippage and fees. */
export interface SimulatedFill {
  /** The signal that triggered this fill */
  signal: Signal;
  /** Price after slippage adjustment */
  fillPrice: Decimal;
  /** Timestamp of the fill candle */
  fillTimestamp: number;
  /** Fee charged for this fill */
  fee: Decimal;
  /** Quantity filled */
  quantity: Decimal;
  /** Side of the fill */
  side: 'buy' | 'sell';
}

/** A completed round-trip trade (entry + exit). */
export interface Trade {
  /** The fill that opened this position */
  entryFill: SimulatedFill;
  /** The fill that closed this position */
  exitFill: SimulatedFill;
  /** Profit/loss in quote currency (Decimal) */
  pnl: Decimal;
  /** Profit/loss as percentage of entry cost */
  pnlPct: Decimal;
  /** Time held in milliseconds */
  holdingPeriodMs: number;
  /** Trade journal metadata (populated from DB, not set during backtest) */
  strategyName?: string;
  regimeAtEntry?: string;
  exitReason?: string;
}

/** A point on the equity curve. */
export interface EquityPoint {
  /** Candle timestamp */
  timestamp: number;
  /** Portfolio equity at this point */
  equity: Decimal;
}

/** Per-regime performance breakdown produced by regime-aware backtesting. */
export interface RegimeBreakdown {
  regime: MarketRegime;
  /** Percentage of total candles classified as this regime */
  timePct: number;
  /** Number of trades that entered during this regime */
  tradeCount: number;
  /** Sharpe ratio for trades in this regime (annualized, sqrt(365)) */
  sharpeRatio: number;
  /** Win rate for trades in this regime */
  winRate: number;
}

/** Complete result from running a backtest. */
export interface BacktestResult {
  /** The config used for this backtest */
  config: BacktestConfig;
  /** Completed round-trip trades */
  trades: Trade[];
  /** Equity curve over time */
  equityCurve: EquityPoint[];
  /** Final portfolio equity */
  finalEquity: Decimal;
  /** Total fees paid */
  totalFees: Decimal;
  /** Accumulated funding cost across all open positions (perp only; ZERO for spot backtests) */
  fundingCost: Decimal;
  /** Timestamp of first candle */
  startTimestamp: number;
  /** Timestamp of last candle */
  endTimestamp: number;
  /** Per-regime performance breakdown (populated when regime detection is active) */
  regimeBreakdown?: RegimeBreakdown[];
  /** Per-candle regime timeline for persistence (timestamp + regime label) */
  regimeTimeline?: { timestamp: number; regime: string }[];
}
