/**
 * LiveDataFeed -- real-time candle stream via Coinbase WebSocket + REST polling.
 *
 * The Coinbase advTradeMarketData 'candles' WS channel sends 5-minute candles
 * only (ONE_FIVE_MINUTE). Each WS update includes a full 100-candle snapshot,
 * not just the new candle.
 *
 * Strategy:
 *  - For 5m timeframe: use WS with deduplication, REST as disconnection fallback.
 *  - For all other timeframes (1h, 15m, 1m, etc.): use REST polling only with
 *    the correct granularity. WS subscription is kept alive for health monitoring.
 *
 * Deduplication: tracks the last emitted candle timestamp per pair and skips
 * any candle that is not strictly newer. This prevents repeated processing of
 * the WS historical snapshot that Coinbase sends on every update.
 *
 * CRITICAL: WebSocket sends candle.start as Unix SECONDS.
 * This class converts to Unix MILLISECONDS (project convention).
 */

import { EventEmitter } from 'node:events';
import { WebsocketClient, CBAdvancedTradeClient } from 'coinbase-api';
import type { Candle, TradingPair, Timeframe } from '../core/types.js';
import { TIMEFRAME_MS } from '../core/types.js';
import type { LiveDataFeedEvents } from './types.js';
import { createModuleLogger } from '../core/logger.js';

const log = createModuleLogger('live-data-feed');

/** Coinbase granularity string for each supported timeframe. */
const TIMEFRAME_TO_GRANULARITY: Partial<Record<Timeframe, string>> = {
  '1m': 'ONE_MINUTE',
  '5m': 'FIVE_MINUTE',
  '15m': 'FIFTEEN_MINUTE',
  '1h': 'ONE_HOUR',
  '4h': 'SIX_HOUR', // closest match (no 4h on CB)
  '1D': 'ONE_DAY',
};

/** WS sends 5m candles only. For other timeframes, use REST polling. */
const WS_NATIVE_TIMEFRAME: Timeframe = '5m';

export interface LiveDataFeedOptions {
  apiKey?: string;
  apiSecret?: string;
  /** Timeframe to use for emitted candles. Defaults to '5m' (WS native). */
  timeframe?: Timeframe;
}

export class LiveDataFeed extends EventEmitter {
  private ws: WebsocketClient;
  private restClient: CBAdvancedTradeClient | null = null;

  private readonly timeframe: Timeframe;
  private readonly granularity: string;
  private readonly useWsForData: boolean;

  /** Tracks the last seen candle start (Unix seconds string) per product_id */
  private lastCandleStart: Map<string, string> = new Map();

  /** Current (in-progress) candle per product_id */
  private currentCandle: Map<string, Candle> = new Map();

  /** Last emitted candle timestamp (ms) per pair — for deduplication. */
  private lastEmittedTs: Map<string, number> = new Map();

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

    this.timeframe = options.timeframe ?? WS_NATIVE_TIMEFRAME;
    this.granularity = TIMEFRAME_TO_GRANULARITY[this.timeframe] ?? 'FIVE_MINUTE';
    // Only use WS candle data when WS natively provides this timeframe
    this.useWsForData = this.timeframe === WS_NATIVE_TIMEFRAME;

    this.ws = new WebsocketClient({
      apiKey: options.apiKey,
      apiSecret: options.apiSecret,
    });

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
   * @param pollIntervalMs - REST poll interval. For non-5m timeframes this is
   *   used as the primary data source poll rate (default 60000ms).
   */
  start(pairs: TradingPair[], pollIntervalMs?: number): void {
    this.activePairs = pairs;
    if (pollIntervalMs !== undefined) {
      this.pollIntervalMs = pollIntervalMs;
    }

    // Wire up WebSocket event handlers
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.ws.on('update', (data: any) => {
      if (data?.channel === 'candles' && this.useWsForData) {
        this.handleCandleUpdate(data);
      }
    });

    this.ws.on('open', () => {
      this.isConnected = true;
      // For non-5m: keep REST polling running alongside WS
      if (this.useWsForData) {
        this.stopRestFallback();
      }
      log.info({ pairs, timeframe: this.timeframe }, 'WebSocket connected');
      this.emit('connected');
    });

    this.ws.on('reconnected', () => {
      this.isConnected = true;
      if (this.useWsForData) {
        this.stopRestFallback();
      }
      log.info({ pairs, timeframe: this.timeframe }, 'WebSocket reconnected');
      this.emit('reconnected');
    });

    this.ws.on('close', () => {
      this.isConnected = false;
      log.warn('WebSocket disconnected, starting REST fallback');
      this.startRestPolling(pairs);
      this.emit('disconnected');
    });

    this.ws.on('exception', (err: unknown) => {
      log.error({ err }, 'WebSocket exception');
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    });

    // Subscribe to candle channel (for WS health + 5m data when applicable)
    this.ws.subscribe(
      {
        topic: 'candles',
        payload: { product_ids: pairs },
      },
      'advTradeMarketData',
    );

    // For non-5m timeframes: start REST polling immediately as primary data source
    if (!this.useWsForData) {
      this.startRestPolling(pairs);
    }

    log.info(
      { pairs, timeframe: this.timeframe, granularity: this.granularity, pollIntervalMs: this.pollIntervalMs },
      'LiveDataFeed started',
    );
  }

  /**
   * Stop the data feed and clean up resources.
   */
  stop(): void {
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
    this.lastEmittedTs.clear();
    this.isConnected = false;
    this.activePairs = [];

    log.info('LiveDataFeed stopped');
  }

  // ── Private: candle update handling ────────────────────────────────

  /**
   * Handle incoming candle update from WebSocket (5m candles only).
   *
   * Coinbase sends a full 100-candle historical snapshot with every update.
   * Deduplication via lastEmittedTs ensures only genuinely new candles are
   * emitted — historical snapshot candles are silently skipped.
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

        // When start timestamp changes, the previous candle is complete
        if (prevStart && prevStart !== candle.start) {
          const completed = this.currentCandle.get(key);
          if (completed) {
            this.emitIfNew(key, completed);
          }
        }

        // Update current in-progress candle
        // CRITICAL: Convert Unix seconds to Unix milliseconds
        this.currentCandle.set(key, {
          pair: candle.product_id as TradingPair,
          timeframe: this.timeframe,
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

  /**
   * Emit a candle only if its timestamp is strictly newer than the last
   * emitted candle for the same pair. Prevents re-processing historical
   * snapshot candles that Coinbase includes in every WS update.
   */
  private emitIfNew(key: string, candle: Candle): void {
    const lastTs = this.lastEmittedTs.get(key) ?? 0;
    if (candle.timestamp <= lastTs) {
      log.debug(
        { pair: key, timestamp: candle.timestamp, lastEmittedTs: lastTs },
        'Candle deduplicated — skipping historical snapshot candle',
      );
      return;
    }
    this.lastEmittedTs.set(key, candle.timestamp);
    log.debug({ pair: key, timestamp: candle.timestamp }, 'Candle completed');
    this.emit('candle', candle);
  }

  // ── Private: REST polling ──────────────────────────────────────────

  /**
   * Start REST polling. Used as:
   *  - Primary data source for non-5m timeframes
   *  - Fallback when WebSocket disconnects (for 5m)
   */
  private startRestPolling(pairs: TradingPair[]): void {
    if (!this.restClient) {
      log.warn('No REST client available (no credentials)');
      return;
    }

    if (this.pollTimer) return; // Already polling

    log.info(
      { pairs, intervalMs: this.pollIntervalMs, granularity: this.granularity },
      'REST polling started',
    );

    this.pollTimer = setInterval(() => void this._pollRest(pairs), this.pollIntervalMs);
    // Fire immediately
    void this._pollRest(pairs);
  }

  private async _pollRest(pairs: TradingPair[]): Promise<void> {
    if (!this.restClient) return;

    const tfMs = TIMEFRAME_MS[this.timeframe] ?? 300_000;
    // Look back 3 periods to reliably catch the last completed candle
    const lookbackSec = Math.ceil((tfMs * 3) / 1000);

    for (const pair of pairs) {
      try {
        const now = Math.floor(Date.now() / 1000);

        const response = await this.restClient.getProductCandles({
          product_id: pair,
          start: String(now - lookbackSec),
          end: String(now),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          granularity: this.granularity as any,
        });

        // Sort descending by start time (newest first)
        const sorted = (response.candles ?? [])
          .map((c: { start: string; open: string; high: string; low: string; close: string; volume: string }) => ({
            ...c,
            startMs: Number(c.start) * 1000,
          }))
          .sort((a: { startMs: number }, b: { startMs: number }) => b.startMs - a.startMs);

        // Skip the first (in-progress) candle; take the most recent completed one
        if (sorted.length < 2) continue;
        const completed = sorted[1];

        const candleObj: Candle = {
          pair,
          timeframe: this.timeframe,
          timestamp: completed.startMs,
          open: completed.open,
          high: completed.high,
          low: completed.low,
          close: completed.close,
          volume: completed.volume,
        };

        this.lastCandleStart.set(pair, String(completed.startMs / 1000));
        this.currentCandle.set(pair, candleObj);

        this.emitIfNew(pair, candleObj);
        // Heartbeat: fire on every successful poll so FeedHealthMonitor stays
        // current regardless of candle deduplication (e.g. long timeframes).
        this.emit('polled', pair as TradingPair);
      } catch (err) {
        log.error({ err, pair }, 'REST poll error');
      }
    }
  }

  /**
   * Stop REST polling.
   */
  private stopRestFallback(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
      log.info('REST polling stopped');
    }
  }
}
