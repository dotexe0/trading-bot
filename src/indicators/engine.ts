/**
 * IndicatorEngine -- computes technical indicators on Candle[] data.
 *
 * Wraps fast-technical-indicators with typed config, adapters, and
 * insufficient-data guards.
 */

import { createRequire } from 'module';
import type { Candle } from '../core/types.js';
import { extractCloses, extractOHLC } from './adapters.js';
import { parseIndicatorConfig, minCandlesRequired } from './config.js';
import type { IndicatorConfig, IndicatorOutput, MACDPoint } from './types.js';

// fast-technical-indicators has a broken ESM entry point (ESM syntax in a
// CJS-typed package). Use createRequire to load the CJS bundle reliably.
const require = createRequire(import.meta.url);
const {
  sma,
  ema,
  rsi,
  macd,
  bollingerbands,
  stochastic,
  atr,
} = require('fast-technical-indicators') as {
  sma: (input: { period: number; values: number[] }) => number[];
  ema: (input: { period: number; values: number[] }) => number[];
  rsi: (input: { period: number; values: number[] }) => number[];
  macd: (input: {
    values: number[];
    fastPeriod: number;
    slowPeriod: number;
    signalPeriod: number;
    SimpleMAOscillator?: boolean;
    SimpleMASignal?: boolean;
  }) => MACDPoint[];
  bollingerbands: (input: {
    period: number;
    values: number[];
    stdDev: number;
  }) => { upper: number; middle: number; lower: number; pb: number }[];
  stochastic: (input: {
    period: number;
    signalPeriod: number;
    high: number[];
    low: number[];
    close: number[];
  }) => { k: number; d: number }[];
  atr: (input: {
    period: number;
    high: number[];
    low: number[];
    close: number[];
  }) => number[];
};

export class IndicatorEngine {
  /**
   * Compute an indicator on candle data.
   *
   * Config is validated via Zod. If candles are insufficient for the
   * indicator period, returns `{ values: [], offset: 0 }`.
   */
  compute(config: IndicatorConfig, candles: Candle[]): IndicatorOutput {
    // Validate config (throws IndicatorConfigError on invalid)
    const validConfig = parseIndicatorConfig(config);

    // Guard: insufficient data
    if (candles.length < minCandlesRequired(validConfig)) {
      return { values: [], offset: 0 };
    }

    switch (validConfig.name) {
      case 'SMA': {
        const closes = extractCloses(candles);
        const values = sma({ period: validConfig.period, values: closes });
        return { values, offset: closes.length - values.length };
      }

      case 'EMA': {
        const closes = extractCloses(candles);
        const values = ema({ period: validConfig.period, values: closes });
        return { values, offset: closes.length - values.length };
      }

      case 'RSI': {
        const closes = extractCloses(candles);
        const values = rsi({ period: validConfig.period, values: closes });
        return { values, offset: closes.length - values.length };
      }

      case 'MACD': {
        const closes = extractCloses(candles);
        const values = macd({
          values: closes,
          fastPeriod: validConfig.fastPeriod,
          slowPeriod: validConfig.slowPeriod,
          signalPeriod: validConfig.signalPeriod,
          SimpleMAOscillator: false,
          SimpleMASignal: false,
        });
        return { values, offset: closes.length - values.length };
      }

      case 'BollingerBands': {
        const closes = extractCloses(candles);
        const values = bollingerbands({
          period: validConfig.period,
          values: closes,
          stdDev: validConfig.stdDev,
        });
        return { values, offset: closes.length - values.length };
      }

      case 'Stochastic': {
        const ohlc = extractOHLC(candles);
        const values = stochastic({
          period: validConfig.period,
          signalPeriod: validConfig.signalPeriod,
          high: ohlc.high,
          low: ohlc.low,
          close: ohlc.close,
        });
        return { values, offset: candles.length - values.length };
      }

      case 'ATR': {
        const ohlc = extractOHLC(candles);
        const values = atr({
          period: validConfig.period,
          high: ohlc.high,
          low: ohlc.low,
          close: ohlc.close,
        });
        return { values, offset: candles.length - values.length };
      }
    }
  }
}
