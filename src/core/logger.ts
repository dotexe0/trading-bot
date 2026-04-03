/**
 * Structured JSON logger using Pino.
 *
 * - Outputs JSON with Unix millisecond timestamps
 * - Supports module-scoped child loggers via createModuleLogger()
 * - Uses pino-pretty in development for human-readable output
 * - Always tees JSON logs to LOG_FILE (default: logs/bot.log)
 */

import pino from 'pino';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const level = process.env.LOG_LEVEL || 'info';
const isDev =
  level === 'debug' ||
  level === 'trace' ||
  process.env.NODE_ENV === 'development';

const logFile = process.env.LOG_FILE || 'logs/bot.log';
mkdirSync(dirname(logFile), { recursive: true });

const targets: pino.TransportTargetOptions[] = [
  // Always write JSON to file
  {
    target: 'pino/file',
    options: { destination: logFile, mkdir: true },
    level,
  },
];

if (isDev) {
  // Pretty-print to stdout in dev
  targets.push({
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname',
    },
    level,
  });
} else {
  // JSON to stdout in production
  targets.push({
    target: 'pino/file',
    options: { destination: 1 },
    level,
  });
}

export const logger = pino({
  level,
  timestamp: () => `,"time":${Date.now()}`,
  transport: { targets },
});

/**
 * Create a child logger scoped to a specific module.
 * Usage: `const log = createModuleLogger('candle-repo');`
 */
export function createModuleLogger(module: string) {
  return logger.child({ module });
}
