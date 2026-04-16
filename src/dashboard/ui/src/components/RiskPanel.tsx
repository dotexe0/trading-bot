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

function barLevel(ratio: number): string {
  if (ratio > 0.8) return 'level-crit';
  if (ratio > 0.5) return 'level-warn';
  return 'level-ok';
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
    <div className="risk-bar">
      <div className="risk-bar-header">
        <span className="risk-bar-label">{label}</span>
        <span className={`risk-bar-value${over ? ' over' : ''}`}>
          {current.toFixed(1)}% / {max.toFixed(0)}%
        </span>
      </div>
      <div className="risk-bar-track">
        <div
          className={`risk-bar-fill ${barLevel(ratio)}`}
          style={{ width: `${Math.min(ratio * 100, 100)}%` }}
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
