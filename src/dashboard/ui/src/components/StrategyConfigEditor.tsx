import React, { useState } from 'react';
import type { StrategyInfo } from '../types.js';

// ── Parameter definitions (compile-time known from strategyConfigSchema) ──────

interface ParamDef {
  key: string;
  label: string;
  type: 'number' | 'boolean' | 'select';
  options?: string[];
}

const STRATEGY_PARAMS: Record<string, ParamDef[]> = {
  'sma-crossover': [
    { key: 'fastPeriod', label: 'Fast Period', type: 'number' },
    { key: 'slowPeriod', label: 'Slow Period', type: 'number' },
  ],
  'rsi-mean-reversion': [
    { key: 'period', label: 'RSI Period', type: 'number' },
    { key: 'oversoldThreshold', label: 'Oversold', type: 'number' },
    { key: 'overboughtThreshold', label: 'Overbought', type: 'number' },
  ],
  'macd-momentum': [
    { key: 'fastPeriod', label: 'Fast Period', type: 'number' },
    { key: 'slowPeriod', label: 'Slow Period', type: 'number' },
    { key: 'signalPeriod', label: 'Signal Period', type: 'number' },
  ],
  'bollinger-breakout': [
    { key: 'period', label: 'Period', type: 'number' },
    { key: 'stdDev', label: 'Std Dev', type: 'number' },
    { key: 'breakoutMode', label: 'Breakout Mode', type: 'boolean' },
  ],
  'multi-timeframe-trend': [
    { key: 'trendTimeframe', label: 'Trend TF', type: 'select', options: ['1h', '4h', '1D'] },
    { key: 'trendEmaPeriod', label: 'Trend EMA', type: 'number' },
    { key: 'entryEmaPeriod', label: 'Entry EMA', type: 'number' },
    { key: 'atrPeriod', label: 'ATR Period', type: 'number' },
  ],
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function defaultFieldsForStrategy(name: string): Record<string, string> {
  const params = STRATEGY_PARAMS[name];
  if (!params) return {};
  const fields: Record<string, string> = {};
  for (const p of params) {
    if (p.type === 'boolean') fields[p.key] = 'true';
    else if (p.type === 'select') fields[p.key] = p.options?.[0] ?? '';
    else fields[p.key] = '';
  }
  return fields;
}

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  strategies: StrategyInfo[];
}

export function StrategyConfigEditor({ strategies }: Props): React.ReactElement {
  const [selectedStrategy, setSelectedStrategy] = useState('');
  const [configFields, setConfigFields] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<'idle' | 'saving' | 'success' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState('');

  function handleStrategyChange(name: string) {
    setSelectedStrategy(name);
    setConfigFields(defaultFieldsForStrategy(name));
    setStatus('idle');
    setErrorMessage('');
  }

  function handleFieldChange(key: string, value: string) {
    setConfigFields((prev) => ({ ...prev, [key]: value }));
  }

  async function handleApply() {
    setStatus('saving');
    setErrorMessage('');

    const body: Record<string, unknown> = { strategy: selectedStrategy };
    const params = STRATEGY_PARAMS[selectedStrategy] ?? [];
    for (const [key, val] of Object.entries(configFields)) {
      const paramDef = params.find((p) => p.key === key);
      if (paramDef?.type === 'number') {
        body[key] = Number(val);
      } else if (paramDef?.type === 'boolean') {
        body[key] = val === 'true';
      } else {
        body[key] = val;
      }
    }

    try {
      const res = await fetch(`/api/strategies/${encodeURIComponent(selectedStrategy)}/config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        setStatus('success');
      } else {
        const data = (await res.json()) as { error?: string; details?: string[] };
        setErrorMessage(data.details?.join('; ') ?? data.error ?? 'Unknown error');
        setStatus('error');
      }
    } catch {
      setErrorMessage('Network error');
      setStatus('error');
    }
  }

  const runningStrategyNames = strategies.map((s) => s.name);

  if (strategies.length === 0) {
    return <div className="empty-state">No running strategies to configure</div>;
  }

  const params = selectedStrategy ? (STRATEGY_PARAMS[selectedStrategy] ?? []) : [];

  return (
    <div className="strategy-config-editor">
      <div className="form-row">
        <label htmlFor="strategy-select">Strategy</label>
        <select
          id="strategy-select"
          value={selectedStrategy}
          onChange={(e) => handleStrategyChange(e.target.value)}
        >
          <option value="">-- select strategy --</option>
          {runningStrategyNames.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </div>

      {selectedStrategy && params.length > 0 && (
        <>
          {params.map((p) => (
            <div key={p.key} className="form-row">
              <label htmlFor={`param-${p.key}`}>{p.label}</label>
              {p.type === 'select' ? (
                <select
                  id={`param-${p.key}`}
                  value={configFields[p.key] ?? ''}
                  onChange={(e) => handleFieldChange(p.key, e.target.value)}
                >
                  {(p.options ?? []).map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
              ) : p.type === 'boolean' ? (
                <select
                  id={`param-${p.key}`}
                  value={configFields[p.key] ?? 'true'}
                  onChange={(e) => handleFieldChange(p.key, e.target.value)}
                >
                  <option value="true">true</option>
                  <option value="false">false</option>
                </select>
              ) : (
                <input
                  id={`param-${p.key}`}
                  type="number"
                  value={configFields[p.key] ?? ''}
                  onChange={(e) => handleFieldChange(p.key, e.target.value)}
                  placeholder="value"
                />
              )}
            </div>
          ))}

          <div className="form-row">
            <button
              onClick={() => void handleApply()}
              disabled={status === 'saving'}
              className="btn-apply"
            >
              {status === 'saving' ? 'Applying...' : 'Apply'}
            </button>
          </div>

          {status === 'success' && (
            <div className="config-feedback config-success">Config applied successfully.</div>
          )}
          {status === 'error' && (
            <div className="config-feedback config-error">{errorMessage}</div>
          )}
        </>
      )}
    </div>
  );
}
