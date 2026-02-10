/**
 * MaxPositionCountRule -- limits the number of concurrent open positions.
 *
 * Simple count check: if openPositionCount >= maxPositionCount, reject.
 */

import type { RiskRule, RiskContext, RiskRuleResult } from '../types.js';

export class MaxPositionCountRule implements RiskRule {
  readonly name = 'max-position-count';

  evaluate(context: RiskContext): RiskRuleResult {
    const { openPositionCount, riskConfig } = context;
    const maxCount = riskConfig.maxPositionCount;

    const inputValues = {
      currentCount: String(openPositionCount),
    };
    const threshold = String(maxCount);

    if (openPositionCount >= maxCount) {
      return {
        approved: false,
        rule: this.name,
        reason: `Open position count ${openPositionCount} meets or exceeds limit of ${maxCount}`,
        inputValues,
        threshold,
      };
    }

    return {
      approved: true,
      rule: this.name,
      reason: `Open position count ${openPositionCount} within limit of ${maxCount}`,
      inputValues,
      threshold,
    };
  }
}
