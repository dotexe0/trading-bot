/**
 * Tests for CorrelationStore -- SQLite persistence for correlation snapshots.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { CorrelationStore } from '../correlation-store.js';

function makeTmpPath(): string {
  return path.join(
    os.tmpdir(),
    `correlation-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

describe('CorrelationStore', () => {
  let store: CorrelationStore;
  let dbPath: string;

  beforeEach(() => {
    dbPath = makeTmpPath();
    store = new CorrelationStore({ dbPath });
  });

  afterEach(() => {
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  });

  describe('save + getByRange round-trip', () => {
    it('saves 3 snapshots and retrieves all via getByRange', () => {
      const T1 = 1000;
      const T2 = 2000;
      const T3 = 3000;

      store.save({ correlation: 0.5, windowSize: 100, timestamp: T1 }, '1h');
      store.save({ correlation: 0.6, windowSize: 100, timestamp: T2 }, '1h');
      store.save({ correlation: 0.7, windowSize: 100, timestamp: T3 }, '1h');

      const results = store.getByRange('1h', T1, T3);
      expect(results).toHaveLength(3);
      expect(results[0].correlation).toBeCloseTo(0.5);
      expect(results[1].correlation).toBeCloseTo(0.6);
      expect(results[2].correlation).toBeCloseTo(0.7);
      expect(results[0].timestamp).toBe(T1);
      expect(results[1].timestamp).toBe(T2);
      expect(results[2].timestamp).toBe(T3);
    });
  });

  describe('INSERT OR REPLACE upsert semantics', () => {
    it('overwrites snapshot when same (timeframe, timestamp) saved again', () => {
      const T = 5000;

      store.save({ correlation: 0.7, windowSize: 100, timestamp: T }, '1h');
      store.save({ correlation: 0.9, windowSize: 100, timestamp: T }, '1h');

      const results = store.getByRange('1h', T, T);
      expect(results).toHaveLength(1);
      expect(results[0].correlation).toBeCloseTo(0.9);
    });
  });

  describe('getByRange time filter', () => {
    it('returns only records within the requested time window', () => {
      const T1 = 1000;
      const T2 = 2000;
      const T3 = 3000;

      store.save({ correlation: 0.3, windowSize: 100, timestamp: T1 }, '1h');
      store.save({ correlation: 0.4, windowSize: 100, timestamp: T2 }, '1h');
      store.save({ correlation: 0.5, windowSize: 100, timestamp: T3 }, '1h');

      const results = store.getByRange('1h', T1, T2);
      expect(results).toHaveLength(2);
      expect(results[0].timestamp).toBe(T1);
      expect(results[1].timestamp).toBe(T2);
    });
  });

  describe('getLatest', () => {
    it('returns the snapshot with the highest timestamp', () => {
      store.save({ correlation: 0.2, windowSize: 100, timestamp: 1000 }, '1h');
      store.save({ correlation: 0.8, windowSize: 100, timestamp: 3000 }, '1h');
      store.save({ correlation: 0.5, windowSize: 100, timestamp: 2000 }, '1h');

      const latest = store.getLatest('1h');
      expect(latest).not.toBeNull();
      expect(latest!.timestamp).toBe(3000);
      expect(latest!.correlation).toBeCloseTo(0.8);
    });

    it('returns null when the table is empty', () => {
      const latest = store.getLatest('1h');
      expect(latest).toBeNull();
    });
  });

  describe('saveBatch', () => {
    it('persists multiple snapshots atomically and verifies count via getByRange', () => {
      const snapshots = [
        { correlation: 0.1, windowSize: 100, timestamp: 1000, timeframe: '1h' },
        { correlation: 0.2, windowSize: 100, timestamp: 2000, timeframe: '1h' },
        { correlation: 0.3, windowSize: 100, timestamp: 3000, timeframe: '1h' },
        { correlation: 0.4, windowSize: 100, timestamp: 4000, timeframe: '1h' },
      ];

      store.saveBatch(snapshots);

      const results = store.getByRange('1h', 1000, 4000);
      expect(results).toHaveLength(4);
      expect(results[0].correlation).toBeCloseTo(0.1);
      expect(results[3].correlation).toBeCloseTo(0.4);
    });

    it('handles empty batch gracefully without throwing', () => {
      expect(() => store.saveBatch([])).not.toThrow();
    });
  });

  describe('timeframe isolation', () => {
    it('getByRange only returns records for the specified timeframe', () => {
      store.save({ correlation: 0.5, windowSize: 100, timestamp: 1000 }, '1h');
      store.save({ correlation: 0.9, windowSize: 50, timestamp: 1000 }, '4h');

      const results1h = store.getByRange('1h', 1000, 1000);
      expect(results1h).toHaveLength(1);
      expect(results1h[0].correlation).toBeCloseTo(0.5);

      const results4h = store.getByRange('4h', 1000, 1000);
      expect(results4h).toHaveLength(1);
      expect(results4h[0].correlation).toBeCloseTo(0.9);
    });

    it('getLatest returns null for empty timeframe even if another timeframe has data', () => {
      store.save({ correlation: 0.5, windowSize: 100, timestamp: 1000 }, '1h');

      const latest4h = store.getLatest('4h');
      expect(latest4h).toBeNull();
    });
  });
});
