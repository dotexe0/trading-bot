/**
 * ISpotOrderExecutor — strategy pattern interface for spot order placement.
 *
 * Abstracts the difference between paper (FillSimulator) and live (OrderManager) fills.
 * The unified SpotTradingEngine delegates only the fill mechanism to this interface;
 * all risk checks, exit logic, and event emission remain in the engine.
 */

import type Decimal from 'decimal.js';
import { d } from '../core/decimal.js';
import { createModuleLogger } from '../core/logger.js';
import { FillSimulator } from '../backtest/fill-simulator.js';
import type { SimulatedFill } from '../backtest/types.js';
import type { Signal } from '../strategies/types.js';
import type { Candle } from '../core/types.js';
import type { OrderManager, SubmitMarketOrderParams } from '../live/order-manager.js';
import type { LiveOrder } from '../live/types.js';

// ── Shared types ─────────────────────────────────────────────────────

export interface SpotFillResult {
  /** Actual fill price (after slippage in paper, from exchange in live). */
  fillPrice: Decimal;
  /** Quantity filled. */
  quantity: Decimal;
  /** Fee charged for this fill. */
  fee: Decimal;
  /** Timestamp of the fill. */
  fillTimestamp: number;
  /** Side of the fill. */
  side: 'buy' | 'sell';
  /** Slippage in bps (paper only — undefined in live until fill event). */
  slippageBps?: string;
  /** Exchange order ID (live only). */
  orderId?: string;
}

export interface SpotOrderParams {
  signal: Signal;
  /** Candle whose close is used as fill base price (paper) or market context (live). */
  candle: Candle;
  /** Quantity to buy/sell. */
  quantity: Decimal;
  /** Order purpose. */
  purpose: 'ENTRY' | 'EXIT' | 'STOP_LOSS';
}

// ── Interface ────────────────────────────────────────────────────────

export interface SpotLimitOrderParams {
  signal: Signal;
  candle: Candle;
  quantity: Decimal;
  /** Limit price for the order. */
  limitPrice: Decimal;
  /** Max time in ms to wait for fill before returning null (live only). */
  timeoutMs: number;
}

export interface ISpotOrderExecutor {
  /** Execute a market order (entry or exit). */
  executeOrder(params: SpotOrderParams): Promise<SpotFillResult>;
  /**
   * Cancel an order by ID. Paper: no-op. Live: calls exchange cancel API.
   * Returns true if cancelled, false if already filled.
   */
  cancelOrder?(orderId: string): Promise<boolean>;
  /**
   * Submit a close order with retry + emergency close fallback.
   * Paper: immediate fill. Live: retry loop with exponential backoff.
   */
  executeCloseWithRetry?(params: {
    pair: string;
    closeSide: 'BUY' | 'SELL';
    baseSize: string;
    purpose: 'EXIT' | 'STOP_LOSS';
    maxRetries: number;
  }): Promise<SpotFillResult>;
  /**
   * Submit a limit entry order. Returns null if not filled within timeout.
   * Paper: fill if candle low <= limit (long) or high >= limit (short).
   * Live: submit GTC limit, wait timeout, cancel if unfilled.
   */
  executeLimitEntry?(params: SpotLimitOrderParams): Promise<SpotFillResult | null>;
}

// ── Paper implementation ─────────────────────────────────────────────

const paperLog = createModuleLogger('paper-spot-executor');

/**
 * Simulates fills via FillSimulator (slippage + fee model).
 * Synchronous — no API calls.
 */
export class PaperSpotOrderExecutor implements ISpotOrderExecutor {
  private fillSimulator: FillSimulator;

  constructor(fillSimulator: FillSimulator) {
    this.fillSimulator = fillSimulator;
  }

  async executeOrder(params: SpotOrderParams): Promise<SpotFillResult> {
    const { signal, candle, quantity } = params;

    // Paper uses candle close as fill base (open field in fillCandle)
    const fillCandle: Candle = {
      ...candle,
      open: candle.close,
    };

    const fill: SimulatedFill = this.fillSimulator.simulate(signal, fillCandle, quantity);

    paperLog.info(
      { pair: candle.pair, side: fill.side, fillPrice: fill.fillPrice.toString(), quantity: fill.quantity.toString() },
      '[PAPER] Simulated fill',
    );

    return {
      fillPrice: fill.fillPrice,
      quantity: fill.quantity,
      fee: fill.fee,
      fillTimestamp: fill.fillTimestamp,
      side: fill.side,
    };
  }

  async executeLimitEntry(params: SpotLimitOrderParams): Promise<SpotFillResult | null> {
    const { signal, candle, quantity, limitPrice } = params;
    const isLong = signal.direction === 'long';

    // Paper: check if the candle would have filled the limit order
    // Long: fill if candle low <= limitPrice
    // Short: fill if candle high >= limitPrice
    const wouldFill = isLong
      ? d(candle.low).lte(limitPrice)
      : d(candle.high).gte(limitPrice);

    if (!wouldFill) return null;

    // Simulate fill at the limit price via FillSimulator for consistent fee calc
    const limitCandle: Candle = { ...candle, open: limitPrice.toString() };
    const fill = this.fillSimulator.simulate(signal, limitCandle, quantity);

    paperLog.info(
      { pair: candle.pair, side: isLong ? 'buy' : 'sell', limitPrice: limitPrice.toString(), quantity: quantity.toString() },
      '[PAPER] Limit entry filled',
    );

    return {
      fillPrice: limitPrice,
      quantity: fill.quantity,
      fee: fill.fee,
      fillTimestamp: candle.timestamp,
      side: isLong ? 'buy' : 'sell',
    };
  }
}

// ── Live implementation ──────────────────────────────────────────────

const liveLog = createModuleLogger('live-spot-executor');

/** Minimum base size increments for supported pairs (v1 hardcoded). */
const BASE_INCREMENTS: Record<string, number> = {
  'BTC-USD': 0.00000001,
  'ETH-USD': 0.00000001,
};

/**
 * Places real orders via OrderManager. Async — real exchange API calls.
 */
export class LiveSpotOrderExecutor implements ISpotOrderExecutor {
  private orderManager: OrderManager;

  constructor(orderManager: OrderManager) {
    this.orderManager = orderManager;
  }

  async executeOrder(params: SpotOrderParams): Promise<SpotFillResult> {
    const { signal, candle, quantity, purpose } = params;
    const side = signal.direction === 'long' || signal.direction === 'short'
      ? (signal.direction === 'long' ? 'BUY' : 'SELL')
      : (signal.direction === 'close' ? 'SELL' : 'BUY');

    // Round quantity DOWN to base increment
    const pair = candle.pair;
    const increment = BASE_INCREMENTS[pair] ?? 0.00000001;
    const rawQty = quantity.toNumber();
    const roundedQty = Math.floor(rawQty / increment) * increment;

    if (roundedQty < increment) {
      throw new Error(`Quantity ${rawQty} too small after rounding for ${pair}`);
    }

    const order: LiveOrder = await this.orderManager.submitMarketOrder({
      pair,
      side: side as 'BUY' | 'SELL',
      baseSize: roundedQty.toFixed(8),
      purpose,
    });

    liveLog.info(
      { pair, side, orderId: order.orderId, purpose },
      'Market order submitted',
    );

    const fillPrice = order.averageFillPrice ? d(order.averageFillPrice) : d(candle.close);
    const fee = d(order.totalFees ?? '0');

    return {
      fillPrice,
      quantity: d(roundedQty),
      fee,
      fillTimestamp: order.updatedAt,
      side: side === 'BUY' ? 'buy' : 'sell',
      orderId: order.orderId,
    };
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    return this.orderManager.cancelOrder(orderId);
  }

  async executeCloseWithRetry(params: {
    pair: string;
    closeSide: 'BUY' | 'SELL';
    baseSize: string;
    purpose: 'EXIT' | 'STOP_LOSS';
    maxRetries: number;
  }): Promise<SpotFillResult> {
    const { pair, closeSide, baseSize, purpose, maxRetries } = params;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const order = await this.orderManager.submitMarketOrder({
          pair,
          side: closeSide,
          baseSize,
          purpose,
        });

        const fillPrice = order.averageFillPrice ? d(order.averageFillPrice) : d('0');
        const fee = d(order.totalFees ?? '0');

        return {
          fillPrice,
          quantity: d(baseSize),
          fee,
          fillTimestamp: order.updatedAt,
          side: closeSide === 'BUY' ? 'buy' : 'sell',
          orderId: order.orderId,
        };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        liveLog.warn(
          { attempt, maxRetries, pair, err: lastError.message, purpose },
          'Close order failed -- retrying',
        );
        await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt - 1)));
      }
    }

    // Emergency close: one final attempt
    liveLog.error(
      { pair, closeSide, baseSize, purpose, attempts: maxRetries, lastError: lastError?.message },
      'EMERGENCY CLOSE: all close retries exhausted',
    );

    try {
      const order = await this.orderManager.submitMarketOrder({
        pair,
        side: closeSide,
        baseSize,
        purpose: 'EXIT',
      });

      const fillPrice = order.averageFillPrice ? d(order.averageFillPrice) : d('0');
      const fee = d(order.totalFees ?? '0');

      return {
        fillPrice,
        quantity: d(baseSize),
        fee,
        fillTimestamp: order.updatedAt,
        side: closeSide === 'BUY' ? 'buy' : 'sell',
        orderId: order.orderId,
      };
    } catch (emergencyErr) {
      liveLog.error(
        { err: emergencyErr instanceof Error ? emergencyErr.message : String(emergencyErr) },
        'CRITICAL: Emergency close also failed -- triggering reconciliation',
      );
      this.orderManager.reconcile().catch(reconcileErr => {
        liveLog.error({ err: reconcileErr }, 'Post-emergency reconciliation failed');
      });
      throw emergencyErr;
    }
  }

  async executeLimitEntry(params: SpotLimitOrderParams): Promise<SpotFillResult | null> {
    const { signal, candle, quantity, limitPrice, timeoutMs } = params;
    const isLong = signal.direction === 'long';
    const side = isLong ? 'BUY' : 'SELL';
    const pair = candle.pair;
    const increment = BASE_INCREMENTS[pair] ?? 0.00000001;
    const rawQty = quantity.toNumber();
    const roundedQty = Math.floor(rawQty / increment) * increment;

    if (roundedQty < increment) return null;

    // Submit GTC limit order
    let order: LiveOrder;
    try {
      order = await this.orderManager.submitLimitGtcOrder({
        pair,
        side: side as 'BUY' | 'SELL',
        baseSize: roundedQty.toFixed(8),
        limitPrice: limitPrice.toString(),
        purpose: 'ENTRY',
      });
    } catch (err) {
      liveLog.warn(
        { pair, err: err instanceof Error ? err.message : String(err) },
        'Limit entry order submission failed',
      );
      return null;
    }

    // Wait for fill with polling
    const deadline = Date.now() + timeoutMs;
    const pollInterval = 2000;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, pollInterval));
      const status = this.orderManager.getOrderStatus?.(order.orderId);
      if (status === 'FILLED') {
        const fillPrice = order.averageFillPrice ? d(order.averageFillPrice) : limitPrice;
        const fee = d(order.totalFees ?? '0');
        return {
          fillPrice,
          quantity: d(roundedQty),
          fee,
          fillTimestamp: Date.now(),
          side: isLong ? 'buy' : 'sell',
          orderId: order.orderId,
        };
      }
      if (status === 'CANCELLED' || status === 'FAILED') {
        return null;
      }
    }

    // Timeout — cancel the unfilled order
    liveLog.info(
      { pair, orderId: order.orderId, timeoutMs },
      'Limit entry timed out — cancelling',
    );
    await this.cancelOrder(order.orderId);
    return null;
  }
}
