/**
 * Tests for PerpTradingEngine — the unified perp engine.
 *
 * Tests cover both paper and live modes via IPerpOrderExecutor injection.
 * IntxClient and PerpStateStore are fully mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PerpTradingEngine } from '../perp-trading-engine.js';
import { PaperPerpOrderExecutor, LivePerpOrderExecutor } from '../order-executor.js';
import { FundingRateTracker } from '../funding-tracker.js';
import { StrategyRegistry } from '../../strategies/registry.js';
import type { IPerpOrderExecutor } from '../order-executor.js';
import type { IntxClient } from '../intx-client.js';
import type { PerpStateStore } from '../perp-state-store.js';
import type { IntxConfig } from '../config.js';
import type { IntxMarkPriceEvent, IntxFundingRateEvent, PerpSession } from '../types.js';
import type { IStrategy } from '../../strategies/types.js';
import type { Candle } from '../../core/types.js';
import type { RegimeLeaderboards, RegimeLeaderboardEntry, LeaderboardEntry } from '../../tournament/types.js';

// ── Mock factories ────────────────────────────────────────────────────

function makeMockIntxClient(): IntxClient & EventEmitter {
  const client = new EventEmitter() as any;
  client.start = vi.fn().mockResolvedValue(undefined);
  client.stop = vi.fn().mockResolvedValue(undefined);
  client.placeOrder = vi.fn().mockResolvedValue({
    orderId: 'ex-1', status: 'FILLED', execQty: '0.1', avgPrice: '50000', fee: '0.5',
  });
  client.fetchFundingRate = vi.fn().mockResolvedValue(0);
  client.getAccountState = vi.fn().mockResolvedValue({ positions: [], balances: {} });
  return client;
}

function makeMockStateStore(): PerpStateStore {
  // Stateful mock: tracks sessions so getOpenSession reflects what createSession
  // put in and what updateSession mutated (needed for phantom-session reconciliation).
  const sessionsById = new Map<string, PerpSession>();
  const store = {
    createSession: vi.fn((session: PerpSession) => {
      sessionsById.set(session.id, { ...session });
    }),
    updateSession: vi.fn((id: string, updates: Partial<PerpSession>) => {
      const existing = sessionsById.get(id);
      if (existing) {
        sessionsById.set(id, { ...existing, ...updates });
      }
    }),
    getSession: vi.fn((id: string) => sessionsById.get(id) ?? null),
    getOpenSession: vi.fn((instrument: string) => {
      for (const s of sessionsById.values()) {
        if (s.instrument === instrument && s.status === 'open') return s;
      }
      return null;
    }),
    getAllOpenSessions: vi.fn(() =>
      Array.from(sessionsById.values()).filter((s) => s.status === 'open'),
    ),
    recordTrade: vi.fn(),
    listClosedTrades: vi.fn().mockReturnValue([]),
    persistOrder: vi.fn(),
    getPendingOrders: vi.fn().mockReturnValue([]),
    getOpenOrdersBySession: vi.fn().mockReturnValue([]),
    close: vi.fn(),
  };
  return store as any;
}

function makeMockConfig(overrides?: Partial<IntxConfig>): IntxConfig {
  return {
    enabled: true,
    perpMode: 'paper',
    apiKey: 'test',
    apiSecret: 'test',
    passphrase: 'test',
    btcProductId: 'BTC-PERP',
    ethProductId: 'ETH-PERP',
    defaultLeverage: 5,
    defaultMaintenanceMarginRate: '0.0333',
    liquidationSafetyThresholdPct: '2.0',
    fundingDrainThresholdPct: 10,
    tpTargetPct: 2.0,
    orderCloseMaxRetries: 3,
    ...overrides,
  } as IntxConfig;
}

function makeCandle(pair: Candle['pair'] = 'BTC-USD', close = '50000'): Candle {
  return {
    pair,
    timeframe: '1h',
    timestamp: Date.now() - 3600_000,
    open: close,
    high: close,
    low: close,
    close,
    volume: '100',
  };
}

// ── Paper mode tests ─────────────────────────────────────────────────

describe('PerpTradingEngine (paper mode)', () => {
  let intxClient: ReturnType<typeof makeMockIntxClient>;
  let stateStore: ReturnType<typeof makeMockStateStore>;
  let config: IntxConfig;
  let engine: PerpTradingEngine;

  beforeEach(() => {
    intxClient = makeMockIntxClient();
    stateStore = makeMockStateStore();
    config = makeMockConfig();
    engine = new PerpTradingEngine({
      mode: 'paper',
      executor: new PaperPerpOrderExecutor(),
      intxClient: intxClient as any,
      stateStore: stateStore as any,
      config,
      tradingPair: 'BTC-USD',
      timeframe: '1h',
    });
  });

  afterEach(() => {
    engine.stop();
  });

  it('starts and stops without error', () => {
    engine.start();
    expect(() => engine.stop()).not.toThrow();
  });

  it('throws if started twice', () => {
    engine.start();
    expect(() => engine.start()).toThrow('already started');
  });

  it('onSignal: open-long → close cycle records trade', async () => {
    let callCount = 0;
    const signalEngine = new PerpTradingEngine({
      mode: 'paper',
      executor: new PaperPerpOrderExecutor(),
      intxClient: intxClient as any,
      stateStore: stateStore as any,
      config,
      tradingPair: 'BTC-USD',
      timeframe: '1h',
      onSignal: () => {
        callCount++;
        if (callCount === 1) return 'open-long';
        return 'close';
      },
    });

    const positionOpened = vi.fn();
    const positionClosed = vi.fn();
    signalEngine.on('positionOpened', positionOpened);
    signalEngine.on('positionClosed', positionClosed);

    signalEngine.start();

    // Fire mark price event
    intxClient.emit('markPrice', {
      instrument: 'BTC-PERP',
      markPrice: '50000',
      indexPrice: '50000',
      timestamp: Date.now(),
      isStale: false,
    } satisfies IntxMarkPriceEvent);

    // Wait for async open
    await vi.waitFor(() => expect(positionOpened).toHaveBeenCalled());

    // Fire second mark price to trigger close
    intxClient.emit('markPrice', {
      instrument: 'BTC-PERP',
      markPrice: '51000',
      indexPrice: '51000',
      timestamp: Date.now(),
      isStale: false,
    } satisfies IntxMarkPriceEvent);

    await vi.waitFor(() => expect(positionClosed).toHaveBeenCalled());
    expect(stateStore.recordTrade).toHaveBeenCalled();

    signalEngine.stop();
  });

  it('stale mark price events are ignored', () => {
    engine.start();
    const positionOpened = vi.fn();
    engine.on('positionOpened', positionOpened);

    intxClient.emit('markPrice', {
      instrument: 'BTC-PERP',
      markPrice: '50000',
      indexPrice: '50000',
      timestamp: Date.now(),
      isStale: true,
    } satisfies IntxMarkPriceEvent);

    expect(positionOpened).not.toHaveBeenCalled();
  });

  it('double-open guard throws', async () => {
    engine.start();
    await engine.openPosition('BTC-PERP', 'long', '0.01', 5, '50000');
    await expect(
      engine.openPosition('BTC-PERP', 'long', '0.01', 5, '50000'),
    ).rejects.toThrow('Position already open');
  });

  it('close without open position throws', async () => {
    engine.start();
    await expect(engine.closePosition('50000')).rejects.toThrow('No open position');
  });

  it('short position has correct PnL sign', async () => {
    engine.start();
    const session = await engine.openPosition('BTC-PERP', 'short', '0.1', 5, '50000');
    const closed = await engine.closePosition('49000', 'manual'); // profitable short

    const tradeCall = (stateStore.recordTrade as any).mock.calls[0][0];
    const pnl = parseFloat(tradeCall.realizedPnl);
    expect(pnl).toBeGreaterThan(0);
  });

  it('paper engine never calls intxClient.placeOrder', async () => {
    engine.start();
    await engine.openPosition('BTC-PERP', 'long', '0.01', 5, '50000');
    await engine.closePosition('51000');
    expect(intxClient.placeOrder).not.toHaveBeenCalled();
  });

  it('emits positionOpened and positionClosed events', async () => {
    engine.start();
    const opened = vi.fn();
    const closed = vi.fn();
    engine.on('positionOpened', opened);
    engine.on('positionClosed', closed);

    await engine.openPosition('BTC-PERP', 'long', '0.01', 5, '50000');
    expect(opened).toHaveBeenCalledTimes(1);

    await engine.closePosition('51000');
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('emits exposureUpdate on open and close', async () => {
    engine.start();
    const exposureUpdates: any[] = [];
    engine.on('exposureUpdate', (update) => exposureUpdates.push(update));

    await engine.openPosition('BTC-PERP', 'long', '0.01', 5, '50000');
    expect(exposureUpdates).toHaveLength(1);
    expect(parseFloat(exposureUpdates[0].totalNotionalUsd)).toBeGreaterThan(0);

    await engine.closePosition('51000');
    expect(exposureUpdates).toHaveLength(2);
    expect(exposureUpdates[1].totalNotionalUsd).toBe('0.00');
  });

  it('risk gate rejection blocks position open', async () => {
    const riskGate = {
      check: vi.fn().mockResolvedValue({ approved: false, rejectReason: 'MAX_LOSS_EXCEEDED', details: {} }),
      recordRealizedLoss: vi.fn(),
    };
    const gatedEngine = new PerpTradingEngine({
      mode: 'paper',
      executor: new PaperPerpOrderExecutor(),
      intxClient: intxClient as any,
      stateStore: stateStore as any,
      config,
      tradingPair: 'BTC-USD',
      timeframe: '1h',
      riskGate: riskGate as any,
    });
    gatedEngine.start();
    await expect(
      gatedEngine.openPosition('BTC-PERP', 'long', '0.01', 5, '50000'),
    ).rejects.toThrow('PerpRiskGate rejected');
    gatedEngine.stop();
  });

  it('records realized loss to risk gate on close', async () => {
    const riskGate = {
      check: vi.fn().mockResolvedValue({ approved: true, details: {} }),
      recordRealizedLoss: vi.fn(),
    };
    const gatedEngine = new PerpTradingEngine({
      mode: 'paper',
      executor: new PaperPerpOrderExecutor(),
      intxClient: intxClient as any,
      stateStore: stateStore as any,
      config,
      tradingPair: 'BTC-USD',
      timeframe: '1h',
      riskGate: riskGate as any,
    });
    gatedEngine.start();
    await gatedEngine.openPosition('BTC-PERP', 'long', '0.01', 5, '50000');
    await gatedEngine.closePosition('49000', 'manual'); // loss
    expect(riskGate.recordRealizedLoss).toHaveBeenCalled();
    gatedEngine.stop();
  });

  it('emergency close fires when liquidation distance drops below threshold', async () => {
    const emergencyFn = vi.fn();
    engine.on('emergencyClose', emergencyFn);
    engine.start();

    await engine.openPosition('BTC-PERP', 'long', '0.01', 5, '50000');

    // Fire mark price very close to liquidation
    intxClient.emit('markPrice', {
      instrument: 'BTC-PERP',
      markPrice: '40100', // very close to liquidation
      indexPrice: '40100',
      timestamp: Date.now(),
      isStale: false,
    } satisfies IntxMarkPriceEvent);

    await vi.waitFor(() => expect(emergencyFn).toHaveBeenCalled());
  });
});

// ── Re-hydration / cross-instrument isolation ─────────────────────────

describe('PerpTradingEngine re-hydration', () => {
  let intxClient: ReturnType<typeof makeMockIntxClient>;
  let stateStore: ReturnType<typeof makeMockStateStore>;
  let config: IntxConfig;

  beforeEach(() => {
    intxClient = makeMockIntxClient();
    stateStore = makeMockStateStore();
    config = makeMockConfig();
  });

  it('BTC engine ignores ETH open sessions on startup', async () => {
    // ETH session in DB — should be ignored by BTC engine
    (stateStore.getAllOpenSessions as any).mockReturnValue([
      {
        id: 'eth-sess',
        instrument: 'ETH-PERP',
        direction: 'long',
        entryPrice: '3000',
        size: '1',
        leverage: 5,
        liquidationPrice: '2400',
        maintenanceMarginRate: '0.0333',
        status: 'open',
        openedAt: Date.now() - 3600_000,
      },
    ]);

    const engine = new PerpTradingEngine({
      mode: 'paper',
      executor: new PaperPerpOrderExecutor(),
      intxClient: intxClient as any,
      stateStore: stateStore as any,
      config,
      tradingPair: 'BTC-USD',
      timeframe: '1h',
    });

    engine.start();
    expect(engine.getCurrentSession()).toBeNull();
    engine.stop();
  });

  it('paper mode: closes BTC session on startup as paper-restart (does not rehydrate)', () => {
    (stateStore.getAllOpenSessions as any).mockReturnValue([
      {
        id: 'btc-sess',
        instrument: 'BTC-PERP',
        direction: 'long',
        entryPrice: '50000',
        size: '0.1',
        leverage: 5,
        liquidationPrice: '40000',
        maintenanceMarginRate: '0.0333',
        status: 'open',
        openedAt: Date.now() - 3600_000,
      },
    ]);

    const engine = new PerpTradingEngine({
      mode: 'paper',
      executor: new PaperPerpOrderExecutor(),
      intxClient: intxClient as any,
      stateStore: stateStore as any,
      config,
      tradingPair: 'BTC-USD',
      timeframe: '1h',
    });

    engine.start();
    expect(engine.getCurrentSession()).toBeNull();
    expect(stateStore.updateSession).toHaveBeenCalledWith('btc-sess', expect.objectContaining({
      status: 'closed',
      closeReason: 'paper-restart',
    }));
    engine.stop();
  });

  it('paper mode: closes all matching open sessions on startup (no orphan preservation)', () => {
    const now = Date.now();
    (stateStore.getAllOpenSessions as any).mockReturnValue([
      {
        id: 'newer',
        instrument: 'BTC-PERP',
        direction: 'long',
        entryPrice: '50000',
        size: '0.1',
        leverage: 5,
        liquidationPrice: '40000',
        maintenanceMarginRate: '0.0333',
        status: 'open',
        openedAt: now - 1000,
      },
      {
        id: 'older',
        instrument: 'BTC-PERP',
        direction: 'long',
        entryPrice: '49000',
        size: '0.1',
        leverage: 5,
        liquidationPrice: '39000',
        maintenanceMarginRate: '0.0333',
        status: 'open',
        openedAt: now - 86400_000,
      },
    ]);

    const engine = new PerpTradingEngine({
      mode: 'paper',
      executor: new PaperPerpOrderExecutor(),
      intxClient: intxClient as any,
      stateStore: stateStore as any,
      config,
      tradingPair: 'BTC-USD',
      timeframe: '1h',
    });

    engine.start();

    // In paper mode: no rehydration, both sessions closed as paper-restart
    expect(engine.getCurrentSession()).toBeNull();
    expect(stateStore.updateSession).toHaveBeenCalledWith('newer', expect.objectContaining({
      status: 'closed',
      closeReason: 'paper-restart',
    }));
    expect(stateStore.updateSession).toHaveBeenCalledWith('older', expect.objectContaining({
      status: 'closed',
      closeReason: 'paper-restart',
    }));

    engine.stop();
  });

  it('live mode: re-hydrates BTC session correctly', () => {
    const liveConfig = makeMockConfig({ perpMode: 'live' });
    (stateStore.getAllOpenSessions as any).mockReturnValue([
      {
        id: 'btc-sess',
        instrument: 'BTC-PERP',
        direction: 'long',
        entryPrice: '50000',
        size: '0.1',
        leverage: 5,
        liquidationPrice: '40000',
        maintenanceMarginRate: '0.0333',
        status: 'open',
        openedAt: Date.now() - 3600_000,
      },
    ]);

    const engine = new PerpTradingEngine({
      mode: 'live',
      executor: new LivePerpOrderExecutor({ intxClient: intxClient as any, stateStore: stateStore as any }),
      intxClient: intxClient as any,
      stateStore: stateStore as any,
      config: liveConfig,
      tradingPair: 'BTC-USD',
      timeframe: '1h',
    });

    engine.start();
    expect(engine.getCurrentSession()).not.toBeNull();
    expect(engine.getCurrentSession()!.instrument).toBe('BTC-PERP');
    engine.stop();
  });

  it('live mode: closes orphaned sessions on startup (keeps newest)', () => {
    const liveConfig = makeMockConfig({ perpMode: 'live' });
    const now = Date.now();
    (stateStore.getAllOpenSessions as any).mockReturnValue([
      {
        id: 'newer',
        instrument: 'BTC-PERP',
        direction: 'long',
        entryPrice: '50000',
        size: '0.1',
        leverage: 5,
        liquidationPrice: '40000',
        maintenanceMarginRate: '0.0333',
        status: 'open',
        openedAt: now - 1000,
      },
      {
        id: 'older',
        instrument: 'BTC-PERP',
        direction: 'long',
        entryPrice: '49000',
        size: '0.1',
        leverage: 5,
        liquidationPrice: '39000',
        maintenanceMarginRate: '0.0333',
        status: 'open',
        openedAt: now - 86400_000,
      },
    ]);

    const engine = new PerpTradingEngine({
      mode: 'live',
      executor: new LivePerpOrderExecutor({ intxClient: intxClient as any, stateStore: stateStore as any }),
      intxClient: intxClient as any,
      stateStore: stateStore as any,
      config: liveConfig,
      tradingPair: 'BTC-USD',
      timeframe: '1h',
    });

    engine.start();

    // Newer session adopted, older closed as orphan
    expect(engine.getCurrentSession()!.id).toBe('newer');
    expect(stateStore.updateSession).toHaveBeenCalledWith('older', expect.objectContaining({
      status: 'closed',
      closeReason: 'engine-restart',
    }));

    engine.stop();
  });
});

// ── Phantom-session reconciliation ───────────────────────────────────

describe('PerpTradingEngine phantom-session reconciliation', () => {
  let intxClient: ReturnType<typeof makeMockIntxClient>;
  let stateStore: ReturnType<typeof makeMockStateStore>;
  let config: IntxConfig;

  beforeEach(() => {
    intxClient = makeMockIntxClient();
    stateStore = makeMockStateStore();
    config = makeMockConfig();
  });

  it('onCandle clears phantom session when DB session no longer open', async () => {
    const strategy: IStrategy = {
      name: 'test',
      minCandles: 1,
      requiredIndicators: [],
      evaluate: vi.fn().mockReturnValue([]),
    };

    const engine = new PerpTradingEngine({
      mode: 'paper',
      executor: new PaperPerpOrderExecutor(),
      intxClient: intxClient as any,
      stateStore: stateStore as any,
      config,
      tradingPair: 'BTC-USD',
      timeframe: '1h',
      initialStrategy: strategy,
    });

    engine.start();
    await engine.openPosition('BTC-PERP', 'long', '0.1', 5, '50000');
    expect(engine.getCurrentSession()).not.toBeNull();

    // Simulate phantom scenario: DB session closed externally (e.g. by a
    // separate rehydrate path marking it stale), but in-memory currentSession
    // still references it. getOpenSession returns null → phantom detected.
    (stateStore.getOpenSession as any).mockReturnValue(null);

    engine.onCandle(makeCandle());

    // Reconciliation should have cleared in-memory state
    expect(engine.getCurrentSession()).toBeNull();

    engine.stop();
  });

  it('onCandle clears phantom session when DB has different open session id', async () => {
    const strategy: IStrategy = {
      name: 'test',
      minCandles: 1,
      requiredIndicators: [],
      evaluate: vi.fn().mockReturnValue([]),
    };

    const engine = new PerpTradingEngine({
      mode: 'paper',
      executor: new PaperPerpOrderExecutor(),
      intxClient: intxClient as any,
      stateStore: stateStore as any,
      config,
      tradingPair: 'BTC-USD',
      timeframe: '1h',
      initialStrategy: strategy,
    });

    engine.start();
    await engine.openPosition('BTC-PERP', 'long', '0.1', 5, '50000');
    const openedId = engine.getCurrentSession()!.id;

    // DB now has a different open session for the same instrument —
    // in-memory reference is stale/phantom.
    (stateStore.getOpenSession as any).mockReturnValue({
      id: `${openedId}-different`,
      instrument: 'BTC-PERP',
      direction: 'long',
      entryPrice: '51000',
      size: '0.1',
      leverage: 5,
      liquidationPrice: '40000',
      maintenanceMarginRate: '0.0333',
      status: 'open',
      openedAt: Date.now(),
    });

    engine.onCandle(makeCandle());

    expect(engine.getCurrentSession()).toBeNull();

    engine.stop();
  });

  it('onCandle keeps session when DB confirms it is still open', async () => {
    const strategy: IStrategy = {
      name: 'test',
      minCandles: 1,
      requiredIndicators: [],
      evaluate: vi.fn().mockReturnValue([]),
    };

    const engine = new PerpTradingEngine({
      mode: 'paper',
      executor: new PaperPerpOrderExecutor(),
      intxClient: intxClient as any,
      stateStore: stateStore as any,
      config,
      tradingPair: 'BTC-USD',
      timeframe: '1h',
      initialStrategy: strategy,
    });

    engine.start();
    const session = await engine.openPosition('BTC-PERP', 'long', '0.1', 5, '50000');
    expect(engine.getCurrentSession()).not.toBeNull();

    // DB confirms same session still open
    (stateStore.getOpenSession as any).mockReturnValue({
      id: session.id,
      instrument: session.instrument,
      direction: session.direction,
      entryPrice: session.entryPrice,
      size: session.size,
      leverage: session.leverage,
      liquidationPrice: session.liquidationPrice,
      maintenanceMarginRate: session.maintenanceMarginRate,
      status: 'open',
      openedAt: session.openedAt,
    });

    engine.onCandle(makeCandle());

    expect(engine.getCurrentSession()).not.toBeNull();
    expect(engine.getCurrentSession()!.id).toBe(session.id);

    engine.stop();
  });
});

// ── Strategy-switch position restoration ─────────────────────────────

describe('PerpTradingEngine strategy-switch position restoration', () => {
  let intxClient: ReturnType<typeof makeMockIntxClient>;
  let stateStore: ReturnType<typeof makeMockStateStore>;
  let config: IntxConfig;

  beforeEach(() => {
    intxClient = makeMockIntxClient();
    stateStore = makeMockStateStore();
    config = makeMockConfig();
  });

  it('restores position state on new strategy when strategy switch fires with open position', async () => {
    const restoreSpy = vi.fn();
    const switchedStrategy = {
      name: 'switched',
      minCandles: 1,
      requiredIndicators: [],
      evaluate: vi.fn().mockReturnValue([]),
      restorePosition: restoreSpy,
    };

    const registry = {
      create: vi.fn().mockReturnValue(switchedStrategy),
    };

    const leaderboards = {
      trending: [{ strategyConfig: { name: 'trending' }, sharpe: 1 }],
      ranging: [],
      volatile: [],
      fallbackEntry: { strategyConfig: { name: 'fallback' }, sharpe: 0 },
    } as any;

    const engine = new PerpTradingEngine({
      mode: 'paper',
      executor: new PaperPerpOrderExecutor(),
      intxClient: intxClient as any,
      stateStore: stateStore as any,
      config,
      tradingPair: 'BTC-USD',
      timeframe: '1h',
      regimeLeaderboards: leaderboards,
      strategyRegistry: registry as any,
    });

    engine.start();

    // Open a short position so currentSession is set
    await engine.openPosition('BTC-PERP', 'short', '0.1', 5, '50000');

    // Simulate a deferred strategy switch firing: set pendingSwitch, then trigger
    // via firePendingSwitchIfIdle(false) which calls executeStrategySwitch →
    // onStrategySwitch callback. The engine's callback must call restorePosition
    // on the new strategy because currentSession is non-null.
    const ctrl = (engine as any).ctrl;
    (ctrl as any).pendingSwitch = { strategyConfig: { name: 'new' }, regime: 'trending' };
    ctrl.firePendingSwitchIfIdle(false);

    expect(restoreSpy).toHaveBeenCalledWith('short', '50000');

    engine.stop();
  });

  it('does not call restorePosition when strategy switch fires with no open position', async () => {
    const restoreSpy = vi.fn();
    const switchedStrategy = {
      name: 'switched',
      minCandles: 1,
      requiredIndicators: [],
      evaluate: vi.fn().mockReturnValue([]),
      restorePosition: restoreSpy,
    };

    const registry = {
      create: vi.fn().mockReturnValue(switchedStrategy),
    };

    const leaderboards = {
      trending: [{ strategyConfig: { name: 'trending' }, sharpe: 1 }],
      ranging: [],
      volatile: [],
      fallbackEntry: { strategyConfig: { name: 'fallback' }, sharpe: 0 },
    } as any;

    const engine = new PerpTradingEngine({
      mode: 'paper',
      executor: new PaperPerpOrderExecutor(),
      intxClient: intxClient as any,
      stateStore: stateStore as any,
      config,
      tradingPair: 'BTC-USD',
      timeframe: '1h',
      regimeLeaderboards: leaderboards,
      strategyRegistry: registry as any,
    });

    engine.start();

    // No position open — strategy switch should not call restorePosition
    const ctrl = (engine as any).ctrl;
    (ctrl as any).pendingSwitch = { strategyConfig: { name: 'new' }, regime: 'trending' };
    ctrl.firePendingSwitchIfIdle(false);

    expect(restoreSpy).not.toHaveBeenCalled();

    engine.stop();
  });
});

// ── Live mode tests ──────────────────────────────────────────────────

describe('PerpTradingEngine (live mode)', () => {
  let intxClient: ReturnType<typeof makeMockIntxClient>;
  let stateStore: ReturnType<typeof makeMockStateStore>;
  let config: IntxConfig;
  let executor: LivePerpOrderExecutor;
  let engine: PerpTradingEngine;

  beforeEach(() => {
    intxClient = makeMockIntxClient();
    stateStore = makeMockStateStore();
    config = makeMockConfig({ perpMode: 'live' });
    executor = new LivePerpOrderExecutor({
      intxClient: intxClient as any,
      stateStore: stateStore as any,
    });
    engine = new PerpTradingEngine({
      mode: 'live',
      executor,
      intxClient: intxClient as any,
      stateStore: stateStore as any,
      config,
      tradingPair: 'BTC-USD',
      timeframe: '1h',
    });
  });

  afterEach(() => {
    engine.stop();
  });

  it('openPosition calls intxClient.placeOrder', async () => {
    engine.start();
    await engine.openPosition('BTC-PERP', 'long', '0.1', 5, '50000');
    expect(intxClient.placeOrder).toHaveBeenCalled();
  });

  it('openPosition uses exchange fill price, not mark price', async () => {
    vi.mocked(intxClient.placeOrder).mockResolvedValue({
      orderId: 'ex-1', status: 'FILLED', execQty: '0.1', avgPrice: '50050', fee: '0.5',
    });

    engine.start();
    const session = await engine.openPosition('BTC-PERP', 'long', '0.1', 5, '50000');
    expect(session.entryPrice).toBe('50050'); // exchange fill price, not requested 50000
  });

  it('closePosition persists order before API call', async () => {
    const callOrder: string[] = [];
    (stateStore.persistOrder as any).mockImplementation(() => callOrder.push('persist'));
    vi.mocked(intxClient.placeOrder).mockImplementation(async () => {
      callOrder.push('placeOrder');
      return { orderId: 'ex-1', status: 'FILLED', execQty: '0.1', avgPrice: '50000', fee: '0.5' };
    });

    engine.start();
    await engine.openPosition('BTC-PERP', 'long', '0.1', 5, '50000');

    callOrder.length = 0; // reset for close
    await engine.closePosition('51000');

    expect(callOrder[0]).toBe('persist');
    expect(callOrder[1]).toBe('placeOrder');
  });

  it('recoverFromRestart restores verified position', async () => {
    (stateStore.getAllOpenSessions as any).mockReturnValue([
      {
        id: 'live-sess',
        instrument: 'BTC-PERP',
        direction: 'long',
        entryPrice: '50000',
        size: '0.1',
        leverage: 5,
        liquidationPrice: '40000',
        maintenanceMarginRate: '0.0333',
        status: 'open',
        openedAt: Date.now() - 3600_000,
      },
    ]);

    vi.mocked(intxClient.getAccountState).mockResolvedValue({
      positions: [
        {
          product_id: 'BTC-PERP',
          side: 'LONG',
          number_of_contracts: '0.1',
          avg_entry_price: '50000',
          current_price: '50500',
        },
      ],
      balances: {},
      summary: {},
    });

    const result = await engine.recoverFromRestart();
    expect(result.restored).toBe(true);
    expect(result.closedExternally).toBe(false);
    expect(engine.getCurrentSession()?.id).toBe('live-sess');
  });

  it('recoverFromRestart marks externally closed position', async () => {
    (stateStore.getAllOpenSessions as any).mockReturnValue([
      {
        id: 'gone-sess',
        instrument: 'BTC-PERP',
        direction: 'long',
        entryPrice: '50000',
        size: '0.1',
        leverage: 5,
        liquidationPrice: '40000',
        maintenanceMarginRate: '0.0333',
        status: 'open',
        openedAt: Date.now() - 3600_000,
      },
    ]);

    vi.mocked(intxClient.getAccountState).mockResolvedValue({
      positions: [], // position gone from exchange
      balances: {},
      summary: {},
    });

    const result = await engine.recoverFromRestart();
    expect(result.restored).toBe(false);
    expect(result.closedExternally).toBe(true);
    expect(stateStore.updateSession).toHaveBeenCalledWith('gone-sess', expect.objectContaining({
      status: 'closed',
      closeReason: 'external_close',
    }));
  });

  it('recoverFromRestart is no-op in paper mode', async () => {
    const paperEngine = new PerpTradingEngine({
      mode: 'paper',
      executor: new PaperPerpOrderExecutor(),
      intxClient: intxClient as any,
      stateStore: stateStore as any,
      config,
      tradingPair: 'BTC-USD',
      timeframe: '1h',
    });

    const result = await paperEngine.recoverFromRestart();
    expect(result.restored).toBe(false);
    expect(intxClient.getAccountState).not.toHaveBeenCalled();
  });

  it('openPosition: emergency-closes orphan exchange position when createSession throws', async () => {
    // Simulate DB failure AFTER successful exchange fill — partial failure
    (stateStore.createSession as any).mockImplementation(() => {
      throw new Error('SQLITE_BUSY: database is locked');
    });

    const orphanEvents: any[] = [];
    engine.on('orphanPosition', (evt) => orphanEvents.push(evt));

    engine.start();

    await expect(
      engine.openPosition('BTC-PERP', 'long', '0.1', 5, '50000'),
    ).rejects.toThrow('SQLITE_BUSY');

    // placeOrder called twice: open, then emergency close
    expect(intxClient.placeOrder).toHaveBeenCalledTimes(2);
    expect(intxClient.placeOrder).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ side: 'BUY' }),
    );
    expect(intxClient.placeOrder).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ side: 'SELL', closeOnly: true }),
    );

    // engine must not believe a position is open
    expect(engine.getCurrentSession()).toBeNull();

    // orphanPosition event emitted for ops visibility
    expect(orphanEvents).toHaveLength(1);
    expect(orphanEvents[0]).toMatchObject({
      instrument: 'BTC-PERP',
      direction: 'long',
      recovered: true,
    });
  });

  it('openPosition: emits orphanPosition with recovered=false when emergency close also fails', async () => {
    (stateStore.createSession as any).mockImplementation(() => {
      throw new Error('SQLITE_BUSY: database is locked');
    });
    // First placeOrder (entry) succeeds, second (emergency close) fails
    vi.mocked(intxClient.placeOrder)
      .mockResolvedValueOnce({
        orderId: 'ex-entry', status: 'FILLED', execQty: '0.1', avgPrice: '50000', fee: '0.5',
      })
      .mockRejectedValueOnce(new Error('Network timeout'));
    // getAccountState (silent-fill check during close) returns empty → no silent fill
    vi.mocked(intxClient.getAccountState).mockResolvedValue({
      positions: [], balances: {}, summary: {},
    });

    const orphanEvents: any[] = [];
    engine.on('orphanPosition', (evt) => orphanEvents.push(evt));

    engine.start();

    await expect(
      engine.openPosition('BTC-PERP', 'long', '0.1', 5, '50000'),
    ).rejects.toThrow();

    expect(orphanEvents).toHaveLength(1);
    expect(orphanEvents[0].recovered).toBe(false);
    expect(engine.getCurrentSession()).toBeNull();
  });

  it('openPosition: paper mode createSession failure does not attempt emergency close', async () => {
    const paperEngine = new PerpTradingEngine({
      mode: 'paper',
      executor: new PaperPerpOrderExecutor(),
      intxClient: intxClient as any,
      stateStore: stateStore as any,
      config: makeMockConfig(), // paper mode
      tradingPair: 'BTC-USD',
      timeframe: '1h',
    });

    (stateStore.createSession as any).mockImplementation(() => {
      throw new Error('SQLITE_BUSY');
    });

    paperEngine.start();

    await expect(
      paperEngine.openPosition('BTC-PERP', 'long', '0.1', 5, '50000'),
    ).rejects.toThrow('SQLITE_BUSY');

    // paper mode never touches the exchange
    expect(intxClient.placeOrder).not.toHaveBeenCalled();
    expect(paperEngine.getCurrentSession()).toBeNull();
    paperEngine.stop();
  });
});

// ── onCandle strategy-driven tests ───────────────────────────────────

describe('PerpTradingEngine onCandle strategy signals', () => {
  let intxClient: ReturnType<typeof makeMockIntxClient>;
  let stateStore: ReturnType<typeof makeMockStateStore>;
  let config: IntxConfig;

  beforeEach(() => {
    intxClient = makeMockIntxClient();
    stateStore = makeMockStateStore();
    config = makeMockConfig();
  });

  it('strategy open-long signal opens position via onCandle', async () => {
    let callCount = 0;
    const strategy: IStrategy = {
      name: 'test-open',
      minCandles: 1,
      requiredIndicators: [],
      evaluate: () => {
        callCount++;
        if (callCount === 1) {
          return [{ direction: 'long' as const, strategyName: 'test', pair: 'BTC-USD' as const, timeframe: '1h' as const, confidence: 1, timestamp: Date.now(), reasoning: 'test' }];
        }
        return [];
      },
    };

    const engine = new PerpTradingEngine({
      mode: 'paper',
      executor: new PaperPerpOrderExecutor(),
      intxClient: intxClient as any,
      stateStore: stateStore as any,
      config,
      tradingPair: 'BTC-USD',
      timeframe: '1h',
      initialStrategy: strategy,
    });

    const opened = vi.fn();
    engine.on('positionOpened', opened);
    engine.start();

    engine.onCandle(makeCandle());

    await vi.waitFor(() => expect(opened).toHaveBeenCalled());

    engine.stop();
  });

  it('strategy close signal closes open position', async () => {
    let callCount = 0;
    const strategy: IStrategy = {
      name: 'test-close',
      minCandles: 1,
      requiredIndicators: [],
      evaluate: () => {
        callCount++;
        if (callCount === 2) {
          return [{ direction: 'close' as const, strategyName: 'test', pair: 'BTC-USD' as const, timeframe: '1h' as const, confidence: 1, timestamp: Date.now(), reasoning: 'test' }];
        }
        return [];
      },
    };

    const engine = new PerpTradingEngine({
      mode: 'paper',
      executor: new PaperPerpOrderExecutor(),
      intxClient: intxClient as any,
      stateStore: stateStore as any,
      config,
      tradingPair: 'BTC-USD',
      timeframe: '1h',
      initialStrategy: strategy,
    });

    engine.start();
    await engine.openPosition('BTC-PERP', 'long', '0.01', 5, '50000');

    const closed = vi.fn();
    engine.on('positionClosed', closed);

    // First candle: no signal (callCount=1 returns empty since we enter with it already incremented)
    engine.onCandle(makeCandle());
    // Second candle: close signal
    engine.onCandle(makeCandle());

    await vi.waitFor(() => expect(closed).toHaveBeenCalled());

    engine.stop();
  });

  it('ignores candles for other pairs', () => {
    const strategy: IStrategy = {
      name: 'test-ignore',
      minCandles: 1,
      requiredIndicators: [],
      evaluate: vi.fn().mockReturnValue([]),
    };

    const engine = new PerpTradingEngine({
      mode: 'paper',
      executor: new PaperPerpOrderExecutor(),
      intxClient: intxClient as any,
      stateStore: stateStore as any,
      config,
      tradingPair: 'BTC-USD',
      timeframe: '1h',
      initialStrategy: strategy,
    });

    engine.start();
    engine.onCandle(makeCandle('ETH-USD'));
    expect(strategy.evaluate).not.toHaveBeenCalled();
    engine.stop();
  });

  it('scales position size by signal confidence', async () => {
    const strategy: IStrategy = {
      name: 'test-conf',
      minCandles: 1,
      requiredIndicators: [],
      evaluate: () => {
        return [{ direction: 'long' as const, strategyName: 'test', pair: 'BTC-USD' as const, timeframe: '1h' as const, confidence: 0.5, timestamp: Date.now(), reasoning: 'test' }];
      },
    };

    const conf = makeMockConfig({ basePositionSize: 0.01, confidenceFloor: 0.3 });
    const engine = new PerpTradingEngine({
      mode: 'paper',
      executor: new PaperPerpOrderExecutor(),
      intxClient: intxClient as any,
      stateStore: stateStore as any,
      config: conf,
      tradingPair: 'BTC-USD',
      timeframe: '1h',
      initialStrategy: strategy,
    });

    const opened = vi.fn();
    engine.on('positionOpened', opened);
    engine.start();
    engine.onCandle(makeCandle());

    await vi.waitFor(() => expect(opened).toHaveBeenCalled());

    // confidence=0.5, floor=0.3 → scale = 0.3 + 0.7*0.5 = 0.65 → size = 0.01*0.65 = 0.0065
    const session = opened.mock.calls[0][0];
    expect(parseFloat(session.size)).toBeCloseTo(0.0065, 4);

    engine.stop();
  });
});

// ── Activity metrics for ActivityMonitor ─────────────────────────────────────

describe('PerpTradingEngine getActivityMetrics', () => {
  let intxClient: ReturnType<typeof makeMockIntxClient>;
  let stateStore: ReturnType<typeof makeMockStateStore>;
  let config: IntxConfig;

  beforeEach(() => {
    intxClient = makeMockIntxClient();
    stateStore = makeMockStateStore();
    config = makeMockConfig();
  });

  it('fresh engine reports null timestamps, 0 candles since signal, no open position', () => {
    const engine = new PerpTradingEngine({
      mode: 'paper',
      executor: new PaperPerpOrderExecutor(),
      intxClient: intxClient as any,
      stateStore: stateStore as any,
      config,
      tradingPair: 'BTC-USD',
      timeframe: '1h',
    });

    const m = engine.getActivityMetrics();
    expect(m.name).toBe('perp-BTC-USD');
    expect(m.lastCandleProcessedAt).toBeNull();
    expect(m.lastSignalEmittedAt).toBeNull();
    expect(m.candlesSinceLastSignal).toBe(0);
    expect(m.hasOpenPosition).toBe(false);
    expect(m.timeframeMs).toBe(3_600_000);
  });

  it('onCandle updates lastCandleProcessedAt and increments candlesSinceLastSignal', () => {
    const strategy: IStrategy = {
      name: 'test-noop',
      minCandles: 1,
      requiredIndicators: [],
      evaluate: () => [],
    };
    const engine = new PerpTradingEngine({
      mode: 'paper',
      executor: new PaperPerpOrderExecutor(),
      intxClient: intxClient as any,
      stateStore: stateStore as any,
      config,
      tradingPair: 'BTC-USD',
      timeframe: '1h',
      initialStrategy: strategy,
    });

    engine.start();
    const beforeTs = Date.now();
    engine.onCandle(makeCandle());
    engine.onCandle(makeCandle());
    engine.onCandle(makeCandle());

    const m = engine.getActivityMetrics();
    expect(m.lastCandleProcessedAt).not.toBeNull();
    expect(m.lastCandleProcessedAt!).toBeGreaterThanOrEqual(beforeTs);
    expect(m.candlesSinceLastSignal).toBe(3);
    engine.stop();
  });

  it('ignored candle (wrong pair) does not update metrics', () => {
    const engine = new PerpTradingEngine({
      mode: 'paper',
      executor: new PaperPerpOrderExecutor(),
      intxClient: intxClient as any,
      stateStore: stateStore as any,
      config,
      tradingPair: 'BTC-USD',
      timeframe: '1h',
    });

    engine.start();
    engine.onCandle(makeCandle('ETH-USD'));

    const m = engine.getActivityMetrics();
    expect(m.lastCandleProcessedAt).toBeNull();
    expect(m.candlesSinceLastSignal).toBe(0);
    engine.stop();
  });

  it('resets candlesSinceLastSignal and sets lastSignalEmittedAt when strategy emits a signal', async () => {
    let calls = 0;
    const strategy: IStrategy = {
      name: 'test-signal',
      minCandles: 1,
      requiredIndicators: [],
      evaluate: () => {
        calls++;
        if (calls === 3) {
          return [{
            direction: 'long' as const,
            strategyName: 'test',
            pair: 'BTC-USD' as const,
            timeframe: '1h' as const,
            confidence: 1,
            timestamp: Date.now(),
            reasoning: 'test',
          }];
        }
        return [];
      },
    };

    const engine = new PerpTradingEngine({
      mode: 'paper',
      executor: new PaperPerpOrderExecutor(),
      intxClient: intxClient as any,
      stateStore: stateStore as any,
      config,
      tradingPair: 'BTC-USD',
      timeframe: '1h',
      initialStrategy: strategy,
    });

    const opened = vi.fn();
    engine.on('positionOpened', opened);
    engine.start();
    engine.onCandle(makeCandle());
    engine.onCandle(makeCandle());
    engine.onCandle(makeCandle());

    await vi.waitFor(() => expect(opened).toHaveBeenCalled());

    const m = engine.getActivityMetrics();
    expect(m.lastSignalEmittedAt).not.toBeNull();
    expect(m.candlesSinceLastSignal).toBe(0);
    engine.stop();
  });

  it('hasOpenPosition reflects currentSession state', async () => {
    const engine = new PerpTradingEngine({
      mode: 'paper',
      executor: new PaperPerpOrderExecutor(),
      intxClient: intxClient as any,
      stateStore: stateStore as any,
      config,
      tradingPair: 'BTC-USD',
      timeframe: '1h',
    });

    engine.start();
    expect(engine.getActivityMetrics().hasOpenPosition).toBe(false);

    await engine.openPosition('BTC-PERP', 'long', '0.01', 5, '50000');
    expect(engine.getActivityMetrics().hasOpenPosition).toBe(true);

    await engine.closePosition('50000', 'test');
    expect(engine.getActivityMetrics().hasOpenPosition).toBe(false);
    engine.stop();
  });

  it('ETH engine reports name perp-ETH-USD', () => {
    const engine = new PerpTradingEngine({
      mode: 'paper',
      executor: new PaperPerpOrderExecutor(),
      intxClient: intxClient as any,
      stateStore: stateStore as any,
      config,
      tradingPair: 'ETH-USD',
      timeframe: '1h',
    });

    expect(engine.getActivityMetrics().name).toBe('perp-ETH-USD');
  });
});
