/**
 * Tests for PerpRiskGate Check 4: FEE_DRAG_EXCESSIVE.
 *
 * Existing Checks 1-3 are implicitly covered by paper-perp-engine.test.ts
 * and position-manager.test.ts. This file focuses on the new fee drag check.
 */
import { describe, it, expect, vi } from 'vitest';
import { PerpRiskGate } from '../perp-risk-gate.js';
import type { FeeConfig } from '../fee-config.js';
import type { IntxClient } from '../intx-client.js';
import type { PerpStateStore } from '../perp-state-store.js';
import type { IntxConfig } from '../config.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeFeeConfig(takerFeeRate = 0.0003): FeeConfig {
  return { takerFeeRate, makerFeeRate: 0, source: 'fallback' };
}

function makeConfig(): IntxConfig {
  return {
    enabled: true,
    apiKey: 'key',
    apiSecret: 'secret',
    testnet: false,
    btcProductId: 'BIP-20DEC30-CDE',
    ethProductId: 'ETP-20DEC30-CDE',
    liquidationSafetyThresholdPct: 5.0,
    defaultMaintenanceMarginRate: '0.0333',
    tpTargetPct: 2.0,
    atrMultiplier: 2.0,
    stopLimitSlippagePct: 0.1,
    repriceTimeoutMs: 60000,
    maxRepriceAttempts: 20,
    entryOrderTimeoutMs: 300000,
    maxLeverageCap: 5,
    defaultLeverage: 3,
    leverageByRegime: { VOLATILE: 2, TRENDING: 5, RANGING: 3 },
    marginUtilizationCeiling: 0.8,
    perpExposureCapPct: 0.5,
    perpMaxLossPct: 0.02,
    fundingDrainThresholdPct: 0.005,
    perpMode: 'none',
  };
}

function makeGate(feeConfig?: FeeConfig): PerpRiskGate {
  // paperMode=true bypasses margin/exposure REST calls
  const intxClient = {} as IntxClient;
  const stateStore = { getAllOpenSessions: vi.fn().mockReturnValue([]) } as unknown as PerpStateStore;
  return new PerpRiskGate({
    intxClient,
    stateStore,
    config: makeConfig(),
    feeConfig,
    paperMode: true,
  });
}

// Base params that pass Checks 1-3 (paper mode mock balance is always healthy)
function baseParams(overrides: Partial<{ expectedGain: string; proposedNotional: string }> = {}) {
  return {
    instrument: 'BIP-20DEC30-CDE',
    proposedNotional: '1000',   // $1000 notional
    proposedMaxLoss: '20',      // $20 max loss (2%)
    accountValue: '100000',     // $100k account value — well within limits
    expectedGain: '10',         // $10 expected gain (default — overridden per test)
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('PerpRiskGate Check 4: FEE_DRAG_EXCESSIVE', () => {

  describe('fee drag rejection', () => {
    it('rejects when expectedGain equals roundTripFee exactly', async () => {
      // takerFeeRate=0.0003, notional=1000 → roundTripFee = 2*0.0003*1000 = 0.6
      const gate = makeGate(makeFeeConfig(0.0003));
      const result = await gate.check(baseParams({ expectedGain: '0.6', proposedNotional: '1000' }));
      expect(result.approved).toBe(false);
      expect(result.rejectReason).toBe('FEE_DRAG_EXCESSIVE');
      expect(result.details.expectedGain).toBe('0.6');
      expect(result.details.roundTripFee).toBe('0.600000');
    });

    it('rejects when expectedGain is below roundTripFee', async () => {
      // roundTripFee = 2*0.0003*1000 = 0.6; expectedGain=0.5 < 0.6
      const gate = makeGate(makeFeeConfig(0.0003));
      const result = await gate.check(baseParams({ expectedGain: '0.5', proposedNotional: '1000' }));
      expect(result.approved).toBe(false);
      expect(result.rejectReason).toBe('FEE_DRAG_EXCESSIVE');
    });

    it('rejects when expectedGain is zero', async () => {
      const gate = makeGate(makeFeeConfig(0.0003));
      const result = await gate.check(baseParams({ expectedGain: '0', proposedNotional: '1000' }));
      expect(result.approved).toBe(false);
      expect(result.rejectReason).toBe('FEE_DRAG_EXCESSIVE');
    });
  });

  describe('fee drag approval', () => {
    it('approves when expectedGain strictly exceeds roundTripFee', async () => {
      // roundTripFee = 2*0.0003*1000 = 0.6; expectedGain=0.61 > 0.6
      const gate = makeGate(makeFeeConfig(0.0003));
      const result = await gate.check(baseParams({ expectedGain: '0.61', proposedNotional: '1000' }));
      expect(result.approved).toBe(true);
      expect(result.rejectReason).toBeUndefined();
    });

    it('approves with realistic TP gain (2% of 1000 = 20 >> fee of 0.6)', async () => {
      const gate = makeGate(makeFeeConfig(0.0003));
      const result = await gate.check(baseParams({ expectedGain: '20', proposedNotional: '1000' }));
      expect(result.approved).toBe(true);
    });
  });

  describe('feeConfig defaults', () => {
    it('uses DEFAULT_FEE_CONFIG (takerFeeRate=0.0003) when feeConfig not provided', async () => {
      // Without feeConfig: roundTripFee = 2*0.0003*1000 = 0.6
      // expectedGain=0.5 should still be rejected via the fallback
      const gate = makeGate(undefined);
      const result = await gate.check(baseParams({ expectedGain: '0.5', proposedNotional: '1000' }));
      expect(result.approved).toBe(false);
      expect(result.rejectReason).toBe('FEE_DRAG_EXCESSIVE');
    });

    it('uses provided feeConfig takerFeeRate instead of fallback', async () => {
      // Higher fee rate: roundTripFee = 2*0.001*1000 = 2.0
      // expectedGain=1.5 < 2.0 → rejected
      const gate = makeGate(makeFeeConfig(0.001));
      const result = await gate.check(baseParams({ expectedGain: '1.5', proposedNotional: '1000' }));
      expect(result.approved).toBe(false);
      expect(result.rejectReason).toBe('FEE_DRAG_EXCESSIVE');
    });
  });

  describe('check ordering', () => {
    it('Check 4 only fires after Checks 1-3 pass', async () => {
      // Paper mode mock balance always passes Checks 1-3; Check 4 can then fire
      const gate = makeGate(makeFeeConfig(0.0003));
      const result = await gate.check(baseParams({ expectedGain: '0' }));
      // Check 4 should be the reject reason (not margin/exposure/maxloss)
      expect(result.rejectReason).toBe('FEE_DRAG_EXCESSIVE');
    });
  });
});
