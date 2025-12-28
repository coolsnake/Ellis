/**
 * Cache Validator - Validates tick/bin array existence on-chain
 * 
 * This module provides utilities to validate that cached tick arrays (Orca, Raydium)
 * and bin arrays (Meteora) actually exist on-chain before attempting swaps.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { executionCache } from './cache.js';
import { logger } from '../utils/logger.js';
import { logCatchError } from '../utils/errorHandler.js';
import { peekRaydiumPools, peekOrcaPools, peekMeteoraPools } from '../server/pools.js';

// Program IDs
const ORCA_WHIRLPOOL_PROGRAM = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
const RAYDIUM_CLMM_PROGRAM = new PublicKey('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK');
const METEORA_DLMM_PROGRAM = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');

// Constants for tick/bin array derivation
const ORCA_TICK_ARRAY_SIZE = 88;
const RAYDIUM_TICK_ARRAY_SIZE = 60;
const METEORA_BIN_ARRAY_SIZE = 70;

export interface TickArrayValidation {
  lower: { address: string; exists: boolean } | null;
  center: { address: string; exists: boolean } | null;
  upper: { address: string; exists: boolean } | null;
}

export interface BinArrayValidation {
  lower: { address: string; exists: boolean } | null;
  upper: { address: string; exists: boolean } | null;
  active: { address: string; exists: boolean } | null;
  allArrays?: Array<{ index: number; address: string; exists: boolean }>;
}

export interface PoolValidationResult {
  poolId: string;
  dex: 'orca' | 'raydium' | 'meteora';
  hasCacheEntry: boolean;
  hasHotCache: boolean;
  hasStaticCache: boolean;
  tickArrayValidation?: TickArrayValidation;
  binArrayValidation?: BinArrayValidation;
  issues: string[];
  valid: boolean;
  // Additional cache data for debugging
  cacheData?: {
    currentTick?: number;
    tickSpacing?: number;
    activeId?: number;
    binStep?: number;
  };
}

export interface BatchValidationResult {
  totalPools: number;
  validPools: number;
  invalidPools: number;
  poolsWithMissingCenter: number;
  poolsWithMissingArrays: number;
  poolsWithNoCacheEntry: number;
  results: PoolValidationResult[];
  timestamp: number;
  durationMs: number;
}

/**
 * Validate a single pool's tick/bin arrays against on-chain state
 */
export async function validatePoolCache(
  connection: Connection,
  poolId: string,
  dex: 'orca' | 'raydium' | 'meteora'
): Promise<PoolValidationResult> {
  const issues: string[] = [];
  const basePoolId = poolId.replace(/[#-]rev$/, '');
  
  const stat = executionCache.getStatic(basePoolId);
  const hot = executionCache.getHot(basePoolId);
  
  const result: PoolValidationResult = {
    poolId: basePoolId,
    dex,
    hasCacheEntry: !!(stat || hot),
    hasHotCache: !!hot,
    hasStaticCache: !!stat,
    issues,
    valid: false,
  };
  
  if (!stat && !hot) {
    issues.push('No cache entry found');
    return result;
  }
  
  try {
    if (dex === 'orca' || dex === 'raydium') {
      const tickArrays = hot?.tickArrays;
      const currentTick = hot?.currentTickIndex;
      const tickSpacing = hot?.tickSpacing || stat?.tickSpacing || (stat as any)?.tick_spacing;
      
      result.cacheData = {
        currentTick,
        tickSpacing,
      };
      
      if (!tickArrays) {
        issues.push('No tickArrays in hot cache');
        
        // Try to derive tick arrays if we have the required data
        if (currentTick !== undefined && tickSpacing && tickSpacing > 0) {
          issues.push('Could derive tick arrays from currentTick and tickSpacing');
        } else {
          if (currentTick === undefined) issues.push('Missing currentTickIndex');
          if (!tickSpacing) issues.push('Missing tickSpacing');
        }
      } else {
        // Validate tick arrays exist on-chain
        const lower = Array.isArray(tickArrays.lower) ? tickArrays.lower[0] : tickArrays.lower;
        const center = tickArrays.center;
        const upper = Array.isArray(tickArrays.upper) ? tickArrays.upper[0] : tickArrays.upper;
        
        const keysToCheck: PublicKey[] = [];
        const keyMap: { type: 'lower' | 'center' | 'upper'; address: string }[] = [];
        
        if (lower) {
          try {
            keysToCheck.push(new PublicKey(lower));
            keyMap.push({ type: 'lower', address: lower });
          } catch { issues.push('Invalid lower tick array address'); }
        }
        if (center) {
          try {
            keysToCheck.push(new PublicKey(center));
            keyMap.push({ type: 'center', address: center });
          } catch { issues.push('Invalid center tick array address'); }
        }
        if (upper) {
          try {
            keysToCheck.push(new PublicKey(upper));
            keyMap.push({ type: 'upper', address: upper });
          } catch { issues.push('Invalid upper tick array address'); }
        }
        
        if (keysToCheck.length > 0) {
          const infos = await connection.getMultipleAccountsInfo(keysToCheck);
          const expectedOwner = dex === 'orca' ? ORCA_WHIRLPOOL_PROGRAM : RAYDIUM_CLMM_PROGRAM;
          
          const validation: TickArrayValidation = {
            lower: null,
            center: null,
            upper: null,
          };
          
          for (let i = 0; i < keyMap.length; i++) {
            const { type, address } = keyMap[i];
            const info = infos[i];
            const exists = !!info && info.owner.equals(expectedOwner);
            
            validation[type] = { address, exists };
            
            if (!exists) {
              issues.push(`${type} tick array does not exist on-chain`);
            }
          }
          
          result.tickArrayValidation = validation;
          
          // Center is critical - if it doesn't exist, the pool can't be traded
          if (!validation.center?.exists) {
            issues.push('CRITICAL: Center tick array missing - pool cannot be traded');
          }
        }
      }
    } else if (dex === 'meteora') {
      const binArrays = hot?.binArrays as any;
      const activeId = hot?.activeId;
      const binStep = hot?.binStep || stat?.binStep;
      
      result.cacheData = {
        activeId,
        binStep,
      };
      
      if (!binArrays) {
        issues.push('No binArrays in hot cache');
        
        if (activeId !== undefined) {
          issues.push('Could derive bin arrays from activeId');
        } else {
          issues.push('Missing activeId');
        }
      } else {
        // Validate bin arrays exist on-chain
        const keysToCheck: PublicKey[] = [];
        const keyMap: { type: 'lower' | 'upper' | 'active'; address: string }[] = [];
        
        if (binArrays.lower) {
          try {
            keysToCheck.push(new PublicKey(binArrays.lower));
            keyMap.push({ type: 'lower', address: binArrays.lower });
          } catch { issues.push('Invalid lower bin array address'); }
        }
        if (binArrays.upper) {
          try {
            keysToCheck.push(new PublicKey(binArrays.upper));
            keyMap.push({ type: 'upper', address: binArrays.upper });
          } catch { issues.push('Invalid upper bin array address'); }
        }
        if (binArrays.active) {
          try {
            keysToCheck.push(new PublicKey(binArrays.active));
            keyMap.push({ type: 'active', address: binArrays.active });
          } catch { issues.push('Invalid active bin array address'); }
        }
        
        // Also check the arrays field if present
        const allArrays: Array<{ index: number; address: string; exists: boolean }> = [];
        if (Array.isArray(binArrays.arrays)) {
          for (const arr of binArrays.arrays) {
            if (arr && arr.address) {
              try {
                keysToCheck.push(new PublicKey(arr.address));
                allArrays.push({ index: arr.index, address: arr.address, exists: false });
              } catch {}
            }
          }
        }
        
        if (keysToCheck.length > 0) {
          const infos = await connection.getMultipleAccountsInfo(keysToCheck);
          
          const validation: BinArrayValidation = {
            lower: null,
            upper: null,
            active: null,
          };
          
          let infoIdx = 0;
          for (const { type, address } of keyMap) {
            const info = infos[infoIdx++];
            const exists = !!info && info.owner.equals(METEORA_DLMM_PROGRAM);
            validation[type] = { address, exists };
            
            if (!exists) {
              issues.push(`${type} bin array does not exist on-chain`);
            }
          }
          
          // Check allArrays
          for (const arr of allArrays) {
            const info = infos[infoIdx++];
            arr.exists = !!info && info.owner.equals(METEORA_DLMM_PROGRAM);
          }
          
          if (allArrays.length > 0) {
            validation.allArrays = allArrays;
            const existingCount = allArrays.filter(a => a.exists).length;
            if (existingCount === 0) {
              issues.push('CRITICAL: No bin arrays exist on-chain');
            }
          }
          
          result.binArrayValidation = validation;
          
          // At least one bin array must exist
          const hasAnyBinArray = 
            validation.lower?.exists || 
            validation.upper?.exists || 
            validation.active?.exists ||
            allArrays.some(a => a.exists);
          
          if (!hasAnyBinArray) {
            issues.push('CRITICAL: No bin arrays exist - pool cannot be traded');
          }
        }
      }
    }
  } catch (err: any) {
    issues.push(`Validation error: ${err.message}`);
    logCatchError('cacheValidator', err);
  }
  
  result.valid = issues.length === 0;
  return result;
}

/**
 * Batch validate multiple pools by DEX
 */
export async function validatePoolCacheBatch(
  connection: Connection,
  dex: 'orca' | 'raydium' | 'meteora',
  options?: { limit?: number; onlyClmm?: boolean }
): Promise<BatchValidationResult> {
  const startTime = Date.now();
  const limit = options?.limit ?? 50;
  
  // Get pools from the appropriate cache
  let pools: any[] = [];
  
  if (dex === 'orca') {
    const orcaPools = peekOrcaPools();
    pools = (orcaPools?.clmm || []).slice(0, limit);
  } else if (dex === 'raydium') {
    const raydiumPools = peekRaydiumPools();
    pools = (raydiumPools?.clmm || []).slice(0, limit);
  } else if (dex === 'meteora') {
    const meteoraPools = peekMeteoraPools();
    pools = (meteoraPools?.clmm || []).slice(0, limit);
  }
  
  const results: PoolValidationResult[] = [];
  let validPools = 0;
  let poolsWithMissingCenter = 0;
  let poolsWithMissingArrays = 0;
  let poolsWithNoCacheEntry = 0;
  
  // Process in batches to avoid overwhelming RPC
  const BATCH_SIZE = 10;
  for (let i = 0; i < pools.length; i += BATCH_SIZE) {
    const batch = pools.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(pool => validatePoolCache(connection, pool.id, dex))
    );
    
    for (const result of batchResults) {
      results.push(result);
      
      if (result.valid) {
        validPools++;
      } else {
        if (!result.hasCacheEntry) {
          poolsWithNoCacheEntry++;
        }
        
        const hasMissingCenter = result.issues.some(i => 
          i.includes('Center tick array') || i.includes('CRITICAL')
        );
        if (hasMissingCenter) {
          poolsWithMissingCenter++;
        }
        
        const hasMissingArrays = result.issues.some(i =>
          i.includes('does not exist') || i.includes('No tickArrays') || i.includes('No binArrays')
        );
        if (hasMissingArrays && !hasMissingCenter) {
          poolsWithMissingArrays++;
        }
      }
    }
  }
  
  const durationMs = Date.now() - startTime;
  
  logger.info('cache.validation.batch.complete', {
    cat: 'cache',
    ctx: {
      dex,
      totalPools: results.length,
      validPools,
      invalidPools: results.length - validPools,
      poolsWithMissingCenter,
      poolsWithMissingArrays,
      poolsWithNoCacheEntry,
      durationMs,
    }
  });
  
  return {
    totalPools: results.length,
    validPools,
    invalidPools: results.length - validPools,
    poolsWithMissingCenter,
    poolsWithMissingArrays,
    poolsWithNoCacheEntry,
    results,
    timestamp: Date.now(),
    durationMs,
  };
}

/**
 * Get a summary of cache health across all DEXes
 */
export async function getCacheHealthSummary(
  connection: Connection,
  options?: { poolsPerDex?: number }
): Promise<{
  orca: BatchValidationResult;
  raydium: BatchValidationResult;
  meteora: BatchValidationResult;
  overallHealthPercent: number;
  timestamp: number;
}> {
  const poolsPerDex = options?.poolsPerDex ?? 20;
  
  const [orca, raydium, meteora] = await Promise.all([
    validatePoolCacheBatch(connection, 'orca', { limit: poolsPerDex }),
    validatePoolCacheBatch(connection, 'raydium', { limit: poolsPerDex }),
    validatePoolCacheBatch(connection, 'meteora', { limit: poolsPerDex }),
  ]);
  
  const totalPools = orca.totalPools + raydium.totalPools + meteora.totalPools;
  const totalValid = orca.validPools + raydium.validPools + meteora.validPools;
  const overallHealthPercent = totalPools > 0 ? Math.round((totalValid / totalPools) * 100) : 0;
  
  return {
    orca,
    raydium,
    meteora,
    overallHealthPercent,
    timestamp: Date.now(),
  };
}

