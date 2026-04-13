/**
 * Tests for CrossAssetSignalBus — cross-asset signal confirmation.
 */

import { describe, it, expect } from 'vitest';
import { CrossAssetSignalBus } from '../cross-asset-signal-bus.js';

describe('CrossAssetSignalBus', () => {
  const NOW = 1700000000000;

  it('returns +0.15 when both assets signal the same direction (long+long)', () => {
    const bus = new CrossAssetSignalBus();
    bus.publish('ETH-USD', 'long', 0.8, NOW);
    const adj = bus.getConfirmation('BTC-USD', 'long', NOW);
    expect(adj).toBe(0.15);
  });

  it('returns +0.15 when both assets signal short+short', () => {
    const bus = new CrossAssetSignalBus();
    bus.publish('BTC-USD', 'short', 0.7, NOW);
    const adj = bus.getConfirmation('ETH-USD', 'short', NOW);
    expect(adj).toBe(0.15);
  });

  it('returns -0.10 when assets signal opposing directions (long vs short)', () => {
    const bus = new CrossAssetSignalBus();
    bus.publish('ETH-USD', 'short', 0.6, NOW);
    const adj = bus.getConfirmation('BTC-USD', 'long', NOW);
    expect(adj).toBe(-0.10);
  });

  it('returns 0 when other asset signal is stale', () => {
    const bus = new CrossAssetSignalBus({ stalenessMs: 3_600_000 });
    bus.publish('ETH-USD', 'long', 0.8, NOW - 3_600_001); // 1ms past staleness
    const adj = bus.getConfirmation('BTC-USD', 'long', NOW);
    expect(adj).toBe(0);
  });

  it('returns 0 when other asset has no signal', () => {
    const bus = new CrossAssetSignalBus();
    const adj = bus.getConfirmation('BTC-USD', 'long', NOW);
    expect(adj).toBe(0);
  });

  it('returns 0 when thisDirection is close', () => {
    const bus = new CrossAssetSignalBus();
    bus.publish('ETH-USD', 'long', 0.8, NOW);
    const adj = bus.getConfirmation('BTC-USD', 'close', NOW);
    expect(adj).toBe(0);
  });

  it('returns 0 when other asset direction is close (no penalty)', () => {
    const bus = new CrossAssetSignalBus();
    bus.publish('ETH-USD', 'close', 0.8, NOW);
    const adj = bus.getConfirmation('BTC-USD', 'long', NOW);
    expect(adj).toBe(0);
  });

  it('uses custom boost and penalty values', () => {
    const bus = new CrossAssetSignalBus({
      sameDirectionBoost: 0.20,
      opposingDirectionPenalty: 0.05,
    });
    bus.publish('ETH-USD', 'long', 0.8, NOW);
    expect(bus.getConfirmation('BTC-USD', 'long', NOW)).toBe(0.20);

    bus.publish('ETH-USD', 'short', 0.8, NOW);
    expect(bus.getConfirmation('BTC-USD', 'long', NOW)).toBe(-0.05);
  });

  it('overwrites previous signal for the same pair', () => {
    const bus = new CrossAssetSignalBus();
    bus.publish('ETH-USD', 'long', 0.8, NOW);
    bus.publish('ETH-USD', 'short', 0.6, NOW + 1000);
    const adj = bus.getConfirmation('BTC-USD', 'long', NOW + 1000);
    expect(adj).toBe(-0.10); // opposing
  });
});
