// @ts-nocheck
/**
 * Priority Fee Cache
 * 
 * Background service that polls getRecentPrioritizationFees and caches
 * the results for zero-latency reads during transaction execution.
 * 
 * Pattern follows jitoTipCache.ts exactly.
 */

import { getConnection } from '../wallet/wallet.js';
import { withRpcLimit } from '../utils/rpcLimiter.js';
import { logger } from '../utils/logger.js';

// ============================================================================
// Types
// ============================================================================

export interface PriorityFeeLevels {
  min: number;
  p25: number;      // 25th percentile (low)
  p50: number;      // 50th percentile (medium)
  p75: number;      // 75th percentile (high)
  p95: number;      // 95th percentile (very high)
  max: number;
}

interface PriorityFeeState {
  levels?: PriorityFeeLevels;
  ts?: number;
  sampleCount?: number;
}

// ============================================================================
// Module State (singleton pattern like jitoTipCache)
// ============================================================================

const state: PriorityFeeState = {};
let timer: ReturnType<typeof setInterval> | null = null;

// Fallback values when no data available
const FALLBACK_LEVELS: PriorityFeeLevels = {
  min: 1_000,
  p25: 10_000,
  p50: 50_000,
  p75: 100_000,
  p95: 500_000,
  max: 1_000_000,
};

// ============================================================================
// Background Feed
// ============================================================================

/**
 * Start background priority fee polling.
 * Call once at startup (e.g., in arbExecutor.start()).
 * 
 * @param intervalMs - Polling interval (default 10s, min 5s)
 */
export function startPriorityFeeFeed(intervalMs = 10_000): void {
  if (timer) return; // Already running
  
  const every = Math.max(5_000, Number(intervalMs));
  
  const step = async () => {
    try {
      const connection = getConnection();
      
      // Fetch recent priority fees (rate-limited)
      const recentFees = await withRpcLimit(
        () => connection.getRecentPrioritizationFees(),
        1,
        { module: 'fees', method: 'getRecentPrioritizationFees' }
      );
      
      if (!recentFees || recentFees.length === 0) {
        return; // Keep existing cache
      }
      
      // Extract non-zero fees and sort
      const fees = recentFees
        .map(f => f.prioritizationFee)
        .filter(f => f > 0)
        .sort((a, b) => a - b);
      
      if (fees.length === 0) {
        return; // Keep existing cache
      }
      
      // Calculate percentiles
      const percentile = (arr: number[], p: number): number => {
        const idx = Math.ceil((p / 100) * arr.length) - 1;
        return arr[Math.max(0, Math.min(idx, arr.length - 1))];
      };
      
      state.levels = {
        min: fees[0],
        p25: percentile(fees, 25),
        p50: percentile(fees, 50),
        p75: percentile(fees, 75),
        p95: percentile(fees, 95),
        max: fees[fees.length - 1],
      };
      state.sampleCount = fees.length;
      state.ts = Date.now();
      
      logger.debug('priority_fee.cache.updated', {
        cat: 'tx',
        ctx: {
          sampleCount: fees.length,
          p50: state.levels.p50,
          p75: state.levels.p75,
          p95: state.levels.p95,
        },
      });
    } catch (err) {
      // Silent fail - don't spam logs, keep existing cache
      logger.debug('priority_fee.cache.error', {
        cat: 'tx',
        error: String((err as any)?.message || err),
      });
    }
  };
  
  // Run immediately, then on interval
  step().catch(() => {});
  timer = setInterval(() => { step().catch(() => {}); }, every);
  
  logger.info('priority_fee.feed.started', { 
    cat: 'tx', 
    intervalMs: every,
  });
}

/**
 * Stop the background feed (for cleanup/testing)
 */
export function stopPriorityFeeFeed(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info('priority_fee.feed.stopped', { cat: 'tx' });
  }
}

// ============================================================================
// Synchronous Getters (Zero Latency)
// ============================================================================

/**
 * Get cached priority fee levels.
 * Returns fallback values if cache is empty or stale.
 * 
 * ZERO LATENCY - safe to call in hot path.
 */
export function getCachedPriorityFee(): PriorityFeeLevels {
  if (state.levels && state.ts) {
    // Check staleness (60 seconds max)
    const age = Date.now() - state.ts;
    if (age < 60_000) {
      return state.levels;
    }
  }
  return FALLBACK_LEVELS;
}

/**
 * Get recommended priority fee for a given urgency level.
 * 
 * ZERO LATENCY - safe to call in hot path.
 * 
 * @param urgency - 'low' | 'medium' | 'high' | 'critical'
 * @param minFloor - Minimum fee floor (default 1000)
 * @param maxCap - Maximum fee cap (default 2M)
 */
export function getRecommendedPriorityFee(
  urgency: 'low' | 'medium' | 'high' | 'critical' = 'medium',
  minFloor: number = 1_000,
  maxCap: number = 2_000_000
): number {
  const levels = getCachedPriorityFee();
  
  let fee: number;
  switch (urgency) {
    case 'low':
      fee = levels.p25;
      break;
    case 'medium':
      fee = levels.p50;
      break;
    case 'high':
      fee = levels.p75;
      break;
    case 'critical':
      fee = levels.p95;
      break;
    default:
      fee = levels.p50;
  }
  
  return Math.max(minFloor, Math.min(maxCap, fee));
}

/**
 * Get cache metadata for debugging/logging.
 */
export function getPriorityFeeCacheInfo(): {
  hasCachedData: boolean;
  ageMs: number | null;
  sampleCount: number | null;
  levels: PriorityFeeLevels | null;
} {
  return {
    hasCachedData: !!state.levels,
    ageMs: state.ts ? Date.now() - state.ts : null,
    sampleCount: state.sampleCount ?? null,
    levels: state.levels ?? null,
  };
}
