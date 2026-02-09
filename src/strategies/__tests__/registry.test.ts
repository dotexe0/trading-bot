import { describe, it, expect, beforeEach } from 'vitest';
import { StrategyRegistry } from '../registry.js';
import { StrategyConfigError } from '../../core/errors.js';
import type { IStrategy } from '../types.js';
import type { StrategyConfig } from '../config.js';

const mockFactory = (config: StrategyConfig): IStrategy => ({
  name: config.strategy,
  minCandles: 10,
  requiredIndicators: [],
  evaluate: () => [],
});

describe('StrategyRegistry', () => {
  let registry: StrategyRegistry;

  beforeEach(() => {
    registry = new StrategyRegistry();
  });

  it('has() returns false for unregistered name', () => {
    expect(registry.has('sma-crossover')).toBe(false);
  });

  it('register() + has() returns true for registered name', () => {
    registry.register('sma-crossover', mockFactory);
    expect(registry.has('sma-crossover')).toBe(true);
  });

  it('list() returns empty array on empty registry', () => {
    expect(registry.list()).toEqual([]);
  });

  it('list() returns array of registered names', () => {
    registry.register('sma-crossover', mockFactory);
    registry.register('rsi-mean-reversion', mockFactory);
    expect(registry.list()).toEqual(['sma-crossover', 'rsi-mean-reversion']);
  });

  it('create() with valid config calls factory and returns IStrategy', () => {
    registry.register('sma-crossover', mockFactory);
    const strategy = registry.create({ strategy: 'sma-crossover' });
    expect(strategy.name).toBe('sma-crossover');
    expect(strategy.minCandles).toBe(10);
    expect(strategy.requiredIndicators).toEqual([]);
    expect(strategy.evaluate([], 'BTC-USD', '1h')).toEqual([]);
  });

  it('create() with invalid config throws StrategyConfigError before factory lookup', () => {
    // No factory registered, but error should come from config validation, not factory lookup
    expect(() => registry.create({})).toThrow(StrategyConfigError);
  });

  it('register() same name twice throws Error', () => {
    registry.register('sma-crossover', mockFactory);
    expect(() => registry.register('sma-crossover', mockFactory)).toThrow(
      'Strategy already registered: sma-crossover',
    );
  });
});
