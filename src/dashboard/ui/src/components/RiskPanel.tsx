/**
 * RiskPanel — Risk dashboard panel with semicircular gauges and circuit breaker event log.
 *
 * Combines:
 * - DrawdownGauge: config-driven semicircular gauge for drawdown %
 * - ExposureGauge: config-driven semicircular gauge for exposure %
 * - Circuit breaker event log: recent triggers with timestamp, type, resolution
 */

import React from 'react';
import type { CircuitBreakerEvent, RiskStatus } from '../types.js';
import { DrawdownGauge } from './DrawdownGauge.js';
import { ExposureGauge } from './ExposureGauge.js';

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

export function RiskPanel({
  riskStatus,
  riskConfig,
  circuitBreakerEvents,
}: RiskPanelProps): React.ReactElement {
  const { circuitBreakerTripped } = riskStatus;
  const currentDrawdown = riskStatus.currentDrawdownPct ?? 0;
  const currentExposure = riskStatus.currentExposurePct ?? 0;

  // Ensure sensible defaults so gauges always render
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

      {/* Gauges side by side */}
      <div className="gauge-row">
        <DrawdownGauge
          currentDrawdownPct={currentDrawdown}
          maxDrawdownPct={maxDrawdown}
        />
        <ExposureGauge
          currentExposurePct={currentExposure}
          maxExposurePct={maxExposure}
        />
      </div>

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
