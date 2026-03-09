/**
 * CLI entry point for FCM futures account status.
 *
 * Usage: npm run perp:status
 *        npm run perp:status -- --json
 *
 * Requires FCM_ENABLED=true in .env.
 * FCM reuses COINBASE_API_KEY_NAME / COINBASE_API_KEY_SECRET — no separate keys needed.
 * Routes to testnet if FCM_TESTNET=true.
 */

import { Command } from 'commander';
import { loadConfig } from '../core/config.js';
import { IntxClient } from '../perp/index.js';
import { out } from './shared/output.js';

const program = new Command();

program
  .name('perp:status')
  .description('Show FCM futures account balance, margin, and open positions')
  .option('--json', 'Output raw JSON instead of formatted table')
  .action(async (opts) => {
    let config;
    try {
      config = loadConfig();
    } catch (err) {
      out.error(`Config error: ${(err as Error).message}`);
      process.exit(1);
    }

    if (!config.intx.enabled) {
      out.error('FCM is disabled. Set FCM_ENABLED=true in .env to use perpetual futures.');
      process.exit(1);
    }

    const client = new IntxClient(config.intx);

    try {
      const state = await client.getAccountState();

      if (opts.json) {
        console.log(JSON.stringify(state, null, 2));
        return;
      }

      out.banner('FCM Futures Account Status');
      out.table('Network', config.intx.testnet ? 'FCM Testnet' : 'FCM Mainnet (CDE)');

      out.info('--- FCM Balance Summary ---');
      console.log(JSON.stringify(state.summary, null, 2));

      out.info('--- FCM Balance Summary (balances) ---');
      console.log(JSON.stringify(state.balances, null, 2));

      out.info('--- Open FCM Positions ---');
      if (Array.isArray(state.positions) && state.positions.length === 0) {
        out.info('No open positions');
      } else {
        console.log(JSON.stringify(state.positions, null, 2));
      }
    } catch (err) {
      out.error(`Failed to fetch FCM account state: ${(err as Error).message}`);
      process.exit(1);
    }
  });

await program.parseAsync(process.argv);
