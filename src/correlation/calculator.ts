/**
 * CorrelationCalculator — pure Pearson correlation math kernel.
 *
 * Stateless class that computes the rolling Pearson correlation between
 * BTC-USD and ETH-USD log-returns from aligned candle arrays.
 *
 * Zero I/O — all inputs are plain arrays, all outputs are pure values.
 * No side effects, no database access, no external state.
 */

import { sampleCorrelation } from 'simple-statistics';
import type { Candle } from '../core/types.js';
import type { CorrelationSnapshot } from './types.js';

export class CorrelationCalculator {
  private readonly windowCandles: number;

  /**
   * @param windowCandles - Rolling window size in candles.
   *   Need windowCandles+1 aligned candles to produce windowCandles log-returns.
   *   Minimum practical value is 30; default config is 720 (30 days at 1h).
   */
  constructor(windowCandles: number) {
    this.windowCandles = windowCandles;
  }

  /**
   * Compute rolling Pearson correlation from aligned BTC and ETH candles.
   *
   * Returns null (never throws) when:
   * - Either array is empty
   * - Fewer than windowCandles+1 aligned (same-timestamp) candles exist
   * - The price series is constant (zero variance → sampleCorrelation throws)
   * - sampleCorrelation returns a non-finite value (NaN, Infinity)
   * - Any other computation error
   *
   * @param btcCandles - BTC-USD candles sorted ascending by timestamp
   * @param ethCandles - ETH-USD candles sorted ascending by timestamp
   * @returns CorrelationSnapshot or null if insufficient/degenerate data
   */
  compute(btcCandles: Candle[], ethCandles: Candle[]): CorrelationSnapshot | null {
    // Align by timestamp intersection — only use candles present in BOTH arrays
    const { btc: btcAligned, eth: ethAligned } = this.alignCandles(
      btcCandles,
      ethCandles,
    );

    // Need windowCandles+1 aligned candles to produce windowCandles log-returns
    if (btcAligned.length < this.windowCandles + 1) return null;

    // Slice the most recent windowCandles+1 candles
    const btcSlice = btcAligned.slice(-(this.windowCandles + 1));
    const ethSlice = ethAligned.slice(-(this.windowCandles + 1));

    // Convert to log-returns: ln(close[i] / close[i-1])
    const btcReturns = this.toLogReturns(btcSlice);
    const ethReturns = this.toLogReturns(ethSlice);

    // Need at least 2 returns for sampleCorrelation (Bessel's correction requires n >= 2)
    if (btcReturns.length < 2 || ethReturns.length < 2) return null;

    // sampleCorrelation throws on constant series or length mismatch — catch all
    try {
      const r = sampleCorrelation(btcReturns, ethReturns);
      if (!isFinite(r)) return null;
      return {
        correlation: r,
        windowSize: btcReturns.length,
        timestamp: btcAligned[btcAligned.length - 1].timestamp,
      };
    } catch {
      return null;
    }
  }

  /**
   * Compute the correlation discount scalar.
   *
   * Formula: scalar = 1 - max(0, r)
   *
   * Properties:
   *   r = 0.0  → 1.0  (uncorrelated, no discount)
   *   r = 0.5  → 0.5  (moderate correlation, 50% discount)
   *   r = 1.0  → 0.0  (perfect correlation, full discount)
   *   r = -0.5 → 1.0  (negative correlation is diversifying, no discount)
   *   r = -1.0 → 1.0  (perfect negative correlation, no discount)
   *
   * Negative correlation is capped at zero — we never amplify position size.
   *
   * @param r - Pearson correlation coefficient, typically in [-1, 1]
   * @returns Scalar in [0, 1] to multiply against raw position size
   */
  scalar(r: number): number {
    return Math.max(0, 1 - Math.max(0, r));
  }

  /**
   * Align two candle arrays by intersecting their timestamps.
   *
   * Only candles present in BOTH arrays (same timestamp) are returned.
   * Output arrays are guaranteed to be the same length and ordered ascending.
   */
  private alignCandles(
    btc: Candle[],
    eth: Candle[],
  ): { btc: Candle[]; eth: Candle[] } {
    // Build a timestamp → ETH candle map for O(1) lookup
    const ethByTimestamp = new Map<number, Candle>();
    for (const candle of eth) {
      ethByTimestamp.set(candle.timestamp, candle);
    }

    const btcAligned: Candle[] = [];
    const ethAligned: Candle[] = [];

    for (const candle of btc) {
      const ethCandle = ethByTimestamp.get(candle.timestamp);
      if (ethCandle !== undefined) {
        btcAligned.push(candle);
        ethAligned.push(ethCandle);
      }
    }

    return { btc: btcAligned, eth: ethAligned };
  }

  /**
   * Convert an array of candles to log-returns.
   *
   * log-return[i] = ln(close[i] / close[i-1])
   *
   * Skips any candle pair where either close is non-positive (division
   * by zero or log of zero/negative is undefined).
   */
  private toLogReturns(candles: Candle[]): number[] {
    const returns: number[] = [];
    for (let i = 1; i < candles.length; i++) {
      const prev = Number(candles[i - 1].close);
      const curr = Number(candles[i].close);
      if (prev > 0 && curr > 0) {
        returns.push(Math.log(curr / prev));
      }
    }
    return returns;
  }
}
