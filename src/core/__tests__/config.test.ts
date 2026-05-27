/**
 * Tests for loadConfig env-var mapping.
 *
 * Focused on data.nativeHistoryDays — the separate, longer history window used
 * for native 1h/1D fetching (vs the 1m `historyDays`).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../config.js';

describe('loadConfig: data.nativeHistoryDays', () => {
  const SAVED_KEYS = [
    'COINBASE_API_KEY_NAME',
    'COINBASE_API_KEY_SECRET',
    'NATIVE_HISTORY_DAYS',
  ] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of SAVED_KEYS) saved[k] = process.env[k];
    process.env.COINBASE_API_KEY_NAME = 'test-key';
    process.env.COINBASE_API_KEY_SECRET = 'test-secret';
  });

  afterEach(() => {
    for (const k of SAVED_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('defaults to 1095 (3 years) when NATIVE_HISTORY_DAYS is unset', () => {
    delete process.env.NATIVE_HISTORY_DAYS;
    const config = loadConfig();
    expect(config.data.nativeHistoryDays).toBe(1095);
  });

  it('parses NATIVE_HISTORY_DAYS from the environment', () => {
    process.env.NATIVE_HISTORY_DAYS = '730';
    const config = loadConfig();
    expect(config.data.nativeHistoryDays).toBe(730);
  });
});
