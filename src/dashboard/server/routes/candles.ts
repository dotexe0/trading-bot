import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from '../index.js';

/**
 * GET /api/candles?pair=BTC-USD&timeframe=1h&limit=500
 *
 * Returns recent candles from the local SQLite DB for pre-populating
 * the dashboard price chart on page load / refresh.
 */
export async function registerCandleRoutes(
  app: FastifyInstance,
  deps: RouteDeps,
): Promise<void> {
  app.get('/api/candles', async (request, reply) => {
    if (!deps.repo) {
      return reply.code(503).send({ error: 'Candle repository not available' });
    }

    const query = request.query as Record<string, string>;
    const pair = (query['pair'] ?? 'BTC-USD') as 'BTC-USD' | 'ETH-USD';
    const timeframe = (query['timeframe'] ?? '1h') as '1m' | '5m' | '15m' | '1h' | '4h' | '1D';
    const limit = Math.min(parseInt(query['limit'] ?? '500', 10), 1000);

    const endMs = Date.now();
    // Fetch enough history to cover the limit: 1h * limit
    const timeframeMs: Record<string, number> = {
      '1m': 60_000, '5m': 300_000, '15m': 900_000,
      '1h': 3_600_000, '4h': 14_400_000, '1D': 86_400_000,
    };
    const startMs = endMs - (timeframeMs[timeframe] ?? 3_600_000) * limit;

    const raw = deps.repo.getCandles(pair, timeframe, startMs, endMs);

    // Return only the last `limit` candles (repo returns ascending)
    const sliced = raw.slice(-limit);

    return sliced.map((c) => ({
      time: Math.floor(c.timestamp / 1000),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));
  });
}
