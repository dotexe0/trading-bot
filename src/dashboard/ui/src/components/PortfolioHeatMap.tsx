import React, { useEffect, useRef, useState } from 'react';

// ── Types ─────────────────────────────────────────────────────────────

interface AssetTile {
  pair: string;
  allocationPct: number;
  valueUsd: string;
}

interface HeatMapData {
  assets: AssetTile[];
  totalValueUsd: string;
  noPositions: boolean;
  correlation: number | null;
  correlationTimestamp: number | null;
}

// ── Color helpers ─────────────────────────────────────────────────────

function allocationColor(pct: number): string {
  // Gray at 0%, green at 100% using HSL
  const saturation = Math.round(pct * 0.8); // 0–80
  const lightness = 25 + Math.round(pct * 0.15); // 25–40
  return `hsl(142, ${saturation}%, ${lightness}%)`;
}

function correlationLabel(r: number): { text: string; color: string } {
  if (r >= 0.7) return { text: 'High', color: '#ef4444' };
  if (r >= 0.4) return { text: 'Moderate', color: '#f59e0b' };
  return { text: 'Low', color: '#22c55e' };
}

// ── Component ─────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 30_000;

export function PortfolioHeatMap(): React.ReactElement {
  const [data, setData] = useState<HeatMapData | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function fetchData(): Promise<void> {
    try {
      const res = await fetch('/api/portfolio/heatmap');
      if (res.ok) {
        const json = (await res.json()) as HeatMapData;
        setData(json);
        setLoading(false);
      }
    } catch {
      // API not reachable yet — keep loading state
    }
  }

  useEffect(() => {
    void fetchData();
    intervalRef.current = setInterval(() => { void fetchData(); }, POLL_INTERVAL_MS);
    return () => {
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
      }
    };
  }, []);

  if (loading || data === null) {
    return <div className="empty-state">Loading...</div>;
  }

  return (
    <div className="heatmap-container">
      {data.noPositions && (
        <div className="heatmap-no-positions" style={{ color: '#9ca3af', marginBottom: '0.5rem', fontSize: '0.85rem' }}>
          No active positions
        </div>
      )}
      <div className="heatmap-grid" style={{ display: 'flex', gap: '1rem' }}>
        {data.assets.map((asset) => (
          <div
            key={asset.pair}
            className="heatmap-tile"
            style={{
              backgroundColor: allocationColor(asset.allocationPct),
              flex: 1,
              padding: '1rem',
              borderRadius: '6px',
              textAlign: 'center',
            }}
          >
            <div style={{ fontWeight: 'bold', fontSize: '1.1rem' }}>{asset.pair}</div>
            <div style={{ fontSize: '1.5rem' }}>{asset.allocationPct.toFixed(1)}%</div>
            <div style={{ color: '#9ca3af', fontSize: '0.85rem' }}>${asset.valueUsd}</div>
          </div>
        ))}
      </div>
      <div
        className="correlation-badge"
        style={{ marginTop: '0.75rem', fontSize: '0.9rem', color: '#9ca3af' }}
      >
        BTC/ETH Correlation (1h):{' '}
        {data.correlation !== null ? (
          <>
            <span>{data.correlation.toFixed(3)}</span>{' '}
            <span style={{ color: correlationLabel(data.correlation).color }}>
              ({correlationLabel(data.correlation).text})
            </span>
          </>
        ) : (
          <span>N/A — run correlation analysis first</span>
        )}
      </div>
    </div>
  );
}
