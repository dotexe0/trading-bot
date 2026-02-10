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

export class RiskManager {
  private readonly config: RiskConfig;
  private readonly maxPositionSize: MaxPositionSizeRule;
  private readonly maxDrawdown: MaxDrawdownRule;
  private readonly dailyLossLimit: DailyLossLimitRule;
  private readonly maxExposure: MaxExposureRule;
  private readonly maxPositionCount: MaxPositionCountRule;
  private readonly log;

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
}
