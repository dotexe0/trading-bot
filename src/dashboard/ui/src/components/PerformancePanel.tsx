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

    return { tradeCount, winRate, avgWinPct, avgLossPct, winLossRatio };
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
      </div>
    </div>
  );
}
