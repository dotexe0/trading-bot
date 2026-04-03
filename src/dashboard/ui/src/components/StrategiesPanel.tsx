/**
 * StrategiesPanel — Combined tournament leaderboard + live performance metrics + stop control.
 *
 * Top half: Tournament leaderboard table (or placeholder rows when no tournament data).
 *   - ACTIVE strategy row shows a stop toggle with inline confirmation.
 *   - DISQUALIFIED rows are dimmed and show a tooltip with the reason.
 *
 * Bottom half: Live performance metrics identical to PerformancePanel.
 *   - Metrics grid: win rate, avg win%, avg loss%, win/loss ratio, trade count, avg slippage bps.
 *   - Per-strategy breakdown table: strategy name, trades, win%, gross avg, fees avg, net avg, fee drag %.
 */

import React, { useState, useMemo } from 'react';
import type { StrategyInfo, TradeData, TournamentLeaderboard } from '../types.js';

interface StrategiesPanelProps {
  strategies: StrategyInfo[];
  trades: TradeData[];
  tournament: TournamentLeaderboard | null;
  availableStrategies: string[];
  onStop: (name: string) => Promise<void>;
}

interface StopRowState {
  pending: boolean;
  confirmingStop: boolean;
}

export function StrategiesPanel({
  strategies,
  trades,
  tournament,
  availableStrategies,
  onStop,
}: StrategiesPanelProps): React.ReactElement {
  const [stopStates, setStopStates] = useState<Record<string, StopRowState>>({});

  function getStopState(name: string): StopRowState {
    return stopStates[name] ?? { pending: false, confirmingStop: false };
  }

  function setStopState(name: string, patch: Partial<StopRowState>) {
    setStopStates((prev) => ({
      ...prev,
      [name]: { ...getStopState(name), ...patch },
    }));
  }

  function handleToggleStop(name: string) {
    const state = getStopState(name);
    if (state.pending) return;
    setStopState(name, { confirmingStop: true });
  }

  async function handleConfirmStop(name: string) {
    setStopState(name, { pending: true, confirmingStop: false });
    try {
      await onStop(name);
    } finally {
      setStopState(name, { pending: false, confirmingStop: false });
    }
  }

  function handleCancelStop(name: string) {
    setStopState(name, { confirmingStop: false });
  }

  // ── Running strategy names set for O(1) lookup ──────────────────────
  // Engine keys from /api/strategies are "strategyName:PAIR" (e.g. "sma-crossover:BTC-USD").
  // Strip the pair suffix so they match the tournament leaderboard's bare strategy names.
  const runningNames = useMemo(
    () =>
      new Set(
        strategies
          .filter((s) => s.status === 'running')
          .map((s) => s.name.split(':')[0]),
      ),
    [strategies],
  );

  // ── Build leaderboard rows ──────────────────────────────────────────
  // When tournament data is present use it; otherwise show placeholder rows
  // for each name in availableStrategies.
  const leaderboardRows = useMemo(() => {
    if (tournament) {
      return tournament.leaderboard;
    }
    return availableStrategies.map((name, idx) => ({
      rank: idx + 1,
      strategyName: name,
      isSharpe: NaN,
      oosSharpe: NaN,
      robustnessRatio: NaN,
      oosTradeCount: NaN,
      oosWinRate: NaN,
      disqualified: false,
      disqualifyReason: null,
      active: runningNames.has(name),
    }));
  }, [tournament, availableStrategies, runningNames]);

  // ── Performance metrics (mirrors PerformancePanel exactly) ─────────
  const metrics = useMemo(() => {
    const completed = trades.filter((t) => t.pnl !== undefined && t.pnl !== null);
    if (completed.length === 0) return null;

    const tradeCount = completed.length;
    const wins = completed.filter((t) => parseFloat(t.pnl!) > 0);
    const losses = completed.filter((t) => parseFloat(t.pnl!) < 0);

    const winRate = wins.length / tradeCount;

    // pnlPct is already a percentage string (e.g. "5.0" = 5%) — no * 100
    const avgWinPct =
      wins.length > 0
        ? wins.reduce((sum, t) => sum + parseFloat(t.pnlPct!), 0) / wins.length
        : 0;

    const avgLossPct =
      losses.length > 0
        ? losses.reduce((sum, t) => sum + parseFloat(t.pnlPct!), 0) / losses.length
        : 0;

    const winLossRatio =
      Math.abs(avgLossPct) > 0
        ? Math.abs(avgWinPct) / Math.abs(avgLossPct)
        : avgWinPct > 0
        ? 999
        : 0;

    const withSlippage = completed.filter(
      (t) => t.entrySlippageBps !== undefined || t.exitSlippageBps !== undefined,
    );
    const avgSlippageBps =
      withSlippage.length > 0
        ? withSlippage.reduce((sum, t) => {
            return sum + parseFloat(t.entrySlippageBps ?? '0') + parseFloat(t.exitSlippageBps ?? '0');
          }, 0) / withSlippage.length
        : null;

    return { tradeCount, winRate, avgWinPct, avgLossPct, winLossRatio, avgSlippageBps };
  }, [trades]);

  const strategyStats = useMemo(() => {
    const completed = trades.filter(
      (t) => t.pnl !== undefined && t.pnl !== null && t.strategyName,
    );
    if (completed.length === 0) return [];

    const groups = new Map<string, typeof completed>();
    for (const t of completed) {
      const name = t.strategyName!;
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name)!.push(t);
    }

    return Array.from(groups.entries()).map(([name, groupTrades]) => {
      const count = groupTrades.length;
      const wins = groupTrades.filter((t) => parseFloat(t.pnl!) > 0);
      const winRate = wins.length / count;

      // Gross P&L = pnl (net) + total fees
      const avgGrossPnl =
        groupTrades.reduce((sum, t) => {
          const fees = parseFloat(t.entryFee) + parseFloat(t.exitFee ?? '0');
          const net = parseFloat(t.pnl!);
          return sum + (net + fees);
        }, 0) / count;

      const avgFees =
        groupTrades.reduce((sum, t) => {
          return sum + parseFloat(t.entryFee) + parseFloat(t.exitFee ?? '0');
        }, 0) / count;

      const avgNetPnl =
        groupTrades.reduce((sum, t) => sum + parseFloat(t.pnl!), 0) / count;

      // Fee-drag ratio: avgFees / |avgGrossPnl| — cap at 9999% to avoid Infinity
      const feeDragRatio =
        Math.abs(avgGrossPnl) > 0
          ? Math.min((avgFees / Math.abs(avgGrossPnl)) * 100, 9999)
          : 0;

      return { name, count, winRate, avgGrossPnl, avgFees, avgNetPnl, feeDragRatio };
    });
  }, [trades]);

  // ── Helpers ─────────────────────────────────────────────────────────
  function fmt(n: number, decimals: number): string {
    return isNaN(n) ? '—' : n.toFixed(decimals);
  }

  return (
    <div className="panel">
      <div className="panel-title">Strategies</div>

      {/* ── Tournament Leaderboard ─────────────────────────────────── */}
      {tournament && (
        <div style={{ fontSize: '11px', color: '#64748b', marginBottom: '6px' }}>
          Last run: {new Date(tournament.runAt).toLocaleString()} &nbsp;·&nbsp;{' '}
          {tournament.strategiesEvaluated} evaluated
        </div>
      )}

      <div style={{ overflowX: 'auto', marginBottom: '16px' }}>
        <table style={{ width: '100%', fontSize: '12px', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ color: '#94a3b8', textAlign: 'right' }}>
              <th style={{ textAlign: 'left', paddingBottom: '4px', paddingRight: '8px' }}>#</th>
              <th style={{ textAlign: 'left', paddingBottom: '4px', paddingRight: '8px' }}>
                Strategy
              </th>
              <th style={{ paddingBottom: '4px', paddingRight: '8px' }}>IS Sharpe</th>
              <th style={{ paddingBottom: '4px', paddingRight: '8px' }}>OOS Sharpe</th>
              <th style={{ paddingBottom: '4px', paddingRight: '8px' }}>Robustness</th>
              <th style={{ paddingBottom: '4px', paddingRight: '8px' }}>OOS Trades</th>
              <th style={{ paddingBottom: '4px', paddingRight: '8px' }}>Win%</th>
              <th style={{ textAlign: 'left', paddingBottom: '4px' }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {leaderboardRows.map((entry) => {
              const isActive = runningNames.has(entry.strategyName);
              const stopState = getStopState(entry.strategyName);

              return (
                <tr
                  key={entry.strategyName}
                  style={{
                    textAlign: 'right',
                    borderTop: '1px solid #1e293b',
                    opacity: entry.disqualified ? 0.45 : 1,
                  }}
                >
                  <td style={{ textAlign: 'left', paddingRight: '8px', color: '#64748b' }}>
                    {entry.rank}
                  </td>
                  <td
                    style={{
                      textAlign: 'left',
                      paddingRight: '8px',
                      color: '#cbd5e1',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {entry.strategyName}
                  </td>
                  <td style={{ paddingRight: '8px' }}>{fmt(entry.isSharpe, 2)}</td>
                  <td style={{ paddingRight: '8px' }}>{fmt(entry.oosSharpe, 2)}</td>
                  <td style={{ paddingRight: '8px' }}>{fmt(entry.robustnessRatio, 2)}</td>
                  <td style={{ paddingRight: '8px' }}>
                    {isNaN(entry.oosTradeCount) ? '—' : entry.oosTradeCount}
                  </td>
                  <td style={{ paddingRight: '8px' }}>
                    {isNaN(entry.oosWinRate) ? '—' : `${(entry.oosWinRate * 100).toFixed(1)}%`}
                  </td>
                  <td style={{ textAlign: 'left' }}>
                    {isActive ? (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                        <span className="status-badge status-running">ACTIVE</span>
                        {/* Stop toggle */}
                        <button
                          className={`toggle-switch toggle-on${stopState.pending ? ' toggle-pending' : ''}`}
                          onClick={() => handleToggleStop(entry.strategyName)}
                          disabled={stopState.pending || stopState.confirmingStop}
                          aria-label={`Stop ${entry.strategyName}`}
                          title={`Stop ${entry.strategyName}`}
                        >
                          <span className="toggle-thumb" />
                        </button>
                        {stopState.confirmingStop && (
                          <span className="inline-confirm">
                            <span className="inline-confirm-text">
                              Stop {entry.strategyName}?
                            </span>
                            <button
                              className="btn-secondary btn-sm"
                              onClick={() => handleCancelStop(entry.strategyName)}
                            >
                              Cancel
                            </button>
                            <button
                              className="btn-danger btn-sm"
                              onClick={() => handleConfirmStop(entry.strategyName)}
                            >
                              Stop
                            </button>
                          </span>
                        )}
                      </span>
                    ) : entry.disqualified ? (
                      <span
                        className="status-badge"
                        style={{ background: '#334155', color: '#94a3b8' }}
                        title={entry.disqualifyReason ?? undefined}
                      >
                        DISQUALIFIED
                      </span>
                    ) : (
                      <span className="status-badge status-stopped">STOPPED</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* ── Live Performance (mirrors PerformancePanel) ────────────── */}
      <div className="panel-title" style={{ marginTop: '4px' }}>Live Performance</div>

      {!metrics ? (
        <div className="empty-state">No completed trades</div>
      ) : (
        <>
          <div className="performance-grid">
            <div className="perf-stat">
              <div className="perf-stat-value">{(metrics.winRate * 100).toFixed(1)}%</div>
              <div className="perf-stat-label">Win Rate</div>
            </div>
            <div className="perf-stat">
              <div
                className="perf-stat-value"
                style={{ color: metrics.avgWinPct >= 0 ? '#22c55e' : '#ef4444' }}
              >
                {metrics.avgWinPct >= 0 ? '+' : ''}
                {metrics.avgWinPct.toFixed(2)}%
              </div>
              <div className="perf-stat-label">Avg Win</div>
            </div>
            <div className="perf-stat">
              <div className="perf-stat-value" style={{ color: '#ef4444' }}>
                {metrics.avgLossPct.toFixed(2)}%
              </div>
              <div className="perf-stat-label">Avg Loss</div>
            </div>
            <div className="perf-stat">
              <div className="perf-stat-value">{metrics.winLossRatio.toFixed(2)}</div>
              <div className="perf-stat-label">Win/Loss</div>
            </div>
            <div className="perf-stat">
              <div className="perf-stat-value">{metrics.tradeCount}</div>
              <div className="perf-stat-label">Trades</div>
            </div>
            {metrics.avgSlippageBps !== null && (
              <div className="perf-stat">
                <div
                  className="perf-stat-value"
                  style={{ color: metrics.avgSlippageBps > 0 ? '#ef4444' : '#22c55e' }}
                >
                  {metrics.avgSlippageBps > 0 ? '+' : ''}
                  {metrics.avgSlippageBps.toFixed(1)} bps
                </div>
                <div className="perf-stat-label">Avg Slippage</div>
              </div>
            )}
          </div>

          {strategyStats.length > 0 && (
            <>
              <div className="panel-title" style={{ marginTop: '12px' }}>
                Strategy Performance
              </div>
              <table
                style={{ width: '100%', fontSize: '12px', borderCollapse: 'collapse' }}
              >
                <thead>
                  <tr style={{ color: '#94a3b8', textAlign: 'right' }}>
                    <th style={{ textAlign: 'left', paddingBottom: '4px' }}>Strategy</th>
                    <th>Trades</th>
                    <th>Win%</th>
                    <th>Gross</th>
                    <th>Fees</th>
                    <th>Net</th>
                    <th>FeeDrag</th>
                  </tr>
                </thead>
                <tbody>
                  {strategyStats.map((s) => (
                    <tr
                      key={s.name}
                      style={{ textAlign: 'right', borderTop: '1px solid #1e293b' }}
                    >
                      <td
                        style={{
                          textAlign: 'left',
                          paddingRight: '8px',
                          color: '#cbd5e1',
                        }}
                      >
                        {s.name}
                      </td>
                      <td>{s.count}</td>
                      <td>{(s.winRate * 100).toFixed(1)}%</td>
                      <td
                        style={{ color: s.avgGrossPnl >= 0 ? '#22c55e' : '#ef4444' }}
                      >
                        {s.avgGrossPnl >= 0 ? '+' : ''}
                        {s.avgGrossPnl.toFixed(4)}
                      </td>
                      <td style={{ color: '#f59e0b' }}>{s.avgFees.toFixed(4)}</td>
                      <td
                        style={{ color: s.avgNetPnl >= 0 ? '#22c55e' : '#ef4444' }}
                      >
                        {s.avgNetPnl >= 0 ? '+' : ''}
                        {s.avgNetPnl.toFixed(4)}
                      </td>
                      <td
                        style={{
                          color: s.feeDragRatio > 50 ? '#ef4444' : '#94a3b8',
                        }}
                      >
                        {s.feeDragRatio.toFixed(1)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}
    </div>
  );
}
