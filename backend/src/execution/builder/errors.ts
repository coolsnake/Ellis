import type { DirectHop } from '../types.js';
import { logger } from '../../utils/logger.js';
import { LogCode } from '../../utils/logging.js';

/**
 * Error context for builder errors
 */
export interface BuilderErrorContext {
  poolId?: string;
  dex?: string;
  variant?: string;
  inputMint?: string;
  outputMint?: string;
  amountInRaw?: string;
  minOutRaw?: string;
  [key: string]: unknown;
}

/**
 * Creates a standardized builder error with context
 * Format: {DEX}_{BUILD_FAILED}: {specific_reason}: {context}
 */
export function createBuilderError(
  dex: string,
  reason: string,
  hop?: DirectHop | Partial<DirectHop>,
  additionalContext?: Record<string, unknown>
): Error {
  const context: BuilderErrorContext = {
    ...additionalContext,
  };

  if (hop) {
    context.poolId = hop.poolId;
    context.dex = hop.dex;
    context.variant = hop.variant;
    context.inputMint = hop.inputMint;
    context.outputMint = hop.outputMint;
    context.amountInRaw = hop.amountInRaw?.toString() || '0';
    context.minOutRaw = hop.minOutRaw?.toString() || '0';
  }

  const contextStr = Object.entries(context)
    .filter(([_, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(', ');

  return new Error(`${dex.toUpperCase()}_BUILD_FAILED: ${reason}: ${contextStr}`);
}

/**
 * Logs an error with context before rethrowing
 * Ensures all errors are logged for observability
 */
export function logAndThrow(error: Error, logContext?: Record<string, unknown>): never {
  try {
    logger.error('builder.error', {
      cat: 'tx',
      code: LogCode.TX_BUILD_ERR,
      ctx: {
        error: error.message,
        stack: error.stack,
        ...logContext,
      }
    });
  } catch (logErr) {
    // Don't fail if logging fails
  }
  throw error;
}

/**
 * Wraps an error with context and logs it
 */
export function wrapBuilderError(
  error: unknown,
  dex: string,
  reason: string,
  hop?: DirectHop | Partial<DirectHop>,
  additionalContext?: Record<string, unknown>
): Error {
  const builderError = error instanceof Error
    ? createBuilderError(dex, `${reason}: ${error.message}`, hop, additionalContext)
    : createBuilderError(dex, `${reason}: ${String(error)}`, hop, additionalContext);

  // Preserve original error stack if available
  if (error instanceof Error && error.stack) {
    builderError.stack = `${builderError.stack}\nOriginal: ${error.stack}`;
  }

  logAndThrow(builderError);
}

