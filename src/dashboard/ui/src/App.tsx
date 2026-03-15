import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Header } from './components/Header.js';
import { PriceChart } from './components/PriceChart.js';
import { EquityCurve } from './components/EquityCurve.js';
import { PositionsTable } from './components/PositionsTable.js';
import { TradeHistory } from './components/TradeHistory.js';
import { StrategyControls } from './components/StrategyControls.js';
import { StrategyConfigEditor } from './components/StrategyConfigEditor.js';
import { PortfolioHeatMap } from './components/PortfolioHeatMap.js';
import { RiskPanel } from './components/RiskPanel.js';
import { PerformancePanel } from './components/PerformancePanel.js';
import { CircuitBreakerBanner } from './components/CircuitBreakerBanner.js';
import { PerpPositionsPanel } from './components/PerpPositionsPanel.js';
import { PerpFundingPanel } from './components/PerpFundingPanel.js';
import { PerpLeverageMeter } from './components/PerpLeverageMeter.js';
import { FundingHistoryChart } from './components/FundingHistoryChart.js';
import { PnlCurveChart } from './components/PnlCurveChart.js';
import { LeverageHistoryChart } from './components/LeverageHistoryChart.js';
import { useWebSocket } from './hooks/useWebSocket.js';
import { BacktestViewer } from './components/BacktestViewer.js';
import { PortfolioStats } from './components/PortfolioStats.js';
import type {
  CircuitBreakerEvent,
  EquityPoint,
  EquityUpdatePayload,
  PerpExposurePayload,
  PerpFundingPayload,
  PerpFundingBarPayload,
  PerpPnlPointPayload,
  PerpPositionPayload,
  PositionData,
  PriceTickPayload,
  RiskStatus,
  SessionData,
  SnapshotPayload,
  StrategyInfo,
  TradeData,
} from './types.js';
import type { CandlestickData, HistogramData, BaselineData, AreaData, Time } from 'lightweight-charts';
import type { PriceChartHandle } from './components/PriceChart.js';
import type { EquityCurveHandle } from './components/EquityCurve.js';
import type { FundingHistoryChartHandle } from './components/FundingHistoryChart.js';
import type { PnlCurveChartHandle } from './components/PnlCurveChart.js';
import type { LeverageHistoryChartHandle } from './components/LeverageHistoryChart.js';

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
  const [chartData, setChartData] = useState<CandlestickData[]>([]);
  const [equityVersion, setEquityVersion] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  const [perpPositions, setPerpPositions] = useState<PerpPositionPayload[]>([]);
  const [perpFunding, setPerpFunding] = useState<Record<string, PerpFundingPayload>>({});
  const [perpExposure, setPerpExposure] = useState<PerpExposurePayload>({
    totalNotionalUsd: '0.00',
    exposureCapUsd: '0.00',
    utilizationPct: '0.00',
  });
  const [fundingData, setFundingData] = useState<HistogramData[]>([]);
  const [pnlData, setPnlData] = useState<BaselineData[]>([]);

  // ── Chart refs for imperative updates ────────────────────────────
  const priceChartRef = useRef<PriceChartHandle>(null);
  const equityCurveRef = useRef<EquityCurveHandle>(null);
  const fundingHistoryRef = useRef<FundingHistoryChartHandle>(null);
  const pnlCurveRef = useRef<PnlCurveChartHandle>(null);
  const leverageHistoryRef = useRef<LeverageHistoryChartHandle>(null);

  // ── Per-pair candle buffers (no re-render on tick) ────────────────
  const candleBuffers = useRef<Record<'BTC-USD' | 'ETH-USD', CandlestickData[]>>({
    'BTC-USD': [],
    'ETH-USD': [],
  });

  // ── Client-side ring buffers for DASH-01 and DASH-02 ─────────────
  const fundingBarsRef = useRef<HistogramData[]>([]);
  const pnlPointsRef = useRef<BaselineData[]>([]);
  const MAX_PNL_POINTS = 1440;
  // Track last leverage timestamp for monotonic zero-point (DASH-03 Pitfall 3)
  const lastLeverageSecondRef = useRef<number>(0);

  // ── Fetch initial candle history for both pairs ───────────────────
  useEffect(() => {
    void (async () => {
      for (const pair of ['BTC-USD', 'ETH-USD'] as const) {
        try {
          const res = await fetch(`/api/candles?pair=${pair}&timeframe=1h&limit=500`);
          if (res.ok) {
            const data = (await res.json()) as CandlestickData[];
            candleBuffers.current[pair] = data;
          }
        } catch { /* API not ready yet */ }
      }
      // Seed chart with the active pair's history
      setChartData([...candleBuffers.current[activePair]]);
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // run once on mount

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

        // Fetch open perp positions for initial hydration
        try {
          const perpPosRes = await fetch('/api/perp/positions');
          if (perpPosRes.ok) {
            const perpPosData = (await perpPosRes.json()) as PerpPositionPayload[];
            setPerpPositions(perpPosData);
          }
        } catch { /* API not ready */ }

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
          const candle: CandlestickData = {
            time: Math.floor(tick.timestamp / 1000) as Time,
            open: parseFloat(tick.open),
            high: parseFloat(tick.high),
            low: parseFloat(tick.low),
            close: parseFloat(tick.close),
          };
          // Buffer for every pair regardless of which is active
          const pair = tick.pair as 'BTC-USD' | 'ETH-USD';
          if (pair in candleBuffers.current) {
            const buf = candleBuffers.current[pair];
            const last = buf[buf.length - 1];
            if (last && last.time === candle.time) {
              buf[buf.length - 1] = candle; // update in-progress candle
            } else {
              buf.push(candle);
              if (buf.length > 500) buf.shift(); // cap at 500 candles
            }
          }
          // Push to chart only for the active pair
          if (priceChartRef.current && tick.pair === activePair) {
            priceChartRef.current.update(candle);
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
          setEquityVersion((v) => v + 1); // trigger PortfolioStats refresh
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
          // Refresh positions after an order event
          void fetch('/api/positions')
            .then((r) => r.json())
            .then((data) => setPositions(data as PositionData[]))
            .catch(() => undefined);
          // Always fetch fresh sessions before fetching trades — never rely on
          // stale React state here. The sessions state may not yet reflect the
          // running paper session if orderFilled fires before the engineStarted
          // /api/sessions fetch has resolved and React has re-rendered.
          void fetch('/api/sessions')
            .then((r) => r.json())
            .then((sessData) => {
              const updatedSessions = sessData as SessionData[];
              setSessions(updatedSessions);
              const active = updatedSessions.find((s) => s.status === 'running');
              if (active) {
                return fetch(`/api/sessions/${active.id}/trades`);
              }
              return null;
            })
            .then((r) => (r ? r.json() : null))
            .then((data) => { if (data) setTrades(data as TradeData[]); })
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
          // DASH-01: hydrate funding history from ring buffer snapshot
          if (snap.perpFundingHistory && snap.perpFundingHistory.length > 0) {
            fundingBarsRef.current = snap.perpFundingHistory.map((b) => ({
              time: b.time as Time,
              value: b.value,
              color: b.color,
            }));
            // setData handled by chart's data prop — trigger re-render via state
            setFundingData([...fundingBarsRef.current]);
          }
          // DASH-02: hydrate P&L history from ring buffer snapshot
          if (snap.perpPnlHistory && snap.perpPnlHistory.length > 0) {
            pnlPointsRef.current = snap.perpPnlHistory.map((p) => ({
              time: p.time as Time,
              value: p.value,
            }));
            setPnlData([...pnlPointsRef.current]);
          }
          break;
        }

        case 'engineStarted': {
          // Refresh strategies list and sessions (new session may have been created)
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

        case 'perpPositionUpdate': {
          const pos = payload as PerpPositionPayload;
          setPerpPositions((prev) => {
            const filtered = prev.filter((p) => p.id !== pos.id);
            // Only keep open positions in the panel (closed/emergency_closed fall off)
            if (pos.status === 'open') {
              return [...filtered, pos];
            }
            return filtered;
          });
          break;
        }

        case 'perpFundingUpdate': {
          const funding = payload as PerpFundingPayload;
          // fundingRates map is keyed by FCM product ID (funding.instrument field)
          setPerpFunding((prev) => ({ ...prev, [funding.instrument]: funding }));
          break;
        }

        case 'perpFundingHistory': {
          const bar = payload as PerpFundingBarPayload;
          const histBar: HistogramData = {
            time: bar.time as Time,
            value: bar.value,
            color: bar.color,
          };
          fundingBarsRef.current.push(histBar);
          fundingHistoryRef.current?.addBar(histBar);
          break;
        }

        case 'perpPnlUpdate': {
          const pnlPayload = payload as PerpPnlPointPayload;
          const pnlPoint: BaselineData = {
            time: pnlPayload.time as Time,
            value: pnlPayload.value,
          };
          pnlPointsRef.current.push(pnlPoint);
          if (pnlPointsRef.current.length > MAX_PNL_POINTS) pnlPointsRef.current.shift();
          pnlCurveRef.current?.addPoint(pnlPoint);
          break;
        }

        case 'perpExposureUpdate': {
          const exposure = payload as PerpExposurePayload;
          setPerpExposure(exposure);
          // DASH-03: push to leverage history chart (client-side time series)
          const nowSec = Math.floor(Date.now() / 1000);
          const pointTime = nowSec > lastLeverageSecondRef.current
            ? nowSec
            : lastLeverageSecondRef.current + 1;
          lastLeverageSecondRef.current = pointTime;
          const utilizationVal = parseFloat(exposure.utilizationPct);
          leverageHistoryRef.current?.addPoint({ time: pointTime as Time, value: utilizationVal } as AreaData);
          // DASH-02: clear P&L ring buffer when position closes
          if (exposure.utilizationPct === '0.00') {
            pnlPointsRef.current = [];
            setPnlData([]);
          }
          break;
        }

        default:
          break;
      }
    },
    [activePair, sessions],
  );

  const { status, send } = useWebSocket(WS_URL, handleMessage);

  // ── Pair switch: load buffered candles for the new pair ──────────
  function handlePairChange(pair: 'BTC-USD' | 'ETH-USD') {
    setActivePair(pair);
    setChartData([...candleBuffers.current[pair]]);
  }

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

      <PortfolioStats
        mode={sessions.find((s) => s.status === 'running')?.mode ?? 'paper'}
        refreshToken={equityVersion}
      />

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
              initialData={chartData}
              pair={activePair}
              onPairChange={handlePairChange}
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

          <PerformancePanel trades={trades} />

          <div className="panel">
            <div className="panel-title">Perp Positions</div>
            <PerpPositionsPanel positions={perpPositions} />
          </div>

          <div className="panel">
            <div className="panel-title">Perp Funding Rates</div>
            <PerpFundingPanel fundingRates={perpFunding} />
          </div>

          <div className="panel">
            <div className="panel-title">Perp Leverage Utilization</div>
            <PerpLeverageMeter exposure={perpExposure} />
          </div>

          <div className="panel">
            <div className="panel-title">Funding Rate History</div>
            <FundingHistoryChart ref={fundingHistoryRef} data={fundingData} />
          </div>

          <div className="panel">
            <div className="panel-title">P&L Curve</div>
            <PnlCurveChart ref={pnlCurveRef} data={pnlData} />
          </div>

          <div className="panel">
            <div className="panel-title">Leverage Utilization History</div>
            <LeverageHistoryChart ref={leverageHistoryRef} data={[]} />
          </div>

          <div className="panel">
            <div className="panel-title">Portfolio Heat Map</div>
            <PortfolioHeatMap />
          </div>

          <StrategyControls
            strategies={strategies}
            onStart={handleStrategyStart}
            onStop={handleStrategyStop}
          />

          <div className="panel">
            <div className="panel-title">Strategy Config</div>
            <StrategyConfigEditor strategies={strategies} />
          </div>

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
