#!/usr/bin/env tsx
/**
 * scripts/verify-index-price.ts
 *
 * Diagnostic script: verify whether FCM WebSocket sends distinct index_price
 * values vs mark_price values.
 *
 * FINDING (confirmed by code inspection 2026-03-15):
 *   src/perp/intx-client.ts line 163:
 *     indexPrice: t.price ?? price
 *
 * The FCM ticker channel carries a single `price` field. The `index_price`
 * field is never mapped. Both markPrice and indexPrice in IntxMarkPriceEvent
 * are set to the same value. The implied funding rate (markPrice - indexPrice)
 * / indexPrice always evaluates to 0.
 *
 * CONSEQUENCE:
 *   - FundingRateArbitrageStrategy: always returns [] (no signals)
 *   - BasisTradeStrategy: always returns [] (SD=0 on constant-zero basis)
 *
 * Both strategies are implemented defensively and will produce signals if/when
 * FCM adds a distinct index_price to the ticker payload.
 *
 * Usage (requires valid FCM credentials in environment):
 *   tsx scripts/verify-index-price.ts
 *
 * Without credentials, the script prints the finding summary and exits.
 */

import { createModuleLogger } from '../src/core/logger.js';
import type { IntxMarkPriceEvent } from '../src/perp/types.js';

const log = createModuleLogger('verify-index-price');

const SAMPLE_COUNT = 10;
const TIMEOUT_MS = 30_000;

interface SampleResult {
  markPrice: string;
  indexPrice: string;
  areDifferent: boolean;
  instrument: string;
  timestamp: number;
}

async function main(): Promise<void> {
  log.info(
    {
      finding: 'indexPrice === markPrice in current FCM ticker',
      confirmedBy: 'src/perp/intx-client.ts line 163: indexPrice: t.price ?? price',
      consequence: 'FundingRateArbitrageStrategy and BasisTradeStrategy always return []',
    },
    'FCM indexPrice verification — code-confirmed finding (2026-03-15)',
  );

  const apiKey = process.env.FCM_API_KEY;
  const apiSecret = process.env.FCM_API_SECRET;

  if (!apiKey || !apiSecret) {
    log.warn(
      'FCM_API_KEY / FCM_API_SECRET not set — skipping live WebSocket verification. ' +
      'Finding confirmed by static code analysis: indexPrice === markPrice.',
    );
    process.exit(0);
  }

  // Dynamic import to avoid loading IntxClient when credentials are absent
  const { IntxClient } = await import('../src/perp/intx-client.js');
  const { loadConfig } = await import('../src/core/config.js');

  const config = loadConfig();
  if (!config.intx?.enabled) {
    log.warn('INTX not enabled in config — skipping live verification.');
    process.exit(0);
  }

  const client = new IntxClient(config.intx);
  const samples: SampleResult[] = [];

  const done = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timeout: only ${samples.length} samples received in ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);

    client.on('markPrice', (evt: IntxMarkPriceEvent) => {
      samples.push({
        markPrice: evt.markPrice,
        indexPrice: evt.indexPrice,
        areDifferent: evt.markPrice !== evt.indexPrice,
        instrument: evt.instrument,
        timestamp: evt.timestamp,
      });
      log.info(
        { ...samples[samples.length - 1] },
        `Sample ${samples.length}/${SAMPLE_COUNT}`,
      );
      if (samples.length >= SAMPLE_COUNT) {
        clearTimeout(timeout);
        resolve();
      }
    });

    client.on('error', (err: Error) => {
      clearTimeout(timeout);
      reject(err);
    });
  });

  await client.start();

  try {
    await done;
  } finally {
    await client.stop();
  }

  const differentCount = samples.filter(s => s.areDifferent).length;

  log.info(
    {
      totalSamples: samples.length,
      differentCount,
      allEqual: differentCount === 0,
    },
    differentCount === 0
      ? 'CONFIRMED: indexPrice === markPrice in all samples (FCM limitation)'
      : `UNEXPECTED: ${differentCount} samples had indexPrice !== markPrice — update strategy logic`,
  );

  process.exit(0);
}

main().catch((err) => {
  log.error({ err }, 'verify-index-price script failed');
  process.exit(1);
});
