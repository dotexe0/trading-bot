/**
 * FcmClient — REST wrapper and WebSocket streamer for Coinbase FCM futures
 * (available to US users via the Advanced Trade API).
 *
 * Replaces the former INTX (Coinbase International) client.
 * Uses CBAdvancedTradeClient with the same credentials as spot trading.
 *
 * Events emitted (typed via IntxClientEvents):
 *  - markPrice     — on ticker update for FCM products
 *  - fundingRate   — on futures_balance_summary update (funding component)
 *  - connected / disconnected / reconnected / reconnectFailed / error
 */

import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { CBAdvancedTradeClient, WebsocketClient } from 'coinbase-api';
import { createModuleLogger } from '../core/logger.js';
import type { FcmConfig } from './config.js';
import type {
  IntxClientEvents,
  IntxAccountState,
  PlaceOrderParams,
  CancelOrderParams,
  FcmOrderFillEvent,
} from './types.js';
import type { FeeConfig } from './fee-config.js';
import { DEFAULT_FEE_CONFIG, FCM_FALLBACK_TAKER_RATE, FCM_FALLBACK_MAKER_RATE } from './fee-config.js';

const log = createModuleLogger('fcm-client');

export class IntxClient extends EventEmitter {
  private restClient: CBAdvancedTradeClient;
  private config: FcmConfig;

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
  /** Last funding rate received from futures_balance_summary channel. */
  private _lastFundingRate: number | null = null;

  /** Typed emit override — matches ENGINE_EVENT_MAP pattern. */
  override emit<K extends keyof IntxClientEvents>(
    event: K,
    ...args: IntxClientEvents[K]
  ): boolean {
    return super.emit(event, ...args);
  }

  constructor(config: FcmConfig) {
    super();
    if (!config.enabled) {
      throw new Error(
        'IntxClient instantiated with FCM_ENABLED=false. Check caller.',
      );
    }
    this.config = config;
    this.restClient = new CBAdvancedTradeClient({
      apiKey: config.apiKey!,
      apiSecret: config.apiSecret!,
    });
    // FCM_TESTNET: no real sandbox exists; this flag is for mock/dev paths only
    log.info(
      { testnet: config.testnet },
      'FcmClient initialized (FCM via Advanced Trade API)',
    );
  }

  get isStale(): boolean { return this._isStale; }

  /** Returns the last funding rate received from IntxClient, or null if none yet received. */
  getLastFundingRate(): number | null { return this._lastFundingRate; }

  // ── WebSocket public API ───────────────────────────────────────────

  /**
   * Connect WebSocket and subscribe to ticker and futures_balance_summary channels.
   * Call once — throws if already started.
   * Does NOT make live network calls at module load time.
   */
  async start(): Promise<void> {
    if (this.ws) throw new Error('FcmClient already started');
    this.stopped = false;
    this.ws = new WebsocketClient({
      apiKey: this.config.apiKey!,
      apiSecret: this.config.apiSecret!,
    });
    this._wireWsEvents();
    this._subscribe();
    log.info('FcmClient WebSocket started');
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
    log.info('FcmClient stopped');
  }

  // ── WebSocket private helpers ──────────────────────────────────────

  /** Subscribe to ticker (mark prices), futures_balance_summary, and user (order fills) channels. */
  private _subscribe(): void {
    const products = [this.config.btcProductId, this.config.ethProductId];
    // Ticker for mark prices on FCM products
    this.ws!.subscribe({ topic: 'ticker', payload: { product_ids: products } }, 'advTradeMarketData');
    // Futures balance summary for account-level updates
    this.ws!.subscribe({ topic: 'futures_balance_summary', payload: { product_ids: [] } }, 'advTradeUserData');
    // User data channel for order fills
    this.ws!.subscribe({ topic: 'user', payload: { product_ids: products } }, 'advTradeUserData');
  }

  /**
   * Explicitly re-subscribe to the user channel (e.g. after reconnect).
   * Already included in _subscribe(); exposed for idempotent re-subscription.
   */
  subscribeUserChannel(): void {
    if (!this.ws) throw new Error('FcmClient not started');
    const products = [this.config.btcProductId, this.config.ethProductId];
    this.ws.subscribe({ topic: 'user', payload: { product_ids: products } }, 'advTradeUserData');
  }

  /** Attach event listeners to the WebsocketClient instance. */
  private _wireWsEvents(): void {
    // Connection established
    this.ws!.on('open', () => {
      this.reconnectAttempts = 0;
      this._isStale = false;
      this.emit('connected');
      log.info('FCM WebSocket connected');
    });

    // Market data update
    this.ws!.on('update', (data: any) => {
      if (data?.channel === 'ticker' || data?.type === 'ticker') {
        // ticker events: data.events[].tickers[] or data.price etc.
        const events = Array.isArray(data.events) ? data.events : [data];
        for (const evt of events) {
          const tickers = Array.isArray(evt.tickers) ? evt.tickers : [evt];
          for (const t of tickers) {
            const productId = t.product_id ?? data.product_id;
            const price = t.price ?? t.mark_price ?? t.last_trade_price;
            if (productId && price) {
              this.emit('markPrice', {
                instrument: productId,
                markPrice: price,
                indexPrice: t.price ?? price,
                timestamp: Date.now(),
                isStale: this._isStale,
              });
            }
          }
        }
      } else if (data?.channel === 'futures_balance_summary') {
        // Funding rate from balance summary
        const summary = data?.events?.[0]?.fcm_balance_summary ?? data;
        if (summary !== undefined && summary !== null) {
          // FCM limitation: futures_balance_summary yields an account-level funding_hold aggregate,
          // not per-instrument 8h funding rates. No per-instrument funding rate WebSocket channel exists in FCM.
          // Emit on every summary message (even funding_hold=0) so the histogram stays live in paper mode.
          const fundingRate = String(summary.funding_hold ?? '0');
          this._lastFundingRate = Number(fundingRate);
          this.emit('fundingRate', {
            instrument: 'FCM',
            fundingRate,
            isFinal: false,
            timestamp: Date.now(),
            isStale: this._isStale,
          });
        }
      } else if (data?.channel === 'user') {
        const events = Array.isArray(data.events) ? data.events : [data];
        for (const evt of events) {
          const orders = Array.isArray(evt.orders) ? evt.orders : [];
          for (const o of orders) {
            if (o.status === 'FILLED' && o.order_id) {
              const fill: FcmOrderFillEvent = {
                orderId: o.order_id,
                clientOrderId: o.client_order_id ?? '',
                productId: o.product_id ?? '',
                side: o.side ?? 'BUY',
                filledSize: o.filled_size ?? o.base_size ?? '0',
                avgFillPrice: o.average_filled_price ?? '0',
                totalFees: o.total_fees ?? '0',
                timestamp: Date.now(),
              };
              this.emit('orderFill', fill);
            }
          }
        }
      } else {
        log.debug({ channel: data?.channel }, 'FCM WebSocket: unknown channel update');
      }
    });

    // Connection dropped
    this.ws!.on('close', () => {
      this._isStale = true;
      this.emit('disconnected');
      log.warn('FCM WebSocket disconnected — scheduling reconnect');
      this._scheduleReconnect();
    });

    // WebSocket error — log and let reconnect handle recovery
    this.ws!.on('error', (err: any) => {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err: message }, 'FCM WebSocket error');
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
        'FCM WebSocket max reconnect attempts exceeded — perp subsystem stopped',
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
      'FCM WebSocket reconnecting...',
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
   * Fetch FCM account state: futures balance summary and open positions.
   */
  async getAccountState(): Promise<IntxAccountState> {
    const [balanceSummary, positions] = await Promise.all([
      this.restClient.getFuturesBalanceSummary(),
      this.restClient.getFuturesPositions(),
    ]);
    log.info('FCM account state fetched');
    return {
      balances: (balanceSummary as any)?.balance_summary ?? balanceSummary,
      positions: (positions as any)?.positions ?? positions ?? [],
      summary: (balanceSummary as any)?.balance_summary ?? balanceSummary,
    };
  }

  /**
   * Fetch the FCM taker fee rate from Coinbase getTransactionSummary.
   *
   * Uses this.restClient (private) so callers never need to access restClient directly.
   * On any error or malformed response, logs a warning and returns DEFAULT_FEE_CONFIG.
   * Never throws — fee fetch failure must not abort startup.
   */
  async fetchFeeConfig(): Promise<FeeConfig> {
    try {
      const summary = await this.restClient.getTransactionSummary({
        product_type: 'FUTURE',
        product_venue: 'FCM',
      });
      const raw = (summary as any)?.fee_tier?.taker_fee_rate;
      const rawMaker = (summary as any)?.fee_tier?.maker_fee_rate;
      const takerRate = typeof raw === 'string' && raw.length > 0 ? parseFloat(raw) : NaN;
      if (!Number.isFinite(takerRate) || takerRate <= 0 || takerRate > 0.1) {
        log.warn({ raw }, 'fetchFeeConfig: malformed or missing taker_fee_rate — using fallback');
        return DEFAULT_FEE_CONFIG;
      }
      const makerRate =
        typeof rawMaker === 'string' && rawMaker.length > 0 ? parseFloat(rawMaker) : FCM_FALLBACK_MAKER_RATE;
      const makerFeeRate = Number.isFinite(makerRate) && makerRate >= 0 && makerRate <= 0.1
        ? makerRate
        : FCM_FALLBACK_MAKER_RATE;
      log.info({ takerFeeRate: takerRate, makerFeeRate }, 'FCM taker fee rate fetched from API');
      return { takerFeeRate: takerRate, makerFeeRate, source: 'api' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ err: message }, 'fetchFeeConfig: API call failed — using fallback rate');
      return DEFAULT_FEE_CONFIG;
    }
  }

  /**
   * Place an FCM futures order using the Advanced Trade submitOrder endpoint.
   */
  async placeOrder(params: PlaceOrderParams): Promise<{
    orderId: string;
    status: string;
    execQty: string;
    avgPrice: string;
    fee: string;
  }> {
    const clientOrderId = params.clientOrderId ?? crypto.randomUUID();
    const productId = params.productId ?? params.instrument;

    // Build order config based on type
    let orderConfiguration: Record<string, unknown>;
    if (params.orderType === 'MARKET') {
      if (params.side === 'BUY') {
        orderConfiguration = { market_market_ioc: { quote_size: params.size } };
      } else {
        orderConfiguration = { market_market_ioc: { base_size: params.size } };
      }
    } else {
      orderConfiguration = {
        limit_limit_gtc: {
          base_size: params.size,
          limit_price: params.limitPrice!,
          post_only: params.postOnly ?? false,
        },
      };
    }

    const req: Record<string, unknown> = {
      client_order_id: clientOrderId,
      product_id: productId,
      side: params.side,
      order_configuration: orderConfiguration,
    };

    if (params.closeOnly) {
      (req as any).close_position = true;
    }

    const response = await this.restClient.submitOrder(req as any);
    const successResp = (response as any)?.success_response ?? response;
    const orderId = successResp?.order_id ?? (response as any)?.order_id;

    if (!orderId) {
      throw new Error(`FCM submitOrder returned no order_id: ${JSON.stringify(response)}`);
    }

    log.info(
      {
        clientOrderId,
        exchangeOrderId: orderId,
        side: params.side,
        productId,
      },
      'FCM order placed',
    );

    return {
      orderId,
      status: successResp?.status ?? 'FILLED',
      execQty: successResp?.filled_size ?? params.size,
      avgPrice: successResp?.average_filled_price ?? '0',
      fee: successResp?.total_fees ?? '0',
    };
  }

  /**
   * Cancel a single FCM futures order.
   */
  async cancelOrder(params: CancelOrderParams): Promise<void> {
    try {
      await this.restClient.cancelOrders({ order_ids: [params.orderId] });
      log.info({ orderId: params.orderId }, 'FCM order cancelled');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ orderId: params.orderId, err: message }, 'FCM cancelOrder failed');
      throw err;
    }
  }

  /**
   * Batch cancel FCM futures orders by exchange order IDs.
   * Logs at warn on partial failure; throws to allow caller to handle.
   */
  async cancelOrders(orderIds: string[]): Promise<void> {
    if (orderIds.length === 0) return;
    try {
      await this.restClient.cancelOrders({ order_ids: orderIds });
      log.info({ count: orderIds.length }, 'FCM batch cancel complete');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ orderIds, err: message }, 'FCM batch cancel partial failure');
      throw err;
    }
  }

  /**
   * Place a stop-limit (stop_limit_stop_limit_gtc) FCM futures order.
   * Used for trailing stop placement — stop triggers at stopPrice, executes at limitPrice.
   *
   * stop_direction values:
   *  - 'STOP_DIRECTION_STOP_DOWN' — triggers when price falls to stopPrice (long exit)
   *  - 'STOP_DIRECTION_STOP_UP'   — triggers when price rises to stopPrice (short exit)
   */
  async placeStopOrder(params: {
    productId: string;
    side: 'BUY' | 'SELL';
    size: string;
    stopPrice: string;
    limitPrice: string;
    stopDirection: string;
    clientOrderId?: string;
  }): Promise<{ orderId: string }> {
    const clientOrderId = params.clientOrderId ?? crypto.randomUUID();
    const req = {
      client_order_id: clientOrderId,
      product_id: params.productId,
      side: params.side,
      order_configuration: {
        stop_limit_stop_limit_gtc: {
          base_size: params.size,
          stop_price: params.stopPrice,
          limit_price: params.limitPrice,
          stop_direction: params.stopDirection,
        },
      },
    };
    const response = await this.restClient.submitOrder(req as any);
    const successResp = (response as any)?.success_response ?? response;
    const orderId = successResp?.order_id ?? (response as any)?.order_id;
    if (!orderId) throw new Error(`placeStopOrder: no order_id: ${JSON.stringify(response)}`);
    log.info({ clientOrderId, exchangeOrderId: orderId }, 'FCM stop order placed');
    return { orderId };
  }
}
