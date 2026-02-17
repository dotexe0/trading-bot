/**
 * WebSocket route handler for the dashboard server.
 *
 * Registers the /ws route, adds new connections to the broadcaster,
 * sends an initial snapshot, and dispatches incoming commands.
 */

import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { createModuleLogger } from '../../../core/logger.js';
import type { WsBroadcaster } from './broadcaster.js';
import type { WsCommand } from '../types.js';

const log = createModuleLogger('ws-handler');

export interface WsHandlerDeps {
  broadcaster: WsBroadcaster;
  getSnapshot: () => unknown;
  onCommand: (cmd: WsCommand, ws: WebSocket) => void;
}

/**
 * Register the WebSocket route on the Fastify instance.
 */
export async function wsHandler(
  app: FastifyInstance,
  deps: WsHandlerDeps,
): Promise<void> {
  app.get('/ws', { websocket: true }, (socket, _request) => {
    const ws = socket as unknown as WebSocket;

    deps.broadcaster.addClient(ws);

    // Send initial snapshot
    try {
      const snapshot = deps.getSnapshot();
      const message = JSON.stringify({
        type: 'snapshot',
        payload: snapshot,
        timestamp: Date.now(),
      });
      ws.send(message);
    } catch (err) {
      log.error({ err }, 'Failed to send initial snapshot');
    }

    // Handle incoming messages (commands)
    ws.on('message', (data) => {
      try {
        const raw = typeof data === 'string' ? data : data.toString();
        const cmd = JSON.parse(raw) as WsCommand;

        if (!cmd.action) {
          log.warn({ raw }, 'Received WS message without action');
          return;
        }

        log.info({ action: cmd.action, params: cmd.params }, 'WS command received');
        deps.onCommand(cmd, ws);
      } catch (err) {
        log.warn({ err }, 'Failed to parse WS message');
      }
    });
  });
}
