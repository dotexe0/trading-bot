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

const program = new Command();

program
  .name('dashboard')
  .description('Start the dashboard web server (REST API + WebSocket + UI)')
  .option('--port <port>', 'Server port', '3001')
  .option('--dev', 'Enable development mode (CORS open, no static files)')
  .action(async (opts) => {
    const { config, dbConn } = bootstrap();

    try {
      const port = parseInt(opts.port, 10);
      const isDev = opts.dev === true;

      // Warn if UI build is missing (non-dev mode)
      if (!isDev && !fs.existsSync('dist/dashboard')) {
        out.warn('Dashboard UI not built. Run: npm --prefix src/dashboard/ui run build');
        out.info('API endpoints will still work.');
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

      out.step(1, 2, 'Creating dashboard server');

      const server = await createDashboardServer(dashboardConfig, {
        liveStateStore,
        sessionStore,
        activationBridge,
        riskManager,
        engines: [],
        correlationStore,
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
          dbConn.sqlite.close();
          process.exit(0);
        }
      });

      out.step(2, 2, 'Starting server');
      const address = await server.start();

      out.success(`Dashboard running at http://localhost:${port}`);
      if (isDev) {
        out.info('Development mode: CORS enabled, no static files');
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
