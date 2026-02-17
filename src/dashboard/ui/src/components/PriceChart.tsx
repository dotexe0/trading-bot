import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import {
  createChart,
  CandlestickSeries,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  type Time,
} from 'lightweight-charts';

export interface PriceChartHandle {
  update: (candle: CandlestickData) => void;
}

interface PriceChartProps {
  initialData: CandlestickData[];
  pair: 'BTC-USD' | 'ETH-USD';
  onPairChange?: (pair: 'BTC-USD' | 'ETH-USD') => void;
}

const PAIRS: Array<'BTC-USD' | 'ETH-USD'> = ['BTC-USD', 'ETH-USD'];
const CHART_HEIGHT = 350;

/**
 * Candlestick price chart using Lightweight Charts v5.
 *
 * Uses forwardRef + useImperativeHandle so parent can push real-time ticks
 * via ref.update(candle) without re-renders.
 *
 * Per research pitfall #3: chart and series stored in useRef, never useState.
 */
export const PriceChart = forwardRef<PriceChartHandle, PriceChartProps>(
  function PriceChart({ initialData, pair, onPairChange }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef<IChartApi | null>(null);
    const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);

    // Expose imperative update method
    useImperativeHandle(ref, () => ({
      update(candle: CandlestickData) {
        seriesRef.current?.update(candle);
      },
    }));

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

      if (initialData.length > 0) {
        series.setData(initialData);
        chart.timeScale().fitContent();
      }

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
      };
    }, []); // Intentionally no deps — chart created once

    // Update series when initialData changes
    useEffect(() => {
      if (seriesRef.current && initialData.length > 0) {
        seriesRef.current.setData(initialData);
        chartRef.current?.timeScale().fitContent();
      }
    }, [initialData]);

    return (
      <div>
        {onPairChange && (
          <div className="pair-tabs">
            {PAIRS.map((p) => (
              <button
                key={p}
                className={`pair-tab${pair === p ? ' active' : ''}`}
                onClick={() => onPairChange(p)}
              >
                {p}
              </button>
            ))}
          </div>
        )}
        <div ref={containerRef} className="chart-container" />
      </div>
    );
  },
);
