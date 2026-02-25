/**
 * Barrel export for the correlation module.
 *
 * Exports CorrelationCalculator, CorrelationStore, configuration schema,
 * utility helpers, and types for external consumers.
 */

export { CorrelationCalculator } from './calculator.js';
export { CorrelationStore } from './correlation-store.js';
export { correlationConfigSchema, daysToCandles } from './types.js';
export type { CorrelationConfig, CorrelationSnapshot } from './types.js';
