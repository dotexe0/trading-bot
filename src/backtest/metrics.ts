/**
 * MetricsCalculator -- computes performance metrics from backtest results.
 *
 * All 6 required metrics: Sharpe ratio, max drawdown, win rate,
 * profit factor, CAGR, and total return. Plus auxiliary stats.
 *
 * Financial metrics use Decimal precision. Sharpe ratio uses native Number
 * for statistical calculations (acceptable per research).
 */

import { d, ZERO, Decimal } from '../core/decimal.js';
import type { BacktestResult, Trade, EquityPoint, RegimeBreakdown } from './types.js';
import { MarketRegime } from '../regime/types.js';

/** Complete performance metrics from a backtest run. */
export interface PerformanceMetrics {
  /** (finalEquity - initialCapital) / initialCapital */
  totalReturn: Decimal;
  /** Compound annual growth rate: (end/start)^(365/days) - 1 */
  cagr: Decimal;
  /** Annualized Sharpe ratio using sqrt(365) for 24/7 crypto */
  sharpeRatio: number;
  /** Peak-to-trough absolute decline */
  maxDrawdown: Decimal;
  /** Max drawdown as percentage of peak */
  maxDrawdownPct: Decimal;
  /** Winning trades / total trades */
  winRate: Decimal;
  /** Gross profit / abs(gross loss) */
  profitFactor: Decimal;
  /** Number of completed round-trip trades */
  totalTrades: number;
  /** Total fees paid */
  totalFees: Decimal;
  /** Accumulated funding cost (perp only; ZERO for spot backtests) — NEVER add to totalFees */
  fundingCost: Decimal;
  /** Average PnL per trade / avg entry cost */
  avgTradeReturn: Decimal;
  /** Highest single-trade PnL */
  bestTrade: Decimal;
  /** Lowest single-trade PnL */
  worstTrade: Decimal;
}

export class MetricsCalculator {
  /**
   * Calculate all performance metrics from a backtest result.
   *
   * @param result - Complete backtest result with trades and equity curve
   * @param initialCapital - Starting capital as string (Decimal precision)
   * @returns PerformanceMetrics with all computed values
   */
  calculate(result: BacktestResult, initialCapital: string): PerformanceMetrics {
    const capital = d(initialCapital);
    const finalEquity = result.finalEquity;
    const trades = result.trades;
    const equityCurve = result.equityCurve;

    return {
      totalReturn: this.calcTotalReturn(finalEquity, capital),
      cagr: this.calcCAGR(finalEquity, capital, result.startTimestamp, result.endTimestamp),
      sharpeRatio: this.calcSharpeRatio(equityCurve),
      maxDrawdown: this.calcMaxDrawdown(equityCurve).absolute,
      maxDrawdownPct: this.calcMaxDrawdown(equityCurve).percentage,
      winRate: this.calcWinRate(trades),
      profitFactor: this.calcProfitFactor(trades),
      totalTrades: trades.length,
      totalFees: result.totalFees,
      fundingCost: result.fundingCost,
      avgTradeReturn: this.calcAvgTradeReturn(trades),
      bestTrade: this.calcBestTrade(trades),
      worstTrade: this.calcWorstTrade(trades),
    };
  }

  // ── Private calculation methods ──────────────────────────────────────

  private calcTotalReturn(finalEquity: Decimal, initialCapital: Decimal): Decimal {
    if (initialCapital.isZero()) return ZERO;
    return finalEquity.minus(initialCapital).div(initialCapital);
  }

  private calcCAGR(
    finalEquity: Decimal,
    initialCapital: Decimal,
    startTimestamp: number,
    endTimestamp: number,
  ): Decimal {
    const days = (endTimestamp - startTimestamp) / 86400000;
    if (days <= 0 || initialCapital.lte(ZERO)) return ZERO;
    if (finalEquity.lte(ZERO)) return d(-1); // Total loss

    const ratio = finalEquity.div(initialCapital);
    // CAGR = ratio^(365/days) - 1
    const exponent = d(365).div(d(days));
    return ratio.pow(exponent).minus(d(1));
  }

  private calcSharpeRatio(equityCurve: EquityPoint[]): number {
    if (equityCurve.length < 2) return 0;

    // Resample to daily: take last equity point of each UTC day
    const dailyEquity = this.resampleDaily(equityCurve);
    if (dailyEquity.length < 2) return 0;

    // Calculate daily returns as native Numbers
    const dailyReturns: number[] = [];
    for (let i = 1; i < dailyEquity.length; i++) {
      const prev = dailyEquity[i - 1];
      const curr = dailyEquity[i];
      if (prev === 0) continue;
      dailyReturns.push((curr - prev) / prev);
    }

    if (dailyReturns.length < 2) return 0;

    // Mean
    const sum = dailyReturns.reduce((a, b) => a + b, 0);
    const mean = sum / dailyReturns.length;

    // Sample variance (N-1 denominator)
    const squaredDiffs = dailyReturns.reduce((acc, r) => acc + (r - mean) ** 2, 0);
    const variance = squaredDiffs / (dailyReturns.length - 1);
    const stdDev = Math.sqrt(variance);

    if (stdDev === 0) return 0;

    // Annualize with sqrt(365) for 24/7 crypto markets
    return (mean / stdDev) * Math.sqrt(365);
  }

  private calcMaxDrawdown(equityCurve: EquityPoint[]): {
    absolute: Decimal;
    percentage: Decimal;
  } {
    if (equityCurve.length === 0) {
      return { absolute: ZERO, percentage: ZERO };
    }

    let peak = equityCurve[0].equity;
    let maxDD = ZERO;
    let maxDDPct = ZERO;

    for (const point of equityCurve) {
      if (point.equity.gt(peak)) {
        peak = point.equity;
      }
      const drawdown = peak.minus(point.equity);
      if (drawdown.gt(maxDD)) {
        maxDD = drawdown;
        maxDDPct = peak.isZero() ? ZERO : drawdown.div(peak);
      }
    }

    return { absolute: maxDD, percentage: maxDDPct };
  }

  private calcWinRate(trades: Trade[]): Decimal {
    if (trades.length === 0) return ZERO;
    const wins = trades.filter((t) => t.pnl.gt(ZERO)).length;
    return d(wins).div(d(trades.length));
  }

  private calcProfitFactor(trades: Trade[]): Decimal {
    if (trades.length === 0) return ZERO;

    let grossProfit = ZERO;
    let grossLoss = ZERO;

    for (const trade of trades) {
      if (trade.pnl.gt(ZERO)) {
        grossProfit = grossProfit.plus(trade.pnl);
      } else if (trade.pnl.lt(ZERO)) {
        grossLoss = grossLoss.plus(trade.pnl.abs());
      }
    }

    if (grossLoss.isZero()) {
      return grossProfit.gt(ZERO) ? d(999) : ZERO;
    }

    return grossProfit.div(grossLoss);
  }

  private calcAvgTradeReturn(trades: Trade[]): Decimal {
    if (trades.length === 0) return ZERO;

    let totalPnl = ZERO;
    let totalEntryCost = ZERO;

    for (const trade of trades) {
      totalPnl = totalPnl.plus(trade.pnl);
      totalEntryCost = totalEntryCost.plus(
        trade.entryFill.quantity.mul(trade.entryFill.fillPrice),
      );
    }

    if (totalEntryCost.isZero()) return ZERO;
    return totalPnl.div(d(trades.length)).div(totalEntryCost.div(d(trades.length)));
  }

  private calcBestTrade(trades: Trade[]): Decimal {
    if (trades.length === 0) return ZERO;
    return trades.reduce(
      (best, t) => (t.pnl.gt(best) ? t.pnl : best),
      trades[0].pnl,
    );
  }

  private calcWorstTrade(trades: Trade[]): Decimal {
    if (trades.length === 0) return ZERO;
    return trades.reduce(
      (worst, t) => (t.pnl.lt(worst) ? t.pnl : worst),
      trades[0].pnl,
    );
  }

  /**
   * Calculate per-regime performance breakdown from a regime-aware backtest.
   *
   * @param regimePerCandle - Map of candle timestamp -> MarketRegime
   * @param trades - Completed trades from the backtest
   * @param totalCandles - Total number of candles in the backtest (for timePct)
   * @returns Array of RegimeBreakdown sorted by MarketRegime enum order
   */
  calculateRegimeBreakdown(
    regimePerCandle: Map<number, MarketRegime>,
    trades: Trade[],
    totalCandles: number,
  ): RegimeBreakdown[] {
    // Count candles per regime
    const candleCount = new Map<MarketRegime, number>([
      [MarketRegime.TRENDING, 0],
      [MarketRegime.RANGING, 0],
      [MarketRegime.VOLATILE, 0],
    ]);

    for (const regime of regimePerCandle.values()) {
      candleCount.set(regime, (candleCount.get(regime) ?? 0) + 1);
    }

    // Sorted timestamps for nearest-prior lookup
    const sortedTimestamps = Array.from(regimePerCandle.keys()).sort((a, b) => a - b);

    // Group trades by their entry regime
    const tradesByRegime = new Map<MarketRegime, Trade[]>([
      [MarketRegime.TRENDING, []],
      [MarketRegime.RANGING, []],
      [MarketRegime.VOLATILE, []],
    ]);

    for (const trade of trades) {
      const entryTs = trade.entryFill.fillTimestamp;

      // Exact match first
      let regime = regimePerCandle.get(entryTs);

      // If no exact match, find the closest prior timestamp
      if (regime === undefined) {
        let lo = 0;
        let hi = sortedTimestamps.length - 1;
        let best: number | undefined;

        while (lo <= hi) {
          const mid = (lo + hi) >>> 1;
          if (sortedTimestamps[mid] <= entryTs) {
            best = sortedTimestamps[mid];
            lo = mid + 1;
          } else {
            hi = mid - 1;
          }
        }

        if (best !== undefined) {
          regime = regimePerCandle.get(best);
        }
      }

      if (regime !== undefined) {
        const bucket = tradesByRegime.get(regime);
        if (bucket) bucket.push(trade);
      }
    }

    // Build breakdown for each regime (enum order: TRENDING, RANGING, VOLATILE)
    const orderedRegimes = [MarketRegime.TRENDING, MarketRegime.RANGING, MarketRegime.VOLATILE];
    const result: RegimeBreakdown[] = [];

    for (const regime of orderedRegimes) {
      const count = candleCount.get(regime) ?? 0;
      if (count === 0) continue;

      const regimeTrades = tradesByRegime.get(regime) ?? [];
      const tradeCount = regimeTrades.length;

      const winRate =
        tradeCount === 0
          ? 0
          : regimeTrades.filter((t) => t.pnl.gt(ZERO)).length / tradeCount;

      // Compute Sharpe from per-trade pnlPct returns
      let sharpeRatio = 0;
      if (tradeCount >= 2) {
        const returns = regimeTrades.map((t) => t.pnlPct.toNumber());
        const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
        const variance =
          returns.reduce((acc, r) => acc + (r - mean) ** 2, 0) / (returns.length - 1);
        const stdDev = Math.sqrt(variance);
        if (stdDev > 0) {
          sharpeRatio = (mean / stdDev) * Math.sqrt(365);
        }
      }

      result.push({
        regime,
        timePct: count / totalCandles,
        tradeCount,
        winRate,
        sharpeRatio,
      });
    }

    return result;
  }

  /**
   * Resample equity curve to daily values (last point of each UTC day).
   * Returns equity values as native Numbers for Sharpe calculation.
   */
  private resampleDaily(equityCurve: EquityPoint[]): number[] {
    if (equityCurve.length === 0) return [];

    const dailyMap = new Map<string, number>();

    for (const point of equityCurve) {
      const dayKey = new Date(point.timestamp).toISOString().slice(0, 10);
      dailyMap.set(dayKey, point.equity.toNumber());
    }

    // Return in chronological order
    const sortedKeys = [...dailyMap.keys()].sort();
    return sortedKeys.map((k) => dailyMap.get(k)!);
  }
}
