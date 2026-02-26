import React, { useEffect, useRef, useState } from 'react';
import {
  createChart,
  createSeriesMarkers,
  CandlestickSeries,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type Time,
} from 'lightweight-charts';

// ── Types ────────────────────────────────────────────────────────────

interface BacktestMeta {
  id: string;
  strategyName: string;
  pair: string;
  timeframe: string;
  tradeCount: number;
  finalEquity: string;
  totalFees: string;
  startTimestamp: number;
  endTimestamp: number;
  createdAt: number;
}

interface LwcCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface BacktestTrade {
  entryTimestamp: number;
  entryPrice: string;
  exitTimestamp: number;
  exitPrice: string;
  pnl: string;
  pnlPct: string;
  entrySide: string;
  exitSide: string;
  signal: string;
}

interface SeriesMarker {
  time: Time;
  position: 'aboveBar' | 'belowBar';
  color: string;
  shape: 'arrowUp' | 'arrowDown';
  text: string;
}

// ── Helpers ──────────────────────────────────────────────────────────

function buildMarkers(trades: BacktestTrade[]): SeriesMarker[] {
  const result: SeriesMarker[] = [];

  for (const trade of trades) {
    // Entry marker: green arrow below bar
    result.push({
      time: Math.floor(trade.entryTimestamp / 1000) as Time,
      position: 'belowBar',
      color: '#22c55e',
      shape: 'arrowUp',
      text: 'Entry',
    });

    // Exit marker: color-coded by P&L above bar
    if (trade.exitTimestamp) {
      const pnlValue = Number(trade.pnl ?? 0);
      result.push({
        time: Math.floor(trade.exitTimestamp / 1000) as Time,
        position: 'aboveBar',
        color: pnlValue >= 0 ? '#22c55e' : '#ef4444',
        shape: 'arrowDown',
        text: 'Exit',
      });
    }
  }

  // CRITICAL: sort ascending by time before returning
  result.sort((a, b) => (a.time as number) - (b.time as number));

  return result;
}

// ── BacktestViewer Component ─────────────────────────────────────────

const CHART_HEIGHT = 400;

export function BacktestViewer(): React.ReactElement {
  const [backtests, setBacktests] = useState<BacktestMeta[]>([]);
  const [selectedId, setSelectedId] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Chart refs -- stored in useRef, never useState (zero re-renders)
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const markersPluginRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);

  // Fetch list of backtests on mount
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/backtests');
        if (res.ok) {
          const data = (await res.json()) as BacktestMeta[];
          setBacktests(data);
        }
      } catch {
        // API not available -- show empty state
      }
    })();
  }, []);

  // Create chart on mount, destroy on unmount
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      width: container.clientWidth,
      height: CHART_HEIGHT,
      layout: {
        background: { color: '#1a1a2e' },
        textColor: '#d1d5db',
      },
      grid: {
        vertLines: { color: '#2a2a3e' },
        horzLines: { color: '#2a2a3e' },
      },
      crosshair: {
        vertLine: { color: '#4a4a6e' },
        horzLine: { color: '#4a4a6e' },
      },
      rightPriceScale: {
        borderColor: '#2a2a3e',
      },
      timeScale: {
        borderColor: '#2a2a3e',
        timeVisible: true,
        secondsVisible: false,
      },
    });

    chartRef.current = chart;

    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#22c55e',
      downColor: '#ef4444',
      borderVisible: false,
      wickUpColor: '#22c55e',
      wickDownColor: '#ef4444',
    });

    seriesRef.current = series;

    // CRITICAL: call createSeriesMarkers IMMEDIATELY after addSeries
    markersPluginRef.current = createSeriesMarkers(series, []);

    // ResizeObserver for responsive width
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry && chartRef.current) {
        chartRef.current.applyOptions({ width: entry.contentRect.width });
      }
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      markersPluginRef.current = null;
    };
  }, []); // Chart created once on mount

  // Fetch and render candles+trades when a backtest is selected
  useEffect(() => {
    if (!selectedId) return;

    setLoading(true);
    setError(null);

    void (async () => {
      try {
        const [candlesRes, tradesRes] = await Promise.all([
          fetch(`/api/backtests/${selectedId}/candles`),
          fetch(`/api/backtests/${selectedId}/trades`),
        ]);

        if (!candlesRes.ok || !tradesRes.ok) {
          setError('Failed to load backtest data');
          setLoading(false);
          return;
        }

        const candleData = (await candlesRes.json()) as LwcCandle[];
        const tradeData = (await tradesRes.json()) as BacktestTrade[];

        // Update chart imperatively -- no re-renders
        if (seriesRef.current) {
          seriesRef.current.setData(
            candleData.map((c) => ({
              time: c.time as Time,
              open: c.open,
              high: c.high,
              low: c.low,
              close: c.close,
            })),
          );
        }

        if (markersPluginRef.current) {
          markersPluginRef.current.setMarkers(buildMarkers(tradeData));
        }

        chartRef.current?.timeScale().fitContent();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load backtest data');
      } finally {
        setLoading(false);
      }
    })();
  }, [selectedId]);

  // ── Render ──────────────────────────────────────────────────────────

  return (
    <div>
      {/* Backtest selector */}
      <div style={{ marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '12px' }}>
        <select
          value={selectedId}
          onChange={(e) => setSelectedId(e.target.value)}
          style={{
            background: '#16213e',
            color: '#d1d5db',
            border: '1px solid #2a2a3e',
            borderRadius: '4px',
            padding: '6px 10px',
            minWidth: '320px',
          }}
        >
          <option value="">Select a backtest to view</option>
          {backtests.map((bt) => (
            <option key={bt.id} value={bt.id}>
              {bt.strategyName} {bt.pair} {bt.timeframe} &mdash; {bt.tradeCount} trades
            </option>
          ))}
        </select>

        {loading && (
          <span style={{ color: '#8b5cf6', fontSize: '0.85rem' }}>Loading...</span>
        )}
        {error && (
          <span style={{ color: '#ef4444', fontSize: '0.85rem' }}>{error}</span>
        )}
      </div>

      {/* Chart container */}
      {!selectedId && (
        <div
          className="empty-state"
          style={{ height: `${CHART_HEIGHT}px`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          Select a backtest to view
        </div>
      )}

      <div
        ref={containerRef}
        className="chart-container"
        style={{ display: selectedId ? 'block' : 'none' }}
      />
    </div>
  );
}
