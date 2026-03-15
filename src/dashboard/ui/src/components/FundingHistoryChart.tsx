import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import {
  createChart,
  HistogramSeries,
  type IChartApi,
  type ISeriesApi,
  type HistogramData,
  type Time,
} from 'lightweight-charts';

export interface FundingHistoryChartHandle {
  addBar: (point: HistogramData) => void;
}

interface FundingHistoryChartProps {
  data: HistogramData[];
}

const CHART_HEIGHT = 200;

/**
 * Funding rate history histogram using Lightweight Charts v5 HistogramSeries.
 *
 * DASH-01: Each bar represents one FCM fundingRate event. Color is per-bar:
 * green (#22c55e) for negative rate (longs paid), red (#ef4444) for positive.
 *
 * FCM limitation: isFinal is always false in IntxClient; all non-stale events
 * are shown. The histogram will display every funding poll, not just 8h settlements.
 *
 * Follows forwardRef + useImperativeHandle + useRef pattern (no series in useState).
 */
export const FundingHistoryChart = forwardRef<FundingHistoryChartHandle, FundingHistoryChartProps>(
  function FundingHistoryChart({ data }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef<IChartApi | null>(null);
    const seriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);

    useImperativeHandle(ref, () => ({
      addBar(point: HistogramData) {
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

      const series = chart.addSeries(HistogramSeries, {
        color: '#22c55e', // default; overridden per-bar via HistogramData.color
        base: 0,
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
