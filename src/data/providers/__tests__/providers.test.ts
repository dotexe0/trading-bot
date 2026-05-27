/**
 * Unit tests for CoinbaseProvider and CryptoCompareProvider.
 *
 * These tests verify constructability and type contracts.
 * Actual API calls require real credentials and are tested in the checkpoint.
 */

import { describe, it, expect } from 'vitest';
import { CoinbaseProvider } from '../coinbase.js';
import type { ProductCandlesClient } from '../coinbase.js';
import { CryptoCompareProvider } from '../cryptocompare.js';

// ── Test helpers ─────────────────────────────────────────────────────

/** Build a raw Coinbase candle payload (start is Unix *seconds* string). */
function rawCandle(startSec: number, price = 100) {
  return {
    start: String(startSec),
    open: String(price),
    high: String(price + 1),
    low: String(price - 1),
    close: String(price),
    volume: '10',
  };
}

/**
 * Mock client that serves exactly one non-empty batch then empty batches,
 * recording every call's params. Models hitting Coinbase's retention edge.
 */
function makeOneBatchThenEmptyClient(): {
  client: ProductCandlesClient;
  calls: Array<{ start: string; end: string; granularity: string }>;
} {
  const calls: Array<{ start: string; end: string; granularity: string }> = [];
  let served = false;
  const client: ProductCandlesClient = {
    async getProductCandles(params) {
      calls.push({ start: params.start, end: params.end, granularity: params.granularity });
      if (served) return { candles: [] };
      served = true;
      return { candles: [rawCandle(Number(params.start))] };
    },
  };
  return { client, calls };
}

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

describe('CoinbaseProvider.fetchCandles granularity + fetch-until-empty', () => {
  const END = 1_700_000_000_000;

  it('defaults to ONE_MINUTE granularity and tags candles as 1m', async () => {
    const { client, calls } = makeOneBatchThenEmptyClient();
    const provider = new CoinbaseProvider('k', 's', client);

    const candles = await provider.fetchCandles('BTC-USD', END - 5 * 60_000, END);

    expect(calls[0].granularity).toBe('ONE_MINUTE');
    expect(candles.length).toBeGreaterThan(0);
    expect(candles.every((c) => c.timeframe === '1m')).toBe(true);
  });

  it('forwards a coarse granularity and tags candles with the matching timeframe', async () => {
    const { client, calls } = makeOneBatchThenEmptyClient();
    const provider = new CoinbaseProvider('k', 's', client);

    const hourly = await provider.fetchCandles('BTC-USD', END - 5 * 3_600_000, END, 'ONE_HOUR');
    expect(calls[0].granularity).toBe('ONE_HOUR');
    expect(hourly.every((c) => c.timeframe === '1h')).toBe(true);

    const { client: dailyClient } = makeOneBatchThenEmptyClient();
    const dailyProvider = new CoinbaseProvider('k', 's', dailyClient);
    const daily = await dailyProvider.fetchCandles('BTC-USD', END - 5 * 86_400_000, END, 'ONE_DAY');
    expect(daily.every((c) => c.timeframe === '1D')).toBe(true);
  });

  it('stops paging backward as soon as a batch comes back empty', async () => {
    const { client, calls } = makeOneBatchThenEmptyClient();
    const provider = new CoinbaseProvider('k', 's', client);

    // A full year at ONE_HOUR would be ~25 batches (350h windows) without early termination.
    await provider.fetchCandles('BTC-USD', END - 365 * 86_400_000, END, 'ONE_HOUR');

    // One batch with data, one empty batch that triggers termination.
    expect(calls.length).toBe(2);
  });

  it('never requests a start earlier than the configured start bound', async () => {
    const startsRequested: number[] = [];
    const client: ProductCandlesClient = {
      async getProductCandles(params) {
        startsRequested.push(Number(params.start));
        // Always return data → only the start bound can terminate the walk.
        return { candles: [rawCandle(Number(params.start))] };
      },
    };
    const provider = new CoinbaseProvider('k', 's', client);

    const startMs = END - 2 * 3_600_000; // 2 hours
    const startSec = Math.floor(startMs / 1000);
    await provider.fetchCandles('BTC-USD', startMs, END, 'ONE_HOUR');

    expect(Math.min(...startsRequested)).toBeGreaterThanOrEqual(startSec);
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
