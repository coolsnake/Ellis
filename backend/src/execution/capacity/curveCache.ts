/**
 * Capacity Curve Cache
 * 
 * In-memory cache for pre-computed capacity curves.
 * Curves are invalidated when tick/bin boundaries cross,
 * ensuring we always have accurate slippage estimates.
 */

import type { CapacityCurve, PoolType } from './types.js';
import { logger } from '../../utils/logger.js';

// ============================================================================
// Configuration
// ============================================================================

/** Maximum age of a curve before it's considered stale (ms) */
const CURVE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** Maximum number of curves to cache (LRU eviction) */
const MAX_CACHE_SIZE = 5000;

// ============================================================================
// Cache Storage
// ============================================================================

interface CacheEntry {
  curve: CapacityCurve;
  lastAccessedAt: number;
}

const cache = new Map<string, CacheEntry>();

// Stats for monitoring
let stats = {
  hits: 0,
  misses: 0,
  evictions: 0,
  invalidations: 0,
};

// ============================================================================
// Public API
// ============================================================================

/**
 * Get a capacity curve from cache
 * @returns The curve if found and not stale, undefined otherwise
 */
export function getCapacityCurve(poolId: string): CapacityCurve | undefined {
  const entry = cache.get(poolId);
  
  if (!entry) {
    stats.misses++;
    return undefined;
  }
  
  // Check if stale
  const now = Date.now();
  if (now - entry.curve.computedAt > CURVE_TTL_MS) {
    cache.delete(poolId);
    stats.misses++;
    return undefined;
  }
  
  // Update LRU timestamp
  entry.lastAccessedAt = now;
  stats.hits++;
  
  return entry.curve;
}

/**
 * Store a capacity curve in cache
 */
export function setCapacityCurve(poolId: string, curve: CapacityCurve): void {
  // Evict if at capacity
  if (cache.size >= MAX_CACHE_SIZE && !cache.has(poolId)) {
    evictLRU();
  }
  
  cache.set(poolId, {
    curve,
    lastAccessedAt: Date.now(),
  });
  
  logger.debug('capacity.cache.set', {
    cat: 'sizing',
    poolId: poolId.slice(0, 12) + '...',
    poolType: curve.poolType,
    confidence: curve.confidence,
    breakEvenUsd: curve.breakEvenSizeUsd.toFixed(2),
    activeLiquidityUsd: curve.activeLiquidityUsd.toFixed(2),
    curvePoints: curve.curve.size,
  });
}

/**
 * Invalidate a specific pool's curve
 * Called when tick/bin boundary crossing is detected
 */
export function invalidateCapacityCurve(poolId: string): void {
  if (cache.delete(poolId)) {
    stats.invalidations++;
    logger.debug('capacity.cache.invalidate', {
      cat: 'sizing',
      poolId: poolId.slice(0, 12) + '...',
    });
  }
}

/**
 * Invalidate all curves for a specific pool type
 * Useful when adjustments change
 */
export function invalidateByPoolType(poolType: PoolType): void {
  let count = 0;
  for (const [poolId, entry] of cache.entries()) {
    if (entry.curve.poolType === poolType) {
      cache.delete(poolId);
      count++;
    }
  }
  stats.invalidations += count;
  
  if (count > 0) {
    logger.debug('capacity.cache.invalidate_by_type', {
      cat: 'sizing',
      poolType,
      count,
    });
  }
}

/**
 * Check if a curve exists and is fresh
 */
export function hasValidCurve(poolId: string): boolean {
  const entry = cache.get(poolId);
  if (!entry) return false;
  
  return Date.now() - entry.curve.computedAt < CURVE_TTL_MS;
}

/**
 * Get cache statistics
 */
export function getCacheStats(): {
  size: number;
  hits: number;
  misses: number;
  hitRate: number;
  evictions: number;
  invalidations: number;
  byPoolType: Record<PoolType, number>;
} {
  const byPoolType: Record<PoolType, number> = { amm: 0, clmm: 0, dlmm: 0 };
  
  for (const entry of cache.values()) {
    byPoolType[entry.curve.poolType]++;
  }
  
  const total = stats.hits + stats.misses;
  
  return {
    size: cache.size,
    hits: stats.hits,
    misses: stats.misses,
    hitRate: total > 0 ? stats.hits / total : 0,
    evictions: stats.evictions,
    invalidations: stats.invalidations,
    byPoolType,
  };
}

/**
 * Reset cache statistics (for testing)
 */
export function resetStats(): void {
  stats = {
    hits: 0,
    misses: 0,
    evictions: 0,
    invalidations: 0,
  };
}

/**
 * Clear entire cache (for testing or config changes)
 */
export function clearCache(): void {
  cache.clear();
  logger.debug('capacity.cache.cleared', { cat: 'sizing' });
}

/**
 * Get all cached pool IDs (for debugging)
 */
export function getCachedPoolIds(): string[] {
  return Array.from(cache.keys());
}

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * Evict least recently used entry
 */
function evictLRU(): void {
  let oldestKey: string | null = null;
  let oldestTime = Infinity;
  
  for (const [key, entry] of cache.entries()) {
    if (entry.lastAccessedAt < oldestTime) {
      oldestTime = entry.lastAccessedAt;
      oldestKey = key;
    }
  }
  
  if (oldestKey) {
    cache.delete(oldestKey);
    stats.evictions++;
  }
}

/**
 * Periodic cleanup of stale entries
 * Called automatically every minute
 */
function cleanupStale(): void {
  const now = Date.now();
  let cleaned = 0;
  
  for (const [poolId, entry] of cache.entries()) {
    if (now - entry.curve.computedAt > CURVE_TTL_MS) {
      cache.delete(poolId);
      cleaned++;
    }
  }
  
  if (cleaned > 0) {
    logger.debug('capacity.cache.cleanup', {
      cat: 'sizing',
      cleaned,
      remaining: cache.size,
    });
  }
}

// Run cleanup every minute
const cleanupInterval = setInterval(cleanupStale, 60_000);

// Ensure cleanup doesn't prevent process exit
if (typeof cleanupInterval.unref === 'function') {
  cleanupInterval.unref();
}
