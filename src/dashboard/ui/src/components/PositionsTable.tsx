import React from 'react';
import type { PositionData } from '../types.js';
import { useFlash } from '../hooks/useFlash.js';

interface PositionRowProps {
  position: PositionData;
}

/**
 * Single position row with flash animations on price and PnL changes.
 */
function PositionRow({ position }: PositionRowProps): React.ReactElement {
  const priceFlash = useFlash(position.currentPrice);
  const pnlFlash = useFlash(position.unrealizedPnl);

  const pnlValue = parseFloat(position.unrealizedPnl);
  const pnlClass = pnlValue >= 0 ? 'text-green' : 'text-red';

  return (
    <tr>
      <td>{position.pair}</td>
      <td className={position.side === 'buy' ? 'text-green' : 'text-red'}>
        {position.side.toUpperCase()}
      </td>
      <td className="mono">{position.entryPrice}</td>
      <td className={`mono ${priceFlash === 'up' ? 'flash-up' : priceFlash === 'down' ? 'flash-down' : ''}`}>
        {position.currentPrice}
      </td>
      <td className="mono">{position.quantity}</td>
      <td className={`mono ${pnlClass} ${pnlFlash === 'up' ? 'flash-up' : pnlFlash === 'down' ? 'flash-down' : ''}`}>
        {pnlValue >= 0 ? '+' : ''}{position.unrealizedPnl}
      </td>
      <td className={`mono ${pnlClass}`}>
        {position.unrealizedPnlPct}%
      </td>
      <td className="text-muted">{position.strategyName}</td>
    </tr>
  );
}

interface PositionsTableProps {
  positions: PositionData[];
}

/**
 * Table of open positions with flash animations on price/PnL changes.
 * Per locked decision: subtle flash/color pulse on changed values (trading terminal style).
 */
export function PositionsTable({ positions }: PositionsTableProps): React.ReactElement {
  if (positions.length === 0) {
    return <div className="empty-state">No open positions</div>;
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="data-table">
        <thead>
          <tr>
            <th>Pair</th>
            <th>Side</th>
            <th>Entry Price</th>
            <th>Current Price</th>
            <th>Qty</th>
            <th>PnL</th>
            <th>PnL%</th>
            <th>Strategy</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((pos, i) => (
            <PositionRow key={`${pos.sessionId}-${pos.pair}-${i}`} position={pos} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
