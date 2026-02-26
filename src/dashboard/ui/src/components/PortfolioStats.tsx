import React from 'react';
import type { EquityPoint, SessionData } from '../types.js';

interface PortfolioStatsProps {
  equity: EquityPoint[];
  sessions: SessionData[];
}

function fmt(value: number): string {
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function PortfolioStats({ equity, sessions }: PortfolioStatsProps): React.ReactElement {
  const activeSession = sessions.find((s) => s.status === 'running') ?? sessions[0];
  const initialCapital = parseFloat(activeSession?.initialCapital ?? '0');
  const currentEquity =
    equity.length > 0
      ? parseFloat(equity[equity.length - 1].equity)
      : initialCapital;

  const pnl = currentEquity - initialCapital;
  const pnlPct = initialCapital > 0 ? (pnl / initialCapital) * 100 : 0;
  const isPositive = pnl >= 0;
  const pnlColor = isPositive ? '#22c55e' : '#ef4444';
  const mode = activeSession?.mode ?? 'paper';

  if (!activeSession) {
    return <div className="portfolio-stats-bar" style={{ color: '#6b7280', fontSize: '0.85rem' }}>No active session</div>;
  }

  return (
    <div className="portfolio-stats-bar">
      <div className="portfolio-stat">
        <span className="portfolio-stat-label">Portfolio Value</span>
        <span className="portfolio-stat-value">${fmt(currentEquity)}</span>
      </div>
      <div className="portfolio-stat-divider" />
      <div className="portfolio-stat">
        <span className="portfolio-stat-label">P&amp;L</span>
        <span className="portfolio-stat-value" style={{ color: pnlColor }}>
          {isPositive ? '+' : ''}{fmt(pnl)} ({isPositive ? '+' : ''}{pnlPct.toFixed(2)}%)
        </span>
      </div>
      <div className="portfolio-stat-divider" />
      <div className="portfolio-stat">
        <span className="portfolio-stat-label">Starting Capital</span>
        <span className="portfolio-stat-value">${fmt(initialCapital)}</span>
      </div>
      <div className="portfolio-stat-divider" />
      <div className="portfolio-stat">
        <span className="portfolio-stat-label">Mode</span>
        <span className="portfolio-stat-value" style={{ color: mode === 'live' ? '#f59e0b' : '#60a5fa', textTransform: 'uppercase', fontSize: '0.75rem', letterSpacing: '0.05em' }}>
          {mode}
        </span>
      </div>
    </div>
  );
}
