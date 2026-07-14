/**
 * logger.ts — Level-filtered, console-compatible logger.
 *
 * Drop-in replacement for console.log/warn/error: identical varargs
 * signature, so call sites need no reformatting. What it adds:
 *   - level filtering via LOG_LEVEL (debug|info|warn|error|silent)
 *   - optional JSON output via LOG_FORMAT=json (one object per line,
 *     for log shipping in production)
 *   - ISO timestamp prefix in pretty mode
 *
 * Usage: import { logger } from './core/logger';
 *        logger.info('🟢 [VDB] connected:', url);
 */

import { format } from 'util';
import { env } from '../config/env';

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<Level | 'silent', number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 99,
};

const threshold = LEVEL_RANK[env.LOG_LEVEL];

function emit(level: Level, args: unknown[]): void {
  if (LEVEL_RANK[level] < threshold) return;

  if (env.LOG_FORMAT === 'json') {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      msg: format(...args),
    });
    if (level === 'error') process.stderr.write(line + '\n');
    else process.stdout.write(line + '\n');
    return;
  }

  const prefix = new Date().toISOString();
  if (level === 'error') console.error(prefix, ...args);
  else if (level === 'warn') console.warn(prefix, ...args);
  else console.log(prefix, ...args);
}

export const logger = {
  debug: (...args: unknown[]) => emit('debug', args),
  info: (...args: unknown[]) => emit('info', args),
  warn: (...args: unknown[]) => emit('warn', args),
  error: (...args: unknown[]) => emit('error', args),
};

export type Logger = typeof logger;
