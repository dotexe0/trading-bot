import React, { useEffect, useState } from 'react';

interface SignalEntry {
  pair: string;
  direction: string;
  confidence: number;
  timestamp: number;
  ageMs: number;
}

interface CrossAssetState {
  signals: SignalEntry[];
  alignment: 'aligned' | 'opposing' | 'neutral' | 'stale';
}

const ALIGNMENT_COLORS: Record<string, string> = {
  aligned: '#22c55e',
  opposing: '#ef4444',
  neutral: '#94a3b8',
  stale: '#64748b',
};

const ALIGNMENT_LABELS: Record<string, string> = {
  aligned: 'Aligned',
  opposing: 'Opposing',
  neutral: 'Neutral',
  stale: 'Stale',
};

const DIRECTION_COLORS: Record<string, string> = {
  long: '#22c55e',
  short: '#ef4444',
  close: '#94a3b8',
};

function formatAge(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  return `${(ms / 3_600_000).toFixed(1)}h ago`;
}

export function CrossAssetSignalPanel(): React.ReactElement {
  const [state, setState] = useState<CrossAssetState | null>(null);

  useEffect(() => {
    let active = true;
    const fetchState = async () => {
      try {
        const res = await fetch('/api/cross-asset-signals');
        if (res.ok && active) {
          setState(await res.json());
        }
      } catch { /* ignore */ }
    };
    fetchState();
    const interval = setInterval(fetchState, 10_000);
    return () => { active = false; clearInterval(interval); };
  }, []);

  if (!state || state.signals.length === 0) {
    return (
      <div className="panel" style={{ minHeight: 60 }}>
        <div className="panel-title">Cross-Asset Signals</div>
        <div style={{ color: '#64748b', fontSize: 12 }}>No signals yet</div>
      </div>
    );
  }

  return (
    <div className="panel">
      <div className="panel-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>Cross-Asset Signals</span>
        <span style={{
          fontSize: 11,
          fontWeight: 600,
          color: ALIGNMENT_COLORS[state.alignment],
          background: `${ALIGNMENT_COLORS[state.alignment]}22`,
          padding: '2px 8px',
          borderRadius: 4,
        }}>
          {ALIGNMENT_LABELS[state.alignment]}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 12, marginTop: 6 }}>
        {state.signals.map((s) => (
          <div key={s.pair} style={{
            flex: 1,
            background: 'rgba(30, 41, 59, 0.5)',
            borderRadius: 4,
            padding: '8px 10px',
          }}>
            <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 4 }}>{s.pair}</div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
              <span style={{
                fontSize: 14,
                fontWeight: 600,
                color: DIRECTION_COLORS[s.direction] ?? '#94a3b8',
                textTransform: 'uppercase',
              }}>
                {s.direction}
              </span>
              <span className="mono" style={{ fontSize: 11, color: '#94a3b8' }}>
                {s.confidence.toFixed(2)}
              </span>
            </div>
            <div style={{ fontSize: 10, color: '#64748b', marginTop: 2 }}>
              {formatAge(s.ageMs)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
