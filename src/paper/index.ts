/**
 * Paper trading module barrel export.
 *
 * Provides the complete paper trading system: real-time data feed,
 * trading engine with simulated fills, session persistence, and
 * Coinbase sandbox validation.
 */

// Types
export type {
  PaperTradingConfig,
  PaperSession,
  PaperTradingResult,
  LiveDataFeedEvents,
} from './types.js';

// Config
export { paperConfigSchema, parsePaperConfig } from './config.js';

// Core components
export { LiveDataFeed } from './live-data-feed.js';
export { SessionStore } from './session-store.js';
export { SandboxValidator } from './sandbox-validator.js';
