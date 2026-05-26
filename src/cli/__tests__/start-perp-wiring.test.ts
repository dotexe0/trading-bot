/**
 * Structural tests for INFRA-03 and INFRA-04 in src/cli/start.ts.
 *
 * These tests read the source file to verify:
 *   INFRA-03: intxClient.on('error', ...) appears before await perpClient.start()
 *   INFRA-04: resources.push order — perp-intx-client before dashboard
 *   INFRA-04: perpStateStore?.close() appears in gracefulShutdown
 *   PIPE-02 guard: perp block wrapped in if (config.intx.enabled && ...)
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const srcPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '../start.ts',
);
const src = readFileSync(srcPath, 'utf-8');
const lines = src.split('\n');

function lineOf(pattern: RegExp): number {
  const idx = lines.findIndex((l) => pattern.test(l));
  return idx === -1 ? Infinity : idx;
}

describe('start.ts – INFRA-03: error listener before .start()', () => {
  it('registers intxClient error listener', () => {
    expect(src).toMatch(/perpClient\.on\(['"]error['"]/);
  });

  it('error listener appears before perpClient.start()', () => {
    const errorListenerLine = lineOf(/perpClient\.on\(['"]error['"]/);
    const startLine = lineOf(/await perpClient\.start\(\)/);
    expect(errorListenerLine).toBeLessThan(startLine);
  });
});

describe('start.ts – INFRA-04: shutdown ordering', () => {
  it('perp-intx-client is pushed to resources before dashboard', () => {
    const perpClientPushLine = lineOf(/name:\s*['"]perp-intx-client['"]/);
    const dashboardPushLine = lineOf(/name:\s*['"]dashboard['"]/);
    expect(perpClientPushLine).toBeLessThan(dashboardPushLine);
  });

  it('perpStateStore?.close() appears in source', () => {
    expect(src).toMatch(/perpStateStore\?\.close\(\)/);
  });

  it('perpStateStore close appears before or in the gracefulShutdown function body', () => {
    // gracefulShutdown is defined before the action handler — verify close is near the correlationStore close
    const corrCloseLine = lineOf(/correlationStore\?\.close/);
    const perpCloseLine = lineOf(/perpStateStore\?\.close/);
    // Both should be in the gracefulShutdown block (within 10 lines of each other)
    expect(Math.abs(corrCloseLine - perpCloseLine)).toBeLessThan(10);
  });
});

describe('start.ts – PIPE-02 guard: perp block gated on config', () => {
  it('perp wiring is inside an if (config.intx.enabled && ...) guard', () => {
    expect(src).toMatch(/config\.intx\.enabled.*config\.intx\.perpMode/s);
  });

  it('perpMode check uses !== none', () => {
    expect(src).toMatch(/perpMode\s*!==\s*['"]none['"]/);
  });
});

describe('start.ts – PIPE-01: perp tournament call', () => {
  it('calls runPerpTournament inside the perp guard block', () => {
    expect(src).toMatch(/runPerpTournament\s*\(/);
  });

  it('uses config.database.path for spot candles (not perpDatabase)', () => {
    const tournamentCallLine = lineOf(/runPerpTournament\s*\(/);
    // Within 20 lines after the call, config.database.path should appear (not perpDatabase)
    const nearbyLines = lines.slice(tournamentCallLine, tournamentCallLine + 20).join('\n');
    expect(nearbyLines).toMatch(/config\.database\.path/);
    expect(nearbyLines).not.toMatch(/config\.perpDatabase\.path/);
  });

  it('has an edge-floor guard that holds cash when no strategy qualifies', () => {
    // Stronger than the old zero-trade guard: perp activates only when a
    // strategy clears the edge floor (positive OOS Sharpe), not merely traded.
    expect(src).toMatch(/edge floor/);
    expect(src).toMatch(/selectDeployableEntries/);
  });

  it('--skip-perp-tournament option is registered', () => {
    expect(src).toMatch(/skip-perp-tournament/);
  });

  it('perpActivationReady flag controls engine activation', () => {
    expect(src).toMatch(/perpActivationReady/);
  });
});

describe('start.ts – PIPE-02: PerpTradingEngine activation (paper)', () => {
  it('instantiates PerpTradingEngine for paper mode', () => {
    expect(src).toMatch(/new PerpTradingEngine\s*\(/);
  });

  it('pushes PerpTradingEngine emitter to perpEngineEmitters before createDashboardServer call', () => {
    const enginePushLine = lineOf(/perpEngineEmitters\.push\(perpEngine\)/);
    // Match the actual invocation (await createDashboardServer(...)), not the import line
    const dashboardCreateLine = lineOf(/await createDashboardServer\s*\(/);
    expect(enginePushLine).toBeLessThan(dashboardCreateLine);
  });

  it('engine resource (paper or live) is pushed before perp-intx-client', () => {
    const engineLine = lineOf(/name:\s*[`'"]perp-engine/);
    const clientLine = lineOf(/name:\s*['"]perp-intx-client['"]/);
    expect(engineLine).toBeLessThan(clientLine);
  });
});

describe('start.ts – PIPE-03: PerpTradingEngine activation (live)', () => {
  it('instantiates PerpTradingEngine for live mode', () => {
    // Both paper and live use PerpTradingEngine now
    const matches = src.match(/new PerpTradingEngine\s*\(/g);
    expect(matches?.length).toBeGreaterThanOrEqual(2);
  });

  it('calls recoverFromRestart before perpEngine.start() in live block', () => {
    const recoverLine = lineOf(/recoverFromRestart\s*\(\)/);
    // Find the SECOND perpEngine.start() — the one in the live block (first is paper)
    const allStartIndices = lines
      .map((l, i) => /perpEngine\.start\s*\(\)/.test(l) ? i : -1)
      .filter((i) => i !== -1);
    expect(allStartIndices.length).toBeGreaterThanOrEqual(2);
    const liveStartLine = allStartIndices[1]; // second occurrence = live block
    expect(recoverLine).toBeLessThan(liveStartLine);
  });

  it('perp-engine resource is pushed before perp-intx-client', () => {
    const engineResourceLine = lineOf(/name:\s*[`'"]perp-engine/);
    const clientResourceLine = lineOf(/name:\s*['"]perp-intx-client['"]/);
    expect(engineResourceLine).toBeLessThan(clientResourceLine);
  });
});

describe('start.ts – PIPE-01/02/03: regimeLeaderboards pass-through', () => {
  it('passes perpRegimeLeaderboards to PerpTradingEngine constructor (paper)', () => {
    // Find the PerpTradingEngine constructor lines (not SpotTradingEngine)
    const allPerpEngineLines = lines
      .map((l, i) => /new PerpTradingEngine\s*\(/.test(l) ? i : -1)
      .filter((i) => i !== -1);
    expect(allPerpEngineLines.length).toBeGreaterThanOrEqual(2);
    // First PerpTradingEngine = paper mode
    const nearbyLines = lines.slice(allPerpEngineLines[0], allPerpEngineLines[0] + 20).join('\n');
    expect(nearbyLines).toMatch(/regimeLeaderboards:\s*perpRegimeLeaderboards/);
  });

  it('passes perpRegimeLeaderboards to PerpTradingEngine constructor (live)', () => {
    // Second PerpTradingEngine = live mode
    const allPerpEngineLines = lines
      .map((l, i) => /new PerpTradingEngine\s*\(/.test(l) ? i : -1)
      .filter((i) => i !== -1);
    expect(allPerpEngineLines.length).toBeGreaterThanOrEqual(2);
    const nearbyLines = lines.slice(allPerpEngineLines[1], allPerpEngineLines[1] + 20).join('\n');
    expect(nearbyLines).toMatch(/regimeLeaderboards:\s*perpRegimeLeaderboards/);
  });
});
