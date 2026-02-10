/**
 * DailyLossLimitRule -- blocks new entries when daily loss exceeds limit.
 *
 * Tracks the UTC day and start-of-day equity. Resets at UTC midnight
 * boundaries. Computes daily loss as (startOfDayEquity - currentEquity) / startOfDayEquity.
 */

import { d, ZERO } from '../../core/decimal.js';
import type { RiskRule, RiskContext, RiskRuleResult } from '../types.js';

export class DailyLossLimitRule implements RiskRule {
  readonly name = 'daily-loss-limit';

  private currentDay = -1;
  private startOfDayEquity = ZERO;

  evaluate(context: RiskContext): RiskRuleResult {
    const { currentEquity, riskConfig, timestamp } = context;
    const maxDailyLossPct = d(riskConfig.maxDailyLossPct);

    // Determine UTC day from timestamp
    const utcDay = Math.floor(timestamp / 86_400_000);

    // Reset on new day
    if (utcDay !== this.currentDay) {
      this.currentDay = utcDay;
      this.startOfDayEquity = currentEquity;
    }

    // Compute daily loss
    const dailyLoss = this.startOfDayEquity.isZero()
      ? ZERO
      : this.startOfDayEquity.minus(currentEquity).div(this.startOfDayEquity);

    const inputValues = {
      dailyLossPct: `${dailyLoss.mul(100).toFixed(2)}%`,
      startOfDayEquity: `$${this.startOfDayEquity.toFixed(2)}`,
    };
    const threshold = String(riskConfig.maxDailyLossPct);

    if (dailyLoss.gte(maxDailyLossPct)) {
      return {
        approved: false,
        rule: this.name,
        reason: `Daily loss ${dailyLoss.mul(100).toFixed(2)}% exceeds ${maxDailyLossPct.mul(100).toFixed(0)}% limit`,
        inputValues,
        threshold,
      };
    }

    return {
      approved: true,
      rule: this.name,
      reason: `Daily loss ${dailyLoss.mul(100).toFixed(2)}% within ${maxDailyLossPct.mul(100).toFixed(0)}% limit`,
      inputValues,
      threshold,
    };
  }
}
