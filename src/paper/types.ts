/**
 * Paper trading type system.
 *
 * Defines PaperTradingConfig, PaperSession, PaperTradingResult,
 * and LiveDataFeedEvents. Reuses Trade and EquityPoint from backtest.
 */

import type { Decimal } from 'decimal.js';
import type { TradingPair, Timeframe, Candle } from '../core/types.js';
import type { Trade, EquityPoint } from '../backtest/types.js';
import type { RiskConfig } from '../risk/types.js';
import type { z } from 'zod';
import type { paperConfigSchema } from './config.js';

// ── Paper Trading Config (Zod-inferred) ─────────────────────────────

/** Validated paper trading configuration, inferred from Zod schema. */
export type PaperTradingConfig = z.infer<typeof paperConfigSchema>;

// ── Session ─────────────────────────────────────────────────────────

/** A paper trading session record. */
export interface PaperSession {
  /** Unique session identifier */
  id: string;
  /** Configuration used for this session */
  config: PaperTradingConfig;
  /** Strategy name */
  strategyName: string;
  /** Trading pair */
  pair: TradingPair;
  /** Candle timeframe */
  timeframe: Timeframe;
  /** Session start time (Unix ms) */
  startTime: number;
  /** Session end time (Unix ms), undefined while running */
  endTime?: number;
  /** Initial capital as string for precision */
  initialCapital: string;
  /** Final equity as string, undefined while running */
  finalEquity?: string;
  /** Session status */
  status: 'running' | 'stopped' | 'error';
}

// ── Paper Trading Result ────────────────────────────────────────────

/** Complete result from a paper trading session. */
export interface PaperTradingResult {
  /** The session metadata */
  session: PaperSession;
  /** Completed round-trip trades (same Trade type as backtest) */
  trades: Trade[];
  /** Equity curve over time (same EquityPoint type as backtest) */
  equityCurve: EquityPoint[];
  /** Final portfolio equity */
  finalEquity: Decimal;
  /** Total fees paid across all trades */
  totalFees: Decimal;
}

// ── LiveDataFeed Events ─────────────────────────────────────────────

/** Typed events for the LiveDataFeed EventEmitter. */
export interface LiveDataFeedEvents {
  candle: [Candle];
  /** Fires on every successful REST poll per pair — even when the candle is deduplicated.
   *  Used by FeedHealthMonitor to track pipeline liveness independent of candle cadence. */
  polled: [TradingPair];
  wsError: [Error];
  connected: [];
  disconnected: [];
  reconnected: [];
}
