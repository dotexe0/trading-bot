/**
 * Backtest module barrel export.
 *
 * Provides the complete public API for backtesting:
 * - Types and config validation
 * - Fill simulation with slippage/fees
 * - Portfolio tracking
 * - Backtest engine (event-driven replay)
 * - Performance metrics calculation
 * - Walk-forward validation
 * - Strategy comparison
 */

// Types and config
export {
  backtestConfigSchema,
  parseBacktestConfig,
  COINBASE_FEE_TIERS,
  DEFAULT_FEE_MAKER,
  DEFAULT_FEE_TAKER,
} from './types.js';
export type {
  BacktestConfig,
  SimulatedFill,
  Trade,
  EquityPoint,
  BacktestResult,
} from './types.js';

// Fill simulation
export { FillSimulator } from './fill-simulator.js';
export type { FillSimulatorConfig } from './fill-simulator.js';

// Portfolio tracking
export { PortfolioTracker } from './portfolio.js';
export type { PortfolioState } from './portfolio.js';

// Engine
export { BacktestEngine } from './engine.js';

// Metrics
export { MetricsCalculator } from './metrics.js';
export type { PerformanceMetrics } from './metrics.js';

// Walk-forward validation
export { WalkForwardRunner, generateWindows, walkForwardConfigSchema } from './walk-forward.js';
export type {
  WalkForwardConfig,
  WalkForwardWindow,
  WalkForwardWindowResult,
  WalkForwardResult,
} from './walk-forward.js';

// Strategy comparison
export { StrategyComparator } from './comparison.js';
export type { ComparisonEntry, ComparisonReport } from './comparison.js';
