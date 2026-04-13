/**
 * ActivationBridge -- connects tournament results to paper/live trading
 * engines. Stops previously active strategies, starts new top-N strategies
 * via an injected engine factory, and persists activation records.
 *
 * The engineFactory callback keeps this module decoupled from concrete
 * engine types (SpotTradingEngine paper/live). The caller
 * provides the factory that knows how to construct the right engine.
 */

import { createModuleLogger } from '../core/logger.js';
import type { TournamentConfig } from './config.js';
import type { TournamentResult, LeaderboardEntry } from './types.js';
import type { TournamentStore } from './tournament-store.js';

const log = createModuleLogger('activation-bridge');

// ── Types ────────────────────────────────────────────────────────────

/** Result from an activation cycle. */
export interface ActivationResult {
  activated: Array<{ strategyName: string; rank: number; sessionId: string }>;
  deactivated: number;
  mode: 'paper' | 'live';
}

/** Handle to a running engine spawned by the bridge. */
export interface EngineHandle {
  sessionId: string;
  strategyName: string;
  stop: () => Promise<void>;
}

// ── ActivationBridge ─────────────────────────────────────────────────

export class ActivationBridge {
  private readonly store: TournamentStore;
  private readonly engines: Map<string, EngineHandle> = new Map();

  constructor(deps: { store: TournamentStore }) {
    this.store = deps.store;
  }

  /**
   * Activate top-N strategies from a tournament result.
   *
   * 1. Stop all currently tracked engines.
   * 2. Mark DB records as deactivated.
   * 3. Start new engines via the factory callback.
   * 4. Persist activation records with session IDs.
   */
  async activate(
    result: TournamentResult,
    mode: 'paper' | 'live',
    engineFactory: (
      strategyConfig: Record<string, unknown>,
      tournamentConfig: TournamentConfig,
    ) => Promise<EngineHandle>,
  ): Promise<ActivationResult> {
    const topN = result.config.topN;
    const topEntries = result.leaderboard.slice(0, topN);

    // 1. Stop all currently tracked engines
    const deactivated = await this.stopAllEngines();

    // 2. Mark DB records as deactivated
    this.store.deactivateAll(mode);

    // 3. Start new engines for each top-N entry
    const activated: ActivationResult['activated'] = [];

    for (const entry of topEntries) {
      try {
        const handle = await engineFactory(entry.strategyConfig, result.config);
        this.engines.set(entry.strategyName, handle);
        activated.push({
          strategyName: entry.strategyName,
          rank: entry.rank,
          sessionId: handle.sessionId,
        });
        log.info(
          {
            strategy: entry.strategyName,
            rank: entry.rank,
            oosSharpe: entry.oosMetrics.sharpeRatio.toFixed(4),
            sessionId: handle.sessionId,
          },
          'Strategy activated',
        );
      } catch (err) {
        log.error(
          { strategy: entry.strategyName, err },
          'Failed to activate strategy, continuing with others',
        );
      }
    }

    // 4. Persist activation records with session IDs
    this.store.saveActiveStrategies(result.id, topEntries, mode);

    const activationResult: ActivationResult = {
      activated,
      deactivated,
      mode,
    };

    log.info(
      {
        activated: activated.length,
        deactivated,
        mode,
        tournamentId: result.id,
      },
      'Activation cycle complete',
    );

    return activationResult;
  }

  /**
   * Deactivate all currently tracked engines.
   * Returns the number of engines stopped.
   */
  async deactivateAll(): Promise<number> {
    return this.stopAllEngines();
  }

  /**
   * Register an engine handle directly without stopping existing engines.
   * Used when activating strategies across multiple pairs simultaneously —
   * unlike activate(), this does not call stopAllEngines() first.
   */
  addEngine(strategyName: string, handle: EngineHandle): void {
    this.engines.set(strategyName, handle);
  }

  /**
   * Get a copy of currently active engine handles.
   */
  getActiveEngines(): Map<string, EngineHandle> {
    return new Map(this.engines);
  }

  // ── Private ──────────────────────────────────────────────────────

  private async stopAllEngines(): Promise<number> {
    let count = 0;
    for (const [name, handle] of this.engines) {
      try {
        await handle.stop();
        count++;
      } catch (err) {
        log.error({ strategy: name, err }, 'Error stopping engine');
        count++; // Still count it as deactivated
      }
    }
    this.engines.clear();
    return count;
  }
}
