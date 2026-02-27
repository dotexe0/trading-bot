/**
 * Strategy schema exits merge tests -- TDD RED phase.
 *
 * Tests that all 5 strategy schemas accept an optional exits block
 * with proper defaults from exitConfigSchema.
 */

import { describe, it, expect } from 'vitest';
import { parseStrategyConfig } from '../config.js';

describe('strategy schemas with exits merge', () => {
  it('sma-crossover includes exits defaults when not specified', () => {
    const cfg = parseStrategyConfig({
      strategy: 'sma-crossover',
      fastPeriod: 5,
      slowPeriod: 20,
    });
    expect(cfg.exits.trailing.enabled).toBe(false);
    expect(cfg.exits.partial.enabled).toBe(false);
    expect(cfg.exits.time.enabled).toBe(false);
    expect(cfg.exits.atrStop.enabled).toBe(false);
  });

  it('sma-crossover accepts exits with trailing enabled', () => {
    const cfg = parseStrategyConfig({
      strategy: 'sma-crossover',
      fastPeriod: 5,
      slowPeriod: 20,
      exits: { trailing: { enabled: true } },
    });
    expect(cfg.exits.trailing.enabled).toBe(true);
  });

  it('rsi-mean-reversion includes exits defaults', () => {
    const cfg = parseStrategyConfig({
      strategy: 'rsi-mean-reversion',
    });
    expect(cfg.exits.trailing.enabled).toBe(false);
    expect(cfg.exits.atrStop.atrPeriod).toBe(14);
  });

  it('rsi-mean-reversion accepts custom exits', () => {
    const cfg = parseStrategyConfig({
      strategy: 'rsi-mean-reversion',
      exits: { atrStop: { enabled: true, atrMultiple: 3.0 } },
    });
    expect(cfg.exits.atrStop.enabled).toBe(true);
    expect(cfg.exits.atrStop.atrMultiple).toBe(3.0);
  });

  it('macd-momentum includes exits defaults', () => {
    const cfg = parseStrategyConfig({
      strategy: 'macd-momentum',
    });
    expect(cfg.exits.partial.closeFraction).toBe(0.5);
  });

  it('bollinger-breakout includes exits defaults', () => {
    const cfg = parseStrategyConfig({
      strategy: 'bollinger-breakout',
    });
    expect(cfg.exits.atrStop.atrPeriod).toBe(14);
    expect(cfg.exits.time.maxCandlesHeld).toBe(20);
  });

  it('multi-timeframe-trend includes exits defaults', () => {
    const cfg = parseStrategyConfig({
      strategy: 'multi-timeframe-trend',
    });
    expect(cfg.exits.trailing.activateAfterPct).toBe(0.02);
    expect(cfg.exits.atrStop.enabled).toBe(false);
  });

  it('sma-crossover refinement still works with exits', () => {
    // fastPeriod >= slowPeriod should still be rejected
    expect(() =>
      parseStrategyConfig({
        strategy: 'sma-crossover',
        fastPeriod: 30,
        slowPeriod: 10,
        exits: { trailing: { enabled: true } },
      }),
    ).toThrow();
  });

  it('macd-momentum refinement still works with exits', () => {
    expect(() =>
      parseStrategyConfig({
        strategy: 'macd-momentum',
        fastPeriod: 30,
        slowPeriod: 10,
        exits: { trailing: { enabled: true } },
      }),
    ).toThrow();
  });
});
