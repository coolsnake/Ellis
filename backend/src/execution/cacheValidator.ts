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

export interface BitmapExtensionValidation {
  cachedValue: string | null;
  derivedPda: string;
  pdaExistsOnChain: boolean;
  isUsingProgramIdFallback: boolean;
  isValid: boolean;
  issue?: string;
}

export interface RaydiumExBitmapValidation {
  cachedValue: string | null;
  derivedPda: string;
  pdaExistsOnChain: boolean;
  isValid: boolean;
  issue?: string;
}

export interface PoolValidationResult {
  poolId: string;
  dex: 'orca' | 'raydium' | 'meteora';
  hasCacheEntry: boolean;
  hasHotCache: boolean;
  hasStaticCache: boolean;
  tickArrayValidation?: TickArrayValidation;
  binArrayValidation?: BinArrayValidation;
  bitmapExtensionValidation?: BitmapExtensionValidation;  // Meteora bitmap extension
  exBitmapValidation?: RaydiumExBitmapValidation;          // Raydium tick array bitmap extension
  issues: string[];
  valid: boolean;
  // Additional cache data for debugging
  cacheData?: {
    currentTick?: number;
    tickSpacing?: number;
    activeId?: number;
    binStep?: number;
    bitmapExtension?: string;  // Meteora
    exBitmap?: string;         // Raydium
  };
}

export interface BatchValidationResult {
  totalPools: number;
  validPools: number;
  invalidPools: number;
  poolsWithMissingCenter: number;
  poolsWithMissingArrays: number;
  poolsWithNoCacheEntry: number;
  poolsWithInvalidBitmapExtension: number;  // Meteora
  poolsWithInvalidExBitmap: number;          // Raydium
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
      
      // Validate ex_bitmap (tick array bitmap extension) for Raydium CLMM
      if (dex === 'raydium') {
        const cachedExBitmap = (stat as any)?.ex_bitmap || null;
        
        result.cacheData = {
          ...result.cacheData,
          exBitmap: cachedExBitmap,
        };
        
        // Derive the correct ex_bitmap PDA using "exaccount" seed
        let derivedExBitmapPda: string | null = null;
        try {
          const poolPk = new PublicKey(basePoolId);
          const [pda] = PublicKey.findProgramAddressSync(
            [Buffer.from('exaccount'), poolPk.toBuffer()],
            RAYDIUM_CLMM_PROGRAM
          );
          derivedExBitmapPda = pda.toBase58();
        } catch (e) {
          issues.push('Failed to derive Raydium ex_bitmap PDA');
        }
        
        if (derivedExBitmapPda) {
          try {
            const pdaPk = new PublicKey(derivedExBitmapPda);
            const info = await connection.getAccountInfo(pdaPk);
            const pdaExistsOnChain = !!info && info.owner.equals(RAYDIUM_CLMM_PROGRAM);
            
            const exBitmapValidation: RaydiumExBitmapValidation = {
              cachedValue: cachedExBitmap,
              derivedPda: derivedExBitmapPda,
              pdaExistsOnChain,
              isValid: false,
            };
            
            if (pdaExistsOnChain) {
              // PDA exists on-chain - we should have it cached
              if (cachedExBitmap === derivedExBitmapPda) {
                exBitmapValidation.isValid = true;
              } else if (!cachedExBitmap) {
                exBitmapValidation.issue = 'ex_bitmap exists on-chain but not cached';
                issues.push(exBitmapValidation.issue);
              } else {
                exBitmapValidation.issue = 'Cached ex_bitmap does not match derived PDA';
                issues.push(exBitmapValidation.issue);
              }
            } else {
              // PDA doesn't exist on-chain - this is okay for pools with narrow tick ranges
              // Having it cached is harmless (SDK will handle non-existent accounts)
              exBitmapValidation.isValid = true;
              if (cachedExBitmap && cachedExBitmap !== derivedExBitmapPda) {
                exBitmapValidation.issue = 'Cached ex_bitmap is incorrect PDA (but account does not exist)';
                // Not critical - just a warning, don't add to issues
              }
            }
            
            result.exBitmapValidation = exBitmapValidation;
          } catch (e: any) {
            issues.push(`Failed to verify ex_bitmap: ${e.message}`);
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
      
      // Validate bitmap extension for Meteora
      const cachedBitmapExt = (stat as any)?.bin_array_bitmap_extension;
      const programIdStr = METEORA_DLMM_PROGRAM.toBase58();
      const isUsingProgramIdFallback = cachedBitmapExt === programIdStr;
      
      result.cacheData = {
        ...result.cacheData,
        bitmapExtension: cachedBitmapExt,
      };
      
      // Derive the correct bitmap extension PDA using "bitmap" seed
      let derivedPda: string | null = null;
      try {
        const poolPk = new PublicKey(basePoolId);
        const [pda] = PublicKey.findProgramAddressSync(
          [Buffer.from('bitmap'), poolPk.toBuffer()],
          METEORA_DLMM_PROGRAM
        );
        derivedPda = pda.toBase58();
      } catch (e) {
        issues.push('Failed to derive bitmap extension PDA');
      }
      
      if (derivedPda) {
        // Check if the derived PDA exists on-chain
        try {
          const pdaPk = new PublicKey(derivedPda);
          const info = await connection.getAccountInfo(pdaPk);
          const pdaExistsOnChain = !!info && info.owner.equals(METEORA_DLMM_PROGRAM);
          
          const bitmapValidation: BitmapExtensionValidation = {
            cachedValue: cachedBitmapExt || null,
            derivedPda,
            pdaExistsOnChain,
            isUsingProgramIdFallback,
            isValid: false,
          };
          
          if (pdaExistsOnChain) {
            // PDA exists on-chain - we MUST use it, not the program ID
            if (cachedBitmapExt === derivedPda) {
              bitmapValidation.isValid = true;
            } else if (isUsingProgramIdFallback) {
              bitmapValidation.issue = 'CRITICAL: Bitmap extension exists on-chain but cache has program ID fallback';
              issues.push(bitmapValidation.issue);
            } else if (!cachedBitmapExt) {
              bitmapValidation.issue = 'Bitmap extension exists on-chain but not cached';
              issues.push(bitmapValidation.issue);
            } else {
              bitmapValidation.issue = 'Cached bitmap extension does not match derived PDA';
              issues.push(bitmapValidation.issue);
            }
          } else {
            // PDA doesn't exist on-chain - program ID fallback is acceptable
            if (isUsingProgramIdFallback || !cachedBitmapExt) {
              bitmapValidation.isValid = true;
            } else if (cachedBitmapExt !== derivedPda) {
              // Cached value is neither the program ID nor the correct PDA
              bitmapValidation.issue = 'Cached bitmap extension is invalid (PDA does not exist on-chain)';
              issues.push(bitmapValidation.issue);
            } else {
              // Cached the derived PDA but it doesn't exist - use program ID instead
              bitmapValidation.issue = 'Cached PDA does not exist on-chain, should use program ID';
              issues.push(bitmapValidation.issue);
            }
          }
          
          result.bitmapExtensionValidation = bitmapValidation;
        } catch (e: any) {
          issues.push(`Failed to verify bitmap extension: ${e.message}`);
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
  let poolsWithInvalidBitmapExtension = 0;  // Meteora
  let poolsWithInvalidExBitmap = 0;          // Raydium
  
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
          i.includes('Center tick array') || i.includes('CRITICAL: No bin arrays')
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
        
        // Track bitmap extension issues (Meteora only)
        if (result.bitmapExtensionValidation && !result.bitmapExtensionValidation.isValid) {
          poolsWithInvalidBitmapExtension++;
        }
        
        // Track ex_bitmap issues (Raydium only)
        if (result.exBitmapValidation && !result.exBitmapValidation.isValid) {
          poolsWithInvalidExBitmap++;
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
      poolsWithInvalidBitmapExtension,
      poolsWithInvalidExBitmap,
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
    poolsWithInvalidBitmapExtension,
    poolsWithInvalidExBitmap,
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

/**
 * Refresh invalid pools by fetching validated tick/bin arrays via SDK
 * Returns count of pools successfully refreshed
 */
export async function refreshInvalidPools(
  connection: Connection,
  invalidPools: PoolValidationResult[],
  options?: { concurrency?: number }
): Promise<{ refreshed: number; failed: number; errors: string[] }> {
  const { 
    fetchOrcaPoolViaSdk, 
    fetchRaydiumPoolViaSdk, 
    fetchMeteoraPoolViaSdk 
  } = await import('./sdkPoolFetcher.js');
  
  const concurrency = options?.concurrency ?? 5;
  let refreshed = 0;
  let failed = 0;
  const errors: string[] = [];
  
  // Process in batches
  for (let i = 0; i < invalidPools.length; i += concurrency) {
    const batch = invalidPools.slice(i, i + concurrency);
    
    const results = await Promise.all(
      batch.map(async (pool) => {
        try {
          let validatedState = null;
          
          switch (pool.dex) {
            case 'orca':
              validatedState = await fetchOrcaPoolViaSdk(connection, pool.poolId);
              break;
            case 'raydium':
              validatedState = await fetchRaydiumPoolViaSdk(connection, pool.poolId);
              break;
            case 'meteora':
              validatedState = await fetchMeteoraPoolViaSdk(connection, pool.poolId);
              break;
          }
          
          if (validatedState) {
            // Update cache with validated arrays
            if (validatedState.tickArrays) {
              const existing = executionCache.getHot(pool.poolId) || {};
              executionCache.setHot(pool.poolId, {
                ...existing,
                currentTickIndex: validatedState.currentTick,
                tickSpacing: validatedState.tickSpacing,
                tickArrays: {
                  center: validatedState.tickArrays.center,
                  lower: validatedState.tickArrays.lower,
                  upper: validatedState.tickArrays.upper,
                },
              });
              return { success: true, poolId: pool.poolId };
            }
            
            if (validatedState.binArrays) {
              const existing = executionCache.getHot(pool.poolId) || {};
              const BIN_ARRAY_SIZE = 70;
              const activeBinArrayIdx = Math.floor((validatedState.activeId || 0) / BIN_ARRAY_SIZE);
              
              // Find lower/upper/active from arrays
              const arrays = validatedState.binArrays.arrays || [];
              const active = arrays.find(a => a.index === activeBinArrayIdx)?.address;
              const lower = arrays.find(a => a.index === activeBinArrayIdx - 1)?.address;
              const upper = arrays.find(a => a.index === activeBinArrayIdx + 1)?.address;
              
              executionCache.setHot(pool.poolId, {
                ...existing,
                activeId: validatedState.activeId,
                binStep: validatedState.binStep,
                binArrays: {
                  lower,
                  upper,
                  active,
                  arrays: validatedState.binArrays.arrays,
                  range: { 
                    lower: arrays.length > 0 ? Math.min(...arrays.map(a => a.index)) : 0,
                    upper: arrays.length > 0 ? Math.max(...arrays.map(a => a.index)) : 0,
                  },
                },
              });
              return { success: true, poolId: pool.poolId };
            }
          }
          
          return { success: false, poolId: pool.poolId, error: 'No validated arrays found' };
        } catch (err: any) {
          return { success: false, poolId: pool.poolId, error: err.message };
        }
      })
    );
    
    for (const result of results) {
      if (result.success) {
        refreshed++;
      } else {
        failed++;
        if (result.error) {
          errors.push(`${result.poolId}: ${result.error}`);
        }
      }
    }
  }
  
  logger.info('cache.refresh.complete', {
    cat: 'cache',
    ctx: { refreshed, failed, total: invalidPools.length }
  });
  
  return { refreshed, failed, errors };
}

/**
 * Bitmap Extension Validation Result for a single pool
 */
export interface BitmapExtensionRefreshResult {
  poolId: string;
  previousValue: string | null;
  newValue: string | null;
  derivedPda: string;
  pdaExistsOnChain: boolean;
  wasUpdated: boolean;
  issue?: string;
}

/**
 * Batch result for bitmap extension validation
 */
export interface BitmapExtensionBatchResult {
  totalPools: number;
  poolsChecked: number;
  poolsWithPdaOnChain: number;
  poolsNeedingUpdate: number;
  poolsUpdated: number;
  poolsSkipped: number;
  results: BitmapExtensionRefreshResult[];
  timestamp: number;
  durationMs: number;
}

/**
 * Validate and refresh bitmap extensions for all Meteora DLMM pools.
 * 
 * This function:
 * 1. Derives the correct bitmap extension PDA for each pool using "bitmap" seed
 * 2. Checks on-chain if the PDA exists
 * 3. Updates the pool cache and execution cache with the correct value
 * 
 * Can be called from a button in the frontend to fix stale bitmap extension cache.
 */
export async function validateAndRefreshBitmapExtensions(
  connection: Connection,
  options?: { 
    limit?: number;
    dryRun?: boolean;  // If true, don't update caches, just report
  }
): Promise<BitmapExtensionBatchResult> {
  const startTime = Date.now();
  const limit = options?.limit ?? 100;
  const dryRun = options?.dryRun ?? false;
  
  const meteoraPools = peekMeteoraPools();
  const pools = (meteoraPools?.clmm || []).slice(0, limit);
  
  const results: BitmapExtensionRefreshResult[] = [];
  let poolsWithPdaOnChain = 0;
  let poolsNeedingUpdate = 0;
  let poolsUpdated = 0;
  let poolsSkipped = 0;
  
  const programIdStr = METEORA_DLMM_PROGRAM.toBase58();
  
  // Derive all PDAs first
  const poolsWithPda: Array<{ pool: any; poolPk: PublicKey; pda: PublicKey }> = [];
  for (const pool of pools) {
    try {
      const poolPk = new PublicKey(pool.id);
      const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from('bitmap'), poolPk.toBuffer()],
        METEORA_DLMM_PROGRAM
      );
      poolsWithPda.push({ pool, poolPk, pda });
    } catch (e) {
      results.push({
        poolId: pool.id,
        previousValue: null,
        newValue: null,
        derivedPda: '',
        pdaExistsOnChain: false,
        wasUpdated: false,
        issue: 'Failed to derive PDA',
      });
      poolsSkipped++;
    }
  }
  
  // Batch check which PDAs exist on-chain
  const BATCH_SIZE = 100;
  for (let i = 0; i < poolsWithPda.length; i += BATCH_SIZE) {
    const batch = poolsWithPda.slice(i, i + BATCH_SIZE);
    const pdas = batch.map(p => p.pda);
    
    try {
      const infos = await connection.getMultipleAccountsInfo(pdas);
      
      for (let j = 0; j < batch.length; j++) {
        const { pool, pda } = batch[j];
        const info = infos[j];
        const pdaExistsOnChain = !!info && info.owner.equals(METEORA_DLMM_PROGRAM);
        const derivedPdaStr = pda.toBase58();
        
        // Get current cached value
        const cachedValue = pool.bin_array_bitmap_extension || null;
        const stat = executionCache.getStatic(pool.id);
        const statCachedValue = (stat as any)?.bin_array_bitmap_extension;
        
        const result: BitmapExtensionRefreshResult = {
          poolId: pool.id,
          previousValue: cachedValue || statCachedValue || null,
          newValue: null,
          derivedPda: derivedPdaStr,
          pdaExistsOnChain,
          wasUpdated: false,
        };
        
        if (pdaExistsOnChain) {
          poolsWithPdaOnChain++;
          result.newValue = derivedPdaStr;
          
          // Check if update is needed
          const needsUpdate = cachedValue !== derivedPdaStr || statCachedValue !== derivedPdaStr;
          
          if (needsUpdate) {
            poolsNeedingUpdate++;
            
            if (!dryRun) {
              // Update pool cache
              pool.bin_array_bitmap_extension = derivedPdaStr;
              
              // Update execution cache
              if (stat) {
                executionCache.setStatic(pool.id, {
                  ...stat,
                  bin_array_bitmap_extension: derivedPdaStr,
                });
              }
              
              result.wasUpdated = true;
              poolsUpdated++;
              
              logger.info('cache.bitmap_ext.updated', {
                cat: 'cache',
                ctx: {
                  poolId: pool.id,
                  previousValue: result.previousValue,
                  newValue: derivedPdaStr,
                }
              });
            } else {
              result.issue = 'Would update (dry run)';
            }
          }
        } else {
          // PDA doesn't exist - program ID is the correct fallback
          result.newValue = programIdStr;
          
          // Check if we need to update to program ID
          const needsUpdate = cachedValue && cachedValue !== programIdStr && cachedValue !== derivedPdaStr;
          
          if (needsUpdate) {
            poolsNeedingUpdate++;
            
            if (!dryRun) {
              pool.bin_array_bitmap_extension = programIdStr;
              
              if (stat) {
                executionCache.setStatic(pool.id, {
                  ...stat,
                  bin_array_bitmap_extension: programIdStr,
                });
              }
              
              result.wasUpdated = true;
              poolsUpdated++;
            } else {
              result.issue = 'Would update to program ID (dry run)';
            }
          }
        }
        
        results.push(result);
      }
    } catch (e: any) {
      // If batch fails, mark all as skipped
      for (const { pool, pda } of batch) {
        results.push({
          poolId: pool.id,
          previousValue: pool.bin_array_bitmap_extension || null,
          newValue: null,
          derivedPda: pda.toBase58(),
          pdaExistsOnChain: false,
          wasUpdated: false,
          issue: `RPC error: ${e.message}`,
        });
        poolsSkipped++;
      }
    }
  }
  
  const durationMs = Date.now() - startTime;
  
  logger.info('cache.bitmap_ext.validation.complete', {
    cat: 'cache',
    ctx: {
      totalPools: pools.length,
      poolsChecked: results.length,
      poolsWithPdaOnChain,
      poolsNeedingUpdate,
      poolsUpdated,
      poolsSkipped,
      dryRun,
      durationMs,
    }
  });
  
  return {
    totalPools: pools.length,
    poolsChecked: results.length,
    poolsWithPdaOnChain,
    poolsNeedingUpdate,
    poolsUpdated,
    poolsSkipped,
    results,
    timestamp: Date.now(),
    durationMs,
  };
}

/**
 * Validate and refresh a single pool's bitmap extension.
 * Useful for just-in-time validation before a swap.
 */
export async function validatePoolBitmapExtension(
  connection: Connection,
  poolId: string
): Promise<BitmapExtensionRefreshResult> {
  const basePoolId = poolId.replace(/[#-]rev$/, '');
  const programIdStr = METEORA_DLMM_PROGRAM.toBase58();
  
  try {
    const poolPk = new PublicKey(basePoolId);
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('bitmap'), poolPk.toBuffer()],
      METEORA_DLMM_PROGRAM
    );
    const derivedPdaStr = pda.toBase58();
    
    // Check on-chain
    const info = await connection.getAccountInfo(pda);
    const pdaExistsOnChain = !!info && info.owner.equals(METEORA_DLMM_PROGRAM);
    
    // Get current cached value
    const stat = executionCache.getStatic(basePoolId);
    const previousValue = (stat as any)?.bin_array_bitmap_extension || null;
    
    const newValue = pdaExistsOnChain ? derivedPdaStr : programIdStr;
    const needsUpdate = previousValue !== newValue;
    
    if (needsUpdate && stat) {
      executionCache.setStatic(basePoolId, {
        ...stat,
        bin_array_bitmap_extension: newValue,
      });
      
      logger.info('cache.bitmap_ext.single.updated', {
        cat: 'cache',
        ctx: {
          poolId: basePoolId,
          previousValue,
          newValue,
          pdaExistsOnChain,
        }
      });
    }
    
    return {
      poolId: basePoolId,
      previousValue,
      newValue,
      derivedPda: derivedPdaStr,
      pdaExistsOnChain,
      wasUpdated: needsUpdate,
    };
  } catch (e: any) {
    return {
      poolId: basePoolId,
      previousValue: null,
      newValue: null,
      derivedPda: '',
      pdaExistsOnChain: false,
      wasUpdated: false,
      issue: `Error: ${e.message}`,
    };
  }
}

/**
 * Raydium Ex_Bitmap Validation Result for a single pool
 */
export interface RaydiumExBitmapRefreshResult {
  poolId: string;
  previousValue: string | null;
  newValue: string | null;
  derivedPda: string;
  pdaExistsOnChain: boolean;
  wasUpdated: boolean;
  issue?: string;
}

/**
 * Batch result for Raydium ex_bitmap validation
 */
export interface RaydiumExBitmapBatchResult {
  totalPools: number;
  poolsChecked: number;
  poolsWithPdaOnChain: number;
  poolsNeedingUpdate: number;
  poolsUpdated: number;
  poolsSkipped: number;
  results: RaydiumExBitmapRefreshResult[];
  timestamp: number;
  durationMs: number;
}

/**
 * Validate and refresh ex_bitmap (tick array bitmap extension) for Raydium CLMM pools.
 * 
 * This function:
 * 1. Derives the correct ex_bitmap PDA for each pool using "exaccount" seed
 * 2. Checks on-chain if the PDA exists
 * 3. Updates the pool cache and execution cache with the correct value
 * 
 * Can be called from a button in the frontend to fix stale ex_bitmap cache.
 */
export async function validateAndRefreshRaydiumExBitmaps(
  connection: Connection,
  options?: { 
    limit?: number;
    dryRun?: boolean;  // If true, don't update caches, just report
  }
): Promise<RaydiumExBitmapBatchResult> {
  const startTime = Date.now();
  const limit = options?.limit ?? 100;
  const dryRun = options?.dryRun ?? false;
  
  const raydiumPools = peekRaydiumPools();
  const pools = (raydiumPools?.clmm || []).slice(0, limit);
  
  const results: RaydiumExBitmapRefreshResult[] = [];
  let poolsWithPdaOnChain = 0;
  let poolsNeedingUpdate = 0;
  let poolsUpdated = 0;
  let poolsSkipped = 0;
  
  // Derive all PDAs first
  const poolsWithPda: Array<{ pool: any; poolPk: PublicKey; pda: PublicKey }> = [];
  for (const pool of pools) {
    try {
      const poolPk = new PublicKey(pool.id);
      const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from('exaccount'), poolPk.toBuffer()],
        RAYDIUM_CLMM_PROGRAM
      );
      poolsWithPda.push({ pool, poolPk, pda });
    } catch (e) {
      results.push({
        poolId: pool.id,
        previousValue: null,
        newValue: null,
        derivedPda: '',
        pdaExistsOnChain: false,
        wasUpdated: false,
        issue: 'Failed to derive PDA',
      });
      poolsSkipped++;
    }
  }
  
  // Batch check which PDAs exist on-chain
  const BATCH_SIZE = 100;
  for (let i = 0; i < poolsWithPda.length; i += BATCH_SIZE) {
    const batch = poolsWithPda.slice(i, i + BATCH_SIZE);
    const pdas = batch.map(p => p.pda);
    
    try {
      const infos = await connection.getMultipleAccountsInfo(pdas);
      
      for (let j = 0; j < batch.length; j++) {
        const { pool, pda } = batch[j];
        const info = infos[j];
        const pdaExistsOnChain = !!info && info.owner.equals(RAYDIUM_CLMM_PROGRAM);
        const derivedPdaStr = pda.toBase58();
        
        // Get current cached value
        const stat = executionCache.getStatic(pool.id);
        const cachedValue = (stat as any)?.ex_bitmap || pool.ex_bitmap || null;
        
        const result: RaydiumExBitmapRefreshResult = {
          poolId: pool.id,
          previousValue: cachedValue,
          newValue: null,
          derivedPda: derivedPdaStr,
          pdaExistsOnChain,
          wasUpdated: false,
        };
        
        if (pdaExistsOnChain) {
          poolsWithPdaOnChain++;
          result.newValue = derivedPdaStr;
          
          const needsUpdate = cachedValue !== derivedPdaStr;
          
          if (needsUpdate) {
            poolsNeedingUpdate++;
            
            if (!dryRun) {
              pool.ex_bitmap = derivedPdaStr;
              
              if (stat) {
                executionCache.setStatic(pool.id, {
                  ...stat,
                  ex_bitmap: derivedPdaStr,
                });
              }
              
              result.wasUpdated = true;
              poolsUpdated++;
              
              logger.info('cache.raydium_exbitmap.updated', {
                cat: 'cache',
                ctx: {
                  poolId: pool.id,
                  previousValue: result.previousValue,
                  newValue: derivedPdaStr,
                }
              });
            } else {
              result.issue = 'Would update (dry run)';
            }
          }
        } else {
          // PDA doesn't exist - clear cached value if it's stale
          result.newValue = null;
          
          if (cachedValue && !dryRun) {
            // Clear stale cache
            if (stat) {
              const { ex_bitmap, ...rest } = stat as any;
              executionCache.setStatic(pool.id, rest);
              result.wasUpdated = true;
              poolsUpdated++;
            }
          }
        }
        
        results.push(result);
      }
    } catch (e: any) {
      // If batch fails, mark all as skipped
      for (const { pool, pda } of batch) {
        results.push({
          poolId: pool.id,
          previousValue: pool.ex_bitmap || null,
          newValue: null,
          derivedPda: pda.toBase58(),
          pdaExistsOnChain: false,
          wasUpdated: false,
          issue: `RPC error: ${e.message}`,
        });
        poolsSkipped++;
      }
    }
  }
  
  const durationMs = Date.now() - startTime;
  
  logger.info('cache.raydium_exbitmap.validation.complete', {
    cat: 'cache',
    ctx: {
      totalPools: pools.length,
      poolsChecked: results.length,
      poolsWithPdaOnChain,
      poolsNeedingUpdate,
      poolsUpdated,
      poolsSkipped,
      dryRun,
      durationMs,
    }
  });
  
  return {
    totalPools: pools.length,
    poolsChecked: results.length,
    poolsWithPdaOnChain,
    poolsNeedingUpdate,
    poolsUpdated,
    poolsSkipped,
    results,
    timestamp: Date.now(),
    durationMs,
  };
}

/**
 * Validate and refresh a single pool's Raydium ex_bitmap.
 * Useful for just-in-time validation before a swap.
 */
export async function validatePoolRaydiumExBitmap(
  connection: Connection,
  poolId: string
): Promise<RaydiumExBitmapRefreshResult> {
  const basePoolId = poolId.replace(/[#-]rev$/, '');
  
  try {
    const poolPk = new PublicKey(basePoolId);
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('exaccount'), poolPk.toBuffer()],
      RAYDIUM_CLMM_PROGRAM
    );
    const derivedPdaStr = pda.toBase58();
    
    // Check on-chain
    const info = await connection.getAccountInfo(pda);
    const pdaExistsOnChain = !!info && info.owner.equals(RAYDIUM_CLMM_PROGRAM);
    
    // Get current cached value
    const stat = executionCache.getStatic(basePoolId);
    const previousValue = (stat as any)?.ex_bitmap || null;
    
    const newValue = pdaExistsOnChain ? derivedPdaStr : null;
    const needsUpdate = previousValue !== newValue;
    
    if (needsUpdate && stat) {
      if (newValue) {
        executionCache.setStatic(basePoolId, {
          ...stat,
          ex_bitmap: newValue,
        });
      } else {
        // Clear stale cache
        const { ex_bitmap, ...rest } = stat as any;
        executionCache.setStatic(basePoolId, rest);
      }
      
      logger.info('cache.raydium_exbitmap.single.updated', {
        cat: 'cache',
        ctx: {
          poolId: basePoolId,
          previousValue,
          newValue,
          pdaExistsOnChain,
        }
      });
    }
    
    return {
      poolId: basePoolId,
      previousValue,
      newValue,
      derivedPda: derivedPdaStr,
      pdaExistsOnChain,
      wasUpdated: needsUpdate,
    };
  } catch (e: any) {
    return {
      poolId: basePoolId,
      previousValue: null,
      newValue: null,
      derivedPda: '',
      pdaExistsOnChain: false,
      wasUpdated: false,
      issue: `Error: ${e.message}`,
    };
  }
}

