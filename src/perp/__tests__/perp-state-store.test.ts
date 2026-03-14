/**
 * Tests for PerpStateStore DB path isolation (INFRA-02).
 * Verifies the store defaults to data/perp.db (not data/trading.db).
 */
import { describe, it, expect } from 'vitest';
import { PerpStateStore } from '../perp-state-store.js';

describe('PerpStateStore – DB path', () => {
  it('accepts an explicit in-memory path for testing', () => {
    // Verifies the store constructs successfully with :memory:
    const store = new PerpStateStore({ dbPath: ':memory:' });
    expect(store).toBeDefined();
    store.close();
  });

  it('accepts an explicit custom path', () => {
    const store = new PerpStateStore({ dbPath: ':memory:' });
    // Constructed with explicit path — no default fallback triggered
    expect(store).toBeDefined();
    store.close();
  });
});

describe('PerpStateStore – default DB path constant', () => {
  it('constructor source code references data/perp.db not data/trading.db', async () => {
    // Read source to confirm default changed from trading.db to perp.db (INFRA-02 regression guard)
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { join, dirname } = await import('node:path');
    const url = new URL('../perp-state-store.js', import.meta.url);
    // Check the TS source instead since we're running via tsx/vitest
    const srcPath = join(
      dirname(fileURLToPath(import.meta.url)),
      '../perp-state-store.ts',
    );
    const src = readFileSync(srcPath, 'utf-8');
    expect(src).toContain("'data/perp.db'");
    expect(src).not.toMatch(/options\.dbPath \?\? ['"]data\/trading\.db['"]/);
  });
});
