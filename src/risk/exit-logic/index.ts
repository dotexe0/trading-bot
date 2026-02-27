/**
 * Exit logic module barrel export.
 *
 * Re-exports all exit behavior classes, configuration utilities,
 * and types for the exit logic engine.
 */

// ── Core manager ─────────────────────────────────────────────────────
export { ExitLogicManager } from './manager.js';

// ── Individual exit behaviors ────────────────────────────────────────
export { AtrDynamicStop } from './atr-stop.js';
export { TrailingProfitExit } from './trailing.js';
export { PartialPositionExit } from './partial.js';
export { TimeBasedExit } from './time.js';

// ── Configuration ────────────────────────────────────────────────────
export { exitConfigSchema, parseExitConfig } from './config.js';

// ── Types ────────────────────────────────────────────────────────────
export type {
  ExitAction,
  ExitActionType,
  ExitConfig,
  PositionState,
  TrailingExitConfig,
  PartialExitConfig,
  TimeExitConfig,
  AtrStopConfig,
} from './types.js';
