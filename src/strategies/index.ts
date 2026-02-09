/**
 * Strategy framework barrel export.
 *
 * Re-exports types, config validation, and registry.
 * Strategy implementations will be added in Plan 02.
 */

export type { IStrategy, Signal, SignalDirection } from './types.js';
export { strategyConfigSchema, parseStrategyConfig, validateStrategyConfigs } from './config.js';
export type { StrategyConfig } from './config.js';
export { StrategyRegistry } from './registry.js';
