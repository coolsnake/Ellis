/**
 * Pool Activation Module
 * 
 * Implements "lazy activation" mode where pools are only added to the graph
 * after receiving their first WebSocket update with valid pricing.
 * 
 * This ensures the detector only operates on pools with fresh, verified data.
 */

import { logger } from '../utils/logger.js';
import { emit } from './realtime.js';

// ============================================================================
// Configuration
// ============================================================================

let lazyActivationEnabled = false;
const ACTIVATION_DEBOUNCE_MS = 100; // Batch activations every 100ms

// ============================================================================
// State
// ============================================================================

/** Set of pool IDs that have received at least one valid update */
const activatedPoolIds: Set<string> = new Set();

/** Timestamp when each pool was activated (for metrics) */
const activationTimestamps: Map<string, number> = new Map();

/** Pending activations waiting for debounced graph rebuild */
let pendingActivations: string[] = [];
let activationTimer: NodeJS.Timeout | null = null;

// Note: No callback needed - incremental updates handle activation automatically
// The decoder calls tryActivatePool() BEFORE scheduleDexApply(), so by the time
// applyPoolUpdates runs, the pool is already marked as activated.

// ============================================================================
// Public API
// ============================================================================

/**
 * Enable or disable lazy activation mode.
 * When disabled, all pools are considered "activated" (default behavior).
 */
export function setLazyActivationEnabled(enabled: boolean): void {
  const wasEnabled = lazyActivationEnabled;
  lazyActivationEnabled = enabled;
  
  if (wasEnabled && !enabled) {
    // Switching OFF: clear tracking state
    activatedPoolIds.clear();
    activationTimestamps.clear();
    pendingActivations = [];
    if (activationTimer) {
      clearTimeout(activationTimer);
      activationTimer = null;
    }
  }
  
  logger.info('pool.activation.mode_changed', {
    enabled,
    cat: 'pools'
  });
  
  try {
    emit('log', {
      level: 'info',
      message: `pools:activation lazy mode ${enabled ? 'ENABLED' : 'DISABLED'}`,
      timestamp: new Date().toISOString(),
      context: { cat: 'pools' }
    });
  } catch {}
}

export function isLazyActivationEnabled(): boolean {
  return lazyActivationEnabled;
}

// setOnActivationBatch removed - no longer needed since incremental updates
// handle pool activation automatically through the decoder flow

/**
 * Attempt to activate a pool after receiving a valid update.
 * Returns true if this was the pool's first activation.
 * 
 * @param poolId - Pool address
 * @param dex - DEX name for logging
 * @param hasValidPrice - Whether the update included valid pricing
 */
export function tryActivatePool(
  poolId: string,
  dex: string,
  hasValidPrice: boolean
): boolean {
  // When lazy mode is disabled, all pools are implicitly active
  if (!lazyActivationEnabled) return false;
  
  // Only activate if we have valid pricing (Option 1B)
  if (!hasValidPrice) {
    logger.debug('pool.activation.skipped_no_price', {
      pool: poolId.slice(0, 8) + '…',
      dex,
      cat: 'pools'
    });
    return false;
  }
  
  // Check if already activated
  if (activatedPoolIds.has(poolId)) {
    return false; // Already active, not a new activation
  }
  
  // First valid update - ACTIVATE!
  const now = Date.now();
  activatedPoolIds.add(poolId);
  activationTimestamps.set(poolId, now);
  pendingActivations.push(poolId);
  
  logger.info('pool.activated', {
    pool: poolId.slice(0, 8) + '…',
    dex,
    totalActivated: activatedPoolIds.size,
    pendingBatch: pendingActivations.length,
    cat: 'pools'
  });
  
  // Schedule debounced batch processing (Option 2B)
  scheduleActivationBatch();
  
  return true;
}

/**
 * Check if a pool is activated (should be included in graph).
 * When lazy mode is disabled, returns true for all pools.
 */
export function isPoolActivated(poolId: string): boolean {
  if (!lazyActivationEnabled) return true;
  return activatedPoolIds.has(poolId);
}

/**
 * Filter a pools payload to only include activated pools.
 * Used by getGraphSnapshot() when lazy mode is enabled.
 */
export function filterActivatedPools<T extends { id: string }>(pools: T[]): T[] {
  if (!lazyActivationEnabled) return pools;
  return pools.filter(p => activatedPoolIds.has(p.id));
}

/**
 * Get activation statistics for monitoring.
 */
export function getActivationStats(): {
  enabled: boolean;
  activatedCount: number;
  pendingBatchCount: number;
} {
  return {
    enabled: lazyActivationEnabled,
    activatedCount: activatedPoolIds.size,
    pendingBatchCount: pendingActivations.length,
  };
}

/**
 * Get list of all activated pool IDs.
 */
export function getActivatedPoolIds(): string[] {
  return Array.from(activatedPoolIds);
}

/**
 * Clear all activation state (for testing or reset).
 */
export function clearActivationState(): void {
  activatedPoolIds.clear();
  activationTimestamps.clear();
  pendingActivations = [];
  if (activationTimer) {
    clearTimeout(activationTimer);
    activationTimer = null;
  }
}

// ============================================================================
// Internal
// ============================================================================

/**
 * Schedule a debounced notification after activations.
 * Note: No graph rebuild needed - the decoder's scheduleDexApply() already
 * triggered applyPoolUpdates which will include the newly activated pool.
 */
function scheduleActivationBatch(): void {
  if (activationTimer) return; // Already scheduled
  
  activationTimer = setTimeout(() => {
    activationTimer = null;
    
    if (pendingActivations.length === 0) return;
    
    const batch = pendingActivations.splice(0);
    
    logger.info('pool.activation.batch_flush', {
      count: batch.length,
      totalActivated: activatedPoolIds.size,
      cat: 'pools'
    });
    
    // Emit status update for UI
    try {
      emit('pool-activation-update', {
        activatedCount: activatedPoolIds.size,
        pendingBatchCount: 0,
        recentlyActivated: batch.slice(0, 10),
      });
    } catch {}
    
    try {
      emit('log', {
        level: 'info',
        message: `pools:activation ${batch.length} pools activated (incremental update)`,
        timestamp: new Date().toISOString(),
        context: { cat: 'pools', poolIds: batch.slice(0, 5) }
      });
    } catch {}
    
    // No rebuild needed - incremental updates handle it automatically
  }, ACTIVATION_DEBOUNCE_MS);
}
