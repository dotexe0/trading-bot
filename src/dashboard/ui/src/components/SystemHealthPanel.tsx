import React from 'react';
import type { SystemHealthPayload } from '../types.js';

interface SystemHealthPanelProps {
  systemHealth: SystemHealthPayload | null;
}

const RECOVERY_COLORS: Record<string, string> = {
  NORMAL: '#22c55e',
  RECOVERING: '#f59e0b',
  RECONCILIATION_NEEDED: '#ef4444',
};

const FEED_STATUS_COLORS: Record<string, string> = {
  LIVE: '#22c55e',
  STALE: '#f59e0b',
  DEAD: '#ef4444',
};

function getBarColor(ratio: number): string {
  if (ratio > 0.8) return '#ef4444';
  if (ratio > 0.5) return '#f59e0b';
  return '#22c55e';
}

const badgeStyle = (bg: string): React.CSSProperties => ({
  display: 'inline-block',
  padding: '1px 8px',
  borderRadius: '4px',
  fontSize: '11px',
  fontWeight: 600,
  color: '#fff',
  backgroundColor: bg,
});

const labelStyle: React.CSSProperties = {
  color: '#9ca3af',
  fontSize: '13px',
};

const valueStyle: React.CSSProperties = {
  fontFamily: 'monospace',
  fontSize: '13px',
};

const rowStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '3px 0',
};

export function SystemHealthPanel({ systemHealth }: SystemHealthPanelProps): React.ReactElement {
  if (!systemHealth) {
    return (
      <div>
        <h3 style={{ margin: '0 0 0.5rem' }}>System Health</h3>
        <div style={{ color: '#6b7280', fontSize: '13px' }}>Awaiting data</div>
      </div>
    );
  }

  const { recoveryState, lastReconciliationAt, feedHealth, riskProximity } = systemHealth;
  const drawdownRatio = riskProximity.maxDrawdownPct > 0
    ? riskProximity.currentDrawdownPct / riskProximity.maxDrawdownPct
    : 0;
  const exposureRatio = riskProximity.maxExposurePct > 0
    ? riskProximity.currentExposurePct / riskProximity.maxExposurePct
    : 0;

  return (
    <div>
      <h3 style={{ margin: '0 0 0.5rem' }}>System Health</h3>

      {/* Recovery State */}
      <div style={rowStyle}>
        <span style={labelStyle}>Recovery</span>
        <span style={badgeStyle(RECOVERY_COLORS[recoveryState] ?? '#6b7280')}>
          {recoveryState}
        </span>
      </div>

      {/* Last Reconciliation */}
      <div style={rowStyle}>
        <span style={labelStyle}>Last Reconciliation</span>
        <span style={valueStyle}>
          {lastReconciliationAt != null
            ? new Date(lastReconciliationAt).toLocaleString()
            : '\u2014'}
        </span>
      </div>

      {/* Feed Health */}
      <div style={{ marginTop: '8px' }}>
        <div style={{ ...labelStyle, marginBottom: '4px', fontWeight: 600 }}>Feed Status</div>
        {(!feedHealth || feedHealth.length === 0) ? (
          <div style={{ color: '#9ca3af', fontSize: '12px' }}>No feeds</div>
        ) : (
          feedHealth.map((feed) => (
            <div key={feed.instrument} style={{ ...rowStyle, padding: '2px 0', fontSize: '12px' }}>
              <span style={{ fontFamily: 'monospace' }}>{feed.instrument}</span>
              <span style={badgeStyle(FEED_STATUS_COLORS[feed.status] ?? '#6b7280')}>
                {feed.status}
              </span>
            </div>
          ))
        )}
      </div>

      {/* Risk Proximity */}
      <div style={{ marginTop: '8px' }}>
        <div style={{ ...labelStyle, marginBottom: '4px', fontWeight: 600 }}>Risk Proximity</div>

        {/* Drawdown bar */}
        <div style={{ marginBottom: '6px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginBottom: '2px' }}>
            <span style={labelStyle}>Drawdown</span>
            <span style={valueStyle}>
              {riskProximity.currentDrawdownPct.toFixed(1)}% / {riskProximity.maxDrawdownPct.toFixed(0)}%
            </span>
          </div>
          <div style={{ width: '100%', height: '8px', borderRadius: '4px', backgroundColor: '#374151' }}>
            <div
              style={{
                width: `${Math.min(drawdownRatio * 100, 100)}%`,
                height: '100%',
                borderRadius: '4px',
                backgroundColor: getBarColor(drawdownRatio),
                transition: 'width 0.3s ease',
              }}
            />
          </div>
        </div>

        {/* Exposure bar */}
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginBottom: '2px' }}>
            <span style={labelStyle}>Exposure</span>
            <span style={valueStyle}>
              {riskProximity.currentExposurePct.toFixed(1)}% / {riskProximity.maxExposurePct.toFixed(0)}%
            </span>
          </div>
          <div style={{ width: '100%', height: '8px', borderRadius: '4px', backgroundColor: '#374151' }}>
            <div
              style={{
                width: `${Math.min(exposureRatio * 100, 100)}%`,
                height: '100%',
                borderRadius: '4px',
                backgroundColor: getBarColor(exposureRatio),
                transition: 'width 0.3s ease',
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
