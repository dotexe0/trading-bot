/**
 * Tests for RegimeStore -- SQLite persistence for regime classification history.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { RegimeStore } from '../regime-store.js';
import { MarketRegime } from '../types.js';

function makeTmpPath(): string {
  return path.join(os.tmpdir(), `regime-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

describe('RegimeStore', () => {
  let store: RegimeStore;
  let dbPath: string;

  beforeEach(() => {
    dbPath = makeTmpPath();
    store = new RegimeStore({ dbPath });
  });

  afterEach(() => {
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  });

  describe('saveBatch + getByRange round-trip', () => {
    it('saves and retrieves records within range', () => {
      const records = [
        { pair: 'BTC-USD', timeframe: '1h', timestamp: 1000, regime: MarketRegime.TRENDING },
        { pair: 'BTC-USD', timeframe: '1h', timestamp: 2000, regime: MarketRegime.RANGING },
        { pair: 'BTC-USD', timeframe: '1h', timestamp: 3000, regime: MarketRegime.VOLATILE },
      ];

      store.saveBatch(records);

      const result = store.getByRange('BTC-USD', '1h', 1000, 3000);
      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({ timestamp: 1000, regime: MarketRegime.TRENDING });
      expect(result[1]).toEqual({ timestamp: 2000, regime: MarketRegime.RANGING });
      expect(result[2]).toEqual({ timestamp: 3000, regime: MarketRegime.VOLATILE });
    });

    it('filters correctly to the requested range', () => {
      const records = [
        { pair: 'BTC-USD', timeframe: '1h', timestamp: 1000, regime: MarketRegime.TRENDING },
        { pair: 'BTC-USD', timeframe: '1h', timestamp: 2000, regime: MarketRegime.RANGING },
        { pair: 'BTC-USD', timeframe: '1h', timestamp: 3000, regime: MarketRegime.VOLATILE },
        { pair: 'BTC-USD', timeframe: '1h', timestamp: 4000, regime: MarketRegime.TRENDING },
      ];

      store.saveBatch(records);

      const result = store.getByRange('BTC-USD', '1h', 2000, 3000);
      expect(result).toHaveLength(2);
      expect(result[0].timestamp).toBe(2000);
      expect(result[1].timestamp).toBe(3000);
    });

    it('returns results in ascending timestamp order', () => {
      const records = [
        { pair: 'BTC-USD', timeframe: '1h', timestamp: 3000, regime: MarketRegime.VOLATILE },
        { pair: 'BTC-USD', timeframe: '1h', timestamp: 1000, regime: MarketRegime.TRENDING },
        { pair: 'BTC-USD', timeframe: '1h', timestamp: 2000, regime: MarketRegime.RANGING },
      ];

      store.saveBatch(records);

      const result = store.getByRange('BTC-USD', '1h', 1000, 3000);
      expect(result[0].timestamp).toBe(1000);
      expect(result[1].timestamp).toBe(2000);
      expect(result[2].timestamp).toBe(3000);
    });

    it('returns empty array when no records in range', () => {
      store.saveBatch([
        { pair: 'BTC-USD', timeframe: '1h', timestamp: 5000, regime: MarketRegime.TRENDING },
      ]);

      const result = store.getByRange('BTC-USD', '1h', 1000, 4000);
      expect(result).toHaveLength(0);
    });

    it('filters by pair and timeframe', () => {
      store.saveBatch([
        { pair: 'BTC-USD', timeframe: '1h', timestamp: 1000, regime: MarketRegime.TRENDING },
        { pair: 'ETH-USD', timeframe: '1h', timestamp: 1000, regime: MarketRegime.RANGING },
        { pair: 'BTC-USD', timeframe: '4h', timestamp: 1000, regime: MarketRegime.VOLATILE },
      ]);

      const result = store.getByRange('BTC-USD', '1h', 1000, 1000);
      expect(result).toHaveLength(1);
      expect(result[0].regime).toBe(MarketRegime.TRENDING);
    });

    it('handles empty batch gracefully', () => {
      expect(() => store.saveBatch([])).not.toThrow();
    });
  });

  describe('getAtTimestamp', () => {
    it('returns regime for exact timestamp', () => {
      store.saveBatch([
        { pair: 'BTC-USD', timeframe: '1h', timestamp: 1000, regime: MarketRegime.TRENDING },
      ]);

      const result = store.getAtTimestamp('BTC-USD', '1h', 1000);
      expect(result).toBe(MarketRegime.TRENDING);
    });

    it('returns null when no record exists for timestamp', () => {
      const result = store.getAtTimestamp('BTC-USD', '1h', 9999);
      expect(result).toBeNull();
    });

    it('returns null when pair does not match', () => {
      store.saveBatch([
        { pair: 'BTC-USD', timeframe: '1h', timestamp: 1000, regime: MarketRegime.TRENDING },
      ]);

      const result = store.getAtTimestamp('ETH-USD', '1h', 1000);
      expect(result).toBeNull();
    });
  });

  describe('upsert behavior (saveBatch twice with same timestamp overwrites)', () => {
    it('overwrites existing record when same (pair, timeframe, timestamp)', () => {
      store.saveBatch([
        { pair: 'BTC-USD', timeframe: '1h', timestamp: 1000, regime: MarketRegime.TRENDING },
      ]);

      // Save again with different regime -- should overwrite
      store.saveBatch([
        { pair: 'BTC-USD', timeframe: '1h', timestamp: 1000, regime: MarketRegime.VOLATILE },
      ]);

      const result = store.getAtTimestamp('BTC-USD', '1h', 1000);
      expect(result).toBe(MarketRegime.VOLATILE);
    });

    it('only one record exists after multiple upserts', () => {
      for (let i = 0; i < 3; i++) {
        store.saveBatch([
          { pair: 'BTC-USD', timeframe: '1h', timestamp: 1000, regime: MarketRegime.RANGING },
        ]);
      }

      const result = store.getByRange('BTC-USD', '1h', 1000, 1000);
      expect(result).toHaveLength(1);
    });
  });
});
