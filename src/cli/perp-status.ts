/**
 * CLI entry point for INTX account status.
 *
 * Usage: npm run perp:status
 *        npm run perp:status -- --json
 *
 * Requires INTX_ENABLED=true and valid INTX credentials in .env.
 * Routes to testnet if INTX_TESTNET=true.
 */

import { Command } from 'commander';
import { loadConfig } from '../core/config.js';
import { IntxClient } from '../perp/index.js';
import { out } from './shared/output.js';

const program = new Command();

program
  .name('perp:status')
  .description('Show INTX account balance, margin, and open positions')
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
      out.error('INTX is disabled. Set INTX_ENABLED=true in .env to use perpetual futures.');
      process.exit(1);
    }

    const client = new IntxClient(config.intx);

    try {
      const state = await client.getAccountState();

      if (opts.json) {
        console.log(JSON.stringify(state, null, 2));
        return;
      }

      out.banner('INTX Account Status');
      out.table('Network', config.intx.testnet ? 'Testnet (sandbox)' : 'Mainnet');
      out.table('Portfolio ID', config.intx.portfolioId ?? '—');

      out.info('--- Summary ---');
      console.log(JSON.stringify(state.summary, null, 2));

      out.info('--- Balances ---');
      console.log(JSON.stringify(state.balances, null, 2));

      out.info('--- Open Positions ---');
      if (Array.isArray(state.positions) && state.positions.length === 0) {
        out.info('No open positions');
      } else {
        console.log(JSON.stringify(state.positions, null, 2));
      }
    } catch (err) {
      out.error(`Failed to fetch INTX account state: ${(err as Error).message}`);
      process.exit(1);
    }
  });

await program.parseAsync(process.argv);
