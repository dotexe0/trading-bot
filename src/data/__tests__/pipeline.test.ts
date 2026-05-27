/**
 * Tests for DataPipeline.runFull native higher-timeframe wiring.
 *
 * Verifies the post-design data flow:
 *   - 1m is fetched and aggregated to 5m/15m ONLY (no longer to 1h/1D/4h)
 *   - native 1h and 1D are fetched directly and stored as the sole source
 *   - 4h is derived from the stored native 1h
 *
 * Uses an injected mock provider + an in-memory SQLite DB.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { DataPipeline } from '../pipeline.js';
import type { CandleFetcher } from '../pipeline.js';
import { CandleRepository } from '../storage/candle-repo.js';
import { createDatabase, initializeSchema } from '../storage/db.js';
import type { Candle, TradingPair, Timeframe } from '../../core/types.js';
import { TIMEFRAME_MS } from '../../core/types.js';
import type { Config } from '../../core/config.js';
import type { CandleGranularity } from '../providers/coinbase.js';

// ── Test helpers ─────────────────────────────────────────────────────

const MIN = TIMEFRAME_MS['1m'];
const HOUR = TIMEFRAME_MS['1h'];
const DAY = TIMEFRAME_MS['1D'];
const FOUR_H = TIMEFRAME_MS['4h'];
const FIFTEEN_M = TIMEFRAME_MS['15m'];

function candle(pair: TradingPair, timeframe: Timeframe, timestamp: number): Candle {
  return {
    pair,
    timeframe,
    timestamp,
    open: '100',
    high: '101',
    low: '99',
    close: '100',
    volume: '10',
  };
}

function makeConfig(): Config {
  // Only the fields DataPipeline reads; provider is injected so coinbase keys are unused.
  return {
    coinbase: { apiKeyName: 'x', apiKeySecret: 'y' },
    cryptoCompare: { apiKey: '' },
    data: {
      pairs: ['BTC-USD'],
      historyDays: 365,
      nativeHistoryDays: 1095,
    },
  } as unknown as Config;
}

// 60 contiguous 1m candles aligned to a 15m boundary → 12 × 5m, 4 × 15m windows.
const MINUTE_BASE = Math.floor(1_700_000_000_000 / FIFTEEN_M) * FIFTEEN_M;
const MINUTE_CANDLES = Array.from({ length: 60 }, (_, i) =>
  candle('BTC-USD', '1m', MINUTE_BASE + i * MIN),
);

// 100 contiguous native 1h candles aligned to a 4h boundary, placed well before
// the 1m window → 25 × 4h windows; distinct timestamps from any 1m-derived hour.
const HOUR_BASE = Math.floor((MINUTE_BASE - 500 * HOUR) / FOUR_H) * FOUR_H;
const HOUR_CANDLES = Array.from({ length: 100 }, (_, i) =>
  candle('BTC-USD', '1h', HOUR_BASE + i * HOUR),
);

// 30 native 1D candles.
const DAY_BASE = Math.floor((HOUR_BASE - 90 * DAY) / DAY) * DAY;
const DAY_CANDLES = Array.from({ length: 30 }, (_, i) =>
  candle('BTC-USD', '1D', DAY_BASE + i * DAY),
);

interface FetchCall {
  granularity: CandleGranularity;
}

function makeMockFetcher(): { fetcher: CandleFetcher; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetcher: CandleFetcher = {
    async fetchCandles(_pair, _startMs, _endMs, granularity = 'ONE_MINUTE') {
      calls.push({ granularity });
      if (granularity === 'ONE_HOUR') return HOUR_CANDLES;
      if (granularity === 'ONE_DAY') return DAY_CANDLES;
      return MINUTE_CANDLES;
    },
  };
  return { fetcher, calls };
}

describe('DataPipeline.runFull native higher-timeframe wiring', () => {
  let repo: CandleRepository;
  let calls: FetchCall[];

  beforeEach(async () => {
    const { db, sqlite } = createDatabase(':memory:');
    initializeSchema(sqlite);
    repo = new CandleRepository(db);

    const mock = makeMockFetcher();
    calls = mock.calls;
    const pipeline = new DataPipeline(makeConfig(), repo, mock.fetcher);
    await pipeline.runFull('BTC-USD');
  });

  it('fetches native 1h and 1D directly (not aggregated from 1m)', () => {
    expect(repo.getCandleCount('BTC-USD', '1h')).toBe(100);
    expect(repo.getCandleCount('BTC-USD', '1D')).toBe(30);

    // No 1h candle was synthesised in the recent 1m window — proves 1m→1h
    // aggregation was removed (native fetch is the sole 1h source).
    const oneHourWindow = Math.floor(MINUTE_BASE / HOUR) * HOUR;
    const inMinuteRange = repo.getCandles('BTC-USD', '1h', oneHourWindow, oneHourWindow + HOUR);
    expect(inMinuteRange).toHaveLength(0);
  });

  it('requests both coarse granularities natively', () => {
    const requested = calls.map((c) => c.granularity);
    expect(requested).toContain('ONE_HOUR');
    expect(requested).toContain('ONE_DAY');
  });

  it('aggregates 5m and 15m from 1m', () => {
    expect(repo.getCandleCount('BTC-USD', '5m')).toBe(12);
    expect(repo.getCandleCount('BTC-USD', '15m')).toBe(4);
  });

  it('derives 4h from the stored native 1h', () => {
    expect(repo.getCandleCount('BTC-USD', '4h')).toBe(25);
  });
});
