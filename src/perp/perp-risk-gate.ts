/**
 * PerpRiskGate — pre-entry risk guard for perpetual futures positions.
 *
 * Runs four sequential checks before any entry (live or paper):
 *  1. Margin utilization ceiling — rejects if current utilization >= configured ceiling
 *  2. Total exposure cap — rejects if total open notional would exceed account value * perpExposureCapPct
 *  3. Per-trade max loss — rejects if proposedMaxLoss > account value * perpMaxLossPct
 *  4. Fee drag — rejects if expectedGain <= round-trip taker fee (2 * takerFeeRate * notional)
 *
 * Balance summary REST calls are cached for 5 seconds to avoid per-entry hammering.
 * In paper mode, a mock healthy balance is returned so REST calls are never made.
 *
 * Satisfies: MARGIN-04, RISK-01, RISK-02
 */

import { d, ZERO } from '../core/decimal.js';
import { createModuleLogger } from '../core/logger.js';
import { DEFAULT_FEE_CONFIG } from './fee-config.js';
import type { FeeConfig } from './fee-config.js';
import type { FcmConfig } from './config.js';
import type { IntxClient } from './intx-client.js';
import type { PerpStateStore } from './perp-state-store.js';
import type {
  RiskGateResult,
  PerpRiskGateParams,
  IntxAccountState,
} from './types.js';

const log = createModuleLogger('perp-risk-gate');

/** Options for PerpRiskGate constructor. */
export interface PerpRiskGateOptions {
  intxClient: IntxClient;
  stateStore: PerpStateStore;
  config: FcmConfig;
  feeConfig?: FeeConfig;    // optional — defaults to DEFAULT_FEE_CONFIG when absent
  /** When true, skips all REST calls — uses mock healthy balance and in-process notional. Default: false. */
  paperMode?: boolean;
}

/** Cached balance shape for reuse within the 5-second window. */
interface CachedBalance {
  initialMargin: string;
  availableMargin: string;
  positions: IntxAccountState['positions'];
}

const BALANCE_CACHE_TTL_MS = 5000;

export class PerpRiskGate {
  private _intxClient: IntxClient;
  private _stateStore: PerpStateStore;
  private _config: FcmConfig;
  private _feeConfig: FeeConfig;
  private _paperMode: boolean;

  private _cachedBalance: CachedBalance | null = null;
  private _lastBalanceFetchMs = 0;

  // -- Daily loss tracking --
  private _dailyLossUsd: number = 0;
  private _dailyLossDateUtc: string = '';  // 'YYYY-MM-DD' format for reset detection

  constructor(options: PerpRiskGateOptions) {
    this._intxClient = options.intxClient;
    this._stateStore = options.stateStore;
    this._config = options.config;
    this._feeConfig = options.feeConfig ?? DEFAULT_FEE_CONFIG;
    this._paperMode = options.paperMode ?? false;
  }

  // ── Internal: balance cache ──────────────────────────────────────────────

  /**
   * Fetch (or return cached) balance summary.
   *
   * - Paper mode: returns a mock healthy balance — all utilization/margin checks pass.
   * - Live mode: calls intxClient.getAccountState() at most once per 5-second window.
   */
  private async _fetchBalance(): Promise<CachedBalance> {
    if (this._paperMode) {
      // Paper mode always returns a mock healthy balance — no REST calls.
      return {
        initialMargin: '0',
        availableMargin: '1000000',
        positions: [],
      };
    }

    const now = Date.now();
    if (
      this._cachedBalance !== null &&
      now - this._lastBalanceFetchMs < BALANCE_CACHE_TTL_MS
    ) {
      return this._cachedBalance;
    }

    const accountState = await this._intxClient.getAccountState();
    const balances = accountState.balances as {
      initial_margin?: { value?: string };
      available_margin?: { value?: string };
    };

    const initialMargin = balances?.initial_margin?.value ?? '0';
    const availableMargin = balances?.available_margin?.value ?? '0';

    this._cachedBalance = {
      initialMargin,
      availableMargin,
      positions: accountState.positions ?? [],
    };
    this._lastBalanceFetchMs = now;

    return this._cachedBalance;
  }

  // ── Daily loss tracking ──────────────────────────────────────────────────

  /**
   * Reset daily loss accumulator if the UTC date has changed since last recording.
   */
  private _ensureDailyReset(): void {
    const todayUtc = new Date(Date.now()).toISOString().slice(0, 10);  // 'YYYY-MM-DD'
    if (todayUtc !== this._dailyLossDateUtc) {
      this._dailyLossUsd = 0;
      this._dailyLossDateUtc = todayUtc;
    }
  }

  /**
   * Record a realized loss from a closed position.
   * Only positive values (actual losses) accumulate. Profits (negative values) are ignored.
   * Call this after every position close to track daily drawdown.
   *
   * @param lossUsd - The realized loss in USD. Positive = loss, negative = profit (ignored).
   */
  recordRealizedLoss(lossUsd: number): void {
    if (lossUsd <= 0) return;  // Only track actual losses, ignore profits
    this._ensureDailyReset();
    this._dailyLossUsd += lossUsd;
  }

  // ── Public: check ────────────────────────────────────────────────────────

  /**
   * Run four sequential risk checks.
   * Returns on first failure — subsequent checks are not evaluated.
   *
   * @param params - Proposed trade parameters (instrument, notional, max loss, account value, expected gain)
   * @returns RiskGateResult with approved:true or approved:false + rejectReason
   */
  async check(params: PerpRiskGateParams): Promise<RiskGateResult> {
    // ── Check 1: Margin utilization ceiling ──────────────────────────────────
    const balance = await this._fetchBalance();
    const initialMargin = d(balance.initialMargin);
    const availableMargin = d(balance.availableMargin);
    const totalCapacity = initialMargin.plus(availableMargin);
    const utilization = totalCapacity.isZero()
      ? ZERO
      : initialMargin.div(totalCapacity);

    if (utilization.gte(d(String(this._config.marginUtilizationCeiling)))) {
      log.warn(
        {
          utilization: utilization.toFixed(4),
          ceiling: this._config.marginUtilizationCeiling,
          instrument: params.instrument,
        },
        'MARGIN_UTILIZATION_EXCEEDED: perp entry rejected',
      );
      return {
        approved: false,
        rejectReason: 'MARGIN_UTILIZATION_EXCEEDED',
        details: {
          utilization: utilization.toFixed(4),
          ceiling: String(this._config.marginUtilizationCeiling),
        },
      };
    }

    // ── Check 2: Total exposure cap ──────────────────────────────────────────
    let totalNotional = d(params.proposedNotional);

    if (this._paperMode) {
      // Paper mode: sum notional from in-process sessions (no REST positions)
      const openSessions = this._stateStore.getAllOpenSessions();
      for (const session of openSessions) {
        totalNotional = totalNotional.plus(
          d(session.size).mul(d(session.entryPrice)),
        );
      }
    } else {
      // Live mode: sum notional from balance positions (already fetched in step 1)
      for (const pos of balance.positions) {
        const contracts = pos.number_of_contracts ?? '0';
        const price = pos.current_price ?? '0';
        totalNotional = totalNotional.plus(d(String(contracts)).mul(d(String(price))));
      }
    }

    const exposureCap = d(params.accountValue).mul(
      d(String(this._config.perpExposureCapPct)),
    );

    if (totalNotional.gte(exposureCap)) {
      log.warn(
        {
          totalNotional: totalNotional.toFixed(2),
          cap: exposureCap.toFixed(2),
          instrument: params.instrument,
        },
        'EXPOSURE_CAP_EXCEEDED: perp entry rejected',
      );
      return {
        approved: false,
        rejectReason: 'EXPOSURE_CAP_EXCEEDED',
        details: {
          totalNotional: totalNotional.toFixed(2),
          cap: exposureCap.toFixed(2),
        },
      };
    }

    // ── Check 3: Per-trade max loss ──────────────────────────────────────────
    const maxAllowedLoss = d(params.accountValue).mul(
      d(String(this._config.perpMaxLossPct)),
    );

    if (d(params.proposedMaxLoss).gte(maxAllowedLoss)) {
      log.warn(
        {
          proposedMaxLoss: params.proposedMaxLoss,
          maxAllowed: maxAllowedLoss.toFixed(2),
          instrument: params.instrument,
        },
        'MAX_LOSS_EXCEEDED: perp entry rejected',
      );
      return {
        approved: false,
        rejectReason: 'MAX_LOSS_EXCEEDED',
        details: {
          proposedMaxLoss: params.proposedMaxLoss,
          maxAllowed: maxAllowedLoss.toFixed(2),
        },
      };
    }

    // ── Check 4: Fee drag ────────────────────────────────────────────────────
    const takerRate = d(String(this._feeConfig.takerFeeRate));
    const roundTripFee = takerRate.mul(d('2')).mul(d(params.proposedNotional));
    if (d(params.expectedGain).lte(roundTripFee)) {
      log.warn(
        {
          expectedGain: params.expectedGain,
          roundTripFee: roundTripFee.toFixed(6),
          instrument: params.instrument,
        },
        'FEE_DRAG_EXCESSIVE: perp entry rejected',
      );
      return {
        approved: false,
        rejectReason: 'FEE_DRAG_EXCESSIVE',
        details: {
          expectedGain: params.expectedGain,
          roundTripFee: roundTripFee.toFixed(6),
        },
      };
    }

    // ── Check 5: Daily loss cap ──────────────────────────────────────────────
    this._ensureDailyReset();
    const maxDailyLoss = this._config.maxDailyLossUsd;
    if (maxDailyLoss !== undefined && this._dailyLossUsd >= maxDailyLoss) {
      log.warn(
        {
          dailyLoss: this._dailyLossUsd.toFixed(2),
          cap: String(maxDailyLoss),
          instrument: params.instrument,
        },
        'DAILY_LOSS_CAP_EXCEEDED: perp entry rejected',
      );
      return {
        approved: false,
        rejectReason: 'DAILY_LOSS_CAP_EXCEEDED',
        details: {
          dailyLoss: this._dailyLossUsd.toFixed(2),
          cap: String(maxDailyLoss),
        },
      };
    }

    // ── All checks passed ────────────────────────────────────────────────────
    log.info(
      {
        instrument: params.instrument,
        utilization: utilization.toFixed(4),
        totalNotional: totalNotional.toFixed(2),
        proposedMaxLoss: params.proposedMaxLoss,
        expectedGain: params.expectedGain,
        roundTripFee: roundTripFee.toFixed(6),
      },
      'PerpRiskGate: entry approved',
    );

    return { approved: true, details: {} };
  }
}
