import React, { useMemo } from 'react';
import type { TradeData } from '../types.js';

interface PerformancePanelProps {
  trades: TradeData[];
}

/**
 * PerformancePanel -- Real-time performance metrics computed client-side.
 *
 * Metrics are derived from the existing `trades` state in App.tsx via useMemo.
 * No new WebSocket events, no new REST endpoints, no duplicate data pipeline.
 *
 * pnlPct is already a percentage string (e.g. "5.0" = 5%) -- verified from
 * TradeHistory.tsx which appends "%" directly without multiplying by 100.
 * winRate is a 0-1 ratio and DOES need * 100 for display.
 */
export function PerformancePanel({ trades }: PerformancePanelProps): React.ReactElement {
  const metrics = useMemo(() => {
    // Filter to completed trades only (those with pnl defined)
    const completed = trades.filter(t => t.pnl !== undefined && t.pnl !== null);
    if (completed.length === 0) return null;

    const tradeCount = completed.length;
    const wins = completed.filter(t => parseFloat(t.pnl!) > 0);
    const losses = completed.filter(t => parseFloat(t.pnl!) < 0);

    const winRate = wins.length / tradeCount;

    // Avg win (by pnlPct) -- pnlPct is already a percentage string, no * 100
    const avgWinPct = wins.length > 0
      ? wins.reduce((sum, t) => sum + parseFloat(t.pnlPct!), 0) / wins.length
      : 0;

    // Avg loss (by pnlPct) -- pnlPct is already a percentage string, no * 100
    const avgLossPct = losses.length > 0
      ? losses.reduce((sum, t) => sum + parseFloat(t.pnlPct!), 0) / losses.length
      : 0;

    // Win/loss ratio: |avgWin| / |avgLoss|
    const winLossRatio = Math.abs(avgLossPct) > 0
      ? Math.abs(avgWinPct) / Math.abs(avgLossPct)
      : (avgWinPct > 0 ? 999 : 0);

    // Avg round-trip slippage (only for trades with slippage data)
    const withSlippage = completed.filter(
      t => t.entrySlippageBps !== undefined || t.exitSlippageBps !== undefined,
    );
    const avgSlippageBps = withSlippage.length > 0
      ? withSlippage.reduce((sum, t) => {
          return sum + parseFloat(t.entrySlippageBps ?? '0') + parseFloat(t.exitSlippageBps ?? '0');
        }, 0) / withSlippage.length
      : null;

    return { tradeCount, winRate, avgWinPct, avgLossPct, winLossRatio, avgSlippageBps };
  }, [trades]);

  const strategyStats = useMemo(() => {
    const completed = trades.filter(t => t.pnl !== undefined && t.pnl !== null && t.strategyName);
    if (completed.length === 0) return [];

    // Group by strategyName
    const groups = new Map<string, typeof completed>();
    for (const t of completed) {
      const name = t.strategyName!;
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name)!.push(t);
    }

    return Array.from(groups.entries()).map(([name, groupTrades]) => {
      const count = groupTrades.length;
      const wins = groupTrades.filter(t => parseFloat(t.pnl!) > 0);
      const winRate = wins.length / count;

      // Gross P&L = pnl (net) + total fees
      const avgGrossPnl = groupTrades.reduce((sum, t) => {
        const fees = parseFloat(t.entryFee) + parseFloat(t.exitFee ?? '0');
        const net = parseFloat(t.pnl!);
        return sum + (net + fees);
      }, 0) / count;

      const avgFees = groupTrades.reduce((sum, t) => {
        return sum + parseFloat(t.entryFee) + parseFloat(t.exitFee ?? '0');
      }, 0) / count;

      const avgNetPnl = groupTrades.reduce((sum, t) => sum + parseFloat(t.pnl!), 0) / count;

      // Fee-drag ratio: avgFees / |avgGrossPnl| -- how much of gross is eaten by fees
      // Cap at 9999% to avoid Infinity display when grossPnl is 0
      const feeDragRatio = Math.abs(avgGrossPnl) > 0
        ? Math.min(avgFees / Math.abs(avgGrossPnl) * 100, 9999)
        : 0;

      return { name, count, winRate, avgGrossPnl, avgFees, avgNetPnl, feeDragRatio };
    });
  }, [trades]);

  if (!metrics) {
    return (
      <div className="panel">
        <div className="panel-title">Performance</div>
        <div className="empty-state">No completed trades</div>
      </div>
    );
  }

  return (
    <div className="panel">
      <div className="panel-title">Performance</div>
      <div className="performance-grid">
        <div className="perf-stat">
          <div className="perf-stat-value">{(metrics.winRate * 100).toFixed(1)}%</div>
          <div className="perf-stat-label">Win Rate</div>
        </div>
        <div className="perf-stat">
          <div className="perf-stat-value" style={{ color: metrics.avgWinPct >= 0 ? '#22c55e' : '#ef4444' }}>
            {metrics.avgWinPct >= 0 ? '+' : ''}{metrics.avgWinPct.toFixed(2)}%
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
            <div className="perf-stat-value" style={{ color: metrics.avgSlippageBps > 0 ? '#ef4444' : '#22c55e' }}>
              {metrics.avgSlippageBps > 0 ? '+' : ''}{metrics.avgSlippageBps.toFixed(1)} bps
            </div>
            <div className="perf-stat-label">Avg Slippage</div>
          </div>
        )}
      </div>
      {strategyStats.length > 0 && (
        <>
          <div className="panel-title" style={{ marginTop: '12px' }}>Strategy Performance</div>
          <table style={{ width: '100%', fontSize: '12px', borderCollapse: 'collapse' }}>
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
              {strategyStats.map(s => (
                <tr key={s.name} style={{ textAlign: 'right', borderTop: '1px solid #1e293b' }}>
                  <td style={{ textAlign: 'left', paddingRight: '8px', color: '#cbd5e1' }}>{s.name}</td>
                  <td>{s.count}</td>
                  <td>{(s.winRate * 100).toFixed(1)}%</td>
                  <td style={{ color: s.avgGrossPnl >= 0 ? '#22c55e' : '#ef4444' }}>
                    {s.avgGrossPnl >= 0 ? '+' : ''}{s.avgGrossPnl.toFixed(4)}
                  </td>
                  <td style={{ color: '#f59e0b' }}>{s.avgFees.toFixed(4)}</td>
                  <td style={{ color: s.avgNetPnl >= 0 ? '#22c55e' : '#ef4444' }}>
                    {s.avgNetPnl >= 0 ? '+' : ''}{s.avgNetPnl.toFixed(4)}
                  </td>
                  <td style={{ color: s.feeDragRatio > 50 ? '#ef4444' : '#94a3b8' }}>
                    {s.feeDragRatio.toFixed(1)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
