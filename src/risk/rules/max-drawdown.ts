/**
 * MaxDrawdownRule -- portfolio circuit breaker.
 *
 * Trips when portfolio drawdown from peak exceeds maxDrawdownPct.
 * Once tripped, stays tripped until:
 *   - cooldownMs > 0 AND enough time has passed -> auto-reset
 *   - cooldownMs === 0 -> never auto-resets (requires manual reset)
 */

import { d, ZERO } from '../../core/decimal.js';
import type { RiskRule, RiskContext, RiskRuleResult } from '../types.js';

export class MaxDrawdownRule implements RiskRule {
  readonly name = 'max-drawdown';

  private tripped = false;
  private tripTimestamp = 0;
  private internalPeak = ZERO;
  private lastDrawdownPct = 0;

  evaluate(context: RiskContext): RiskRuleResult {
    const { currentEquity, peakEquity, riskConfig, timestamp } = context;
    const maxDDPct = d(riskConfig.maxDrawdownPct);
    const cooldownMs = riskConfig.circuitBreakerCooldownMs;

    // Use whichever peak is higher -- external or internal tracking
    const effectivePeak = peakEquity.gt(this.internalPeak) ? peakEquity : this.internalPeak;

    // If tripped, check for cooldown reset
    if (this.tripped) {
      if (cooldownMs > 0 && (timestamp - this.tripTimestamp) >= cooldownMs) {
        // Cooldown elapsed -- reset
        this.tripped = false;
        this.internalPeak = currentEquity;
      } else {
        // Still tripped
        const drawdown = effectivePeak.isZero()
          ? ZERO
          : effectivePeak.minus(currentEquity).div(effectivePeak);
        this.lastDrawdownPct = drawdown.mul(100).toNumber();
        return {
          approved: false,
          rule: this.name,
          reason: `Circuit breaker tripped: drawdown ${drawdown.mul(100).toFixed(2)}% exceeds ${maxDDPct.mul(100).toFixed(0)}% limit`,
          inputValues: {
            currentDrawdown: `${drawdown.mul(100).toFixed(2)}%`,
            peakEquity: `$${effectivePeak.toFixed(2)}`,
            currentEquity: `$${currentEquity.toFixed(2)}`,
          },
          threshold: String(riskConfig.maxDrawdownPct),
        };
      }
    }

    // Update internal peak
    if (effectivePeak.gt(this.internalPeak)) {
      this.internalPeak = effectivePeak;
    }

    // Compute drawdown
    const drawdown = this.internalPeak.isZero()
      ? ZERO
      : this.internalPeak.minus(currentEquity).div(this.internalPeak);
    this.lastDrawdownPct = drawdown.mul(100).toNumber();

    const inputValues = {
      currentDrawdown: `${drawdown.mul(100).toFixed(2)}%`,
      peakEquity: `$${this.internalPeak.toFixed(2)}`,
      currentEquity: `$${currentEquity.toFixed(2)}`,
    };
    const threshold = String(riskConfig.maxDrawdownPct);

    if (drawdown.gte(maxDDPct)) {
      // Trip the circuit breaker
      this.tripped = true;
      this.tripTimestamp = timestamp;

      return {
        approved: false,
        rule: this.name,
        reason: `Circuit breaker tripped: drawdown ${drawdown.mul(100).toFixed(2)}% exceeds ${maxDDPct.mul(100).toFixed(0)}% limit`,
        inputValues,
        threshold,
      };
    }

    return {
      approved: true,
      rule: this.name,
      reason: `Drawdown ${drawdown.mul(100).toFixed(2)}% within ${maxDDPct.mul(100).toFixed(0)}% limit`,
      inputValues,
      threshold,
    };
  }

  /** Check if the circuit breaker is currently tripped. */
  isTripped(): boolean {
    return this.tripped;
  }

  /** Get the last evaluated drawdown as a percentage (e.g., 5.23 for 5.23%). */
  getCurrentDrawdownPct(): number {
    return this.lastDrawdownPct;
  }

  /** Manually reset the circuit breaker. */
  reset(): void {
    this.tripped = false;
    this.tripTimestamp = 0;
  }
}
