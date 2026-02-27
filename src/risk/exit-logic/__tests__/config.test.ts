/**
 * ExitConfig Zod schema tests -- TDD RED phase.
 *
 * Tests parseExitConfig() with various inputs to verify
 * schema defaults, validation, and error handling.
 */

import { describe, it, expect } from 'vitest';
import { parseExitConfig } from '../config.js';

describe('parseExitConfig', () => {
  it('returns fully-defaulted ExitConfig with all four exit types disabled when passed empty object', () => {
    const cfg = parseExitConfig({});
    expect(cfg.exits.trailing.enabled).toBe(false);
    expect(cfg.exits.trailing.activateAfterPct).toBe(0.02);
    expect(cfg.exits.trailing.trailAtrMultiple).toBe(2.0);
    expect(cfg.exits.partial.enabled).toBe(false);
    expect(cfg.exits.partial.profitTargetPct).toBe(0.03);
    expect(cfg.exits.partial.closeFraction).toBe(0.5);
    expect(cfg.exits.time.enabled).toBe(false);
    expect(cfg.exits.time.maxCandlesHeld).toBe(20);
    expect(cfg.exits.time.pnlThresholdPct).toBe(0.0);
    expect(cfg.exits.atrStop.enabled).toBe(false);
    expect(cfg.exits.atrStop.atrPeriod).toBe(14);
    expect(cfg.exits.atrStop.atrMultiple).toBe(2.0);
  });

  it('returns ExitConfig with trailing enabled when only trailing.enabled is true', () => {
    const cfg = parseExitConfig({ exits: { trailing: { enabled: true } } });
    expect(cfg.exits.trailing.enabled).toBe(true);
    // Other defaults intact
    expect(cfg.exits.partial.enabled).toBe(false);
    expect(cfg.exits.time.enabled).toBe(false);
    expect(cfg.exits.atrStop.enabled).toBe(false);
  });

  it('parses partial exit config with custom closeFraction', () => {
    const cfg = parseExitConfig({
      exits: { partial: { enabled: true, closeFraction: 0.3 } },
    });
    expect(cfg.exits.partial.enabled).toBe(true);
    expect(cfg.exits.partial.closeFraction).toBe(0.3);
  });

  it('parses atrStop config with custom atrPeriod and atrMultiple', () => {
    const cfg = parseExitConfig({
      exits: { atrStop: { enabled: true, atrPeriod: 21, atrMultiple: 3.0 } },
    });
    expect(cfg.exits.atrStop.enabled).toBe(true);
    expect(cfg.exits.atrStop.atrPeriod).toBe(21);
    expect(cfg.exits.atrStop.atrMultiple).toBe(3.0);
  });

  it('parses time exit config with custom maxCandlesHeld', () => {
    const cfg = parseExitConfig({
      exits: { time: { enabled: true, maxCandlesHeld: 10 } },
    });
    expect(cfg.exits.time.enabled).toBe(true);
    expect(cfg.exits.time.maxCandlesHeld).toBe(10);
  });

  it('throws when activateAfterPct exceeds max of 1.0', () => {
    expect(() =>
      parseExitConfig({
        exits: { trailing: { activateAfterPct: 1.5 } },
      }),
    ).toThrow();
  });
});
