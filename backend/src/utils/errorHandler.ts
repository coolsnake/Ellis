/**
 * Error Handler Utility
 * 
 * Provides consistent error logging for catch blocks across the codebase.
 * Replaces empty `catch {}` blocks with informative debug logging.
 */

import { logger } from './logger.js';

/**
 * Log an error caught in a try/catch block with context.
 * 
 * @param context - A dot-separated identifier for the code location (e.g., 'raydium.normalize.pool')
 * @param error - The caught error (can be any type)
 * @param extra - Optional additional context to include in the log
 * 
 * @example
 * ```typescript
 * try {
 *   await fetchData();
 * } catch (e) {
 *   logCatchError('myModule.fetchData', e, { poolId });
 * }
 * ```
 */
export function logCatchError(
  context: string,
  error: unknown,
  extra?: Record<string, unknown>
): void {
  try {
    const errorMessage = error instanceof Error 
      ? error.message 
      : String(error);
    
    const errorStack = error instanceof Error 
      ? error.stack 
      : undefined;
    
    logger.debug(`${context}.caught`, {
      error: errorMessage,
      stack: errorStack,
      ...extra,
      cat: 'error'
    });
  } catch {
    // Last resort: console.error if logger fails
    console.error(`[${context}]`, error);
  }
}

/**
 * Log a warning-level error for more significant issues.
 * 
 * @param context - A dot-separated identifier for the code location
 * @param error - The caught error
 * @param extra - Optional additional context
 */
export function logCatchWarn(
  context: string,
  error: unknown,
  extra?: Record<string, unknown>
): void {
  try {
    const errorMessage = error instanceof Error 
      ? error.message 
      : String(error);
    
    logger.warn(`${context}.caught`, {
      error: errorMessage,
      ...extra,
      cat: 'error'
    });
  } catch {
    console.error(`[${context}]`, error);
  }
}

/**
 * Log an info-level message for expected/handled errors.
 * 
 * @param context - A dot-separated identifier for the code location
 * @param error - The caught error
 * @param extra - Optional additional context
 */
export function logCatchInfo(
  context: string,
  error: unknown,
  extra?: Record<string, unknown>
): void {
  try {
    const errorMessage = error instanceof Error 
      ? error.message 
      : String(error);
    
    logger.info(`${context}.caught`, {
      error: errorMessage,
      ...extra,
      cat: 'error'
    });
  } catch {
    console.error(`[${context}]`, error);
  }
}

/**
 * Silently swallow an error but still log at trace level.
 * Use sparingly - only for truly ignorable errors.
 * 
 * @param context - A dot-separated identifier for the code location
 * @param error - The caught error
 */
export function logCatchSilent(
  context: string,
  error: unknown
): void {
  try {
    // Only log at trace level (typically disabled in production)
    if (typeof (logger as any).trace === 'function') {
      (logger as any).trace(`${context}.caught`, {
        error: error instanceof Error ? error.message : String(error),
        cat: 'error'
      });
    }
  } catch {
    // Truly silent - do nothing
  }
}

/**
 * Format an error for inclusion in other log messages.
 * 
 * @param error - The error to format
 * @returns A string representation of the error
 */
export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * Extract error message safely from any thrown value.
 * 
 * @param error - The error to extract message from
 * @returns The error message string
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

/**
 * Log a debug-level error for minor/expected issues.
 * Alias for logCatchError with explicit semantics.
 * 
 * @param context - A dot-separated identifier for the code location
 * @param error - The caught error
 * @param extra - Optional additional context
 */
export function logCatchDebug(
  context: string,
  error: unknown,
  extra?: Record<string, unknown>
): void {
  logCatchError(context, error, extra);
}

