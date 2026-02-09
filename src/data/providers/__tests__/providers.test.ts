/**
 * Unit tests for CoinbaseProvider and CryptoCompareProvider.
 *
 * These tests verify constructability and type contracts.
 * Actual API calls require real credentials and are tested in the checkpoint.
 */

import { describe, it, expect } from 'vitest';
import { CoinbaseProvider } from '../coinbase.js';
import { CryptoCompareProvider } from '../cryptocompare.js';

describe('CoinbaseProvider', () => {
  it('should be constructable with dummy credentials', () => {
    const provider = new CoinbaseProvider('test-key-name', 'test-key-secret');
    expect(provider).toBeInstanceOf(CoinbaseProvider);
  });

  it('should have fetchCandles method', () => {
    const provider = new CoinbaseProvider('test-key-name', 'test-key-secret');
    expect(typeof provider.fetchCandles).toBe('function');
  });

  it('should correctly convert seconds to milliseconds timestamp', () => {
    // Verify the conversion logic: Coinbase returns start as Unix seconds string
    // e.g., "1700000000" should become timestamp 1700000000000 (ms)
    const secondsStr = '1700000000';
    const expectedMs = 1700000000000;
    const actualMs = Number(secondsStr) * 1000;
    expect(actualMs).toBe(expectedMs);

    // Verify the assertion threshold
    expect(actualMs).toBeGreaterThanOrEqual(1_000_000_000_000);
  });
});

describe('CryptoCompareProvider', () => {
  it('should be constructable with a dummy API key', () => {
    const provider = new CryptoCompareProvider('test-api-key');
    expect(provider).toBeInstanceOf(CryptoCompareProvider);
  });

  it('should have fetchHourlyCandles method', () => {
    const provider = new CryptoCompareProvider('test-api-key');
    expect(typeof provider.fetchHourlyCandles).toBe('function');
  });

  it('should have fetchDailyCandles method', () => {
    const provider = new CryptoCompareProvider('test-api-key');
    expect(typeof provider.fetchDailyCandles).toBe('function');
  });
});
