/**
 * CircuitBreakerBanner — Full-width red banner shown when circuit breaker fires.
 *
 * - Slides down from top with animation on activation
 * - Plays Web Audio API alert (880/660/880Hz sine sequence) only on false->true transition
 * - Sound is skipped when isMuted is true
 * - Has an X dismiss button to hide the banner (but keeps isActive state in parent)
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

function playAlertBeep(): void {
  try {
    const ctx = new AudioContext();
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

      if (i === frequencies.length - 1) {
        oscillator.onended = () => {
          void ctx.close();
        };
      }
    });
  } catch {
    // Audio API not available — silent fallback
  }
}

export function CircuitBreakerBanner({
  isActive,
  message,
  triggeredAt,
  isMuted,
  onDismiss,
}: CircuitBreakerBannerProps): React.ReactElement | null {
  // Track previous isActive to detect false -> true transition
  const prevActiveRef = useRef(false);

  useEffect(() => {
    // Only play sound on the transition from false to true
    if (isActive && !prevActiveRef.current && !isMuted) {
      playAlertBeep();
    }
    prevActiveRef.current = isActive;
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
