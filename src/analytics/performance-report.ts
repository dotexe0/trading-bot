/**
 * Shared performance analytics module.
 *
 * Provides a pure `computePerformanceReport()` function that takes
 * normalized Trade[] and returns win rate, avg win, avg loss, win/loss
 * ratio, profit factor, trade count, and top-N best/worst trade snapshots.
 *
 * Also provides normalization functions for converting store-specific
 * trade shapes (ApiBacktestTrade, LiveTrade) into the common Trade type.
 */

import { d, ZERO, type Decimal } from '../core/decimal.js';
import type { Trade, SimulatedFill } from '../backtest/types.js';
import type { ApiBacktestTrade } from '../backtest/backtest-store.js';
import type { LiveTrade } from '../live/types.js';
import type { Signal } from '../strategies/types.js';

// ── Report Types ────────────────────────────────────────────────────

/** A snapshot of a single trade for display purposes. */
export interface TradeSnapshot {
  entryTimestamp: number;
  exitTimestamp: number;
  pair: string;
  entryPrice: string;
  exitPrice: string;
  pnlPct: string;
  pnl: string;
}

/** Complete performance report computed from a set of trades. */
export interface PerformanceReport {
  /** Winning trades / total trades (0 if no trades) */
  winRate: Decimal;
  /** Average pnlPct of winning trades (ZERO if no winners) */
  avgWin: Decimal;
  /** Average pnlPct of losing trades (ZERO if no losers -- will be negative) */
  avgLoss: Decimal;
  /** |avgWin| / |avgLoss| (ZERO if no losers, d(999) if all winners) */
  winLossRatio: Decimal;
  /** Gross profit / |gross loss| (d(999) if no losers with positive profit, ZERO if no trades) */
  profitFactor: Decimal;
  /** Number of completed round-trip trades */
  tradeCount: number;
  /** Top N trades sorted by pnlPct descending */
  bestTrades: TradeSnapshot[];
  /** Top N trades sorted by pnlPct ascending */
  worstTrades: TradeSnapshot[];
}

// ── Core Function ───────────────────────────────────────────────────

/**
 * Compute a performance report from normalized trades.
 *
 * Pure function -- no DB access, no side effects.
 * Uses decimal.js for all math.
 *
 * @param trades - Array of normalized Trade objects
 * @param pair - Trading pair (needed because Trade doesn't carry pair)
 * @param topN - Number of best/worst trades to include (default 5)
 */
export function computePerformanceReport(
  trades: Trade[],
  pair: string,
  topN: number = 5,
): PerformanceReport {
  const tradeCount = trades.length;

  if (tradeCount === 0) {
    return {
      winRate: ZERO,
      avgWin: ZERO,
      avgLoss: ZERO,
      winLossRatio: ZERO,
      profitFactor: ZERO,
      tradeCount: 0,
      bestTrades: [],
      worstTrades: [],
    };
  }

  // Separate winners and losers
  const winners = trades.filter((t) => t.pnl.gt(ZERO));
  const losers = trades.filter((t) => t.pnl.lt(ZERO));

  // Win rate
  const winRate = d(winners.length).div(d(tradeCount));

  // Average win (by pnlPct)
  const avgWin =
    winners.length > 0
      ? winners.reduce((sum, t) => sum.plus(t.pnlPct), ZERO).div(d(winners.length))
      : ZERO;

  // Average loss (by pnlPct) -- will be negative
  const avgLoss =
    losers.length > 0
      ? losers.reduce((sum, t) => sum.plus(t.pnlPct), ZERO).div(d(losers.length))
      : ZERO;

  // Win/loss ratio: |avgWin| / |avgLoss|
  let winLossRatio: Decimal;
  if (avgLoss.isZero()) {
    winLossRatio = avgWin.gt(ZERO) ? d(999) : ZERO;
  } else {
    winLossRatio = avgWin.abs().div(avgLoss.abs());
  }

  // Profit factor: gross profit / |gross loss|
  // Follow the MetricsCalculator.calcProfitFactor pattern
  let grossProfit = ZERO;
  let grossLoss = ZERO;

  for (const trade of trades) {
    if (trade.pnl.gt(ZERO)) {
      grossProfit = grossProfit.plus(trade.pnl);
    } else if (trade.pnl.lt(ZERO)) {
      grossLoss = grossLoss.plus(trade.pnl.abs());
    }
  }

  let profitFactor: Decimal;
  if (grossLoss.isZero()) {
    profitFactor = grossProfit.gt(ZERO) ? d(999) : ZERO;
  } else {
    profitFactor = grossProfit.div(grossLoss);
  }

  // Best trades: sort by pnlPct descending, take topN
  const sortedDesc = [...trades].sort((a, b) =>
    b.pnlPct.minus(a.pnlPct).toNumber(),
  );
  const bestTrades = sortedDesc
    .slice(0, topN)
    .map((t) => tradeToSnapshot(t, pair));

  // Worst trades: sort by pnlPct ascending, take topN
  const sortedAsc = [...trades].sort((a, b) =>
    a.pnlPct.minus(b.pnlPct).toNumber(),
  );
  const worstTrades = sortedAsc
    .slice(0, topN)
    .map((t) => tradeToSnapshot(t, pair));

  return {
    winRate,
    avgWin,
    avgLoss,
    winLossRatio,
    profitFactor,
    tradeCount,
    bestTrades,
    worstTrades,
  };
}

// ── Normalization Functions ─────────────────────────────────────────

/**
 * Convert an ApiBacktestTrade (string fields from BacktestStore) into a Trade.
 *
 * IMPORTANT: Uses `t.signal` for entry direction, NOT `t.entrySide`.
 * The entrySide is the order side ('buy'/'sell') which does not correctly
 * map to direction for short trades.
 */
export function normalizeApiBacktestTrade(t: ApiBacktestTrade): Trade {
  const entrySignal: Signal = {
    strategyName: 'backtest',
    pair: 'BTC-USD',
    timeframe: '1h',
    timestamp: t.entryTimestamp,
    direction: t.signal as 'long' | 'short' | 'close',
    confidence: 1,
    reasoning: '',
  };

  const exitSignal: Signal = {
    strategyName: 'backtest',
    pair: 'BTC-USD',
    timeframe: '1h',
    timestamp: t.exitTimestamp,
    direction: 'close',
    confidence: 1,
    reasoning: '',
  };

  const entryFill: SimulatedFill = {
    signal: entrySignal,
    fillPrice: d(t.entryPrice),
    fillTimestamp: t.entryTimestamp,
    fee: d(t.entryFee),
    quantity: d(t.entryQuantity),
    side: t.entrySide as 'buy' | 'sell',
  };

  const exitFill: SimulatedFill = {
    signal: exitSignal,
    fillPrice: d(t.exitPrice),
    fillTimestamp: t.exitTimestamp,
    fee: d(t.exitFee),
    quantity: d(t.exitQuantity),
    side: t.exitSide as 'buy' | 'sell',
  };

  return {
    entryFill,
    exitFill,
    pnl: d(t.pnl),
    pnlPct: d(t.pnlPct),
    holdingPeriodMs: t.exitTimestamp - t.entryTimestamp,
  };
}

/**
 * Convert a LiveTrade into a Trade, or null if the trade is incomplete.
 *
 * Returns null for trades missing exitPrice, pnl, or pnlPct.
 */
export function normalizeLiveTrade(lt: LiveTrade): Trade | null {
  // Skip incomplete trades (no exit yet)
  if (!lt.exitPrice || !lt.pnl || !lt.pnlPct) return null;

  const entryFill: SimulatedFill = {
    signal: {
      strategyName: 'live',
      pair: 'BTC-USD',
      timeframe: '1h',
      timestamp: lt.entryTimestamp,
      direction: lt.entrySide === 'BUY' ? 'long' : 'short',
      confidence: 1,
      reasoning: '',
    },
    fillPrice: d(lt.entryPrice),
    fillTimestamp: lt.entryTimestamp,
    fee: d(lt.entryFee),
    quantity: d(lt.entryQuantity),
    side: lt.entrySide === 'BUY' ? 'buy' : 'sell',
  };

  const exitFill: SimulatedFill = {
    signal: {
      ...entryFill.signal,
      direction: 'close',
      timestamp: lt.exitTimestamp!,
    },
    fillPrice: d(lt.exitPrice),
    fillTimestamp: lt.exitTimestamp!,
    fee: d(lt.exitFee!),
    quantity: d(lt.exitQuantity!),
    side: lt.exitSide === 'BUY' ? 'buy' : 'sell',
  };

  return {
    entryFill,
    exitFill,
    pnl: d(lt.pnl),
    pnlPct: d(lt.pnlPct),
    holdingPeriodMs: lt.holdingPeriodMs ?? 0,
  };
}

// ── Private Helpers ─────────────────────────────────────────────────

function tradeToSnapshot(trade: Trade, pair: string): TradeSnapshot {
  return {
    entryTimestamp: trade.entryFill.fillTimestamp,
    exitTimestamp: trade.exitFill.fillTimestamp,
    pair,
    entryPrice: trade.entryFill.fillPrice.toString(),
    exitPrice: trade.exitFill.fillPrice.toString(),
    pnlPct: trade.pnlPct.toString(),
    pnl: trade.pnl.toString(),
  };
}
