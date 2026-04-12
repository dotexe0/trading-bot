/**
 * DriftDetector -- monitors rolling trade performance against tournament baseline.
 *
 * Maintains a fixed-size window of recent trade returns. Once full,
 * compares rolling Sharpe and win rate against the OOS baseline.
 */

export interface DriftConfig {
  windowSize: number;
  sharpeThreshold: number;
  winRateTolerance: number;
}

export interface DriftBaseline {
  sharpeRatio: number;
  winRate: number;
}

export interface DriftResult {
  type: 'sharpe' | 'winRate';
  rolling: number;
  baseline: number;
  threshold: number;
}

export class DriftDetector {
  private readonly config: DriftConfig;
  private readonly window: number[] = [];
  private baseline: DriftBaseline | null = null;

  constructor(config: DriftConfig) {
    this.config = config;
  }

  setBaseline(baseline: DriftBaseline): void {
    this.baseline = baseline;
    this.window.length = 0;
  }

  recordTrade(returnPct: number): void {
    this.window.push(returnPct);
    if (this.window.length > this.config.windowSize) {
      this.window.shift();
    }
  }

  checkDrift(): DriftResult | null {
    if (!this.baseline) return null;
    if (this.window.length < this.config.windowSize) return null;

    const mean = this.window.reduce((a, b) => a + b, 0) / this.window.length;
    const variance = this.window.reduce((acc, r) => acc + (r - mean) ** 2, 0) / (this.window.length - 1);
    const stdDev = Math.sqrt(variance);
    const rollingSharpe = stdDev > 0 ? mean / stdDev : 0;
    const rollingAnnualized = rollingSharpe * Math.sqrt(365);

    const sharpeFloor = this.config.sharpeThreshold * this.baseline.sharpeRatio;
    if (rollingAnnualized < sharpeFloor) {
      return {
        type: 'sharpe',
        rolling: rollingAnnualized,
        baseline: this.baseline.sharpeRatio,
        threshold: sharpeFloor,
      };
    }

    const rollingWinRate = this.window.filter(r => r > 0).length / this.window.length;
    const winRateFloor = this.baseline.winRate - this.config.winRateTolerance;
    if (rollingWinRate < winRateFloor) {
      return {
        type: 'winRate',
        rolling: rollingWinRate,
        baseline: this.baseline.winRate,
        threshold: winRateFloor,
      };
    }

    return null;
  }
}
