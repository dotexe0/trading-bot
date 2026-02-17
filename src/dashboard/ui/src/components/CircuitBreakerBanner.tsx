/**
 * CircuitBreakerBanner — Full-width alert banner shown when the circuit breaker trips.
 *
 * Shows a prominent red banner below the header with:
 * - "CIRCUIT BREAKER TRIGGERED" label
 * - The triggering message
 * - Time since trigger
 * - Dismiss button
 * - Optional audio alert (plays when not muted)
 */

import React, { useEffect, useRef } from 'react';

interface CircuitBreakerBannerProps {
  isActive: boolean;
  message: string;
  triggeredAt?: number;
  isMuted: boolean;
  onDismiss: () => void;
}

function formatElapsed(ts: number): string {
  const elapsed = Math.floor((Date.now() - ts) / 1000);
  if (elapsed < 60) return `${elapsed}s ago`;
  const mins = Math.floor(elapsed / 60);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m ago`;
}

export function CircuitBreakerBanner({
  isActive,
  message,
  triggeredAt,
  isMuted,
  onDismiss,
}: CircuitBreakerBannerProps): React.ReactElement | null {
  const audioRef = useRef<AudioContext | null>(null);

  // Play alert tone when circuit breaker fires and not muted
  useEffect(() => {
    if (!isActive || isMuted) return;

    try {
      const ctx = new AudioContext();
      audioRef.current = ctx;

      // Simple beep sequence
      const frequencies = [880, 660, 880];
      frequencies.forEach((freq, i) => {
        const oscillator = ctx.createOscillator();
        const gainNode = ctx.createGain();

        oscillator.connect(gainNode);
        gainNode.connect(ctx.destination);

        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(freq, ctx.currentTime + i * 0.25);

        gainNode.gain.setValueAtTime(0.3, ctx.currentTime + i * 0.25);
        gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.25 + 0.2);

        oscillator.start(ctx.currentTime + i * 0.25);
        oscillator.stop(ctx.currentTime + i * 0.25 + 0.2);
      });
    } catch {
      // Audio API not available — silent fallback
    }

    return () => {
      audioRef.current?.close().catch(() => undefined);
      audioRef.current = null;
    };
  }, [isActive, isMuted]);

  if (!isActive) return null;

  return (
    <div className="cb-banner" role="alert" aria-live="assertive">
      <div className="cb-banner-content">
        <span className="cb-banner-label">Circuit Breaker Triggered</span>
        {message && <span className="cb-banner-message">{message}</span>}
        {triggeredAt && (
          <span className="cb-banner-time">{formatElapsed(triggeredAt)}</span>
        )}
      </div>
      <button
        className="cb-banner-dismiss"
        onClick={onDismiss}
        aria-label="Dismiss circuit breaker alert"
        title="Dismiss"
      >
        &times;
      </button>
    </div>
  );
}
