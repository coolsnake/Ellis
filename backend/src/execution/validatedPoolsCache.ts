/**
 * Validated Pools Cache
 * 
 * Tracks pools that have been validated through successful swap execution.
 * A pool is "validated" when:
 * - A transaction simulation succeeded (all swaps executed)
 * - A transaction got 6007 error (swaps worked, only profit check failed)
 * 
 * When ALL pools in a route are validated, simulation can be skipped
 * to reduce latency and improve execution speed.
 */

import { logger } from '../utils/logger.js';
import type { DirectHop } from './types.js';

export interface PoolValidation {
  poolId: string;
  lastValidatedAt: number;
  successCount: number;
  sixOhSevenCount: number;  // 6007 errors (swaps worked but no profit)
  lastDex: string;
  lastVariant: string;
  // Track recent outcomes for analysis
  recentOutcomes: Array<{ outcome: 'success' | '6007'; timestamp: number }>;
}

export interface SkipSimulationConfig {
  enabled: boolean;
  poolValidityMs?: number;      // How long a pool stays validated (default: 60000 = 1 min)
  minValidations?: number;      // Require N validations before trusting (default: 1)
  maxRecentOutcomes?: number;   // Keep last N outcomes per pool (default: 10)
}

const DEFAULT_VALIDITY_MS = 300_000;  // 5 minutes - pools stay validated longer for better hit rate
const DEFAULT_MIN_VALIDATIONS = 1;
const DEFAULT_MAX_RECENT_OUTCOMES = 10;

class ValidatedPoolsCacheImpl {
  private pools: Map<string, PoolValidation> = new Map();
  private config: SkipSimulationConfig = { enabled: false };
  
  /**
   * Configure the cache
   */
  setConfig(config: SkipSimulationConfig): void {
    this.config = config;
    logger.info('validatedPoolsCache.config_updated', {
      cat: 'cache',
      ctx: {
        enabled: config.enabled,
        poolValidityMs: config.poolValidityMs ?? DEFAULT_VALIDITY_MS,
        minValidations: config.minValidations ?? DEFAULT_MIN_VALIDATIONS,
      },
    });
  }
  
  /**
   * Get current configuration
   */
  getConfig(): SkipSimulationConfig {
    return this.config;
  }
  
  /**
   * Check if skip simulation is enabled
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }
  
  /**
   * Mark a pool as validated after successful swap or 6007 error
   * @param poolId - The pool ID (base ID without #rev suffix)
   * @param dex - DEX name
   * @param variant - Pool variant (clmm, amm, dlmm, etc.)
   * @param outcome - 'success' for successful sim, '6007' for profit check failure
   */
  markValidated(poolId: string, dex: string, variant: string, outcome: 'success' | '6007'): void {
    const cleanPoolId = poolId.replace(/[#-]rev$/, '');
    const now = Date.now();
    const maxOutcomes = this.config.maxRecentOutcomes ?? DEFAULT_MAX_RECENT_OUTCOMES;
    
    const existing = this.pools.get(cleanPoolId);
    
    if (existing) {
      // Update existing validation
      existing.lastValidatedAt = now;
      existing.lastDex = dex;
      existing.lastVariant = variant;
      
      if (outcome === 'success') {
        existing.successCount++;
      } else {
        existing.sixOhSevenCount++;
      }
      
      // Add to recent outcomes, keeping only last N
      existing.recentOutcomes.push({ outcome, timestamp: now });
      if (existing.recentOutcomes.length > maxOutcomes) {
        existing.recentOutcomes.shift();
      }
    } else {
      // Create new validation entry
      this.pools.set(cleanPoolId, {
        poolId: cleanPoolId,
        lastValidatedAt: now,
        successCount: outcome === 'success' ? 1 : 0,
        sixOhSevenCount: outcome === '6007' ? 1 : 0,
        lastDex: dex,
        lastVariant: variant,
        recentOutcomes: [{ outcome, timestamp: now }],
      });
    }
    
    logger.debug('validatedPoolsCache.pool_validated', {
      cat: 'cache',
      ctx: {
        poolId: cleanPoolId.slice(0, 8) + '...',
        dex,
        variant,
        outcome,
        totalValidations: this.getTotalValidations(cleanPoolId),
      },
    });
  }
  
  /**
   * Mark multiple pools as validated (convenience for marking all hops)
   */
  markAllValidated(hops: DirectHop[], outcome: 'success' | '6007'): void {
    for (const hop of hops) {
      this.markValidated(hop.poolId, hop.dex, hop.variant, outcome);
    }
  }
  
  /**
   * Invalidate a pool after a real failure (not 6007)
   * This removes the pool from the validated set
   */
  invalidate(poolId: string): void {
    const cleanPoolId = poolId.replace(/[#-]rev$/, '');
    const existed = this.pools.delete(cleanPoolId);
    
    if (existed) {
      logger.info('validatedPoolsCache.pool_invalidated', {
        cat: 'cache',
        ctx: {
          poolId: cleanPoolId.slice(0, 8) + '...',
          reason: 'real_failure',
        },
      });
    }
  }
  
  /**
   * Check if a single pool is validated (not stale and meets min validations)
   */
  isPoolValidated(poolId: string): boolean {
    if (!this.config.enabled) return false;
    
    const cleanPoolId = poolId.replace(/[#-]rev$/, '');
    const validation = this.pools.get(cleanPoolId);
    
    if (!validation) return false;
    
    const validityMs = this.config.poolValidityMs ?? DEFAULT_VALIDITY_MS;
    const minValidations = this.config.minValidations ?? DEFAULT_MIN_VALIDATIONS;
    const now = Date.now();
    
    // Check if validation is stale
    if (now - validation.lastValidatedAt > validityMs) {
      return false;
    }
    
    // Check if we have enough validations
    const totalValidations = validation.successCount + validation.sixOhSevenCount;
    if (totalValidations < minValidations) {
      return false;
    }
    
    return true;
  }
  
  /**
   * Check if ALL pools in a route are validated
   * This is the key check for whether to skip simulation
   */
  allPoolsValidated(hops: DirectHop[]): boolean {
    if (!this.config.enabled) return false;
    if (hops.length === 0) return false;
    
    for (const hop of hops) {
      if (!this.isPoolValidated(hop.poolId)) {
        return false;
      }
    }
    
    return true;
  }
  
  /**
   * Get validation info for a pool (for debugging/logging)
   */
  getValidation(poolId: string): PoolValidation | undefined {
    const cleanPoolId = poolId.replace(/[#-]rev$/, '');
    return this.pools.get(cleanPoolId);
  }
  
  /**
   * Get total validations for a pool
   */
  getTotalValidations(poolId: string): number {
    const cleanPoolId = poolId.replace(/[#-]rev$/, '');
    const validation = this.pools.get(cleanPoolId);
    if (!validation) return 0;
    return validation.successCount + validation.sixOhSevenCount;
  }
  
  /**
   * Get summary stats for logging
   */
  getStats(): { totalPools: number; validatedPools: number; totalValidations: number } {
    let validatedPools = 0;
    let totalValidations = 0;
    
    const validityMs = this.config.poolValidityMs ?? DEFAULT_VALIDITY_MS;
    const minValidations = this.config.minValidations ?? DEFAULT_MIN_VALIDATIONS;
    const now = Date.now();
    
    for (const [, validation] of this.pools) {
      const total = validation.successCount + validation.sixOhSevenCount;
      totalValidations += total;
      
      // Count as "validated" if not stale and meets min
      if (now - validation.lastValidatedAt <= validityMs && total >= minValidations) {
        validatedPools++;
      }
    }
    
    return {
      totalPools: this.pools.size,
      validatedPools,
      totalValidations,
    };
  }
  
  /**
   * Clean up stale entries (call periodically to prevent memory growth)
   */
  cleanup(): number {
    const validityMs = this.config.poolValidityMs ?? DEFAULT_VALIDITY_MS;
    const now = Date.now();
    const staleThreshold = validityMs * 2; // Keep for 2x validity period
    
    let removed = 0;
    for (const [poolId, validation] of this.pools) {
      if (now - validation.lastValidatedAt > staleThreshold) {
        this.pools.delete(poolId);
        removed++;
      }
    }
    
    if (removed > 0) {
      logger.debug('validatedPoolsCache.cleanup', {
        cat: 'cache',
        ctx: {
          removed,
          remaining: this.pools.size,
        },
      });
    }
    
    return removed;
  }
  
  /**
   * Clear all validations
   */
  clear(): void {
    const count = this.pools.size;
    this.pools.clear();
    logger.info('validatedPoolsCache.cleared', {
      cat: 'cache',
      ctx: { clearedCount: count },
    });
  }
}

// Singleton instance
export const validatedPoolsCache = new ValidatedPoolsCacheImpl();

// Start periodic cleanup (every 5 minutes)
setInterval(() => {
  try {
    validatedPoolsCache.cleanup();
  } catch (e) {
    // Ignore cleanup errors
  }
}, 5 * 60 * 1000);
