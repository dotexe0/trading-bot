/**
 * PreLiveGate -- pre-live activation safety gate.
 *
 * Prevents live trading activation (PERP_MODE=live or --mode live) unless
 * paper trading has demonstrated profitability. Reads paper trade history
 * from SQLite, computes cumulative net P&L, and fails fast with a clear
 * error message before any engine is initialized.
 *
 * Satisfies: GATE-01
 */

import { d, ZERO } from '../core/decimal.js';
import type Decimal from 'decimal.js';
import { createModuleLogger } from '../core/logger.js';
import type { SessionStore } from '../paper/session-store.js';
import type { PerpStateStore, PerpTradeRecord } from '../perp/perp-state-store.js';
import type { Trade } from '../backtest/types.js';

const log = createModuleLogger('pre-live-gate');

/** Options for PreLiveGate constructor. */
export interface PreLiveGateOptions {
  /** SessionStore instance for reading spot paper trades. */
  sessionStore: SessionStore;
  /** PerpStateStore instance for reading perp paper trades (optional for spot-only). */
  perpStateStore?: PerpStateStore;
  /** Minimum number of completed paper trades required. */
  minTrades: number;
  /** Minimum cumulative net P&L threshold (in quote currency). */
  minNetPnl: number;
  /** If set, only consider the last N trades (most recent). */
  lookbackTrades?: number;
}

/** Result of a PreLiveGate check. */
export interface PreLiveGateResult {
  /** Whether the gate passed (all thresholds met). */
  passed: boolean;
  /** Number of spot paper trades considered. */
  spotTradeCount: number;
  /** Number of perp paper trades considered. */
  perpTradeCount: number;
  /** Total paper trades considered (spot + perp). */
  totalTradeCount: number;
  /** Cumulative spot net P&L as string. */
  spotNetPnl: string;
  /** Cumulative perp net P&L as string. */
  perpNetPnl: string;
  /** Combined net P&L as string. */
  totalNetPnl: string;
  /** Spot win rate (0-1). */
  spotWinRate: number;
  /** Perp win rate (0-1). */
  perpWinRate: number;
  /** Human-readable reasons the gate failed (empty if passed). */
  failReasons: string[];
}

export class PreLiveGate {
  private readonly sessionStore: SessionStore;
  private readonly perpStateStore?: PerpStateStore;
  private readonly minTrades: number;
  private readonly minNetPnl: number;
  private readonly lookbackTrades?: number;

  constructor(options: PreLiveGateOptions) {
    this.sessionStore = options.sessionStore;
    this.perpStateStore = options.perpStateStore;
    this.minTrades = options.minTrades;
    this.minNetPnl = options.minNetPnl;
    this.lookbackTrades = options.lookbackTrades;
  }

  /**
   * Check whether live trading should be permitted based on paper trade history.
   *
   * @param mode - Which markets to check: 'spot', 'perp', or 'both'
   * @returns PreLiveGateResult with pass/fail status and details
   */
  check(mode: 'spot' | 'perp' | 'both'): PreLiveGateResult {
    let spotTrades: Trade[] = [];
    let perpTrades: PerpTradeRecord[] = [];

    // ── Gather spot trades ────────────────────────────────────────────
    if (mode === 'spot' || mode === 'both') {
      const sessions = this.sessionStore.listSessions();
      const allSpotTrades: Trade[] = [];
      for (const session of sessions) {
        const trades = this.sessionStore.getSessionTrades(session.id);
        for (const trade of trades) {
          // Only count trades with a non-null pnl
          if (trade.pnl !== null && trade.pnl !== undefined) {
            allSpotTrades.push(trade);
          }
        }
      }

      // Sort by entry timestamp descending (most recent first)
      allSpotTrades.sort((a, b) => b.entryFill.fillTimestamp - a.entryFill.fillTimestamp);

      // Apply lookback limit
      if (this.lookbackTrades !== undefined) {
        spotTrades = allSpotTrades.slice(0, this.lookbackTrades);
      } else {
        spotTrades = allSpotTrades;
      }
    }

    // ── Gather perp trades ────────────────────────────────────────────
    if ((mode === 'perp' || mode === 'both') && this.perpStateStore) {
      const allPerpTrades = this.perpStateStore.listClosedTrades();
      // listClosedTrades returns records sorted by close time from the store

      if (this.lookbackTrades !== undefined) {
        // Take the last N trades (most recent = end of array)
        perpTrades = allPerpTrades.slice(-this.lookbackTrades);
      } else {
        perpTrades = allPerpTrades;
      }
    }

    // ── Compute spot stats ────────────────────────────────────────────
    let spotNetPnl: Decimal = ZERO;
    let spotWins = 0;
    for (const trade of spotTrades) {
      spotNetPnl = spotNetPnl.plus(trade.pnl);
      if (trade.pnl.gt(ZERO)) spotWins++;
    }
    const spotWinRate = spotTrades.length > 0 ? spotWins / spotTrades.length : 0;

    // ── Compute perp stats ────────────────────────────────────────────
    let perpNetPnl: Decimal = ZERO;
    let perpWins = 0;
    for (const trade of perpTrades) {
      const pnl = d(trade.realizedPnl);
      perpNetPnl = perpNetPnl.plus(pnl);
      if (pnl.gt(ZERO)) perpWins++;
    }
    const perpWinRate = perpTrades.length > 0 ? perpWins / perpTrades.length : 0;

    // ── Combined totals ───────────────────────────────────────────────
    const totalTradeCount = spotTrades.length + perpTrades.length;
    const totalNetPnl = spotNetPnl.plus(perpNetPnl);

    // ── Build fail reasons ────────────────────────────────────────────
    const failReasons: string[] = [];

    if (totalTradeCount < this.minTrades) {
      failReasons.push(
        `Insufficient paper trades: ${totalTradeCount} completed, minimum ${this.minTrades} required`,
      );
    }

    if (totalNetPnl.lt(d(String(this.minNetPnl)))) {
      failReasons.push(
        `Paper net P&L $${totalNetPnl.toFixed(2)} below minimum threshold $${this.minNetPnl}`,
      );
    }

    const passed = failReasons.length === 0;

    const result: PreLiveGateResult = {
      passed,
      spotTradeCount: spotTrades.length,
      perpTradeCount: perpTrades.length,
      totalTradeCount,
      spotNetPnl: spotNetPnl.toFixed(2),
      perpNetPnl: perpNetPnl.toFixed(2),
      totalNetPnl: totalNetPnl.toFixed(2),
      spotWinRate,
      perpWinRate,
      failReasons,
    };

    if (passed) {
      log.info(
        {
          totalTradeCount,
          totalNetPnl: totalNetPnl.toFixed(2),
          spotWinRate: spotWinRate.toFixed(4),
          perpWinRate: perpWinRate.toFixed(4),
          event: 'pre-live-gate-passed',
        },
        'Pre-live gate PASSED',
      );
    } else {
      log.warn(
        {
          totalTradeCount,
          totalNetPnl: totalNetPnl.toFixed(2),
          failReasons,
          event: 'pre-live-gate-failed',
        },
        'Pre-live gate FAILED',
      );
    }

    return result;
  }
}
