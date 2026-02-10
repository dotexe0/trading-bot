/**
 * RiskManager tests -- orchestrator that chains all 5 risk rules
 * and produces structured logging per RISK-07.
 */

import { describe, it, expect, vi } from 'vitest';
import { d, ZERO } from '../../core/decimal.js';
import { RiskManager } from '../risk-manager.js';
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
    ...overrides,
  };
}

function makeContext(overrides: Partial<RiskContext> = {}): RiskContext {
  return {
    signal: makeSignal(),
    proposedQuantity: d(0.1),
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

// ── Tests ────────────────────────────────────────────────────────────

describe('RiskManager', () => {
  it('approves when all rules pass, finalQuantity = proposedQuantity', () => {
    const config = makeRiskConfig();
    const manager = new RiskManager(config);
    // 0.1 BTC * $50000 = $5000 = 5% of $100000 -- well within all limits
    const ctx = makeContext();
    const decision = manager.evaluate(ctx);

    expect(decision.approved).toBe(true);
    expect(decision.finalQuantity.eq(d(0.1))).toBe(true);
    expect(decision.ruleResults).toHaveLength(5);
    expect(decision.rejectReason).toBeUndefined();
  });

  it('rejects when one rule fails, rejectReason is set', () => {
    const config = makeRiskConfig({ maxPositionCount: 1 });
    const manager = new RiskManager(config);
    // Already have 1 open position, limit is 1
    const ctx = makeContext({ openPositionCount: 1, riskConfig: config });
    const decision = manager.evaluate(ctx);

    expect(decision.approved).toBe(false);
    expect(decision.finalQuantity.eq(ZERO)).toBe(true);
    expect(decision.rejectReason).toBeDefined();
    expect(decision.ruleResults).toHaveLength(5);
  });

  it('uses minimum adjustedQuantity when multiple rules adjust', () => {
    // maxPositionPct = 0.10 -> allows max $10000 position = 0.2 BTC at $50k
    const config = makeRiskConfig({
      maxPositionPct: 0.10,
      maxExposurePct: 0.95,
    });
    const manager = new RiskManager(config);
    // Propose 0.5 BTC * $50000 = $25000 = 25% of $100000 > 10% cap
    const ctx = makeContext({
      proposedQuantity: d(0.5),
      proposedPrice: d(50000),
      riskConfig: config,
    });
    const decision = manager.evaluate(ctx);

    expect(decision.approved).toBe(true);
    // MaxPositionSize should adjust to 0.2 BTC ($10000 / $50000)
    expect(decision.finalQuantity.toNumber()).toBe(0.2);
  });

  it('circuit breaker trips and blocks subsequent signals', () => {
    const config = makeRiskConfig({ circuitBreakerCooldownMs: 0 });
    const manager = new RiskManager(config);

    // First: trip the breaker with 20% drawdown (> 15% limit)
    const ctx1 = makeContext({
      currentEquity: d(80000),
      peakEquity: d(100000),
      timestamp: 1700000000000,
    });
    const d1 = manager.evaluate(ctx1);
    expect(d1.approved).toBe(false);
    expect(manager.getCircuitBreakerState().tripped).toBe(true);

    // Second: even with good equity, still blocked
    const ctx2 = makeContext({
      currentEquity: d(99000),
      peakEquity: d(100000),
      timestamp: 1700000000000 + 60000,
    });
    const d2 = manager.evaluate(ctx2);
    expect(d2.approved).toBe(false);
    expect(d2.rejectReason).toContain('Circuit breaker');
  });

  it('resetCircuitBreaker clears tripped state', () => {
    const config = makeRiskConfig();
    const manager = new RiskManager(config);

    // Trip it
    const ctx = makeContext({
      currentEquity: d(80000),
      peakEquity: d(100000),
    });
    manager.evaluate(ctx);
    expect(manager.getCircuitBreakerState().tripped).toBe(true);

    // Reset it
    manager.resetCircuitBreaker();
    expect(manager.getCircuitBreakerState().tripped).toBe(false);
  });

  it('all rule results are present even when one rejects', () => {
    const config = makeRiskConfig({ maxPositionCount: 0 }); // impossible to pass
    // maxPositionCount min is 1 in Zod, but we're using raw config here
    const manager = new RiskManager(config);
    const ctx = makeContext({ openPositionCount: 1 });
    const decision = manager.evaluate(ctx);

    expect(decision.ruleResults).toHaveLength(5);
    // Every result should have rule name, inputValues, threshold
    for (const result of decision.ruleResults) {
      expect(result.rule).toBeDefined();
      expect(result.inputValues).toBeDefined();
      expect(result.threshold).toBeDefined();
    }
  });

  it('logs approved rules at info level and rejected at warn level', () => {
    // Spy on the logger module
    const config = makeRiskConfig();
    const manager = new RiskManager(config);

    // Access the private log to spy on it
    const logSpy = {
      info: vi.fn(),
      warn: vi.fn(),
    };
    // Replace the logger with our spy
    (manager as any).log = logSpy;

    const ctx = makeContext();
    manager.evaluate(ctx);

    // All 5 rules should have logged via info (all approved)
    expect(logSpy.info).toHaveBeenCalledTimes(5);
    expect(logSpy.warn).not.toHaveBeenCalled();
  });

  it('logs rejected rules at warn level', () => {
    const config = makeRiskConfig();
    const manager = new RiskManager(config);

    const logSpy = {
      info: vi.fn(),
      warn: vi.fn(),
    };
    (manager as any).log = logSpy;

    // Trip circuit breaker
    const ctx = makeContext({
      currentEquity: d(80000),
      peakEquity: d(100000),
    });
    manager.evaluate(ctx);

    // maxDrawdown should log at warn
    expect(logSpy.warn).toHaveBeenCalled();
    // Check the warn call includes the right rule name
    const warnCall = logSpy.warn.mock.calls[0];
    expect(warnCall[0].rule).toBe('max-drawdown');
  });
});
