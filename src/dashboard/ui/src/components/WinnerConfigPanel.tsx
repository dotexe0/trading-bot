import React from 'react';
import type { TournamentLeaderboard, PerpTournamentLeaderboard } from '../types.js';

interface WinnerConfigPanelProps {
  tournament: TournamentLeaderboard | null;
  perpTournament: PerpTournamentLeaderboard | null;
}

function ConfigTable({ config, label }: { config: Record<string, unknown>; label: string }): React.ReactElement {
  const entries = Object.entries(config).filter(([k]) => k !== 'strategy');

  if (entries.length === 0) {
    return <div className="empty-state" style={{ padding: '0.5rem 0' }}>No parameters</div>;
  }

  return (
    <div style={{ marginBottom: 12 }}>
      <div className="winner-config-label">{label}</div>
      <table className="data-table">
        <tbody>
          {entries.map(([key, value]) => (
            <tr key={key}>
              <td className="winner-config-key">{key}</td>
              <td className="mono winner-config-value">{String(value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function WinnerConfigPanel({ tournament, perpTournament }: WinnerConfigPanelProps): React.ReactElement {
  const spotWinner = tournament?.leaderboard?.find((e) => e.active && !e.disqualified);
  const perpWinner = perpTournament?.leaderboard?.find((e) => !e.disqualified && e.rank === 1);

  const hasSpot = spotWinner?.strategyConfig;
  const hasPerp = perpWinner?.strategyConfig;

  if (!hasSpot && !hasPerp) {
    return (
      <div className="panel" style={{ '--panel-i': 3 } as React.CSSProperties}>
        <div className="panel-title">Active Config</div>
        <div className="empty-state">No tournament data yet</div>
      </div>
    );
  }

  return (
    <div className="panel" style={{ '--panel-i': 3 } as React.CSSProperties}>
      <div className="panel-title">Active Config</div>
      {hasSpot && (
        <ConfigTable
          config={spotWinner!.strategyConfig!}
          label={`Spot: ${spotWinner!.strategyName}`}
        />
      )}
      {hasPerp && (
        <ConfigTable
          config={perpWinner!.strategyConfig}
          label={`Perp: ${perpWinner!.strategyName}`}
        />
      )}
    </div>
  );
}
