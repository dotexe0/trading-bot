/**
 * CLI entry point for perp paper mode (mark-price simulation).
 *
 * Usage: npm run perp:paper
 *
 * Requires INTX_ENABLED=true and valid INTX credentials in .env.
 * Routes to testnet if INTX_TESTNET=true.
 *
 * The engine runs in passive monitoring mode (no onSignal provided) —
 * it watches mark price updates and triggers LIQUIDATION_RISK emergency
 * close events only. No real orders are placed.
 */

import { loadConfig } from '../core/config.js';
import { IntxClient, PerpTradingEngine, PaperPerpOrderExecutor, PerpStateStore } from '../perp/index.js';
import { createModuleLogger } from '../core/logger.js';

const log = createModuleLogger('perp-paper');

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(`Config error: ${(err as Error).message}`);
  process.exit(1);
}

if (!config.intx.enabled) {
  console.error(
    'FCM is disabled. Set FCM_ENABLED=true in .env to use perpetual futures.',
  );
  process.exit(1);
}

const intxClient = new IntxClient(config.intx);
const stateStore = new PerpStateStore({ dbPath: config.perpDatabase.path });
const paperEngine = new PerpTradingEngine({
  mode: 'paper',
  executor: new PaperPerpOrderExecutor(),
  intxClient,
  stateStore,
  config: config.intx,
  tradingPair: 'BTC-USD',
  timeframe: '1h',
});

// Wire up event listeners before starting
intxClient.on('markPrice', (evt) => {
  log.debug({ ...evt }, '[PAPER] mark price');
});

paperEngine.on('emergencyClose', (session, detail) => {
  log.warn({ ...detail }, '[PAPER] LIQUIDATION_RISK: emergency close');
});

paperEngine.on('liquidationDistance', (detail) => {
  log.debug(detail, '[PAPER] liq distance');
});

// Start WebSocket and paper engine
intxClient.on('error', (err: Error) => {
  log.warn({ err: err.message }, '[PAPER] IntxClient error — continuing');
});
await intxClient.start();
paperEngine.start();

log.info('[PAPER] FCM perp paper mode started — monitoring mark price stream (Ctrl+C to stop)');

// Graceful shutdown on SIGINT/SIGTERM
function shutdown(): void {
  log.info('[PAPER] Stopping...');
  paperEngine.stop();
  intxClient.stop().catch((err) => {
    log.warn({ err: (err as Error).message }, '[PAPER] Error stopping intxClient');
  });
  stateStore.close();
  log.info('[PAPER] Stopped');
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
