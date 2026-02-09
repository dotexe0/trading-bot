/**
 * Decimal.js wrapper configured for financial precision.
 *
 * All financial calculations MUST use Decimal, never native JS numbers.
 * This ensures no floating-point errors in price/volume/position calculations.
 */

import Decimal from 'decimal.js';

// Configure Decimal for financial use
Decimal.set({
  precision: 20,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -9,
  toExpPos: 21,
});

/** Convenience function to create a new Decimal from a string or number. */
export function d(value: string | number): Decimal {
  return new Decimal(value);
}

/** Zero constant for comparison and initialization. */
export const ZERO = new Decimal(0);

export { Decimal };
