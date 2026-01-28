/**
 * Per-pool staleness tracking and monitoring system
 * 
 * Monitors individual pool subscriptions for activity and provides visibility
 * into which pools haven't received updates within a threshold.
 * 
 * NOTE: This is primarily a diagnostic/alerting tool. Most "stale" pools are
 * simply inactive (low liquidity pairs that don't trade often), not dropped
 * subscriptions. No automatic resubscription is performed - the callback is
 * for logging and UI visibility only.
 * 
 * Use cases:
 * - Visibility into pool subscription health
 * - Detecting systemic connection issues (many pools stale at once)
 * - Debugging/troubleshooting subscription problems
 */

import { logger } from '../../../utils/logger.js';
import { emit } from '../../realtime.js';
import { CONFIG } from '../../../utils/config.js';
import type { DexSource } from './types.js';

/**
 * Per-pool activity tracking state
 */
export interface PoolActivityState {
  lastUpdateMs: number;
  subscriptionId?: number;
  dex: DexSource;
  accountAddress: string;
}

/**
 * Staleness check result
 */
export interface StalenessCheckResult {
  stalePools: Array<{
    poolId: string;
    dex: DexSource;
    ageMs: number;
    accountAddress: string;
  }>;
  healthyPools: number;
  totalTracked: number;
}

/**
 * Staleness monitor configuration (from CONFIG.system)
 */
interface StalenessConfig {
  /** Threshold in ms after which a pool is considered stale (default: 120000 = 2 min) */
  staleThresholdMs: number;
  /** Interval in ms between staleness checks (default: 60000 = 1 min) */
  checkIntervalMs: number;
  /** Enable/disable the staleness monitor (default: true) */
  enabled: boolean;
}

// ============================================================================
// Module State
// ============================================================================

/** Per-pool activity tracking */
const poolActivityMap: Map<string, PoolActivityState> = new Map();

/** Staleness check timer */
let stalenessTimer: NodeJS.Timeout | null = null;

/** Callback for handling stale pool notifications (logging/alerting only) */
let resubscribeCallback: ((stalePools: Array<{ poolId: string; dex: DexSource; ageMs: number; accountAddress: string }>) => Promise<void>) | null = null;

/** Last staleness check timestamp */
let lastCheckMs = 0;

// ============================================================================
// Configuration
// ============================================================================

/**
 * Get staleness configuration from CONFIG.system
 */
function getStalenessConfig(): StalenessConfig {
  const sys = CONFIG.system as any;
  return {
    staleThresholdMs: Number(sys?.wsPoolStaleThresholdMs ?? 120_000),
    checkIntervalMs: Number(sys?.wsPoolStaleCheckMs ?? 60_000),
    enabled: sys?.wsPoolStaleMonitorEnabled !== false,
  };
}

// ============================================================================
// Activity Tracking
// ============================================================================

/**
 * Record activity for a pool (called when WebSocket update is received)
 * 
 * @param poolId - Pool address
 * @param dex - DEX source
 * @param accountAddress - The account address that received the update
 * @param subscriptionId - Optional subscription ID for tracking
 */
export function recordPoolActivity(
  poolId: string,
  dex: DexSource,
  accountAddress: string,
  subscriptionId?: number
): void {
  const existing = poolActivityMap.get(poolId);
  const now = Date.now();
  
  if (existing) {
    existing.lastUpdateMs = now;
    if (subscriptionId !== undefined) {
      existing.subscriptionId = subscriptionId;
    }
  } else {
    poolActivityMap.set(poolId, {
      lastUpdateMs: now,
      subscriptionId,
      dex,
      accountAddress,
    });
  }
}

/**
 * Register a pool for staleness tracking without marking activity
 * Used when initially subscribing to a pool
 * 
 * @param poolId - Pool address
 * @param dex - DEX source
 * @param accountAddress - The account address being subscribed to
 * @param subscriptionId - Optional subscription ID
 */
export function registerPoolSubscription(
  poolId: string,
  dex: DexSource,
  accountAddress: string,
  subscriptionId?: number
): void {
  const existing = poolActivityMap.get(poolId);
  const now = Date.now();
  
  if (!existing) {
    poolActivityMap.set(poolId, {
      lastUpdateMs: now, // Start fresh
      subscriptionId,
      dex,
      accountAddress,
    });
  } else {
    // Update subscription info but preserve activity timestamp
    existing.accountAddress = accountAddress;
    if (subscriptionId !== undefined) {
      existing.subscriptionId = subscriptionId;
    }
  }
}

/**
 * Unregister a pool from staleness tracking
 * Called when unsubscribing from a pool
 * 
 * @param poolId - Pool address to remove
 */
export function unregisterPool(poolId: string): void {
  poolActivityMap.delete(poolId);
}

/**
 * Bulk unregister pools (used during retarget)
 * 
 * @param poolIds - Array of pool IDs to remove
 */
export function unregisterPools(poolIds: string[]): void {
  for (const poolId of poolIds) {
    poolActivityMap.delete(poolId);
  }
}

/**
 * Clear all pool tracking state
 * Used during full retarget or shutdown
 */
export function clearPoolActivityTracking(): void {
  poolActivityMap.clear();
  logger.info('pool.staleness.cleared', { cat: 'pools' });
}

// ============================================================================
// Staleness Detection
// ============================================================================

/**
 * Check all tracked pools for staleness
 * 
 * @returns StalenessCheckResult with stale pools and stats
 */
export function checkPoolStaleness(): StalenessCheckResult {
  const config = getStalenessConfig();
  const now = Date.now();
  const stalePools: StalenessCheckResult['stalePools'] = [];
  let healthyPools = 0;
  
  for (const [poolId, state] of poolActivityMap) {
    const ageMs = now - state.lastUpdateMs;
    
    if (ageMs > config.staleThresholdMs) {
      stalePools.push({
        poolId,
        dex: state.dex,
        ageMs,
        accountAddress: state.accountAddress,
      });
    } else {
      healthyPools++;
    }
  }
  
  return {
    stalePools,
    healthyPools,
    totalTracked: poolActivityMap.size,
  };
}

// ============================================================================
// Staleness Monitor
// ============================================================================

/**
 * Set the callback function for handling stale pools
 * This is called when stale pools are detected - purely for logging/alerting
 * No automatic resubscription is performed
 * 
 * @param callback - Async function that handles stale pool notifications
 */
export function setResubscribeCallback(
  callback: (stalePools: Array<{ poolId: string; dex: DexSource; ageMs: number; accountAddress: string }>) => Promise<void>
): void {
  resubscribeCallback = callback;
}

/**
 * Run a single staleness check and notify callback if stale pools are found
 */
async function runStalenessCheck(): Promise<void> {
  const config = getStalenessConfig();
  if (!config.enabled) return;
  
  const now = Date.now();
  lastCheckMs = now;
  
  const result = checkPoolStaleness();
  
  if (result.stalePools.length === 0) {
    // Periodic health log (every 5 checks = ~5 min with default 1 min interval)
    if (Math.random() < 0.2) {
      logger.debug('pool.staleness.check.healthy', {
        healthy: result.healthyPools,
        total: result.totalTracked,
        cat: 'pools'
      });
    }
    return;
  }
  
  // Log stale pools (info level - stale pools are expected for low-activity pairs)
  logger.info('pool.staleness.detected', {
    staleCount: result.stalePools.length,
    healthy: result.healthyPools,
    total: result.totalTracked,
    stalePools: result.stalePools.slice(0, 10).map(p => ({
      id: p.poolId.slice(0, 8) + '…',
      dex: p.dex,
      ageMs: p.ageMs,
    })),
    cat: 'pools'
  });
  
  // Notify callback for logging/alerting (no automatic resubscription)
  if (resubscribeCallback) {
    try {
      await resubscribeCallback(result.stalePools);
    } catch (err) {
      logger.error('pool.staleness.callback.failed', {
        error: String((err as Error)?.message || err),
        count: result.stalePools.length,
        cat: 'pools'
      });
    }
  }
}

/**
 * Start the staleness monitoring timer
 */
export function startStalenessMonitor(): void {
  const config = getStalenessConfig();
  
  if (!config.enabled) {
    logger.info('pool.staleness.monitor.disabled', { cat: 'pools' });
    return;
  }
  
  stopStalenessMonitor(); // Clear any existing timer
  
  logger.info('pool.staleness.monitor.started', {
    thresholdMs: config.staleThresholdMs,
    checkIntervalMs: config.checkIntervalMs,
    maxRetries: config.maxResubscribeAttempts,
    cat: 'pools'
  });
  
  emit('log', {
    level: 'info',
    message: `pools:staleness monitor started (threshold=${config.staleThresholdMs}ms, interval=${config.checkIntervalMs}ms)`,
    timestamp: new Date().toISOString(),
    context: { cat: 'pools' }
  });
  
  stalenessTimer = setInterval(() => {
    runStalenessCheck().catch(err => {
      logger.error('pool.staleness.check.error', {
        error: String((err as Error)?.message || err),
        cat: 'pools'
      });
    });
  }, config.checkIntervalMs);
}

/**
 * Stop the staleness monitoring timer
 */
export function stopStalenessMonitor(): void {
  if (stalenessTimer) {
    clearInterval(stalenessTimer);
    stalenessTimer = null;
    logger.info('pool.staleness.monitor.stopped', { cat: 'pools' });
  }
}

/**
 * Check if staleness monitor is running
 */
export function isStalenessMonitorRunning(): boolean {
  return stalenessTimer !== null;
}

// ============================================================================
// Status & Diagnostics
// ============================================================================

/**
 * Get staleness tracking status for diagnostics
 */
export function getStalenessStatus(): {
  monitorRunning: boolean;
  trackedPools: number;
  lastCheckMs: number;
  config: StalenessConfig;
  perDexCounts: Record<DexSource, number>;
  oldestActivityMs: number;
  newestActivityMs: number;
} {
  const config = getStalenessConfig();
  const perDexCounts: Record<DexSource, number> = {
    'raydium': 0,
    'raydium-cpmm': 0,
    'orca': 0,
    'meteora_dlmm': 0,
    'meteora_damm_v1': 0,
    'meteora_damm_v2': 0,
    'pumpswap': 0,
  };
  
  let oldestActivityMs = Date.now();
  let newestActivityMs = 0;
  
  for (const [, state] of poolActivityMap) {
    perDexCounts[state.dex]++;
    if (state.lastUpdateMs < oldestActivityMs) {
      oldestActivityMs = state.lastUpdateMs;
    }
    if (state.lastUpdateMs > newestActivityMs) {
      newestActivityMs = state.lastUpdateMs;
    }
  }
  
  return {
    monitorRunning: stalenessTimer !== null,
    trackedPools: poolActivityMap.size,
    lastCheckMs,
    config,
    perDexCounts,
    oldestActivityMs: poolActivityMap.size > 0 ? oldestActivityMs : 0,
    newestActivityMs,
  };
}

/**
 * Get activity age for a specific pool
 * 
 * @param poolId - Pool to check
 * @returns Age in ms, or -1 if pool not tracked
 */
export function getPoolActivityAge(poolId: string): number {
  const state = poolActivityMap.get(poolId);
  if (!state) return -1;
  return Date.now() - state.lastUpdateMs;
}

/**
 * Get all tracked pool IDs
 */
export function getTrackedPoolIds(): string[] {
  return Array.from(poolActivityMap.keys());
}

/**
 * Get pools exceeding a given age threshold
 * 
 * @param thresholdMs - Age threshold in milliseconds
 * @returns Array of pool IDs exceeding threshold
 */
export function getPoolsExceedingAge(thresholdMs: number): string[] {
  const now = Date.now();
  const result: string[] = [];
  
  for (const [poolId, state] of poolActivityMap) {
    if (now - state.lastUpdateMs > thresholdMs) {
      result.push(poolId);
    }
  }
  
  return result;
}
