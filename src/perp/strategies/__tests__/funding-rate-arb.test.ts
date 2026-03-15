import { describe, it, expect } from 'vitest';
import type { Candle, TradingPair, Timeframe } from '../../../core/types.js';
import { MarketRegime } from '../../../regime/types.js';
import { FundingRateArbitrageStrategy } from '../funding-rate-arb.js';

function makeCandles(n = 5): Candle[] {
  return Array.from({ length: n }, (_, i) => ({
    pair: 'BTC-USD' as TradingPair,
    timeframe: '1h' as Timeframe,
    timestamp: 1_700_000_000_000 + i * 3_600_000,
    open: '50000',
    high: '50100',
    low: '49900',
    close: '50000',
    volume: '100',
  }));
}

function makeProvider(mark: string, index: string) {
  return () => ({ markPrice: mark, indexPrice: index });
}

const candles = makeCandles();

describe('FundingRateArbitrageStrategy', () => {
  describe('constructor', () => {
    it('has correct name', () => {
      const s = new FundingRateArbitrageStrategy({
        threshold: 0.0005,
        markPriceProvider: () => null,
        tournamentMode: false,
      });
      expect(s.name).toBe('funding-rate-arb');
    });

    it('has minCandles = 1', () => {
      const s = new FundingRateArbitrageStrategy({
        threshold: 0.0005,
        markPriceProvider: () => null,
        tournamentMode: false,
      });
      expect(s.minCandles).toBe(1);
    });
  });

  describe('tournament mode guard', () => {
    it('returns [] when tournamentMode=true regardless of other state', () => {
      const s = new FundingRateArbitrageStrategy({
        threshold: 0.0005,
        // Provider would return a strong signal, but tournamentMode blocks it
        markPriceProvider: makeProvider('50100', '50000'),
        tournamentMode: true,
      });
      const signals = s.evaluate(candles, 'BTC-USD', '1h', undefined, MarketRegime.RANGING);
      expect(signals).toEqual([]);
    });
  });

  describe('regime gate', () => {
    it('returns [] in TRENDING regime', () => {
      const s = new FundingRateArbitrageStrategy({
        threshold: 0.0005,
        markPriceProvider: makeProvider('49975', '50000'), // impliedRate ~ -0.0005
        tournamentMode: false,
      });
      const signals = s.evaluate(candles, 'BTC-USD', '1h', undefined, MarketRegime.TRENDING);
      expect(signals).toEqual([]);
    });

    it('returns [] when regime is undefined', () => {
      const s = new FundingRateArbitrageStrategy({
        threshold: 0.0005,
        markPriceProvider: makeProvider('49975', '50000'),
        tournamentMode: false,
      });
      const signals = s.evaluate(candles, 'BTC-USD', '1h', undefined, undefined);
      expect(signals).toEqual([]);
    });

    it('generates signals in RANGING regime', () => {
      // impliedRate = (49950 - 50000) / 50000 = -0.001 < -0.0005 → LONG
      const s = new FundingRateArbitrageStrategy({
        threshold: 0.0005,
        markPriceProvider: makeProvider('49950', '50000'),
        tournamentMode: false,
      });
      const signals = s.evaluate(candles, 'BTC-USD', '1h', undefined, MarketRegime.RANGING);
      expect(signals.length).toBe(1);
      expect(signals[0].direction).toBe('long');
    });

    it('generates signals in VOLATILE regime', () => {
      // impliedRate = (50050 - 50000) / 50000 = +0.001 > +0.0005 → SHORT
      const s = new FundingRateArbitrageStrategy({
        threshold: 0.0005,
        markPriceProvider: makeProvider('50050', '50000'),
        tournamentMode: false,
      });
      const signals = s.evaluate(candles, 'BTC-USD', '1h', undefined, MarketRegime.VOLATILE);
      expect(signals.length).toBe(1);
      expect(signals[0].direction).toBe('short');
    });
  });

  describe('provider guards', () => {
    it('returns [] when markPriceProvider returns null', () => {
      const s = new FundingRateArbitrageStrategy({
        threshold: 0.0005,
        markPriceProvider: () => null,
        tournamentMode: false,
      });
      const signals = s.evaluate(candles, 'BTC-USD', '1h', undefined, MarketRegime.RANGING);
      expect(signals).toEqual([]);
    });

    it('returns [] when indexPrice is zero (division guard)', () => {
      const s = new FundingRateArbitrageStrategy({
        threshold: 0.0005,
        markPriceProvider: makeProvider('50000', '0'),
        tournamentMode: false,
      });
      const signals = s.evaluate(candles, 'BTC-USD', '1h', undefined, MarketRegime.RANGING);
      expect(signals).toEqual([]);
    });
  });

  describe('indexPrice === markPrice (current FCM reality)', () => {
    it('returns [] when markPrice equals indexPrice (implied rate = 0)', () => {
      const s = new FundingRateArbitrageStrategy({
        threshold: 0.0005,
        markPriceProvider: makeProvider('50000', '50000'),
        tournamentMode: false,
      });
      const signals = s.evaluate(candles, 'BTC-USD', '1h', undefined, MarketRegime.RANGING);
      expect(signals).toEqual([]);
    });
  });

  describe('signal properties', () => {
    it('LONG signal has valid confidence [0.01, 1]', () => {
      // impliedRate = (49950 - 50000) / 50000 = -0.001
      const s = new FundingRateArbitrageStrategy({
        threshold: 0.0005,
        markPriceProvider: makeProvider('49950', '50000'),
        tournamentMode: false,
      });
      const [sig] = s.evaluate(candles, 'BTC-USD', '1h', undefined, MarketRegime.RANGING);
      expect(sig.confidence).toBeGreaterThanOrEqual(0.01);
      expect(sig.confidence).toBeLessThanOrEqual(1);
      expect(sig.reasoning).toContain('impliedRate');
    });

    it('SHORT signal fires when impliedRate above positive threshold', () => {
      // impliedRate = (50100 - 50000) / 50000 = +0.002 >> +0.0005
      const s = new FundingRateArbitrageStrategy({
        threshold: 0.0005,
        markPriceProvider: makeProvider('50100', '50000'),
        tournamentMode: false,
      });
      const signals = s.evaluate(candles, 'BTC-USD', '1h', undefined, MarketRegime.VOLATILE);
      expect(signals.length).toBe(1);
      expect(signals[0].direction).toBe('short');
    });
  });
});
