/**
 * Pool Revalidation Module
 * 
 * Provides on-demand validation and refresh of:
 * 1. Token decimals (fetched on-chain if missing)
 * 2. CLMM pool tick/bin arrays (validated against on-chain state)
 * 
 * This ensures pools loaded from cache have valid, up-to-date data before being used for swaps.
 */

import { logger } from '../utils/logger.js';
import { emit } from './realtime.js';

export interface DecimalsValidationStats {
  poolsValidated: number;
  poolsUpdated: number;
  poolsStillMissing: number;
  uniqueMintsResolved: number;
  durationMs: number;
}

export interface RevalidationResult {
  healthPercent: number;
  totalPools: number;
  validPools: number;
  invalidPools: number;
  refreshed: number;
  failed: number;
  durationMs: number;
  decimals?: DecimalsValidationStats;
  dex?: {
    orca: { total: number; valid: number; refreshed: number };
    raydium: { total: number; valid: number; refreshed: number };
    meteora: { total: number; valid: number; refreshed: number };
  };
}

export interface RevalidateOptions {
  dex?: 'orca' | 'raydium' | 'meteora';
  limit?: number;
  /** Set to true to validate ALL pools in cache (overrides limit) */
  validateAll?: boolean;
  concurrency?: number;
  /** Set to true to include decimals validation (default: true) */
  includeDecimals?: boolean;
}

/**
 * Revalidate pools for a specific DEX
 * @param options.limit - Max pools to validate. Omit or use 0 for all pools.
 * @param options.validateAll - If true, validates ALL pools (overrides limit)
 * @param options.includeDecimals - If true, validates and refreshes token decimals (default: true)
 */
export async function revalidateDex(
  dex: 'orca' | 'raydium' | 'meteora',
  options?: { limit?: number; validateAll?: boolean; concurrency?: number; includeDecimals?: boolean }
): Promise<RevalidationResult> {
  const startTime = Date.now();
  // Default to validating ALL pools unless a specific limit is provided
  const hasExplicitLimit = options?.limit !== undefined && options.limit > 0;
  const validateAll = options?.validateAll || options?.limit === 0 || !hasExplicitLimit;
  const limit = validateAll ? Infinity : options!.limit!;
  const concurrency = options?.concurrency ?? 10;
  const includeDecimals = options?.includeDecimals ?? true;
  
  try {
    const { validatePoolCacheBatch, refreshInvalidPools, validateAndRefreshPoolDecimals } = 
      await import('../execution/cacheValidator.js');
    const { getConnection } = await import('../wallet/wallet.js');
    
    const connection = getConnection();
    
    // === PHASE 1: Decimals Validation ===
    let decimalsStats: DecimalsValidationStats | undefined;
    if (includeDecimals) {
      const decimalsStart = Date.now();
      logger.info('pools.revalidate.decimals.start', { dex, cat: 'pools' });
      
      try {
        const decResult = await validateAndRefreshPoolDecimals(connection, dex, {
          limit: limit === Infinity ? undefined : limit,
        });
        
        decimalsStats = {
          poolsValidated: decResult.poolsValidated,
          poolsUpdated: decResult.poolsUpdated,
          poolsStillMissing: decResult.poolsStillMissing,
          uniqueMintsResolved: decResult.uniqueMintsResolved,
          durationMs: Date.now() - decimalsStart,
        };
        
        logger.info('pools.revalidate.decimals.complete', {
          dex,
          ...decimalsStats,
          cat: 'pools'
        });
      } catch (e: any) {
        logger.warn('pools.revalidate.decimals.failed', {
          dex,
          error: e.message,
          cat: 'pools'
        });
      }
    }
    
    // === PHASE 2: Tick/Bin Array Validation ===
    const validation = await validatePoolCacheBatch(connection, dex, { limit });
    
    // Refresh invalid pools
    let refreshResult = { refreshed: 0, failed: 0, errors: [] as string[] };
    if (validation.invalidPools > 0) {
      const invalidPools = validation.results.filter(r => !r.valid);
      refreshResult = await refreshInvalidPools(connection, invalidPools, { concurrency });
    }
    
    const result: RevalidationResult = {
      healthPercent: validation.totalPools > 0 
        ? Math.round((validation.validPools / validation.totalPools) * 100) 
        : 100,
      totalPools: validation.totalPools,
      validPools: validation.validPools,
      invalidPools: validation.invalidPools,
      refreshed: refreshResult.refreshed,
      failed: refreshResult.failed,
      durationMs: Date.now() - startTime,
      decimals: decimalsStats,
    };
    
    logger.info('pools.revalidate.dex.complete', {
      dex,
      ...result,
      cat: 'pools'
    });
    
    return result;
  } catch (err: any) {
    logger.error('pools.revalidate.dex.failed', { 
      dex, 
      error: err.message,
      cat: 'pools' 
    });
    throw err;
  }
}

/**
 * Revalidate all DEXes including decimals validation
 * @param options.limit - Max pools per DEX to validate. Omit or use 0 for all pools.
 * @param options.validateAll - If true, validates ALL pools (overrides limit)
 * @param options.includeDecimals - If true, validates and refreshes token decimals (default: true)
 */
export async function revalidateAllPools(
  options?: { limit?: number; validateAll?: boolean; concurrency?: number; includeDecimals?: boolean }
): Promise<RevalidationResult> {
  const startTime = Date.now();
  // Default to validating ALL pools unless a specific limit is provided
  const hasExplicitLimit = options?.limit !== undefined && options.limit > 0;
  const validateAll = options?.validateAll || options?.limit === 0 || !hasExplicitLimit;
  const limit = validateAll ? Infinity : options!.limit!;
  const concurrency = options?.concurrency ?? 10;
  const includeDecimals = options?.includeDecimals ?? true;
  
  try {
    const { getCacheHealthSummary, refreshInvalidPools, validateAndRefreshAllDecimals } = 
      await import('../execution/cacheValidator.js');
    const { getConnection } = await import('../wallet/wallet.js');
    
    const connection = getConnection();
    
    logger.info('pools.revalidate.start', {
      cat: 'pools',
      validateAll,
      limit: limit === Infinity ? 'all' : limit,
      includeDecimals,
    });
    
    // === PHASE 1: Decimals Validation ===
    let decimalsStats: DecimalsValidationStats | undefined;
    if (includeDecimals) {
      const decimalsStart = Date.now();
      logger.info('pools.revalidate.decimals.all.start', { cat: 'pools' });
      
      try {
        const decResults = await validateAndRefreshAllDecimals(connection, {
          limit: limit === Infinity ? undefined : limit,
        });
        
        // Aggregate decimals stats across all DEXes
        let totalValidated = 0;
        let totalUpdated = 0;
        let totalStillMissing = 0;
        let totalMintsResolved = 0;
        
        for (const result of Object.values(decResults.results)) {
          totalValidated += result.poolsValidated;
          totalUpdated += result.poolsUpdated;
          totalStillMissing += result.poolsStillMissing;
          totalMintsResolved += result.uniqueMintsResolved;
        }
        
        decimalsStats = {
          poolsValidated: totalValidated,
          poolsUpdated: totalUpdated,
          poolsStillMissing: totalStillMissing,
          uniqueMintsResolved: totalMintsResolved,
          durationMs: Date.now() - decimalsStart,
        };
        
        logger.info('pools.revalidate.decimals.all.complete', {
          ...decimalsStats,
          cat: 'pools'
        });
      } catch (e: any) {
        logger.warn('pools.revalidate.decimals.all.failed', {
          error: e.message,
          cat: 'pools'
        });
      }
    }
    
    // === PHASE 2: Tick/Bin Array Validation ===
    const health = await getCacheHealthSummary(connection, { 
      poolsPerDex: limit, 
      validateAll 
    });
    
    logger.info('pools.revalidate.health', {
      cat: 'pools',
      orcaPools: health.orca.totalPools,
      raydiumPools: health.raydium.totalPools,
      meteoraPools: health.meteora.totalPools,
      totalPools: health.orca.totalPools + health.raydium.totalPools + health.meteora.totalPools,
    });
    
    // Collect all invalid pools
    const allInvalid = [
      ...health.orca.results.filter(r => !r.valid),
      ...health.raydium.results.filter(r => !r.valid),
      ...health.meteora.results.filter(r => !r.valid),
    ];
    
    // Refresh invalid pools
    let refreshResult = { refreshed: 0, failed: 0, errors: [] as string[] };
    if (allInvalid.length > 0) {
      refreshResult = await refreshInvalidPools(connection, allInvalid, { concurrency });
    }
    
    const totalPools = health.orca.totalPools + health.raydium.totalPools + health.meteora.totalPools;
    const validPools = health.orca.validPools + health.raydium.validPools + health.meteora.validPools;
    
    const result: RevalidationResult = {
      healthPercent: health.overallHealthPercent,
      totalPools,
      validPools,
      invalidPools: totalPools - validPools,
      refreshed: refreshResult.refreshed,
      failed: refreshResult.failed,
      durationMs: Date.now() - startTime,
      decimals: decimalsStats,
      dex: {
        orca: {
          total: health.orca.totalPools,
          valid: health.orca.validPools,
          refreshed: 0, // Individual counts not tracked
        },
        raydium: {
          total: health.raydium.totalPools,
          valid: health.raydium.validPools,
          refreshed: 0,
        },
        meteora: {
          total: health.meteora.totalPools,
          valid: health.meteora.validPools,
          refreshed: 0,
        },
      },
    };
    
    logger.info('pools.revalidate.all.complete', {
      ...result,
      cat: 'pools'
    });
    
    try {
      const decimalsMsg = decimalsStats 
        ? ` decimals_updated=${decimalsStats.poolsUpdated} decimals_missing=${decimalsStats.poolsStillMissing}`
        : '';
      emit('log', {
        level: 'info',
        message: `pools:revalidate complete health=${result.healthPercent}% refreshed=${result.refreshed}${decimalsMsg}`,
        timestamp: new Date().toISOString(),
        context: { cat: 'pools' }
      });
    } catch {}
    
    return result;
  } catch (err: any) {
    logger.error('pools.revalidate.all.failed', { 
      error: err.message,
      cat: 'pools' 
    });
    throw err;
  }
}

/**
 * Revalidate only decimals (without tick/bin array validation)
 * Useful for quickly fixing pools with missing decimals
 */
export async function revalidateDecimals(
  options?: { dex?: 'orca' | 'raydium' | 'meteora' | 'pumpswap' | 'meteora_balanced'; limit?: number }
): Promise<DecimalsValidationStats> {
  const startTime = Date.now();
  
  try {
    const { validateAndRefreshPoolDecimals, validateAndRefreshAllDecimals } = 
      await import('../execution/cacheValidator.js');
    const { getConnection } = await import('../wallet/wallet.js');
    
    const connection = getConnection();
    
    if (options?.dex) {
      // Single DEX
      logger.info('pools.revalidate.decimals_only.start', { dex: options.dex, cat: 'pools' });
      
      const result = await validateAndRefreshPoolDecimals(connection, options.dex, {
        limit: options.limit,
      });
      
      const stats: DecimalsValidationStats = {
        poolsValidated: result.poolsValidated,
        poolsUpdated: result.poolsUpdated,
        poolsStillMissing: result.poolsStillMissing,
        uniqueMintsResolved: result.uniqueMintsResolved,
        durationMs: Date.now() - startTime,
      };
      
      logger.info('pools.revalidate.decimals_only.complete', {
        dex: options.dex,
        ...stats,
        cat: 'pools'
      });
      
      return stats;
    } else {
      // All DEXes
      logger.info('pools.revalidate.decimals_only.all.start', { cat: 'pools' });
      
      const results = await validateAndRefreshAllDecimals(connection, {
        limit: options?.limit,
      });
      
      // Aggregate stats
      let totalValidated = 0;
      let totalUpdated = 0;
      let totalStillMissing = 0;
      let totalMintsResolved = 0;
      
      for (const result of Object.values(results.results)) {
        totalValidated += result.poolsValidated;
        totalUpdated += result.poolsUpdated;
        totalStillMissing += result.poolsStillMissing;
        totalMintsResolved += result.uniqueMintsResolved;
      }
      
      const stats: DecimalsValidationStats = {
        poolsValidated: totalValidated,
        poolsUpdated: totalUpdated,
        poolsStillMissing: totalStillMissing,
        uniqueMintsResolved: totalMintsResolved,
        durationMs: Date.now() - startTime,
      };
      
      logger.info('pools.revalidate.decimals_only.all.complete', {
        ...stats,
        cat: 'pools'
      });
      
      return stats;
    }
  } catch (err: any) {
    logger.error('pools.revalidate.decimals_only.failed', { 
      error: err.message,
      cat: 'pools' 
    });
    throw err;
  }
}