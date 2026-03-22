import React from 'react';
import type { FeedHealthPayload } from '../types.js';

interface FeedHealthPanelProps {
  feeds: FeedHealthPayload[];
  lastUpdatedAt?: number;
}

const STATUS_COLORS: Record<string, string> = {
  LIVE: '#22c55e',   // green -- healthy feed
  STALE: '#ef4444',  // red -- feed stale at 2.5x interval, signal evaluation paused
  DEAD: '#ef4444',   // red -- feed dead at 5x interval, signal evaluation paused
};

export function FeedHealthPanel({ feeds, lastUpdatedAt }: FeedHealthPanelProps): React.ReactElement {
  if (feeds.length === 0) {
    return (
      <div>
        <h3 style={{ margin: '0 0 0.5rem' }}>Feed Health</h3>
        <div style={{ color: '#6b7280', fontSize: '13px' }}>Awaiting data</div>
      </div>
    );
  }

  return (
    <div>
      <h3 style={{ margin: '0 0 0.5rem' }}>Feed Health</h3>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid #374151', color: '#9ca3af' }}>
            <th style={{ textAlign: 'left', padding: '4px 8px' }}>Instrument</th>
            <th style={{ textAlign: 'center', padding: '4px 8px' }}>Status</th>
            <th style={{ textAlign: 'right', padding: '4px 8px' }}>Last Candle</th>
          </tr>
        </thead>
        <tbody>
          {feeds.map((feed) => (
            <tr key={feed.instrument} style={{ borderBottom: '1px solid #1f2937' }}>
              <td style={{ padding: '4px 8px', fontFamily: 'monospace' }}>{feed.instrument}</td>
              <td style={{ textAlign: 'center', padding: '4px 8px' }}>
                <span
                  style={{
                    display: 'inline-block',
                    padding: '1px 8px',
                    borderRadius: '4px',
                    fontSize: '11px',
                    fontWeight: 600,
                    color: '#fff',
                    backgroundColor: STATUS_COLORS[feed.status] ?? '#6b7280',
                  }}
                >
                  {feed.status}
                </span>
              </td>
              <td style={{ textAlign: 'right', padding: '4px 8px', fontFamily: 'monospace', fontSize: '12px' }}>
                {feed.lastCandleAt
                  ? new Date(feed.lastCandleAt).toLocaleTimeString()
                  : '\u2014'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ fontSize: '11px', color: '#6b7280', marginTop: '0.25rem', textAlign: 'right' }}>
        {lastUpdatedAt
          ? `Updated: ${new Date(lastUpdatedAt).toLocaleTimeString()}`
          : 'Awaiting data'}
      </div>
    </div>
  );
}
