/**
 * DrawdownGauge — Semicircular gauge for current drawdown percentage.
 *
 * Color zones are config-driven from the risk config maxDrawdownPct:
 *   - Green:    0 to 50% of max
 *   - Yellow:   50% to 80% of max
 *   - Red:      80% to 100% of max
 *   - Dark red: beyond max (120% headroom)
 */

import React from 'react';
import GaugeComponent from 'react-gauge-component';

interface DrawdownGaugeProps {
  currentDrawdownPct: number;
  maxDrawdownPct: number;
}

export function DrawdownGauge({ currentDrawdownPct, maxDrawdownPct }: DrawdownGaugeProps): React.ReactElement {
  // Add 20% headroom beyond max so gauge shows over-limit values
  const maxDisplay = maxDrawdownPct > 0 ? maxDrawdownPct * 1.2 : 24;
  const max = maxDrawdownPct > 0 ? maxDrawdownPct : 20;

  const subArcs = [
    { limit: max * 0.5, color: '#22c55e', showTick: true, tooltip: { text: 'Safe' } },
    { limit: max * 0.8, color: '#eab308', showTick: true, tooltip: { text: 'Warning' } },
    { limit: max, color: '#ef4444', showTick: true, tooltip: { text: 'Danger' } },
    { limit: maxDisplay, color: '#7f1d1d', tooltip: { text: 'Critical' } },
  ];

  return (
    <div className="gauge-container">
      <div className="gauge-label">Drawdown</div>
      <GaugeComponent
        type="semicircle"
        arc={{ width: 0.2, padding: 0.005, subArcs }}
        pointer={{ type: 'blob', animationDelay: 0 }}
        value={currentDrawdownPct}
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
            ticks: [
              { value: 0 },
              { value: max * 0.5 },
              { value: max },
            ],
            defaultTickValueConfig: {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              formatTextValue: (v: any) => `${Number(v).toFixed(0)}%`,
              style: { fill: '#6b7280', fontSize: '10px' },
            },
          },
        }}
      />
    </div>
  );
}
