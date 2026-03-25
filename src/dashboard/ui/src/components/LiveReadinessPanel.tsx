import React, { useMemo } from 'react';
import type { GateStatusData, TradeData } from '../types.js';

interface LiveReadinessPanelProps {
  gateStatus: GateStatusData | null;
  trades: TradeData[];
}

/**
 * LiveReadinessPanel -- Displays pre-live gate GO/NO-GO status with paper
 * track record, risk config, fee tier info, and fail reasons.
 *
 * The panel uses server-provided gateStatus for the authoritative result
 * (all sessions + both spot and perp). A client-side useMemo on trades
 * provides live-session updates for the current spot session.
 *
 * Auto-updates when trades change (via orderFilled WS -> REST fetch chain)
 * and when gateStatus is re-fetched.
 */
export function LiveReadinessPanel({ gateStatus, trades }: LiveReadinessPanelProps): React.ReactElement {
  // Client-side live check from current session trades for real-time updates
  const liveStatus = useMemo(() => {
    if (!gateStatus) return null;
    const completed = trades.filter(t => t.pnl !== undefined && t.pnl !== null);
    const tradeCount = completed.length;
    const netPnl = completed.reduce((sum, t) => sum + parseFloat(t.pnl!), 0);
    const wins = completed.filter(t => parseFloat(t.pnl!) > 0);
    const winRate = tradeCount > 0 ? wins.length / tradeCount : 0;

    const meetsTradeCount = tradeCount >= gateStatus.config.minTrades;
    const meetsPnl = netPnl >= gateStatus.config.minNetPnl;
    const passed = meetsTradeCount && meetsPnl;

    const failReasons: string[] = [];
    if (!meetsTradeCount) {
      failReasons.push(`Need ${gateStatus.config.minTrades} trades, have ${tradeCount}`);
    }
    if (!meetsPnl) {
      failReasons.push(`Net P&L $${netPnl.toFixed(2)} below threshold $${gateStatus.config.minNetPnl}`);
    }

    return { passed, tradeCount, netPnl, winRate, failReasons };
  }, [trades, gateStatus]);

  if (!gateStatus) {
    return <div style={{ color: '#64748b', fontSize: '13px', padding: '8px 0' }}>Loading gate status...</div>;
  }

  // Use server-computed status as authoritative; show live session note if it differs
  const showGo = gateStatus.passed;
  const showLiveNote = liveStatus && liveStatus.passed !== gateStatus.passed;

  return (
    <div style={{ fontSize: '13px' }}>
      {/* GO / NO-GO indicator */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '12px',
        borderRadius: '8px',
        backgroundColor: showGo ? '#22c55e' : '#ef4444',
        color: '#fff',
        fontWeight: 700,
        fontSize: '18px',
        marginBottom: '12px',
        gap: '8px',
      }}>
        <span>{showGo ? '\u2713' : '\u2717'}</span>
        <span>{showGo ? 'GO' : 'NO-GO'}</span>
      </div>

      {showLiveNote && (
        <div style={{
          padding: '6px 8px',
          marginBottom: '8px',
          borderRadius: '4px',
          backgroundColor: liveStatus!.passed ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)',
          color: liveStatus!.passed ? '#22c55e' : '#ef4444',
          fontSize: '12px',
          textAlign: 'center',
        }}>
          Current session: {liveStatus!.passed ? 'GO' : 'NO-GO'} (based on {liveStatus!.tradeCount} session trades)
        </div>
      )}

      {/* Paper Track Record */}
      <div style={{ marginBottom: '10px' }}>
        <div style={{ color: '#94a3b8', fontWeight: 600, marginBottom: '4px', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          Paper Track Record
        </div>
        <table style={{ width: '100%', fontSize: '12px', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ color: '#64748b', textAlign: 'right' }}>
              <th style={{ textAlign: 'left', paddingBottom: '2px' }}></th>
              <th style={{ paddingBottom: '2px' }}>Trades</th>
              <th style={{ paddingBottom: '2px' }}>Net P&L</th>
              <th style={{ paddingBottom: '2px' }}>Win Rate</th>
            </tr>
          </thead>
          <tbody>
            <tr style={{ borderTop: '1px solid #1e293b' }}>
              <td style={{ color: '#cbd5e1', paddingRight: '8px' }}>Spot</td>
              <td style={{ textAlign: 'right' }}>{gateStatus.spotTradeCount}</td>
              <td style={{ textAlign: 'right', color: parseFloat(gateStatus.spotNetPnl) >= 0 ? '#22c55e' : '#ef4444' }}>
                ${gateStatus.spotNetPnl}
              </td>
              <td style={{ textAlign: 'right' }}>{(gateStatus.spotWinRate * 100).toFixed(1)}%</td>
            </tr>
            <tr style={{ borderTop: '1px solid #1e293b' }}>
              <td style={{ color: '#cbd5e1', paddingRight: '8px' }}>Perp</td>
              <td style={{ textAlign: 'right' }}>{gateStatus.perpTradeCount}</td>
              <td style={{ textAlign: 'right', color: parseFloat(gateStatus.perpNetPnl) >= 0 ? '#22c55e' : '#ef4444' }}>
                ${gateStatus.perpNetPnl}
              </td>
              <td style={{ textAlign: 'right' }}>{(gateStatus.perpWinRate * 100).toFixed(1)}%</td>
            </tr>
            <tr style={{ borderTop: '1px solid #1e293b', fontWeight: 600 }}>
              <td style={{ color: '#cbd5e1', paddingRight: '8px' }}>Total</td>
              <td style={{ textAlign: 'right' }}>{gateStatus.totalTradeCount}</td>
              <td style={{ textAlign: 'right', color: parseFloat(gateStatus.totalNetPnl) >= 0 ? '#22c55e' : '#ef4444' }}>
                ${gateStatus.totalNetPnl}
              </td>
              <td style={{ textAlign: 'right' }}></td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Gate Thresholds */}
      <div style={{ marginBottom: '10px' }}>
        <div style={{ color: '#94a3b8', fontWeight: 600, marginBottom: '4px', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          Gate Thresholds
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'max-content auto', gap: '4px 12px', fontSize: '12px' }}>
          <span style={{ color: '#64748b' }}>Min trades</span>
          <span style={{ textAlign: 'right' }}>{gateStatus.config.minTrades}</span>
          <span style={{ color: '#64748b' }}>Min net P&L</span>
          <span style={{ textAlign: 'right' }}>${gateStatus.config.minNetPnl}</span>
          <span style={{ color: '#64748b' }}>Lookback</span>
          <span style={{ textAlign: 'right' }}>{gateStatus.config.lookbackTrades ?? 'All trades'}</span>
        </div>
      </div>

      {/* Risk Config */}
      <div style={{ marginBottom: '10px' }}>
        <div style={{ color: '#94a3b8', fontWeight: 600, marginBottom: '4px', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          Risk Config
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'max-content auto', gap: '4px 12px', fontSize: '12px' }}>
          <span style={{ color: '#64748b' }}>Max drawdown</span>
          <span style={{ textAlign: 'right' }}>{gateStatus.riskConfig.maxDrawdownPct != null ? `${gateStatus.riskConfig.maxDrawdownPct}%` : 'N/A'}</span>
          <span style={{ color: '#64748b' }}>Max exposure</span>
          <span style={{ textAlign: 'right' }}>{gateStatus.riskConfig.maxExposurePct != null ? `${gateStatus.riskConfig.maxExposurePct}%` : 'N/A'}</span>
          <span style={{ color: '#64748b' }}>Max daily loss</span>
          <span style={{ textAlign: 'right' }}>{gateStatus.riskConfig.maxDailyLossPct != null ? `${gateStatus.riskConfig.maxDailyLossPct}%` : 'N/A'}</span>
          <span style={{ color: '#64748b' }}>Max positions</span>
          <span style={{ textAlign: 'right' }}>{gateStatus.riskConfig.maxPositionCount ?? 'N/A'}</span>
        </div>
      </div>

      {/* Fee Tier */}
      <div style={{ marginBottom: '10px' }}>
        <div style={{ color: '#94a3b8', fontWeight: 600, marginBottom: '4px', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          Fee Tier
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'max-content auto', gap: '4px 12px', fontSize: '12px' }}>
          <span style={{ color: '#64748b' }}>Spot taker</span>
          <span style={{ textAlign: 'right' }}>{(gateStatus.feeConfig.spotTakerRate * 100).toFixed(2)}%</span>
          <span style={{ color: '#64748b' }}>Perp taker</span>
          <span style={{ textAlign: 'right' }}>
            {gateStatus.feeConfig.perpTakerRate != null
              ? `${(gateStatus.feeConfig.perpTakerRate * 100).toFixed(4)}%`
              : 'N/A (FCM not enabled)'}
          </span>
          <span style={{ color: '#64748b' }}>Source</span>
          <span style={{ textAlign: 'right' }}>{gateStatus.feeConfig.perpFeeSource ?? 'N/A'}</span>
        </div>
      </div>

      {/* Fail Reasons */}
      {!gateStatus.passed && gateStatus.failReasons.length > 0 && (
        <div>
          <div style={{ color: '#94a3b8', fontWeight: 600, marginBottom: '4px', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Fail Reasons
          </div>
          <ul style={{ margin: 0, paddingLeft: '16px', fontSize: '12px' }}>
            {gateStatus.failReasons.map((reason, i) => (
              <li key={i} style={{ color: '#ef4444', marginBottom: '2px' }}>{reason}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
