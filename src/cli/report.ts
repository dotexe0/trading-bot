/**
 * CLI entry point for performance analytics reports.
 *
 * Usage: npm run report -- --latest
 *        npm run report -- --latest --trades
 *        npm run report -- --latest --trades -n 3
 *        npm run report -- --session <id> --type paper
 *        npm run report -- --session <id> --type live
 */

import { Command } from 'commander';
import pc from 'picocolors';
import { bootstrap } from './shared/bootstrap.js';
import { out } from './shared/output.js';
import {
  computePerformanceReport,
  normalizeApiBacktestTrade,
  normalizeLiveTrade,
} from '../analytics/performance-report.js';
import { BacktestStore } from '../backtest/backtest-store.js';
import { SessionStore } from '../paper/session-store.js';
import { LiveStateStore } from '../live/state-store.js';
import type { Trade } from '../backtest/types.js';

const program = new Command();

program
  .name('report')
  .description('Show performance analytics for a completed session or backtest')
  .option('--session <id>', 'Session or backtest ID')
  .option('--latest', 'Use the most recent session/backtest')
  .option('--type <type>', 'Session type: backtest|paper|live', 'backtest')
  .option('--trades', 'Show top N best/worst trades')
  .option('-n, --top <n>', 'Number of best/worst trades to show', '5')
  .action(async (opts) => {
    const { dbConn } = bootstrap();
    const backtestStore = new BacktestStore();
    const sessionStore = new SessionStore();
    const stateStore = new LiveStateStore();

    try {
      const topN = parseInt(opts.top as string, 10) || 5;
      const sessionType = (opts.type as string).toLowerCase();

      let trades: Trade[] = [];
      let pair = 'BTC-USD';
      let strategyName = 'unknown';
      let sessionId: string | undefined;

      if (sessionType === 'backtest') {
        let run = null;

        if (opts.session) {
          run = backtestStore.getById(opts.session as string);
          if (!run) {
            out.error(`Backtest not found: ${opts.session}`);
            process.exit(1);
          }
        } else if (opts.latest) {
          const recent = backtestStore.listRecent(1);
          if (recent.length === 0) {
            out.error('No backtests found. Run `npm run backtest` first.');
            process.exit(1);
          }
          run = recent[0];
        } else {
          out.error('Provide --session <id> or --latest');
          process.exit(1);
        }

        sessionId = run.id;
        pair = run.pair;
        strategyName = run.strategyName;
        trades = run.trades.map(normalizeApiBacktestTrade);

      } else if (sessionType === 'paper') {
        let session = null;

        if (opts.session) {
          session = sessionStore.getSession(opts.session as string);
          if (!session) {
            out.error(`Paper session not found: ${opts.session}`);
            process.exit(1);
          }
        } else if (opts.latest) {
          const sessions = sessionStore.listSessions();
          // listSessions() has no ORDER BY — sort by startTime descending
          sessions.sort((a, b) => b.startTime - a.startTime);
          if (sessions.length === 0) {
            out.error('No paper sessions found. Run `npm run paper` first.');
            process.exit(1);
          }
          session = sessions[0];
        } else {
          out.error('Provide --session <id> or --latest');
          process.exit(1);
        }

        sessionId = session.id;
        pair = session.pair;
        strategyName = session.strategyName;
        trades = sessionStore.getSessionTrades(sessionId);

      } else if (sessionType === 'live') {
        let session = null;

        if (opts.session) {
          session = stateStore.getSession(opts.session as string);
          if (!session) {
            out.error(`Live session not found: ${opts.session}`);
            process.exit(1);
          }
        } else if (opts.latest) {
          const sessions = stateStore.listSessions();
          // listSessions() has no ORDER BY — sort by startTime descending
          sessions.sort((a, b) => b.startTime - a.startTime);
          if (sessions.length === 0) {
            out.error('No live sessions found. Run `npm run live` first.');
            process.exit(1);
          }
          session = sessions[0];
        } else {
          out.error('Provide --session <id> or --latest');
          process.exit(1);
        }

        sessionId = session.id;
        pair = session.pair;
        strategyName = session.strategyName;
        const liveTrades = stateStore.getSessionTrades(sessionId);
        trades = liveTrades
          .map(normalizeLiveTrade)
          .filter((t): t is Trade => t !== null);

      } else {
        out.error(`Unknown session type: ${sessionType}. Use backtest|paper|live`);
        process.exit(1);
      }

      const report = computePerformanceReport(trades, pair, topN);

      out.banner('Performance Report');
      out.table('Session Type', sessionType);
      out.table('Strategy', strategyName);
      out.table('Pair', pair);
      if (sessionId) out.table('Session ID', sessionId);
      out.table('Trade Count', String(report.tradeCount));
      out.table('Win Rate', `${report.winRate.mul(100).toFixed(1)}%`);
      out.table('Avg Win', `${report.avgWin.mul(100).toFixed(2)}%`);
      out.table('Avg Loss', `${report.avgLoss.mul(100).toFixed(2)}%`);
      out.table('Win/Loss Ratio', report.winLossRatio.toFixed(2));
      out.table('Profit Factor', report.profitFactor.toFixed(2));

      if (opts.trades && report.tradeCount > 0) {
        const fmtTs = (ts: number) =>
          new Date(ts).toISOString().slice(0, 16).replace('T', ' ');
        const fmtPrice = (p: string) => parseFloat(p).toFixed(2);
        const fmtPnl = (pct: string) => {
          const val = parseFloat(pct);
          const str = `${val >= 0 ? '+' : ''}${val.toFixed(2)}%`;
          return val >= 0 ? pc.green(str) : pc.red(str);
        };

        const header = `  ${'Date'.padEnd(17)} ${'Pair'.padEnd(9)} ${'Entry'.padEnd(12)} ${'Exit'.padEnd(12)} ${'P&L %'.padStart(8)}`;

        out.banner(`Top ${topN} Best Trades`);
        console.log(pc.dim(header));
        for (const t of report.bestTrades) {
          console.log(
            `  ${fmtTs(t.entryTimestamp).padEnd(17)} ${t.pair.padEnd(9)} ${fmtPrice(t.entryPrice).padEnd(12)} ${fmtPrice(t.exitPrice).padEnd(12)} ${fmtPnl(t.pnlPct).padStart(8)}`,
          );
        }

        out.banner(`Top ${topN} Worst Trades`);
        console.log(pc.dim(header));
        for (const t of report.worstTrades) {
          console.log(
            `  ${fmtTs(t.entryTimestamp).padEnd(17)} ${t.pair.padEnd(9)} ${fmtPrice(t.entryPrice).padEnd(12)} ${fmtPrice(t.exitPrice).padEnd(12)} ${fmtPnl(t.pnlPct).padStart(8)}`,
          );
        }
        console.log('');
      } else if (opts.trades && report.tradeCount === 0) {
        out.warn('No completed trades found for this session.');
      }

      out.success('Report complete');
    } catch (error) {
      out.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    } finally {
      backtestStore.close();
      sessionStore.close();
      stateStore.close();
      dbConn.sqlite.close();
    }
  });

await program.parseAsync(process.argv);
