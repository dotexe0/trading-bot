import { useCallback, useEffect, useRef, useState } from 'react';

export type WsStatus = 'connecting' | 'connected' | 'disconnected';

interface UseWebSocketReturn {
  status: WsStatus;
  send: (cmd: unknown) => void;
}

/**
 * WebSocket hook with auto-reconnect and exponential backoff.
 *
 * - Base delay: 1s, max delay: 30s
 * - Jitter: ±20% of delay to avoid thundering herd
 * - Resets retry counter on successful connection
 * - Cleans up WebSocket and timer on unmount
 */
export function useWebSocket(
  url: string,
  onMessage: (type: string, payload: unknown) => void,
): UseWebSocketReturn {
  const [status, setStatus] = useState<WsStatus>('connecting');
  const wsRef = useRef<WebSocket | null>(null);
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const onMessageRef = useRef(onMessage);

  // Keep onMessage ref current without re-triggering effect
  useEffect(() => {
    onMessageRef.current = onMessage;
  });

  const connect = useCallback(() => {
    if (!mountedRef.current) return;

    setStatus('connecting');

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      if (!mountedRef.current) {
        ws.close();
        return;
      }
      retryCountRef.current = 0;
      setStatus('connected');
    };

    ws.onmessage = (event: MessageEvent) => {
      if (!mountedRef.current) return;
      try {
        const data = JSON.parse(event.data as string) as { type: string; payload: unknown };
        onMessageRef.current(data.type, data.payload);
      } catch {
        // Malformed message — ignore
      }
    };

    ws.onclose = () => {
      if (!mountedRef.current) return;
      wsRef.current = null;
      setStatus('disconnected');
      scheduleReconnect();
    };

    ws.onerror = () => {
      // onerror always precedes onclose; let onclose handle reconnect
      ws.close();
    };
  }, [url]);

  const scheduleReconnect = useCallback(() => {
    if (!mountedRef.current) return;

    const baseDelay = 1000;
    const maxDelay = 30000;
    const expDelay = Math.min(baseDelay * 2 ** retryCountRef.current, maxDelay);
    const jitter = expDelay * 0.2 * Math.random();
    const delay = expDelay + jitter;

    retryCountRef.current += 1;

    retryTimerRef.current = setTimeout(() => {
      if (mountedRef.current) {
        connect();
      }
    }, delay);
  }, [connect]);

  useEffect(() => {
    mountedRef.current = true;
    connect();

    return () => {
      mountedRef.current = false;

      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }

      if (wsRef.current) {
        wsRef.current.onclose = null; // Prevent reconnect on intentional close
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connect]);

  const send = useCallback((cmd: unknown) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(cmd));
    }
  }, []);

  return { status, send };
}
