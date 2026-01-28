/**
 * Pool Substitution Store
 * 
 * Persists learned pool substitutions across opportunities. When we discover that
 * an alternative pool performs better than the originally selected pool for a hop,
 * we store this mapping so future opportunities can use the better pool directly.
 * 
 * Key insight: The "best rate" pool selected by arb-rs may have stale prices or
 * worse actual execution. By learning from simulation feedback, we can proactively
 * substitute problematic pools before wasting simulation cycles.
 */

import { logger } from '../utils/logger.js';
import { readJson, writeJson, ensureDir, joinPath } from '../utils/fs.js';
import { CONFIG } from '../utils/config.js';

// Types
export interface PoolSubstitution {
  /** Original pool that was problematic */
  originalPoolId: string;
  originalDex: string;
  /** Better alternative pool */
  alternativePoolId: string;
  alternativeDex: string;
  /** Token pair for this substitution (direction matters!) */
  inputMint: string;
  outputMint: string;
  /** Statistics */
  successCount: number;      // Times the alternative succeeded
  failureCount: number;      // Times the alternative also failed
  originalFailCount: number; // Times the original failed before we found this
  /** Timestamps */
  firstLearnedMs: number;
  lastSuccessMs: number;
  lastFailureMs: number | null;
  /** Average slippage improvement in bps */
  avgSlippageImprovementBps: number;
}

export interface PoolSubstitutionConfig {
  /** Enable/disable the substitution system */
  enabled: boolean;
  /** Minimum successes before trusting a substitution */
  minSuccessCount: number;
  /** Maximum failure rate (failures / total) before disabling substitution */
  maxFailureRate: number;
  /** TTL for stale substitutions (ms) - substitutions older than this are re-evaluated */
  staleTtlMs: number;
  /** TTL for expired substitutions (ms) - substitutions older than this are removed */
  expireTtlMs: number;
  /** Persist to disk */
  persistToDisk: boolean;
}

const DEFAULT_CONFIG: PoolSubstitutionConfig = {
  enabled: true,
  minSuccessCount: 2,        // Need at least 2 successes before trusting
  maxFailureRate: 0.3,       // Disable if >30% failure rate
  staleTtlMs: 5 * 60 * 1000, // 5 minutes - re-evaluate after this
  expireTtlMs: 30 * 60 * 1000, // 30 minutes - remove after this
  persistToDisk: true,
};

// In-memory store: key = `${inputMint}:${outputMint}:${originalPoolId}`
const substitutions = new Map<string, PoolSubstitution>();

// Configuration
let config: PoolSubstitutionConfig = { ...DEFAULT_CONFIG };

// Persistence file path
const PERSISTENCE_FILE = 'pool-substitutions.json';

/**
 * Generate a unique key for a pool substitution
 */
function makeKey(inputMint: string, outputMint: string, originalPoolId: string): string {
  return `${inputMint}:${outputMint}:${originalPoolId}`;
}

/**
 * Initialize the substitution store with optional config
 */
export function initPoolSubstitutionStore(cfg?: Partial<PoolSubstitutionConfig>): void {
  if (cfg) {
    config = { ...DEFAULT_CONFIG, ...cfg };
  }
  
  // Load persisted substitutions
  if (config.persistToDisk) {
    loadFromDisk().catch(err => {
      logger.warn('poolsub.load.failed', { cat: 'arb', error: String(err) });
    });
  }
  
  logger.info('poolsub.init', {
    cat: 'arb',
    config: {
      enabled: config.enabled,
      minSuccessCount: config.minSuccessCount,
      maxFailureRate: config.maxFailureRate,
      staleTtlMs: config.staleTtlMs,
    },
  });
}

/**
 * Update configuration
 */
export function setPoolSubstitutionConfig(cfg: Partial<PoolSubstitutionConfig>): void {
  config = { ...config, ...cfg };
}

/**
 * Get current configuration
 */
export function getPoolSubstitutionConfig(): PoolSubstitutionConfig {
  return { ...config };
}

/**
 * Record a successful pool substitution
 */
export function recordSubstitutionSuccess(
  inputMint: string,
  outputMint: string,
  originalPoolId: string,
  originalDex: string,
  alternativePoolId: string,
  alternativeDex: string,
  slippageImprovementBps: number = 0
): void {
  if (!config.enabled) return;
  
  const key = makeKey(inputMint, outputMint, originalPoolId);
  const now = Date.now();
  
  const existing = substitutions.get(key);
  
  if (existing && existing.alternativePoolId === alternativePoolId) {
    // Update existing substitution
    existing.successCount++;
    existing.lastSuccessMs = now;
    // Update rolling average slippage improvement
    existing.avgSlippageImprovementBps = (
      (existing.avgSlippageImprovementBps * (existing.successCount - 1) + slippageImprovementBps)
      / existing.successCount
    );
  } else {
    // New substitution (or different alternative)
    substitutions.set(key, {
      originalPoolId,
      originalDex,
      alternativePoolId,
      alternativeDex,
      inputMint,
      outputMint,
      successCount: 1,
      failureCount: 0,
      originalFailCount: 1,
      firstLearnedMs: now,
      lastSuccessMs: now,
      lastFailureMs: null,
      avgSlippageImprovementBps: slippageImprovementBps,
    });
  }
  
  logger.info('poolsub.success.recorded', {
    cat: 'arb',
    inputMint: inputMint.slice(0, 8) + '...',
    outputMint: outputMint.slice(0, 8) + '...',
    originalPool: originalPoolId.slice(0, 12) + '...',
    alternativePool: alternativePoolId.slice(0, 12) + '...',
    successCount: substitutions.get(key)?.successCount,
    slippageImprovementBps,
  });
  
  // Persist async
  if (config.persistToDisk) {
    saveToDisk().catch(() => {});
  }
}

/**
 * Record a failed substitution attempt (alternative also failed)
 */
export function recordSubstitutionFailure(
  inputMint: string,
  outputMint: string,
  originalPoolId: string,
  alternativePoolId: string
): void {
  if (!config.enabled) return;
  
  const key = makeKey(inputMint, outputMint, originalPoolId);
  const existing = substitutions.get(key);
  
  if (existing && existing.alternativePoolId === alternativePoolId) {
    existing.failureCount++;
    existing.lastFailureMs = Date.now();
    
    // Check if we should disable this substitution
    const totalAttempts = existing.successCount + existing.failureCount;
    const failureRate = existing.failureCount / totalAttempts;
    
    if (failureRate > config.maxFailureRate && totalAttempts >= 3) {
      logger.warn('poolsub.disabled.high_failure_rate', {
        cat: 'arb',
        originalPool: originalPoolId.slice(0, 12) + '...',
        alternativePool: alternativePoolId.slice(0, 12) + '...',
        failureRate: failureRate.toFixed(2),
        successCount: existing.successCount,
        failureCount: existing.failureCount,
      });
      // Remove the substitution
      substitutions.delete(key);
    }
    
    // Persist async
    if (config.persistToDisk) {
      saveToDisk().catch(() => {});
    }
  }
}

/**
 * Record that the original pool failed (increments counter for stats)
 */
export function recordOriginalPoolFailure(
  inputMint: string,
  outputMint: string,
  originalPoolId: string
): void {
  if (!config.enabled) return;
  
  const key = makeKey(inputMint, outputMint, originalPoolId);
  const existing = substitutions.get(key);
  
  if (existing) {
    existing.originalFailCount++;
  }
}

/**
 * Look up a substitution for a given hop
 * Returns the alternative pool if we have a trusted substitution
 */
export function lookupSubstitution(
  inputMint: string,
  outputMint: string,
  originalPoolId: string
): { poolId: string; dex: string } | null {
  if (!config.enabled) return null;
  
  const key = makeKey(inputMint, outputMint, originalPoolId);
  const sub = substitutions.get(key);
  
  if (!sub) return null;
  
  const now = Date.now();
  const age = now - sub.lastSuccessMs;
  
  // Check if expired
  if (age > config.expireTtlMs) {
    substitutions.delete(key);
    logger.debug('poolsub.expired', {
      cat: 'arb',
      originalPool: originalPoolId.slice(0, 12) + '...',
      ageMs: age,
    });
    return null;
  }
  
  // Check if stale (still return but log warning)
  if (age > config.staleTtlMs) {
    logger.debug('poolsub.stale', {
      cat: 'arb',
      originalPool: originalPoolId.slice(0, 12) + '...',
      ageMs: age,
    });
    // Still return but mark as needing re-evaluation
  }
  
  // Check if we have enough confidence
  if (sub.successCount < config.minSuccessCount) {
    logger.debug('poolsub.insufficient_confidence', {
      cat: 'arb',
      originalPool: originalPoolId.slice(0, 12) + '...',
      successCount: sub.successCount,
      minRequired: config.minSuccessCount,
    });
    return null;
  }
  
  // Check failure rate
  const totalAttempts = sub.successCount + sub.failureCount;
  const failureRate = totalAttempts > 0 ? sub.failureCount / totalAttempts : 0;
  
  if (failureRate > config.maxFailureRate) {
    return null;
  }
  
  return {
    poolId: sub.alternativePoolId,
    dex: sub.alternativeDex,
  };
}

/**
 * Apply substitutions to an opportunity's hop pools
 * Returns modified arrays and a list of substitutions made
 */
export function applySubstitutions(
  path: string[],
  hopPoolIds: string[],
  hopDexes: string[]
): {
  modifiedPoolIds: string[];
  modifiedDexes: string[];
  substitutionsMade: Array<{
    hopIndex: number;
    originalPoolId: string;
    originalDex: string;
    newPoolId: string;
    newDex: string;
  }>;
} {
  if (!config.enabled) {
    return {
      modifiedPoolIds: [...hopPoolIds],
      modifiedDexes: [...hopDexes],
      substitutionsMade: [],
    };
  }
  
  const modifiedPoolIds = [...hopPoolIds];
  const modifiedDexes = [...hopDexes];
  const substitutionsMade: Array<{
    hopIndex: number;
    originalPoolId: string;
    originalDex: string;
    newPoolId: string;
    newDex: string;
  }> = [];
  
  for (let i = 0; i < hopPoolIds.length && i < path.length - 1; i++) {
    const inputMint = path[i];
    const outputMint = path[i + 1] || path[0]; // Wrap for cycles
    const originalPoolId = hopPoolIds[i];
    const originalDex = hopDexes[i] || '';
    
    const sub = lookupSubstitution(inputMint, outputMint, originalPoolId);
    
    if (sub) {
      modifiedPoolIds[i] = sub.poolId;
      modifiedDexes[i] = sub.dex;
      
      substitutionsMade.push({
        hopIndex: i,
        originalPoolId,
        originalDex,
        newPoolId: sub.poolId,
        newDex: sub.dex,
      });
    }
  }
  
  if (substitutionsMade.length > 0) {
    logger.info('poolsub.applied', {
      cat: 'arb',
      path: path.slice(0, 3).map(m => m.slice(0, 8) + '...').join('->'),
      substitutionCount: substitutionsMade.length,
      substitutions: substitutionsMade.map(s => ({
        hop: s.hopIndex,
        from: s.originalPoolId.slice(0, 12) + '...',
        to: s.newPoolId.slice(0, 12) + '...',
      })),
    });
  }
  
  return {
    modifiedPoolIds,
    modifiedDexes,
    substitutionsMade,
  };
}

/**
 * Get all current substitutions (for debugging/monitoring)
 */
export function getAllSubstitutions(): PoolSubstitution[] {
  return Array.from(substitutions.values());
}

/**
 * Get substitution stats
 */
export function getSubstitutionStats(): {
  total: number;
  active: number;
  stale: number;
  totalSuccesses: number;
  totalFailures: number;
} {
  const now = Date.now();
  let active = 0;
  let stale = 0;
  let totalSuccesses = 0;
  let totalFailures = 0;
  
  for (const sub of substitutions.values()) {
    const age = now - sub.lastSuccessMs;
    if (age > config.staleTtlMs) {
      stale++;
    } else {
      active++;
    }
    totalSuccesses += sub.successCount;
    totalFailures += sub.failureCount;
  }
  
  return {
    total: substitutions.size,
    active,
    stale,
    totalSuccesses,
    totalFailures,
  };
}

/**
 * Clear all substitutions
 */
export function clearSubstitutions(): void {
  substitutions.clear();
  logger.info('poolsub.cleared', { cat: 'arb' });
  
  if (config.persistToDisk) {
    saveToDisk().catch(() => {});
  }
}

/**
 * Remove expired substitutions
 */
export function pruneExpired(): number {
  const now = Date.now();
  let pruned = 0;
  
  for (const [key, sub] of substitutions.entries()) {
    const age = now - sub.lastSuccessMs;
    if (age > config.expireTtlMs) {
      substitutions.delete(key);
      pruned++;
    }
  }
  
  if (pruned > 0) {
    logger.debug('poolsub.pruned', { cat: 'arb', count: pruned });
    
    if (config.persistToDisk) {
      saveToDisk().catch(() => {});
    }
  }
  
  return pruned;
}

// Persistence functions

async function getFilePath(): Promise<string> {
  await ensureDir(CONFIG.cacheDir);
  return joinPath(CONFIG.cacheDir, PERSISTENCE_FILE);
}

async function saveToDisk(): Promise<void> {
  try {
    const filePath = await getFilePath();
    const data = {
      version: 1,
      timestamp: Date.now(),
      substitutions: Array.from(substitutions.entries()),
    };
    await writeJson(filePath, data);
  } catch (err) {
    logger.warn('poolsub.save.failed', { cat: 'arb', error: String(err) });
  }
}

async function loadFromDisk(): Promise<void> {
  try {
    const filePath = await getFilePath();
    const data = await readJson<{
      version: number;
      timestamp: number;
      substitutions: Array<[string, PoolSubstitution]>;
    }>(filePath, null as any);
    
    if (!data || !data.substitutions) {
      return;
    }
    
    // Clear and reload
    substitutions.clear();
    let loaded = 0;
    let skipped = 0;
    const now = Date.now();
    
    for (const [key, sub] of data.substitutions) {
      // Skip expired
      const age = now - sub.lastSuccessMs;
      if (age > config.expireTtlMs) {
        skipped++;
        continue;
      }
      
      substitutions.set(key, sub);
      loaded++;
    }
    
    logger.info('poolsub.loaded', {
      cat: 'arb',
      loaded,
      skipped,
      fileTimestamp: data.timestamp,
    });
  } catch (err) {
    // File doesn't exist or is corrupted - that's fine
    logger.debug('poolsub.load.not_found', { cat: 'arb' });
  }
}

// Start pruning timer
let pruneTimer: NodeJS.Timeout | null = null;

export function startPruneTimer(intervalMs: number = 60_000): void {
  if (pruneTimer) {
    clearInterval(pruneTimer);
  }
  
  pruneTimer = setInterval(() => {
    pruneExpired();
  }, intervalMs);
}

export function stopPruneTimer(): void {
  if (pruneTimer) {
    clearInterval(pruneTimer);
    pruneTimer = null;
  }
}
