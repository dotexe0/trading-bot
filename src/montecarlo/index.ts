/**
 * Monte Carlo simulation module.
 *
 * Public barrel exports for types, config validation, and engine.
 */

export {
  monteCarloConfigSchema,
  parseMonteCarloConfig,
  type MonteCarloConfig,
  type MonteCarloResult,
  type PercentileDistribution,
} from './types.js';

export { MonteCarloEngine } from './monte-carlo-engine.js';

export { MonteCarloStore } from './monte-carlo-store.js';
