import { logger } from '../utils/logger.js';

/**
 * Crash-safe logger proxy for the drift module.
 *
 * Many drift files wrap every logger call in try/catch to prevent a logger
 * failure from crashing financial-critical code paths.  This proxy eliminates
 * the need for those guards by ensuring each method never throws.
 */
function wrap(fn: Function): (...args: any[]) => void {
  return (...args: any[]) => {
    try { fn.apply(logger, args); } catch { /* intentionally silent – logger failure must never crash caller */ }
  };
}

export const safeLog = {
  info: wrap(logger.info),
  warn: wrap(logger.warn),
  error: wrap(logger.error),
  debug: wrap(logger.debug),
};

/**
 * Execute `fn` and return its result.  If it throws (sync or async), log the
 * error at the requested level and return `undefined`.
 *
 * Use this to replace bare `try { ... } catch {}` blocks so that failures are
 * always visible in logs.
 *
 * @param fn       The function to execute (may be sync or async).
 * @param context  A dot-delimited string used as the log message prefix
 *                 (e.g. `'drift.liquidator.initDiscovery'`).
 * @param level    Log level for the caught error (default `'debug'`).
 */
export function guardExec<T>(
  fn: () => T | Promise<T>,
  context: string,
  level: 'debug' | 'warn' | 'error' = 'debug',
): Promise<T | undefined> {
  try {
    const result = fn();
    if (result && typeof (result as any).then === 'function') {
      return (result as Promise<T>).catch((e: any) => {
        safeLog[level](`${context}.failed`, { error: String(e?.message || e), cat: 'drift' });
        return undefined;
      });
    }
    return Promise.resolve(result);
  } catch (e: any) {
    safeLog[level](`${context}.failed`, { error: String(e?.message || e), cat: 'drift' });
    return Promise.resolve(undefined);
  }
}
