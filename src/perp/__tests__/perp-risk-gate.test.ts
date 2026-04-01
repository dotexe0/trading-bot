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
    orderMaxWaitSeconds: 60,
    orderCloseMaxRetries: 3,
    maxDailyLossUsd: 500,
    scalpingTimeframe: '5m' as const,
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

describe('Check 5: DAILY_LOSS_CAP_EXCEEDED', () => {
  const baseParams5 = {
    instrument: 'BIP-20DEC30-CDE',
    proposedNotional: '1000',
    proposedMaxLoss: '10',       // well below perpMaxLossPct * accountValue
    accountValue: '10000',
    expectedGain: '50',          // well above fee drag
  };

  it('approves when daily loss is zero', async () => {
    const gate = makeGate();
    const result = await gate.check(baseParams5);
    expect(result.approved).toBe(true);
  });

  it('approves when daily loss is below cap', async () => {
    const gate = makeGate();
    gate.recordRealizedLoss(200);  // $200 loss, cap is $500
    const result = await gate.check(baseParams5);
    expect(result.approved).toBe(true);
  });

  it('rejects when daily loss equals cap', async () => {
    const gate = makeGate();
    gate.recordRealizedLoss(500);  // exactly at cap
    const result = await gate.check(baseParams5);
    expect(result.approved).toBe(false);
    expect(result.rejectReason).toBe('DAILY_LOSS_CAP_EXCEEDED');
  });

  it('rejects when daily loss exceeds cap', async () => {
    const gate = makeGate();
    gate.recordRealizedLoss(300);
    gate.recordRealizedLoss(250);  // total $550, exceeds $500 cap
    const result = await gate.check(baseParams5);
    expect(result.approved).toBe(false);
    expect(result.rejectReason).toBe('DAILY_LOSS_CAP_EXCEEDED');
    expect(result.details.dailyLoss).toBe('550.00');
    expect(result.details.cap).toBe('500');
  });

  it('accumulates multiple losses correctly', async () => {
    const gate = makeGate();
    gate.recordRealizedLoss(100);
    gate.recordRealizedLoss(150);
    gate.recordRealizedLoss(200);  // total $450, still below $500
    const result = await gate.check(baseParams5);
    expect(result.approved).toBe(true);
  });

  it('ignores profits (only losses accumulate)', async () => {
    const gate = makeGate();
    gate.recordRealizedLoss(-50);  // profit, should be ignored
    gate.recordRealizedLoss(100);  // loss
    // daily loss should be $100, not $50
    const result = await gate.check(baseParams5);
    expect(result.approved).toBe(true);
  });

  it('resets daily loss after midnight UTC', async () => {
    const gate = makeGate();
    gate.recordRealizedLoss(600);  // over the cap

    // Simulate midnight crossing by advancing Date.now past midnight UTC
    const tomorrow = new Date();
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(0, 0, 1, 0);
    vi.spyOn(Date, 'now').mockReturnValue(tomorrow.getTime());

    const result = await gate.check(baseParams5);
    expect(result.approved).toBe(true);

    vi.restoreAllMocks();
  });

  it('rejects new entries after accumulated losses from position closes exceed cap', async () => {
    // End-to-end: simulate what happens when closePaperPosition records losses
    const gate = makeGate();
    // Simulate 3 losing trades: $200, $150, $200 = $550 total
    gate.recordRealizedLoss(200);
    gate.recordRealizedLoss(150);
    gate.recordRealizedLoss(200);
    const result = await gate.check(baseParams5);
    expect(result.approved).toBe(false);
    expect(result.rejectReason).toBe('DAILY_LOSS_CAP_EXCEEDED');
  });
});
