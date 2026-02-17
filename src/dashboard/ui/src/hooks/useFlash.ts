import { useEffect, useRef, useState } from 'react';

export type FlashDirection = 'up' | 'down' | null;

/**
 * Flash animation hook for trading terminal-style value change indicators.
 *
 * Compares current value to previous value via useRef.
 * Returns 'up' when value increases, 'down' when it decreases, null otherwise.
 * Flash clears automatically after `duration` ms (default 500ms).
 */
export function useFlash(
  value: number | string,
  duration = 500,
): FlashDirection {
  const prevRef = useRef<number | string | undefined>(undefined);
  const [flash, setFlash] = useState<FlashDirection>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = value;

    // Skip on first render
    if (prev === undefined) return;

    const numCurrent = typeof value === 'string' ? parseFloat(value) : value;
    const numPrev = typeof prev === 'string' ? parseFloat(prev) : prev;

    if (!isFinite(numCurrent) || !isFinite(numPrev)) return;
    if (numCurrent === numPrev) return;

    const direction: FlashDirection = numCurrent > numPrev ? 'up' : 'down';

    // Clear any pending timer before setting new flash
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
    }

    setFlash(direction);

    timerRef.current = setTimeout(() => {
      setFlash(null);
      timerRef.current = null;
    }, duration);
  }, [value, duration]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  return flash;
}
