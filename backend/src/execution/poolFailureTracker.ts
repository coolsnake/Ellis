/**
 * Pool Failure Tracker
 * 
 * Tracks pool failures from transaction simulations/executions and automatically
 * quarantines pools that exceed a failure threshold within a time window.
 * 
 * Features:
 * - Automatic quarantine after N failures within time window
 * - Time-windowed failure tracking (old failures expire)
 * - Manual pool blocklist support (persisted via config)
 * - Automatic quarantine expiration
 * - Realtime events for UI updates
 */

import { logger } from '../utils/logger.js';
import { emit } from '../server/realtime.js';

// ============================================================================
// Types
// ============================================================================

export interface PoolQuarantineConfig {
  /** Enable/disable the entire quarantine system */
  enabled: boolean;
  /** Number of failures before quarantine (default: 5) */
  maxFailures: number;
  /** Time window for counting failures in ms (default: 5 min) */
  windowMs: number;
  /** How long to quarantine a pool in ms (default: 15 min) */
  quarantineDurationMs: number;
}

interface PoolFailureRecord {
  poolId: string;
  dex: string;
  errors: Array<{
    error: string;
    timestamp: number;
    traceId?: string;
  }>;
  lastFailure: number;
}

interface QuarantineEntry {
  until: number;
  reason: string;
  failureCount: number;
  dex: string;
  quarantinedAt: number;
}

export interface QuarantineStats {
  enabled: boolean;
  config: PoolQuarantineConfig;
  tracked: number;
  quarantined: number;
  manuallyBlocked: number;
  quarantinedPools: Array<{
    poolId: string;
    dex: string;
    until: number;
    reason: string;
    remainingMs: number;
  }>;
  topFailures: Array<{
    poolId: string;
    dex: string;
    failures: number;
    lastFailure: number;
  }>;
  manualBlocklist: string[];
}

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_CONFIG: PoolQuarantineConfig = {
  enabled: true,
  maxFailures: 5,
  windowMs: 5 * 60 * 1000,         // 5 minutes
  quarantineDurationMs: 15 * 60 * 1000, // 15 minutes
};

// ============================================================================
// State
// ============================================================================

/** Current configuration */
let config: PoolQuarantineConfig = { ...DEFAULT_CONFIG };

/** Pool failure tracking (in-memory, time-windowed) */
const poolFailures = new Map<string, PoolFailureRecord>();

/** Currently quarantined pools (auto-quarantine, in-memory) */
const quarantinedPools = new Map<string, QuarantineEntry>();

/** Manually blocklisted pools (from config, persisted) */
let manualBlocklist = new Set<string>();

/** Maximum errors to keep per pool (memory bound) */
const MAX_ERRORS_PER_POOL = 20;

// ============================================================================
// Configuration
// ============================================================================

/**
 * Update quarantine configuration
 */
export function setQuarantineConfig(cfg: Partial<PoolQuarantineConfig>): void {
  config = { ...config, ...cfg };
  logger.info('pool.quarantine.config_updated', {
    cat: 'execution',
    config,
  });
}

/**
 * Get current configuration
 */
export function getQuarantineConfig(): PoolQuarantineConfig {
  return { ...config };
}

/**
 * Set manual pool blocklist (from persisted config)
 */
export function setManualBlocklist(poolIds: string[]): void {
  manualBlocklist = new Set(poolIds.filter(id => id && typeof id === 'string'));
  logger.info('pool.blocklist.updated', {
    cat: 'execution',
    count: manualBlocklist.size,
    pools: Array.from(manualBlocklist).slice(0, 10),
  });
}

/**
 * Get manual blocklist
 */
export function getManualBlocklist(): string[] {
  return Array.from(manualBlocklist);
}

/**
 * Add a pool to manual blocklist
 */
export function addToManualBlocklist(poolId: string): void {
  if (poolId && typeof poolId === 'string') {
    manualBlocklist.add(poolId);
    logger.info('pool.blocklist.added', {
      cat: 'execution',
      poolId,
    });
  }
}

/**
 * Remove a pool from manual blocklist
 */
export function removeFromManualBlocklist(poolId: string): void {
  manualBlocklist.delete(poolId);
  logger.info('pool.blocklist.removed', {
    cat: 'execution',
    poolId,
  });
}

// ============================================================================
// Failure Recording
// ============================================================================

/**
 * Record a pool failure from a transaction simulation/execution error.
 * Call this from arbExecutor when a transaction fails, with the failing hop identified.
 */
export function recordPoolFailure(
  poolId: string,
  dex: string,
  error: string,
  traceId?: string
): void {
  if (!config.enabled) return;
  if (!poolId || typeof poolId !== 'string') return;

  const now = Date.now();

  try {
    // Get or create failure record
    let record = poolFailures.get(poolId);
    if (!record) {
      record = {
        poolId,
        dex,
        errors: [],
        lastFailure: 0,
      };
      poolFailures.set(poolId, record);
    }

    // Clean old errors outside the window
    record.errors = record.errors.filter(e => now - e.timestamp < config.windowMs);

    // Add new error (bounded)
    record.errors.push({
      error: error.slice(0, 500), // Limit error message length
      timestamp: now,
      traceId,
    });

    // Bound the errors array
    if (record.errors.length > MAX_ERRORS_PER_POOL) {
      record.errors = record.errors.slice(-MAX_ERRORS_PER_POOL);
    }

    record.lastFailure = now;
    record.dex = dex; // Update dex in case it changed

    const failureCount = record.errors.length;

    logger.info('pool.failure.recorded', {
      cat: 'execution',
      poolId: poolId.slice(0, 16) + '...',
      dex,
      failureCount,
      threshold: config.maxFailures,
      error: error.slice(0, 100),
      traceId,
    });

    // Emit realtime event
    try {
      emit('pool:failure:recorded', {
        poolId,
        dex,
        failureCount,
        threshold: config.maxFailures,
        timestamp: now,
      });
    } catch {}

    // Check if pool should be quarantined
    if (failureCount >= config.maxFailures) {
      quarantinePool(poolId, dex, record);
    }
  } catch (e) {
    // Non-blocking - don't let tracking errors affect execution
    try {
      logger.warn('pool.failure.record_error', {
        cat: 'execution',
        error: String((e as any)?.message || e),
        poolId,
      });
    } catch {}
  }
}

/**
 * Quarantine a pool after exceeding failure threshold
 */
function quarantinePool(poolId: string, dex: string, record: PoolFailureRecord): void {
  const now = Date.now();
  const until = now + config.quarantineDurationMs;
  const failureCount = record.errors.length;
  const reason = `${failureCount} failures in ${Math.round(config.windowMs / 1000)}s`;

  quarantinedPools.set(poolId, {
    until,
    reason,
    failureCount,
    dex,
    quarantinedAt: now,
  });

  // Clear failure record since pool is now quarantined
  poolFailures.delete(poolId);

  logger.warn('pool.quarantined', {
    cat: 'execution',
    poolId: poolId.slice(0, 16) + '...',
    dex,
    failureCount,
    quarantineUntil: new Date(until).toISOString(),
    durationMs: config.quarantineDurationMs,
    reason,
    recentErrors: record.errors.slice(-3).map(e => e.error.slice(0, 50)),
  });

  // Emit realtime event
  try {
    emit('pool:quarantined', {
      poolId,
      dex,
      until,
      reason,
      failureCount,
      durationMs: config.quarantineDurationMs,
    });
  } catch {}
}

// ============================================================================
// Quarantine Checking
// ============================================================================

/**
 * Check if a pool is currently quarantined (auto or manual)
 */
export function isPoolQuarantined(poolId: string): boolean {
  if (!poolId) return false;

  // Check manual blocklist first
  if (manualBlocklist.has(poolId)) {
    return true;
  }

  // Check auto-quarantine (only if enabled)
  if (!config.enabled) return false;

  const q = quarantinedPools.get(poolId);
  if (!q) return false;

  // Check if quarantine expired
  if (Date.now() > q.until) {
    quarantinedPools.delete(poolId);
    
    logger.info('pool.quarantine.expired', {
      cat: 'execution',
      poolId: poolId.slice(0, 16) + '...',
      dex: q.dex,
    });

    // Emit realtime event
    try {
      emit('pool:quarantine:expired', {
        poolId,
        dex: q.dex,
      });
    } catch {}

    return false;
  }

  return true;
}

/**
 * Check if a pool is in the manual blocklist
 */
export function isPoolManuallyBlocked(poolId: string): boolean {
  return manualBlocklist.has(poolId);
}

/**
 * Filter out quarantined/blocked pools from an opportunity's pool list.
 * Returns which pools are allowed and which are blocked.
 */
export function filterQuarantinedPools(poolIds: string[]): {
  allowed: string[];
  blocked: string[];
  reasons: Map<string, string>;
} {
  const allowed: string[] = [];
  const blocked: string[] = [];
  const reasons = new Map<string, string>();

  for (const poolId of poolIds) {
    if (!poolId) continue;

    // Check manual blocklist
    if (manualBlocklist.has(poolId)) {
      blocked.push(poolId);
      reasons.set(poolId, 'manual_blocklist');
      continue;
    }

    // Check auto-quarantine
    if (config.enabled && isPoolQuarantined(poolId)) {
      blocked.push(poolId);
      const q = quarantinedPools.get(poolId);
      reasons.set(poolId, q ? `quarantined: ${q.reason}` : 'quarantined');
      continue;
    }

    allowed.push(poolId);
  }

  return { allowed, blocked, reasons };
}

/**
 * Check if any pool in the list is quarantined/blocked
 */
export function hasQuarantinedPool(poolIds: string[]): boolean {
  for (const poolId of poolIds) {
    if (isPoolQuarantined(poolId)) return true;
  }
  return false;
}

// ============================================================================
// Management
// ============================================================================

/**
 * Remove a specific pool from quarantine (manual override)
 */
export function removeFromQuarantine(poolId: string): boolean {
  const existed = quarantinedPools.has(poolId);
  quarantinedPools.delete(poolId);
  poolFailures.delete(poolId);

  if (existed) {
    logger.info('pool.quarantine.removed', {
      cat: 'execution',
      poolId,
    });
  }

  return existed;
}

/**
 * Clear all auto-quarantines
 */
export function clearAllQuarantines(): number {
  const count = quarantinedPools.size;
  quarantinedPools.clear();
  poolFailures.clear();

  logger.info('pool.quarantine.cleared_all', {
    cat: 'execution',
    count,
  });

  return count;
}

/**
 * Get current quarantine statistics for UI/monitoring
 */
export function getQuarantineStats(): QuarantineStats {
  const now = Date.now();

  // Clean expired quarantines
  for (const [poolId, q] of quarantinedPools) {
    if (now > q.until) {
      quarantinedPools.delete(poolId);
      try {
        emit('pool:quarantine:expired', { poolId, dex: q.dex });
      } catch {}
    }
  }

  // Build quarantined pools list
  const quarantinedPoolsList = Array.from(quarantinedPools.entries())
    .map(([poolId, q]) => ({
      poolId,
      dex: q.dex,
      until: q.until,
      reason: q.reason,
      remainingMs: Math.max(0, q.until - now),
    }))
    .sort((a, b) => a.remainingMs - b.remainingMs);

  // Build top failures list
  const topFailures = Array.from(poolFailures.values())
    .filter(p => p.errors.length > 0)
    .map(p => ({
      poolId: p.poolId,
      dex: p.dex,
      failures: p.errors.filter(e => now - e.timestamp < config.windowMs).length,
      lastFailure: p.lastFailure,
    }))
    .filter(p => p.failures > 0)
    .sort((a, b) => b.failures - a.failures)
    .slice(0, 10);

  return {
    enabled: config.enabled,
    config: { ...config },
    tracked: poolFailures.size,
    quarantined: quarantinedPools.size,
    manuallyBlocked: manualBlocklist.size,
    quarantinedPools: quarantinedPoolsList,
    topFailures,
    manualBlocklist: Array.from(manualBlocklist),
  };
}

// ============================================================================
// Cleanup
// ============================================================================

/**
 * Periodic cleanup of stale data
 */
function cleanupStaleData(): void {
  const now = Date.now();

  // Clean old failure records
  for (const [poolId, record] of poolFailures) {
    record.errors = record.errors.filter(e => now - e.timestamp < config.windowMs);
    if (record.errors.length === 0) {
      poolFailures.delete(poolId);
    }
  }

  // Clean expired quarantines
  for (const [poolId, q] of quarantinedPools) {
    if (now > q.until) {
      quarantinedPools.delete(poolId);
      logger.info('pool.quarantine.expired', {
        cat: 'execution',
        poolId: poolId.slice(0, 16) + '...',
        dex: q.dex,
      });
      try {
        emit('pool:quarantine:expired', { poolId, dex: q.dex });
      } catch {}
    }
  }
}

// Run cleanup every 60 seconds
setInterval(cleanupStaleData, 60_000);

// ============================================================================
// Initialization
// ============================================================================

/**
 * Initialize the tracker with config from persisted settings
 */
export function initializeTracker(
  quarantineConfig?: Partial<PoolQuarantineConfig>,
  blocklist?: string[]
): void {
  if (quarantineConfig) {
    setQuarantineConfig(quarantineConfig);
  }
  if (blocklist) {
    setManualBlocklist(blocklist);
  }
  
  logger.info('pool.quarantine.initialized', {
    cat: 'execution',
    enabled: config.enabled,
    maxFailures: config.maxFailures,
    windowMs: config.windowMs,
    quarantineDurationMs: config.quarantineDurationMs,
    manualBlocklistSize: manualBlocklist.size,
  });
}
