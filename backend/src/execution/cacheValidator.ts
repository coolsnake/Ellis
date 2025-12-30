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
import { withRpcLimit } from '../utils/rpcLimiter.js';

// RPC context for rate limiting
const RPC_MODULE = 'cacheValidator';

// Program IDs
const ORCA_WHIRLPOOL_PROGRAM = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
const RAYDIUM_CLMM_PROGRAM = new PublicKey('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK');
const METEORA_DLMM_PROGRAM = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');

// Constants for tick/bin array derivation
const ORCA_TICK_ARRAY_SIZE = 88;
const RAYDIUM_TICK_ARRAY_SIZE = 60;
const METEORA_BIN_ARRAY_SIZE = 70;

/**
 * Fetch fresh tick data from chain and validate tick arrays
 * Used when cached tick data leads to non-existent tick arrays
 */
async function fetchFreshTickDataAndValidate(
  connection: Connection,
  poolId: string,
  dex: 'orca' | 'raydium'
): Promise<{
  currentTick: number;
  tickSpacing: number;
  tickArrays?: { center: string; lower: string[]; upper: string[] };
  validation?: TickArrayValidation;
} | null> {
  try {
    const poolPk = new PublicKey(poolId);
    const accountInfo = await withRpcLimit(
      () => connection.getAccountInfo(poolPk),
      1,
      { module: RPC_MODULE, method: 'getAccountInfo:fetchTick' }
    );
    
    if (!accountInfo || !accountInfo.data) {
      return null;
    }
    
    const data = accountInfo.data;
    let currentTick: number;
    let tickSpacing: number;
    
    if (dex === 'raydium') {
      // Raydium CLMM layout offsets
      if (data.length < 280) return null;
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      tickSpacing = view.getUint16(235, true);
      currentTick = view.getInt32(269, true);
    } else {
      // Orca Whirlpool layout offsets
      if (data.length < 280) return null;
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      // Skip 8 byte discriminator, 32 byte config, 1 byte bump
      tickSpacing = view.getUint16(41, true);
      // Skip to tickCurrentIndex at offset ~277
      // Orca: discriminator(8) + config(32) + bump(1) + tickSpacing(2) + tickSpacingSeed(2) + feeRate(2) + protocolFeeRate(2) + liquidity(16) + sqrtPrice(16) + tickCurrentIndex(4)
      currentTick = view.getInt32(8 + 32 + 1 + 2 + 2 + 2 + 2 + 16 + 16, true); // offset 81
    }
    
    if (tickSpacing <= 0 || tickSpacing > 1000) {
      return null;
    }
    
    // Now derive and validate with fresh tick data
    const derivedResult = await deriveAndValidateTickArrays(connection, poolId, currentTick, tickSpacing, dex);
    
    return {
      currentTick,
      tickSpacing,
      tickArrays: derivedResult.tickArrays,
      validation: derivedResult.validation,
    };
  } catch (e) {
    logCatchError('fetchFreshTickDataAndValidate', e);
    return null;
  }
}

/**
 * Derive and validate tick arrays for a pool
 * Returns derived addresses and their on-chain validation status
 * Uses SDK-based derivation for Raydium, manual for Orca
 */
async function deriveAndValidateTickArrays(
  connection: Connection,
  poolId: string,
  currentTick: number,
  tickSpacing: number,
  dex: 'orca' | 'raydium'
): Promise<{
  tickArrays?: { center: string; lower: string[]; upper: string[] };
  validation?: TickArrayValidation;
}> {
  try {
    const poolPk = new PublicKey(poolId);
    const programId = dex === 'orca' ? ORCA_WHIRLPOOL_PROGRAM : RAYDIUM_CLMM_PROGRAM;
    
    // Use the authoritative tick array derivation
    const tickArraySize = dex === 'orca' ? ORCA_TICK_ARRAY_SIZE : RAYDIUM_TICK_ARRAY_SIZE;
    const ticksInArray = tickArraySize * tickSpacing;
    
    // Calculate center start using same formula as getTickArrayStartIndexByTick
    const centerStart = Math.floor(currentTick / ticksInArray) * ticksInArray;
    const delta = ticksInArray;
    
    // Calculate start indices for lower, center, upper arrays
    const startIndices = [
      { type: 'lower' as const, offset: -2, startIndex: centerStart - (2 * delta) },
      { type: 'lower' as const, offset: -1, startIndex: centerStart - delta },
      { type: 'center' as const, offset: 0, startIndex: centerStart },
      { type: 'upper' as const, offset: 1, startIndex: centerStart + delta },
      { type: 'upper' as const, offset: 2, startIndex: centerStart + (2 * delta) },
    ];
    
    // Derive PDAs
    let tickArrayPdas: Array<{ type: 'lower' | 'center' | 'upper'; offset: number; pda: PublicKey }>;
    
    if (dex === 'raydium') {
      // Use SDK for Raydium (handles edge cases correctly)
      const { deriveTickArrayPda } = await import('./raydiumTickArrays.js');
      tickArrayPdas = await Promise.all(
        startIndices.map(async ({ type, offset, startIndex }) => {
          const pda = await deriveTickArrayPda(programId, poolPk, startIndex);
          return { type, offset, pda };
        })
      );
    } else {
      // Manual derivation for Orca (ASCII string encoding)
      tickArrayPdas = startIndices.map(({ type, offset, startIndex }) => {
        const [pda] = PublicKey.findProgramAddressSync(
          [Buffer.from('tick_array'), poolPk.toBuffer(), Buffer.from(startIndex.toString())],
          programId
        );
        return { type, offset, pda };
      });
    }
    
    // Batch check existence on-chain (rate limited)
    const pdaKeys = tickArrayPdas.map(p => p.pda);
    const infos = await withRpcLimit(
      () => connection.getMultipleAccountsInfo(pdaKeys),
      Math.ceil(pdaKeys.length / 5), // Weight based on number of accounts
      { module: RPC_MODULE, method: 'getMultipleAccountsInfo:tickArrays' }
    );
    
    const lower: string[] = [];
    let center: string | undefined;
    const upper: string[] = [];
    const validation: TickArrayValidation = { lower: null, center: null, upper: null };
    
    for (let i = 0; i < tickArrayPdas.length; i++) {
      const { type, pda } = tickArrayPdas[i];
      const info = infos[i];
      const exists = !!info && info.owner.equals(programId);
      const addr = pda.toBase58();
      
      if (type === 'center') {
        center = addr;
        validation.center = { address: addr, exists };
      } else if (type === 'lower') {
        if (exists) lower.push(addr);
        if (!validation.lower) validation.lower = { address: addr, exists };
      } else if (type === 'upper') {
        if (exists) upper.push(addr);
        if (!validation.upper) validation.upper = { address: addr, exists };
      }
    }
    
    if (!center) {
      return { validation };
    }
    
    return {
      tickArrays: { center, lower, upper },
      validation,
    };
  } catch (e) {
    logCatchError('deriveAndValidateTickArrays', e);
    return {};
  }
}

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
    ammConfig?: string;        // Raydium - required for swaps
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
  poolsWithMissingAmmConfig: number;         // Raydium - missing ammConfig
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
        // Try to derive and validate tick arrays if we have the required data
        if (currentTick !== undefined && tickSpacing && tickSpacing > 0) {
          // Derive tick arrays and validate on-chain
          const derivedResult = await deriveAndValidateTickArrays(
            connection, 
            basePoolId, 
            currentTick, 
            tickSpacing, 
            dex
          );
          
          if (derivedResult.tickArrays) {
            result.tickArrayValidation = derivedResult.validation;
            
            if (derivedResult.validation?.center?.exists) {
              // Successfully derived and validated - update cache
              executionCache.setHot(basePoolId, {
                ...hot,
                currentTickIndex: currentTick,
                tickSpacing,
                tickArrays: derivedResult.tickArrays,
              });
              // Don't add issues - the arrays are now valid
            } else {
              // Cached tick might be stale - try fetching fresh from chain
              const freshResult = await fetchFreshTickDataAndValidate(connection, basePoolId, dex);
              
              if (freshResult?.tickArrays && freshResult.validation?.center?.exists) {
                // Fresh data worked - update cache
                executionCache.setHot(basePoolId, {
                  ...hot,
                  currentTickIndex: freshResult.currentTick,
                  tickSpacing: freshResult.tickSpacing,
                  tickArrays: freshResult.tickArrays,
                });
                result.tickArrayValidation = freshResult.validation;
                result.cacheData = {
                  ...result.cacheData,
                  currentTick: freshResult.currentTick,
                  tickSpacing: freshResult.tickSpacing,
                };
                // Don't add issues - we fixed it with fresh data
              } else {
                // Even fresh data failed - pool might have no liquidity
                logger.debug('cache.validation.tick_array_not_found', {
                  cat: 'cache',
                  ctx: {
                    poolId: basePoolId,
                    dex,
                    cachedTick: currentTick,
                    freshTick: freshResult?.currentTick,
                    tickSpacing,
                    centerAddress: derivedResult.validation?.center?.address?.slice(0, 12),
                  }
                });
                issues.push('Center tick array does not exist on-chain (pool may have no liquidity)');
              }
            }
          } else {
            issues.push('Failed to derive tick arrays');
          }
        } else if (currentTick === undefined || !tickSpacing) {
          // Hot cache is missing tick data - try fetching fresh from chain
          const freshResult = await fetchFreshTickDataAndValidate(connection, basePoolId, dex);
          
          if (freshResult?.tickArrays && freshResult.validation?.center?.exists) {
            // Fresh data worked - update cache
            executionCache.setHot(basePoolId, {
              ...hot,
              currentTickIndex: freshResult.currentTick,
              tickSpacing: freshResult.tickSpacing,
              tickArrays: freshResult.tickArrays,
            });
            result.tickArrayValidation = freshResult.validation;
            result.cacheData = {
              currentTick: freshResult.currentTick,
              tickSpacing: freshResult.tickSpacing,
            };
            // Don't add issues - we fixed it with fresh data
          } else if (freshResult) {
            // Got fresh data but tick arrays don't exist
            result.cacheData = {
              currentTick: freshResult.currentTick,
              tickSpacing: freshResult.tickSpacing,
            };
            issues.push('Center tick array does not exist on-chain (pool may have no liquidity)');
          } else {
            // Couldn't fetch pool data at all
            issues.push('Failed to fetch pool data from chain');
          }
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
          const infos = await withRpcLimit(
            () => connection.getMultipleAccountsInfo(keysToCheck),
            Math.ceil(keysToCheck.length / 5),
            { module: RPC_MODULE, method: 'getMultipleAccountsInfo:validateTickArrays' }
          );
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
            const info = await withRpcLimit(
              () => connection.getAccountInfo(pdaPk),
              1,
              { module: RPC_MODULE, method: 'getAccountInfo:exBitmap' }
            );
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
        
        // Validate ammConfig is cached (required for Raydium swap transactions)
        let cachedAmmConfig = (stat as any)?.amm_config || null;
        
        if (!cachedAmmConfig) {
          // Try to fetch ammConfig from on-chain pool data
          try {
            const poolPk = new PublicKey(basePoolId);
            const accountInfo = await withRpcLimit(
              () => connection.getAccountInfo(poolPk),
              1,
              { module: RPC_MODULE, method: 'getAccountInfo:ammConfig' }
            );
            
            if (accountInfo?.data) {
              const { deriveRaydiumClmmCacheFields } = await import('../server/pools.derivation.js');
              const derived = await deriveRaydiumClmmCacheFields(basePoolId, accountInfo.data as Buffer);
              
              if (derived?.ammConfig) {
                cachedAmmConfig = derived.ammConfig;
                
                // Update static cache with the fetched ammConfig
                const existingStatic = executionCache.getStatic(basePoolId) || {};
                executionCache.setStatic(basePoolId, {
                  ...existingStatic,
                  amm_config: cachedAmmConfig,
                });
                
                logger.debug('cache.ammConfig.fetched', {
                  cat: 'cache',
                  poolId: basePoolId.slice(0, 8),
                  ammConfig: cachedAmmConfig.slice(0, 8),
                });
              }
            }
          } catch (e: any) {
            logger.debug('cache.ammConfig.fetch.failed', {
              cat: 'cache',
              poolId: basePoolId.slice(0, 8),
              error: e.message,
            });
          }
        }
        
        result.cacheData = {
          ...result.cacheData,
          ammConfig: cachedAmmConfig,
        };
        
        if (!cachedAmmConfig) {
          issues.push('Missing ammConfig - required for swap transactions');
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
          const infos = await withRpcLimit(
            () => connection.getMultipleAccountsInfo(keysToCheck),
            Math.ceil(keysToCheck.length / 5),
            { module: RPC_MODULE, method: 'getMultipleAccountsInfo:binArrays' }
          );
          
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
          const info = await withRpcLimit(
            () => connection.getAccountInfo(pdaPk),
            1,
            { module: RPC_MODULE, method: 'getAccountInfo:bitmapExtension' }
          );
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
 * @param options.limit - Max pools to validate. Use 0 or Infinity for all pools. Default: all pools
 * @param options.onlyClmm - Only validate CLMM pools (default true)
 */
export async function validatePoolCacheBatch(
  connection: Connection,
  dex: 'orca' | 'raydium' | 'meteora',
  options?: { limit?: number; onlyClmm?: boolean }
): Promise<BatchValidationResult> {
  const startTime = Date.now();
  // Default to all pools (no limit) - use 0 or Infinity explicitly for all
  const limit = options?.limit === 0 || options?.limit === Infinity ? Infinity : (options?.limit ?? Infinity);
  
  // Get pools from the appropriate cache
  let pools: any[] = [];
  let totalInCache = 0;
  
  if (dex === 'orca') {
    const orcaPools = peekOrcaPools();
    const allPools = orcaPools?.clmm || [];
    totalInCache = allPools.length;
    pools = limit === Infinity ? allPools : allPools.slice(0, limit);
  } else if (dex === 'raydium') {
    const raydiumPools = peekRaydiumPools();
    const allPools = raydiumPools?.clmm || [];
    totalInCache = allPools.length;
    pools = limit === Infinity ? allPools : allPools.slice(0, limit);
  } else if (dex === 'meteora') {
    const meteoraPools = peekMeteoraPools();
    const allPools = meteoraPools?.clmm || [];
    totalInCache = allPools.length;
    pools = limit === Infinity ? allPools : allPools.slice(0, limit);
  }
  
  logger.debug('cache.validation.batch.start', {
    cat: 'cache',
    ctx: { dex, totalInCache, poolsToValidate: pools.length, limit: limit === Infinity ? 'all' : limit }
  });
  
  const results: PoolValidationResult[] = [];
  let validPools = 0;
  let poolsWithMissingCenter = 0;
  let poolsWithMissingArrays = 0;
  let poolsWithNoCacheEntry = 0;
  let poolsWithInvalidBitmapExtension = 0;  // Meteora
  let poolsWithInvalidExBitmap = 0;          // Raydium
  let poolsWithMissingAmmConfig = 0;         // Raydium - missing ammConfig
  
  // Process in batches to avoid overwhelming RPC
  // Reduced batch size and added delay between batches for rate limiting
  const BATCH_SIZE = 5;
  const BATCH_DELAY_MS = 100; // 100ms delay between batches
  
  for (let i = 0; i < pools.length; i += BATCH_SIZE) {
    const batch = pools.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(pool => validatePoolCache(connection, pool.id, dex))
    );
    
    // Add delay between batches to prevent RPC overload
    if (i + BATCH_SIZE < pools.length) {
      await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
    }
    
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
        
        // Track missing ammConfig (Raydium only)
        if (result.dex === 'raydium' && result.issues?.some(i => i.includes('ammConfig'))) {
          poolsWithMissingAmmConfig++;
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
      poolsWithMissingAmmConfig,
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
    poolsWithMissingAmmConfig,
    results,
    timestamp: Date.now(),
    durationMs,
  };
}

/**
 * Get a summary of cache health across all DEXes
 * @param options.poolsPerDex - Max pools per DEX. Omit or use 0 for all pools.
 * @param options.validateAll - If true, validates ALL pools (overrides poolsPerDex)
 */
export async function getCacheHealthSummary(
  connection: Connection,
  options?: { poolsPerDex?: number; validateAll?: boolean }
): Promise<{
  orca: BatchValidationResult;
  raydium: BatchValidationResult;
  meteora: BatchValidationResult;
  overallHealthPercent: number;
  timestamp: number;
}> {
  // Default to validating ALL pools unless a specific limit is provided
  const hasExplicitLimit = options?.poolsPerDex !== undefined && options.poolsPerDex > 0;
  const poolsPerDex = options?.validateAll || !hasExplicitLimit ? Infinity : options!.poolsPerDex!;
  
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
            // Also populate/update static cache (handles "No cache entry" case and missing fields)
            const existingStatic = executionCache.getStatic(pool.poolId) || {};
            const staticUpdate: any = {
              ...existingStatic,
              programId: validatedState.programId,
              dex: pool.dex === 'orca' ? 'Orca' : pool.dex === 'raydium' ? 'Raydium' : 'Meteora',
              pool_kind: 'clmm',
            };
            
            if (validatedState.tickSpacing) staticUpdate.tick_spacing = validatedState.tickSpacing;
            if (validatedState.binStep) staticUpdate.binStep = validatedState.binStep;
            
            // Raydium-specific: store ammConfig and observationState
            if (pool.dex === 'raydium') {
              if (validatedState.ammConfig) staticUpdate.amm_config = validatedState.ammConfig;
              if (validatedState.observationState) staticUpdate.observation_state = validatedState.observationState;
            }
            
            executionCache.setStatic(pool.poolId, staticUpdate);
            
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
              logger.debug('cache.refresh.pool.success', {
                cat: 'cache',
                ctx: {
                  poolId: pool.poolId,
                  dex: pool.dex,
                  tickArraysFound: {
                    center: !!validatedState.tickArrays.center,
                    lower: validatedState.tickArrays.lower?.length ?? 0,
                    upper: validatedState.tickArrays.upper?.length ?? 0,
                  },
                }
              });
              return { success: true, poolId: pool.poolId };
            } else if (validatedState.currentTick !== undefined) {
              // Pool was fetched but no tick arrays found on-chain
              return { 
                success: false, 
                poolId: pool.poolId, 
                error: `No tick arrays found on-chain (tick: ${validatedState.currentTick}, spacing: ${validatedState.tickSpacing})` 
              };
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
          
          return { 
            success: false, 
            poolId: pool.poolId, 
            error: validatedState 
              ? `State fetched but no arrays found (dex: ${pool.dex})` 
              : 'Failed to fetch pool state from chain'
          };
        } catch (err: any) {
          return { success: false, poolId: pool.poolId, error: `${pool.dex}: ${err.message}` };
        }
      })
    );
    
    for (const result of results) {
      if (result.success) {
        refreshed++;
      } else {
        failed++;
        if (result.error) {
          // Mark pools with no liquidity separately - they're not "failures" in the error sense
          const isNoLiquidity = result.error.includes('No tick arrays found on-chain') || 
                               result.error.includes('no liquidity');
          if (!isNoLiquidity) {
            errors.push(`${result.poolId}: ${result.error}`);
          }
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
      const infos = await withRpcLimit(
        () => connection.getMultipleAccountsInfo(pdas),
        Math.ceil(pdas.length / 5),
        { module: RPC_MODULE, method: 'getMultipleAccountsInfo:bitmapBatch' }
      );
      
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
    const info = await withRpcLimit(
      () => connection.getAccountInfo(pda),
      1,
      { module: RPC_MODULE, method: 'getAccountInfo:meteoraBitmapSingle' }
    );
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
      const infos = await withRpcLimit(
        () => connection.getMultipleAccountsInfo(pdas),
        Math.ceil(pdas.length / 5),
        { module: RPC_MODULE, method: 'getMultipleAccountsInfo:bitmapBatch' }
      );
      
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
    const info = await withRpcLimit(
      () => connection.getAccountInfo(pda),
      1,
      { module: RPC_MODULE, method: 'getAccountInfo:raydiumExBitmapSingle' }
    );
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

