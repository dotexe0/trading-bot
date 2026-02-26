import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Header } from './components/Header.js';
import { PriceChart } from './components/PriceChart.js';
import { EquityCurve } from './components/EquityCurve.js';
import { PositionsTable } from './components/PositionsTable.js';
import { TradeHistory } from './components/TradeHistory.js';
import { StrategyControls } from './components/StrategyControls.js';
import { RiskPanel } from './components/RiskPanel.js';
import { CircuitBreakerBanner } from './components/CircuitBreakerBanner.js';
import { useWebSocket } from './hooks/useWebSocket.js';
import { BacktestViewer } from './components/BacktestViewer.js';
import type {
  CircuitBreakerEvent,
  EquityPoint,
  EquityUpdatePayload,
  PositionData,
  PriceTickPayload,
  RiskStatus,
  SessionData,
  SnapshotPayload,
  StrategyInfo,
  TradeData,
} from './types.js';
import type { CandlestickData, Time } from 'lightweight-charts';
import type { PriceChartHandle } from './components/PriceChart.js';
import type { EquityCurveHandle } from './components/EquityCurve.js';

const WS_URL =
  typeof window !== 'undefined'
    ? `ws://${window.location.host}/ws`
    : 'ws://localhost:3001/ws';

function App(): React.ReactElement {
  // ── Data state ────────────────────────────────────────────────────
  const [sessions, setSessions] = useState<SessionData[]>([]);
  const [trades, setTrades] = useState<TradeData[]>([]);
  const [equity, setEquity] = useState<EquityPoint[]>([]);
  const [positions, setPositions] = useState<PositionData[]>([]);
  const [strategies, setStrategies] = useState<StrategyInfo[]>([]);
  const [riskStatus, setRiskStatus] = useState<RiskStatus>({
    circuitBreakerTripped: false,
    thresholds: {},
  });
  const [circuitBreakerEvents, setCircuitBreakerEvents] = useState<CircuitBreakerEvent[]>([]);
  const [cbBannerActive, setCbBannerActive] = useState(false);
  const [cbBannerMessage, setCbBannerMessage] = useState('');
  const [cbTriggeredAt, setCbTriggeredAt] = useState<number | undefined>(undefined);
  const [activePair, setActivePair] = useState<'BTC-USD' | 'ETH-USD'>('BTC-USD');
  const [isMuted, setIsMuted] = useState(false);

  // ── Chart refs for imperative updates ────────────────────────────
  const priceChartRef = useRef<PriceChartHandle>(null);
  const equityCurveRef = useRef<EquityCurveHandle>(null);

  // ── Fetch initial data ────────────────────────────────────────────
  useEffect(() => {
    void (async () => {
      try {
        // Fetch sessions
        const sessRes = await fetch('/api/sessions');
        if (sessRes.ok) {
          const sessData = (await sessRes.json()) as SessionData[];
          setSessions(sessData);

          // Use the first running or most recent session for initial data
          const active =
            sessData.find((s) => s.status === 'running') ?? sessData[0];

          if (active) {
            // Fetch equity for active session
            const eqRes = await fetch(`/api/sessions/${active.id}/equity`);
            if (eqRes.ok) {
              const eqData = (await eqRes.json()) as EquityPoint[];
              setEquity(eqData);
            }

            // Fetch trades for active session
            const trRes = await fetch(`/api/sessions/${active.id}/trades`);
            if (trRes.ok) {
              const trData = (await trRes.json()) as TradeData[];
              setTrades(trData);
            }
          }
        }

        // Fetch open positions
        const posRes = await fetch('/api/positions');
        if (posRes.ok) {
          const posData = (await posRes.json()) as PositionData[];
          setPositions(posData);
        }

        // Fetch active strategies
        const stratRes = await fetch('/api/strategies');
        if (stratRes.ok) {
          const stratData = (await stratRes.json()) as StrategyInfo[];
          setStrategies(stratData);
        }

        // Fetch risk status
        const riskRes = await fetch('/api/risk');
        if (riskRes.ok) {
          const riskData = (await riskRes.json()) as RiskStatus;
          setRiskStatus(riskData);
          if (riskData.circuitBreakerTripped) {
            setCbBannerActive(true);
          }
        }

        // Fetch circuit breaker events
        const eventsRes = await fetch('/api/risk/events');
        if (eventsRes.ok) {
          const eventsData = (await eventsRes.json()) as CircuitBreakerEvent[];
          setCircuitBreakerEvents(eventsData);
        }
      } catch {
        // API not available yet — dashboard shows empty state
      }
    })();
  }, []);

  // ── WebSocket message handler ─────────────────────────────────────
  const handleMessage = useCallback(
    (type: string, payload: unknown) => {
      switch (type) {
        case 'priceTick': {
          const tick = payload as PriceTickPayload;
          if (priceChartRef.current && tick.pair === activePair) {
            priceChartRef.current.update({
              time: Math.floor(tick.timestamp / 1000) as Time,
              open: parseFloat(tick.open),
              high: parseFloat(tick.high),
              low: parseFloat(tick.low),
              close: parseFloat(tick.close),
            });
          }
          break;
        }

        case 'equityUpdate': {
          const eq = payload as EquityUpdatePayload;
          const point: EquityPoint = {
            timestamp: eq.timestamp,
            equity: eq.equity,
          };
          setEquity((prev) => [...prev, point]);
          if (equityCurveRef.current) {
            equityCurveRef.current.update({
              time: Math.floor(eq.timestamp / 1000) as Time,
              value: parseFloat(eq.equity),
            });
          }
          break;
        }

        case 'orderFilled':
        case 'orderCancelled': {
          // Refresh positions and trades after an order event
          void fetch('/api/positions')
            .then((r) => r.json())
            .then((data) => setPositions(data as PositionData[]))
            .catch(() => undefined);
          break;
        }

        case 'snapshot': {
          const snap = payload as SnapshotPayload;
          if (snap.sessions) setSessions(snap.sessions);
          if (snap.trades) setTrades(snap.trades);
          if (snap.equity) setEquity(snap.equity);
          if (snap.strategies) setStrategies(snap.strategies);
          if (snap.risk) setRiskStatus(snap.risk);
          break;
        }

        case 'engineStarted': {
          // Refresh strategies list
          void fetch('/api/strategies')
            .then((r) => r.json())
            .then((data) => setStrategies(data as StrategyInfo[]))
            .catch(() => undefined);
          break;
        }

        case 'engineStopped': {
          // Refresh strategies list
          void fetch('/api/strategies')
            .then((r) => r.json())
            .then((data) => setStrategies(data as StrategyInfo[]))
            .catch(() => undefined);
          break;
        }

        case 'riskUpdate': {
          const riskPayload = payload as Partial<RiskStatus>;
          setRiskStatus((prev) => ({
            ...prev,
            ...riskPayload,
            thresholds: {
              ...prev.thresholds,
              ...(riskPayload.thresholds ?? {}),
            },
          }));
          break;
        }

        case 'circuitBreaker': {
          const cbPayload = payload as { type?: string; message?: string; timestamp?: number; resolution?: string };
          const now = Date.now();
          const event: CircuitBreakerEvent = {
            timestamp: cbPayload.timestamp ?? now,
            type: cbPayload.type ?? 'UNKNOWN',
            resolution: cbPayload.resolution ?? 'PENDING',
            message: cbPayload.message,
          };

          setCbBannerActive(true);
          setCbBannerMessage(cbPayload.message ?? `Circuit breaker triggered: ${event.type}`);
          setCbTriggeredAt(event.timestamp);
          setRiskStatus((prev) => ({ ...prev, circuitBreakerTripped: true }));
          setCircuitBreakerEvents((prev) => [event, ...prev].slice(0, 20));
          break;
        }

        case 'shutdown': {
          // Kill switch fired -- refresh positions and strategies to clear stale data
          void fetch('/api/positions')
            .then((r) => r.json())
            .then((data) => setPositions(data as PositionData[]))
            .catch(() => undefined);
          void fetch('/api/strategies')
            .then((r) => r.json())
            .then((data) => setStrategies(data as StrategyInfo[]))
            .catch(() => undefined);
          void fetch('/api/sessions')
            .then((r) => r.json())
            .then((data) => setSessions(data as SessionData[]))
            .catch(() => undefined);
          break;
        }

        default:
          break;
      }
    },
    [activePair],
  );

  const { status, send } = useWebSocket(WS_URL, handleMessage);

  // ── Strategy control handlers ─────────────────────────────────────
  async function handleStrategyStart(name: string) {
    await fetch(`/api/strategies/${encodeURIComponent(name)}/start`, { method: 'POST' });
    const res = await fetch('/api/strategies');
    if (res.ok) setStrategies((await res.json()) as StrategyInfo[]);
  }

  async function handleStrategyStop(name: string) {
    await fetch(`/api/strategies/${encodeURIComponent(name)}/stop`, { method: 'POST' });
    const res = await fetch('/api/strategies');
    if (res.ok) setStrategies((await res.json()) as StrategyInfo[]);
  }

  // ── Equity chart data ─────────────────────────────────────────────
  const equityLineData = equity.map((p) => ({
    time: Math.floor(p.timestamp / 1000) as Time,
    value: parseFloat(p.equity),
  }));

  // Risk config derived from riskStatus thresholds
  const riskConfig = {
    maxDrawdown: riskStatus.thresholds.maxDrawdownPct ?? 20,
    maxExposure: riskStatus.thresholds.maxExposurePct ?? 80,
  };

  // ── Render ────────────────────────────────────────────────────────
  return (
    <>
      <Header status={status} isMuted={isMuted} onMuteToggle={() => setIsMuted((m) => !m)} />

      <CircuitBreakerBanner
        isActive={cbBannerActive}
        message={cbBannerMessage}
        triggeredAt={cbTriggeredAt}
        isMuted={isMuted}
        onDismiss={() => setCbBannerActive(false)}
      />

      <div className="dashboard-grid">
        {/* Left column: charts */}
        <div className="dashboard-left">
          <div className="panel">
            <div className="panel-title">Price Chart</div>
            <PriceChart
              ref={priceChartRef}
              initialData={[]}
              pair={activePair}
              onPairChange={setActivePair}
            />
          </div>

          <div className="panel">
            <div className="panel-title">Equity Curve</div>
            <EquityCurve ref={equityCurveRef} data={equityLineData} />
          </div>
        </div>

        {/* Right column: positions + risk + strategies */}
        <div className="dashboard-right">
          <div className="panel">
            <div className="panel-title">Open Positions</div>
            <PositionsTable positions={positions} />
          </div>

          <RiskPanel
            riskStatus={riskStatus}
            riskConfig={riskConfig}
            circuitBreakerEvents={circuitBreakerEvents}
          />

          <StrategyControls
            strategies={strategies}
            onStart={handleStrategyStart}
            onStop={handleStrategyStop}
          />

          <div className="panel">
            <div className="panel-title">Sessions</div>
            {sessions.length === 0 ? (
              <div className="empty-state">No active sessions</div>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Strategy</th>
                    <th>Pair</th>
                    <th>Mode</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((s) => (
                    <tr key={s.id}>
                      <td>{s.strategyName}</td>
                      <td>{s.pair}</td>
                      <td>{s.mode}</td>
                      <td className={s.status === 'running' ? 'text-green' : 'text-muted'}>
                        {s.status}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      {/* Bottom: trade history */}
      <div className="dashboard-bottom">
        <div className="panel">
          <div className="panel-title">Trade History</div>
          <TradeHistory trades={trades} />
        </div>
      </div>

      {/* Backtest Viewer */}
      <div className="dashboard-bottom">
        <div className="panel">
          <div className="panel-title">Backtest Viewer</div>
          <BacktestViewer />
        </div>
      </div>

      {/* Hidden send reference to avoid unused variable warning */}
      <div style={{ display: 'none' }} data-send={String(!!send)} />
    </>
  );
}

export default App;
