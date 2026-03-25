import React from 'react';
import type { PerpPositionPayload } from '../types.js';
import { useFlash } from '../hooks/useFlash.js';

interface PerpPositionRowProps {
  position: PerpPositionPayload;
}

function PerpPositionRow({ position }: PerpPositionRowProps): React.ReactElement {
  const markFlash = useFlash(position.markPrice ?? position.entryPrice);
  const pnlFlash = useFlash(position.unrealizedPnl ?? '0');
  const pnlValue = position.unrealizedPnl != null ? parseFloat(position.unrealizedPnl) : null;
  const pnlClass = pnlValue != null && pnlValue >= 0 ? 'text-green' : pnlValue != null ? 'text-red' : 'text-muted';

  return (
    <tr>
      <td className="mono">{position.instrument}</td>
      <td className={position.direction === 'long' ? 'text-green' : 'text-red'}>
        {position.direction.toUpperCase()}
      </td>
      <td className="mono">{position.leverage}x</td>
      <td className="mono">{position.entryPrice}</td>
      <td className={`mono ${markFlash === 'up' ? 'flash-up' : markFlash === 'down' ? 'flash-down' : ''}`}>
        {position.markPrice ?? '—'}
      </td>
      <td className="mono text-muted">{position.liquidationPrice}</td>
      <td className={`mono ${pnlClass} ${pnlFlash === 'up' ? 'flash-up' : pnlFlash === 'down' ? 'flash-down' : ''}`}>
        {pnlValue != null ? `${pnlValue >= 0 ? '+' : ''}${position.unrealizedPnl}` : '—'}
      </td>
      <td className="mono text-muted">{position.cumulativeFundingCost ?? '—'}</td>
    </tr>
  );
}

interface PerpPositionsPanelProps {
  positions: PerpPositionPayload[];
  lastUpdatedAt?: number;
}

export function PerpPositionsPanel({ positions, lastUpdatedAt }: PerpPositionsPanelProps): React.ReactElement {
  const open = positions.filter((p) => p.status === 'open');

  const timestampDiv = (
    <div style={{ fontSize: '11px', color: '#6b7280', marginTop: '0.25rem', textAlign: 'right' }}>
      {lastUpdatedAt
        ? `Updated: ${new Date(lastUpdatedAt).toLocaleTimeString()}`
        : 'Awaiting data'}
    </div>
  );

  if (open.length === 0) {
    return (
      <div>
        <div className="empty-state">No open perp positions</div>
        {timestampDiv}
      </div>
    );
  }

  return (
    <div>
      <div style={{ overflowX: 'auto' }}>
        <table className="data-table">
          <thead>
            <tr>
              <th>Instrument</th>
              <th>Direction</th>
              <th>Leverage</th>
              <th>Entry</th>
              <th>Mark Price</th>
              <th>Liq. Price</th>
              <th>Unr. P&amp;L</th>
              <th>Funding Cost</th>
            </tr>
          </thead>
          <tbody>
            {open.map((pos) => (
              <PerpPositionRow key={pos.id} position={pos} />
            ))}
          </tbody>
        </table>
      </div>
      {timestampDiv}
    </div>
  );
}
