/**
 * Tests for fcmConfigSchema perpMode validation (INFRA-01).
 * Verifies that the cross-field refine correctly rejects live/paper
 * modes when FCM is disabled.
 *
 * Also validates leverage cap for scalping (SCALP-02):
 * defaultLeverage max raised to 20, scalpingTimeframe field defaults to '5m'.
 */
import { describe, it, expect } from 'vitest';
import { fcmConfigSchema } from '../config.js';

const validBase = {
  enabled: true,
  apiKey: 'key',
  apiSecret: 'secret',
};

describe('leverage cap for scalping', () => {
  it('accepts defaultLeverage of 15 (within new max of 20)', () => {
    expect(() => fcmConfigSchema.parse({ ...validBase, defaultLeverage: 15 })).not.toThrow();
  });

  it('rejects defaultLeverage of 21 (above max of 20)', () => {
    expect(() => fcmConfigSchema.parse({ ...validBase, defaultLeverage: 21 })).toThrow();
  });

  it('defaults scalpingTimeframe to 5m', () => {
    const cfg = fcmConfigSchema.parse({});
    expect(cfg.scalpingTimeframe).toBe('5m');
  });
});

describe('fcmConfigSchema – maxDailyLossUsd', () => {
  it('defaults maxDailyLossUsd to 500', () => {
    const cfg = fcmConfigSchema.parse({});
    expect(cfg.maxDailyLossUsd).toBe(500);
  });

  it('accepts custom maxDailyLossUsd', () => {
    const cfg = fcmConfigSchema.parse({ maxDailyLossUsd: 200 });
    expect(cfg.maxDailyLossUsd).toBe(200);
  });
});

describe('fcmConfigSchema – perpMode validation', () => {
  it('passes when PERP_MODE is none and FCM is disabled (default)', () => {
    const result = fcmConfigSchema.safeParse({ enabled: false });
    expect(result.success).toBe(true);
    expect(result.data?.perpMode).toBe('none');
  });

  it('passes when PERP_MODE is omitted (defaults to none)', () => {
    const result = fcmConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    expect(result.data?.perpMode).toBe('none');
  });

  it('passes when PERP_MODE=paper and FCM_ENABLED=true', () => {
    const result = fcmConfigSchema.safeParse({
      enabled: true,
      apiKey: 'key',
      apiSecret: 'secret',
      perpMode: 'paper',
    });
    expect(result.success).toBe(true);
  });

  it('passes when PERP_MODE=live and FCM_ENABLED=true', () => {
    const result = fcmConfigSchema.safeParse({
      enabled: true,
      apiKey: 'key',
      apiSecret: 'secret',
      perpMode: 'live',
    });
    expect(result.success).toBe(true);
  });

  it('fails when PERP_MODE=live and FCM_ENABLED=false', () => {
    const result = fcmConfigSchema.safeParse({
      enabled: false,
      perpMode: 'live',
    });
    expect(result.success).toBe(false);
    const issue = result.error?.issues.find((i) => i.path.includes('perpMode'));
    expect(issue?.message).toMatch(/FCM_ENABLED=true is required/);
  });

  it('fails when PERP_MODE=paper and FCM_ENABLED=false', () => {
    const result = fcmConfigSchema.safeParse({
      enabled: false,
      perpMode: 'paper',
    });
    expect(result.success).toBe(false);
    const issue = result.error?.issues.find((i) => i.path.includes('perpMode'));
    expect(issue?.message).toMatch(/FCM_ENABLED=true is required/);
  });
});
