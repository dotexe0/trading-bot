/**
 * Liquidation price and distance calculations for INTX perpetual futures.
 *
 * Formula (industry-standard isolated-margin approximation):
 *   LONG:  liqPrice = entryPrice * (1 - 1/leverage + maintenanceMarginRate)
 *   SHORT: liqPrice = entryPrice * (1 + 1/leverage - maintenanceMarginRate)
 *
 * Distance (% gap; positive = safe, negative = already past liquidation):
 *   LONG:  distancePct = (markPrice - liqPrice) / markPrice * 100
 *   SHORT: distancePct = (liqPrice - markPrice) / markPrice * 100
 */
import { d } from '../core/decimal.js';
import type Decimal from 'decimal.js';

export function calcLiquidationPrice(
  entryPrice: Decimal,
  leverage: number,
  direction: 'long' | 'short',
  maintenanceMarginRate: Decimal,
): Decimal {
  const lev = d(leverage);
  return direction === 'long'
    ? entryPrice.mul(d(1).minus(d(1).div(lev)).plus(maintenanceMarginRate))
    : entryPrice.mul(d(1).plus(d(1).div(lev)).minus(maintenanceMarginRate));
}

export function calcLiquidationDistance(
  markPrice: Decimal,
  liqPrice: Decimal,
  direction: 'long' | 'short',
): Decimal {
  return direction === 'long'
    ? markPrice.minus(liqPrice).div(markPrice).mul(100)
    : liqPrice.minus(markPrice).div(markPrice).mul(100);
}
