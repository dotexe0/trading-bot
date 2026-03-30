import { describe, it, expect } from 'vitest';
import { buildPerpParamGrid } from '../perp-tournament-runner.js';

describe('buildPerpParamGrid', () => {
  it('returns 38 total configs', () => {
    expect(buildPerpParamGrid()).toHaveLength(38);
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
});
