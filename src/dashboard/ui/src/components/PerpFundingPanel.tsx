import React from 'react';
import type { PerpFundingPayload } from '../types.js';

interface PerpFundingPanelProps {
  /** Map from FCM product ID to latest funding payload. */
  fundingRates: Record<string, PerpFundingPayload>;
  lastUpdatedAt?: number;
}

/** FCM product IDs as emitted by PerpPositionManager fundingUpdate events. */
const INSTRUMENTS = ['BIP-20DEC30-CDE', 'ETP-20DEC30-CDE'] as const;

/** Human-readable display names for FCM product IDs. */
const DISPLAY_NAME: Record<string, string> = {
  'BIP-20DEC30-CDE': 'BTC-PERP',
  'ETP-20DEC30-CDE': 'ETH-PERP',
};

export function PerpFundingPanel({ fundingRates, lastUpdatedAt }: PerpFundingPanelProps): React.ReactElement {
  return (
    <div>
      <table className="data-table">
        <thead>
          <tr>
            <th>Instrument</th>
            <th>8h Funding Rate</th>
            <th>Cum. Funding</th>
          </tr>
        </thead>
        <tbody>
          {INSTRUMENTS.map((fcmId) => {
            const entry = fundingRates[fcmId];
            return (
              <tr key={fcmId}>
                <td className="mono">{DISPLAY_NAME[fcmId] ?? fcmId}</td>
                <td className="mono text-muted">
                  {entry ? entry.currentFundingRate : '—'}
                </td>
                <td className="mono text-muted">
                  {entry ? entry.cumulativeFundingCost : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div style={{ fontSize: '11px', color: '#6b7280', marginTop: '0.25rem', textAlign: 'right' }}>
        {lastUpdatedAt
          ? `Updated: ${new Date(lastUpdatedAt).toLocaleTimeString()}`
          : 'Awaiting data'}
      </div>
    </div>
  );
}
