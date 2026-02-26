/**
 * CLI entry point for starting the dashboard server.
 *
 * Usage: npm run dashboard
 *        npm run dashboard -- --port 8080 --dev
 *
 * Runs until SIGINT (Ctrl+C). Serves REST API and WebSocket on the
 * configured port.
 */

import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { Command } from 'commander';
import { bootstrap } from './shared/bootstrap.js';
import { out } from './shared/output.js';
import { createDashboardServer } from '../dashboard/server/index.js';
import { dashboardConfigSchema } from '../dashboard/server/config.js';
import { SessionStore } from '../paper/session-store.js';
import { LiveStateStore } from '../live/state-store.js';
import { TournamentStore } from '../tournament/tournament-store.js';
import { ActivationBridge } from '../tournament/activation-bridge.js';
import { RiskManager } from '../risk/risk-manager.js';
import { parseRiskConfig } from '../risk/config.js';
import { CorrelationStore } from '../correlation/correlation-store.js';
import { BacktestStore } from '../backtest/backtest-store.js';
import { CandleRepository } from '../data/storage/candle-repo.js';

const program = new Command();

program
  .name('dashboard')
  .description('Start the dashboard web server (REST API + WebSocket + UI)')
  .option('--port <port>', 'Server port', '3001')
  .option('--dev', 'Dev mode: spawn Vite dev server + API server (open http://localhost:5173)')
  .action(async (opts) => {
    const { config, dbConn } = bootstrap();

    try {
      const port = parseInt(opts.port, 10);
      const isDev = opts.dev === true;

      // Dev mode: spawn Vite dev server alongside the API server
      if (isDev) {
        const vite = spawn('npm', ['--prefix', 'src/dashboard/ui', 'run', 'dev'], {
          stdio: 'inherit',
          shell: process.platform === 'win32',
        });
        vite.on('error', (err) => out.warn(`Vite error: ${err.message}`));
        process.on('exit', () => { try { vite.kill(); } catch { /* ignore */ } });
      }

      // Prod mode: auto-build UI if dist is missing
      if (!isDev && !fs.existsSync('dist/dashboard')) {
        out.info('Building dashboard UI...');
        spawnSync('npm', ['--prefix', 'src/dashboard/ui', 'run', 'build'], { stdio: 'inherit' });
      }

      const dashboardConfig = dashboardConfigSchema.parse({
        port,
        host: '0.0.0.0',
        isDev,
      });

      const sessionStore = new SessionStore({ dbPath: config.database.path });
      const liveStateStore = new LiveStateStore({ dbPath: config.database.path });
      const tournamentStore = new TournamentStore({ dbPath: config.database.path });
      const activationBridge = new ActivationBridge({ store: tournamentStore });

      const riskConfig = parseRiskConfig({});
      const riskManager = new RiskManager(riskConfig);
      const correlationStore = new CorrelationStore({ dbPath: config.database.path });
      const backtestStore = new BacktestStore({ dbPath: config.database.path });
      const repo = new CandleRepository(dbConn.db);

      out.step(1, 2, 'Creating dashboard server');

      const server = await createDashboardServer(dashboardConfig, {
        liveStateStore,
        sessionStore,
        activationBridge,
        riskManager,
        engines: [],
        correlationStore,
        backtestStore,
        repo,
      });

      // Register SIGINT handler for graceful shutdown
      let stopping = false;
      process.on('SIGINT', async () => {
        if (stopping) return;
        stopping = true;
        out.info('Shutting down dashboard...');
        try {
          await server.close();
          out.success('Dashboard stopped');
        } catch (err) {
          out.error(err instanceof Error ? err.message : String(err));
        } finally {
          try { correlationStore.close(); } catch { /* ignore */ }
          try { backtestStore.close(); } catch { /* ignore */ }
          dbConn.sqlite.close();
          process.exit(0);
        }
      });

      out.step(2, 2, 'Starting server');
      const address = await server.start();

      if (isDev) {
        out.success(`API server running at http://localhost:${port}`);
        out.info('UI dev server starting at http://localhost:5173 (open this in your browser)');
      } else {
        out.success(`Dashboard running at http://localhost:${port}`);
      }
      out.info('Press Ctrl+C to stop');

      // Block until SIGINT
      await new Promise(() => {});
    } catch (error) {
      out.error(error instanceof Error ? error.message : String(error));
      dbConn.sqlite.close();
      process.exit(1);
    }
  });

await program.parseAsync(process.argv);
