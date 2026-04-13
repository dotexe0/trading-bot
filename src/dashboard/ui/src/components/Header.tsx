/**
 * Header — Sticky top bar with connection status, title, kill switch, and mute toggle.
 *
 * Kill switch is always visible per locked decision: "kill switch is an always-visible
 * red button in the header -- accessible from every page".
 */

import React, { useState } from 'react';
import type { WsStatus } from '../hooks/useWebSocket.js';
import { KillSwitchDialog } from './KillSwitchDialog.js';

interface HeaderProps {
  status: WsStatus;
  isMuted: boolean;
  onMuteToggle: () => void;
}

/**
 * Sticky top bar with connection status dot, title, kill switch button, and mute toggle.
 *
 * Connection dot colors per locked decision:
 *   - connected:     green  (#22c55e)
 *   - disconnected:  red    (#ef4444)
 *   - connecting:    yellow (#eab308) with pulse animation
 */
export function Header({ status, isMuted, onMuteToggle }: HeaderProps): React.ReactElement {
  const [killSwitchOpen, setKillSwitchOpen] = useState(false);
  const [killSwitchLoading, setKillSwitchLoading] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetLoading, setResetLoading] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  const dotClass = `connection-dot ${status}`;

  const statusLabel =
    status === 'connected'
      ? 'Connected'
      : status === 'connecting'
        ? 'Connecting...'
        : 'Disconnected';

  async function handleKillSwitchConfirm() {
    setKillSwitchLoading(true);
    try {
      const res = await fetch('/api/kill-switch', { method: 'POST' });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error ?? 'Kill switch failed');
      }
      setKillSwitchOpen(false);
      setToast({ message: 'Kill switch executed successfully', type: 'success' });
    } catch (err) {
      setToast({ message: err instanceof Error ? err.message : 'Kill switch failed', type: 'error' });
    } finally {
      setKillSwitchLoading(false);
      // Auto-dismiss toast after 4s
      setTimeout(() => setToast(null), 4000);
    }
  }

  async function handleResetConfirm() {
    setResetLoading(true);
    try {
      const res = await fetch('/api/reset-paper', { method: 'POST' });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error ?? 'Reset failed');
      }
      setResetOpen(false);
      setToast({ message: 'Paper history cleared — reloading...', type: 'success' });
      // Reload after short delay so toast is visible
      setTimeout(() => window.location.reload(), 1200);
    } catch (err) {
      setToast({ message: err instanceof Error ? err.message : 'Reset failed', type: 'error' });
    } finally {
      setResetLoading(false);
      setTimeout(() => setToast(null), 4000);
    }
  }

  return (
    <>
      <header className="header">
        <div className="header-left">
          <span className={dotClass} aria-label={statusLabel} title={statusLabel} />
          <span className="connection-label">{statusLabel}</span>
        </div>

        <span className="header-title">Trading Dashboard</span>

        <div className="header-right">
          {/* Mute toggle for circuit breaker sound */}
          <button
            className={`mute-btn ${isMuted ? 'muted' : ''}`}
            onClick={onMuteToggle}
            title={isMuted ? 'Unmute alerts' : 'Mute alerts'}
            aria-label={isMuted ? 'Unmute alerts' : 'Mute alerts'}
          >
            {isMuted ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M3.63 3.63a.996.996 0 0 0 0 1.41L7.29 8.7 7 9H4c-.55 0-1 .45-1 1v4c0 .55.45 1 1 1h3l3.29 3.29c.63.63 1.71.18 1.71-.71v-4.17l4.18 4.18c-.49.37-1.02.68-1.6.91-.36.15-.58.53-.58.92 0 .72.73 1.18 1.39.91.8-.33 1.55-.77 2.22-1.31l1.34 1.34a.996.996 0 1 0 1.41-1.41L5.05 3.63c-.39-.39-1.02-.39-1.42 0zM19 12c0 .82-.15 1.61-.41 2.34l1.53 1.53c.56-1.17.88-2.48.88-3.87 0-3.83-2.4-7.11-5.78-8.4-.59-.23-1.22.2-1.22.84v.08c0 .38.25.71.61.85C17.18 6.54 19 9.06 19 12zm-8.71-6.29-.17.17L12 7.76V6.41c0-.89-1.08-1.33-1.71-.7zM16.5 12c0-1.77-1.02-3.29-2.5-4.03v1.79l2.48 2.48c.01-.08.02-.16.02-.24z" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
              </svg>
            )}
          </button>

          {/* Reset paper history */}
          <button
            className="reset-paper-btn"
            onClick={() => setResetOpen(true)}
            aria-label="Reset paper history"
          >
            RESET HISTORY
          </button>

          {/* Kill switch always visible */}
          <button
            className="kill-switch-btn"
            onClick={() => setKillSwitchOpen(true)}
            aria-label="Emergency kill switch"
          >
            KILL SWITCH
          </button>
        </div>
      </header>

      {/* Toast notification */}
      {toast && (
        <div className={`toast toast-${toast.type}`}>
          {toast.message}
        </div>
      )}

      <KillSwitchDialog
        isOpen={killSwitchOpen}
        onConfirm={handleKillSwitchConfirm}
        onCancel={() => setKillSwitchOpen(false)}
        isLoading={killSwitchLoading}
      />

      {/* Reset paper history confirmation dialog */}
      {resetOpen && (
        <div className="modal-overlay" onClick={!resetLoading ? () => setResetOpen(false) : undefined} role="dialog" aria-modal="true" aria-labelledby="reset-title">
          <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-icon modal-icon-warn">!</span>
              <h2 id="reset-title" className="modal-title">Reset Paper History</h2>
            </div>

            <p className="modal-body">Delete all paper trading history and start fresh?</p>
            <p className="modal-warning">This will clear all trades, equity snapshots, sessions, tournament results, exit optimizations, regime history, and correlation snapshots. This cannot be undone.</p>

            <div className="modal-actions">
              <button
                className="btn-secondary"
                onClick={() => setResetOpen(false)}
                disabled={resetLoading}
              >
                Cancel
              </button>
              <button
                className="btn-warn reset-confirm-btn"
                onClick={handleResetConfirm}
                disabled={resetLoading}
              >
                {resetLoading ? (
                  <span className="btn-spinner">
                    <span className="spinner" />
                    Resetting...
                  </span>
                ) : (
                  'Confirm Reset'
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
