import { describe, it, expect } from 'vitest';
import { buildPerpParamGrid } from '../perp-tournament-runner.js';
import { parseStrategyConfig } from '../../strategies/config.js';
import { createPerpRegistry } from '../strategies/index.js';

describe('buildPerpParamGrid', () => {
  it('returns 68 total configs', () => {
    expect(buildPerpParamGrid()).toHaveLength(68);
  });

  it('contains 27 perp-momentum configs', () => {
    const momentum = buildPerpParamGrid().filter((c) => c.strategy === 'perp-momentum');
    expect(momentum).toHaveLength(27);
  });

  it('contains 9 perp-mean-reversion configs', () => {
    const mr = buildPerpParamGrid().filter((c) => c.strategy === 'perp-mean-reversion');
    expect(mr).toHaveLength(9);
  });

  it('contains 1 funding-rate-arb config', () => {
    const arb = buildPerpParamGrid().filter((c) => c.strategy === 'funding-rate-arb');
    expect(arb).toHaveLength(1);
  });

  it('contains 1 basis-trade config', () => {
    const basis = buildPerpParamGrid().filter((c) => c.strategy === 'basis-trade');
    expect(basis).toHaveLength(1);
  });

  it('perp-momentum covers all breakoutWindow values', () => {
    const windows = new Set(
      buildPerpParamGrid()
        .filter((c) => c.strategy === 'perp-momentum')
        .map((c) => c.breakoutWindow),
    );
    expect(windows).toEqual(new Set([10, 20, 40]));
  });

  it('perp-momentum covers all volumeMultiplier values', () => {
    const multipliers = new Set(
      buildPerpParamGrid()
        .filter((c) => c.strategy === 'perp-momentum')
        .map((c) => c.volumeMultiplier),
    );
    expect(multipliers).toEqual(new Set([1.2, 1.5, 2.0]));
  });

  it('perp-momentum covers all maxHoldCandles values', () => {
    const holds = new Set(
      buildPerpParamGrid()
        .filter((c) => c.strategy === 'perp-momentum')
        .map((c) => c.maxHoldCandles),
    );
    expect(holds).toEqual(new Set([10, 20, 40]));
  });

  it('perp-mean-reversion covers all period values', () => {
    const periods = new Set(
      buildPerpParamGrid()
        .filter((c) => c.strategy === 'perp-mean-reversion')
        .map((c) => c.period),
    );
    expect(periods).toEqual(new Set([10, 20, 40]));
  });

  it('perp-mean-reversion covers all threshold values', () => {
    const thresholds = new Set(
      buildPerpParamGrid()
        .filter((c) => c.strategy === 'perp-mean-reversion')
        .map((c) => c.threshold),
    );
    expect(thresholds).toEqual(new Set([1.0, 1.5, 2.0]));
  });

  it('every perp-momentum config is a unique combination', () => {
    const momentum = buildPerpParamGrid().filter((c) => c.strategy === 'perp-momentum');
    const keys = momentum.map(
      (c) => `${c.breakoutWindow}:${c.volumeMultiplier}:${c.maxHoldCandles}`,
    );
    expect(new Set(keys).size).toBe(27);
  });

  it('contains 18 perp-vwap-reversion configs', () => {
    const vwap = buildPerpParamGrid().filter((c) => c.strategy === 'perp-vwap-reversion');
    expect(vwap).toHaveLength(18);
  });

  it('contains 12 perp-micro-momentum configs', () => {
    const micro = buildPerpParamGrid().filter((c) => c.strategy === 'perp-micro-momentum');
    expect(micro).toHaveLength(12);
  });

  it('perp-vwap-reversion covers all vwapPeriod values', () => {
    const periods = new Set(
      buildPerpParamGrid()
        .filter((c) => c.strategy === 'perp-vwap-reversion')
        .map((c) => c.vwapPeriod),
    );
    expect(periods).toEqual(new Set([10, 15, 20]));
  });

  it('perp-vwap-reversion covers all zScoreThreshold values', () => {
    const thresholds = new Set(
      buildPerpParamGrid()
        .filter((c) => c.strategy === 'perp-vwap-reversion')
        .map((c) => c.zScoreThreshold),
    );
    expect(thresholds).toEqual(new Set([1.0, 1.5, 2.0]));
  });

  it('perp-micro-momentum covers all fastEmaPeriod values', () => {
    const periods = new Set(
      buildPerpParamGrid()
        .filter((c) => c.strategy === 'perp-micro-momentum')
        .map((c) => c.fastEmaPeriod),
    );
    expect(periods).toEqual(new Set([5, 8, 12]));
  });

  it('every perp-micro-momentum config has fastEmaPeriod < slowEmaPeriod', () => {
    const micro = buildPerpParamGrid().filter((c) => c.strategy === 'perp-micro-momentum');
    for (const cfg of micro) {
      expect(cfg.fastEmaPeriod).toBeLessThan(cfg.slowEmaPeriod as number);
    }
  });
});

describe('scalping strategy config schemas', () => {
  it('parses perp-vwap-reversion with defaults', () => {
    const cfg = parseStrategyConfig({ strategy: 'perp-vwap-reversion' });
    expect(cfg.strategy).toBe('perp-vwap-reversion');
  });

  it('parses perp-micro-momentum with defaults', () => {
    const cfg = parseStrategyConfig({ strategy: 'perp-micro-momentum' });
    expect(cfg.strategy).toBe('perp-micro-momentum');
  });

  it('rejects perp-micro-momentum when fastEmaPeriod >= slowEmaPeriod', () => {
    expect(() =>
      parseStrategyConfig({ strategy: 'perp-micro-momentum', fastEmaPeriod: 20, slowEmaPeriod: 5 }),
    ).toThrow();
  });
});

describe('scalping registry registration', () => {
  it('creates perp-vwap-reversion from registry', () => {
    const registry = createPerpRegistry();
    const strategy = registry.create({ strategy: 'perp-vwap-reversion' } as any);
    expect(strategy.name).toBe('perp-vwap-reversion');
  });

  it('creates perp-micro-momentum from registry', () => {
    const registry = createPerpRegistry();
    const strategy = registry.create({ strategy: 'perp-micro-momentum' } as any);
    expect(strategy.name).toBe('perp-micro-momentum');
  });
});
