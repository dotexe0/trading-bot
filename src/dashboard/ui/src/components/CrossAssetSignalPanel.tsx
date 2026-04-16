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
  long: 'var(--gain, #22c55e)',
  short: 'var(--loss, #ef4444)',
  close: 'var(--text-lo, #94a3b8)',
};

const DIRECTION_ARROWS: Record<string, string> = {
  long: '\u25B2',
  short: '\u25BC',
  close: '\u25CF',
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
        <div className="empty-state" style={{ padding: '0.75rem 0' }}>No signals yet</div>
      </div>
    );
  }

  return (
    <div className="panel">
      <div className="panel-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>Cross-Asset Signals</span>
        <span
          className="signal-alignment-badge"
          style={{
            color: ALIGNMENT_COLORS[state.alignment],
            background: `${ALIGNMENT_COLORS[state.alignment]}22`,
          }}
        >
          {ALIGNMENT_LABELS[state.alignment]}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 12, marginTop: 6 }}>
        {state.signals.map((s) => (
          <div key={s.pair} className={`signal-card dir-${s.direction}`}>
            <div className="signal-pair">{s.pair}</div>
            <div className="signal-direction-row">
              <span
                className="signal-direction"
                style={{ color: DIRECTION_COLORS[s.direction] ?? 'var(--text-lo)' }}
              >
                <span className="signal-arrow">{DIRECTION_ARROWS[s.direction] ?? ''}</span>
                {s.direction}
              </span>
              <span className="mono signal-confidence">
                {s.confidence.toFixed(2)}
              </span>
            </div>
            <div className="signal-age">
              {formatAge(s.ageMs)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
