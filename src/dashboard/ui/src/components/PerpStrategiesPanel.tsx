import type { PerpTournamentLeaderboard } from '../types.js';

interface Props {
  tournament: PerpTournamentLeaderboard | null;
}

/** Derives a short label that distinguishes param variants of the same strategy. */
function strategyLabel(name: string, config: Record<string, unknown>): string {
  if (name === 'perp-momentum') {
    const { breakoutWindow: bw, volumeMultiplier: vm, maxHoldCandles: mh } = config;
    if (bw !== undefined && vm !== undefined && mh !== undefined) {
      return `${name} [bw=${bw} vm=${vm} mh=${mh}]`;
    }
  }
  if (name === 'perp-mean-reversion') {
    const { period: p, threshold: t } = config;
    if (p !== undefined && t !== undefined) {
      return `${name} [p=${p} t=${t}]`;
    }
  }
  return name;
}

function fmt(n: number, decimals = 2): string {
  return isFinite(n) ? n.toFixed(decimals) : '—';
}

function pct(n: number): string {
  return isFinite(n) ? `${(n * 100).toFixed(1)}%` : '—';
}

export function PerpStrategiesPanel({ tournament }: Props) {
  const runDate = tournament
    ? new Date(tournament.runAt).toLocaleString()
    : null;

  return (
    <div className="panel">
      <div className="panel-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>Perp Strategy Tournament</span>
        {runDate && (
          <span style={{ fontSize: '10px', color: 'var(--text-lo)', fontWeight: 400 }}>
            {runDate}
          </span>
        )}
      </div>

      {!tournament ? (
        <div className="empty-state">No perp tournament data — perp may be disabled or tournament skipped</div>
      ) : tournament.leaderboard.length === 0 ? (
        <div className="empty-state">No strategies evaluated</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Strategy</th>
              <th>OOS Sharpe</th>
              <th>IS Sharpe</th>
              <th>Robustness</th>
              <th>OOS Trades</th>
              <th>Win%</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {tournament.leaderboard.map((entry) => {
              const isTop = entry.rank === 1 && !entry.disqualified;
              const label = strategyLabel(entry.strategyName, entry.strategyConfig ?? {});
              return (
                <tr key={entry.rank}>
                  <td>
                    <span
                      style={{
                        fontFamily: 'var(--mono)',
                        fontSize: '11px',
                        color: isTop ? 'var(--accent)' : 'var(--text-lo)',
                        fontWeight: isTop ? 700 : 400,
                      }}
                    >
                      #{entry.rank}
                    </span>
                  </td>
                  <td>
                    <span style={{ color: 'var(--text-hi)', fontWeight: 500 }}>
                      {label}
                    </span>
                  </td>
                  <td className="mono">
                    <span className={entry.oosSharpe >= 0 ? 'text-green' : 'text-red'}>
                      {fmt(entry.oosSharpe)}
                    </span>
                  </td>
                  <td className="mono" style={{ color: 'var(--text-lo)' }}>
                    {fmt(entry.isSharpe)}
                  </td>
                  <td className="mono" style={{ color: 'var(--text-lo)' }}>
                    {fmt(entry.robustnessRatio)}
                  </td>
                  <td className="mono" style={{ color: 'var(--text-lo)' }}>
                    {entry.oosTradeCount}
                  </td>
                  <td className="mono">
                    <span
                      style={{
                        color:
                          entry.oosTradeCount < 5
                            ? 'var(--warn)'
                            : entry.oosWinRate >= 0.5
                              ? 'var(--gain)'
                              : 'var(--text)',
                      }}
                      title={entry.oosTradeCount < 5 ? 'Low sample — fewer than 5 OOS trades' : undefined}
                    >
                      {pct(entry.oosWinRate)}
                      {entry.oosTradeCount < 5 && ' ⚠'}
                    </span>
                  </td>
                  <td>
                    {entry.disqualified ? (
                      <span
                        className="status-badge"
                        style={{ background: '#1a1a2e', color: 'var(--text-lo)' }}
                        title={entry.disqualifyReason ?? undefined}
                      >
                        DQ
                      </span>
                    ) : isTop ? (
                      <span
                        className="status-badge"
                        style={{
                          background: 'rgba(23, 212, 200, 0.08)',
                          color: 'var(--accent)',
                          border: '1px solid rgba(23, 212, 200, 0.2)',
                        }}
                      >
                        SELECTED
                      </span>
                    ) : (
                      <span className="status-badge status-stopped">RANKED</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {tournament && (
        <div style={{ marginTop: '0.5rem', fontSize: '10.5px', color: 'var(--text-lo)' }}>
          {tournament.strategiesEvaluated} strategies evaluated · perp engine selects rank #1 automatically
        </div>
      )}
    </div>
  );
}
