/**
 * Tests for IntxClient and intxConfigSchema.
 *
 * All CBInternationalClient interactions are mocked — no live network calls.
 * Tests validate:
 *   - Config schema refine rules (enabled + missing credentials)
 *   - IntxClient constructor guard (enabled=false throws)
 *   - IntxClient constructor success (CBInternationalClient instantiated)
 *   - getAccountState() calls getPortfolioDetails with portfolioId and maps response
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock coinbase-api ────────────────────────────────────────────────

const mockGetPortfolioDetails = vi.fn();

vi.mock('coinbase-api', () => ({
  CBInternationalClient: class MockCBInternationalClient {
    constructor(public opts: unknown) {}
    getPortfolioDetails = mockGetPortfolioDetails;
  },
}));

// Import AFTER mock registration
import { intxConfigSchema } from '../config.js';
import { IntxClient } from '../intx-client.js';

// ── Helpers ─────────────────────────────────────────────────────────

const VALID_ENABLED_CONFIG = {
  enabled: true,
  apiKey: 'test-key',
  apiSecret: 'test-secret',
  apiPassphrase: 'test-passphrase',
  portfolioId: 'portfolio-uuid-001',
  testnet: true,
};

// ── intxConfigSchema tests ────────────────────────────────────────────

describe('intxConfigSchema', () => {
  it('Test 1: validates successfully with enabled=false and no credentials', () => {
    const result = intxConfigSchema.safeParse({ enabled: false });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(false);
    }
  });

  it('Test 2: validates successfully with enabled=true and all four credentials', () => {
    const result = intxConfigSchema.safeParse(VALID_ENABLED_CONFIG);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(true);
      expect(result.data.apiKey).toBe('test-key');
      expect(result.data.apiPassphrase).toBe('test-passphrase');
      expect(result.data.portfolioId).toBe('portfolio-uuid-001');
    }
  });

  it('Test 3: fails when enabled=true and apiPassphrase is missing', () => {
    const result = intxConfigSchema.safeParse({
      enabled: true,
      apiKey: 'test-key',
      apiSecret: 'test-secret',
      // apiPassphrase omitted
      portfolioId: 'portfolio-uuid-001',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages.some((m) => m.includes('INTX_API_PASSPHRASE'))).toBe(true);
    }
  });

  it('Test 4: fails when enabled=true and portfolioId is missing', () => {
    const result = intxConfigSchema.safeParse({
      enabled: true,
      apiKey: 'test-key',
      apiSecret: 'test-secret',
      apiPassphrase: 'test-passphrase',
      // portfolioId omitted
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages.some((m) => m.includes('INTX_PORTFOLIO_ID'))).toBe(true);
    }
  });
});

// ── IntxClient constructor tests ─────────────────────────────────────

describe('IntxClient constructor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('Test 5: throws when instantiated with enabled=false', () => {
    const disabledConfig = intxConfigSchema.parse({ enabled: false });
    expect(() => new IntxClient(disabledConfig)).toThrow(
      'IntxClient instantiated with INTX_ENABLED=false',
    );
  });

  it('Test 6: succeeds with a valid enabled config', () => {
    const config = intxConfigSchema.parse(VALID_ENABLED_CONFIG);
    const client = new IntxClient(config);
    expect(client).toBeInstanceOf(IntxClient);
  });
});

// ── IntxClient.getAccountState() tests ──────────────────────────────

describe('IntxClient.getAccountState()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('Test 7: calls getPortfolioDetails with portfolioId and maps response to IntxAccountState', async () => {
    const mockResponse = {
      balances: [{ asset: 'USD', quantity: '10000' }],
      positions: [{ instrument: 'BTC-PERP', netSize: '0.5' }],
      summary: { initialMargin: '500', maintenanceMargin: '250' },
    };
    mockGetPortfolioDetails.mockResolvedValueOnce(mockResponse);

    const config = intxConfigSchema.parse(VALID_ENABLED_CONFIG);
    const client = new IntxClient(config);
    const state = await client.getAccountState();

    expect(mockGetPortfolioDetails).toHaveBeenCalledOnce();
    expect(mockGetPortfolioDetails).toHaveBeenCalledWith({
      portfolio: 'portfolio-uuid-001',
    });

    expect(state.balances).toEqual(mockResponse.balances);
    expect(state.positions).toEqual(mockResponse.positions);
    expect(state.summary).toEqual(mockResponse.summary);
  });
});
