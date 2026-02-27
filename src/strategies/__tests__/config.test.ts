import { describe, it, expect } from 'vitest';
import { parseStrategyConfig, validateStrategyConfigs } from '../config.js';
import { StrategyConfigError } from '../../core/errors.js';

describe('parseStrategyConfig', () => {
  // -- SMA Crossover -------------------------------------------------------

  describe('sma-crossover', () => {
    it('returns defaults when only strategy is provided', () => {
      const cfg = parseStrategyConfig({ strategy: 'sma-crossover' });
      expect(cfg).toMatchObject({
        strategy: 'sma-crossover',
        fastPeriod: 10,
        slowPeriod: 20,
      });
    });

    it('preserves custom values', () => {
      const cfg = parseStrategyConfig({
        strategy: 'sma-crossover',
        fastPeriod: 5,
        slowPeriod: 50,
      });
      expect(cfg.strategy).toBe('sma-crossover');
      if (cfg.strategy === 'sma-crossover') {
        expect(cfg.fastPeriod).toBe(5);
        expect(cfg.slowPeriod).toBe(50);
      }
    });

    it('rejects fastPeriod >= slowPeriod', () => {
      expect(() =>
        parseStrategyConfig({
          strategy: 'sma-crossover',
          fastPeriod: 30,
          slowPeriod: 10,
        }),
      ).toThrow(StrategyConfigError);
    });

    it('rejects negative period', () => {
      expect(() =>
        parseStrategyConfig({
          strategy: 'sma-crossover',
          fastPeriod: -5,
        }),
      ).toThrow(StrategyConfigError);
    });
  });

  // -- RSI Mean Reversion --------------------------------------------------

  describe('rsi-mean-reversion', () => {
    it('returns defaults when only strategy is provided', () => {
      const cfg = parseStrategyConfig({ strategy: 'rsi-mean-reversion' });
      expect(cfg).toMatchObject({
        strategy: 'rsi-mean-reversion',
        period: 14,
        oversoldThreshold: 30,
        overboughtThreshold: 70,
      });
    });

    it('rejects oversoldThreshold >= overboughtThreshold', () => {
      expect(() =>
        parseStrategyConfig({
          strategy: 'rsi-mean-reversion',
          oversoldThreshold: 80,
          overboughtThreshold: 20,
        }),
      ).toThrow(StrategyConfigError);
    });
  });

  // -- MACD Momentum -------------------------------------------------------

  describe('macd-momentum', () => {
    it('returns defaults when only strategy is provided', () => {
      const cfg = parseStrategyConfig({ strategy: 'macd-momentum' });
      expect(cfg).toMatchObject({
        strategy: 'macd-momentum',
        fastPeriod: 12,
        slowPeriod: 26,
        signalPeriod: 9,
      });
    });

    it('rejects fastPeriod >= slowPeriod', () => {
      expect(() =>
        parseStrategyConfig({
          strategy: 'macd-momentum',
          fastPeriod: 30,
          slowPeriod: 10,
        }),
      ).toThrow(StrategyConfigError);
    });
  });

  // -- Bollinger Breakout --------------------------------------------------

  describe('bollinger-breakout', () => {
    it('returns defaults when only strategy is provided', () => {
      const cfg = parseStrategyConfig({ strategy: 'bollinger-breakout' });
      expect(cfg).toMatchObject({
        strategy: 'bollinger-breakout',
        period: 20,
        stdDev: 2,
        breakoutMode: true,
      });
    });

    it('accepts breakoutMode=false', () => {
      const cfg = parseStrategyConfig({
        strategy: 'bollinger-breakout',
        breakoutMode: false,
      });
      if (cfg.strategy === 'bollinger-breakout') {
        expect(cfg.breakoutMode).toBe(false);
      }
    });
  });

  // -- Multi-Timeframe Trend -----------------------------------------------

  describe('multi-timeframe-trend', () => {
    it('returns defaults when only strategy is provided', () => {
      const cfg = parseStrategyConfig({ strategy: 'multi-timeframe-trend' });
      expect(cfg).toMatchObject({
        strategy: 'multi-timeframe-trend',
        trendTimeframe: '4h',
        trendEmaPeriod: 50,
        entryEmaPeriod: 20,
        atrPeriod: 14,
      });
    });

    it('accepts custom trendTimeframe', () => {
      const cfg = parseStrategyConfig({
        strategy: 'multi-timeframe-trend',
        trendTimeframe: '1D',
      });
      if (cfg.strategy === 'multi-timeframe-trend') {
        expect(cfg.trendTimeframe).toBe('1D');
      }
    });
  });

  // -- Edge cases ----------------------------------------------------------

  describe('edge cases', () => {
    it('rejects missing strategy field', () => {
      expect(() => parseStrategyConfig({})).toThrow(StrategyConfigError);
    });

    it('rejects unknown strategy name', () => {
      expect(() =>
        parseStrategyConfig({ strategy: 'unknown' }),
      ).toThrow(StrategyConfigError);
    });

    it('thrown errors have non-empty issues array', () => {
      try {
        parseStrategyConfig({ strategy: 'unknown' });
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(StrategyConfigError);
        expect((err as StrategyConfigError).issues.length).toBeGreaterThan(0);
      }
    });
  });
});

describe('validateStrategyConfigs', () => {
  it('validates an array of valid configs', () => {
    const configs = validateStrategyConfigs([
      { strategy: 'sma-crossover' },
      { strategy: 'rsi-mean-reversion' },
    ]);
    expect(configs).toHaveLength(2);
    expect(configs[0].strategy).toBe('sma-crossover');
    expect(configs[1].strategy).toBe('rsi-mean-reversion');
  });

  it('throws on first invalid config in array', () => {
    expect(() =>
      validateStrategyConfigs([
        { strategy: 'sma-crossover' },
        { strategy: 'invalid' },
      ]),
    ).toThrow(StrategyConfigError);
  });
});
