/**
 * Tournament module barrel export.
 *
 * Provides walk-forward tournament evaluation, strategy ranking,
 * automatic activation of top-N strategies, and periodic re-evaluation.
 */

export * from './types.js';
export * from './config.js';
export { TournamentRunner } from './tournament-runner.js';
export { TournamentStore } from './tournament-store.js';
export { ActivationBridge } from './activation-bridge.js';
export type { ActivationResult, EngineHandle } from './activation-bridge.js';
export { TournamentScheduler } from './tournament-scheduler.js';
export type { SchedulerConfig } from './tournament-scheduler.js';
