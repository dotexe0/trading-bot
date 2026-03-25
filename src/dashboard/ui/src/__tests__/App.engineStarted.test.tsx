/**
 * Regression test for: engineStarted does not refresh sessions
 *
 * Bug: When paper trading started after the dashboard was already open,
 * the `engineStarted` WS handler only refreshed strategies. The `sessions`
 * React state stayed stale, so `orderFilled` handlers could not find the
 * running session and skipped the trades fetch — trade history never appeared.
 *
 * Fix: `engineStarted` now also fetches /api/sessions, ensuring the new
 * paper session is in React state before any orderFilled event fires.
 */

import React from 'react';
import { render, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock all child components (avoid canvas, prop-shape, and CSS issues) ──────

vi.mock('../components/Header.js', () => ({ Header: () => <div /> }));
vi.mock('../components/PriceChart.js', () => ({
  PriceChart: React.forwardRef((_p: object, _r: React.Ref<unknown>) => <div />),
}));
vi.mock('../components/EquityCurve.js', () => ({
  EquityCurve: React.forwardRef((_p: object, _r: React.Ref<unknown>) => <div />),
}));
vi.mock('../components/BacktestViewer.js', () => ({ BacktestViewer: () => <div /> }));
vi.mock('../components/PositionsTable.js', () => ({ PositionsTable: () => <div /> }));
vi.mock('../components/TradeHistory.js', () => ({ TradeHistory: () => <div /> }));
vi.mock('../components/StrategyControls.js', () => ({ StrategyControls: () => <div /> }));
vi.mock('../components/StrategyConfigEditor.js', () => ({ StrategyConfigEditor: () => <div /> }));
vi.mock('../components/PortfolioHeatMap.js', () => ({ PortfolioHeatMap: () => <div /> }));
vi.mock('../components/RiskPanel.js', () => ({ RiskPanel: () => <div /> }));
vi.mock('../components/PerformancePanel.js', () => ({ PerformancePanel: () => <div /> }));
vi.mock('../components/CircuitBreakerBanner.js', () => ({ CircuitBreakerBanner: () => <div /> }));
vi.mock('../components/PortfolioStats.js', () => ({ PortfolioStats: () => <div /> }));
vi.mock('../components/PerpPositionsPanel.js', () => ({ PerpPositionsPanel: () => <div /> }));
vi.mock('../components/PerpFundingPanel.js', () => ({ PerpFundingPanel: () => <div /> }));
vi.mock('../components/PerpLeverageMeter.js', () => ({ PerpLeverageMeter: () => <div /> }));
vi.mock('../components/FundingHistoryChart.js', () => ({
  FundingHistoryChart: React.forwardRef((_p: object, _r: React.Ref<unknown>) => <div />),
}));
vi.mock('../components/PnlCurveChart.js', () => ({
  PnlCurveChart: React.forwardRef((_p: object, _r: React.Ref<unknown>) => <div />),
}));
vi.mock('../components/LeverageHistoryChart.js', () => ({
  LeverageHistoryChart: React.forwardRef((_p: object, _r: React.Ref<unknown>) => <div />),
}));
vi.mock('../components/FeedHealthPanel.js', () => ({ FeedHealthPanel: () => <div /> }));
vi.mock('../components/SystemHealthPanel.js', () => ({ SystemHealthPanel: () => <div /> }));
vi.mock('../components/LiveReadinessPanel.js', () => ({ LiveReadinessPanel: () => <div /> }));

// ── Mock useWebSocket to control message dispatch ─────────────────────────────

type MessageHandler = (type: string, payload: unknown) => void;
let triggerMessage: MessageHandler = () => {};

vi.mock('../hooks/useWebSocket.js', () => ({
  useWebSocket: (_url: string, onMessage: MessageHandler) => {
    triggerMessage = onMessage;
    return { status: 'connected' as const, send: vi.fn() };
  },
}));

// ── Import App after mocks are registered ─────────────────────────────────────

import App from '../App.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const EMPTY_RISK_STATUS = {
  circuitBreakerTripped: false,
  thresholds: { maxDrawdownPct: 20, maxExposurePct: 80 },
};

function makeFetchMock() {
  return vi.fn((url: string) => {
    const bodies: Record<string, unknown> = {
      '/api/sessions':        [],
      '/api/positions':       [],
      '/api/strategies':      [],
      '/api/risk/events':     [],
      '/api/risk':            EMPTY_RISK_STATUS,
      '/api/perp/positions':  [],
      '/api/gate/status':     { passed: false, failReasons: [], spotTradeCount: 0, perpTradeCount: 0, totalTradeCount: 0, spotNetPnl: '0', perpNetPnl: '0', totalNetPnl: '0', spotWinRate: 0, perpWinRate: 0, config: { minTrades: 10, minNetPnl: 0 }, riskConfig: {}, feeConfig: { spotTakerRate: 0.008 } },
      '/api/candles':         [],
    };
    // Longest-prefix match so /api/risk/events beats /api/risk
    const key = Object.keys(bodies)
      .filter((k) => (url as string).startsWith(k))
      .sort((a, b) => b.length - a.length)[0] ?? '';
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(bodies[key] ?? []),
    });
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('App — orderFilled WebSocket handler', () => {
  let fetchMock: ReturnType<typeof makeFetchMock>;

  beforeEach(() => {
    fetchMock = makeFetchMock();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  /**
   * Regression test for: orderFilled fires before engineStarted sessions fetch resolves.
   *
   * Bug: orderFilled read `sessions` from a stale React closure. If orderFilled
   * arrived before the async engineStarted /api/sessions fetch resolved (common
   * with candle preload), sessions was [] and the active session was not found,
   * so the trade fetch was silently skipped — trade history never appeared.
   *
   * Fix: orderFilled now fetches /api/sessions inline (not from state) so it
   * always has a fresh view of sessions before looking for the active session.
   */
  it('fetches /api/sessions inline when orderFilled is received with stale sessions state', async () => {
    // Build a base mock that handles all standard routes, then override sessions to
    // return a running session so our orderFilled inline fetch can find it.
    const runningSession = {
      id: 'session-42',
      status: 'running',
      mode: 'paper',
      strategyName: 'test',
      pair: 'BTC-USD',
    };
    const overrideFetch = vi.fn((url: string) => {
      const bodies: Record<string, unknown> = {
        '/api/sessions':        [runningSession],
        '/api/positions':       [],
        '/api/strategies':      [],
        '/api/risk/events':     [],
        '/api/risk':            EMPTY_RISK_STATUS,
        '/api/perp/positions':  [],
        '/api/gate/status':     { passed: false, failReasons: [], spotTradeCount: 0, perpTradeCount: 0, totalTradeCount: 0, spotNetPnl: '0', perpNetPnl: '0', totalNetPnl: '0', spotWinRate: 0, perpWinRate: 0, config: { minTrades: 10, minNetPnl: 0 }, riskConfig: {}, feeConfig: { spotTakerRate: 0.008 } },
        '/api/candles':         [],
      };
      // Trades endpoint for any session
      if ((url as string).includes('/trades')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([{ id: 'trade-1' }]) });
      }
      const key = Object.keys(bodies)
        .filter((k) => (url as string).startsWith(k))
        .sort((a, b) => b.length - a.length)[0] ?? '';
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(bodies[key] ?? []),
      });
    });
    vi.stubGlobal('fetch', overrideFetch);

    render(<App />);
    // Drain initial mount fetches
    await act(async () => {});

    const sessionCallsBefore = (overrideFetch.mock.calls as [string][]).filter(
      ([url]) => url === '/api/sessions',
    ).length;

    // Simulate orderFilled arriving (e.g. before React state reflects the running session)
    await act(async () => {
      triggerMessage('orderFilled', { purpose: 'EXIT', pair: 'BTC-USD' });
    });

    const sessionCallsAfter = (overrideFetch.mock.calls as [string][]).filter(
      ([url]) => url === '/api/sessions',
    ).length;

    // Fix: orderFilled must always fetch /api/sessions inline (not from stale state)
    expect(sessionCallsAfter).toBeGreaterThan(sessionCallsBefore);

    // And should subsequently fetch trades for the running session
    const tradeCallsAfter = (overrideFetch.mock.calls as [string][]).filter(
      ([url]) => (url as string).includes('/trades'),
    ).length;
    expect(tradeCallsAfter).toBeGreaterThan(0);
  });
});

describe('App — engineStarted WebSocket handler', () => {
  let fetchMock: ReturnType<typeof makeFetchMock>;

  beforeEach(() => {
    fetchMock = makeFetchMock();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('fetches /api/sessions when engineStarted is received', async () => {
    render(<App />);

    // Drain initial mount fetches
    await act(async () => {});

    const sessionCallsBefore = fetchMock.mock.calls.filter(
      ([url]) => url === '/api/sessions',
    ).length;

    // Simulate engineStarted arriving over WebSocket (e.g. paper trading starts)
    await act(async () => {
      triggerMessage('engineStarted', {});
    });

    const sessionCallsAfter = fetchMock.mock.calls.filter(
      ([url]) => url === '/api/sessions',
    ).length;

    // The fix: sessions must be re-fetched when engineStarted fires so that
    // subsequent orderFilled events can find the active session for trade fetching
    expect(sessionCallsAfter).toBeGreaterThan(sessionCallsBefore);
  });

  it('fetches /api/strategies when engineStarted is received (pre-existing behaviour)', async () => {
    render(<App />);

    await act(async () => {});

    const stratCallsBefore = fetchMock.mock.calls.filter(
      ([url]) => url === '/api/strategies',
    ).length;

    await act(async () => {
      triggerMessage('engineStarted', {});
    });

    const stratCallsAfter = fetchMock.mock.calls.filter(
      ([url]) => url === '/api/strategies',
    ).length;

    expect(stratCallsAfter).toBeGreaterThan(stratCallsBefore);
  });
});
