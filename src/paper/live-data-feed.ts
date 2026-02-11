/**
 * LiveDataFeed -- real-time candle stream via Coinbase WebSocket.
 *
 * Subscribes to the `candles` channel on the advTradeMarketData feed.
 * Detects completed candles by tracking when a new candle start timestamp
 * arrives (meaning the previous candle is finalized). Falls back to REST
 * polling when the WebSocket disconnects.
 *
 * CRITICAL: WebSocket sends candle.start as Unix SECONDS.
 * This class converts to Unix MILLISECONDS (project convention).
 */

import { EventEmitter } from 'node:events';
import { WebsocketClient, CBAdvancedTradeClient } from 'coinbase-api';
import type { Candle, TradingPair } from '../core/types.js';
import type { LiveDataFeedEvents } from './types.js';
import { createModuleLogger } from '../core/logger.js';

const log = createModuleLogger('live-data-feed');

export interface LiveDataFeedOptions {
  apiKey?: string;
  apiSecret?: string;
}

export class LiveDataFeed extends EventEmitter {
  private ws: WebsocketClient;
  private restClient: CBAdvancedTradeClient | null = null;

  /** Tracks the last seen candle start (Unix seconds string) per product_id */
  private lastCandleStart: Map<string, string> = new Map();

  /** Current (in-progress) candle per product_id */
  private currentCandle: Map<string, Candle> = new Map();

  /** Whether the WebSocket is currently connected */
  private isConnected = false;

  /** REST fallback polling timer */
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  /** Configurable polling interval for REST fallback */
  private pollIntervalMs = 60000;

  /** Pairs being tracked (for REST fallback) */
  private activePairs: TradingPair[] = [];

  constructor(options: LiveDataFeedOptions = {}) {
    super();

    this.ws = new WebsocketClient({
      apiKey: options.apiKey,
      apiSecret: options.apiSecret,
    });

    // Create REST client if credentials provided (for REST fallback)
    if (options.apiKey && options.apiSecret) {
      this.restClient = new CBAdvancedTradeClient({
        apiKey: options.apiKey,
        apiSecret: options.apiSecret,
      });
    }
  }

  // ── Typed event emitter overrides ───────────────────────────────────

  override emit<K extends keyof LiveDataFeedEvents>(
    event: K,
    ...args: LiveDataFeedEvents[K]
  ): boolean {
    return super.emit(event, ...args);
  }

  override on<K extends keyof LiveDataFeedEvents>(
    event: K,
    listener: (...args: LiveDataFeedEvents[K]) => void,
  ): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  // ── Public API ─────────────────────────────────────────────────────

  /**
   * Start streaming candles for the given pairs.
   *
   * @param pairs - Trading pairs to subscribe to
   * @param pollIntervalMs - REST fallback interval (default 60000ms)
   */
  start(pairs: TradingPair[], pollIntervalMs?: number): void {
    this.activePairs = pairs;
    if (pollIntervalMs !== undefined) {
      this.pollIntervalMs = pollIntervalMs;
    }

    // Wire up WebSocket event handlers
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.ws.on('update', (data: any) => {
      if (data?.channel === 'candles') {
        this.handleCandleUpdate(data);
      }
    });

    this.ws.on('open', () => {
      this.isConnected = true;
      this.stopRestFallback();
      log.info({ pairs }, 'WebSocket connected');
      this.emit('connected');
    });

    this.ws.on('reconnected', () => {
      this.isConnected = true;
      this.stopRestFallback();
      log.info({ pairs }, 'WebSocket reconnected');
      this.emit('reconnected');
    });

    this.ws.on('close', () => {
      this.isConnected = false;
      log.warn('WebSocket disconnected, starting REST fallback');
      this.startRestFallback(pairs);
      this.emit('disconnected');
    });

    this.ws.on('exception', (err: unknown) => {
      log.error({ err }, 'WebSocket exception');
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    });

    // Subscribe to candle channel
    this.ws.subscribe(
      {
        topic: 'candles',
        payload: { product_ids: pairs },
      },
      'advTradeMarketData',
    );

    log.info({ pairs, pollIntervalMs: this.pollIntervalMs }, 'LiveDataFeed started');
  }

  /**
   * Stop the data feed and clean up resources.
   */
  stop(): void {
    // Unsubscribe from WebSocket
    if (this.activePairs.length > 0) {
      try {
        this.ws.unsubscribe(
          {
            topic: 'candles',
            payload: { product_ids: this.activePairs },
          },
          'advTradeMarketData',
        );
      } catch {
        // Ignore errors during cleanup
      }
    }

    this.stopRestFallback();
    this.lastCandleStart.clear();
    this.currentCandle.clear();
    this.isConnected = false;
    this.activePairs = [];

    log.info('LiveDataFeed stopped');
  }

  // ── Private: candle update handling ────────────────────────────────

  /**
   * Handle incoming candle update from WebSocket.
   *
   * When a new candle start timestamp is seen for a product, the PREVIOUS
   * candle (stored in currentCandle) is considered complete and emitted.
   */
  private handleCandleUpdate(data: {
    events?: Array<{
      candles?: Array<{
        product_id: string;
        start: string;
        open: string;
        high: string;
        low: string;
        close: string;
        volume: string;
      }>;
    }>;
  }): void {
    if (!data.events) return;

    for (const event of data.events) {
      if (!event.candles) continue;

      for (const candle of event.candles) {
        const key = candle.product_id;
        const prevStart = this.lastCandleStart.get(key);

        // If we have a previous candle and the start changed, previous is complete
        if (prevStart && prevStart !== candle.start) {
          const completed = this.currentCandle.get(key);
          if (completed) {
            log.debug(
              {
                pair: key,
                timestamp: completed.timestamp,
              },
              'Candle completed',
            );
            this.emit('candle', completed);
          }
        }

        // Update current candle with latest data
        // CRITICAL: Convert Unix seconds to Unix milliseconds
        this.currentCandle.set(key, {
          pair: candle.product_id as TradingPair,
          timeframe: '1m',
          timestamp: Number(candle.start) * 1000,
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
          volume: candle.volume,
        });

        this.lastCandleStart.set(key, candle.start);
      }
    }
  }

  // ── Private: REST fallback ─────────────────────────────────────────

  /**
   * Start REST polling as fallback when WebSocket is disconnected.
   * Only works if REST client is available (credentials were provided).
   */
  private startRestFallback(pairs: TradingPair[]): void {
    if (!this.restClient) {
      log.warn('No REST client available for fallback (no credentials)');
      return;
    }

    if (this.pollTimer) return; // Already polling

    log.info(
      { pairs, intervalMs: this.pollIntervalMs },
      'REST fallback polling started',
    );

    this.pollTimer = setInterval(async () => {
      if (!this.restClient) return;

      for (const pair of pairs) {
        try {
          const now = Math.floor(Date.now() / 1000);
          const twoMinAgo = now - 120;

          const response = await this.restClient.getProductCandles({
            product_id: pair,
            start: String(twoMinAgo),
            end: String(now),
            granularity: 'ONE_MINUTE',
          });

          // Sort descending by start time
          const sorted = (response.candles ?? [])
            .map((c: { start: string; open: string; high: string; low: string; close: string; volume: string }) => ({
              ...c,
              startMs: Number(c.start) * 1000,
            }))
            .sort((a: { startMs: number }, b: { startMs: number }) => b.startMs - a.startMs);

          // Skip first candle (in-progress), take second (most recent completed)
          if (sorted.length < 2) continue;
          const completed = sorted[1];

          // Only emit if this candle is newer than what we already have
          const lastStart = this.lastCandleStart.get(pair);
          if (lastStart && Number(lastStart) * 1000 >= completed.startMs) {
            continue;
          }

          const candleObj: Candle = {
            pair,
            timeframe: '1m',
            timestamp: completed.startMs,
            open: completed.open,
            high: completed.high,
            low: completed.low,
            close: completed.close,
            volume: completed.volume,
          };

          this.lastCandleStart.set(pair, String(completed.startMs / 1000));
          this.currentCandle.set(pair, candleObj);

          log.debug(
            { pair, timestamp: candleObj.timestamp },
            'REST fallback candle',
          );
          this.emit('candle', candleObj);
        } catch (err) {
          log.error({ err, pair }, 'REST fallback poll error');
        }
      }
    }, this.pollIntervalMs);
  }

  /**
   * Stop REST fallback polling.
   */
  private stopRestFallback(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
      log.info('REST fallback polling stopped');
    }
  }
}
