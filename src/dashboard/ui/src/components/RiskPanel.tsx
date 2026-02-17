/**
 * RiskPanel — Displays current risk thresholds, circuit breaker status,
 * and recent circuit breaker events.
 */

import React from 'react';
import type { CircuitBreakerEvent, RiskStatus } from '../types.js';

interface RiskPanelProps {
  riskStatus: RiskStatus;
  riskConfig: {
    maxDrawdown: number;
    maxExposure: number;
  };
  circuitBreakerEvents: CircuitBreakerEvent[];
}

/** Simple horizontal progress bar for utilization metrics */
function ProgressBar({
  value,
  max,
  danger = false,
}: {
  value: number;
  max: number;
  danger?: boolean;
}): React.ReactElement {
  const pct = Math.min(100, Math.max(0, (value / max) * 100));
  const color =
    danger || pct > 80 ? '#ef4444' : pct > 60 ? '#eab308' : '#22c55e';

  return (
    <div
      style={{
        background: '#0f0f1a',
        borderRadius: 4,
        height: 6,
        overflow: 'hidden',
        marginTop: 2,
      }}
    >
      <div
        style={{
          width: `${pct}%`,
          height: '100%',
          background: color,
          borderRadius: 4,
          transition: 'width 0.3s ease',
        }}
      />
    </div>
  );
}

function formatTs(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function RiskPanel({
  riskStatus,
  riskConfig,
  circuitBreakerEvents,
}: RiskPanelProps): React.ReactElement {
  const { circuitBreakerTripped, thresholds } = riskStatus;

  return (
    <div className="panel">
      <div className="panel-title">Risk Monitor</div>

      {/* Circuit breaker status */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          marginBottom: '0.75rem',
          padding: '0.5rem',
          background: circuitBreakerTripped
            ? 'rgba(239,68,68,0.1)'
            : 'rgba(34,197,94,0.05)',
          borderRadius: 6,
          border: `1px solid ${circuitBreakerTripped ? '#4a1a1a' : '#1a3a1a'}`,
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: circuitBreakerTripped ? '#ef4444' : '#22c55e',
            flexShrink: 0,
          }}
        />
        <span style={{ fontSize: 12, color: circuitBreakerTripped ? '#ef4444' : '#22c55e' }}>
          {circuitBreakerTripped ? 'Circuit Breaker TRIPPED' : 'Circuit Breaker OK'}
        </span>
      </div>

      {/* Thresholds */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem', marginBottom: '0.75rem' }}>
        {thresholds.maxDrawdownPct !== undefined && (
          <div>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                fontSize: 11,
                color: '#9ca3af',
              }}
            >
              <span>Max Drawdown</span>
              <span className="mono">{thresholds.maxDrawdownPct}%</span>
            </div>
            <ProgressBar value={0} max={riskConfig.maxDrawdown} />
          </div>
        )}

        {thresholds.maxExposurePct !== undefined && (
          <div>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                fontSize: 11,
                color: '#9ca3af',
              }}
            >
              <span>Max Exposure</span>
              <span className="mono">{thresholds.maxExposurePct}%</span>
            </div>
            <ProgressBar value={0} max={riskConfig.maxExposure} />
          </div>
        )}

        {thresholds.maxDailyLossPct !== undefined && (
          <div style={{ fontSize: 11, color: '#9ca3af', display: 'flex', justifyContent: 'space-between' }}>
            <span>Daily Loss Limit</span>
            <span className="mono">{thresholds.maxDailyLossPct}%</span>
          </div>
        )}

        {thresholds.maxPositionCount !== undefined && (
          <div style={{ fontSize: 11, color: '#9ca3af', display: 'flex', justifyContent: 'space-between' }}>
            <span>Max Positions</span>
            <span className="mono">{thresholds.maxPositionCount}</span>
          </div>
        )}

        {Object.keys(thresholds).length === 0 && (
          <div className="text-muted" style={{ fontSize: 11 }}>
            No thresholds configured
          </div>
        )}
      </div>

      {/* Recent circuit breaker events */}
      {circuitBreakerEvents.length > 0 && (
        <div>
          <div style={{ fontSize: 11, color: '#6b7280', marginBottom: '0.375rem', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Recent Events
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', maxHeight: 120, overflowY: 'auto' }}>
            {circuitBreakerEvents.slice(0, 5).map((evt, i) => (
              <div
                key={i}
                style={{
                  fontSize: 11,
                  padding: '0.25rem 0.375rem',
                  background: '#0f0f1a',
                  borderRadius: 4,
                  borderLeft: '2px solid #ef4444',
                }}
              >
                <span className="text-muted">{formatTs(evt.timestamp)}</span>
                {' · '}
                <span style={{ color: '#f87171' }}>{evt.type}</span>
                {evt.message && (
                  <span className="text-muted"> — {evt.message}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
