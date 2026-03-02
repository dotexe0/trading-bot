/**
 * ExitConfigOptimizer -- grid search over exit parameter combinations.
 *
 * Searches all combinations of ATR multiples, trailing activation pcts,
 * partial target pcts, and max candles held. For each combo, runs
 * walk-forward validation and selects the one with the highest
 * out-of-sample profit factor (subject to MIN_TRADES_FLOOR).
 */

import crypto from 'node:crypto';
import { createModuleLogger } from '../core/logger.js';
import type { Candle } from '../core/types.js';
import type { BacktestConfig } from '../backtest/types.js';
import type { WalkForwardRunner, WalkForwardConfig } from '../backtest/walk-forward.js';
import type { ExitConfig } from '../risk/exit-logic/types.js';
import { parseExitConfig } from '../risk/exit-logic/config.js';
import type { GridSpec, OptimizedExitParams, OptimizerConfig } from './types.js';

const log = createModuleLogger('exit-config-optimizer');

// ── Default Grid ───────────────────────────────────────────────────

/** Default grid search parameter space. */
export const DEFAULT_GRID: GridSpec = {
  atrMultiples: [1.5, 2.0, 2.5],
  trailActivatePcts: [0.01, 0.02, 0.03],
  partialTargetPcts: [0.02, 0.03, 0.05],
  maxCandlesHeld: [10, 20, 40],
};

// ── Hash Function ──────────────────────────────────────────────────

/**
 * Hash a strategy config, excluding the `exits` block.
 *
 * This prevents infinite re-optimization: if optimized exits are loaded
 * back into the config and the hash included them, the hash would change
 * every time, triggering a new optimization.
 *
 * Keys are sorted alphabetically for deterministic hashing.
 */
export function hashStrategyConfig(config: Record<string, unknown>): string {
  const { exits: _exits, ...baseParams } = config;
  const sorted = Object.fromEntries(
    Object.entries(baseParams).sort(([a], [b]) => a.localeCompare(b)),
  );
  return crypto.createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

// ── Optimizer Class ────────────────────────────────────────────────

export class ExitConfigOptimizer {
  private readonly walkForwardRunner: WalkForwardRunner;

  constructor(deps: { walkForwardRunner: WalkForwardRunner }) {
    this.walkForwardRunner = deps.walkForwardRunner;
  }

  /**
   * Run grid search over exit parameters using walk-forward validation.
   *
   * For each combination in the grid, runs WalkForwardRunner.run() and
   * evaluates the aggregate out-of-sample profit factor. Combos with
   * fewer than minTradesFloor validate trades are skipped.
   *
   * @returns OptimizedExitParams with the best combo (or fallback if all skipped)
   */
  optimize(
    baseConfig: BacktestConfig,
    strategyName: string,
    candles: Candle[],
    wfConfig: WalkForwardConfig,
    optimizerConfig: OptimizerConfig,
  ): OptimizedExitParams {
    const { grid, minTradesFloor } = optimizerConfig;

    let bestPf = -Infinity;
    let bestExitConfig: ExitConfig | null = null;
    let combosSearched = 0;
    let combosSkipped = 0;

    for (const atrMult of grid.atrMultiples) {
      for (const trailPct of grid.trailActivatePcts) {
        for (const partialPct of grid.partialTargetPcts) {
          for (const maxCandles of grid.maxCandlesHeld) {
            combosSearched++;

            // Build exit config for this combination
            const exitConfig = parseExitConfig({
              exits: {
                atrStop: {
                  enabled: true,
                  atrPeriod: 14,
                  atrMultiple: atrMult,
                },
                trailing: {
                  enabled: true,
                  activateAfterPct: trailPct,
                  trailAtrMultiple: atrMult,
                },
                partial: {
                  enabled: true,
                  profitTargetPct: partialPct,
                  closeFraction: 0.5,
                },
                time: {
                  enabled: true,
                  maxCandlesHeld: Math.round(maxCandles),
                  pnlThresholdPct: 0.0,
                },
              },
            });

            // Inject exits into strategy config
            const configWithExits: BacktestConfig = {
              ...baseConfig,
              strategyConfig: {
                ...(baseConfig.strategyConfig as Record<string, unknown>),
                exits: exitConfig.exits,
              },
            };

            // Run walk-forward validation
            const result = this.walkForwardRunner.run(
              configWithExits,
              wfConfig,
              candles,
            );

            // MIN_TRADES_FLOOR guard: skip unreliable results
            if (result.aggregateValidateMetrics.totalTrades < minTradesFloor) {
              combosSkipped++;
              continue;
            }

            // Compare profit factor (Decimal -> number)
            const pf = result.aggregateValidateMetrics.profitFactor.toNumber();
            if (pf > bestPf) {
              bestPf = pf;
              bestExitConfig = exitConfig;
            }
          }
        }
      }
    }

    // Fallback: if all combos were skipped, use all-disabled exits
    const finalExitConfig = bestExitConfig ?? parseExitConfig({});

    log.info(
      { strategyName, combosSearched, combosSkipped, bestPf: bestPf === -Infinity ? 0 : bestPf },
      'Grid search complete',
    );

    return {
      strategyName,
      strategyConfigHash: '', // Caller fills before store.save()
      exitConfig: finalExitConfig,
      profitFactor: bestPf === -Infinity ? 0 : bestPf,
      searchedAt: Date.now(),
    };
  }
}
