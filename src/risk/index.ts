/**
 * Risk management module barrel export.
 *
 * Re-exports all risk types, config, position sizer, stop-loss tracker,
 * risk manager, and individual risk rules.
 */

// Types
export type {
  RiskRule,
  RiskContext,
  RiskRuleResult,
  RiskDecision,
  PositionSizeResult,
  StrategyStats,
  StopLossConfig,
  RiskConfig,
} from './types.js';

// Config
export { riskConfigSchema, parseRiskConfig } from './config.js';

// Core components
export { PositionSizer } from './position-sizer.js';
export { StopLossTracker } from './stop-loss.js';
export { RiskManager } from './risk-manager.js';
export type { RiskEvent } from './risk-manager.js';

// Individual rules
export { MaxPositionSizeRule } from './rules/max-position-size.js';
export { MaxDrawdownRule } from './rules/max-drawdown.js';
export { DailyLossLimitRule } from './rules/daily-loss-limit.js';
export { MaxExposureRule } from './rules/max-exposure.js';
export { MaxPositionCountRule } from './rules/max-position-count.js';
