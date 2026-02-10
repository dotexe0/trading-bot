/**
 * MaxExposureRule -- caps total portfolio exposure.
 *
 * Checks if adding the proposed position would push total exposure
 * (sum of |position_value| / equity) beyond maxExposurePct.
 */

import { d, ZERO } from '../../core/decimal.js';
import type { RiskRule, RiskContext, RiskRuleResult } from '../types.js';

export class MaxExposureRule implements RiskRule {
  readonly name = 'max-exposure';

  evaluate(context: RiskContext): RiskRuleResult {
    const { proposedQuantity, proposedPrice, currentEquity, totalExposure, riskConfig } = context;
    const maxExposurePct = d(riskConfig.maxExposurePct);

    // Compute proposed addition to exposure
    const proposedExposure = currentEquity.isZero()
      ? ZERO
      : proposedQuantity.mul(proposedPrice).div(currentEquity);

    const newExposure = totalExposure.plus(proposedExposure);

    const inputValues = {
      currentExposure: `${totalExposure.mul(100).toFixed(2)}%`,
      proposedExposure: `${proposedExposure.mul(100).toFixed(2)}%`,
      newTotalExposure: `${newExposure.mul(100).toFixed(2)}%`,
    };
    const threshold = String(riskConfig.maxExposurePct);

    if (newExposure.gt(maxExposurePct)) {
      return {
        approved: false,
        rule: this.name,
        reason: `Total exposure would be ${newExposure.mul(100).toFixed(2)}%, exceeding ${maxExposurePct.mul(100).toFixed(0)}% cap`,
        inputValues,
        threshold,
      };
    }

    return {
      approved: true,
      rule: this.name,
      reason: `Total exposure ${newExposure.mul(100).toFixed(2)}% within ${maxExposurePct.mul(100).toFixed(0)}% cap`,
      inputValues,
      threshold,
    };
  }
}
