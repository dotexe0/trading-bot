import { describe, it, expect } from 'vitest';
import { DriftDetector } from '../drift-detector.js';

describe('DriftDetector', () => {
  it('does not flag drift before window is full', () => {
    const dd = new DriftDetector({ windowSize: 5, sharpeThreshold: 0.5, winRateTolerance: 0.15 });
    dd.setBaseline({ sharpeRatio: 2.0, winRate: 0.6 });

    dd.recordTrade(0.01);
    dd.recordTrade(-0.005);
    dd.recordTrade(0.02);
    dd.recordTrade(0.015);

    expect(dd.checkDrift()).toBeNull();
  });

  it('detects Sharpe drift when rolling Sharpe drops below threshold', () => {
    const dd = new DriftDetector({ windowSize: 5, sharpeThreshold: 0.5, winRateTolerance: 0.15 });
    dd.setBaseline({ sharpeRatio: 2.0, winRate: 0.6 });

    for (let i = 0; i < 5; i++) dd.recordTrade(-0.02);

    const drift = dd.checkDrift();
    expect(drift).not.toBeNull();
    expect(drift!.type).toBe('sharpe');
  });

  it('detects win rate drift', () => {
    const dd = new DriftDetector({ windowSize: 5, sharpeThreshold: 0.5, winRateTolerance: 0.15 });
    dd.setBaseline({ sharpeRatio: 0.5, winRate: 0.7 });

    // 1 big win, 4 small losses = 20% win rate. Floor = 70% - 15% = 55%. 20% < 55%.
    // Net mean is positive so rolling Sharpe stays above floor, isolating win rate drift.
    dd.recordTrade(0.10);
    dd.recordTrade(-0.005);
    dd.recordTrade(-0.005);
    dd.recordTrade(-0.005);
    dd.recordTrade(-0.005);

    const drift = dd.checkDrift();
    expect(drift).not.toBeNull();
    expect(drift!.type).toBe('winRate');
  });

  it('returns null when performance is acceptable', () => {
    const dd = new DriftDetector({ windowSize: 5, sharpeThreshold: 0.5, winRateTolerance: 0.15 });
    dd.setBaseline({ sharpeRatio: 1.0, winRate: 0.5 });

    dd.recordTrade(0.02);
    dd.recordTrade(0.01);
    dd.recordTrade(0.015);
    dd.recordTrade(-0.005);
    dd.recordTrade(0.02);

    expect(dd.checkDrift()).toBeNull();
  });

  it('setBaseline resets the window', () => {
    const dd = new DriftDetector({ windowSize: 3, sharpeThreshold: 0.5, winRateTolerance: 0.15 });
    dd.setBaseline({ sharpeRatio: 2.0, winRate: 0.7 });

    dd.recordTrade(-0.02);
    dd.recordTrade(-0.02);
    dd.recordTrade(-0.02);
    expect(dd.checkDrift()).not.toBeNull();

    dd.setBaseline({ sharpeRatio: -1.0, winRate: 0.1 });
    expect(dd.checkDrift()).toBeNull(); // window was reset, not full
  });
});
