import { describe, it, expect } from 'vitest';
import { d } from '../../core/decimal.js';
import { MaxDrawdownRule } from '../rules/max-drawdown.js';
import type { RiskContext } from '../types.js';

function makeContext(equity: number, peak: number, maxDD = 0.10): RiskContext {
  return {
    signal: {
      strategyName: 'test', pair: 'BTC-USD', timeframe: '1h',
      timestamp: Date.now(), direction: 'long', confidence: 1,
    } as any,
    proposedQuantity: d(1),
    proposedPrice: d(50000),
    currentEquity: d(equity),
    peakEquity: d(peak),
    cashBalance: d(equity),
    openPositionCount: 0,
    totalExposure: d(0),
    dailyPnL: d(0),
    riskConfig: {
      sizingMethod: 'half-kelly', kellyFraction: 0.5, fixedFractionPct: 0.02,
      maxPositionPct: 0.25, minTradesForKelly: 30,
      stopLoss: { type: 'fixed', percentage: 0.05 },
      maxDrawdownPct: maxDD, maxDailyLossPct: 0.05, maxExposurePct: 0.95,
      maxPositionCount: 4, circuitBreakerCooldownMs: 0, confidenceFloor: 0.3,
      drawdownRecoveryScaling: true,
    } as any,
    timestamp: Date.now(),
  };
}

describe('MaxDrawdownRule.getRecoveryScale', () => {
  it('returns 1.0 at 0% drawdown', () => {
    const rule = new MaxDrawdownRule();
    rule.evaluate(makeContext(10000, 10000));
    expect(rule.getRecoveryScale(0.10, true)).toBeCloseTo(1.0);
  });

  it('returns ~0.75 at 5% drawdown with 10% maxDD', () => {
    const rule = new MaxDrawdownRule();
    rule.evaluate(makeContext(9500, 10000));
    // scale = 1 - (0.05/0.10)^2 = 1 - 0.25 = 0.75
    expect(rule.getRecoveryScale(0.10, true)).toBeCloseTo(0.75, 2);
  });

  it('returns ~0.36 at 8% drawdown', () => {
    const rule = new MaxDrawdownRule();
    rule.evaluate(makeContext(9200, 10000));
    // scale = 1 - (0.08/0.10)^2 = 1 - 0.64 = 0.36
    expect(rule.getRecoveryScale(0.10, true)).toBeCloseTo(0.36, 2);
  });

  it('returns 0 at maxDD', () => {
    const rule = new MaxDrawdownRule();
    rule.evaluate(makeContext(9000, 10000));
    expect(rule.getRecoveryScale(0.10, true)).toBeCloseTo(0.0, 2);
  });

  it('returns 1.0 when feature disabled', () => {
    const rule = new MaxDrawdownRule();
    rule.evaluate(makeContext(9500, 10000));
    expect(rule.getRecoveryScale(0.10, false)).toBe(1.0);
  });

  it('clamps scale to [0, 1]', () => {
    const rule = new MaxDrawdownRule();
    rule.evaluate(makeContext(8000, 10000)); // 20% DD > 10% maxDD
    const scale = rule.getRecoveryScale(0.10, true);
    expect(scale).toBeGreaterThanOrEqual(0);
    expect(scale).toBeLessThanOrEqual(1);
  });
});
