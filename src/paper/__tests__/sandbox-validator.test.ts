/**
 * Tests for SandboxValidator.
 *
 * Mocks coinbase-api CBAdvancedTradeClient to avoid real API calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSubmitOrder = vi.fn();
const mockCancelOrders = vi.fn();

// Mock coinbase-api before imports -- use a class for proper `new` support
vi.mock('coinbase-api', () => ({
  CBAdvancedTradeClient: class MockCBAdvancedTradeClient {
    submitOrder = mockSubmitOrder;
    cancelOrders = mockCancelOrders;
    constructor(_opts: unknown) {}
  },
}));

import { SandboxValidator } from '../sandbox-validator.js';

describe('SandboxValidator', () => {
  let validator: SandboxValidator;

  beforeEach(() => {
    mockSubmitOrder.mockReset();
    mockCancelOrders.mockReset();
    validator = new SandboxValidator();
  });

  it('validateOrderFormat returns valid when sandbox responds', async () => {
    mockSubmitOrder.mockResolvedValueOnce({
      success: true,
      order_id: 'mock-order-id',
    });

    const result = await validator.validateOrderFormat({
      pair: 'BTC-USD',
      side: 'buy',
      quantity: '0.001',
      price: '50000',
    });

    expect(result.valid).toBe(true);
    expect(result.response).toEqual({
      success: true,
      order_id: 'mock-order-id',
    });
    expect(result.error).toBeUndefined();
  });

  it('validateOrderFormat returns invalid on format error', async () => {
    mockSubmitOrder.mockRejectedValueOnce(
      new Error('Invalid product_id'),
    );

    const result = await validator.validateOrderFormat({
      pair: 'BTC-USD',
      side: 'buy',
      quantity: '0.001',
    });

    expect(result.valid).toBe(false);
    expect(result.error).toBe('Invalid product_id');
    expect(result.response).toBeUndefined();
  });

  it('validateCancelFormat returns valid when sandbox responds', async () => {
    mockCancelOrders.mockResolvedValueOnce({
      results: [{ success: true }],
    });

    const result = await validator.validateCancelFormat('test-order-123');

    expect(result.valid).toBe(true);
    expect(result.response).toEqual({
      results: [{ success: true }],
    });
  });

  it('runValidation reports both results', async () => {
    mockSubmitOrder.mockResolvedValueOnce({ success: true });
    mockCancelOrders.mockResolvedValueOnce({ success: true });

    const summary = await validator.runValidation();

    expect(summary.orderCreate).toBe(true);
    expect(summary.orderCancel).toBe(true);
    expect(summary.summary).toContain('Order create: PASS');
    expect(summary.summary).toContain('Order cancel: PASS');
  });

  it('runValidation reports failures correctly', async () => {
    mockSubmitOrder.mockRejectedValueOnce(new Error('Bad request'));
    mockCancelOrders.mockRejectedValueOnce(new Error('Not found'));

    const summary = await validator.runValidation();

    expect(summary.orderCreate).toBe(false);
    expect(summary.orderCancel).toBe(false);
    expect(summary.summary).toContain('Order create: FAIL');
    expect(summary.summary).toContain('Order cancel: FAIL');
  });
});
