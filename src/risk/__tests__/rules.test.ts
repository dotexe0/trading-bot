/**
 * Tests for all 5 portfolio-level risk rules.
 *
 * Each rule implements RiskRule and produces structured RiskRuleResult
 * with inputValues and threshold for RISK-07 logging.
 */

import { describe, it, expect } from 'vitest';
import { d, ZERO } from '../../core/decimal.js';
import { MaxPositionSizeRule } from '../rules/max-position-size.js';
import { MaxDrawdownRule } from '../rules/max-drawdown.js';
import { DailyLossLimitRule } from '../rules/daily-loss-limit.js';
import { MaxExposureRule } from '../rules/max-exposure.js';
import { MaxPositionCountRule } from '../rules/max-position-count.js';
import type { RiskContext, RiskConfig } from '../types.js';
import type { Signal } from '../../strategies/types.js';

// ── Helpers ───────────────────────────────────────────────────────────

function makeSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    strategyName: 'test-strategy',
    pair: 'BTC-USD',
    timeframe: '1h',
    timestamp: 1700000000000,
    direction: 'long',
    confidence: 0.8,
    reasoning: 'test signal',
    ...overrides,
  };
}

function makeRiskConfig(overrides: Partial<RiskConfig> = {}): RiskConfig {
  return {
    sizingMethod: 'half-kelly',
    kellyFraction: 0.5,
    fixedFractionPct: 0.02,
    maxPositionPct: 0.25,
    minTradesForKelly: 30,
    stopLoss: { type: 'fixed', percentage: 0.05 },
    maxDrawdownPct: 0.15,
    maxDailyLossPct: 0.05,
    maxExposurePct: 0.95,
    maxPositionCount: 4,
    circuitBreakerCooldownMs: 0,
    confidenceFloor: 0.3,
    volatilitySizing: false,
    riskPerTradePct: 0.01,
    atrStopMultiple: 2.0,
    ...overrides,
  };
}

function makeContext(overrides: Partial<RiskContext> = {}): RiskContext {
  return {
    signal: makeSignal(),
    proposedQuantity: d(1),
    proposedPrice: d(50000),
    currentEquity: d(100000),
    peakEquity: d(100000),
    cashBalance: d(100000),
    openPositionCount: 0,
    totalExposure: ZERO,
    dailyPnL: ZERO,
    riskConfig: makeRiskConfig(),
    timestamp: 1700000000000,
    ...overrides,
  };
}

// ── MaxPositionSizeRule ──────────────────────────────────────────────

describe('MaxPositionSizeRule', () => {
  const rule = new MaxPositionSizeRule();

  it('approves when position is within cap', () => {
    // 1 BTC * $50000 / $100000 = 50% -- but wait, maxPositionPct is 25% so 50% > 25%
    // Let's make a smaller position: 0.1 BTC * $50000 / $100000 = 5%
    const ctx = makeContext({ proposedQuantity: d(0.1), proposedPrice: d(50000) });
    const result = rule.evaluate(ctx);
    expect(result.approved).toBe(true);
    expect(result.rule).toBe('max-position-size');
    expect(result.adjustedQuantity).toBeUndefined();
  });

  it('provides adjusted quantity when over cap', () => {
    // 1 BTC * $50000 / $100000 = 50% > 25% cap
    const ctx = makeContext({ proposedQuantity: d(1), proposedPrice: d(50000) });
    const result = rule.evaluate(ctx);
    expect(result.approved).toBe(true);
    expect(result.adjustedQuantity).toBeDefined();
    // Max value = $100000 * 0.25 = $25000; adjusted qty = $25000 / $50000 = 0.5
    expect(result.adjustedQuantity!.toNumber()).toBe(0.5);
  });

  it('approves at boundary (exactly at cap)', () => {
    // 0.5 BTC * $50000 / $100000 = 25% == maxPositionPct of 0.25
    const ctx = makeContext({ proposedQuantity: d(0.5), proposedPrice: d(50000) });
    const result = rule.evaluate(ctx);
    expect(result.approved).toBe(true);
    expect(result.adjustedQuantity).toBeUndefined();
  });

  it('populates inputValues and threshold for logging (RISK-07)', () => {
    const ctx = makeContext({ proposedQuantity: d(0.1), proposedPrice: d(50000) });
    const result = rule.evaluate(ctx);
    expect(result.inputValues).toHaveProperty('positionValuePct');
    expect(result.inputValues).toHaveProperty('equity');
    expect(result.threshold).toBe('0.25');
  });
});

// ── MaxDrawdownRule ──────────────────────────────────────────────────

describe('MaxDrawdownRule', () => {
  it('approves when drawdown is below threshold', () => {
    const rule = new MaxDrawdownRule();
    const ctx = makeContext({
      currentEquity: d(95000),
      peakEquity: d(100000),
    });
    // Drawdown = 5% < 15%
    const result = rule.evaluate(ctx);
    expect(result.approved).toBe(true);
    expect(rule.isTripped()).toBe(false);
  });

  it('rejects and trips when drawdown exceeds threshold', () => {
    const rule = new MaxDrawdownRule();
    const ctx = makeContext({
      currentEquity: d(80000),
      peakEquity: d(100000),
    });
    // Drawdown = 20% > 15%
    const result = rule.evaluate(ctx);
    expect(result.approved).toBe(false);
    expect(rule.isTripped()).toBe(true);
  });

  it('stays tripped on subsequent calls (no cooldown)', () => {
    const rule = new MaxDrawdownRule();
    // Trip it first
    const ctx1 = makeContext({
      currentEquity: d(80000),
      peakEquity: d(100000),
      riskConfig: makeRiskConfig({ circuitBreakerCooldownMs: 0 }),
    });
    rule.evaluate(ctx1);
    expect(rule.isTripped()).toBe(true);

    // Even with equity recovered, still tripped (no cooldown)
    const ctx2 = makeContext({
      currentEquity: d(99000),
      peakEquity: d(100000),
      timestamp: 1700000000000 + 86400000,
      riskConfig: makeRiskConfig({ circuitBreakerCooldownMs: 0 }),
    });
    const result = rule.evaluate(ctx2);
    expect(result.approved).toBe(false);
    expect(rule.isTripped()).toBe(true);
  });

  it('resets after cooldown period elapses', () => {
    const rule = new MaxDrawdownRule();
    const cooldownMs = 60000; // 1 minute

    // Trip it
    const ctx1 = makeContext({
      currentEquity: d(80000),
      peakEquity: d(100000),
      timestamp: 1700000000000,
      riskConfig: makeRiskConfig({ circuitBreakerCooldownMs: cooldownMs }),
    });
    rule.evaluate(ctx1);
    expect(rule.isTripped()).toBe(true);

    // Not enough time -- still tripped
    const ctx2 = makeContext({
      currentEquity: d(95000),
      peakEquity: d(100000),
      timestamp: 1700000000000 + 30000, // 30s < 60s cooldown
      riskConfig: makeRiskConfig({ circuitBreakerCooldownMs: cooldownMs }),
    });
    const result2 = rule.evaluate(ctx2);
    expect(result2.approved).toBe(false);

    // Enough time -- resets
    const ctx3 = makeContext({
      currentEquity: d(95000),
      peakEquity: d(100000),
      timestamp: 1700000000000 + 60000, // exactly at cooldown
      riskConfig: makeRiskConfig({ circuitBreakerCooldownMs: cooldownMs }),
    });
    const result3 = rule.evaluate(ctx3);
    expect(result3.approved).toBe(true);
    expect(rule.isTripped()).toBe(false);
  });

  it('manual reset clears tripped state', () => {
    const rule = new MaxDrawdownRule();
    const ctx = makeContext({
      currentEquity: d(80000),
      peakEquity: d(100000),
    });
    rule.evaluate(ctx);
    expect(rule.isTripped()).toBe(true);

    rule.reset();
    expect(rule.isTripped()).toBe(false);
  });

  it('populates inputValues and threshold for logging (RISK-07)', () => {
    const rule = new MaxDrawdownRule();
    const ctx = makeContext({
      currentEquity: d(90000),
      peakEquity: d(100000),
    });
    const result = rule.evaluate(ctx);
    expect(result.inputValues).toHaveProperty('currentDrawdown');
    expect(result.inputValues).toHaveProperty('peakEquity');
    expect(result.inputValues).toHaveProperty('currentEquity');
    expect(result.threshold).toBe('0.15');
  });
});

// ── DailyLossLimitRule ──────────────────────────────────────────────

describe('DailyLossLimitRule', () => {
  it('approves when daily loss is within limit', () => {
    const rule = new DailyLossLimitRule();
    const ctx = makeContext({
      currentEquity: d(98000),
      timestamp: 1700000000000,
    });
    // First call sets startOfDayEquity = 98000, loss = 0%
    const result = rule.evaluate(ctx);
    expect(result.approved).toBe(true);
  });

  it('rejects when daily loss exceeds limit', () => {
    const rule = new DailyLossLimitRule();
    // First call: set baseline
    const ctx1 = makeContext({
      currentEquity: d(100000),
      timestamp: 1700000000000,
    });
    rule.evaluate(ctx1);

    // Second call: equity dropped 6% (> 5% limit)
    const ctx2 = makeContext({
      currentEquity: d(94000),
      timestamp: 1700000000000 + 3600000, // same day
    });
    const result = rule.evaluate(ctx2);
    expect(result.approved).toBe(false);
    expect(result.reason).toContain('Daily loss');
  });

  it('resets at UTC day boundary', () => {
    const rule = new DailyLossLimitRule();
    // Day 1: equity drops below limit
    const day1Start = 1700000000000; // some timestamp
    const ctx1 = makeContext({
      currentEquity: d(100000),
      timestamp: day1Start,
    });
    rule.evaluate(ctx1);

    const ctx2 = makeContext({
      currentEquity: d(94000),
      timestamp: day1Start + 3600000,
    });
    const result2 = rule.evaluate(ctx2);
    expect(result2.approved).toBe(false);

    // Next UTC day: resets with new equity baseline
    const nextDay = day1Start + 86_400_000;
    const ctx3 = makeContext({
      currentEquity: d(94000),
      timestamp: nextDay,
    });
    const result3 = rule.evaluate(ctx3);
    // New day, loss = 0% (startOfDayEquity resets to 94000)
    expect(result3.approved).toBe(true);
  });

  it('populates inputValues and threshold for logging (RISK-07)', () => {
    const rule = new DailyLossLimitRule();
    const ctx = makeContext({ currentEquity: d(99000), timestamp: 1700000000000 });
    const result = rule.evaluate(ctx);
    expect(result.inputValues).toHaveProperty('dailyLossPct');
    expect(result.inputValues).toHaveProperty('startOfDayEquity');
    expect(result.threshold).toBe('0.05');
  });
});

// ── MaxExposureRule ─────────────────────────────────────────────────

describe('MaxExposureRule', () => {
  it('approves when new exposure is within cap', () => {
    const rule = new MaxExposureRule();
    // Current exposure 40%, proposed adds 20% -> total 60% < 95%
    const ctx = makeContext({
      totalExposure: d(0.4),
      proposedQuantity: d(0.4),
      proposedPrice: d(50000),
      currentEquity: d(100000),
    });
    const result = rule.evaluate(ctx);
    expect(result.approved).toBe(true);
  });

  it('rejects when new exposure exceeds cap', () => {
    const rule = new MaxExposureRule();
    // Current exposure 80%, proposed adds 20% -> total 100% > 95%
    const ctx = makeContext({
      totalExposure: d(0.8),
      proposedQuantity: d(0.4),
      proposedPrice: d(50000),
      currentEquity: d(100000),
    });
    const result = rule.evaluate(ctx);
    expect(result.approved).toBe(false);
    expect(result.reason).toContain('exceeding');
  });

  it('populates inputValues with current and proposed exposure', () => {
    const rule = new MaxExposureRule();
    const ctx = makeContext({
      totalExposure: d(0.3),
      proposedQuantity: d(0.2),
      proposedPrice: d(50000),
      currentEquity: d(100000),
    });
    const result = rule.evaluate(ctx);
    expect(result.inputValues).toHaveProperty('currentExposure');
    expect(result.inputValues).toHaveProperty('proposedExposure');
    expect(result.inputValues).toHaveProperty('newTotalExposure');
    expect(result.threshold).toBe('0.95');
  });
});

// ── MaxPositionCountRule ─────────────────────────────────────────────

describe('MaxPositionCountRule', () => {
  it('approves when under position count limit', () => {
    const rule = new MaxPositionCountRule();
    const ctx = makeContext({ openPositionCount: 2 });
    const result = rule.evaluate(ctx);
    expect(result.approved).toBe(true);
  });

  it('rejects when at position count limit', () => {
    const rule = new MaxPositionCountRule();
    const ctx = makeContext({ openPositionCount: 4 }); // maxPositionCount default is 4
    const result = rule.evaluate(ctx);
    expect(result.approved).toBe(false);
    expect(result.reason).toContain('meets or exceeds');
  });

  it('rejects when over position count limit', () => {
    const rule = new MaxPositionCountRule();
    const ctx = makeContext({ openPositionCount: 5 });
    const result = rule.evaluate(ctx);
    expect(result.approved).toBe(false);
  });

  it('populates inputValues and threshold for logging (RISK-07)', () => {
    const rule = new MaxPositionCountRule();
    const ctx = makeContext({ openPositionCount: 2 });
    const result = rule.evaluate(ctx);
    expect(result.inputValues).toHaveProperty('currentCount');
    expect(result.inputValues.currentCount).toBe('2');
    expect(result.threshold).toBe('4');
  });
});
