/**
 * Colored terminal output helpers for CLI entry points.
 *
 * Uses picocolors (lightweight, already a transitive dependency).
 * Provides consistent formatting across all CLI commands.
 */

import pc from 'picocolors';

export const out = {
  step(n: number, total: number, msg: string): void {
    console.log(pc.cyan(`[${n}/${total}] ${msg}`));
  },

  success(msg: string): void {
    console.log(pc.green(`  OK  ${msg}`));
  },

  warn(msg: string): void {
    console.log(pc.yellow(`  WARN  ${msg}`));
  },

  error(msg: string): void {
    console.error(pc.red(`  ERR  ${msg}`));
  },

  info(msg: string): void {
    console.log(pc.dim(`  ${msg}`));
  },

  banner(msg: string): void {
    console.log(pc.bold(pc.white(`\n  ${msg}\n`)));
  },

  table(label: string, value: string): void {
    console.log(`  ${pc.dim(label.padEnd(14))} ${value}`);
  },
};
