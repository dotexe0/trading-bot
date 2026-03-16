import React from 'react';
import GaugeComponent from 'react-gauge-component';
import type { PerpExposurePayload } from '../types.js';

interface PerpLeverageMeterProps {
  exposure: PerpExposurePayload;
  lastUpdatedAt?: number;
}

export function PerpLeverageMeter({ exposure, lastUpdatedAt }: PerpLeverageMeterProps): React.ReactElement {
  const utilization = parseFloat(exposure.utilizationPct);
  const maxDisplay = 120;

  const subArcs = [
    { limit: 50, color: '#22c55e', showTick: true, tooltip: { text: 'Low' } },
    { limit: 80, color: '#eab308', showTick: true, tooltip: { text: 'Moderate' } },
    { limit: 100, color: '#ef4444', showTick: true, tooltip: { text: 'High' } },
    { limit: maxDisplay, color: '#7f1d1d', tooltip: { text: 'Over cap' } },
  ];

  return (
    <div className="gauge-container">
      <div className="gauge-label">Perp Leverage Utilization</div>
      <GaugeComponent
        type="semicircle"
        arc={{ width: 0.2, padding: 0.005, subArcs }}
        pointer={{ type: 'blob', animationDelay: 0 }}
        value={isFinite(utilization) ? utilization : 0}
        minValue={0}
        maxValue={maxDisplay}
        labels={{
          valueLabel: {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            formatTextValue: (v: any) => `${Number(v).toFixed(1)}%`,
            style: { fill: '#d1d5db', fontSize: '28px' },
          },
          tickLabels: {
            type: 'outer',
            ticks: [{ value: 0 }, { value: 50 }, { value: 100 }],
            defaultTickValueConfig: {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              formatTextValue: (v: any) => `${Number(v).toFixed(0)}%`,
              style: { fill: '#6b7280', fontSize: '10px' },
            },
          },
        }}
      />
      <div style={{ textAlign: 'center', fontSize: '11px', color: '#6b7280', marginTop: '-0.5rem' }}>
        {exposure.totalNotionalUsd !== '0.00'
          ? `$${exposure.totalNotionalUsd} notional`
          : 'No open positions'}
      </div>
      <div style={{ textAlign: 'center', fontSize: '11px', color: '#6b7280', marginTop: '0.25rem' }}>
        {lastUpdatedAt
          ? `Updated: ${new Date(lastUpdatedAt).toLocaleTimeString()}`
          : 'Awaiting data'}
      </div>
    </div>
  );
}
