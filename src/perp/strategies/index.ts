/**
 * Perp strategies barrel export.
 *
 * Re-exports all perp strategy implementations and provides two registry
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
import { FundingRateArbitrageStrategy } from './funding-rate-arb.js';
import { BasisTradeStrategy } from './basis-trade.js';
import { PerpVwapReversionStrategy } from './perp-vwap-reversion.js';
import { PerpMicroMomentumStrategy } from './perp-micro-momentum.js';
import type { StrategyConfig } from '../../strategies/config.js';

export { PerpMomentumStrategy } from './perp-momentum.js';
export { PerpMeanReversionStrategy } from './perp-mean-reversion.js';
export { FundingRateArbitrageStrategy } from './funding-rate-arb.js';
export { BasisTradeStrategy } from './basis-trade.js';
export { PerpVwapReversionStrategy } from './perp-vwap-reversion.js';
export { PerpMicroMomentumStrategy } from './perp-micro-momentum.js';

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
      maxHoldCandles: (cfg as Record<string, unknown>).maxHoldCandles as number | undefined,
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

  registry.register('funding-rate-arb', (c: StrategyConfig) => {
    const cfg = c as Extract<StrategyConfig, { strategy: 'funding-rate-arb' }>;
    return new FundingRateArbitrageStrategy({
      threshold: cfg.threshold ?? 0.0005,
      markPriceProvider: () => null,
      tournamentMode: true, // always true in tournament/backtest registry
    });
  });

  registry.register('basis-trade', (c: StrategyConfig) => {
    const cfg = c as Extract<StrategyConfig, { strategy: 'basis-trade' }>;
    return new BasisTradeStrategy({
      period: cfg.period ?? 20,
      threshold: cfg.threshold ?? 1.5,
      basisProvider: () => null, // no live basis data in tournament
    });
  });

  registry.register('perp-vwap-reversion', (c: StrategyConfig) => {
    const cfg = c as Extract<StrategyConfig, { strategy: 'perp-vwap-reversion' }>;
    return new PerpVwapReversionStrategy({
      vwapPeriod: cfg.vwapPeriod ?? 15,
      zScoreThreshold: cfg.zScoreThreshold ?? 1.5,
      maxHoldCandles: cfg.maxHoldCandles ?? 8,
      stopLossPct: cfg.stopLossPct ?? 0.005,
      fundingThreshold: cfg.fundingThreshold ?? 0.01,
      fundingRateProvider: () => null,
    });
  });

  registry.register('perp-micro-momentum', (c: StrategyConfig) => {
    const cfg = c as Extract<StrategyConfig, { strategy: 'perp-micro-momentum' }>;
    return new PerpMicroMomentumStrategy({
      fastEmaPeriod: cfg.fastEmaPeriod ?? 5,
      slowEmaPeriod: cfg.slowEmaPeriod ?? 12,
      rsiPeriod: cfg.rsiPeriod ?? 7,
      volumeWindow: cfg.volumeWindow ?? 5,
      volumeMultiplier: cfg.volumeMultiplier ?? 1.5,
      maxHoldCandles: cfg.maxHoldCandles ?? 8,
      stopLossPct: cfg.stopLossPct ?? 0.005,
      fundingThreshold: cfg.fundingThreshold ?? 0.01,
      fundingRateProvider: () => null,
    });
  });

  return registry;
}

/**
 * Create a registry pre-loaded with all four perp strategies, wired with a real
 * funding rate provider.
 *
 * For live / paper engine use — the passed-in provider is injected into each
 * strategy so funding adjustments fire at runtime when the rate exceeds
 * threshold.
 *
 * @param fundingRateProvider - Synchronous callback returning the current
 *   funding rate, or null if unavailable.
 * @param markPriceProvider - Optional synchronous callback returning current
 *   {markPrice, indexPrice} from the latest IntxMarkPriceEvent. Defaults to
 *   () => null until Phase 40 wires the real IntxClient cache. All existing
 *   callers of createLivePerpRegistry(fundingRateProvider) continue to compile
 *   unchanged.
 */
export function createLivePerpRegistry(
  fundingRateProvider: () => number | null,
  markPriceProvider?: () => { markPrice: string; indexPrice: string } | null,
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
      maxHoldCandles: (cfg as Record<string, unknown>).maxHoldCandles as number | undefined,
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

  registry.register('funding-rate-arb', (c: StrategyConfig) => {
    const cfg = c as Extract<StrategyConfig, { strategy: 'funding-rate-arb' }>;
    return new FundingRateArbitrageStrategy({
      threshold: cfg.threshold ?? 0.0005,
      markPriceProvider: markPriceProvider ?? (() => null),
      tournamentMode: false,
    });
  });

  registry.register('basis-trade', (c: StrategyConfig) => {
    const cfg = c as Extract<StrategyConfig, { strategy: 'basis-trade' }>;
    return new BasisTradeStrategy({
      period: cfg.period ?? 20,
      threshold: cfg.threshold ?? 1.5,
      basisProvider: () => null, // live basisProvider wired in Phase 40 when ring buffer is implemented
    });
  });

  registry.register('perp-vwap-reversion', (c: StrategyConfig) => {
    const cfg = c as Extract<StrategyConfig, { strategy: 'perp-vwap-reversion' }>;
    return new PerpVwapReversionStrategy({
      vwapPeriod: cfg.vwapPeriod ?? 15,
      zScoreThreshold: cfg.zScoreThreshold ?? 1.5,
      maxHoldCandles: cfg.maxHoldCandles ?? 8,
      stopLossPct: cfg.stopLossPct ?? 0.005,
      fundingThreshold: cfg.fundingThreshold ?? 0.01,
      fundingRateProvider,
    });
  });

  registry.register('perp-micro-momentum', (c: StrategyConfig) => {
    const cfg = c as Extract<StrategyConfig, { strategy: 'perp-micro-momentum' }>;
    return new PerpMicroMomentumStrategy({
      fastEmaPeriod: cfg.fastEmaPeriod ?? 5,
      slowEmaPeriod: cfg.slowEmaPeriod ?? 12,
      rsiPeriod: cfg.rsiPeriod ?? 7,
      volumeWindow: cfg.volumeWindow ?? 5,
      volumeMultiplier: cfg.volumeMultiplier ?? 1.5,
      maxHoldCandles: cfg.maxHoldCandles ?? 8,
      stopLossPct: cfg.stopLossPct ?? 0.005,
      fundingThreshold: cfg.fundingThreshold ?? 0.01,
      fundingRateProvider,
    });
  });

  return registry;
}
