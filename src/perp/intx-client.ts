/**
 * IntxClient — REST wrapper and WebSocket streamer for Coinbase International Exchange (INTX).
 *
 * Provides:
 *  - getAccountState(): single round-trip to fetch balances, positions, summary
 *  - start(): subscribe to RISK and FUNDING channels via WebSocket, with exponential backoff reconnect
 *  - stop(): graceful shutdown, clears pending reconnect timers
 *  - placeOrder(): stub — full implementation in Phase 27
 *  - cancelOrder(): stub — full implementation in Phase 27
 *
 * Events emitted (typed via IntxClientEvents):
 *  - markPrice     — on RISK channel update
 *  - fundingRate   — on FUNDING channel update
 *  - connected     — WebSocket connection established
 *  - disconnected  — WebSocket connection dropped (isStale becomes true)
 *  - reconnected   — WebSocket successfully reconnected
 *  - reconnectFailed — max reconnect attempts exceeded, IntxClient stopped
 *  - error         — WebSocket error (logged, does not crash)
 */

import { EventEmitter } from 'node:events';
import { CBInternationalClient, WebsocketClient } from 'coinbase-api';
import { createModuleLogger } from '../core/logger.js';
import type { IntxConfig } from './config.js';
import type {
  IntxClientEvents,
  IntxAccountState,
  PlaceOrderParams,
  CancelOrderParams,
} from './types.js';

const log = createModuleLogger('intx-client');

export class IntxClient extends EventEmitter {
  private restClient: CBInternationalClient;
  private config: IntxConfig;

  // ── WebSocket state ────────────────────────────────────────────────
  private ws: WebsocketClient | null = null;
  private _isStale = false;
  private reconnectAttempts = 0;
  private readonly MAX_RECONNECT_ATTEMPTS = 10;
  private readonly INITIAL_DELAY_MS = 1000;
  private readonly BACKOFF_MULTIPLIER = 2;
  private readonly MAX_DELAY_MS = 30000;
  private readonly JITTER_FACTOR = 0.2; // ±20%
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  /** Typed emit override — matches ENGINE_EVENT_MAP pattern. */
  override emit<K extends keyof IntxClientEvents>(
    event: K,
    ...args: IntxClientEvents[K]
  ): boolean {
    return super.emit(event, ...args);
  }

  constructor(config: IntxConfig) {
    super();
    if (!config.enabled) {
      throw new Error(
        'IntxClient instantiated with INTX_ENABLED=false. Check caller.',
      );
    }
    this.config = config;
    this.restClient = new CBInternationalClient({
      apiKey: config.apiKey!,
      apiSecret: config.apiSecret!,
      apiPassphrase: config.apiPassphrase!,
      useSandbox: config.testnet,
    });
    log.info(
      { testnet: config.testnet },
      'IntxClient initialized (REST only until start() called)',
    );
  }

  // ── WebSocket public API ───────────────────────────────────────────

  /**
   * Connect WebSocket and subscribe to RISK and FUNDING channels.
   * Call once — throws if already started.
   * Does NOT make live network calls at module load time.
   */
  async start(): Promise<void> {
    if (this.ws) throw new Error('IntxClient already started');
    this.stopped = false;
    this.ws = new WebsocketClient({
      apiKey: this.config.apiKey!,
      apiSecret: this.config.apiSecret!,
      apiPassphrase: this.config.apiPassphrase!,
      useSandbox: this.config.testnet,
    });
    this._wireWsEvents();
    this._subscribe();
    log.info('IntxClient WebSocket started');
  }

  /**
   * Graceful shutdown — clears reconnect timer and closes WebSocket.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.closeAll();
      this.ws = null;
    }
    log.info('IntxClient stopped');
  }

  // ── WebSocket private helpers ──────────────────────────────────────

  /** Subscribe to RISK and FUNDING channels for BTC-PERP and ETH-PERP. */
  private _subscribe(): void {
    this.ws!.subscribe(
      { topic: 'RISK', payload: { product_ids: ['BTC-PERP', 'ETH-PERP'] } },
      'internationalMarketData',
    );
    this.ws!.subscribe(
      { topic: 'FUNDING', payload: { product_ids: ['BTC-PERP', 'ETH-PERP'] } },
      'internationalMarketData',
    );
  }

  /** Attach event listeners to the WebsocketClient instance. */
  private _wireWsEvents(): void {
    // Connection established
    this.ws!.on('open', () => {
      this.reconnectAttempts = 0;
      this._isStale = false;
      this.emit('connected');
      log.info('INTX WebSocket connected');
    });

    // Market data update
    this.ws!.on('update', (data: any) => {
      if (data?.channel === 'RISK') {
        this.emit('markPrice', {
          instrument: data.product_id,
          markPrice: data.mark_price,
          indexPrice: data.index_price,
          timestamp: Date.now(),
          isStale: this._isStale,
        });
      } else if (data?.channel === 'FUNDING') {
        this.emit('fundingRate', {
          instrument: data.product_id,
          fundingRate: data.funding_rate,
          isFinal: data.is_final,
          timestamp: Date.now(),
          isStale: this._isStale,
        });
      } else {
        log.debug({ channel: data?.channel }, 'INTX WebSocket: unknown channel update');
      }
    });

    // Connection dropped
    this.ws!.on('close', () => {
      this._isStale = true;
      this.emit('disconnected');
      log.warn('INTX WebSocket disconnected — scheduling reconnect');
      this._scheduleReconnect();
    });

    // WebSocket error — log and let reconnect handle recovery
    this.ws!.on('error', (err: any) => {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err: message }, 'INTX WebSocket error');
      this.emit('error', err instanceof Error ? err : new Error(message));
    });
  }

  /** Exponential backoff with ±20% jitter. Stops after MAX_RECONNECT_ATTEMPTS. */
  private _scheduleReconnect(): void {
    if (this.stopped) return;
    this.reconnectAttempts++;
    if (this.reconnectAttempts > this.MAX_RECONNECT_ATTEMPTS) {
      log.fatal(
        { attempts: this.reconnectAttempts },
        'INTX WebSocket max reconnect attempts exceeded — perp subsystem stopped',
      );
      this.emit('reconnectFailed', { attempts: this.reconnectAttempts });
      this.stopped = true;
      return;
    }
    const base = Math.min(
      this.INITIAL_DELAY_MS * Math.pow(this.BACKOFF_MULTIPLIER, this.reconnectAttempts - 1),
      this.MAX_DELAY_MS,
    );
    const jitter = base * this.JITTER_FACTOR * (Math.random() * 2 - 1); // ±20%
    const delay = Math.round(base + jitter);
    log.warn(
      { attempt: this.reconnectAttempts, delayMs: delay },
      'INTX WebSocket reconnecting...',
    );
    this.reconnectTimer = setTimeout(() => {
      if (this.stopped) return;
      // ws.subscribe() triggers reconnect internally
      this._subscribe();
      this.emit('reconnected');
      this.reconnectAttempts = 0; // reset on successful reconnect trigger
      this._isStale = false;
    }, delay);
  }

  // ── REST API ───────────────────────────────────────────────────────

  /**
   * Query INTX account state: balances, open positions, and portfolio summary.
   * Uses getPortfolioDetails() for a single round-trip.
   */
  async getAccountState(): Promise<IntxAccountState> {
    const detail = await this.restClient.getPortfolioDetails({
      portfolio: this.config.portfolioId!,
    });
    log.info(
      { portfolioId: this.config.portfolioId },
      'INTX account state fetched',
    );
    return {
      balances: (detail as any).balances ?? [],
      positions: (detail as any).positions ?? [],
      summary: (detail as any).summary ?? {},
    };
  }

  /**
   * Stub: Place a perp order on INTX.
   * Full implementation in Phase 27.
   */
  async placeOrder(_params: PlaceOrderParams): Promise<void> {
    throw new Error('placeOrder not implemented until Phase 27');
  }

  /**
   * Stub: Cancel a perp order on INTX.
   * Full implementation in Phase 27.
   */
  async cancelOrder(_params: CancelOrderParams): Promise<void> {
    throw new Error('cancelOrder not implemented until Phase 27');
  }
}
