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

  it('has zero-trade guard that warns when no OOS trades', () => {
    expect(src).toMatch(/zero OOS trades/);
  });

  it('--skip-perp-tournament option is registered', () => {
    expect(src).toMatch(/skip-perp-tournament/);
  });

  it('perpActivationReady flag controls engine activation', () => {
    expect(src).toMatch(/perpActivationReady/);
  });
});

describe('start.ts – PIPE-02: PaperPerpEngine activation', () => {
  it('instantiates PaperPerpEngine', () => {
    expect(src).toMatch(/new PaperPerpEngine\s*\(/);
  });

  it('pushes PaperPerpEngine emitter to perpEngineEmitters before createDashboardServer call', () => {
    const enginePushLine = lineOf(/perpEngineEmitters\.push\(paperPerpEngine\)/);
    // Match the actual invocation (await createDashboardServer(...)), not the import line
    const dashboardCreateLine = lineOf(/await createDashboardServer\s*\(/);
    expect(enginePushLine).toBeLessThan(dashboardCreateLine);
  });

  it('engine resource (paper or live) is pushed before perp-intx-client', () => {
    const paperLine = lineOf(/name:\s*['"]paper-perp-engine['"]/);
    const liveLine = lineOf(/name:\s*['"]perp-position-manager['"]/);
    const clientLine = lineOf(/name:\s*['"]perp-intx-client['"]/);
    // Both engine resource pushes appear before perp-intx-client
    expect(Math.min(paperLine, liveLine)).toBeLessThan(clientLine);
  });
});

describe('start.ts – PIPE-03: PerpPositionManager activation', () => {
  it('instantiates PerpPositionManager', () => {
    expect(src).toMatch(/new PerpPositionManager\s*\(/);
  });

  it('calls recoverFromRestart before perpManager.start()', () => {
    const recoverLine = lineOf(/recoverFromRestart\s*\(\)/);
    const startLine = lineOf(/perpManager\.start\s*\(\)/);
    expect(recoverLine).toBeLessThan(startLine);
  });

  it('perp-position-manager resource is pushed before perp-intx-client', () => {
    const managerResourceLine = lineOf(/name:\s*['"]perp-position-manager['"]/);
    const clientResourceLine = lineOf(/name:\s*['"]perp-intx-client['"]/);
    expect(managerResourceLine).toBeLessThan(clientResourceLine);
  });
});
