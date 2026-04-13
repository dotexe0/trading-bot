/**
 * ExitLogicManager tests -- TDD RED phase.
 *
 * Integration-level tests verifying the priority decision tree across
 * all four exit types: partial > trailing > atrStop > time.
 */

import { describe, it, expect } from 'vitest';
import { ExitLogicManager } from '../manager.js';
import { d } from '../../../core/decimal.js';
import { MarketRegime } from '../../../regime/types.js';
import type { ExitConfig } from '../types.js';

/** Helper to build a fully-disabled ExitConfig and override specific exits. */
function makeConfig(overrides: Partial<ExitConfig['exits']> = {}): ExitConfig {
  return {
    exits: {
      trailing: {
        enabled: false,
        activateAfterPct: 0.02,
        trailAtrMultiple: 2.0,
      },
      partial: {
        enabled: false,
        profitTargetPct: 0.03,
        closeFraction: 0.5,
      },
      time: {
        enabled: false,
        maxCandlesHeld: 20,
        pnlThresholdPct: 0.0,
      },
      atrStop: {
        enabled: false,
        atrPeriod: 14,
        atrMultiple: 2.0,
      },
      ...overrides,
    },
  };
}

function candle(
  o: string,
  h: string,
  l: string,
  c: string,
  ts: number = Date.now(),
) {
  return { open: o, high: h, low: l, close: c, timestamp: ts };
}

describe('ExitLogicManager', () => {
  describe('all exits disabled', () => {
    it('always returns none', () => {
      const mgr = new ExitLogicManager(
        makeConfig(),
        d(100),
        'long',
        d(5),
      );
      const result = mgr.check(candle('100', '105', '95', '101', 1000), d(5));
      expect(result.type).toBe('none');
    });
  });

  describe('partial exit only', () => {
    it('returns partial_exit at profit target candle', () => {
      const config = makeConfig({
        partial: { enabled: true, profitTargetPct: 0.03, closeFraction: 0.5 },
      });
      const mgr = new ExitLogicManager(config, d(100), 'long', d(5));

      // Candle high=103.5 breaches target=103
      const result = mgr.check(
        candle('100', '103.5', '99', '103', 1000),
        d(5),
      );
      expect(result.type).toBe('partial_exit');
      expect(result.fillPrice.toNumber()).toBe(103);
      expect(result.fraction.toNumber()).toBe(0.5);
      expect(result.reason).toBe('partial_profit_target');
      expect(result.newStopPrice?.toNumber()).toBe(100);
    });

    it('returns none on subsequent candles after partial fires', () => {
      const config = makeConfig({
        partial: { enabled: true, profitTargetPct: 0.03, closeFraction: 0.5 },
      });
      const mgr = new ExitLogicManager(config, d(100), 'long', d(5));

      // First: triggers
      mgr.check(candle('100', '103.5', '99', '103', 1000), d(5));

      // Second: guard active → none
      const result = mgr.check(
        candle('103', '110', '102', '109', 2000),
        d(5),
      );
      expect(result.type).toBe('none');
      expect(mgr.isPartialExitFired()).toBe(true);
    });
  });

  describe('trailing exit only', () => {
    it('returns none during pre-activation candles', () => {
      const config = makeConfig({
        trailing: { enabled: true, activateAfterPct: 0.02, trailAtrMultiple: 2.0 },
      });
      const mgr = new ExitLogicManager(config, d(100), 'long', d(1));

      // high=101.5 (+1.5%) → not enough for 2% activation
      const result = mgr.check(
        candle('100', '101.5', '99', '101', 1000),
        d(1),
      );
      expect(result.type).toBe('none');
    });

    it('returns full_exit after activation and reversal', () => {
      const config = makeConfig({
        trailing: { enabled: true, activateAfterPct: 0.02, trailAtrMultiple: 2.0 },
      });
      const mgr = new ExitLogicManager(config, d(100), 'long', d(1));

      // Activate: high=102 (+2%) → trailingStop = 102 - 2*1 = 100
      mgr.check(candle('100', '102', '99', '101.5', 1000), d(1));

      // Reversal: low=99.5 (< 100) → triggers
      const result = mgr.check(
        candle('101', '101', '99.5', '100', 2000),
        d(1),
      );
      expect(result.type).toBe('full_exit');
      expect(result.reason).toBe('trailing_stop');
    });
  });

  describe('ATR stop only', () => {
    it('returns full_exit when candle breaches ATR stop', () => {
      const config = makeConfig({
        atrStop: { enabled: true, atrPeriod: 14, atrMultiple: 2.0 },
      });
      // entry=100, ATR=5, multiple=2 → stop=100-10=90
      const mgr = new ExitLogicManager(config, d(100), 'long', d(5));

      // low=89 < 90 → triggers
      const result = mgr.check(
        candle('95', '95', '89', '90', 1000),
        d(5),
      );
      expect(result.type).toBe('full_exit');
      expect(result.reason).toBe('atr_stop');
      expect(result.fillPrice.toNumber()).toBe(90);
    });
  });

  describe('time exit only', () => {
    it('returns full_exit after maxCandlesHeld with losing PnL', () => {
      const config = makeConfig({
        time: { enabled: true, maxCandlesHeld: 3, pnlThresholdPct: 0.0 },
      });
      // entry=100, losing PnL
      const mgr = new ExitLogicManager(config, d(100), 'long', d(5));

      // Candle 1: candlesHeld=1 → no exit (need 3)
      mgr.check(candle('100', '100', '99', '99', 1000), d(5));
      // Candle 2: candlesHeld=2 → no exit
      mgr.check(candle('99', '100', '98', '99', 2000), d(5));
      // Candle 3: candlesHeld=3 → exit (losing, close=98 < entry=100)
      const result = mgr.check(
        candle('99', '100', '97', '98', 3000),
        d(5),
      );
      expect(result.type).toBe('full_exit');
      expect(result.reason).toBe('time_exit');
      expect(result.fillPrice.toNumber()).toBe(98); // fills at close
    });
  });

  describe('priority: partial > trailing', () => {
    it('returns partial_exit when both partial and trailing trigger on same candle', () => {
      const config = makeConfig({
        partial: { enabled: true, profitTargetPct: 0.03, closeFraction: 0.5 },
        trailing: { enabled: true, activateAfterPct: 0.02, trailAtrMultiple: 2.0 },
      });
      const mgr = new ExitLogicManager(config, d(100), 'long', d(1));

      // First candle: activate trailing (high=102, +2%) → trailingStop = 102 - 2 = 100
      mgr.check(candle('100', '102', '99', '101.5', 1000), d(1));

      // Second candle: high=103.5 (breaches partial target=103),
      // also low=99.5 (< trailingStop=100 → trailing would trigger too)
      // Partial has higher priority → should return partial_exit
      const result = mgr.check(
        candle('101', '103.5', '99.5', '103', 2000),
        d(1),
      );
      expect(result.type).toBe('partial_exit');
      expect(result.reason).toBe('partial_profit_target');
    });
  });

  describe('candlesHeld deduplication', () => {
    it('increments candlesHeld only once per unique timestamp', () => {
      const config = makeConfig();
      const mgr = new ExitLogicManager(config, d(100), 'long', d(5));

      // Same timestamp twice
      mgr.check(candle('100', '101', '99', '100', 1000), d(5));
      mgr.check(candle('100', '101', '99', '100', 1000), d(5));

      expect(mgr.getCandlesHeld()).toBe(1);

      // Different timestamp
      mgr.check(candle('100', '101', '99', '100', 2000), d(5));
      expect(mgr.getCandlesHeld()).toBe(2);
    });
  });

  describe('getCandlesHeld', () => {
    it('returns correct count', () => {
      const config = makeConfig();
      const mgr = new ExitLogicManager(config, d(100), 'long', d(5));

      expect(mgr.getCandlesHeld()).toBe(0);

      mgr.check(candle('100', '101', '99', '100', 1000), d(5));
      expect(mgr.getCandlesHeld()).toBe(1);

      mgr.check(candle('100', '101', '99', '100', 2000), d(5));
      expect(mgr.getCandlesHeld()).toBe(2);
    });
  });

  describe('getCurrentStopPrice', () => {
    it('returns ATR stop price when atrStop is enabled', () => {
      const config = makeConfig({
        atrStop: { enabled: true, atrPeriod: 14, atrMultiple: 2.0 },
      });
      // entry=100, ATR=5, multiple=2 → stop=90
      const mgr = new ExitLogicManager(config, d(100), 'long', d(5));
      expect(mgr.getCurrentStopPrice().toNumber()).toBe(90);
    });

    it('returns entryPrice as sentinel when atrStop is disabled', () => {
      const config = makeConfig();
      const mgr = new ExitLogicManager(config, d(100), 'long', d(5));
      expect(mgr.getCurrentStopPrice().toNumber()).toBe(100);
    });
  });

  describe('breakeven floor after partial exit (plan-check warning)', () => {
    it('after partial exit fires, ATR stop will not trigger below entryPrice', () => {
      // This tests the breakeven floor: after a partial exit fires with
      // newStopPrice=entryPrice, the ATR stop must not trigger below entry.
      const config = makeConfig({
        partial: { enabled: true, profitTargetPct: 0.03, closeFraction: 0.5 },
        atrStop: { enabled: true, atrPeriod: 14, atrMultiple: 2.0 },
      });
      // entry=100, ATR=5, multiple=2 → initial ATR stop = 100 - 10 = 90
      const mgr = new ExitLogicManager(config, d(100), 'long', d(5));

      // First candle: partial exit triggers (high=103.5, target=103)
      const result1 = mgr.check(
        candle('100', '103.5', '95', '103', 1000),
        d(5),
      );
      expect(result1.type).toBe('partial_exit');
      expect(result1.newStopPrice?.toNumber()).toBe(100); // breakeven

      // After partial exit, the breakeven floor is active.
      // The ATR stop at 90 should be floored up to 100 (entryPrice).
      // So candle low=95 (above 90 but below 100) should trigger the floored stop.
      // Actually: candle low=95 < breakeven floor=100 → ATR stop fires at 100
      const result2 = mgr.check(
        candle('102', '102', '95', '96', 2000),
        d(5),
      );
      expect(result2.type).toBe('full_exit');
      expect(result2.reason).toBe('atr_stop');
      expect(result2.fillPrice.toNumber()).toBe(100); // fills at breakeven, not ATR stop of 90
    });
  });

  describe('regime-scaled ATR stop', () => {
    const regimeConfig = makeConfig({
      atrStop: {
        enabled: true,
        atrPeriod: 14,
        atrMultiple: 2.0,
        atrMultipleByRegime: {
          TRENDING: 3.0,
          RANGING: 1.5,
          VOLATILE: 2.5,
        },
      },
    });

    it('TRENDING regime selects 3.0x multiple (wider stop)', () => {
      // entry=100, ATR=5, TRENDING multiple=3.0 → stop=100-15=85
      const mgr = new ExitLogicManager(regimeConfig, d(100), 'long', d(5), MarketRegime.TRENDING);
      expect(mgr.getCurrentStopPrice().toNumber()).toBe(85);
    });

    it('RANGING regime selects 1.5x multiple (tighter stop)', () => {
      // entry=100, ATR=5, RANGING multiple=1.5 → stop=100-7.5=92.5
      const mgr = new ExitLogicManager(regimeConfig, d(100), 'long', d(5), MarketRegime.RANGING);
      expect(mgr.getCurrentStopPrice().toNumber()).toBe(92.5);
    });

    it('VOLATILE regime selects 2.5x multiple', () => {
      // entry=100, ATR=5, VOLATILE multiple=2.5 → stop=100-12.5=87.5
      const mgr = new ExitLogicManager(regimeConfig, d(100), 'long', d(5), MarketRegime.VOLATILE);
      expect(mgr.getCurrentStopPrice().toNumber()).toBe(87.5);
    });

    it('undefined regime falls back to base atrMultiple (2.0x)', () => {
      // entry=100, ATR=5, base multiple=2.0 → stop=100-10=90
      const mgr = new ExitLogicManager(regimeConfig, d(100), 'long', d(5), undefined);
      expect(mgr.getCurrentStopPrice().toNumber()).toBe(90);
    });

    it('missing atrMultipleByRegime falls back to base atrMultiple', () => {
      const noRegimeConfig = makeConfig({
        atrStop: { enabled: true, atrPeriod: 14, atrMultiple: 2.0 },
      });
      // entry=100, ATR=5, base multiple=2.0 → stop=90
      const mgr = new ExitLogicManager(noRegimeConfig, d(100), 'long', d(5), MarketRegime.TRENDING);
      expect(mgr.getCurrentStopPrice().toNumber()).toBe(90);
    });
  });
});
