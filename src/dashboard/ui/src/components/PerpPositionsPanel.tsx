import React from 'react';
import type { PerpPositionPayload } from '../types.js';
import { useFlash } from '../hooks/useFlash.js';

interface PerpPositionRowProps {
  position: PerpPositionPayload;
}

function PerpPositionRow({ position }: PerpPositionRowProps): React.ReactElement {
  const markFlash = useFlash(position.markPrice ?? position.entryPrice);
  const pnlFlash = useFlash(position.unrealizedPnl ?? '0');
  const pnlValue = parseFloat(position.unrealizedPnl ?? '0');
  const pnlClass = pnlValue >= 0 ? 'text-green' : 'text-red';

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
        {pnlValue >= 0 ? '+' : ''}{position.unrealizedPnl ?? '0.00000000'}
      </td>
      <td className="mono text-muted">{position.cumulativeFundingCost ?? '0.00000000'}</td>
    </tr>
  );
}

interface PerpPositionsPanelProps {
  positions: PerpPositionPayload[];
}

export function PerpPositionsPanel({ positions }: PerpPositionsPanelProps): React.ReactElement {
  const open = positions.filter((p) => p.status === 'open');

  if (open.length === 0) {
    return <div className="empty-state">No open perp positions</div>;
  }

  return (
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
  );
}
