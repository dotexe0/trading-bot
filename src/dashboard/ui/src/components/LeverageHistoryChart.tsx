import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import {
  createChart,
  AreaSeries,
  type IChartApi,
  type ISeriesApi,
  type AreaData,
  type Time,
} from 'lightweight-charts';

export interface LeverageHistoryChartHandle {
  addPoint: (point: AreaData) => void;
}

interface LeverageHistoryChartProps {
  data: AreaData[];
}

const CHART_HEIGHT = 200;

/**
 * Leverage utilization over time using Lightweight Charts v5 AreaSeries.
 *
 * DASH-03: Driven by perpExposureUpdate events in App.tsx (utilizationPct).
 * On position close, App.tsx pushes an explicit zero-point at (lastTimestamp + 1s)
 * to guarantee monotonic ordering (research Pitfall 3).
 * Client-side only — no server ring buffer; chart shows empty on reconnect.
 */
export const LeverageHistoryChart = forwardRef<LeverageHistoryChartHandle, LeverageHistoryChartProps>(
  function LeverageHistoryChart({ data }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef<IChartApi | null>(null);
    const seriesRef = useRef<ISeriesApi<'Area'> | null>(null);

    useImperativeHandle(ref, () => ({
      addPoint(point: AreaData) {
        seriesRef.current?.update(point);
      },
    }));

    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;

      const chart = createChart(container, {
        width: container.clientWidth,
        height: CHART_HEIGHT,
        layout: { background: { color: '#1a1a2e' }, textColor: '#d1d5db' },
        grid: { vertLines: { color: '#2a2a3e' }, horzLines: { color: '#2a2a3e' } },
        crosshair: { vertLine: { color: '#4a4a6e' }, horzLine: { color: '#4a4a6e' } },
        rightPriceScale: { borderColor: '#2a2a3e' },
        timeScale: { borderColor: '#2a2a3e', timeVisible: true },
      });
      chartRef.current = chart;

      const series = chart.addSeries(AreaSeries, {
        lineColor: '#8b5cf6',
        topColor: 'rgba(139, 92, 246, 0.4)',
        bottomColor: 'rgba(139, 92, 246, 0)',
        lineWidth: 2,
      });
      seriesRef.current = series;

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
      };
    }, []);

    useEffect(() => {
      if (seriesRef.current && data.length > 0) {
        seriesRef.current.setData(data);
        chartRef.current?.timeScale().fitContent();
      }
    }, [data]);

    return <div ref={containerRef} className="chart-container" />;
  },
);
