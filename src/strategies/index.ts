/**
 * Strategy framework barrel export.
 *
 * Re-exports types, config validation, registry, all 5 strategy
 * implementations, and createDefaultRegistry().
 */

// Foundation
export type { IStrategy, Signal, SignalDirection } from './types.js';
export { strategyConfigSchema, parseStrategyConfig, validateStrategyConfigs } from './config.js';
export type { StrategyConfig } from './config.js';
export { StrategyRegistry } from './registry.js';

// Strategy implementations
export { SmaCrossoverStrategy } from './sma-crossover.js';
export { RsiMeanReversionStrategy } from './rsi-mean-reversion.js';
export { MacdMomentumStrategy } from './macd-momentum.js';
export { BollingerBreakoutStrategy } from './bollinger-breakout.js';
export { MultiTimeframeTrendStrategy } from './multi-timeframe-trend.js';

// Default registry with all 5 built-in strategies
import { StrategyRegistry } from './registry.js';
import { SmaCrossoverStrategy } from './sma-crossover.js';
import { RsiMeanReversionStrategy } from './rsi-mean-reversion.js';
import { MacdMomentumStrategy } from './macd-momentum.js';
import { BollingerBreakoutStrategy } from './bollinger-breakout.js';
import { MultiTimeframeTrendStrategy } from './multi-timeframe-trend.js';
import type { StrategyConfig } from './config.js';

/**
 * Create a registry pre-loaded with all 5 built-in strategies.
 *
 * Each strategy factory extracts the fields it needs from the
 * validated StrategyConfig discriminated union.
 */
export function createDefaultRegistry(): StrategyRegistry {
  const registry = new StrategyRegistry();

  registry.register('sma-crossover', (c: StrategyConfig) => {
    const cfg = c as Extract<StrategyConfig, { strategy: 'sma-crossover' }>;
    return new SmaCrossoverStrategy(cfg);
  });

  registry.register('rsi-mean-reversion', (c: StrategyConfig) => {
    const cfg = c as Extract<StrategyConfig, { strategy: 'rsi-mean-reversion' }>;
    return new RsiMeanReversionStrategy(cfg);
  });

  registry.register('macd-momentum', (c: StrategyConfig) => {
    const cfg = c as Extract<StrategyConfig, { strategy: 'macd-momentum' }>;
    return new MacdMomentumStrategy(cfg);
  });

  registry.register('bollinger-breakout', (c: StrategyConfig) => {
    const cfg = c as Extract<StrategyConfig, { strategy: 'bollinger-breakout' }>;
    return new BollingerBreakoutStrategy(cfg);
  });

  registry.register('multi-timeframe-trend', (c: StrategyConfig) => {
    const cfg = c as Extract<StrategyConfig, { strategy: 'multi-timeframe-trend' }>;
    return new MultiTimeframeTrendStrategy(cfg);
  });

  return registry;
}
