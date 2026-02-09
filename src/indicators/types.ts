/**
 * Types for the indicator engine.
 *
 * Discriminated union configs (one per indicator), result point types,
 * and the generic IndicatorOutput container.
 */

// ── Indicator names ──────────────────────────────────────────────────

export type IndicatorName =
  | 'SMA'
  | 'EMA'
  | 'RSI'
  | 'MACD'
  | 'BollingerBands'
  | 'Stochastic'
  | 'ATR';

// ── Per-indicator config types ───────────────────────────────────────

export interface SMAConfig {
  name: 'SMA';
  period: number;
}

export interface EMAConfig {
  name: 'EMA';
  period: number;
}

export interface RSIConfig {
  name: 'RSI';
  period: number;
}

export interface MACDConfig {
  name: 'MACD';
  fastPeriod: number;
  slowPeriod: number;
  signalPeriod: number;
}

export interface BollingerBandsConfig {
  name: 'BollingerBands';
  period: number;
  stdDev: number;
}

export interface StochasticConfig {
  name: 'Stochastic';
  period: number;
  signalPeriod: number;
}

export interface ATRConfig {
  name: 'ATR';
  period: number;
}

/** Union of all indicator config types (discriminated on `name`). */
export type IndicatorConfig =
  | SMAConfig
  | EMAConfig
  | RSIConfig
  | MACDConfig
  | BollingerBandsConfig
  | StochasticConfig
  | ATRConfig;

// ── Result point types ───────────────────────────────────────────────

export interface MACDPoint {
  MACD: number | undefined;
  signal: number | undefined;
  histogram: number | undefined;
}

export interface BollingerBandsPoint {
  upper: number;
  middle: number;
  lower: number;
  pb: number;
}

export interface StochasticPoint {
  k: number;
  d: number;
}

// ── Generic output container ─────────────────────────────────────────

export interface IndicatorOutput {
  /** Computed indicator values. Length <= input candle count. */
  values: (number | MACDPoint | BollingerBandsPoint | StochasticPoint)[];
  /** Candle index where the first valid value appears (period warm-up). */
  offset: number;
}
