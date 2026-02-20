/**
 * RiskManager -- orchestrates all portfolio-level risk rules.
 *
 * Chains MaxPositionSize, MaxDrawdown, DailyLossLimit, MaxExposure,
 * and MaxPositionCount rules. Every evaluation produces structured
 * log entries per RISK-07.
 */

import { ZERO } from '../core/decimal.js';
import type Decimal from 'decimal.js';
import { createModuleLogger } from '../core/logger.js';
import type { RiskConfig, RiskContext, RiskDecision, RiskRuleResult } from './types.js';
import { MaxPositionSizeRule } from './rules/max-position-size.js';
import { MaxDrawdownRule } from './rules/max-drawdown.js';
import { DailyLossLimitRule } from './rules/daily-loss-limit.js';
import { MaxExposureRule } from './rules/max-exposure.js';
import { MaxPositionCountRule } from './rules/max-position-count.js';

export interface RiskEvent {
  timestamp: number;
  type: string;
  rule: string;
  message: string;
}

export class RiskManager {
  private readonly config: RiskConfig;
  private readonly maxPositionSize: MaxPositionSizeRule;
  private readonly maxDrawdown: MaxDrawdownRule;
  private readonly dailyLossLimit: DailyLossLimitRule;
  private readonly maxExposure: MaxExposureRule;
  private readonly maxPositionCount: MaxPositionCountRule;
  private readonly log;
  private lastExposurePct = 0;
  private readonly riskEvents: RiskEvent[] = [];

  constructor(config: RiskConfig) {
    this.config = config;
    this.maxPositionSize = new MaxPositionSizeRule();
    this.maxDrawdown = new MaxDrawdownRule();
    this.dailyLossLimit = new DailyLossLimitRule();
    this.maxExposure = new MaxExposureRule();
    this.maxPositionCount = new MaxPositionCountRule();
    this.log = createModuleLogger('risk-manager');
  }

  /**
   * Evaluate all risk rules against the proposed trade context.
   *
   * Runs each rule in order, logs every result, and returns a composite
   * RiskDecision. If any rule rejects, the decision is rejected.
   * If all approve, finalQuantity is the minimum of proposed and all
   * adjustedQuantity values.
   */
  evaluate(context: RiskContext): RiskDecision {
    const rules = [
      this.maxDrawdown,
      this.dailyLossLimit,
      this.maxPositionCount,
      this.maxExposure,
      this.maxPositionSize,
    ];

    const ruleResults: RiskRuleResult[] = [];
    let firstRejectReason: string | undefined;

    for (const rule of rules) {
      const result = rule.evaluate(context);
      ruleResults.push(result);

      // Log every rule result (RISK-07)
      const logData = {
        rule: result.rule,
        approved: result.approved,
        reason: result.reason,
        inputValues: result.inputValues,
        threshold: result.threshold,
        signal: {
          strategy: context.signal.strategyName,
          pair: context.signal.pair,
          direction: context.signal.direction,
          confidence: context.signal.confidence,
        },
        proposedQuantity: context.proposedQuantity.toString(),
        timestamp: context.timestamp,
      };

      if (result.approved) {
        this.log.info(logData, `Risk rule ${result.rule}: APPROVED`);
      } else {
        this.log.warn(logData, `Risk rule ${result.rule}: REJECTED`);
        if (!firstRejectReason) {
          firstRejectReason = result.reason;
        }
      }
    }

    // Track last known exposure for dashboard reporting
    this.lastExposurePct = context.totalExposure.mul(100).toNumber();

    // Record risk events for rejected rules
    for (const result of ruleResults) {
      if (!result.approved) {
        this.riskEvents.push({
          timestamp: context.timestamp,
          type: 'RULE_REJECTED',
          rule: result.rule,
          message: result.reason,
        });
      }
    }
    // Cap event log size
    if (this.riskEvents.length > 100) {
      this.riskEvents.splice(0, this.riskEvents.length - 100);
    }

    // If any rule rejected, the decision is rejected
    if (firstRejectReason) {
      return {
        approved: false,
        finalQuantity: ZERO,
        ruleResults,
        rejectReason: firstRejectReason,
      };
    }

    // All approved -- finalQuantity = min(proposedQuantity, ...adjustedQuantities)
    let finalQuantity: Decimal = context.proposedQuantity;
    for (const result of ruleResults) {
      if (result.adjustedQuantity && result.adjustedQuantity.lt(finalQuantity)) {
        finalQuantity = result.adjustedQuantity;
      }
    }

    return {
      approved: true,
      finalQuantity,
      ruleResults,
    };
  }

  /** Check if the circuit breaker is currently tripped. */
  getCircuitBreakerState(): { tripped: boolean } {
    return { tripped: this.maxDrawdown.isTripped() };
  }

  /** Manually reset the circuit breaker. */
  resetCircuitBreaker(): void {
    this.maxDrawdown.reset();
  }

  /**
   * Return current risk metrics and configuration thresholds for the dashboard.
   * Drawdown is tracked by MaxDrawdownRule across evaluations.
   * Exposure reflects the last evaluated trade context.
   */
  /** Return recent risk events (rule rejections, circuit breaker trips). */
  getRiskEvents(): RiskEvent[] {
    return [...this.riskEvents];
  }

  getCurrentRiskState(): {
    circuitBreakerTripped: boolean;
    currentDrawdownPct: number;
    currentExposurePct: number;
    thresholds: {
      maxDrawdownPct: number;
      maxExposurePct: number;
      maxDailyLossPct: number;
      maxPositionCount: number;
    };
  } {
    return {
      circuitBreakerTripped: this.maxDrawdown.isTripped(),
      currentDrawdownPct: this.maxDrawdown.getCurrentDrawdownPct(),
      currentExposurePct: this.lastExposurePct,
      thresholds: {
        maxDrawdownPct: this.config.maxDrawdownPct * 100,
        maxExposurePct: this.config.maxExposurePct * 100,
        maxDailyLossPct: this.config.maxDailyLossPct * 100,
        maxPositionCount: this.config.maxPositionCount,
      },
    };
  }
}
