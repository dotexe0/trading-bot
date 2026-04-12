/**
 * Risk management type system.
 *
 * Defines all types for risk evaluation: rules, context, decisions,
 * position sizing results, strategy statistics, and stop-loss configuration.
 * All financial fields use Decimal for precision.
 */

import type { Decimal } from 'decimal.js';
import type { Signal } from '../strategies/types.js';

// ── Risk Rule interface ──────────────────────────────────────────────

/** A single risk rule that independently evaluates a proposed trade. */
export interface RiskRule {
  readonly name: string;
  evaluate(context: RiskContext): RiskRuleResult;
}

// ── Risk Context ─────────────────────────────────────────────────────

/** Input to every risk rule evaluation. */
export interface RiskContext {
  /** The signal that triggered this evaluation */
  readonly signal: Signal;
  /** Quantity the position sizer calculated */
  proposedQuantity: Decimal;
  /** Expected fill price */
  proposedPrice: Decimal;
  /** Current portfolio equity */
  currentEquity: Decimal;
  /** Peak portfolio equity (for drawdown calculation) */
  peakEquity: Decimal;
  /** Available cash balance */
  cashBalance: Decimal;
  /** Number of currently open positions */
  openPositionCount: number;
  /** Sum of |position_value| as percentage of equity */
  totalExposure: Decimal;
  /** Profit/loss for the current day */
  dailyPnL: Decimal;
  /** The risk configuration in effect */
  riskConfig: RiskConfig;
  /** Current timestamp (Unix ms) */
  timestamp: number;
}

// ── Risk Rule Result ─────────────────────────────────────────────────

/** Result from a single risk rule evaluation. */
export interface RiskRuleResult {
  /** Whether the rule approves the trade */
  approved: boolean;
  /** Name of the rule that produced this result */
  rule: string;
  /** Human-readable explanation */
  reason: string;
  /** Key input values used in the evaluation (for logging) */
  inputValues: Record<string, string>;
  /** The threshold that was applied */
  threshold: string;
  /** If approved, an optional adjusted quantity (rule may reduce size) */
  adjustedQuantity?: Decimal;
}

// ── Risk Decision ────────────────────────────────────────────────────

/** Final output after all risk rules have been evaluated. */
export interface RiskDecision {
  /** Whether the trade is approved overall */
  approved: boolean;
  /** Smallest adjustedQuantity from all approving rules, or zero if rejected */
  finalQuantity: Decimal;
  /** All individual rule results (for logging/debugging) */
  ruleResults: RiskRuleResult[];
  /** First rejecting rule's reason (if rejected) */
  rejectReason?: string;
}

// ── Position Size Result ─────────────────────────────────────────────

/** Output from the position sizer. */
export interface PositionSizeResult {
  /** Which sizing method was used */
  method: 'kelly' | 'half-kelly' | 'fixed-fraction';
  /** Raw Kelly percentage before any adjustments */
  rawKellyPct: Decimal;
  /** Percentage actually applied (after fraction and cap) */
  appliedPct: Decimal;
  /** Calculated quantity to trade */
  quantity: Decimal;
  /** If the position was capped, which cap triggered */
  cappedBy?: string;
}

// ── Strategy Statistics ──────────────────────────────────────────────

/** Pre-computed strategy statistics for Kelly criterion sizing. */
export interface StrategyStats {
  /** Total number of completed trades */
  totalTrades: number;
  /** Win rate as a Decimal (e.g., 0.60 for 60%) */
  winRate: Decimal;
  /** Average winning trade return (positive Decimal) */
  avgWin: Decimal;
  /** Average losing trade return (positive Decimal, magnitude only) */
  avgLoss: Decimal;
}

// ── Stop-Loss Configuration ──────────────────────────────────────────

/** Stop-loss configuration extracted from RiskConfig. */
export interface StopLossConfig {
  /** Type of stop-loss: fixed stays at entry, trailing ratchets with price */
  type: 'fixed' | 'trailing';
  /** Stop distance as a decimal percentage (e.g., 0.05 for 5%) */
  percentage: Decimal;
}

// ── Risk Config (runtime type -- validated by Zod in config.ts) ──────

/** Fully validated risk management configuration. */
export interface RiskConfig {
  sizingMethod: 'kelly' | 'half-kelly' | 'fixed-fraction';
  kellyFraction: number;
  fixedFractionPct: number;
  maxPositionPct: number;
  minTradesForKelly: number;
  stopLoss: {
    type: 'fixed' | 'trailing';
    percentage: number;
  };
  maxDrawdownPct: number;
  maxDailyLossPct: number;
  maxExposurePct: number;
  maxPositionCount: number;
  circuitBreakerCooldownMs: number;
  /** Minimum confidence scaling factor (0-1). At confidence=0, position size is
   *  multiplied by this floor. At confidence=1, no scaling. Default 0.3. */
  confidenceFloor: number;
  /** Enable ATR-based volatility-targeted position sizing. Default false. */
  volatilitySizing?: boolean;
  /** Risk per trade as fraction of equity (e.g., 0.01 = 1%). Used when volatilitySizing is true. */
  riskPerTradePct?: number;
  /** ATR multiple for stop distance calculation. Default 2.0. */
  atrStopMultiple?: number;
  /** Enable exponential drawdown recovery scaling. Default false. */
  drawdownRecoveryScaling?: boolean;
  /** Drift detection config. */
  driftDetection?: {
    enabled: boolean;
    windowSize: number;
    sharpeThreshold: number;
    winRateTolerance: number;
  };
}
