/**
 * IntxClient — REST wrapper for Coinbase International Exchange (INTX).
 *
 * Provides:
 *  - getAccountState(): single round-trip to fetch balances, positions, summary
 *  - placeOrder(): stub — full implementation in Phase 27
 *  - cancelOrder(): stub — full implementation in Phase 27
 *
 * WebSocket streaming is added in plan 26-02.
 * Extends EventEmitter with typed IntxClientEvents for ws events (Phase 26-02).
 */

import { EventEmitter } from 'node:events';
import { CBInternationalClient } from 'coinbase-api';
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
