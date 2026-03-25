import React from 'react';
import type { CircuitBreakerEvent, RiskStatus } from '../types.js';

interface RiskPanelProps {
  riskStatus: RiskStatus;
  riskConfig: {
    maxDrawdown: number;
    maxExposure: number;
  };
  circuitBreakerEvents: Array<{ timestamp: number; type: string; resolution: string }>;
}

function formatTs(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function barColor(ratio: number): string {
  if (ratio > 0.8) return '#ef4444';
  if (ratio > 0.5) return '#f59e0b';
  return '#22c55e';
}

interface RiskBarProps {
  label: string;
  current: number;
  max: number;
}

function RiskBar({ label, current, max }: RiskBarProps): React.ReactElement {
  const ratio = max > 0 ? Math.min(current / max, 1) : 0;
  const over = max > 0 && current > max;
  return (
    <div style={{ marginBottom: '10px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginBottom: '4px' }}>
        <span style={{ color: '#9ca3af', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: '11px' }}>
          {label}
        </span>
        <span style={{ fontFamily: 'monospace', color: over ? '#ef4444' : '#d1d5db' }}>
          {current.toFixed(1)}% / {max.toFixed(0)}%
        </span>
      </div>
      <div style={{ width: '100%', height: '10px', borderRadius: '5px', backgroundColor: '#374151' }}>
        <div
          style={{
            width: `${Math.min(ratio * 100, 100)}%`,
            height: '100%',
            borderRadius: '5px',
            backgroundColor: barColor(ratio),
            transition: 'width 0.4s ease',
          }}
        />
      </div>
    </div>
  );
}

export function RiskPanel({
  riskStatus,
  riskConfig,
  circuitBreakerEvents,
}: RiskPanelProps): React.ReactElement {
  const { circuitBreakerTripped } = riskStatus;
  const currentDrawdown = riskStatus.currentDrawdownPct ?? 0;
  const currentExposure = riskStatus.currentExposurePct ?? 0;
  const maxDrawdown = riskConfig.maxDrawdown > 0 ? riskConfig.maxDrawdown : 20;
  const maxExposure = riskConfig.maxExposure > 0 ? riskConfig.maxExposure : 80;

  return (
    <div className="panel">
      <div className="panel-title">
        Risk Monitor{' '}
        {circuitBreakerTripped && (
          <span style={{ color: '#ef4444', fontSize: '10px', marginLeft: '0.5rem' }}>
            CIRCUIT BREAKER TRIPPED
          </span>
        )}
      </div>

      <RiskBar label="Drawdown" current={currentDrawdown} max={maxDrawdown} />
      <RiskBar label="Exposure" current={currentExposure} max={maxExposure} />

      {/* Circuit Breaker Event Log */}
      <div className="event-log-title">Circuit Breaker Log</div>

      {circuitBreakerEvents.length === 0 ? (
        <div className="empty-state" style={{ padding: '1rem 0' }}>
          No circuit breaker events
        </div>
      ) : (
        <div className="event-log-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Timestamp</th>
                <th>Type</th>
                <th>Resolution</th>
              </tr>
            </thead>
            <tbody>
              {circuitBreakerEvents.slice(0, 20).map((evt, i) => (
                <tr key={`${evt.timestamp}-${i}`}>
                  <td className="mono text-muted">{formatTs(evt.timestamp)}</td>
                  <td style={{ color: '#f87171' }}>{evt.type}</td>
                  <td className="text-muted">{evt.resolution}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
