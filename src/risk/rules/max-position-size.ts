/**
 * MaxPositionSizeRule -- caps individual position size as a percentage of equity.
 *
 * If a proposed position would exceed maxPositionPct of equity, the rule
 * either rejects (if already over) or adjusts quantity down to the cap.
 */

import { d, ZERO } from '../../core/decimal.js';
import type { RiskRule, RiskContext, RiskRuleResult } from '../types.js';

export class MaxPositionSizeRule implements RiskRule {
  readonly name = 'max-position-size';

  evaluate(context: RiskContext): RiskRuleResult {
    const { proposedQuantity, proposedPrice, currentEquity, riskConfig } = context;
    const maxPct = d(riskConfig.maxPositionPct);

    const positionValue = proposedQuantity.mul(proposedPrice);
    const positionValuePct = currentEquity.isZero()
      ? d(0)
      : positionValue.div(currentEquity);

    const inputValues = {
      positionValuePct: `${positionValuePct.mul(100).toFixed(2)}%`,
      equity: `$${currentEquity.toFixed(2)}`,
    };
    const threshold = String(riskConfig.maxPositionPct);

    if (positionValuePct.lte(maxPct)) {
      // Within cap -- approved as-is
      return {
        approved: true,
        rule: this.name,
        reason: `Position size ${positionValuePct.mul(100).toFixed(2)}% within ${maxPct.mul(100).toFixed(0)}% cap`,
        inputValues,
        threshold,
      };
    }

    // Over cap -- provide adjusted quantity that fits within the limit
    const maxValue = currentEquity.mul(maxPct);
    const adjustedQuantity = proposedPrice.isZero()
      ? ZERO
      : maxValue.div(proposedPrice);

    if (adjustedQuantity.lte(ZERO)) {
      return {
        approved: false,
        rule: this.name,
        reason: `Position size ${positionValuePct.mul(100).toFixed(2)}% exceeds ${maxPct.mul(100).toFixed(0)}% cap and cannot be reduced`,
        inputValues,
        threshold,
      };
    }

    return {
      approved: true,
      rule: this.name,
      reason: `Position size reduced from ${positionValuePct.mul(100).toFixed(2)}% to ${maxPct.mul(100).toFixed(0)}% cap`,
      inputValues,
      threshold,
      adjustedQuantity,
    };
  }
}
