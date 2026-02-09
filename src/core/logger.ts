/**
 * Structured JSON logger using Pino.
 *
 * - Outputs JSON with Unix millisecond timestamps
 * - Supports module-scoped child loggers via createModuleLogger()
 * - Uses pino-pretty in development for human-readable output
 */

import pino from 'pino';

const level = process.env.LOG_LEVEL || 'info';
const isDev =
  level === 'debug' ||
  level === 'trace' ||
  process.env.NODE_ENV === 'development';

const transport = isDev
  ? {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
      },
    }
  : undefined;

export const logger = pino({
  level,
  timestamp: () => `,"time":${Date.now()}`,
  formatters: {
    level(label: string) {
      return { level: label };
    },
  },
  transport,
});

/**
 * Create a child logger scoped to a specific module.
 * Usage: `const log = createModuleLogger('candle-repo');`
 */
export function createModuleLogger(module: string) {
  return logger.child({ module });
}
