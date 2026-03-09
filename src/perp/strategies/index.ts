/**
 * Perp strategies barrel export.
 *
 * Re-exports both perp strategy implementations and provides two registry
 * factory functions:
 *
 * - createPerpRegistry(): for tournament / backtesting use where fundingRateProvider
 *   returns null (no adjustment applied — tournament-safe).
 * - createLivePerpRegistry(provider): for live/paper engine use where a real
 *   fundingRateProvider is injected so funding adjustments fire at runtime.
 *
 * INVARIANT: These registries are entirely separate from createDefaultRegistry().
 * No spot strategies appear in perp registries, and no perp strategies appear
 * in the spot registry.
 */

import { StrategyRegistry } from '../../strategies/registry.js';
import { PerpMomentumStrategy } from './perp-momentum.js';
import { PerpMeanReversionStrategy } from './perp-mean-reversion.js';
import type { StrategyConfig } from '../../strategies/config.js';

export { PerpMomentumStrategy } from './perp-momentum.js';
export { PerpMeanReversionStrategy } from './perp-mean-reversion.js';

/**
 * Create a registry pre-loaded with both perp strategies.
 *
 * For tournament / backtesting — fundingRateProvider returns null so no
 * funding adjustment is applied (safe when no live funding data is available).
 */
export function createPerpRegistry(): StrategyRegistry {
  const registry = new StrategyRegistry();

  registry.register('perp-momentum', (c: StrategyConfig) => {
    const cfg = c as Extract<StrategyConfig, { strategy: 'perp-momentum' }>;
    return new PerpMomentumStrategy({
      breakoutWindow: cfg.breakoutWindow ?? 20,
      volumeWindow: cfg.volumeWindow ?? 20,
      volumeMultiplier: cfg.volumeMultiplier ?? 1.5,
      fundingThreshold: cfg.fundingThreshold ?? 0.01,
      fundingRateProvider: () => null,
    });
  });

  registry.register('perp-mean-reversion', (c: StrategyConfig) => {
    const cfg = c as Extract<StrategyConfig, { strategy: 'perp-mean-reversion' }>;
    return new PerpMeanReversionStrategy({
      period: cfg.period ?? 20,
      threshold: cfg.threshold ?? 1.5,
      fundingThreshold: cfg.fundingThreshold ?? 0.01,
      fundingRateProvider: () => null,
    });
  });

  return registry;
}

/**
 * Create a registry pre-loaded with both perp strategies, wired with a real
 * funding rate provider.
 *
 * For live / paper engine use — the passed-in provider is injected into each
 * strategy so funding adjustments fire at runtime when the rate exceeds
 * threshold.
 *
 * @param fundingRateProvider - Synchronous callback returning the current
 *   funding rate, or null if unavailable.
 */
export function createLivePerpRegistry(
  fundingRateProvider: () => number | null,
): StrategyRegistry {
  const registry = new StrategyRegistry();

  registry.register('perp-momentum', (c: StrategyConfig) => {
    const cfg = c as Extract<StrategyConfig, { strategy: 'perp-momentum' }>;
    return new PerpMomentumStrategy({
      breakoutWindow: cfg.breakoutWindow ?? 20,
      volumeWindow: cfg.volumeWindow ?? 20,
      volumeMultiplier: cfg.volumeMultiplier ?? 1.5,
      fundingThreshold: cfg.fundingThreshold ?? 0.01,
      fundingRateProvider,
    });
  });

  registry.register('perp-mean-reversion', (c: StrategyConfig) => {
    const cfg = c as Extract<StrategyConfig, { strategy: 'perp-mean-reversion' }>;
    return new PerpMeanReversionStrategy({
      period: cfg.period ?? 20,
      threshold: cfg.threshold ?? 1.5,
      fundingThreshold: cfg.fundingThreshold ?? 0.01,
      fundingRateProvider,
    });
  });

  return registry;
}
