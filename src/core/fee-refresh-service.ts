/**
 * FeeRefreshService — periodically re-fetches spot and FCM fee tiers from Coinbase
 * and propagates updated rates to live trading gates and dashboard fee state.
 *
 * Coinbase fee tiers are based on rolling 30-day volume and can change mid-month,
 * so stale fee rates would silently mis-price the fee-drag gate and P&L projections.
 *
 * Refresh frequency: 6 hours for both (volume resets at midnight UTC).
 * Never throws — all errors are logged and the cached rate is left unchanged.
 */

import { CBAdvancedTradeClient } from 'coinbase-api';
import { createModuleLogger } from './logger.js';
import type { SpotSignalGate } from '../risk/spot-signal-gate.js';
import type { IntxClient } from '../perp/intx-client.js';

const log = createModuleLogger('fee-refresh');

/** Mutable live fee snapshot — mutated in-place so all holders see updates. */
export interface LiveFeeSnapshot {
  takerFeeRate: number;
  makerFeeRate: number;
  source: 'api' | 'fallback';
}

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

export class FeeRefreshService {
  private _timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly cbClient: CBAdvancedTradeClient,
    private readonly spotGate: SpotSignalGate,
    private readonly spotFees: LiveFeeSnapshot,
    private readonly intxClient?: IntxClient,
    private readonly fcmFees?: LiveFeeSnapshot,
  ) {}

  /**
   * Start the periodic refresh. Fires immediately on first call, then every intervalMs.
   */
  start(intervalMs = SIX_HOURS_MS): void {
    void this._refresh(); // immediate first run
    this._timer = setInterval(() => void this._refresh(), intervalMs);
  }

  stop(): void {
    if (this._timer !== undefined) {
      clearInterval(this._timer);
      this._timer = undefined;
    }
  }

  private async _refresh(): Promise<void> {
    await Promise.allSettled([
      this._refreshSpot(),
      this.intxClient ? this._refreshFcm() : Promise.resolve(),
    ]);
  }

  private async _refreshSpot(): Promise<void> {
    const prev = this.spotFees.takerFeeRate;
    try {
      const summary = await this.cbClient.getTransactionSummary({ product_type: 'SPOT' });
      const rawTaker = (summary as any)?.fee_tier?.taker_fee_rate;
      const rawMaker = (summary as any)?.fee_tier?.maker_fee_rate;
      const taker = typeof rawTaker === 'string' ? parseFloat(rawTaker) : NaN;
      const maker = typeof rawMaker === 'string' ? parseFloat(rawMaker) : NaN;

      if (!Number.isFinite(taker) || taker <= 0 || taker >= 0.1) {
        log.warn(`Spot fee refresh: unexpected taker value "${rawTaker}", keeping ${(prev * 100).toFixed(4)}%`);
        return;
      }

      this.spotFees.takerFeeRate = taker;
      if (Number.isFinite(maker) && maker > 0) this.spotFees.makerFeeRate = maker;
      this.spotFees.source = 'api';
      this.spotGate.updateTakerFeeRate(taker);

      if (Math.abs(taker - prev) > 0.000001) {
        log.info(`Spot fee tier changed: ${(prev * 100).toFixed(4)}% → ${(taker * 100).toFixed(4)}% taker`);
      } else {
        log.debug(`Spot fee confirmed: ${(taker * 100).toFixed(4)}% taker`);
      }
    } catch (err) {
      log.warn(`Spot fee refresh failed (using cached ${(prev * 100).toFixed(4)}%): ${String(err)}`);
    }
  }

  private async _refreshFcm(): Promise<void> {
    if (!this.intxClient || !this.fcmFees) return;
    const prev = this.fcmFees.takerFeeRate;
    try {
      const feeConfig = await this.intxClient.fetchFeeConfig();
      this.fcmFees.takerFeeRate = feeConfig.takerFeeRate;
      this.fcmFees.makerFeeRate = feeConfig.makerFeeRate;
      this.fcmFees.source = (feeConfig.source as 'api' | 'fallback') ?? 'api';

      if (Math.abs(feeConfig.takerFeeRate - prev) > 0.000001) {
        log.info(`FCM fee tier changed: ${(prev * 100).toFixed(4)}% → ${(feeConfig.takerFeeRate * 100).toFixed(4)}% taker`);
      } else {
        log.debug(`FCM fee confirmed: ${(feeConfig.takerFeeRate * 100).toFixed(4)}% taker`);
      }
    } catch (err) {
      log.warn(`FCM fee refresh failed (using cached ${(prev * 100).toFixed(4)}%): ${String(err)}`);
    }
  }
}
