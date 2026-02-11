/**
 * SandboxValidator -- validates order request format against Coinbase sandbox.
 *
 * The Coinbase Advanced Trade sandbox returns static mocked responses.
 * This validates request FORMAT only, not realistic order execution.
 * Actual paper trading uses live market data with local fill simulation
 * (industry standard).
 *
 * Satisfies PAPR-03 at the format-validation level per research findings.
 */

import crypto from 'node:crypto';
import { CBAdvancedTradeClient } from 'coinbase-api';
import type { TradingPair } from '../core/types.js';
import { createModuleLogger } from '../core/logger.js';

const log = createModuleLogger('sandbox-validator');

export interface ValidateOrderParams {
  pair: TradingPair;
  side: 'buy' | 'sell';
  quantity: string;
  price?: string;
}

export interface ValidationResult {
  valid: boolean;
  response?: unknown;
  error?: string;
}

export interface ValidationSummary {
  orderCreate: boolean;
  orderCancel: boolean;
  summary: string;
}

export class SandboxValidator {
  private client: CBAdvancedTradeClient;

  constructor() {
    this.client = new CBAdvancedTradeClient({ useSandbox: true });
  }

  /**
   * Validate that an order creation request is correctly formatted
   * by sending it to the Coinbase sandbox endpoint.
   */
  async validateOrderFormat(params: ValidateOrderParams): Promise<ValidationResult> {
    try {
      const response = await this.client.submitOrder({
        product_id: params.pair,
        side: params.side === 'buy' ? 'BUY' : 'SELL',
        order_configuration: {
          limit_limit_gtc: {
            base_size: params.quantity,
            limit_price: params.price ?? '50000',
          },
        },
        client_order_id: crypto.randomUUID(),
      });

      log.info(
        { pair: params.pair, side: params.side, valid: true },
        'Order format validated',
      );

      return { valid: true, response };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(
        { pair: params.pair, side: params.side, error: message },
        'Order format validation failed',
      );
      return { valid: false, error: message };
    }
  }

  /**
   * Validate that an order cancellation request is correctly formatted
   * by sending it to the Coinbase sandbox endpoint.
   */
  async validateCancelFormat(orderId: string): Promise<ValidationResult> {
    try {
      const response = await this.client.cancelOrders({
        order_ids: [orderId],
      });

      log.info({ orderId, valid: true }, 'Cancel format validated');

      return { valid: true, response };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(
        { orderId, error: message },
        'Cancel format validation failed',
      );
      return { valid: false, error: message };
    }
  }

  /**
   * Run both order creation and cancellation validation.
   * Returns a summary of what passed/failed.
   */
  async runValidation(): Promise<ValidationSummary> {
    const orderResult = await this.validateOrderFormat({
      pair: 'BTC-USD',
      side: 'buy',
      quantity: '0.001',
      price: '50000',
    });

    const cancelResult = await this.validateCancelFormat('test-order-id');

    const parts: string[] = [];
    parts.push(`Order create: ${orderResult.valid ? 'PASS' : 'FAIL'}`);
    parts.push(`Order cancel: ${cancelResult.valid ? 'PASS' : 'FAIL'}`);

    const summary = parts.join(', ');

    log.info(
      {
        orderCreate: orderResult.valid,
        orderCancel: cancelResult.valid,
      },
      `Sandbox validation: ${summary}`,
    );

    return {
      orderCreate: orderResult.valid,
      orderCancel: cancelResult.valid,
      summary,
    };
  }
}
