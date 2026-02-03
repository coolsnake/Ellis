/**
 * Skip Simulation Feedback Processor
 * 
 * Processes on-chain execution results for skip simulation transactions.
 * This closes the feedback loop that simulation normally provides:
 * 
 * - On success: validates pools, records positive capacity feedback
 * - On 6007 (profit check failed): validates pools (swaps worked), records capacity feedback
 * - On other errors: invalidates pools, records pool failure for quarantine
 * 
 * This enables the system to learn from skip simulation execution outcomes
 * and improve future sizing and pool validation decisions.
 */

import { logger } from '../utils/logger.js';
import { parseSimulationLogs } from './simLogParser.js';
import { validatedPoolsCache } from './validatedPoolsCache.js';
import { recordPoolFeedback, type FeedbackOutcome } from './capacity/feedbackCollector.js';
import { recordPoolFailure } from './poolFailureTracker.js';
import { getPoolTypeFromDex } from './capacity/types.js';
import type { TxRecord } from '../server/txHistory.js';

// ============================================================================
// Calibration Disable Flag
// ============================================================================

/**
 * Module-level flag to disable calibration feedback recording.
 * When true, skip-sim feedback will not record capacity calibration data.
 * Set by the arbExecutor when multi-hop mode has disableCalibration enabled.
 */
let calibrationDisabled = false;

/**
 * Set whether calibration feedback should be disabled.
 * Call this when sizing config changes.
 */
export function setCalibrationDisabled(disabled: boolean): void {
  calibrationDisabled = disabled;
  if (disabled) {
    logger.info('skipSimFeedback.calibration_disabled', { cat: 'feedback' });
  }
}

/**
 * Check if calibration feedback is currently disabled.
 */
export function isCalibrationDisabled(): boolean {
  return calibrationDisabled;
}

// ============================================================================
// Transaction Log Fetching
// ============================================================================

/**
 * Fetch transaction logs from chain for a confirmed transaction.
 * These logs are in the same format as simulation logs and can be parsed
 * by parseSimulationLogs().
 * 
 * @param signature - The transaction signature
 * @returns The transaction logs, or null if fetch failed
 */
async function fetchTransactionLogs(signature: string): Promise<string[] | null> {
  try {
    const { getConnection } = await import('../wallet/wallet.js');
    const { withRpcLimit } = await import('../utils/rpcLimiter.js');
    
    const connection = getConnection();
    const tx = await withRpcLimit(
      () => connection.getTransaction(signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      }),
      1,
      { module: 'skipSimFeedback', method: 'getTransaction' }
    );
    
    return tx?.meta?.logMessages ?? null;
  } catch (e) {
    logger.warn('skipSimFeedback.fetch_logs_failed', {
      cat: 'feedback',
      signature: signature.slice(0, 16),
      error: String((e as any)?.message || e),
    });
    return null;
  }
}

// ============================================================================
// Feedback Processing
// ============================================================================

/**
 * Process a confirmed skip simulation transaction.
 * Called from txHistory when a skip simulation transaction confirms.
 * 
 * @param rec - The TxRecord containing execution context
 * @param success - Whether the transaction succeeded on-chain
 * @param error - Error message if transaction failed
 */
export async function processSkipSimConfirmation(
  rec: TxRecord,
  success: boolean,
  error?: string
): Promise<void> {
  // Validate we have the data needed for feedback
  if (!rec.hops || rec.hops.length === 0) {
    logger.debug('skipSimFeedback.no_hops', {
      cat: 'feedback',
      id: rec.id,
    });
    return;
  }
  
  const traceId = rec.id;
  const signature = rec.signature || 'unknown';
  const sizeUsd = rec.sizeUsd || 0;
  const expectedProfitBps = rec.expectedProfitBps || 0;
  const hops = rec.hops;
  
  if (success) {
    // Transaction succeeded on-chain - pools are definitely valid
    // Record positive feedback for each pool
    handleSuccess(hops, sizeUsd, traceId, signature);
    return;
  }
  
  // Transaction failed - need to understand why
  // Fetch logs to determine if it was a profit check failure (6007)
  const logs = await fetchTransactionLogs(signature);
  const analysis = parseSimulationLogs(logs ?? undefined, error);
  
  if (analysis.profitCheckFailed || analysis.errorCode === 6007) {
    // 6007 error: all swaps executed successfully, only profit check failed
    // Pools are still valid (swaps work), but our capacity estimation was off
    handleProfitCheckFailure(hops, sizeUsd, expectedProfitBps, analysis, traceId, signature);
  } else {
    // Other error - real execution failure, pools may be problematic
    handleExecutionFailure(hops, error || 'unknown_error', analysis, traceId, signature);
  }
}

/**
 * Positive delta to record for successful skip-sim executions.
 * This signals that our estimate worked and we could potentially trade larger.
 * Skip-sim is only used for pre-validated pools, so success is a strong positive signal.
 */
const SKIP_SIM_SUCCESS_DELTA_BPS = 15;

/**
 * Handle successful skip simulation execution.
 * Mark pools as validated and record positive capacity feedback.
 */
function handleSuccess(
  hops: TxRecord['hops'],
  sizeUsd: number,
  traceId: string,
  signature: string
): void {
  // Mark all pools as validated
  const directHops = hops.map(h => ({
    poolId: h.poolId,
    dex: h.dex,
    variant: h.variant,
  }));
  
  for (const hop of directHops) {
    validatedPoolsCache.markValidated(hop.poolId, hop.dex, hop.variant, 'success');
  }
  
  // Record POSITIVE capacity feedback for each pool (unless calibration is disabled)
  // Success on skip-sim is a strong signal - the trade worked without simulation
  // This helps recover from overly conservative calibrations
  if (!calibrationDisabled) {
    const perHopSize = sizeUsd / Math.max(1, hops.length);
    
    for (const hop of hops) {
      const poolType = getPoolTypeFromDex(hop.dex, hop.variant);
      // Record positive delta to signal "we could potentially trade larger"
      // This is key for recovering from the minimum-size trap
      recordPoolFeedback(hop.poolId, poolType, SKIP_SIM_SUCCESS_DELTA_BPS, perHopSize, 'success');
    }
  }
  
  // Update stats
  stats.successCount++;
  stats.lastProcessedAt = Date.now();
  
  logger.info('skipSimFeedback.success', {
    cat: 'feedback',
    traceId,
    signature: signature.slice(0, 16),
    hops: hops.length,
    sizeUsd: sizeUsd.toFixed(2),
    deltaBps: SKIP_SIM_SUCCESS_DELTA_BPS,
    pools: hops.map(h => h.poolId.slice(0, 8)).join(', '),
  });
}

/**
 * Handle profit check failure (6007 error).
 * Pools are still valid (swaps worked), but record capacity feedback.
 */
function handleProfitCheckFailure(
  hops: TxRecord['hops'],
  sizeUsd: number,
  expectedProfitBps: number,
  analysis: ReturnType<typeof parseSimulationLogs>,
  traceId: string,
  signature: string
): void {
  // Mark all pools as validated - swaps executed successfully
  const directHops = hops.map(h => ({
    poolId: h.poolId,
    dex: h.dex,
    variant: h.variant,
  }));
  
  for (const hop of directHops) {
    validatedPoolsCache.markValidated(hop.poolId, hop.dex, hop.variant, '6007');
  }
  
  // Record capacity feedback (unless calibration is disabled)
  // Profit check failed means actual profit was below expected
  // We use expectedProfitBps as a conservative estimate of the error
  // (actual slippage was at least expectedProfitBps worse than quoted)
  if (!calibrationDisabled) {
    const estimatedDeltaBps = -expectedProfitBps;
    const perHopSize = sizeUsd / Math.max(1, hops.length);
    const perHopDelta = estimatedDeltaBps / Math.max(1, hops.length);
    
    for (const hop of hops) {
      const poolType = getPoolTypeFromDex(hop.dex, hop.variant);
      recordPoolFeedback(hop.poolId, poolType, perHopDelta, perHopSize, '6007');
    }
  }
  
  // Update stats
  stats.profitCheckFailedCount++;
  stats.lastProcessedAt = Date.now();
  
  logger.info('skipSimFeedback.profit_check_failed', {
    cat: 'feedback',
    traceId,
    signature: signature.slice(0, 16),
    hops: hops.length,
    sizeUsd: sizeUsd.toFixed(2),
    expectedProfitBps,
    estimatedDeltaBps,
    analysis: {
      profitValue: analysis.profitValue?.toString(),
      minProfitRequired: analysis.minProfitRequired?.toString(),
      initialBalance: analysis.initialBalance?.toString(),
      finalBalance: analysis.finalBalance?.toString(),
    },
    pools: hops.map(h => h.poolId.slice(0, 8)).join(', '),
  });
}

/**
 * Handle execution failure (non-6007 error).
 * Invalidate pools and record pool failures for quarantine tracking.
 */
function handleExecutionFailure(
  hops: TxRecord['hops'],
  error: string,
  analysis: ReturnType<typeof parseSimulationLogs>,
  traceId: string,
  signature: string
): void {
  // Invalidate pools from skip simulation cache - they may be problematic
  for (const hop of hops) {
    validatedPoolsCache.invalidate(hop.poolId);
    recordPoolFailure(hop.poolId, hop.dex, error, traceId);
  }
  
  // Update stats
  stats.executionFailedCount++;
  stats.lastProcessedAt = Date.now();
  
  logger.warn('skipSimFeedback.execution_failed', {
    cat: 'feedback',
    traceId,
    signature: signature.slice(0, 16),
    hops: hops.length,
    error: error.slice(0, 200),
    errorCode: analysis.errorCode,
    errorMessage: analysis.errorMessage,
    pools: hops.map(h => h.poolId.slice(0, 8)).join(', '),
  });
}

// ============================================================================
// Stats and Monitoring
// ============================================================================

// Track feedback processing stats for monitoring
interface FeedbackStats {
  successCount: number;
  profitCheckFailedCount: number;
  executionFailedCount: number;
  lastProcessedAt: number;
}

const stats: FeedbackStats = {
  successCount: 0,
  profitCheckFailedCount: 0,
  executionFailedCount: 0,
  lastProcessedAt: 0,
};

/**
 * Get feedback processing statistics
 */
export function getSkipSimFeedbackStats(): FeedbackStats {
  return { ...stats };
}
