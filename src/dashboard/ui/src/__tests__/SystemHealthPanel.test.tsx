import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { SystemHealthPanel } from '../components/SystemHealthPanel.js';
import type { SystemHealthPayload } from '../types.js';

function makePayload(overrides: Partial<SystemHealthPayload> = {}): SystemHealthPayload {
  return {
    recoveryState: 'NORMAL',
    lastReconciliationAt: null,
    feedHealth: [],
    riskProximity: {
      currentDrawdownPct: 0,
      maxDrawdownPct: 20,
      currentExposurePct: 0,
      maxExposurePct: 80,
    },
    ...overrides,
  };
}

describe('SystemHealthPanel', () => {
  it('renders NORMAL state with green badge', () => {
    render(<SystemHealthPanel systemHealth={makePayload({ recoveryState: 'NORMAL' })} />);
    expect(screen.getByText('NORMAL')).toBeDefined();
    const badge = screen.getByText('NORMAL');
    expect(badge.style.backgroundColor).toBe('rgb(34, 197, 94)'); // #22c55e
  });

  it('renders RECONCILIATION_NEEDED state with red badge', () => {
    render(<SystemHealthPanel systemHealth={makePayload({ recoveryState: 'RECONCILIATION_NEEDED' })} />);
    expect(screen.getByText('RECONCILIATION_NEEDED')).toBeDefined();
    const badge = screen.getByText('RECONCILIATION_NEEDED');
    expect(badge.style.backgroundColor).toBe('rgb(239, 68, 68)'); // #ef4444
  });

  it('renders null state as "Awaiting data"', () => {
    render(<SystemHealthPanel systemHealth={null} />);
    expect(screen.getByText('Awaiting data')).toBeDefined();
  });

  it('renders risk proximity percentage text', () => {
    const payload = makePayload({
      riskProximity: {
        currentDrawdownPct: 15,
        maxDrawdownPct: 20,
        currentExposurePct: 60,
        maxExposurePct: 80,
      },
    });
    render(<SystemHealthPanel systemHealth={payload} />);
    expect(screen.getByText('15.0% / 20%')).toBeDefined();
    expect(screen.getByText('60.0% / 80%')).toBeDefined();
  });

  it('renders last reconciliation timestamp when present', () => {
    const ts = new Date('2026-03-25T10:30:00Z').getTime();
    render(<SystemHealthPanel systemHealth={makePayload({ lastReconciliationAt: ts })} />);
    // The formatted string should NOT be the em-dash
    const label = screen.getByText('Last Reconciliation');
    // The sibling value element should contain the formatted date (locale-dependent)
    const row = label.closest('div');
    expect(row?.textContent).not.toContain('\u2014');
  });

  it('renders em-dash for null reconciliation timestamp', () => {
    render(<SystemHealthPanel systemHealth={makePayload({ lastReconciliationAt: null })} />);
    expect(screen.getByText('\u2014')).toBeDefined();
  });

  it('renders per-feed status indicators with instrument names and status badges', () => {
    const payload = makePayload({
      feedHealth: [
        { instrument: 'BTC-USD', status: 'LIVE', lastCandleAt: Date.now(), lastMarkPriceAt: Date.now() },
        { instrument: 'ETH-USD', status: 'STALE', lastCandleAt: Date.now() - 60000, lastMarkPriceAt: null },
      ],
    });
    render(<SystemHealthPanel systemHealth={payload} />);
    expect(screen.getByText('BTC-USD')).toBeDefined();
    expect(screen.getByText('ETH-USD')).toBeDefined();
    expect(screen.getByText('LIVE')).toBeDefined();
    expect(screen.getByText('STALE')).toBeDefined();
    // LIVE badge should be green
    const liveBadge = screen.getByText('LIVE');
    expect(liveBadge.style.backgroundColor).toBe('rgb(34, 197, 94)'); // #22c55e
    // STALE badge should be amber
    const staleBadge = screen.getByText('STALE');
    expect(staleBadge.style.backgroundColor).toBe('rgb(245, 158, 11)'); // #f59e0b
  });

  it('renders "No feeds" when feedHealth array is empty', () => {
    render(<SystemHealthPanel systemHealth={makePayload({ feedHealth: [] })} />);
    expect(screen.getByText('No feeds')).toBeDefined();
  });
});
