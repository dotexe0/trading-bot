import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Header } from './components/Header.js';
import { PriceChart } from './components/PriceChart.js';
import { EquityCurve } from './components/EquityCurve.js';
import { PositionsTable } from './components/PositionsTable.js';
import { TradeHistory } from './components/TradeHistory.js';
import { StrategiesPanel } from './components/StrategiesPanel.js';
import { PerpStrategiesPanel } from './components/PerpStrategiesPanel.js';
import { StrategyConfigEditor } from './components/StrategyConfigEditor.js';
import { PortfolioHeatMap } from './components/PortfolioHeatMap.js';
import { RiskPanel } from './components/RiskPanel.js';
import { CircuitBreakerBanner } from './components/CircuitBreakerBanner.js';
import { PerpPositionsPanel } from './components/PerpPositionsPanel.js';
import { PerpFundingPanel } from './components/PerpFundingPanel.js';
import { PerpLeverageMeter } from './components/PerpLeverageMeter.js';
import { FundingHistoryChart } from './components/FundingHistoryChart.js';
import { PnlCurveChart } from './components/PnlCurveChart.js';
import { LeverageHistoryChart } from './components/LeverageHistoryChart.js';
import { FeedHealthPanel } from './components/FeedHealthPanel.js';
import { SystemHealthPanel } from './components/SystemHealthPanel.js';
import { LiveReadinessPanel } from './components/LiveReadinessPanel.js';
import { useWebSocket } from './hooks/useWebSocket.js';
import { BacktestViewer } from './components/BacktestViewer.js';
import { PortfolioStats } from './components/PortfolioStats.js';
import { CrossAssetSignalPanel } from './components/CrossAssetSignalPanel.js';
import type {
  CircuitBreakerEvent,
  EquityPoint,
  EquityUpdatePayload,
  FeedHealthPayload,
  GateStatusData,
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
  SystemHealthPayload,
  TradeData,
  TournamentLeaderboard,
  PerpTournamentLeaderboard,
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
  const [perpPositionUpdatedAt, setPerpPositionUpdatedAt] = useState<number | undefined>(undefined);
  const [perpFundingUpdatedAt, setPerpFundingUpdatedAt] = useState<number | undefined>(undefined);
  const [perpExposureUpdatedAt, setPerpExposureUpdatedAt] = useState<number | undefined>(undefined);
  const [gateStatus, setGateStatus] = useState<GateStatusData | null>(null);
  const [isResetting, setIsResetting] = useState(false);
  const [feedHealthData, setFeedHealthData] = useState<FeedHealthPayload[]>([]);
  const [feedHealthUpdatedAt, setFeedHealthUpdatedAt] = useState<number | undefined>(undefined);
  const [systemHealth, setSystemHealth] = useState<SystemHealthPayload | null>(null);
  const [tournament, setTournament] = useState<TournamentLeaderboard | null>(null);
  const [availableStrategies, setAvailableStrategies] = useState<string[]>([]);
  const [perpTournament, setPerpTournament] = useState<PerpTournamentLeaderboard | null>(null);
  const [driftWarnings, setDriftWarnings] = useState<Array<{ message: string; timestamp: number }>>([]);
  const [activeSection, setActiveSection] = useState<string>('overview');

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

  // ── Tournament / available-strategy fetchers ─────────────────────
  const fetchTournament = useCallback(async () => {
    try {
      const res = await fetch('/api/tournament/latest');
      if (res.status === 204) { setTournament(null); return; }
      const data = await res.json() as TournamentLeaderboard;
      setTournament(data);
    } catch { /* non-fatal */ }
  }, []);

  const fetchPerpTournament = useCallback(async () => {
    try {
      const res = await fetch('/api/perp/tournament/latest');
      if (res.status === 204) { setPerpTournament(null); return; }
      const data = await res.json() as PerpTournamentLeaderboard;
      setPerpTournament(data);
    } catch { /* non-fatal */ }
  }, []);

  const fetchAvailableStrategies = useCallback(async () => {
    try {
      const res = await fetch('/api/strategies/available');
      if (!res.ok) return;
      const data = await res.json() as { strategies: string[] };
      setAvailableStrategies(data.strategies);
    } catch { /* non-fatal */ }
  }, []);

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

          // Use the first running or most recent session for equity curve
          const active =
            sessData.find((s) => s.status === 'running') ?? sessData[0];

          if (active) {
            // Fetch equity for active session
            const eqRes = await fetch(`/api/sessions/${active.id}/equity`);
            if (eqRes.ok) {
              const eqData = (await eqRes.json()) as EquityPoint[];
              setEquity(eqData);
            }
          }

          // Fetch trades from ALL running sessions + perp trades
          const runningSessions = sessData.filter((s) => s.status === 'running');
          const sessionTradePromises = runningSessions.map((s) =>
            fetch(`/api/sessions/${s.id}/trades`)
              .then((r) => (r.ok ? r.json() as Promise<TradeData[]> : []))
              .then((trades) => trades.map((t) => ({ ...t, mode: t.mode ?? 'spot' as const })))
              .catch(() => [] as TradeData[]),
          );
          const perpTradePromise = fetch('/api/perp/trades')
            .then((r) => (r.ok ? r.json() as Promise<TradeData[]> : []))
            .catch(() => [] as TradeData[]);
          const allTradeArrays = await Promise.all([...sessionTradePromises, perpTradePromise]);
          const allTrades = allTradeArrays.flat().sort((a, b) => b.entryTimestamp - a.entryTimestamp);
          setTrades(allTrades);
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
            if (perpPosData.length > 0) setPerpPositionUpdatedAt(Date.now());
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

        // Fetch gate status for Live Readiness panel
        try {
          const gateRes = await fetch('/api/gate/status');
          if (gateRes.ok) {
            const gateData = (await gateRes.json()) as GateStatusData;
            setGateStatus(gateData);
          }
        } catch { /* API not ready */ }

        void fetchTournament();
        void fetchPerpTournament();
        void fetchAvailableStrategies();
      } catch {
        // API not available yet — dashboard shows empty state
      }
    })();
  }, [fetchTournament, fetchPerpTournament, fetchAvailableStrategies]);

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
          // Fetch trades from ALL running sessions + perp trades
          void fetch('/api/sessions')
            .then((r) => r.json())
            .then(async (sessData) => {
              const updatedSessions = sessData as SessionData[];
              setSessions(updatedSessions);
              const running = updatedSessions.filter((s) => s.status === 'running');
              const sessionTradeArrays = await Promise.all(
                running.map((s) =>
                  fetch(`/api/sessions/${s.id}/trades`)
                    .then((r) => (r.ok ? r.json() as Promise<TradeData[]> : []))
                    .then((trades) => trades.map((t) => ({ ...t, mode: t.mode ?? 'spot' as const })))
                    .catch(() => [] as TradeData[]),
                ),
              );
              const perpTrades = await fetch('/api/perp/trades')
                .then((r) => (r.ok ? r.json() as Promise<TradeData[]> : []))
                .catch(() => [] as TradeData[]);
              const all = [...sessionTradeArrays.flat(), ...perpTrades]
                .sort((a, b) => b.entryTimestamp - a.entryTimestamp);
              setTrades(all);
            })
            .catch(() => undefined);
          // Also refresh gate status when trades update
          void fetch('/api/gate/status')
            .then(r => r.json())
            .then(data => setGateStatus(data as GateStatusData))
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
          // Feed health: hydrate from snapshot
          if (snap.feedHealth && snap.feedHealth.length > 0) {
            setFeedHealthData(snap.feedHealth);
            setFeedHealthUpdatedAt(Date.now());
          }
          // System health: hydrate from snapshot
          if (snap.systemHealth) {
            setSystemHealth(snap.systemHealth);
          }
          // Perp funding rates: hydrate from snapshot (server caches last known rate per instrument)
          if (snap.perpFundingRates && snap.perpFundingRates.length > 0) {
            const rateMap: Record<string, PerpFundingPayload> = {};
            for (const rate of snap.perpFundingRates) {
              rateMap[rate.instrument] = rate;
            }
            setPerpFunding(rateMap);
            setPerpFundingUpdatedAt(Date.now());
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
          void fetchTournament();
          break;
        }

        case 'engineStopped': {
          // Refresh strategies list
          void fetch('/api/strategies')
            .then((r) => r.json())
            .then((data) => setStrategies(data as StrategyInfo[]))
            .catch(() => undefined);
          void fetchTournament();
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
          setPerpPositionUpdatedAt(Date.now());
          break;
        }

        case 'perpFundingUpdate': {
          const funding = payload as PerpFundingPayload;
          // fundingRates map is keyed by FCM product ID (funding.instrument field)
          setPerpFunding((prev) => ({ ...prev, [funding.instrument]: funding }));
          setPerpFundingUpdatedAt(Date.now());
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
          setPerpExposureUpdatedAt(Date.now());
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

        case 'perpMarkPriceUpdate': {
          const update = payload as { id: string; markPrice: string; unrealizedPnl: string };
          setPerpPositions((prev) =>
            prev.map((p) =>
              p.id === update.id
                ? { ...p, markPrice: update.markPrice, unrealizedPnl: update.unrealizedPnl }
                : p,
            ),
          );
          setPerpPositionUpdatedAt(Date.now());
          break;
        }

        case 'feedHealth': {
          const feed = payload as FeedHealthPayload;
          setFeedHealthData((prev) => {
            // Upsert: replace existing entry for this instrument, or add new
            const filtered = prev.filter((f) => f.instrument !== feed.instrument);
            return [...filtered, feed].sort((a, b) => a.instrument.localeCompare(b.instrument));
          });
          setFeedHealthUpdatedAt(Date.now());
          break;
        }

        case 'systemHealth': {
          setSystemHealth(payload as SystemHealthPayload);
          break;
        }

        case 'strategyDrift': {
          const d = payload as { type: string; rolling: number; baseline: number; threshold: number; strategyName: string };
          const label = d.type === 'sharpe' ? 'Sharpe' : 'Win Rate';
          const msg = `${d.strategyName}: rolling ${label} (${d.rolling.toFixed(2)}) below threshold (${d.threshold.toFixed(2)}, baseline ${d.baseline.toFixed(2)})`;
          setDriftWarnings((prev) => [{ message: msg, timestamp: Date.now() }, ...prev].slice(0, 10));
          break;
        }

        case 'strategySwitch': {
          // Clear drift warnings on strategy switch (new strategy = fresh baseline)
          setDriftWarnings([]);
          break;
        }

        default:
          break;
      }
    },
    [activePair, sessions, fetchTournament],
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
    // The leaderboard passes bare strategy names (e.g. "sma-crossover") but the
    // ActivationBridge keys include the pair (e.g. "sma-crossover:BTC-USD").
    // Resolve to the full engine key before hitting the API.
    const fullName =
      strategies.find((s) => s.name === name || s.name.startsWith(name + ':'))?.name ?? name;
    await fetch(`/api/strategies/${encodeURIComponent(fullName)}/stop`, { method: 'POST' });
    const res = await fetch('/api/strategies');
    if (res.ok) setStrategies((await res.json()) as StrategyInfo[]);
  }

  // ── Paper reset ──────────────────────────────────────────────────
  const currentMode = sessions.find((s) => s.status === 'running')?.mode ?? 'paper';

  async function handleResetPaper() {
    if (!window.confirm('Reset all paper trading history? This cannot be undone.')) return;
    setIsResetting(true);
    try {
      const res = await fetch('/api/reset-paper', { method: 'POST' });
      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        alert(err.error ?? 'Reset failed');
        return;
      }
      // Clear all local state
      setSessions([]);
      setTrades([]);
      setEquity([]);
      setPositions([]);
      setCircuitBreakerEvents([]);
      // Refresh gate status to reflect 0 trades
      const gateRes = await fetch('/api/gate/status');
      if (gateRes.ok) setGateStatus((await gateRes.json()) as GateStatusData);
    } finally {
      setIsResetting(false);
    }
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

  // ── Nav items ─────────────────────────────────────────────────────
  const navItems = [
    {
      id: 'overview',
      label: 'Overview',
      icon: (
        <svg viewBox="0 0 16 16" fill="currentColor" width="15" height="15">
          <rect x="1" y="1" width="6" height="6" rx="1" />
          <rect x="9" y="1" width="6" height="6" rx="1" />
          <rect x="1" y="9" width="6" height="6" rx="1" />
          <rect x="9" y="9" width="6" height="6" rx="1" />
        </svg>
      ),
    },
    {
      id: 'positions',
      label: 'Positions',
      icon: (
        <svg viewBox="0 0 16 16" fill="currentColor" width="15" height="15">
          <rect x="1" y="2.5" width="14" height="2" rx="1" />
          <rect x="1" y="7" width="14" height="2" rx="1" />
          <rect x="1" y="11.5" width="14" height="2" rx="1" />
        </svg>
      ),
    },
    {
      id: 'strategies',
      label: 'Strategies',
      icon: (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" width="15" height="15">
          <polyline points="1,12 5,7 9,9 15,3" />
          <polyline points="11,3 15,3 15,7" />
        </svg>
      ),
    },
    {
      id: 'analytics',
      label: 'Analytics',
      icon: (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" width="15" height="15">
          <rect x="1" y="9" width="3" height="6" rx="1" fill="currentColor" stroke="none" opacity="0.6" />
          <rect x="6" y="6" width="3" height="9" rx="1" fill="currentColor" stroke="none" opacity="0.8" />
          <rect x="11" y="2" width="3" height="13" rx="1" fill="currentColor" stroke="none" />
        </svg>
      ),
    },
    {
      id: 'system',
      label: 'System',
      icon: (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" width="15" height="15">
          <polyline points="1,8 3,8 5,3 7,13 9,5 11,10 13,8 15,8" />
        </svg>
      ),
    },
  ] as const;

  // ── Render ────────────────────────────────────────────────────────
  return (
    <>
      <Header status={status} isMuted={isMuted} onMuteToggle={() => setIsMuted((m) => !m)} />

      <div className="app-shell">
        {/* ── Sidebar ─────────────────────────────────────────── */}
        <nav className="sidebar">
          <div className="sidebar-logo">
            <div className="sidebar-logo-row">
              <div className="sidebar-logo-mark">◈</div>
              <span className="sidebar-logo-text">Signal</span>
            </div>
          </div>

          <div className="sidebar-nav">
            {navItems.map((item) => (
              <button
                key={item.id}
                className={`nav-item${activeSection === item.id ? ' active' : ''}`}
                onClick={() => setActiveSection(item.id)}
              >
                <span className="nav-icon">{item.icon}</span>
                <span className="nav-label">{item.label}</span>
                {item.id === 'system' && cbBannerActive && (
                  <span className="nav-alert" title="Circuit breaker active" />
                )}
              </button>
            ))}
          </div>
        </nav>

        {/* ── Content Area ────────────────────────────────────── */}
        <main className="content-area">
          <PortfolioStats
            mode={currentMode}
            refreshToken={equityVersion}
          />

          <CircuitBreakerBanner
            isActive={cbBannerActive}
            message={cbBannerMessage}
            triggeredAt={cbTriggeredAt}
            isMuted={isMuted}
            onDismiss={() => setCbBannerActive(false)}
          />

          <div className="content-body">

            {/* ── Overview ──────────────────────────────────────── */}
            {activeSection === 'overview' && (
              <div className="section-overview">
                <div className="section-col">
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

                <div className="section-col">
                  <div className="overview-positions-row">
                    <div className="panel">
                      <div className="panel-title">Spot Positions</div>
                      <PositionsTable positions={positions} />
                    </div>
                    <div className="panel">
                      <div className="panel-title">Perp Positions</div>
                      <PerpPositionsPanel positions={perpPositions} lastUpdatedAt={perpPositionUpdatedAt} />
                    </div>
                  </div>
                  <div className="panel">
                    <div className="panel-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span>Live Readiness</span>
                      {currentMode === 'paper' && (
                        <button
                          onClick={() => void handleResetPaper()}
                          disabled={isResetting}
                          style={{
                            fontSize: '10px',
                            padding: '2px 8px',
                            borderRadius: '4px',
                            border: '1px solid var(--border-hi)',
                            background: 'transparent',
                            color: 'var(--text-lo)',
                            cursor: isResetting ? 'not-allowed' : 'pointer',
                            fontFamily: 'var(--font)',
                          }}
                        >
                          {isResetting ? 'Resetting…' : 'Reset Paper'}
                        </button>
                      )}
                    </div>
                    <LiveReadinessPanel gateStatus={gateStatus} trades={trades} />
                  </div>
                </div>
              </div>
            )}

            {/* ── Positions ─────────────────────────────────────── */}
            {activeSection === 'positions' && (
              <div className="section-positions">
                <div className="positions-top">
                  <div className="panel">
                    <div className="panel-title">Spot Positions</div>
                    <PositionsTable positions={positions} />
                  </div>
                  <div className="panel">
                    <div className="panel-title">Perp Positions</div>
                    <PerpPositionsPanel positions={perpPositions} lastUpdatedAt={perpPositionUpdatedAt} />
                  </div>
                </div>
                <div className="panel">
                  <div className="panel-title">Trade History</div>
                  <TradeHistory trades={trades} />
                </div>
              </div>
            )}

            {/* ── Strategies ────────────────────────────────────── */}
            {activeSection === 'strategies' && (
              <div className="section-strategies">
                <div className="strategies-tournaments">
                  <StrategiesPanel
                    strategies={strategies}
                    trades={trades}
                    tournament={tournament}
                    availableStrategies={availableStrategies}
                    onStop={handleStrategyStop}
                    driftWarnings={driftWarnings}
                  />
                  <PerpStrategiesPanel tournament={perpTournament} />
                </div>
                <div className="strategies-bottom">
                  <div className="panel">
                    <div className="panel-title">Strategy Config</div>
                    <StrategyConfigEditor strategies={strategies} />
                  </div>
                  <div className="panel">
                    <div className="panel-title">Sessions</div>
                    {sessions.length === 0 && perpPositions.length === 0 ? (
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
                          {perpPositions.map((p) => (
                            <tr key={p.id}>
                              <td>
                                {perpTournament?.leaderboard?.find(
                                  (e) => !e.disqualified && e.rank === 1,
                                )?.strategyName ?? 'perp'}
                              </td>
                              <td>{p.instrument}</td>
                              <td>perp</td>
                              <td className={p.status === 'open' ? 'text-green' : 'text-muted'}>
                                {p.status === 'open' ? 'running' : p.status}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* ── Analytics ─────────────────────────────────────── */}
            {activeSection === 'analytics' && (
              <div className="section-analytics">
                <CrossAssetSignalPanel />
                <div className="analytics-row2">
                  <div className="panel">
                    <div className="panel-title">Equity Curve — Spot</div>
                    <EquityCurve ref={equityCurveRef} data={equityLineData} />
                  </div>
                  <div className="panel">
                    <div className="panel-title">P&amp;L Curve — Perp</div>
                    <PnlCurveChart ref={pnlCurveRef} data={pnlData} />
                  </div>
                </div>
                <div className="analytics-row2">
                  <div className="panel">
                    <div className="panel-title">Funding Rates</div>
                    <PerpFundingPanel fundingRates={perpFunding} lastUpdatedAt={perpFundingUpdatedAt} />
                  </div>
                  <div className="panel">
                    <div className="panel-title">Leverage Utilization</div>
                    <PerpLeverageMeter exposure={perpExposure} lastUpdatedAt={perpExposureUpdatedAt} />
                  </div>
                </div>
                <div className="analytics-row2">
                  <div className="panel">
                    <div className="panel-title">Funding Rate History</div>
                    <FundingHistoryChart ref={fundingHistoryRef} data={fundingData} />
                  </div>
                  <div className="panel">
                    <div className="panel-title">Leverage History</div>
                    <LeverageHistoryChart ref={leverageHistoryRef} data={[]} />
                  </div>
                </div>
              </div>
            )}

            {/* ── System ────────────────────────────────────────── */}
            {activeSection === 'system' && (
              <div className="section-system">
                <div className="system-row">
                  <div className="panel">
                    <FeedHealthPanel feeds={feedHealthData} lastUpdatedAt={feedHealthUpdatedAt} />
                  </div>
                  <div className="panel">
                    <SystemHealthPanel systemHealth={systemHealth} />
                  </div>
                </div>
                <div className="system-row">
                  <div className="panel">
                    <div className="panel-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span>Live Readiness</span>
                      {currentMode === 'paper' && (
                        <button
                          onClick={() => void handleResetPaper()}
                          disabled={isResetting}
                          style={{
                            fontSize: '10px',
                            padding: '2px 8px',
                            borderRadius: '4px',
                            border: '1px solid var(--border-hi)',
                            background: 'transparent',
                            color: 'var(--text-lo)',
                            cursor: isResetting ? 'not-allowed' : 'pointer',
                            fontFamily: 'var(--font)',
                          }}
                        >
                          {isResetting ? 'Resetting…' : 'Reset Paper'}
                        </button>
                      )}
                    </div>
                    <LiveReadinessPanel gateStatus={gateStatus} trades={trades} />
                  </div>
                  <RiskPanel
                    riskStatus={riskStatus}
                    riskConfig={riskConfig}
                    circuitBreakerEvents={circuitBreakerEvents}
                  />
                </div>
              </div>
            )}

          </div>
        </main>
      </div>

      {/* Hidden send reference to avoid unused variable warning */}
      <div style={{ display: 'none' }} data-send={String(!!send)} />
    </>
  );
}

export default App;
