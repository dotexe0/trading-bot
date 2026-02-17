import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import {
  createChart,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type Time,
} from 'lightweight-charts';

export interface EquityCurveHandle {
  update: (point: LineData) => void;
}

interface EquityCurveProps {
  data: Array<{ time: Time; value: number }>;
}

const CHART_HEIGHT = 250;

/**
 * Portfolio equity curve using Lightweight Charts v5 LineSeries.
 *
 * Uses forwardRef + useImperativeHandle for real-time equity pushes.
 * Per research pitfall #3: chart and series in useRef, never useState.
 */
export const EquityCurve = forwardRef<EquityCurveHandle, EquityCurveProps>(
  function EquityCurve({ data }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef<IChartApi | null>(null);
    const seriesRef = useRef<ISeriesApi<'Line'> | null>(null);

    // Expose imperative update
    useImperativeHandle(ref, () => ({
      update(point: LineData) {
        seriesRef.current?.update(point);
      },
    }));

    // Create chart on mount
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
        },
      });

      chartRef.current = chart;

      const series = chart.addSeries(LineSeries, {
        color: '#8b5cf6',
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

    // Update series when data prop changes
    useEffect(() => {
      if (seriesRef.current && data.length > 0) {
        seriesRef.current.setData(data as LineData[]);
        chartRef.current?.timeScale().fitContent();
      }
    }, [data]);

    return <div ref={containerRef} className="chart-container" />;
  },
);
