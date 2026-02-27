import React, { useCallback, useEffect, useRef, useState } from 'react';

interface EquitySummary {
  equity: string;
  initialCapital: string;
  pnl: string;
  pnlPct: string;
}

const POLL_MS = 10_000;

function fmt(value: number): string {
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

interface PortfolioStatsProps {
  mode?: 'live' | 'paper';
  /** Increment to trigger an immediate refresh (e.g. on equityUpdate WS event). */
  refreshToken?: number;
}

export function PortfolioStats({ mode = 'paper', refreshToken = 0 }: PortfolioStatsProps): React.ReactElement {
  const [data, setData] = useState<EquitySummary | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchEquity = useCallback(async () => {
    try {
      const res = await fetch('/api/portfolio/equity');
      if (res.ok) setData((await res.json()) as EquitySummary);
    } catch { /* API not ready */ }
  }, []);

  // Poll every 10s
  useEffect(() => {
    void fetchEquity();
    intervalRef.current = setInterval(() => { void fetchEquity(); }, POLL_MS);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [fetchEquity]);

  // Refresh immediately on equityUpdate WebSocket event
  useEffect(() => {
    if (refreshToken > 0) void fetchEquity();
  }, [refreshToken, fetchEquity]);

  if (!data || (data.equity === '0' && data.initialCapital === '0')) {
    return <div className="portfolio-stats-bar" style={{ color: '#6b7280', fontSize: '0.85rem' }}>No active session</div>;
  }

  const equity = parseFloat(data.equity);
  const initial = parseFloat(data.initialCapital);
  const pnl = parseFloat(data.pnl);
  const pnlPct = parseFloat(data.pnlPct);
  const isPositive = pnl >= 0;
  const pnlColor = isPositive ? '#22c55e' : '#ef4444';

  return (
    <div className="portfolio-stats-bar">
      <div className="portfolio-stat">
        <span className="portfolio-stat-label">Portfolio Value</span>
        <span className="portfolio-stat-value">${fmt(equity)}</span>
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
        <span className="portfolio-stat-value">${fmt(initial)}</span>
      </div>
      <div className="portfolio-stat-divider" />
      <div className="portfolio-stat">
        <span className="portfolio-stat-label">Mode</span>
        <span className="portfolio-stat-value" style={{
          color: mode === 'live' ? '#f59e0b' : '#60a5fa',
          textTransform: 'uppercase',
          fontSize: '0.75rem',
          letterSpacing: '0.05em',
        }}>
          {mode}
        </span>
      </div>
    </div>
  );
}
