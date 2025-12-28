/**
 * Pool Revalidation Module
 * 
 * Provides on-demand validation and refresh of CLMM pool tick/bin arrays
 * using the SDK-based fetchers. This ensures pools loaded from cache
 * have valid, up-to-date tick/bin array data before being used for swaps.
 */

import { logger } from '../utils/logger.js';
import { emit } from './realtime.js';

export interface RevalidationResult {
  healthPercent: number;
  totalPools: number;
  validPools: number;
  invalidPools: number;
  refreshed: number;
  failed: number;
  durationMs: number;
  dex?: {
    orca: { total: number; valid: number; refreshed: number };
    raydium: { total: number; valid: number; refreshed: number };
    meteora: { total: number; valid: number; refreshed: number };
  };
}

export interface RevalidateOptions {
  dex?: 'orca' | 'raydium' | 'meteora';
  limit?: number;
  concurrency?: number;
}

/**
 * Revalidate pools for a specific DEX
 */
export async function revalidateDex(
  dex: 'orca' | 'raydium' | 'meteora',
  options?: { limit?: number; concurrency?: number }
): Promise<RevalidationResult> {
  const startTime = Date.now();
  const limit = options?.limit ?? 100;
  const concurrency = options?.concurrency ?? 10;
  
  try {
    const { validatePoolCacheBatch, refreshInvalidPools } = 
      await import('../execution/cacheValidator.js');
    const { getConnection } = await import('../execution/connection.js');
    
    const connection = getConnection();
    
    // Validate pools
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
 * Revalidate all DEXes
 */
export async function revalidateAllPools(
  options?: { limit?: number; concurrency?: number }
): Promise<RevalidationResult> {
  const startTime = Date.now();
  const limit = options?.limit ?? 50;
  const concurrency = options?.concurrency ?? 10;
  
  try {
    const { getCacheHealthSummary, refreshInvalidPools } = 
      await import('../execution/cacheValidator.js');
    const { getConnection } = await import('../execution/connection.js');
    
    const connection = getConnection();
    
    // Get health summary for all DEXes
    const health = await getCacheHealthSummary(connection, { poolsPerDex: limit });
    
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
      emit('log', {
        level: 'info',
        message: `pools:revalidate complete health=${result.healthPercent}% refreshed=${result.refreshed}`,
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

