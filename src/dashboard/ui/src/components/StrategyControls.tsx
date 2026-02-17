/**
 * StrategyControls — Toggle switches for starting and stopping individual strategies.
 *
 * Starting a strategy is instant (no confirmation).
 * Stopping a strategy shows an inline confirmation dialog before calling onStop.
 */

import React, { useState } from 'react';
import type { StrategyInfo } from '../types.js';

interface StrategyControlsProps {
  strategies: StrategyInfo[];
  onStart: (name: string) => Promise<void>;
  onStop: (name: string) => Promise<void>;
}

interface StrategyRowState {
  pending: boolean;
  confirmingStop: boolean;
}

export function StrategyControls({ strategies, onStart, onStop }: StrategyControlsProps) {
  const [rowStates, setRowStates] = useState<Record<string, StrategyRowState>>({});

  function getRowState(name: string): StrategyRowState {
    return rowStates[name] ?? { pending: false, confirmingStop: false };
  }

  function setRowState(name: string, patch: Partial<StrategyRowState>) {
    setRowStates((prev) => ({
      ...prev,
      [name]: { ...getRowState(name), ...patch },
    }));
  }

  async function handleToggle(strategy: StrategyInfo) {
    const state = getRowState(strategy.name);
    if (state.pending) return;

    if (strategy.status === 'stopped') {
      // Starting is instant — no confirmation
      setRowState(strategy.name, { pending: true });
      try {
        await onStart(strategy.name);
      } finally {
        setRowState(strategy.name, { pending: false });
      }
    } else {
      // Stopping requires confirmation — show inline dialog
      setRowState(strategy.name, { confirmingStop: true });
    }
  }

  async function handleConfirmStop(name: string) {
    setRowState(name, { pending: true, confirmingStop: false });
    try {
      await onStop(name);
    } finally {
      setRowState(name, { pending: false, confirmingStop: false });
    }
  }

  function handleCancelStop(name: string) {
    setRowState(name, { confirmingStop: false });
  }

  if (strategies.length === 0) {
    return (
      <div className="panel">
        <div className="panel-title">Strategy Controls</div>
        <div className="empty-state">No active strategies</div>
      </div>
    );
  }

  return (
    <div className="panel">
      <div className="panel-title">Strategy Controls</div>
      <div className="strategy-list">
        {strategies.map((strategy) => {
          const state = getRowState(strategy.name);
          const isRunning = strategy.status === 'running';

          return (
            <div key={strategy.name} className="strategy-row">
              <div className="strategy-info">
                <span className="strategy-name">{strategy.name}</span>
                <span className={`status-badge ${isRunning ? 'status-running' : 'status-stopped'}`}>
                  {isRunning ? 'RUNNING' : 'STOPPED'}
                </span>
              </div>

              <button
                className={`toggle-switch ${isRunning ? 'toggle-on' : 'toggle-off'} ${state.pending ? 'toggle-pending' : ''}`}
                onClick={() => handleToggle(strategy)}
                disabled={state.pending || state.confirmingStop}
                aria-label={`${isRunning ? 'Stop' : 'Start'} ${strategy.name}`}
                title={`${isRunning ? 'Stop' : 'Start'} ${strategy.name}`}
              >
                <span className="toggle-thumb" />
              </button>

              {state.confirmingStop && (
                <div className="inline-confirm">
                  <span className="inline-confirm-text">Stop {strategy.name}?</span>
                  <button
                    className="btn-secondary btn-sm"
                    onClick={() => handleCancelStop(strategy.name)}
                  >
                    Cancel
                  </button>
                  <button
                    className="btn-danger btn-sm"
                    onClick={() => handleConfirmStop(strategy.name)}
                  >
                    Stop
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
