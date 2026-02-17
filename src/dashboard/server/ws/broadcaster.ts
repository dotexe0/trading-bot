/**
 * WsBroadcaster -- maintains connected WebSocket clients and broadcasts
 * typed messages to all open connections.
 *
 * Includes server-side ping/pong heartbeat (30s interval) to detect
 * stale connections early and clean up resources.
 */

import type { WebSocket } from 'ws';
import { createModuleLogger } from '../../../core/logger.js';
import type { WsMessageType, WsMessage } from '../types.js';

const log = createModuleLogger('ws-broadcaster');

const PING_INTERVAL_MS = 30_000;

export class WsBroadcaster {
  private clients = new Set<WebSocket>();
  private pingIntervals = new Map<WebSocket, ReturnType<typeof setInterval>>();

  /**
   * Add a WebSocket client. Registers close handler for auto-removal
   * and starts ping/pong heartbeat.
   */
  addClient(ws: WebSocket): void {
    this.clients.add(ws);

    // Server-side ping/pong heartbeat
    const interval = setInterval(() => {
      if (ws.readyState === 1 /* OPEN */) {
        ws.ping();
      }
    }, PING_INTERVAL_MS);

    this.pingIntervals.set(ws, interval);

    ws.on('close', () => {
      this.removeClient(ws);
    });

    ws.on('error', (err) => {
      log.warn({ err: err.message }, 'WebSocket client error');
      this.removeClient(ws);
    });

    log.debug({ clientCount: this.clients.size }, 'Client connected');
  }

  /**
   * Remove a WebSocket client and clear its ping interval.
   */
  removeClient(ws: WebSocket): void {
    this.clients.delete(ws);
    const interval = this.pingIntervals.get(ws);
    if (interval) {
      clearInterval(interval);
      this.pingIntervals.delete(ws);
    }
    log.debug({ clientCount: this.clients.size }, 'Client disconnected');
  }

  /**
   * Broadcast a typed message to all connected clients with readyState OPEN.
   */
  broadcast(type: WsMessageType, payload: unknown): void {
    const message: WsMessage = {
      type,
      payload,
      timestamp: Date.now(),
    };

    const data = JSON.stringify(message);
    let sent = 0;

    for (const client of this.clients) {
      if (client.readyState === 1 /* OPEN */) {
        client.send(data);
        sent++;
      }
    }

    if (sent > 0) {
      log.trace({ type, sent, total: this.clients.size }, 'Broadcast sent');
    }
  }

  /**
   * Get the number of currently connected clients.
   */
  getClientCount(): number {
    return this.clients.size;
  }

  /**
   * Close all clients and clear all intervals. Used during shutdown.
   */
  closeAll(): void {
    for (const [ws, interval] of this.pingIntervals) {
      clearInterval(interval);
      try {
        ws.close();
      } catch {
        // ignore close errors during shutdown
      }
    }
    this.clients.clear();
    this.pingIntervals.clear();
  }
}
