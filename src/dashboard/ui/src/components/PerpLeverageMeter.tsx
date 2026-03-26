import React from 'react';
import type { PerpExposurePayload } from '../types.js';

interface PerpLeverageMeterProps {
  exposure: PerpExposurePayload;
  lastUpdatedAt?: number;
}

function barColor(ratio: number): string {
  if (ratio > 0.8) return '#ef4444';
  if (ratio > 0.5) return '#eab308';
  return '#22c55e';
}

export function PerpLeverageMeter({ exposure, lastUpdatedAt }: PerpLeverageMeterProps): React.ReactElement {
  const utilization = isFinite(parseFloat(exposure.utilizationPct)) ? parseFloat(exposure.utilizationPct) : 0;
  const ratio = Math.min(utilization / 100, 1);
  const over = utilization > 100;

  return (
    <div>
      <div style={{ color: '#9ca3af', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: '11px', marginBottom: '6px' }}>
        Perp Leverage Utilization
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginBottom: '4px' }}>
        <span style={{ fontFamily: 'monospace', color: over ? '#ef4444' : '#d1d5db' }}>
          {utilization.toFixed(1)}%
        </span>
        <span style={{ color: '#6b7280', fontSize: '11px' }}>
          {exposure.totalNotionalUsd !== '0.00'
            ? `$${exposure.totalNotionalUsd} / $${exposure.exposureCapUsd}`
            : 'No open positions'}
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
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: '#4b5563', marginTop: '3px' }}>
        <span>0%</span>
        <span>50%</span>
        <span>100%</span>
      </div>
      {lastUpdatedAt && (
        <div style={{ textAlign: 'center', fontSize: '11px', color: '#6b7280', marginTop: '6px' }}>
          Updated: {new Date(lastUpdatedAt).toLocaleTimeString()}
        </div>
      )}
    </div>
  );
}
