/**
 * TimeBasedExit tests -- TDD RED phase.
 *
 * Tests EXIT-03: Time-based exit that triggers when a position has been
 * held for too many candles and PnL is below a configurable threshold.
 */

import { describe, it, expect } from 'vitest';
import { TimeBasedExit } from '../time.js';
import { d } from '../../../core/decimal.js';

describe('TimeBasedExit', () => {
  describe('maxCandlesHeld=5, pnlThresholdPct=0.0', () => {
    const config = { enabled: true, maxCandlesHeld: 5, pnlThresholdPct: 0.0 };

    it('returns none when candlesHeld < maxCandlesHeld', () => {
      const time = new TimeBasedExit(config);
      const result = time.check(4, d(-0.01), { close: '99' });
      expect(result.type).toBe('none');
    });

    it('returns full_exit when candlesHeld >= maxCandlesHeld and PnL below threshold', () => {
      const time = new TimeBasedExit(config);
      const result = time.check(5, d(-0.01), { close: '99' });
      expect(result.type).toBe('full_exit');
      expect(result.reason).toBe('time_exit');
      expect(result.fillPrice.toNumber()).toBe(99); // fills at close
      expect(result.fraction.toNumber()).toBe(1);
    });

    it('returns none when candlesHeld >= maxCandlesHeld but PnL above threshold', () => {
      const time = new TimeBasedExit(config);
      const result = time.check(5, d(0.01), { close: '101' });
      expect(result.type).toBe('none');
    });
  });

  describe('negative pnlThresholdPct', () => {
    const config = { enabled: true, maxCandlesHeld: 10, pnlThresholdPct: -0.02 };

    it('returns none when PnL is above the negative threshold', () => {
      // pnlThresholdPct=-0.02, PnL=-0.015 (above -2%) → no exit
      const time = new TimeBasedExit(config);
      const result = time.check(10, d(-0.015), { close: '98.5' });
      expect(result.type).toBe('none');
    });

    it('returns full_exit when PnL is below the negative threshold', () => {
      // pnlThresholdPct=-0.02, PnL=-0.03 (below -2%) → exit
      const time = new TimeBasedExit(config);
      const result = time.check(10, d(-0.03), { close: '97' });
      expect(result.type).toBe('full_exit');
      expect(result.reason).toBe('time_exit');
      expect(result.fillPrice.toNumber()).toBe(97);
    });
  });
});
