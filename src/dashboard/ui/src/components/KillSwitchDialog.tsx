/**
 * KillSwitchDialog — Confirmation modal before executing the kill switch.
 *
 * Shown when the user clicks the KILL SWITCH button in the header.
 * Keyboard: Escape closes, Enter confirms.
 */

import React, { useEffect, useCallback } from 'react';

interface KillSwitchDialogProps {
  isOpen: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  isLoading: boolean;
}

export function KillSwitchDialog({ isOpen, onConfirm, onCancel, isLoading }: KillSwitchDialogProps) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!isOpen) return;
      if (e.key === 'Escape' && !isLoading) onCancel();
      if (e.key === 'Enter' && !isLoading) onConfirm();
    },
    [isOpen, isLoading, onCancel, onConfirm],
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={!isLoading ? onCancel : undefined} role="dialog" aria-modal="true" aria-labelledby="ks-title">
      <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-icon">!</span>
          <h2 id="ks-title" className="modal-title">Emergency Kill Switch</h2>
        </div>

        <p className="modal-body">Cancel all orders and close positions?</p>
        <p className="modal-warning">This will immediately stop all running strategies and cancel any open orders. This action cannot be undone.</p>

        <div className="modal-actions">
          <button
            className="btn-secondary"
            onClick={onCancel}
            disabled={isLoading}
          >
            Cancel
          </button>
          <button
            className={`btn-danger kill-confirm-btn ${!isLoading ? 'pulse-border' : ''}`}
            onClick={onConfirm}
            disabled={isLoading}
          >
            {isLoading ? (
              <span className="btn-spinner">
                <span className="spinner" />
                Stopping...
              </span>
            ) : (
              'Confirm Kill Switch'
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
