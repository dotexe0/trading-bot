/**
 * BacktestEngine tests -- event-driven replay, lookahead prevention,
 * fill timing, force-close, and integration with real strategies.
 */

import { describe, it, expect } from 'vitest';
import { BacktestEngine } from '../engine.js';
import { IndicatorEngine } from '../../indicators/engine.js';
import { createDefaultRegistry } from '../../strategies/index.js';
import { StrategyRegistry } from '../../strategies/registry.js';
import { d, Decimal } from '../../core/decimal.js';
import type { Candle, TradingPair, Timeframe } from '../../core/types.js';
import type { IStrategy, Signal } from '../../strategies/types.js';
import type { IndicatorConfig } from '../../indicators/types.js';
import type { BacktestConfig } from '../types.js';

// ── Helpers ───────────────────────────────────────────────────────────

let candleCounter = 0;

function makeCandle(overrides: Partial<Candle> = {}): Candle {
  const ts = 1700000000000 + candleCounter * 3600000;
  candleCounter++;
  return {
    pair: 'BTC-USD',
    timeframe: '1h',
    timestamp: ts,
    open: '50000',
    high: '51000',
    low: '49000',
    close: '50500',
    volume: '100',
    ...overrides,
  };
}

function makeCandles(count: number, basePricePattern?: number[]): Candle[] {
  const candles: Candle[] = [];
  for (let i = 0; i < count; i++) {
    const base = basePricePattern ? basePricePattern[i % basePricePattern.length] : 50000 + i * 100;
    candles.push(
      makeCandle({
        open: String(base),
        high: String(base + 500),
        low: String(base - 500),
        close: String(base + 200),
      }),
    );
  }
  return candles;
}

function makeDefaultConfig(strategyConfig: Record<string, unknown> = {}): BacktestConfig {
  return {
    pair: 'BTC-USD' as TradingPair,
    timeframe: '1h' as Timeframe,
    startMs: 1700000000000,
    endMs: 1700100000000,
    initialCapital: '10000',
    strategyConfig: { strategy: 'sma-crossover', fastPeriod: 3, slowPeriod: 5, ...strategyConfig },
    slippageBps: 5,
    feeTierMaker: 0.0035,
    feeTierTaker: 0.0075,
    assumeTaker: true,
    positionSizePct: 0.95,
    allowShorts: true,
  };
}

/**
 * A mock strategy that records how many candles it receives
 * and optionally signals on a specific bar index.
 */
class RecordingStrategy implements IStrategy {
  readonly name = 'recording';
  readonly minCandles = 2;
  readonly requiredIndicators: IndicatorConfig[] = [];
  receivedCandleCounts: number[] = [];
  signalOnBar: number | null;
  signalDirection: 'long' | 'short' | 'close';

  constructor(signalOnBar: number | null = null, direction: 'long' | 'short' | 'close' = 'long') {
    this.signalOnBar = signalOnBar;
    this.signalDirection = direction;
  }

  evaluate(
    candles: Candle[],
    pair: TradingPair,
    timeframe: Timeframe,
  ): Signal[] {
    this.receivedCandleCounts.push(candles.length);

    if (this.signalOnBar !== null && candles.length - 1 === this.signalOnBar) {
      return [
        {
          strategyName: this.name,
          pair,
          timeframe,
          timestamp: candles[candles.length - 1].timestamp,
          direction: this.signalDirection,
          confidence: 0.8,
          reasoning: 'test signal',
        },
      ];
    }
    return [];
  }
}

/** A strategy that always signals long on every bar. */
class AlwaysLongStrategy implements IStrategy {
  readonly name = 'always-long';
  readonly minCandles = 1;
  readonly requiredIndicators: IndicatorConfig[] = [];

  evaluate(candles: Candle[], pair: TradingPair, timeframe: Timeframe): Signal[] {
    return [
      {
        strategyName: this.name,
        pair,
        timeframe,
        timestamp: candles[candles.length - 1].timestamp,
        direction: 'long',
        confidence: 1,
        reasoning: 'always long',
      },
    ];
  }
}

/**
 * A registry that bypasses Zod strategy config validation.
 * Needed because mock strategies aren't in the discriminated union schema.
 */
class MockStrategyRegistry extends StrategyRegistry {
  private mockStrategy: IStrategy;

  constructor(strategy: IStrategy) {
    super();
    this.mockStrategy = strategy;
  }

  override create(_rawConfig: unknown): IStrategy {
    return this.mockStrategy;
  }
}

function createMockRegistry(strategy: IStrategy): StrategyRegistry {
  return new MockStrategyRegistry(strategy);
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('BacktestEngine', () => {
  // Reset candle counter before each test
  const engine = () =>
    new BacktestEngine({
      strategyRegistry: createDefaultRegistry(),
      indicatorEngine: new IndicatorEngine(),
    });

  it('runs without error on valid config + candles', () => {
    candleCounter = 0;
    const candles = makeCandles(20);
    const config = makeDefaultConfig();
    const result = engine().run(config, candles);

    expect(result).toBeDefined();
    expect(result.config).toBeDefined();
    expect(result.equityCurve.length).toBeGreaterThan(0);
    expect(result.finalEquity).toBeInstanceOf(Decimal);
  });

  it('equity curve has one point per candle from minCandles-1 to end', () => {
    candleCounter = 0;
    const recording = new RecordingStrategy();
    const registry = createMockRegistry(recording);
    const eng = new BacktestEngine({
      strategyRegistry: registry,
      indicatorEngine: new IndicatorEngine(),
    });

    const candles = makeCandles(10);
    const config: BacktestConfig = {
      ...makeDefaultConfig(),
      strategyConfig: { strategy: 'recording' },
    };

    const result = eng.run(config, candles);

    // minCandles = 2, so equity points from index 1 to 9 = 9 points
    expect(result.equityCurve).toHaveLength(candles.length - recording.minCandles + 1);
  });

  it('strategy only receives candles up to current index (no lookahead)', () => {
    candleCounter = 0;
    const recording = new RecordingStrategy();
    const registry = createMockRegistry(recording);
    const eng = new BacktestEngine({
      strategyRegistry: registry,
      indicatorEngine: new IndicatorEngine(),
    });

    const candles = makeCandles(8);
    const config: BacktestConfig = {
      ...makeDefaultConfig(),
      strategyConfig: { strategy: 'recording' },
    };

    eng.run(config, candles);

    // Strategy has minCandles=2, loop starts at i=1
    // On i=1 -> receives 2 candles, i=2 -> 3, ..., i=7 -> 8
    expect(recording.receivedCandleCounts).toEqual([2, 3, 4, 5, 6, 7, 8]);
  });

  it('fill occurs at next bar open, not current bar close', () => {
    candleCounter = 0;
    // Signal on bar index 5, fill should use candle[6].open
    const recording = new RecordingStrategy(5, 'long');
    const registry = createMockRegistry(recording);
    const eng = new BacktestEngine({
      strategyRegistry: registry,
      indicatorEngine: new IndicatorEngine(),
    });

    const candles = makeCandles(10);
    // Set candle[6] with a distinct open price
    candles[6] = makeCandle({
      ...candles[6],
      timestamp: candles[6].timestamp,
      open: '99999',
      high: '100500',
      low: '99500',
      close: '100200',
    });

    const config: BacktestConfig = {
      ...makeDefaultConfig(),
      strategyConfig: { strategy: 'recording' },
      slippageBps: 0, // zero slippage so fill price = exact open
    };

    const result = eng.run(config, candles);

    // Should have at least 1 trade (the long gets force-closed at end)
    expect(result.trades.length).toBeGreaterThanOrEqual(1);
    // Entry fill price should be the next bar's open (99999)
    expect(result.trades[0].entryFill.fillPrice.toNumber()).toBe(99999);
  });

  it('no fill on last candle (signal on final bar has no next bar)', () => {
    candleCounter = 0;
    // Signal on bar 9 (last bar of 10), no bar 10 to fill on
    const recording = new RecordingStrategy(9, 'long');
    const registry = createMockRegistry(recording);
    const eng = new BacktestEngine({
      strategyRegistry: registry,
      indicatorEngine: new IndicatorEngine(),
    });

    const candles = makeCandles(10);
    const config: BacktestConfig = {
      ...makeDefaultConfig(),
      strategyConfig: { strategy: 'recording' },
    };

    const result = eng.run(config, candles);
    // No trade should be opened (can't fill on last bar)
    expect(result.trades).toHaveLength(0);
  });

  it('position force-closed at end if still open', () => {
    candleCounter = 0;
    // Signal long on bar 3, never closes -> engine should force-close at end
    const recording = new RecordingStrategy(3, 'long');
    const registry = createMockRegistry(recording);
    const eng = new BacktestEngine({
      strategyRegistry: registry,
      indicatorEngine: new IndicatorEngine(),
    });

    const candles = makeCandles(10);
    const config: BacktestConfig = {
      ...makeDefaultConfig(),
      strategyConfig: { strategy: 'recording' },
    };

    const result = eng.run(config, candles);
    // Should have exactly 1 trade: entry + force-close
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].exitFill.signal.strategyName).toBe('__force-close');
  });

  it('allowShorts=false skips short signals', () => {
    candleCounter = 0;
    const recording = new RecordingStrategy(3, 'short');
    const registry = createMockRegistry(recording);
    const eng = new BacktestEngine({
      strategyRegistry: registry,
      indicatorEngine: new IndicatorEngine(),
    });

    const candles = makeCandles(10);
    const config: BacktestConfig = {
      ...makeDefaultConfig(),
      strategyConfig: { strategy: 'recording' },
      allowShorts: false,
    };

    const result = eng.run(config, candles);
    expect(result.trades).toHaveLength(0);
  });

  it('empty candle array returns empty result (no error)', () => {
    candleCounter = 0;
    const result = engine().run(makeDefaultConfig(), []);

    expect(result.trades).toHaveLength(0);
    expect(result.equityCurve).toHaveLength(0);
    expect(result.finalEquity.toNumber()).toBe(10000);
  });

  it('insufficient candles for strategy.minCandles returns empty result', () => {
    candleCounter = 0;
    // sma-crossover with slowPeriod=5 needs minCandles=6
    const candles = makeCandles(3);
    const config = makeDefaultConfig();
    const result = engine().run(config, candles);

    expect(result.trades).toHaveLength(0);
    expect(result.equityCurve).toHaveLength(0);
    expect(result.finalEquity.toNumber()).toBe(10000);
  });

  it('config validation rejects invalid config (startMs > endMs)', () => {
    candleCounter = 0;
    const config = {
      ...makeDefaultConfig(),
      startMs: 2000000000000,
      endMs: 1000000000000,
    };

    expect(() => engine().run(config, makeCandles(10))).toThrow(
      'Invalid backtest config',
    );
  });

  it('multi-strategy integration: sma-crossover on crafted crossover candles', () => {
    candleCounter = 0;
    // Craft candles with a clear bearish-to-bullish crossover:
    // Prices go down then up, causing fast SMA to cross above slow SMA
    const prices = [
      100, 98, 96, 94, 92, // falling
      90, 92, 94, 96, 98, // recovery
      100, 102, 104, 106, 108, // rising -- crossover should happen here
      110, 112, 114, 116, 118, // continued rise
    ];

    const candles: Candle[] = prices.map((p, i) => ({
      pair: 'BTC-USD' as TradingPair,
      timeframe: '1h' as Timeframe,
      timestamp: 1700000000000 + i * 3600000,
      open: String(p - 1),
      high: String(p + 2),
      low: String(p - 2),
      close: String(p),
      volume: '100',
    }));

    const config: BacktestConfig = {
      pair: 'BTC-USD',
      timeframe: '1h',
      startMs: 1700000000000,
      endMs: 1700200000000,
      initialCapital: '10000',
      strategyConfig: { strategy: 'sma-crossover', fastPeriod: 3, slowPeriod: 5 },
      slippageBps: 0,
      feeTierMaker: 0,
      feeTierTaker: 0,
      assumeTaker: true,
      positionSizePct: 0.95,
      allowShorts: true,
    };

    const result = engine().run(config, candles);

    // We should see at least one trade (the strategy will fire signals on crossovers)
    // At minimum, any open position gets force-closed at end
    expect(result.trades.length).toBeGreaterThanOrEqual(1);
    expect(result.finalEquity).toBeInstanceOf(Decimal);
    expect(result.equityCurve.length).toBeGreaterThan(0);

    // Verify trade directions make sense
    for (const trade of result.trades) {
      expect(['buy', 'sell']).toContain(trade.entryFill.side);
      expect(trade.holdingPeriodMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('totalFees accumulates across multiple fills', () => {
    candleCounter = 0;
    // Always-long strategy will open position on first bar (if flat)
    const alwaysLong = new AlwaysLongStrategy();
    const registry = createMockRegistry(alwaysLong);
    const eng = new BacktestEngine({
      strategyRegistry: registry,
      indicatorEngine: new IndicatorEngine(),
    });

    const candles = makeCandles(5);
    const config: BacktestConfig = {
      ...makeDefaultConfig(),
      strategyConfig: { strategy: 'always-long' },
      feeTierTaker: 0.01, // 1% fee for easy calculation
    };

    const result = eng.run(config, candles);
    // Should have fees > 0
    expect(result.totalFees.gt(d(0))).toBe(true);
  });
});
