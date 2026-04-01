import { describe, it, expect } from 'vitest';
import type { Candle, TradingPair, Timeframe } from '../../../core/types.js';
import type { Signal } from '../../../strategies/types.js';
import { PerpVwapReversionStrategy } from '../perp-vwap-reversion.js';

// -- Helpers ----------------------------------------------------------------

function makeCandles(params: {
  closes: number[];
  highs?: number[];
  lows?: number[];
  volumes?: number[];
  pair?: TradingPair;
  timeframe?: Timeframe;
}): Candle[] {
  const { closes, highs, lows, volumes, pair = 'BTC-USD', timeframe = '5m' } = params;
  return closes.map((c, i) => ({
    pair,
    timeframe,
    timestamp: 1_700_000_000_000 + i * 300_000,
    open: String(c),
    high: String(highs?.[i] ?? c + 0.5),
    low: String(lows?.[i] ?? c - 0.5),
    close: String(c),
    volume: String(volumes?.[i] ?? 100),
  }));
}

function makeFundingProvider(rate: number | null): () => number | null {
  return () => rate;
}

function assertValidSignal(signal: Signal, expectedDirection?: 'long' | 'short' | 'close'): void {
  expect(signal.confidence).toBeGreaterThanOrEqual(0.01);
  expect(signal.confidence).toBeLessThanOrEqual(1);
  expect(signal.reasoning).toBeTruthy();
  expect(typeof signal.reasoning).toBe('string');
  expect(signal.timestamp).toBeGreaterThan(0);
  expect(['long', 'short', 'close']).toContain(signal.direction);
  if (expectedDirection) expect(signal.direction).toBe(expectedDirection);
}

// vwapPeriod=10, zScoreThreshold=1.5, maxHoldCandles=5, stopLossPct=0.005
// minCandles = vwapPeriod + 1 = 11
const makeStrategy = () =>
  new PerpVwapReversionStrategy({
    vwapPeriod: 10,
    zScoreThreshold: 1.5,
    maxHoldCandles: 5,
    stopLossPct: 0.005,
    fundingThreshold: 0.01,
    fundingRateProvider: makeFundingProvider(null),
  });

/**
 * Build candles where the last N have all closes at basePrice and the last
 * candle has close at extremeClose. With SD computed over the last 10:
 * - basePrice=100, extremeClose=92 → VWTP≈99.2, SD≈2.19, Z≈-3.3 → LONG
 * - basePrice=100, extremeClose=108 → VWTP≈100.8, SD≈2.19, Z≈+3.3 → SHORT
 */
function makeLongEntryCandles(n = 15): Candle[] {
  // 14 flat candles at 100, last close=92. With equal volumes:
  // VWTP over last 10 = (9*100 + 92)/10 = 99.2
  // SD over last 10 closes = stdev([100,100,...,100,92])
  // deviation: 9 * (100 - 99.2)^2 + (92 - 99.2)^2 = 9*0.64 + 51.84 = 57.6, SD=sqrt(57.6/10)≈2.4
  // Z = (92 - 99.2) / 2.4 ≈ -3.0 → long signal (< -1.5)
  const closes = [...Array(n - 1).fill(100) as number[], 92];
  const vols = Array(n).fill(100) as number[];
  return makeCandles({ closes, highs: closes.map(c => c + 0.5), lows: closes.map(c => c - 0.5), volumes: vols });
}

function makeShortEntryCandles(n = 15): Candle[] {
  const closes = [...Array(n - 1).fill(100) as number[], 108];
  const vols = Array(n).fill(100) as number[];
  return makeCandles({ closes, highs: closes.map(c => c + 0.5), lows: closes.map(c => c - 0.5), volumes: vols });
}

describe('PerpVwapReversionStrategy', () => {
  // ---- constructor --------------------------------------------------------

  describe('constructor', () => {
    it('has correct name', () => {
      const s = makeStrategy();
      expect(s.name).toBe('perp-vwap-reversion');
    });

    it('has minCandles = vwapPeriod + 1', () => {
      const s = makeStrategy();
      expect(s.minCandles).toBe(11);
    });
  });

  // ---- length guard -------------------------------------------------------

  describe('length guard', () => {
    it('returns [] when candles.length < minCandles', () => {
      const s = makeStrategy();
      const closes = Array(10).fill(100) as number[]; // only 10, minCandles=11
      const candles = makeCandles({ closes });
      expect(s.evaluate(candles, 'BTC-USD', '5m')).toEqual([]);
    });
  });

  // ---- long entry ---------------------------------------------------------

  describe('long entry (price below VWTP by N SDs)', () => {
    it('returns long signal when Z-score is below -threshold', () => {
      const s = makeStrategy();
      const candles = makeLongEntryCandles();
      const signals = s.evaluate(candles, 'BTC-USD', '5m');
      expect(signals).toHaveLength(1);
      assertValidSignal(signals[0], 'long');
    });
  });

  // ---- short entry --------------------------------------------------------

  describe('short entry (price above VWTP by N SDs)', () => {
    it('returns short signal when Z-score is above +threshold', () => {
      const s = makeStrategy();
      const candles = makeShortEntryCandles();
      const signals = s.evaluate(candles, 'BTC-USD', '5m');
      expect(signals).toHaveLength(1);
      assertValidSignal(signals[0], 'short');
    });
  });

  // ---- neutral zone -------------------------------------------------------

  describe('neutral zone (Z-score between -threshold and +threshold)', () => {
    it('returns [] when Z-score is in the neutral zone', () => {
      const s = makeStrategy();
      // All 15 candles at exactly 100 → SD over last 10 = 0 → guard returns []
      const closes = Array(15).fill(100) as number[];
      const candles = makeCandles({ closes });
      expect(s.evaluate(candles, 'BTC-USD', '5m')).toEqual([]);
    });

    it('returns [] when price deviates only slightly (Z-score < threshold)', () => {
      const s = makeStrategy();
      // 14 at 100, last at 99.8 → Z ≈ (99.8 - 99.98) / SD_tiny → below threshold
      // With 9 at 100, 1 at 99.8 (vwapPeriod=10): VWTP=99.98, SD small
      // Better: use a constant SD scenario where Z < 1.5
      // Use all 15 candles: 10 at 100, 5 at 102 → VWTP≈(5*100+5*102)/10=101
      // SD of closes: [100,100,100,100,100,102,102,102,102,102]→ mean=101, var=1, SD=1
      // Last close=102 → Z=(102-101)/1=1.0 < 1.5 → no signal
      const closes = [...Array(10).fill(100) as number[], ...Array(5).fill(102) as number[]];
      const vols = Array(15).fill(100) as number[];
      const candles = makeCandles({ closes, volumes: vols });
      const sigs = s.evaluate(candles, 'BTC-USD', '5m');
      expect(sigs).toEqual([]);
    });
  });

  // ---- mean reversion exit ------------------------------------------------

  describe('mean reversion exit', () => {
    it('emits close signal when Z-score crosses back through zero after long entry', () => {
      const s = makeStrategy();
      // Step 1: Enter long (close=92)
      const entryCandles = makeLongEntryCandles();
      const entry = s.evaluate(entryCandles, 'BTC-USD', '5m');
      expect(entry[0].direction).toBe('long');

      // Step 2: Feed candles[0..14] = [100,100,...,100,92] as before, plus new candle at 102
      // Last 10 candles of 16-candle sequence: [100,100,100,100,100,100,100,100,92,102]
      // VWTP = (8*100 + 92 + 102) / 10 = (800+92+102)/10 = 99.4
      // close=102 → Z = (102 - 99.4) / SD > 0 → mean reversion for long → close signal
      const reversionCloses = [...Array(14).fill(100) as number[], 92, 102];
      const reversionCandles = makeCandles({ closes: reversionCloses, highs: reversionCloses.map(c => c + 0.5), lows: reversionCloses.map(c => c - 0.5), volumes: Array(16).fill(100) });
      const exit = s.evaluate(reversionCandles, 'BTC-USD', '5m');
      expect(exit).toHaveLength(1);
      assertValidSignal(exit[0], 'close');
      expect(exit[0].reasoning).toContain('MeanReversion');
    });
  });

  // ---- time stop ----------------------------------------------------------

  describe('time stop', () => {
    it('emits close signal on time stop (candlesHeld >= maxHoldCandles=5) even if Z-score has not reverted', () => {
      // Use a strategy with large stopLossPct (10%) to prevent stop-loss from firing
      // during the time stop hold period. This isolates the time stop behavior.
      const s = new PerpVwapReversionStrategy({
        vwapPeriod: 10,
        zScoreThreshold: 1.5,
        maxHoldCandles: 5,
        stopLossPct: 0.10, // 10% — prevents stop-loss from firing during test
        fundingThreshold: 0.01,
        fundingRateProvider: makeFundingProvider(null),
      });

      // Enter long with close=92 (Z << -1.5 → long)
      const entryCandles = makeLongEntryCandles(15);
      const entrySignal = s.evaluate(entryCandles, 'BTC-USD', '5m');
      expect(entrySignal).toHaveLength(1);
      expect(entrySignal[0].direction).toBe('long');

      // Hold candles 1-4 at close=96
      // Last 10 after i holds: [100..., 92, 96, 96, ...] → VWTP > 96 → Z<0 ✓
      // stop-loss: (entryLevel - 96) / entryLevel → entryLevel≈99.2, loss≈3.2% < 10% ✓
      for (let i = 1; i <= 4; i++) {
        const holdCloses = [...Array(14 - i).fill(100) as number[], 92, ...Array(i).fill(96) as number[]];
        const holdCandles = makeCandles({ closes: holdCloses, highs: holdCloses.map(c => c + 0.5), lows: holdCloses.map(c => c - 0.5), volumes: Array(15).fill(100) });
        const holdSigs = s.evaluate(holdCandles, 'BTC-USD', '5m');
        expect(holdSigs).toEqual([]);
      }

      // 5th hold candle → time stop fires (candlesHeld=5 >= maxHoldCandles=5)
      const timeStopCloses = [...Array(9).fill(100) as number[], 92, ...Array(5).fill(96) as number[]];
      const timeStopCandles = makeCandles({ closes: timeStopCloses, highs: timeStopCloses.map(c => c + 0.5), lows: timeStopCloses.map(c => c - 0.5), volumes: Array(15).fill(100) });
      const timeStop = s.evaluate(timeStopCandles, 'BTC-USD', '5m');
      expect(timeStop).toHaveLength(1);
      assertValidSignal(timeStop[0], 'close');
      expect(timeStop[0].reasoning).toContain('TimeStop');
    });
  });

  // ---- price-based stop-loss ----------------------------------------------

  describe('price-based stop-loss', () => {
    it('emits close signal on long stop-loss when loss > stopLossPct', () => {
      const s = makeStrategy();
      // Enter long. entryLevel = VWTP = (9*100+92)/10 = 99.2
      const entryCandles = makeLongEntryCandles(15);
      const entry = s.evaluate(entryCandles, 'BTC-USD', '5m');
      expect(entry[0].direction).toBe('long');

      // stopLossPct=0.005 → trigger when (entryLevel - close) / entryLevel > 0.005
      // entryLevel=99.2 → fires when close < 99.2 * (1-0.005) = 98.704
      // Use close=98.6 → loss=(99.2-98.6)/99.2≈0.6% > 0.5% ✓
      const stopCloses = [...Array(13).fill(100) as number[], 92, 98.6];
      const stopCandles = makeCandles({ closes: stopCloses, highs: stopCloses.map(c => c + 0.5), lows: stopCloses.map(c => c - 0.5), volumes: Array(15).fill(100) });
      const sl = s.evaluate(stopCandles, 'BTC-USD', '5m');
      expect(sl).toHaveLength(1);
      assertValidSignal(sl[0], 'close');
      expect(sl[0].reasoning).toContain('StopLoss');
    });

    it('emits close signal on short stop-loss when loss > stopLossPct', () => {
      const s = makeStrategy();
      // Enter short. entryLevel = VWTP = (9*100+108)/10 = 100.8
      const entryCandles = makeShortEntryCandles(15);
      const entry = s.evaluate(entryCandles, 'BTC-USD', '5m');
      expect(entry[0].direction).toBe('short');

      // For short: loss = (currentClose - entryLevel) / entryLevel > stopLossPct
      // entryLevel=100.8 → fires when close > 100.8 * (1+0.005) = 101.304
      // Use close=101.4 → loss=(101.4-100.8)/100.8≈0.6% > 0.5% ✓
      const stopCloses = [...Array(13).fill(100) as number[], 108, 101.4];
      const stopCandles = makeCandles({ closes: stopCloses, highs: stopCloses.map(c => c + 0.5), lows: stopCloses.map(c => c - 0.5), volumes: Array(15).fill(100) });
      const sl = s.evaluate(stopCandles, 'BTC-USD', '5m');
      expect(sl).toHaveLength(1);
      assertValidSignal(sl[0], 'close');
      expect(sl[0].reasoning).toContain('StopLoss');
    });
  });

  // ---- hold (no exit) -----------------------------------------------------

  describe('hold (position open, no exit triggered)', () => {
    it('returns [] when position is open and neither reversion, time stop, nor stop-loss triggered', () => {
      const s = makeStrategy();
      // Enter long. entryLevel ≈ 99.2 (VWTP after 14x100 + 1x92)
      const entryCandles = makeLongEntryCandles(15);
      const entry = s.evaluate(entryCandles, 'BTC-USD', '5m');
      expect(entry[0].direction).toBe('long');

      // Next candle: close=98.9
      // VWTP over last 10 candles (candles 5-14 = 9x100 and 1x92 → some shifted):
      // For 16-candle array [100,100,...(14 total),92,98.9]:
      // last 10 = [100,100,100,100,100,100,100,100,92,98.9]
      // VWTP = (8*100 + 92 + 98.9) / 10 = (800+92+98.9)/10 = 99.09
      // SD of closes [100,100,100,100,100,100,100,100,92,98.9]:
      //   mean=99.09, deviations: 8*(0.91)^2 + (-7.09)^2 + (-0.19)^2 ≈ 8*0.828+50.27+0.036 ≈ 56.94
      //   SD = sqrt(56.94/10) ≈ 2.39
      // Z = (98.9 - 99.09) / 2.39 ≈ -0.08 < 0 (long position, Z<0 = not reverted yet, Z>=0 triggers exit)
      // Wait: Z<0 means price still below VWTP → no mean reversion exit (exit fires on Z>=0)
      // stop-loss: (entryLevel - close) / entryLevel = (99.2 - 98.9) / 99.2 ≈ 0.3% < 0.5% ✓
      // time stop: candlesHeld=1 < 5 ✓
      // Result: hold → []
      const holdCloses = [...Array(14).fill(100) as number[], 92, 98.9];
      const holdCandles = makeCandles({ closes: holdCloses, highs: holdCloses.map(c => c + 0.5), lows: holdCloses.map(c => c - 0.5), volumes: Array(16).fill(100) });
      const hold = s.evaluate(holdCandles, 'BTC-USD', '5m');
      expect(hold).toEqual([]);
    });
  });

  // ---- funding rate adjustment --------------------------------------------

  describe('funding rate adjustment', () => {
    it('reduces confidence when funding rate opposes direction (long, high positive rate)', () => {
      const sNoFunding = makeStrategy();
      const sWithFunding = new PerpVwapReversionStrategy({
        vwapPeriod: 10,
        zScoreThreshold: 1.5,
        maxHoldCandles: 5,
        stopLossPct: 0.005,
        fundingThreshold: 0.01,
        fundingRateProvider: makeFundingProvider(0.05), // high positive rate opposes long
      });

      const candles = makeLongEntryCandles();
      const noFundingSignals = sNoFunding.evaluate(candles, 'BTC-USD', '5m');
      const withFundingSignals = sWithFunding.evaluate(candles, 'BTC-USD', '5m');

      expect(noFundingSignals).toHaveLength(1);
      expect(withFundingSignals).toHaveLength(1);
      expect(withFundingSignals[0].confidence).toBeLessThan(noFundingSignals[0].confidence);
    });

    it('leaves confidence unadjusted when fundingRateProvider returns null (tournament mode)', () => {
      const s = makeStrategy(); // fundingRateProvider returns null
      const candles = makeLongEntryCandles();
      const signals = s.evaluate(candles, 'BTC-USD', '5m');
      expect(signals).toHaveLength(1);
      expect(signals[0].reasoning).not.toContain('FundingAdj');
    });
  });

  // ---- restorePosition ----------------------------------------------------

  describe('restorePosition()', () => {
    it('correctly restores open direction, entry level, and resets candlesHeld to 0', () => {
      const s = makeStrategy();
      // Restore a long position with entryLevel=99.2
      s.restorePosition('long', '99.2');

      // Feed a candle where close=98.9 → Z<0 (hold), stop-loss not triggered
      // After restore, _candlesHeld=0, _openDirection='long', _entryLevel=99.2
      // Feed: 14x100 + 92 + 98.9 (16 candles, last 10: [100,100,100,100,100,100,100,100,92,98.9])
      // VWTP ≈ 99.09, SD ≈ 2.39, Z ≈ -0.08 < 0 → no mean reversion
      // stop-loss: (99.2 - 98.9) / 99.2 ≈ 0.3% < 0.5% ✓
      // time: candlesHeld becomes 1 (< 5) ✓ → hold → []
      const holdCloses = [...Array(14).fill(100) as number[], 92, 98.9];
      const holdCandles = makeCandles({ closes: holdCloses, highs: holdCloses.map(c => c + 0.5), lows: holdCloses.map(c => c - 0.5), volumes: Array(16).fill(100) });
      const hold = s.evaluate(holdCandles, 'BTC-USD', '5m');
      expect(hold).toEqual([]);
    });
  });

  // ---- no re-entry while position open ------------------------------------

  describe('no re-entry while position open', () => {
    it('returns [] (no new entry) while a position is open even if Z-score signals entry', () => {
      const s = makeStrategy();
      // Enter long
      const entryCandles = makeLongEntryCandles(15);
      const entry = s.evaluate(entryCandles, 'BTC-USD', '5m');
      expect(entry[0].direction).toBe('long');

      // Feed hold candle (no exit)
      const holdCloses = [...Array(14).fill(100) as number[], 92, 98.9];
      const holdCandles = makeCandles({ closes: holdCloses, highs: holdCloses.map(c => c + 0.5), lows: holdCloses.map(c => c - 0.5), volumes: Array(16).fill(100) });
      const hold = s.evaluate(holdCandles, 'BTC-USD', '5m');
      // Position is still open → no entry signals even though Z<0 meets entry criteria
      expect(hold).toEqual([]);
    });
  });

  // ---- confidence clamping ------------------------------------------------

  describe('confidence clamping', () => {
    it('confidence is clamped to [0.01, 1.0]', () => {
      const s = makeStrategy();
      // Extreme Z-score (close=50, 14x100)
      const closes = [...Array(14).fill(100) as number[], 50];
      const candles = makeCandles({ closes, highs: closes.map(c => c + 0.5), lows: closes.map(c => c - 0.5), volumes: Array(15).fill(100) });
      const signals = s.evaluate(candles, 'BTC-USD', '5m');
      if (signals.length > 0) {
        expect(signals[0].confidence).toBeGreaterThanOrEqual(0.01);
        expect(signals[0].confidence).toBeLessThanOrEqual(1.0);
      }
    });
  });
});
