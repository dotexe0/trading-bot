/**
 * Backtest REST routes.
 *
 * GET /api/backtests              -- list recent runs (metadata only)
 * GET /api/backtests/:id/candles  -- OHLCV data formatted for LWC (time in Unix seconds)
 * GET /api/backtests/:id/trades   -- serialized trade array
 */

import type { FastifyInstance } from 'fastify';
import { createModuleLogger } from '../../../core/logger.js';
import type { RouteDeps } from '../index.js';
import type { Timeframe } from '../../../core/types.js';

const log = createModuleLogger('route-backtests');

export async function registerBacktestRoutes(
  app: FastifyInstance,
  deps: RouteDeps,
): Promise<void> {
  // GET /api/backtests -- list recent runs (metadata only, no large blobs)
  app.get('/api/backtests', async () => {
    if (!deps.backtestStore) {
      return [];
    }
    return deps.backtestStore.listRecentMeta(20);
  });

  // GET /api/backtests/:id/candles -- OHLCV data formatted for LWC
  app.get<{ Params: { id: string } }>(
    '/api/backtests/:id/candles',
    async (request, reply) => {
      if (!deps.backtestStore || !deps.repo) {
        return reply.status(503).send({ error: 'BacktestStore or CandleRepository not configured' });
      }

      const { id } = request.params;
      const run = deps.backtestStore.getById(id);

      if (!run) {
        return reply.status(404).send({ error: `Backtest run '${id}' not found` });
      }

      const candles = deps.repo.getCandles(
        run.pair as 'BTC-USD' | 'ETH-USD',
        run.timeframe as Timeframe,
        run.startTimestamp,
        run.endTimestamp,
      );

      // Map to LWC format: time in Unix SECONDS (divide by 1000)
      const lwcCandles = candles.map((c) => ({
        time: Math.floor(c.timestamp / 1000),
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
      }));

      log.info({ id, candleCount: lwcCandles.length }, 'Served backtest candles');
      return lwcCandles;
    },
  );

  // GET /api/backtests/:id/trades -- serialized trade array
  app.get<{ Params: { id: string } }>(
    '/api/backtests/:id/trades',
    async (request, reply) => {
      if (!deps.backtestStore) {
        return reply.status(503).send({ error: 'BacktestStore not configured' });
      }

      const { id } = request.params;
      const run = deps.backtestStore.getById(id);

      if (!run) {
        return reply.status(404).send({ error: `Backtest run '${id}' not found` });
      }

      log.info({ id, tradeCount: run.trades.length }, 'Served backtest trades');
      return run.trades;
    },
  );
}
