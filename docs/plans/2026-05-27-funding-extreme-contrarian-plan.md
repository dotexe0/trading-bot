# Funding-Extreme Contrarian Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the bot's first funding-driven strategy: fetch Coinbase INTX hourly funding history into the DB, expose a lookahead-safe accessor, implement a percentile-extreme contrarian strategy on FCM perps, and wire it into the perp tournament so it can be walk-forward validated under the existing gates.

**Architecture:** Four independently-testable units — (1) funding data layer (provider + repo + sync pipeline with forward-and-backfill), (2) lookahead-safe `FundingHistory` accessor, (3) `FundingExtremeContrarianStrategy` (rolling-percentile signal, low parameter count, two-sided on FCM perp), (4) perp-tournament wiring that loads per-pair funding and injects the accessor only into the new strategy (existing funding-aware strategies deliberately unchanged).

**Tech Stack:** TypeScript (ESM), better-sqlite3 + Drizzle, Zod v4, Vitest, decimal.js, native `fetch`.

**Spec:** `docs/plans/2026-05-27-funding-extreme-contrarian-design.md`

---

## File Structure

**Create:**
- `src/data/storage/funding-rate-repo.ts` — `FundingRateRepository` (CRUD, mirrors `CandleRepository`)
- `src/data/storage/__tests__/funding-rate-repo.test.ts`
- `src/data/providers/intx-funding.ts` — `IntxFundingProvider` (paginated INTX REST fetcher, injectable HTTP client)
- `src/data/providers/__tests__/intx-funding.test.ts`
- `src/data/funding-pipeline.ts` — `FundingPipeline.syncPair(pair)` (forward top-up + backward backfill)
- `src/data/__tests__/funding-pipeline.test.ts`
- `src/cli/fetch-funding.ts` — standalone CLI entry
- `src/perp/funding-history.ts` — `FundingHistory` interface + `HistoricalFundingHistory` impl
- `src/perp/__tests__/funding-history.test.ts`
- `src/perp/strategies/funding-extreme-contrarian.ts` — `FundingExtremeContrarianStrategy`
- `src/perp/strategies/__tests__/funding-extreme-contrarian.test.ts`

**Modify:**
- `src/data/storage/schema.ts` — add `fundingRates` table definition
- `src/data/storage/db.ts` — add CREATE TABLE inside `initializeSchema`
- `src/core/config.ts` — add `data.fundingHistoryDays` (default 1095) + `FUNDING_HISTORY_DAYS` env
- `src/cli/fetch-data.ts` — invoke funding pipeline after candle pipeline
- `src/strategies/config.ts` — add `funding-extreme-contrarian` schema variant
- `src/perp/strategies/index.ts` — register `funding-extreme-contrarian` factory; accept optional `fundingHistory` param
- `src/perp/perp-tournament-runner.ts` — load per-pair funding into a `HistoricalFundingHistory`; build registry with that accessor; add the new strategy to `buildPerpParamGrid`
- `package.json` — add `"fetch:funding": "tsx src/cli/fetch-funding.ts"` script

**Out of scope (deliberate, deferred):** `LiveFundingHistory` impl + registration in `createLivePerpRegistry`. The strategy is validation-only until the gates clear; live wiring is a follow-on.

---

## Task 1: Funding-rates table schema + Drizzle entity

**Files:**
- Modify: `src/data/storage/schema.ts`
- Modify: `src/data/storage/db.ts`

- [ ] **Step 1: Add Drizzle table to `schema.ts`**

Append to `src/data/storage/schema.ts` (alongside the existing `candles` table — match its style):

```ts
import { sqliteTable, integer, text, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

// ...existing exports...

export const fundingRates = sqliteTable(
  'funding_rates',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    pair: text('pair').notNull(),
    timestamp: integer('timestamp').notNull(), // Unix ms, start of funding interval
    fundingRate: text('funding_rate').notNull(), // decimal string
    markPrice: text('mark_price').notNull(),    // decimal string
  },
  (t) => ({
    unique: uniqueIndex('idx_funding_unique').on(t.pair, t.timestamp),
    byPairTs: index('idx_funding_pair_ts').on(t.pair, t.timestamp),
  }),
);
```

If the existing `candles` table uses a slightly different drizzle import style, open `schema.ts` first and mirror it exactly.

- [ ] **Step 2: Add CREATE TABLE to `initializeSchema`**

In `src/data/storage/db.ts`, inside the existing raw-SQL block in `initializeSchema` (alongside the existing candles CREATE block), append:

```sql
CREATE TABLE IF NOT EXISTS funding_rates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pair TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  funding_rate TEXT NOT NULL,
  mark_price TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_funding_unique
  ON funding_rates (pair, timestamp);

CREATE INDEX IF NOT EXISTS idx_funding_pair_ts
  ON funding_rates (pair, timestamp);
```

- [ ] **Step 3: Verify the schema compiles**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 4: Commit**

```
git add src/data/storage/schema.ts src/data/storage/db.ts
git commit -m "feat(funding): add funding_rates table schema"
```

---

## Task 2: FundingRateRepository (TDD)

**Files:**
- Create: `src/data/storage/funding-rate-repo.ts`
- Test: `src/data/storage/__tests__/funding-rate-repo.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/data/storage/__tests__/funding-rate-repo.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createDatabase, initializeSchema } from '../db.js';
import { FundingRateRepository } from '../funding-rate-repo.js';

function makeRepo(): FundingRateRepository {
  const { db, sqlite } = createDatabase(':memory:');
  initializeSchema(sqlite);
  return new FundingRateRepository(db);
}

describe('FundingRateRepository', () => {
  let repo: FundingRateRepository;
  beforeEach(() => { repo = makeRepo(); });

  it('round-trips inserted funding rates within a range', () => {
    const rows = [
      { pair: 'BTC-USD' as const, timestamp: 1_700_000_000_000, fundingRate: '0.00001', markPrice: '40000' },
      { pair: 'BTC-USD' as const, timestamp: 1_700_003_600_000, fundingRate: '0.00002', markPrice: '40010' },
    ];
    expect(repo.insertFundingRates(rows)).toBe(2);
    const got = repo.getFundingRates('BTC-USD', 0, Date.now());
    expect(got).toHaveLength(2);
    expect(got[0].fundingRate).toBe('0.00001');
  });

  it('dedupes on (pair, timestamp) via unique index', () => {
    const dup = { pair: 'BTC-USD' as const, timestamp: 1_700_000_000_000, fundingRate: '0.00001', markPrice: '40000' };
    repo.insertFundingRates([dup]);
    expect(repo.insertFundingRates([dup])).toBe(0);
    expect(repo.getCount('BTC-USD')).toBe(1);
  });

  it('reports earliest and latest timestamps, or null when empty', () => {
    expect(repo.getEarliestTimestamp('BTC-USD')).toBeNull();
    expect(repo.getLatestTimestamp('BTC-USD')).toBeNull();
    repo.insertFundingRates([
      { pair: 'BTC-USD', timestamp: 200, fundingRate: '0.0', markPrice: '1' },
      { pair: 'BTC-USD', timestamp: 100, fundingRate: '0.0', markPrice: '1' },
      { pair: 'BTC-USD', timestamp: 300, fundingRate: '0.0', markPrice: '1' },
    ]);
    expect(repo.getEarliestTimestamp('BTC-USD')).toBe(100);
    expect(repo.getLatestTimestamp('BTC-USD')).toBe(300);
  });
});
```

- [ ] **Step 2: Run and watch fail**

Run: `npx vitest run src/data/storage/__tests__/funding-rate-repo.test.ts`
Expected: import fails — clean RED.

- [ ] **Step 3: Implement the repository**

Create `src/data/storage/funding-rate-repo.ts`:

```ts
/**
 * Repository for hourly perpetual funding rates (per pair).
 * Mirrors CandleRepository in interface shape; ON CONFLICT DO NOTHING dedupes
 * via the (pair, timestamp) unique index.
 */
import { and, asc, eq, gte, lte, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';
import { fundingRates } from './schema.js';
import type { TradingPair } from '../../core/types.js';

type DB = BetterSQLite3Database<typeof schema>;

export interface FundingRateRow {
  pair: TradingPair;
  timestamp: number;
  fundingRate: string;
  markPrice: string;
}

export class FundingRateRepository {
  constructor(private readonly db: DB) {}

  insertFundingRates(rows: FundingRateRow[]): number {
    if (rows.length === 0) return 0;
    let inserted = 0;
    this.db.transaction((tx) => {
      for (const r of rows) {
        const result = tx
          .insert(fundingRates)
          .values({
            pair: r.pair,
            timestamp: r.timestamp,
            fundingRate: r.fundingRate,
            markPrice: r.markPrice,
          })
          .onConflictDoNothing()
          .run();
        inserted += result.changes;
      }
    });
    return inserted;
  }

  getFundingRates(pair: TradingPair, startMs: number, endMs: number): FundingRateRow[] {
    const rows = this.db
      .select()
      .from(fundingRates)
      .where(
        and(
          eq(fundingRates.pair, pair),
          gte(fundingRates.timestamp, startMs),
          lte(fundingRates.timestamp, endMs),
        ),
      )
      .orderBy(asc(fundingRates.timestamp))
      .all();
    return rows.map((row) => ({
      pair: row.pair as TradingPair,
      timestamp: row.timestamp,
      fundingRate: row.fundingRate,
      markPrice: row.markPrice,
    }));
  }

  getLatestTimestamp(pair: TradingPair): number | null {
    const result = this.db
      .select({ maxTs: sql<number>`MAX(${fundingRates.timestamp})` })
      .from(fundingRates)
      .where(eq(fundingRates.pair, pair))
      .get();
    return result?.maxTs ?? null;
  }

  getEarliestTimestamp(pair: TradingPair): number | null {
    const result = this.db
      .select({ minTs: sql<number>`MIN(${fundingRates.timestamp})` })
      .from(fundingRates)
      .where(eq(fundingRates.pair, pair))
      .get();
    return result?.minTs ?? null;
  }

  getCount(pair: TradingPair): number {
    const result = this.db
      .select({ count: sql<number>`COUNT(*)` })
      .from(fundingRates)
      .where(eq(fundingRates.pair, pair))
      .get();
    return result?.count ?? 0;
  }
}
```

- [ ] **Step 4: Run and watch pass**

Run: `npx vitest run src/data/storage/__tests__/funding-rate-repo.test.ts`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```
git add src/data/storage/funding-rate-repo.ts src/data/storage/__tests__/funding-rate-repo.test.ts
git commit -m "feat(funding): FundingRateRepository with insert/range/extremes"
```

---

## Task 3: IntxFundingProvider (TDD)

The spike confirmed `GET https://api.international.coinbase.com/api/v1/instruments/{instrument}/funding?result_limit=300&result_offset=N` returns `{results: [{event_time, funding_rate, mark_price, ...}], pagination: {...}}` newest-first. Page until empty OR until `event_time < startMs`.

**Files:**
- Create: `src/data/providers/intx-funding.ts`
- Test: `src/data/providers/__tests__/intx-funding.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/data/providers/__tests__/intx-funding.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { IntxFundingProvider, type IntxHttpClient } from '../intx-funding.js';

function rawPoint(eventTimeIso: string, rate = '0.00001', mark = '40000') {
  return { event_time: eventTimeIso, funding_rate: rate, mark_price: mark };
}

function makeClient(pages: object[][]): { client: IntxHttpClient; calls: { url: string }[] } {
  const calls: { url: string }[] = [];
  let i = 0;
  const client: IntxHttpClient = {
    async getJson(url: string) {
      calls.push({ url });
      const results = pages[i] ?? [];
      i++;
      return { pagination: { result_limit: 300, result_offset: 0 }, results };
    },
  };
  return { client, calls };
}

describe('IntxFundingProvider', () => {
  it('maps BTC-USD -> BTC-PERP and ETH-USD -> ETH-PERP in the URL', async () => {
    const { client, calls } = makeClient([[]]);
    const provider = new IntxFundingProvider(client);
    await provider.fetchFundingHistory('BTC-USD', 0, Date.now());
    expect(calls[0].url).toContain('/instruments/BTC-PERP/funding');

    const eth = makeClient([[]]);
    const ethProvider = new IntxFundingProvider(eth.client);
    await ethProvider.fetchFundingHistory('ETH-USD', 0, Date.now());
    expect(eth.calls[0].url).toContain('/instruments/ETH-PERP/funding');
  });

  it('paginates via result_offset until an empty page', async () => {
    const { client, calls } = makeClient([
      [rawPoint('2026-05-27T16:00:00Z'), rawPoint('2026-05-27T15:00:00Z')],
      [rawPoint('2026-05-27T14:00:00Z')],
      [],
    ]);
    const provider = new IntxFundingProvider(client);
    const out = await provider.fetchFundingHistory('BTC-USD', 0, Date.now());
    expect(out).toHaveLength(3);
    expect(calls.length).toBe(3);
    expect(calls[0].url).toContain('result_offset=0');
    expect(calls[1].url).toContain('result_offset=2');
    expect(calls[2].url).toContain('result_offset=3');
  });

  it('terminates when results cross the configured start bound', async () => {
    const start = Date.parse('2026-05-27T15:00:00Z');
    const { client, calls } = makeClient([
      [rawPoint('2026-05-27T16:00:00Z'), rawPoint('2026-05-27T14:00:00Z')],
      [rawPoint('2026-05-27T13:00:00Z')],
    ]);
    const provider = new IntxFundingProvider(client);
    const out = await provider.fetchFundingHistory('BTC-USD', start, Date.now());
    expect(out.map((r) => r.timestamp)).toEqual([
      Date.parse('2026-05-27T16:00:00Z'),
    ]);
    expect(calls.length).toBe(1);
  });

  it('converts ISO event_time to Unix ms and preserves decimal strings', async () => {
    const { client } = makeClient([
      [rawPoint('2026-05-27T16:00:00Z', '0.0000123', '40000.5')],
      [],
    ]);
    const provider = new IntxFundingProvider(client);
    const out = await provider.fetchFundingHistory('BTC-USD', 0, Date.now());
    expect(out[0].timestamp).toBe(Date.parse('2026-05-27T16:00:00Z'));
    expect(out[0].fundingRate).toBe('0.0000123');
    expect(out[0].markPrice).toBe('40000.5');
    expect(out[0].pair).toBe('BTC-USD');
  });
});
```

- [ ] **Step 2: Run and watch fail**

Run: `npx vitest run src/data/providers/__tests__/intx-funding.test.ts`
Expected: import fails — clean RED.

- [ ] **Step 3: Implement the provider**

Create `src/data/providers/intx-funding.ts`:

```ts
/**
 * Coinbase INTX public funding-rate provider.
 *
 * Endpoint:
 *   GET https://api.international.coinbase.com/api/v1/instruments/{instrument}/funding
 *   ?result_limit=300&result_offset=N
 *
 * Returns hourly funding rates newest-first. Pages via result_offset; stops
 * when a page is empty OR when its oldest record is < startMs. Public endpoint
 * — no auth required, reachable from US (spike 2026-05-27).
 */
import type { TradingPair } from '../../core/types.js';
import type { FundingRateRow } from '../storage/funding-rate-repo.js';
import { createModuleLogger } from '../../core/logger.js';
import { DataProviderError } from '../../core/errors.js';

const log = createModuleLogger('intx-funding-provider');

const BASE_URL = 'https://api.international.coinbase.com';
const PAGE_SIZE = 300;
const THROTTLE_MS = 35;

/** Minimal HTTP shape this provider depends on — injectable for tests. */
export interface IntxHttpClient {
  getJson(url: string): Promise<unknown>;
}

interface RawFundingRow {
  event_time: string;
  funding_rate: string;
  mark_price: string;
}

const PAIR_TO_INSTRUMENT: Record<TradingPair, string> = {
  'BTC-USD': 'BTC-PERP',
  'ETH-USD': 'ETH-PERP',
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function defaultClient(): IntxHttpClient {
  return {
    async getJson(url: string) {
      const res = await fetch(url, { headers: { 'User-Agent': 'trading-bot/funding-sync' } });
      if (!res.ok) {
        throw new DataProviderError(
          `INTX funding HTTP ${res.status} ${res.statusText} for ${url}`,
          'intx',
          res.status,
        );
      }
      return res.json();
    },
  };
}

export class IntxFundingProvider {
  constructor(private readonly client: IntxHttpClient = defaultClient()) {}

  async fetchFundingHistory(
    pair: TradingPair,
    startMs: number,
    _endMs: number,
  ): Promise<FundingRateRow[]> {
    const instrument = PAIR_TO_INSTRUMENT[pair];
    const all: FundingRateRow[] = [];
    let offset = 0;
    let pages = 0;

    while (true) {
      const url = `${BASE_URL}/api/v1/instruments/${instrument}/funding?result_limit=${PAGE_SIZE}&result_offset=${offset}`;
      const response = (await this.client.getJson(url)) as { results?: RawFundingRow[] };
      const raw = response.results ?? [];
      pages++;

      if (raw.length === 0) {
        log.info({ pair, instrument, fetched: all.length, pages }, 'INTX funding page empty — stopping');
        break;
      }

      let crossedStart = false;
      for (const r of raw) {
        const ts = Date.parse(r.event_time);
        if (ts < startMs) { crossedStart = true; continue; }
        all.push({ pair, timestamp: ts, fundingRate: r.funding_rate, markPrice: r.mark_price });
      }

      if (crossedStart) {
        log.info({ pair, instrument, fetched: all.length, pages }, 'INTX funding crossed startMs — stopping');
        break;
      }

      offset += raw.length;
      await sleep(THROTTLE_MS);
    }

    all.sort((a, b) => a.timestamp - b.timestamp);
    return all;
  }
}
```

- [ ] **Step 4: Run and watch pass**

Run: `npx vitest run src/data/providers/__tests__/intx-funding.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```
git add src/data/providers/intx-funding.ts src/data/providers/__tests__/intx-funding.test.ts
git commit -m "feat(funding): IntxFundingProvider with pagination + start-bound termination"
```

---

## Task 4: Config field `data.fundingHistoryDays`

**Files:**
- Modify: `src/core/config.ts`
- Modify: `src/core/__tests__/config.test.ts`

- [ ] **Step 1: Add failing test cases for the new field**

Append to `src/core/__tests__/config.test.ts` (do not remove existing blocks):

```ts
describe('loadConfig: data.fundingHistoryDays', () => {
  const SAVED_KEYS = [
    'COINBASE_API_KEY_NAME',
    'COINBASE_API_KEY_SECRET',
    'FUNDING_HISTORY_DAYS',
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

  it('defaults to 1095 (3 years) when FUNDING_HISTORY_DAYS is unset', () => {
    delete process.env.FUNDING_HISTORY_DAYS;
    expect(loadConfig().data.fundingHistoryDays).toBe(1095);
  });

  it('parses FUNDING_HISTORY_DAYS from the environment', () => {
    process.env.FUNDING_HISTORY_DAYS = '365';
    expect(loadConfig().data.fundingHistoryDays).toBe(365);
  });
});
```

- [ ] **Step 2: Run and watch fail**

Run: `npx vitest run src/core/__tests__/config.test.ts`
Expected: 2 new tests fail.

- [ ] **Step 3: Add the schema field and env parsing**

In `src/core/config.ts`, locate the `data:` object in `configSchema` and add the new field next to `nativeHistoryDays`:

```ts
/**
 * History window (days) for INTX funding-rate fetching. Mirrors
 * nativeHistoryDays (3yr) — INTX retains ~3.2yr of hourly funding.
 */
fundingHistoryDays: z.number().int().positive().default(1095),
```

In the same file, locate the `rawConfig.data` object in `loadConfig()` and add the new env parsing next to `nativeHistoryDays`:

```ts
fundingHistoryDays: env.FUNDING_HISTORY_DAYS
  ? parseInt(env.FUNDING_HISTORY_DAYS, 10)
  : 1095,
```

Add a JSDoc line above `loadConfig` (near `NATIVE_HISTORY_DAYS`):

`* - FUNDING_HISTORY_DAYS -> data.fundingHistoryDays (parsed as int, default 1095 = 3yr)`

- [ ] **Step 4: Run and watch pass**

Run: `npx vitest run src/core/__tests__/config.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```
git add src/core/config.ts src/core/__tests__/config.test.ts
git commit -m "feat(funding): config.data.fundingHistoryDays (default 1095, env FUNDING_HISTORY_DAYS)"
```

---

## Task 5: FundingPipeline (TDD — forward top-up + backward backfill)

Same two-pass shape as the candle native-fetch fix earlier this session. Forward-only resume leaves a shallow DB stuck; explicit backward backfill is required. There's an explicit regression test for this.

**Files:**
- Create: `src/data/funding-pipeline.ts`
- Test: `src/data/__tests__/funding-pipeline.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/data/__tests__/funding-pipeline.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createDatabase, initializeSchema } from '../storage/db.js';
import { FundingRateRepository, type FundingRateRow } from '../storage/funding-rate-repo.js';
import { FundingPipeline, type FundingFetcher } from '../funding-pipeline.js';
import type { TradingPair } from '../../core/types.js';

const HOUR = 3_600_000;
const DAY = 86_400_000;

function makeRow(pair: TradingPair, ts: number): FundingRateRow {
  return { pair, timestamp: ts, fundingRate: '0.00001', markPrice: '40000' };
}

interface Call { pair: TradingPair; startMs: number; endMs: number; }
function makeFetcher(serve: (pair: TradingPair, start: number, end: number) => FundingRateRow[]) {
  const calls: Call[] = [];
  const fetcher: FundingFetcher = {
    async fetchFundingHistory(pair, startMs, endMs) {
      calls.push({ pair, startMs, endMs });
      return serve(pair, startMs, endMs);
    },
  };
  return { fetcher, calls };
}

describe('FundingPipeline.syncPair', () => {
  it('does a full backfill when the DB is empty', async () => {
    const { db, sqlite } = createDatabase(':memory:');
    initializeSchema(sqlite);
    const repo = new FundingRateRepository(db);
    const now = Date.now();
    const target = now - 30 * DAY;
    const { fetcher } = makeFetcher((pair) => [
      makeRow(pair, target + HOUR),
      makeRow(pair, target + 2 * HOUR),
    ]);
    const pipeline = new FundingPipeline({ repo, fetcher, historyDays: 30 });
    await pipeline.syncPair('BTC-USD');
    expect(repo.getCount('BTC-USD')).toBe(2);
  });

  it('forward top-up extends to now from latest stored', async () => {
    const { db, sqlite } = createDatabase(':memory:');
    initializeSchema(sqlite);
    const repo = new FundingRateRepository(db);
    const now = Date.now();
    const latestStored = now - 3 * HOUR;
    repo.insertFundingRates([
      makeRow('BTC-USD', now - 5 * HOUR),
      makeRow('BTC-USD', now - 4 * HOUR),
      makeRow('BTC-USD', latestStored),
    ]);
    const { fetcher, calls } = makeFetcher((pair, _start) => [
      makeRow(pair, latestStored + HOUR),
      makeRow(pair, latestStored + 2 * HOUR),
    ]);
    const pipeline = new FundingPipeline({ repo, fetcher, historyDays: 1 });
    await pipeline.syncPair('BTC-USD');

    const forwardCall = calls.find((c) => c.startMs === latestStored);
    expect(forwardCall).toBeDefined();
    expect(repo.getLatestTimestamp('BTC-USD')).toBe(latestStored + 2 * HOUR);
  });

  it('REGRESSION: shallow DB triggers backward backfill toward target', async () => {
    const { db, sqlite } = createDatabase(':memory:');
    initializeSchema(sqlite);
    const repo = new FundingRateRepository(db);
    const now = Date.now();

    const shallowStart = now - 10 * DAY;
    for (let i = 0; i < 200; i++) {
      repo.insertFundingRates([makeRow('BTC-USD', shallowStart + i * HOUR)]);
    }

    const { fetcher, calls } = makeFetcher(() => []);
    const pipeline = new FundingPipeline({ repo, fetcher, historyDays: 1000 });
    await pipeline.syncPair('BTC-USD');

    const minStart = Math.min(...calls.map((c) => c.startMs));
    expect(minStart).toBeLessThanOrEqual(now - 900 * DAY);
  });
});
```

- [ ] **Step 2: Run and watch fail**

Run: `npx vitest run src/data/__tests__/funding-pipeline.test.ts`
Expected: import fails — RED.

- [ ] **Step 3: Implement the pipeline**

Create `src/data/funding-pipeline.ts`:

```ts
/**
 * FundingPipeline.syncPair — forward top-up + backward backfill of funding history.
 *
 * Mirrors DataPipeline.syncNativeTimeframe (fixed earlier this session): a
 * forward-only resume leaves a shallow DB stuck; an explicit backward backfill
 * is required when earliest stored is more recent than the target depth.
 */
import { createModuleLogger } from '../core/logger.js';
import type { TradingPair } from '../core/types.js';
import type { FundingRateRepository, FundingRateRow } from './storage/funding-rate-repo.js';

const log = createModuleLogger('funding-pipeline');
const DAY_MS = 86_400_000;

export interface FundingFetcher {
  fetchFundingHistory(
    pair: TradingPair,
    startMs: number,
    endMs: number,
  ): Promise<FundingRateRow[]>;
}

export interface FundingPipelineDeps {
  repo: FundingRateRepository;
  fetcher: FundingFetcher;
  historyDays: number;
}

export class FundingPipeline {
  constructor(private readonly deps: FundingPipelineDeps) {}

  async syncPair(pair: TradingPair): Promise<void> {
    const { repo, historyDays } = this.deps;
    const endMs = Date.now();
    const targetStartMs = endMs - historyDays * DAY_MS;
    const latest = repo.getLatestTimestamp(pair);
    const earliest = repo.getEarliestTimestamp(pair);

    if (latest !== null) {
      await this.fetchAndStore(pair, latest, endMs, 'forward');
    }

    if (earliest === null || earliest > targetStartMs) {
      const backfillEnd = earliest ?? endMs;
      await this.fetchAndStore(pair, targetStartMs, backfillEnd, 'backfill');
    }
  }

  private async fetchAndStore(
    pair: TradingPair,
    startMs: number,
    endMs: number,
    mode: 'forward' | 'backfill',
  ): Promise<void> {
    log.info(
      {
        pair,
        mode,
        from: new Date(startMs).toISOString(),
        to: new Date(endMs).toISOString(),
      },
      'Fetching funding history',
    );
    try {
      const rows = await this.deps.fetcher.fetchFundingHistory(pair, startMs, endMs);
      const valid = rows.filter((r) => Number.isFinite(Number(r.fundingRate)) && Number(r.markPrice) > 0);
      const inserted = this.deps.repo.insertFundingRates(valid);
      log.info(
        { pair, mode, fetched: rows.length, valid: valid.length, stored: inserted },
        'Funding rows stored',
      );
    } catch (err) {
      log.error(
        { pair, mode, err: err instanceof Error ? err.message : String(err) },
        'Funding fetch failed — preserving existing data',
      );
    }
  }
}
```

- [ ] **Step 4: Run and watch pass**

Run: `npx vitest run src/data/__tests__/funding-pipeline.test.ts`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```
git add src/data/funding-pipeline.ts src/data/__tests__/funding-pipeline.test.ts
git commit -m "feat(funding): FundingPipeline.syncPair with forward top-up + backward backfill"
```

---

## Task 6: CLI wiring — `npm run fetch:funding` + integration with `fetch-data`

**Files:**
- Create: `src/cli/fetch-funding.ts`
- Modify: `src/cli/fetch-data.ts`
- Modify: `package.json`

- [ ] **Step 1: Create the standalone CLI**

Create `src/cli/fetch-funding.ts`:

```ts
/**
 * CLI entry: fetch INTX funding history for all configured pairs.
 * Usage: npm run fetch:funding
 */
import { loadConfig } from '../core/config.js';
import { ConfigError } from '../core/errors.js';
import { createModuleLogger } from '../core/logger.js';
import { createDatabase, initializeSchema } from '../data/storage/db.js';
import { FundingRateRepository } from '../data/storage/funding-rate-repo.js';
import { IntxFundingProvider } from '../data/providers/intx-funding.js';
import { FundingPipeline } from '../data/funding-pipeline.js';

const log = createModuleLogger('fetch-funding');

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      log.error({ error: err.message }, 'Configuration error');
      process.exit(1);
    }
    throw err;
  }

  const { db, sqlite } = createDatabase(config.database.path);
  initializeSchema(sqlite);
  const repo = new FundingRateRepository(db);
  const fetcher = new IntxFundingProvider();
  const pipeline = new FundingPipeline({
    repo,
    fetcher,
    historyDays: config.data.fundingHistoryDays,
  });

  try {
    for (const pair of config.data.pairs) {
      log.info({ pair }, 'Syncing funding history');
      await pipeline.syncPair(pair);
    }
    log.info('Funding fetch complete');
  } catch (err) {
    log.error({ error: err instanceof Error ? err.message : String(err) }, 'Funding fetch failed');
    process.exit(1);
  } finally {
    sqlite.close();
  }
}

main().catch((err) => {
  console.error('Unhandled:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Wire the script into `package.json`**

In `package.json` `scripts`, add (next to `"fetch"`):

`"fetch:funding": "tsx src/cli/fetch-funding.ts",`

- [ ] **Step 3: Integrate into `fetch-data.ts`**

Modify `src/cli/fetch-data.ts`. After the existing `await pipeline.runAllPairs();` and BEFORE the `log.info('Data fetch complete');` line, add:

```ts
// Funding history fetch — same DB connection.
const fundingRepo = new FundingRateRepository(db);
const fundingFetcher = new IntxFundingProvider();
const fundingPipeline = new FundingPipeline({
  repo: fundingRepo,
  fetcher: fundingFetcher,
  historyDays: config.data.fundingHistoryDays,
});
for (const pair of config.data.pairs) {
  try {
    await fundingPipeline.syncPair(pair);
  } catch (err) {
    log.error({ pair, err: err instanceof Error ? err.message : String(err) }, 'Funding sync failed for pair');
  }
}
```

Add the imports at the top of `src/cli/fetch-data.ts`:

```ts
import { FundingRateRepository } from '../data/storage/funding-rate-repo.js';
import { IntxFundingProvider } from '../data/providers/intx-funding.js';
import { FundingPipeline } from '../data/funding-pipeline.js';
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 5: Commit**

```
git add src/cli/fetch-funding.ts src/cli/fetch-data.ts package.json
git commit -m "feat(funding): fetch:funding CLI + integrate into npm run fetch"
```

---

## Task 7: HistoricalFundingHistory (lookahead-safe accessor) (TDD)

**Files:**
- Create: `src/perp/funding-history.ts`
- Test: `src/perp/__tests__/funding-history.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/perp/__tests__/funding-history.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { HistoricalFundingHistory, type FundingPoint } from '../funding-history.js';

const HOUR = 3_600_000;

function series(start: number, n: number, baseRate = 0): FundingPoint[] {
  return Array.from({ length: n }, (_, i) => ({
    timestamp: start + i * HOUR,
    fundingRate: baseRate + i * 1e-6,
  }));
}

describe('HistoricalFundingHistory', () => {
  it('LOOKAHEAD-SAFETY: ratesAsOf never returns a rate with timestamp > asOfMs', () => {
    const pts = series(0, 100);
    const h = new HistoricalFundingHistory(pts);
    const asOf = 50 * HOUR;
    const lookback = 1_000_000 * HOUR;
    const rates = h.ratesAsOfWithTimestamps(asOf, lookback);
    for (const p of rates) expect(p.timestamp).toBeLessThanOrEqual(asOf);
  });

  it('ratesAsOf returns only points within the lookback window', () => {
    const pts = series(0, 100);
    const h = new HistoricalFundingHistory(pts);
    const asOf = 60 * HOUR;
    const rates = h.ratesAsOf(asOf, 10 * HOUR);
    expect(rates.length).toBeGreaterThan(0);
    expect(rates.length).toBeLessThanOrEqual(11);
  });

  it('rateAt returns the most-recent rate at or before asOfMs', () => {
    const pts: FundingPoint[] = [
      { timestamp: 100, fundingRate: 0.1 },
      { timestamp: 200, fundingRate: 0.2 },
      { timestamp: 300, fundingRate: 0.3 },
    ];
    const h = new HistoricalFundingHistory(pts);
    expect(h.rateAt(99)).toBeNull();
    expect(h.rateAt(100)).toBe(0.1);
    expect(h.rateAt(250)).toBe(0.2);
    expect(h.rateAt(1000)).toBe(0.3);
  });

  it('handles an empty series safely', () => {
    const h = new HistoricalFundingHistory([]);
    expect(h.rateAt(123)).toBeNull();
    expect(h.ratesAsOf(123, 1000)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run and watch fail**

Run: `npx vitest run src/perp/__tests__/funding-history.test.ts`
Expected: import fails — RED.

- [ ] **Step 3: Implement the accessor**

Create `src/perp/funding-history.ts`:

```ts
/**
 * Lookahead-safe accessor over a sorted funding-rate series.
 * Used by FundingExtremeContrarianStrategy in backtest (binary-search by
 * the current candle's timestamp — cannot see future rates by construction).
 */
export interface FundingPoint {
  timestamp: number;
  fundingRate: number;
}

export interface FundingHistory {
  ratesAsOf(asOfMs: number, lookbackMs: number): number[];
  rateAt(asOfMs: number): number | null;
  ratesAsOfWithTimestamps(asOfMs: number, lookbackMs: number): FundingPoint[];
}

export class HistoricalFundingHistory implements FundingHistory {
  /** Series MUST be sorted ascending by timestamp. */
  constructor(private readonly series: FundingPoint[]) {}

  ratesAsOf(asOfMs: number, lookbackMs: number): number[] {
    return this.ratesAsOfWithTimestamps(asOfMs, lookbackMs).map((p) => p.fundingRate);
  }

  ratesAsOfWithTimestamps(asOfMs: number, lookbackMs: number): FundingPoint[] {
    if (this.series.length === 0) return [];
    const lower = asOfMs - lookbackMs;
    const upperIdx = this.upperBound(asOfMs);
    const lowerIdx = this.upperBound(lower - 1);
    if (lowerIdx >= upperIdx) return [];
    return this.series.slice(lowerIdx, upperIdx);
  }

  rateAt(asOfMs: number): number | null {
    if (this.series.length === 0) return null;
    const upper = this.upperBound(asOfMs);
    if (upper === 0) return null;
    return this.series[upper - 1].fundingRate;
  }

  /** First index i such that series[i].timestamp > value. */
  private upperBound(value: number): number {
    let lo = 0;
    let hi = this.series.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.series[mid].timestamp <= value) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}
```

- [ ] **Step 4: Run and watch pass**

Run: `npx vitest run src/perp/__tests__/funding-history.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```
git add src/perp/funding-history.ts src/perp/__tests__/funding-history.test.ts
git commit -m "feat(funding): HistoricalFundingHistory accessor (lookahead-safe binary search)"
```

---

## Task 8: Strategy config schema variant

**Files:**
- Modify: `src/strategies/config.ts`

- [ ] **Step 1: Add the Zod variant**

In `src/strategies/config.ts`, locate the array passed to `z.discriminatedUnion('strategy', [...])`. After the last existing perp variant (e.g. `perp-micro-momentum`), add:

```ts
z.object({
  strategy: z.literal('funding-extreme-contrarian'),
  /** Rolling window for the percentile distribution, in ms (default 30d). */
  lookbackMs: z.number().int().positive().default(30 * 24 * 3_600_000),
  /** Top-decile threshold for SHORT entries (default 0.90). */
  upperPct: z.number().min(0.5).max(1).default(0.90),
  /** Bottom-decile threshold for LONG entries (default 0.10). */
  lowerPct: z.number().min(0).max(0.5).default(0.10),
  /** Neutral band for funding-normalized exit. */
  neutralLow: z.number().min(0).max(0.5).default(0.40),
  neutralHigh: z.number().min(0.5).max(1).default(0.60),
  /** Refuse to act until window has at least this many samples (default 200). */
  minWindowSamples: z.number().int().positive().default(200),
}).refine((v) => v.lowerPct < v.upperPct, { message: 'lowerPct must be < upperPct' })
  .refine((v) => v.neutralLow < v.neutralHigh, { message: 'neutralLow must be < neutralHigh' }),
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Commit**

```
git add src/strategies/config.ts
git commit -m "feat(funding): strategy config schema for funding-extreme-contrarian"
```

---

## Task 9: FundingExtremeContrarianStrategy — entry logic (TDD)

**Files:**
- Create: `src/perp/strategies/funding-extreme-contrarian.ts`
- Test: `src/perp/strategies/__tests__/funding-extreme-contrarian.test.ts`

- [ ] **Step 1: Write the failing entry-logic tests**

Create `src/perp/strategies/__tests__/funding-extreme-contrarian.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { FundingExtremeContrarianStrategy } from '../funding-extreme-contrarian.js';
import { HistoricalFundingHistory, type FundingPoint } from '../../funding-history.js';
import type { Candle } from '../../../core/types.js';

const HOUR = 3_600_000;

function candle(ts: number): Candle {
  return {
    pair: 'BTC-USD',
    timeframe: '1h',
    timestamp: ts,
    open: '40000', high: '40010', low: '39990', close: '40000', volume: '1',
  };
}

function seriesWithCurrent(start: number, baseRate: number, currentRate: number): FundingPoint[] {
  const pts: FundingPoint[] = [];
  for (let i = 0; i < 99; i++) pts.push({ timestamp: start + i * HOUR, fundingRate: baseRate });
  pts.push({ timestamp: start + 99 * HOUR, fundingRate: currentRate });
  return pts;
}

function makeStrategy(history: HistoricalFundingHistory) {
  return new FundingExtremeContrarianStrategy({
    fundingHistory: history,
    lookbackMs: 200 * HOUR,
    upperPct: 0.90,
    lowerPct: 0.10,
    neutralLow: 0.40,
    neutralHigh: 0.60,
    minWindowSamples: 50,
  });
}

describe('FundingExtremeContrarianStrategy: entry logic', () => {
  const start = 0;
  const lastTs = start + 99 * HOUR;

  it('emits SHORT when current funding sits in the top decile', () => {
    const history = new HistoricalFundingHistory(seriesWithCurrent(start, 0.00001, 0.001));
    const s = makeStrategy(history);
    const sig = s.evaluate([candle(lastTs)], 'BTC-USD', '1h');
    expect(sig).toHaveLength(1);
    expect(sig[0].direction).toBe('short');
    expect(sig[0].confidence).toBeGreaterThan(0);
    expect(sig[0].confidence).toBeLessThanOrEqual(1);
  });

  it('emits LONG when current funding sits in the bottom decile', () => {
    const history = new HistoricalFundingHistory(seriesWithCurrent(start, 0.00001, -0.001));
    const s = makeStrategy(history);
    const sig = s.evaluate([candle(lastTs)], 'BTC-USD', '1h');
    expect(sig).toHaveLength(1);
    expect(sig[0].direction).toBe('long');
  });

  it('emits nothing when current funding sits in the middle of the distribution', () => {
    const pts: FundingPoint[] = [];
    for (let i = 0; i < 100; i++) pts.push({ timestamp: start + i * HOUR, fundingRate: i * 1e-6 });
    pts[pts.length - 1] = { timestamp: start + 99 * HOUR, fundingRate: 50e-6 };
    const s = makeStrategy(new HistoricalFundingHistory(pts));
    expect(s.evaluate([candle(lastTs)], 'BTC-USD', '1h')).toEqual([]);
  });

  it('confidence scales with extremity (more extreme = higher confidence)', () => {
    const moderate = new HistoricalFundingHistory(seriesWithCurrent(start, 0.0, 0.0001));
    const extreme  = new HistoricalFundingHistory(seriesWithCurrent(start, 0.0, 0.01));
    const sM = makeStrategy(moderate).evaluate([candle(lastTs)], 'BTC-USD', '1h');
    const sE = makeStrategy(extreme).evaluate([candle(lastTs)], 'BTC-USD', '1h');
    if (sM.length && sE.length) {
      expect(sE[0].confidence).toBeGreaterThanOrEqual(sM[0].confidence);
    }
  });
});

describe('FundingExtremeContrarianStrategy: guards', () => {
  it('emits nothing when window has fewer than minWindowSamples', () => {
    const pts: FundingPoint[] = [];
    for (let i = 0; i < 10; i++) pts.push({ timestamp: i * HOUR, fundingRate: 0.001 });
    const s = makeStrategy(new HistoricalFundingHistory(pts));
    expect(s.evaluate([candle(9 * HOUR)], 'BTC-USD', '1h')).toEqual([]);
  });

  it('emits nothing when there is no current funding rate at or before the candle', () => {
    const pts: FundingPoint[] = [];
    for (let i = 0; i < 100; i++) pts.push({ timestamp: 1_000_000 + i * HOUR, fundingRate: 0.001 });
    const s = makeStrategy(new HistoricalFundingHistory(pts));
    expect(s.evaluate([candle(0)], 'BTC-USD', '1h')).toEqual([]);
  });

  it('emits nothing when candles is empty (IStrategy contract)', () => {
    const pts: FundingPoint[] = [];
    for (let i = 0; i < 100; i++) pts.push({ timestamp: i * HOUR, fundingRate: 0.001 });
    const s = makeStrategy(new HistoricalFundingHistory(pts));
    expect(s.evaluate([], 'BTC-USD', '1h')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run and watch fail**

Run: `npx vitest run src/perp/strategies/__tests__/funding-extreme-contrarian.test.ts`
Expected: import fails — RED.

- [ ] **Step 3: Implement the strategy**

Create `src/perp/strategies/funding-extreme-contrarian.ts`:

```ts
/**
 * FundingExtremeContrarianStrategy
 *
 * Fades crowded leverage at funding-rate percentile extremes.
 *
 * Per candle: compute the current funding rate's percentile within a trailing
 * lookbackMs window. If percentile >= upperPct -> SHORT. If <= lowerPct -> LONG.
 * Otherwise no signal.
 *
 * No regime gate: the crowding-reversal thesis applies across regimes and
 * adding one would shrink an already-narrow signal surface.
 */
import type { Candle, TradingPair, Timeframe } from '../../core/types.js';
import type { IndicatorConfig } from '../../indicators/types.js';
import type { IStrategy, Signal } from '../../strategies/types.js';
import type { FundingHistory } from '../funding-history.js';
import { createModuleLogger } from '../../core/logger.js';

const log = createModuleLogger('funding-extreme-contrarian');

export interface FundingExtremeContrarianParams {
  fundingHistory: FundingHistory;
  lookbackMs: number;
  upperPct: number;
  lowerPct: number;
  neutralLow: number;
  neutralHigh: number;
  minWindowSamples: number;
}

export class FundingExtremeContrarianStrategy implements IStrategy {
  readonly name = 'funding-extreme-contrarian';
  readonly minCandles = 1;
  readonly requiredIndicators: IndicatorConfig[] = [];

  constructor(private readonly p: FundingExtremeContrarianParams) {}

  evaluate(
    candles: Candle[],
    pair: TradingPair,
    timeframe: Timeframe,
  ): Signal[] {
    if (candles.length < this.minCandles) return [];
    const last = candles[candles.length - 1];
    const t = last.timestamp;

    const window = this.p.fundingHistory.ratesAsOf(t, this.p.lookbackMs);
    if (window.length < this.p.minWindowSamples) return [];

    const current = this.p.fundingHistory.rateAt(t);
    if (current === null) return [];

    const percentile = computePercentile(current, window);

    if (percentile >= this.p.upperPct) {
      const confidence = clamp01((percentile - this.p.upperPct) / Math.max(1 - this.p.upperPct, 1e-9));
      return [signal('short', pair, timeframe, t, confidence, current, percentile, this.name)];
    }
    if (percentile <= this.p.lowerPct) {
      const confidence = clamp01((this.p.lowerPct - percentile) / Math.max(this.p.lowerPct, 1e-9));
      return [signal('long', pair, timeframe, t, confidence, current, percentile, this.name)];
    }
    return [];
  }
}

function computePercentile(value: number, sample: number[]): number {
  let below = 0;
  let equal = 0;
  for (const x of sample) {
    if (x < value) below++;
    else if (x === value) equal++;
  }
  return (below + 0.5 * equal) / sample.length;
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0.01, x));
}

function signal(
  direction: 'long' | 'short' | 'close',
  pair: TradingPair,
  timeframe: Timeframe,
  timestamp: number,
  confidence: number,
  current: number,
  percentile: number,
  name: string,
): Signal {
  log.debug({ pair, timestamp, current, percentile, direction, confidence }, 'funding-contrarian signal');
  return {
    strategyName: name,
    pair,
    timeframe,
    timestamp,
    direction,
    confidence: Math.round(confidence * 100) / 100,
    reasoning:
      `Funding ${current.toExponential(2)} at percentile ${(percentile * 100).toFixed(1)}% -> ` +
      `${direction.toUpperCase()} (crowd-fade).`,
  };
}
```

- [ ] **Step 4: Run and watch pass**

Run: `npx vitest run src/perp/strategies/__tests__/funding-extreme-contrarian.test.ts`
Expected: all entry-logic + guard tests pass.

- [ ] **Step 5: Commit**

```
git add src/perp/strategies/funding-extreme-contrarian.ts src/perp/strategies/__tests__/funding-extreme-contrarian.test.ts
git commit -m "feat(funding): FundingExtremeContrarianStrategy entry logic + guards"
```

---

## Task 10: Funding-normalized exit signal (TDD)

Adds a strategy-specific exit: emit `close` when the percentile reverts inside `[neutralLow, neutralHigh]`. The engine still owns ATR-stop and time-stop via `ExitLogicManager`.

**Files:**
- Modify: `src/perp/strategies/funding-extreme-contrarian.ts`
- Modify: `src/perp/strategies/__tests__/funding-extreme-contrarian.test.ts`

- [ ] **Step 1: Add the failing exit tests**

Append to `src/perp/strategies/__tests__/funding-extreme-contrarian.test.ts`:

```ts
describe('FundingExtremeContrarianStrategy: funding-normalized exit', () => {
  it('emits a close signal when the open positions percentile is back inside neutral', () => {
    const start = 0;
    const pts: FundingPoint[] = [];
    for (let i = 0; i < 99; i++) pts.push({ timestamp: start + i * HOUR, fundingRate: 0.00001 });
    pts.push({ timestamp: start + 99 * HOUR, fundingRate: 0.00001 });
    const s = makeStrategy(new HistoricalFundingHistory(pts));
    s.notePositionOpen('long');
    const sig = s.evaluate([candle(99 * HOUR)], 'BTC-USD', '1h');
    expect(sig).toHaveLength(1);
    expect(sig[0].direction).toBe('close');
  });

  it('does NOT emit a close while percentile is still extreme', () => {
    const start = 0;
    const pts = seriesWithCurrent(start, 0.0, 0.01);
    const s = makeStrategy(new HistoricalFundingHistory(pts));
    s.notePositionOpen('short');
    const sig = s.evaluate([candle(99 * HOUR)], 'BTC-USD', '1h');
    expect(sig.filter((x) => x.direction === 'close')).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run and watch fail**

Run: `npx vitest run src/perp/strategies/__tests__/funding-extreme-contrarian.test.ts`
Expected: 2 new tests fail.

- [ ] **Step 3: Implement the position-aware exit**

In `src/perp/strategies/funding-extreme-contrarian.ts`, extend the class. After the constructor add:

```ts
private openPosition: 'long' | 'short' | null = null;

/** Caller (engine) notifies the strategy when its signal results in an open position. */
notePositionOpen(direction: 'long' | 'short'): void {
  this.openPosition = direction;
}

/** Caller notifies the strategy when the position is closed. */
notePositionClosed(): void {
  this.openPosition = null;
}
```

In `evaluate`, after computing `percentile` and BEFORE the entry branches, insert:

```ts
// Funding-normalized exit: if a position is open and percentile reverted
// inside the neutral band, signal close (the crowd we faded has dissipated).
if (this.openPosition !== null) {
  if (percentile >= this.p.neutralLow && percentile <= this.p.neutralHigh) {
    return [signal('close', pair, timeframe, t, 0.5, current, percentile, this.name)];
  }
  // Don't double-enter while a position is open.
  return [];
}
```

(The `signal()` helper already accepts `'close'` as a direction.)

- [ ] **Step 4: Run and watch pass**

Run: `npx vitest run src/perp/strategies/__tests__/funding-extreme-contrarian.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```
git add src/perp/strategies/funding-extreme-contrarian.ts src/perp/strategies/__tests__/funding-extreme-contrarian.test.ts
git commit -m "feat(funding): funding-normalized exit when percentile reverts to neutral band"
```

---

## Task 11: Register strategy in perp registry + accept optional FundingHistory

**Files:**
- Modify: `src/perp/strategies/index.ts`

- [ ] **Step 1: Update `createPerpRegistry` signature and registration**

In `src/perp/strategies/index.ts`:

1. Add imports at top:

```ts
import { FundingExtremeContrarianStrategy } from './funding-extreme-contrarian.js';
import type { FundingHistory } from '../funding-history.js';
export { FundingExtremeContrarianStrategy } from './funding-extreme-contrarian.js';
```

2. Change the signature of `createPerpRegistry`:

```ts
export function createPerpRegistry(
  fundingHistory?: FundingHistory,
): StrategyRegistry {
```

3. Inside, after the existing strategy registrations, add:

```ts
if (fundingHistory) {
  registry.register('funding-extreme-contrarian', (c: StrategyConfig) => {
    const cfg = c as Extract<StrategyConfig, { strategy: 'funding-extreme-contrarian' }>;
    return new FundingExtremeContrarianStrategy({
      fundingHistory,
      lookbackMs: cfg.lookbackMs,
      upperPct: cfg.upperPct,
      lowerPct: cfg.lowerPct,
      neutralLow: cfg.neutralLow,
      neutralHigh: cfg.neutralHigh,
      minWindowSamples: cfg.minWindowSamples,
    });
  });
}
```

The conditional registration means callers that don't have funding data (legacy paths) keep working unchanged.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Commit**

```
git add src/perp/strategies/index.ts
git commit -m "feat(funding): register funding-extreme-contrarian when FundingHistory provided"
```

---

## Task 12: Perp-tournament wiring + param grid entry + integration test

**Files:**
- Modify: `src/perp/perp-tournament-runner.ts`
- Test: `src/perp/__tests__/perp-tournament-runner.test.ts` (create or extend)

- [ ] **Step 1: Write the failing integration test**

Open the runner first to confirm the exported function name and option shape. Then create or extend `src/perp/__tests__/perp-tournament-runner.test.ts` with a smoke test asserting the new strategy appears in the leaderboard when funding data is present:

```ts
import { describe, it, expect } from 'vitest';
import { createDatabase, initializeSchema } from '../../data/storage/db.js';
import { CandleRepository } from '../../data/storage/candle-repo.js';
import { FundingRateRepository } from '../../data/storage/funding-rate-repo.js';
import type { Candle } from '../../core/types.js';
import { runPerpTournament } from '../perp-tournament-runner.js'; // adjust to actual export

const HOUR = 3_600_000;

function hourlyCandles(pair: 'BTC-USD', n: number): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const price = (40000 + i).toString();
    out.push({ pair, timeframe: '1h', timestamp: i * HOUR, open: price, high: price, low: price, close: price, volume: '1' });
  }
  return out;
}

describe('perp tournament includes funding-extreme-contrarian when funding data is present', () => {
  it('runs the new strategy through walk-forward (smoke)', async () => {
    const { db, sqlite } = createDatabase(':memory:');
    initializeSchema(sqlite);
    const candleRepo = new CandleRepository(db);
    const fundingRepo = new FundingRateRepository(db);

    candleRepo.insertCandles(hourlyCandles('BTC-USD', 500));
    const fundingRows = [];
    for (let i = 0; i < 480; i++) fundingRows.push({ pair: 'BTC-USD' as const, timestamp: i * HOUR, fundingRate: '0.00001', markPrice: '40000' });
    for (let i = 480; i < 500; i++) fundingRows.push({ pair: 'BTC-USD' as const, timestamp: i * HOUR, fundingRate: '0.005', markPrice: '40000' });
    fundingRepo.insertFundingRates(fundingRows);

    const result = await runPerpTournament({
      pair: 'BTC-USD',
      timeframe: '1h',
      candleRepo,
      fundingRepo,
      days: 20,
    });

    const names = result.leaderboard.map((e: { strategyName: string }) => e.strategyName);
    expect(names).toContain('funding-extreme-contrarian');
  });
});
```

Note: the exact runner entry name (`runPerpTournament`), options shape, and `result.leaderboard` shape MUST match the file's existing export. Open `src/perp/perp-tournament-runner.ts` first and adapt. If the runner currently takes `(opts)` with fields like `dbPath`, either pass an in-memory equivalent or refactor the runner to take repos directly (preferred — mirrors `DataPipeline` injection). Refactor inline as part of this step if needed.

- [ ] **Step 2: Run and watch fail**

Run: `npx vitest run src/perp/__tests__/perp-tournament-runner.test.ts`
Expected: fails — the runner does not yet load funding nor register the new strategy.

- [ ] **Step 3: Modify `perp-tournament-runner.ts`**

Three changes:

1. **Load funding history per pair.** Near the top, after the candle load and before constructing the registry, add:

```ts
import { FundingRateRepository } from '../data/storage/funding-rate-repo.js';
import { HistoricalFundingHistory } from './funding-history.js';
// ...
const fundingRepo = new FundingRateRepository(db);
const fundingPts = fundingRepo
  .getFundingRates(pair, 0, Date.now())
  .map((r) => ({ timestamp: r.timestamp, fundingRate: Number(r.fundingRate) }));
const fundingHistory = fundingPts.length > 0
  ? new HistoricalFundingHistory(fundingPts)
  : undefined;
```

2. **Pass `fundingHistory` to `createPerpRegistry`.** Find the call `const registry = createPerpRegistry();` and change to:

```ts
const registry = createPerpRegistry(fundingHistory);
```

3. **Add a default param-grid entry** in `buildPerpParamGrid()`. After the existing perp-micro-momentum loop, append:

```ts
configs.push({ strategy: 'funding-extreme-contrarian' }); // Zod defaults apply
```

- [ ] **Step 4: Run and watch pass**

Run: `npx vitest run src/perp/__tests__/perp-tournament-runner.test.ts && npx tsc --noEmit`
Expected: integration test passes; typecheck exit 0.

- [ ] **Step 5: Full suite green-check**

Run: `npx vitest run`
Expected: 0 failures. (Existing tests remain unaffected because `createPerpRegistry()` with no argument still works and skips the new strategy.)

- [ ] **Step 6: Commit**

```
git add src/perp/perp-tournament-runner.ts src/perp/__tests__/perp-tournament-runner.test.ts
git commit -m "feat(funding): wire funding-extreme-contrarian into perp tournament"
```

---

## Task 13: End-to-end smoke (manual, post-merge)

Not a code change — a runbook to verify the pipeline works against real data.

- [ ] **Step 1: Fetch live funding history**

Run: `npm run fetch:funding`
Expected: logs show stored counts of ~28,000 per pair, exit 0.

- [ ] **Step 2: Run the perp tournament with funding-aware evaluation**

Run: `npm run tournament:perp -- --pair BTC-USD --days 900`
Expected: leaderboard includes `funding-extreme-contrarian`. Its disposition (qualified / disqualified by min-trades / disqualified by edge floor) is the validation result.

- [ ] **Step 3: Repeat for ETH**

Run: `npm run tournament:perp -- --pair ETH-USD --days 900`

- [ ] **Step 4: Record the verdict in memory**

Update `memory/no-validated-edge-2026-05.md` with the per-pair OOS Sharpe + gate disposition. If the strategy clears the bar on both pairs, it earns "evidence-pending → candidate for deployment registration"; otherwise it's logged as validated-negative and the bot holds cash on it.

---

## Self-Review

**Spec coverage check:**
- Unit 1 (data layer): Tasks 1, 2, 3, 5, 6 ✓
- Unit 2 (FundingHistory accessor): Task 7 ✓
- Unit 3 (strategy): Tasks 8, 9, 10 ✓
- Unit 4 (perp tournament wiring): Tasks 11, 12 ✓
- Config field `fundingHistoryDays`: Task 4 ✓
- Validation plan: inherited from existing infra; Task 13 records the run.
- `LiveFundingHistory` + `createLivePerpRegistry` registration: explicitly out-of-scope per the spec, deferred until validation passes.

**Placeholder scan:** no TBDs, no "implement later", no vague "appropriate error handling". The single soft spot is Task 12 Step 3 ("open the runner first to confirm") — an explicit, justified verification step, not a placeholder, since the exact runner export shape must be inspected before adapting the test.

**Type consistency check:**
- `FundingPoint = { timestamp: number; fundingRate: number }` is used uniformly in the accessor (Task 7) and tests (Tasks 7, 9, 10).
- `FundingRateRow = { pair, timestamp, fundingRate: string, markPrice: string }` is the storage shape (strings for decimal precision); the accessor converts to `number` at the boundary in Task 12 Step 3.
- Strategy param names (`lookbackMs`, `upperPct`, `lowerPct`, `neutralLow`, `neutralHigh`, `minWindowSamples`) are identical across Zod schema (Task 8), implementation (Task 9), tests (Tasks 9, 10), and registry wiring (Task 11).
- `createPerpRegistry(fundingHistory?: FundingHistory)` — same signature in Task 11 and call site in Task 12.

No issues found; plan is ready.
