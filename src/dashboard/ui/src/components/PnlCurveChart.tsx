import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import {
  createChart,
  BaselineSeries,
  type IChartApi,
  type ISeriesApi,
  type BaselineData,
  type Time,
} from 'lightweight-charts';

export interface PnlCurveChartHandle {
  addPoint: (point: BaselineData) => void;
}

interface PnlCurveChartProps {
  data: BaselineData[];
}

const CHART_HEIGHT = 200;

/**
 * Per-position P&L curve using Lightweight Charts v5 BaselineSeries.
 *
 * DASH-02: BaselineSeries centered at zero; values above zero render green
 * (profit), values below zero render red (loss). Updates at most 1/minute
 * (throttled server-side). Hydrated from server ring buffer on WS connect.
 *
 * baseValue must be { type: 'price', price: 0 } — type discriminant required
 * by BaseValuePrice (research Pitfall 6).
 */
export const PnlCurveChart = forwardRef<PnlCurveChartHandle, PnlCurveChartProps>(
  function PnlCurveChart({ data }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef<IChartApi | null>(null);
    const seriesRef = useRef<ISeriesApi<'Baseline'> | null>(null);

    useImperativeHandle(ref, () => ({
      addPoint(point: BaselineData) {
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

      const series = chart.addSeries(BaselineSeries, {
        baseValue: { type: 'price', price: 0 },
        topFillColor1: 'rgba(38, 166, 154, 0.28)',
        topFillColor2: 'rgba(38, 166, 154, 0.05)',
        topLineColor: 'rgba(38, 166, 154, 1)',
        bottomFillColor1: 'rgba(239, 83, 80, 0.05)',
        bottomFillColor2: 'rgba(239, 83, 80, 0.28)',
        bottomLineColor: 'rgba(239, 83, 80, 1)',
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
