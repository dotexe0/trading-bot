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

  // -- Z-Score Mean Reversion ------------------------------------------------

  describe('z-score-mean-reversion', () => {
    it('returns defaults when only strategy is provided', () => {
      const cfg = parseStrategyConfig({ strategy: 'z-score-mean-reversion' });
      expect(cfg).toMatchObject({
        strategy: 'z-score-mean-reversion',
        period: 20,
        threshold: 1.5,
      });
    });

    it('preserves custom values', () => {
      const cfg = parseStrategyConfig({
        strategy: 'z-score-mean-reversion',
        period: 30,
        threshold: 2.0,
      });
      expect(cfg.strategy).toBe('z-score-mean-reversion');
      if (cfg.strategy === 'z-score-mean-reversion') {
        expect(cfg.period).toBe(30);
        expect(cfg.threshold).toBe(2.0);
      }
    });

    it('rejects threshold <= 0', () => {
      expect(() =>
        parseStrategyConfig({
          strategy: 'z-score-mean-reversion',
          threshold: 0,
        }),
      ).toThrow(StrategyConfigError);
    });

    it('rejects negative threshold', () => {
      expect(() =>
        parseStrategyConfig({
          strategy: 'z-score-mean-reversion',
          threshold: -1,
        }),
      ).toThrow(StrategyConfigError);
    });

    it('rejects period <= 0', () => {
      expect(() =>
        parseStrategyConfig({
          strategy: 'z-score-mean-reversion',
          period: 0,
        }),
      ).toThrow(StrategyConfigError);
    });

    it('rejects non-integer period', () => {
      expect(() =>
        parseStrategyConfig({
          strategy: 'z-score-mean-reversion',
          period: 10.5,
        }),
      ).toThrow(StrategyConfigError);
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

  // -- Momentum Breakout ----------------------------------------------------

  describe('momentum-breakout', () => {
    it('returns defaults when only strategy is provided', () => {
      const cfg = parseStrategyConfig({ strategy: 'momentum-breakout' });
      expect(cfg).toMatchObject({
        strategy: 'momentum-breakout',
        breakoutWindow: 20,
        volumeWindow: 20,
        volumeMultiplier: 1.5,
      });
    });

    it('preserves custom values', () => {
      const cfg = parseStrategyConfig({
        strategy: 'momentum-breakout',
        breakoutWindow: 10,
        volumeWindow: 15,
        volumeMultiplier: 2.0,
      });
      expect(cfg.strategy).toBe('momentum-breakout');
      if (cfg.strategy === 'momentum-breakout') {
        expect(cfg.breakoutWindow).toBe(10);
        expect(cfg.volumeWindow).toBe(15);
        expect(cfg.volumeMultiplier).toBe(2.0);
      }
    });

    it('rejects non-positive breakoutWindow', () => {
      expect(() =>
        parseStrategyConfig({ strategy: 'momentum-breakout', breakoutWindow: 0 }),
      ).toThrow(StrategyConfigError);
    });

    it('rejects non-integer breakoutWindow', () => {
      expect(() =>
        parseStrategyConfig({ strategy: 'momentum-breakout', breakoutWindow: 5.5 }),
      ).toThrow(StrategyConfigError);
    });

    it('rejects non-positive volumeWindow', () => {
      expect(() =>
        parseStrategyConfig({ strategy: 'momentum-breakout', volumeWindow: -1 }),
      ).toThrow(StrategyConfigError);
    });

    it('rejects non-positive volumeMultiplier', () => {
      expect(() =>
        parseStrategyConfig({ strategy: 'momentum-breakout', volumeMultiplier: 0 }),
      ).toThrow(StrategyConfigError);
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

describe('registry integration', () => {
  it('z-score-mean-reversion resolves to ZScoreMeanReversionStrategy instance', async () => {
    const { createDefaultRegistry } = await import('../index.js');
    const registry = createDefaultRegistry();
    expect(registry.has('z-score-mean-reversion')).toBe(true);
    const strategy = registry.create({ strategy: 'z-score-mean-reversion' });
    expect(strategy.name).toBe('z-score-mean-reversion');
    expect(strategy.minCandles).toBe(21); // default period=20, minCandles=21
    expect(strategy.requiredIndicators).toEqual([
      { name: 'SMA', period: 20 },
      { name: 'SD', period: 20 },
    ]);
  });
});

describe('registry integration - momentum-breakout', () => {
  it('momentum-breakout resolves to MomentumBreakoutStrategy instance', async () => {
    const { createDefaultRegistry } = await import('../index.js');
    const registry = createDefaultRegistry();
    expect(registry.has('momentum-breakout')).toBe(true);
    const strategy = registry.create({ strategy: 'momentum-breakout' });
    expect(strategy.name).toBe('momentum-breakout');
    // defaults: breakoutWindow=20, volumeWindow=20 -> minCandles = Math.max(20,20) + 1 = 21
    expect(strategy.minCandles).toBe(21);
    expect(strategy.requiredIndicators).toContainEqual({ name: 'Highest', period: 20 });
    expect(strategy.requiredIndicators).toContainEqual({ name: 'Lowest', period: 20 });
  });
});
