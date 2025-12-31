/**
 * Cache Validator - Validates tick/bin array existence on-chain
 * 
 * This module provides utilities to validate that cached tick arrays (Orca, Raydium)
 * and bin arrays (Meteora) actually exist on-chain before attempting swaps.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { executionCache } from './cache.js';
import { setClmmStatic, getClmmStatic } from './clmmCache.js';
import { logger } from '../utils/logger.js';
import { logCatchError } from '../utils/errorHandler.js';
import { peekRaydiumPools, peekOrcaPools, peekMeteoraPools, peekPumpswapPools, peekMeteoraBalancedPools } from '../server/pools.js';
import { updatePoolCacheFromValidation } from '../server/pools.cache.js';
import { withRpcLimit } from '../utils/rpcLimiter.js';
import { resolveManyDecimals } from '../server/pools/decimals.js';
import { updateEligibilityFromBatchValidation } from '../server/pools.websockets.js';

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

// Bitmap extension range - default bitmap covers bin array indices -512 to +511
const METEORA_BITMAP_RANGE = 512;

/**
 * Quick check if a Meteora pool is eligible for trading based on activeId.
 * 
 * Use this in WebSocket handlers to toggle pool eligibility without full validation.
 * A pool is eligible if:
 * 1. It has a bitmap extension initialized on-chain, OR
 * 2. The current activeId is within the safe range (bin array index ±512)
 * 
 * @param activeId - The pool's current active bin ID
 * @param hasBitmapExtension - Whether the bitmap extension PDA exists on-chain
 * @returns Eligibility status with bin array index and whether extension is required
 */
export function checkMeteoraBitmapEligibility(
  activeId: number,
  hasBitmapExtension: boolean
): { eligible: boolean; binArrayIndex: number; requiresExtension: boolean } {
  const binArrayIndex = Math.floor(activeId / METEORA_BIN_ARRAY_SIZE);
  const requiresExtension = binArrayIndex < -METEORA_BITMAP_RANGE || binArrayIndex >= METEORA_BITMAP_RANGE;
  const eligible = hasBitmapExtension || !requiresExtension;
  
  return { eligible, binArrayIndex, requiresExtension };
}

/**
 * Calculate the safe activeId range for pools without bitmap extension.
 * Useful for determining if a pool can become tradeable again.
 * 
 * @returns The min/max activeId values that don't require bitmap extension
 */
export function getMeteoraSafeActiveIdRange(): { min: number; max: number } {
  return {
    min: -METEORA_BITMAP_RANGE * METEORA_BIN_ARRAY_SIZE,  // -35,840
    max: METEORA_BITMAP_RANGE * METEORA_BIN_ARRAY_SIZE - 1,  // +35,839
  };
}

/**
 * Fetch fresh tick data from chain and validate tick arrays
 * Used when cached tick data leads to non-existent tick arrays
 * 
 * IMPORTANT: This function validates derivation-dependent values FIRST,
 * updates the cache immediately with fresh values, then derives tick arrays.
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
  derivationValidation: DerivationValidation;
} | null> {
  try {
    const poolPk = new PublicKey(poolId);
    const basePoolId = poolId.replace(/[#-]rev$/, '');
    
    // Get cached values BEFORE fetching fresh data (for comparison)
    const hot = executionCache.getHot(basePoolId);
    const stat = executionCache.getStatic(basePoolId);
    const cachedTick = hot?.currentTickIndex;
    const cachedSpacing = hot?.tickSpacing || stat?.tickSpacing || (stat as any)?.tick_spacing;
    
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
    
    // === DERIVATION VALIDATION ===
    // Validate derivation-dependent values FIRST before deriving arrays
    const TICK_ARRAY_SIZE = dex === 'raydium' ? RAYDIUM_TICK_ARRAY_SIZE : ORCA_TICK_ARRAY_SIZE;
    const ticksInArray = TICK_ARRAY_SIZE * tickSpacing;
    
    // Calculate tick array indices to detect if drift requires new arrays
    const cachedTickArrayIdx = cachedTick !== undefined 
      ? Math.floor(cachedTick / ticksInArray) 
      : undefined;
    const freshTickArrayIdx = Math.floor(currentTick / ticksInArray);
    const tickArrayIdxChanged = cachedTickArrayIdx !== undefined && cachedTickArrayIdx !== freshTickArrayIdx;
    
    const tickDrift = cachedTick !== undefined ? Math.abs(currentTick - cachedTick) : 0;
    const tickDriftPercent = cachedTick !== undefined && cachedTick !== 0 
      ? Math.abs((currentTick - cachedTick) / cachedTick * 100) 
      : 0;
    
    const derivationFieldsValid = tickSpacing > 0 && tickSpacing <= 1000;
    const cacheWasStale = cachedTick !== currentTick || cachedSpacing !== tickSpacing;
    
    const derivationValidation: DerivationValidation = {
      currentTick: {
        cached: cachedTick,
        fresh: currentTick,
        drift: tickDrift,
        driftPercent: tickDriftPercent,
      },
      tickSpacing: {
        cached: cachedSpacing,
        fresh: tickSpacing,
        matches: cachedSpacing === tickSpacing,
      },
      derivationFieldsValid,
      cacheWasStale,
      cacheUpdated: false,
      needsArrayRederivation: tickArrayIdxChanged,
    };
    
    // === UPDATE CACHE IMMEDIATELY WITH FRESH DERIVATION VALUES ===
    // This ensures any subsequent operations use the validated values
    if (cacheWasStale && derivationFieldsValid) {
      const existingHot = executionCache.getHot(basePoolId) || {};
      executionCache.setHot(basePoolId, {
        ...existingHot,
        currentTickIndex: currentTick,
        tickSpacing,
      });
      derivationValidation.cacheUpdated = true;
      
      logger.info('cache.derivation.tick_updated', {
        cat: 'cache',
        ctx: {
          poolId: basePoolId.slice(0, 8) + '…',
          dex,
          cachedTick,
          freshTick: currentTick,
          tickDrift,
          tickDriftPercent: tickDriftPercent.toFixed(2) + '%',
          tickArrayIdxChanged,
          cachedTickArrayIdx,
          freshTickArrayIdx,
        }
      });
    }
    
    if (!derivationFieldsValid) {
      logger.warn('cache.derivation.invalid_tick_spacing', {
        cat: 'cache',
        ctx: {
          poolId: basePoolId.slice(0, 8) + '…',
          dex,
          tickSpacing,
        }
      });
      return null;
    }
    
    // === NOW DERIVE TICK ARRAYS FROM VALIDATED FRESH VALUES ===
    const derivedResult = await deriveAndValidateTickArrays(connection, poolId, currentTick, tickSpacing, dex);
    
    return {
      currentTick,
      tickSpacing,
      tickArrays: derivedResult.tickArrays,
      validation: derivedResult.validation,
      derivationValidation,
    };
  } catch (e) {
    logCatchError('fetchFreshTickDataAndValidate', e);
    return null;
  }
}

/**
 * Fetch fresh bin data from chain and validate bin arrays for Meteora DLMM
 * Used to ensure we're deriving bin arrays from the current activeId, not stale cache
 * 
 * IMPORTANT: This function validates derivation-dependent values FIRST,
 * updates the cache immediately with fresh values, then derives bin arrays.
 */
async function fetchFreshBinDataAndValidate(
  connection: Connection,
  poolId: string
): Promise<{
  activeId: number;
  binStep: number;
  binArrays?: { 
    lower?: string; 
    upper?: string; 
    active?: string;
    arrays: Array<{ index: number; address: string }>;
  };
  validation?: BinArrayValidation;
  derivationValidation: DerivationValidation;
} | null> {
  try {
    const poolPk = new PublicKey(poolId);
    const basePoolId = poolId.replace(/[#-]rev$/, '');
    
    // Get cached values BEFORE fetching fresh data (for comparison)
    const hot = executionCache.getHot(basePoolId);
    const stat = executionCache.getStatic(basePoolId);
    const cachedActiveId = hot?.activeId;
    const cachedBinStep = hot?.binStep || stat?.binStep;
    
    const accountInfo = await withRpcLimit(
      () => connection.getAccountInfo(poolPk),
      1,
      { module: RPC_MODULE, method: 'getAccountInfo:fetchBin' }
    );
    
    if (!accountInfo || !accountInfo.data) {
      return null;
    }
    
    const data = accountInfo.data;
    
    // Meteora DLMM layout offsets (based on LbPair struct)
    // discriminator(8) + parameters(32) + vParameters(32) + bumpSeed(1) + binStepSeed(2) + 
    // pairType(1) + activeId(4) + binStep(2) + ...
    // Active ID is at offset ~76 (after parameters block)
    if (data.length < 120) return null;
    
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    
    // Extract activeId (i32 at approximate offset)
    // Based on Meteora SDK: activeId is stored as i32
    let activeId: number;
    let binStep: number;
    
    try {
      // Try using Meteora SDK for accurate decoding
      const meteoraSdk = await import('@meteora-ag/dlmm');
      const lbPairLayout = (meteoraSdk as any).LBPAIR_LAYOUT || 
                           (meteoraSdk as any).LbPairLayout ||
                           (meteoraSdk as any).default?.LBPAIR_LAYOUT;
      
      if (lbPairLayout?.decode) {
        const decoded = lbPairLayout.decode(data);
        activeId = Number(decoded.activeId ?? decoded.active_id ?? 0);
        binStep = Number(decoded.binStep ?? decoded.bin_step ?? 0);
      } else {
        // Manual extraction based on known offsets
        // Meteora LbPair layout: discriminator(8) + parameters(StaticParameters ~32) + vParameters(VariableParameters ~32)
        // Then: bumpSeed(1) + binStepSeed(2) + pairType(1) + activeId(4) + binStep(2)
        // Approximate offset for activeId: 8 + 32 + 32 + 1 + 2 + 1 = 76
        activeId = view.getInt32(76, true);
        binStep = view.getUint16(80, true);
      }
    } catch {
      // Fallback to manual extraction
      activeId = view.getInt32(76, true);
      binStep = view.getUint16(80, true);
    }
    
    if (binStep <= 0 || binStep > 10000) {
      // Try alternative offset - layout might differ
      // Some versions: activeId at offset 72
      activeId = view.getInt32(72, true);
      binStep = view.getUint16(76, true);
      
      if (binStep <= 0 || binStep > 10000) {
        logger.debug('cache.validation.meteora.invalid_bin_step', {
          cat: 'cache',
          ctx: { poolId: poolId.slice(0, 8), binStep }
        });
        return null;
      }
    }
    
    // === DERIVATION VALIDATION ===
    // Validate derivation-dependent values FIRST before deriving arrays
    
    // Calculate bin array indices to detect if drift requires new arrays
    const cachedBinArrayIdx = cachedActiveId !== undefined 
      ? Math.floor(cachedActiveId / METEORA_BIN_ARRAY_SIZE)
      : undefined;
    const freshBinArrayIdx = Math.floor(activeId / METEORA_BIN_ARRAY_SIZE);
    const activeBinArrayIdxChanged = cachedBinArrayIdx !== undefined && cachedBinArrayIdx !== freshBinArrayIdx;
    
    const activeIdDrift = cachedActiveId !== undefined ? Math.abs(activeId - cachedActiveId) : 0;
    
    const derivationFieldsValid = binStep > 0 && binStep <= 10000;
    const cacheWasStale = cachedActiveId !== activeId || cachedBinStep !== binStep;
    
    const derivationValidation: DerivationValidation = {
      activeId: {
        cached: cachedActiveId,
        fresh: activeId,
        drift: activeIdDrift,
        activeBinArrayIdxChanged,
      },
      binStep: {
        cached: cachedBinStep,
        fresh: binStep,
        matches: cachedBinStep === binStep,
      },
      derivationFieldsValid,
      cacheWasStale,
      cacheUpdated: false,
      needsArrayRederivation: activeBinArrayIdxChanged,
    };
    
    // === UPDATE CACHE IMMEDIATELY WITH FRESH DERIVATION VALUES ===
    // This ensures any subsequent operations use the validated values
    if (cacheWasStale && derivationFieldsValid) {
      const existingHot = executionCache.getHot(basePoolId) || {};
      executionCache.setHot(basePoolId, {
        ...existingHot,
        activeId,
        binStep,
      });
      derivationValidation.cacheUpdated = true;
      
      logger.info('cache.derivation.activeId_updated', {
        cat: 'cache',
        ctx: {
          poolId: basePoolId.slice(0, 8) + '…',
          dex: 'meteora',
          cachedActiveId,
          freshActiveId: activeId,
          activeIdDrift,
          activeBinArrayIdxChanged,
          cachedBinArrayIdx,
          freshBinArrayIdx,
        }
      });
    }
    
    // === NOW DERIVE BIN ARRAYS FROM VALIDATED FRESH VALUES ===
    const derivedResult = await deriveAndValidateBinArrays(connection, poolId, activeId);
    
    return {
      activeId,
      binStep,
      binArrays: derivedResult.binArrays,
      validation: derivedResult.validation,
      derivationValidation,
    };
  } catch (e) {
    logCatchError('fetchFreshBinDataAndValidate', e);
    return null;
  }
}

/**
 * Derive and validate bin arrays for a Meteora DLMM pool
 * Returns derived addresses and their on-chain validation status
 */
async function deriveAndValidateBinArrays(
  connection: Connection,
  poolId: string,
  activeId: number
): Promise<{
  binArrays?: { 
    lower?: string; 
    upper?: string; 
    active?: string;
    arrays: Array<{ index: number; address: string }>;
  };
  validation?: BinArrayValidation;
}> {
  try {
    const poolPk = new PublicKey(poolId);
    
    // Calculate bin array index from activeId
    const activeBinArrayIdx = Math.floor(activeId / METEORA_BIN_ARRAY_SIZE);
    
    // Derive PDAs for surrounding bin arrays (active-2, active-1, active, active+1, active+2)
    const RANGE = 2;
    const binArrayPdas: Array<{ index: number; pda: PublicKey }> = [];
    
    for (let i = -RANGE; i <= RANGE; i++) {
      const binArrayIdx = activeBinArrayIdx + i;
      try {
        // Meteora bin array PDA: seeds = ["bin_array", pool, bin_array_index as i64 LE]
        const indexBuffer = Buffer.alloc(8);
        // Write as signed 64-bit little-endian
        const bigIdx = BigInt(binArrayIdx);
        indexBuffer.writeBigInt64LE(bigIdx, 0);
        
        const [pda] = PublicKey.findProgramAddressSync(
          [Buffer.from('bin_array'), poolPk.toBuffer(), indexBuffer],
          METEORA_DLMM_PROGRAM
        );
        binArrayPdas.push({ index: binArrayIdx, pda });
      } catch (e) {
        // Skip invalid indices
      }
    }
    
    if (binArrayPdas.length === 0) {
      return {};
    }
    
    // Batch check existence on-chain
    const pdaKeys = binArrayPdas.map(p => p.pda);
    const infos = await withRpcLimit(
      () => connection.getMultipleAccountsInfo(pdaKeys),
      Math.ceil(pdaKeys.length / 5),
      { module: RPC_MODULE, method: 'getMultipleAccountsInfo:binArrays' }
    );
    
    const arrays: Array<{ index: number; address: string }> = [];
    let lower: string | undefined;
    let upper: string | undefined;
    let active: string | undefined;
    const validation: BinArrayValidation = { lower: null, upper: null, active: null };
    
    for (let i = 0; i < binArrayPdas.length; i++) {
      const { index, pda } = binArrayPdas[i];
      const info = infos[i];
      const exists = !!info && info.owner.equals(METEORA_DLMM_PROGRAM);
      const addr = pda.toBase58();
      
      if (exists) {
        arrays.push({ index, address: addr });
        
        if (index === activeBinArrayIdx) {
          active = addr;
          validation.active = { address: addr, exists: true };
        } else if (index === activeBinArrayIdx - 1) {
          lower = addr;
          validation.lower = { address: addr, exists: true };
        } else if (index === activeBinArrayIdx + 1) {
          upper = addr;
          validation.upper = { address: addr, exists: true };
        }
      } else {
        if (index === activeBinArrayIdx && !validation.active) {
          validation.active = { address: addr, exists: false };
        } else if (index === activeBinArrayIdx - 1 && !validation.lower) {
          validation.lower = { address: addr, exists: false };
        } else if (index === activeBinArrayIdx + 1 && !validation.upper) {
          validation.upper = { address: addr, exists: false };
        }
      }
    }
    
    return {
      binArrays: {
        lower,
        upper,
        active,
        arrays,
      },
      validation,
    };
  } catch (e) {
    logCatchError('deriveAndValidateBinArrays', e);
    return {};
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
    
    // Track all existing arrays with their offsets (for finding nearest if center doesn't exist)
    const existingArrays: Array<{ offset: number; address: string; type: 'lower' | 'center' | 'upper' }> = [];
    let centerExists = false;
    
    for (let i = 0; i < tickArrayPdas.length; i++) {
      const { type, offset, pda } = tickArrayPdas[i];
      const info = infos[i];
      const exists = !!info && info.owner.equals(programId);
      const addr = pda.toBase58();
      
      if (exists) {
        existingArrays.push({ offset, address: addr, type });
      }
      
      if (type === 'center') {
        center = addr;
        centerExists = exists;
        validation.center = { address: addr, exists };
      } else if (type === 'lower') {
        if (exists) lower.push(addr);
        if (!validation.lower) validation.lower = { address: addr, exists };
      } else if (type === 'upper') {
        if (exists) upper.push(addr);
        if (!validation.upper) validation.upper = { address: addr, exists };
      }
    }
    
    // If center doesn't exist but we have other arrays, use nearest as center
    // This handles pools with concentrated liquidity where tick has drifted into uninitialized range
    if (!centerExists && existingArrays.length > 0) {
      // Sort by absolute offset (closest to calculated center first)
      existingArrays.sort((a, b) => Math.abs(a.offset) - Math.abs(b.offset));
      const nearest = existingArrays[0];
      center = nearest.address;
      
      // Update validation to mark the nearest array as the effective center
      validation.center = { address: nearest.address, exists: true };
      
      // Recategorize lower/upper relative to the new center
      lower.length = 0;
      upper.length = 0;
      for (const arr of existingArrays) {
        if (arr.address === center) continue;
        if (arr.offset < nearest.offset) {
          lower.push(arr.address);
        } else {
          upper.push(arr.address);
        }
      }
      
      logger.debug('cache.validation.center_from_nearest', {
        cat: 'cache',
        ctx: { 
          poolId: poolId.slice(0, 8),
          dex,
          currentTick,
          nearestOffset: nearest.offset,
          totalExisting: existingArrays.length,
        }
      });
    } else if (!centerExists && existingArrays.length === 0) {
      // No tick arrays exist at all
      return { validation };
    }
    
    return {
      tickArrays: { center: center!, lower, upper },
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

/**
 * Derivation Validation - validates the values that tick/bin array derivation depends on
 * These must be validated FIRST before deriving arrays
 */
export interface DerivationValidation {
  // Raydium/Orca CLMM fields
  currentTick?: {
    cached: number | undefined;
    fresh: number;
    drift: number;
    driftPercent: number;
  };
  tickSpacing?: {
    cached: number | undefined;
    fresh: number;
    matches: boolean;
  };
  // Meteora DLMM fields
  activeId?: {
    cached: number | undefined;
    fresh: number;
    drift: number;
    /** True if the active bin array index changed (requires new bin arrays) */
    activeBinArrayIdxChanged: boolean;
  };
  binStep?: {
    cached: number | undefined;
    fresh: number;
    matches: boolean;
  };
  // Common validation results
  /** All derivation-dependent fields have valid values */
  derivationFieldsValid: boolean;
  /** Cached values differed from fresh chain values */
  cacheWasStale: boolean;
  /** Cache was updated with fresh values */
  cacheUpdated: boolean;
  /** Tick/bin array needs to be re-derived due to significant drift */
  needsArrayRederivation: boolean;
}

export interface BitmapExtensionValidation {
  cachedValue: string | null;
  derivedPda: string;
  pdaExistsOnChain: boolean;
  isUsingProgramIdFallback: boolean;
  isValid: boolean;
  issue?: string;
  /** Does the current activeId require a bitmap extension? (bin array index outside ±512) */
  activeIdRequiresBitmapExt?: boolean;
  /** The calculated bin array index from activeId */
  binArrayIndex?: number;
  /** Can we trade this pool right now? True if bitmap ext exists OR activeId doesn't require it */
  isEligibleForTrading?: boolean;
}

export interface RaydiumExBitmapValidation {
  cachedValue: string | null;
  derivedPda: string;
  pdaExistsOnChain: boolean;
  isValid: boolean;
  issue?: string;
  /** Does the current tick require an exBitmap extension? (tick array index outside ±512) */
  tickRequiresExBitmap?: boolean;
  /** The calculated tick array index from currentTick */
  tickArrayIndex?: number;
  /** Can we trade this pool right now? True if exBitmap exists OR tick doesn't require it */
  isEligibleForTrading?: boolean;
}

export interface OrcaTickEligibility {
  /** Current tick from pool state */
  currentTick?: number;
  /** Tick spacing for array index calculation */
  tickSpacing?: number;
  /** The calculated tick array index */
  tickArrayIndex?: number;
  /** Does center tick array exist on-chain? */
  centerArrayExists: boolean;
  /** Can we trade this pool right now? True if center tick array exists */
  isEligibleForTrading: boolean;
  issue?: string;
}

export interface FeeValidation {
  feeBps: number | null;
  isValid: boolean;
  isZero: boolean;
  source: 'pool_cache' | 'execution_cache' | 'none';
  issue?: string;
}

export interface PoolValidationResult {
  poolId: string;
  dex: 'orca' | 'raydium' | 'meteora';
  hasCacheEntry: boolean;
  hasHotCache: boolean;
  hasStaticCache: boolean;
  /** Validation of derivation-dependent values (currentTick, activeId, etc.) - validated FIRST */
  derivationValidation?: DerivationValidation;
  tickArrayValidation?: TickArrayValidation;
  binArrayValidation?: BinArrayValidation;
  bitmapExtensionValidation?: BitmapExtensionValidation;  // Meteora bitmap extension
  exBitmapValidation?: RaydiumExBitmapValidation;          // Raydium tick array bitmap extension
  orcaTickEligibility?: OrcaTickEligibility;               // Orca tick array eligibility
  feeValidation?: FeeValidation;                          // Fee BPS validation
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
    feeBps?: number;           // Fee in basis points
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
  poolsIneligibleDueToBitmapRange: number;  // Meteora - activeId outside ±512 bin array range with no bitmap ext
  poolsWithInvalidExBitmap: number;          // Raydium
  poolsIneligibleDueToExBitmapRange: number; // Raydium - tick outside ±512 array range with no exBitmap
  poolsIneligibleDueToTickArray: number;     // Orca - center tick array doesn't exist
  poolsWithMissingAmmConfig: number;         // Raydium - missing ammConfig
  poolsWithZeroFee: number;                  // Pools with 0 fee BPS (likely incorrect)
  poolsWithMissingFee: number;               // Pools with no fee in cache
  // Derivation validation stats
  poolsWithStaleDerivedValues: number;       // Pools where cached tick/activeId differed from chain
  poolsWithDerivationUpdated: number;        // Pools where cache was updated with fresh derivation values
  poolsNeedingArrayRederivation: number;     // Pools where tick/bin drift requires new arrays
  results: PoolValidationResult[];
  timestamp: number;
  durationMs: number;
}

// === DECIMAL VALIDATION TYPES ===

export type DecimalSource = 'pool' | 'cache' | 'jupiter' | 'rpc' | 'fallback';

export interface DecimalValidationResult {
  poolId: string;
  dex: 'orca' | 'raydium' | 'meteora' | 'pumpswap' | 'meteora_balanced';
  valid: boolean;
  issues: string[];
  // Before validation
  hadDecimalsA: boolean;
  hadDecimalsB: boolean;
  // After validation
  decimalsA?: number;
  decimalsB?: number;
  // Resolution source
  sourceA?: DecimalSource;
  sourceB?: DecimalSource;
  wasUpdated: boolean;
}

export interface DecimalBatchValidationResult {
  dex: string;
  totalPools: number;
  poolsValidated: number;
  poolsWithMissingDecimals: number;
  poolsUpdated: number;
  poolsStillMissing: number;
  uniqueMintsResolved: number;
  timestamp: number;
  durationMs: number;
  results: DecimalValidationResult[];
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
      // ALWAYS fetch fresh tick data from chain first
      // This prevents using stale cached tick values that could lead to wrong tick arrays
      const freshResult = await fetchFreshTickDataAndValidate(connection, basePoolId, dex);
      
      if (freshResult) {
        const { currentTick, tickSpacing, tickArrays, validation, derivationValidation } = freshResult;
        
        result.cacheData = {
          currentTick,
          tickSpacing,
        };
        result.tickArrayValidation = validation;
        result.derivationValidation = derivationValidation;
        
        // Log derivation validation results
        if (derivationValidation?.cacheWasStale) {
          logger.info('cache.validation.derivation.stale_detected', {
            cat: 'cache',
            ctx: {
              poolId: basePoolId.slice(0, 8) + '…',
              dex,
              tickDrift: derivationValidation.currentTick?.drift,
              tickDriftPercent: derivationValidation.currentTick?.driftPercent?.toFixed(2) + '%',
              needsArrayRederivation: derivationValidation.needsArrayRederivation,
              cacheUpdated: derivationValidation.cacheUpdated,
            }
          });
        }
        
        if (tickArrays && validation?.center?.exists) {
          // Successfully validated with fresh data - update all caches
          
          // Update hot cache with fresh tick and arrays
          const existingHot = executionCache.getHot(basePoolId) || {};
          executionCache.setHot(basePoolId, {
            ...existingHot,
            currentTickIndex: currentTick,
            tickSpacing,
            tickArrays,
          });
          
          // Also update static cache tick arrays for consistency
          const existingStat = executionCache.getStatic(basePoolId) || {};
          executionCache.setStatic(basePoolId, {
            ...existingStat,
            tick_spacing: tickSpacing,
            tickArrayLower: Array.isArray(tickArrays.lower) ? tickArrays.lower[0] : tickArrays.lower,
            tickArrayCenter: tickArrays.center,
            tickArrayUpper: Array.isArray(tickArrays.upper) ? tickArrays.upper[0] : tickArrays.upper,
          });
          
          // For Raydium, also update the dedicated CLMM cache if entry exists
          // We can only update existing entries since we don't have all required fields to create new ones
          if (dex === 'raydium') {
            const existingClmm = getClmmStatic(basePoolId);
            if (existingClmm) {
              setClmmStatic(basePoolId, {
                ...existingClmm,
                tickSpacing,
                tickArrays: {
                  center: tickArrays.center,
                  lower: tickArrays.lower,
                  upper: tickArrays.upper,
                },
                lastUpdateMs: Date.now(),
              });
            }
          }
          
          logger.debug('cache.validation.fresh_tick_success', {
            cat: 'cache',
            ctx: {
              poolId: basePoolId.slice(0, 8),
              dex,
              currentTick,
              tickSpacing,
              center: tickArrays.center?.slice(0, 12),
              lowerCount: Array.isArray(tickArrays.lower) ? tickArrays.lower.length : (tickArrays.lower ? 1 : 0),
              upperCount: Array.isArray(tickArrays.upper) ? tickArrays.upper.length : (tickArrays.upper ? 1 : 0),
            }
          });
          
          // No issues - arrays are valid
        } else if (tickArrays) {
          // Arrays derived but center doesn't exist on-chain
          // STILL update the hot cache with fresh tick data, but clear invalid arrays
          logger.debug('cache.validation.tick_array_not_found', {
            cat: 'cache',
            ctx: {
              poolId: basePoolId.slice(0, 8),
              dex,
              freshTick: currentTick,
              tickSpacing,
              centerAddress: validation?.center?.address?.slice(0, 12),
              lowerExists: validation?.lower?.exists,
              upperExists: validation?.upper?.exists,
            }
          });
          
          // Update hot cache with fresh tick but ONLY include arrays that exist on-chain
          const existingHot = executionCache.getHot(basePoolId) || {};
          const validatedArrays: {
            center?: string;
            lower?: string | string[];
            upper?: string | string[];
          } = {};
          
          // Only include arrays that actually exist on-chain
          if (validation?.center?.exists && tickArrays.center) {
            validatedArrays.center = tickArrays.center;
          }
          if (validation?.lower?.exists && tickArrays.lower) {
            validatedArrays.lower = tickArrays.lower;
          }
          if (validation?.upper?.exists && tickArrays.upper) {
            validatedArrays.upper = tickArrays.upper;
          }
          
          executionCache.setHot(basePoolId, {
            ...existingHot,
            currentTickIndex: currentTick,
            tickSpacing,
            // Set tickArrays to only contain existing arrays, or undefined if none exist
            tickArrays: Object.keys(validatedArrays).length > 0 ? validatedArrays as any : undefined,
          });
          
          // Update static cache - clear arrays that don't exist
          const existingStat = executionCache.getStatic(basePoolId) || {};
          executionCache.setStatic(basePoolId, {
            ...existingStat,
            tick_spacing: tickSpacing,
            tickArrayLower: validation?.lower?.exists 
              ? (Array.isArray(tickArrays.lower) ? tickArrays.lower[0] : tickArrays.lower)
              : undefined,
            tickArrayCenter: validation?.center?.exists ? tickArrays.center : undefined,
            tickArrayUpper: validation?.upper?.exists
              ? (Array.isArray(tickArrays.upper) ? tickArrays.upper[0] : tickArrays.upper)
              : undefined,
          });
          
          // For Raydium, also update the CLMM cache if entry exists
          // We can only update existing entries since we don't have all required fields to create new ones
          if (dex === 'raydium') {
            const existingClmm = getClmmStatic(basePoolId);
            if (existingClmm) {
              setClmmStatic(basePoolId, {
                ...existingClmm,
                tickSpacing,
                tickArrays: Object.keys(validatedArrays).length > 0 ? validatedArrays as any : undefined,
                lastUpdateMs: Date.now(),
              });
            }
          }
          
          logger.info('cache.validation.tick_array_cleared_stale', {
            cat: 'cache',
            ctx: {
              poolId: basePoolId.slice(0, 8),
              dex,
              freshTick: currentTick,
              centerExists: validation?.center?.exists,
              lowerExists: validation?.lower?.exists,
              upperExists: validation?.upper?.exists,
            }
          });
          
          issues.push('Center tick array does not exist on-chain (pool may have no liquidity)');
        } else {
          issues.push('Failed to derive tick arrays from fresh chain data');
        }
      } else {
        // Couldn't fetch fresh pool data - fall back to cached data as last resort
        const cachedTick = hot?.currentTickIndex;
        const cachedSpacing = hot?.tickSpacing || stat?.tickSpacing || (stat as any)?.tick_spacing;
        
        result.cacheData = {
          currentTick: cachedTick,
          tickSpacing: cachedSpacing,
        };
        
        issues.push('Failed to fetch fresh pool data from chain');
        
        // Attempt validation with cached data if available (better than nothing)
        if (hot?.tickArrays) {
          const tickArrays = hot.tickArrays;
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
                issues.push(`${type} tick array does not exist on-chain (using cached data)`);
              }
            }
            
            result.tickArrayValidation = validation;
            
            // Warn that we're using potentially stale cached data
            issues.push('WARNING: Using cached tick data - arrays may be stale');
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
            
            // Calculate eligibility based on current tick and exBitmap existence
            const raydiumTickSpacing = result.cacheData?.tickSpacing || 1;
            const raydiumCurrentTick = result.cacheData?.currentTick;
            if (raydiumCurrentTick !== undefined) {
              const ticksInArray = RAYDIUM_TICK_ARRAY_SIZE * raydiumTickSpacing;
              const tickArrayIndex = Math.floor(raydiumCurrentTick / ticksInArray);
              const RAYDIUM_BITMAP_RANGE = 512; // ±512 tick array indices
              const tickRequiresExBitmap = tickArrayIndex < -RAYDIUM_BITMAP_RANGE || tickArrayIndex >= RAYDIUM_BITMAP_RANGE;
              const isEligibleForTrading = pdaExistsOnChain || !tickRequiresExBitmap;
              
              exBitmapValidation.tickRequiresExBitmap = tickRequiresExBitmap;
              exBitmapValidation.tickArrayIndex = tickArrayIndex;
              exBitmapValidation.isEligibleForTrading = isEligibleForTrading;
              
              if (!isEligibleForTrading) {
                const ineligibleIssue = `Pool ineligible: tick array index ${tickArrayIndex} requires exBitmap but none exists`;
                exBitmapValidation.issue = ineligibleIssue;
                issues.push(ineligibleIssue);
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
      
      // Add Orca eligibility validation based on center tick array existence
      if (dex === 'orca') {
        const orcaCurrentTick = result.cacheData?.currentTick;
        const orcaTickSpacing = result.cacheData?.tickSpacing || 1;
        const centerArrayExists = result.tickArrayValidation?.center?.exists ?? false;
        
        // Calculate tick array index for tracking
        let tickArrayIndex: number | undefined;
        if (orcaCurrentTick !== undefined) {
          const ticksInArray = ORCA_TICK_ARRAY_SIZE * orcaTickSpacing;
          tickArrayIndex = Math.floor(orcaCurrentTick / ticksInArray);
        }
        
        const orcaEligibility: OrcaTickEligibility = {
          currentTick: orcaCurrentTick,
          tickSpacing: orcaTickSpacing,
          tickArrayIndex,
          centerArrayExists,
          isEligibleForTrading: centerArrayExists,
        };
        
        if (!centerArrayExists) {
          orcaEligibility.issue = 'Pool ineligible: center tick array does not exist on-chain';
          // Note: this issue is already added above in the tick array validation
        }
        
        result.orcaTickEligibility = orcaEligibility;
      }
    } else if (dex === 'meteora') {
      // ALWAYS fetch fresh bin data from chain first
      // This prevents using stale cached activeId that could lead to wrong bin arrays
      const freshResult = await fetchFreshBinDataAndValidate(connection, basePoolId);
      
      if (freshResult) {
        const { activeId, binStep, binArrays, validation, derivationValidation } = freshResult;
        
        result.cacheData = {
          activeId,
          binStep,
        };
        result.binArrayValidation = validation;
        result.derivationValidation = derivationValidation;
        
        // Log derivation validation results
        if (derivationValidation?.cacheWasStale) {
          logger.info('cache.validation.derivation.stale_detected', {
            cat: 'cache',
            ctx: {
              poolId: basePoolId.slice(0, 8) + '…',
              dex: 'meteora',
              activeIdDrift: derivationValidation.activeId?.drift,
              activeBinArrayIdxChanged: derivationValidation.activeId?.activeBinArrayIdxChanged,
              needsArrayRederivation: derivationValidation.needsArrayRederivation,
              cacheUpdated: derivationValidation.cacheUpdated,
            }
          });
        }
        
        // Check if at least one bin array exists
        const hasAnyBinArray = 
          validation?.lower?.exists || 
          validation?.upper?.exists || 
          validation?.active?.exists ||
          (binArrays?.arrays && binArrays.arrays.length > 0);
        
        if (hasAnyBinArray && binArrays) {
          // Successfully validated with fresh data - update all caches
          
          // Update hot cache with fresh activeId and arrays
          const existingHot = executionCache.getHot(basePoolId) || {};
          const activeBinArrayIdx = Math.floor(activeId / METEORA_BIN_ARRAY_SIZE);
          
          executionCache.setHot(basePoolId, {
            ...existingHot,
            activeId,
            binStep,
            binArrays: {
              lower: binArrays.lower,
              upper: binArrays.upper,
              active: binArrays.active,
              arrays: binArrays.arrays,
              range: binArrays.arrays.length > 0 ? {
                lower: Math.min(...binArrays.arrays.map(a => a.index)),
                upper: Math.max(...binArrays.arrays.map(a => a.index)),
              } : undefined,
            },
          });
          
          // Also update static cache for consistency
          const existingStat = executionCache.getStatic(basePoolId) || {};
          executionCache.setStatic(basePoolId, {
            ...existingStat,
            binStep,
            bin_array_lower: binArrays.lower,
            bin_array_upper: binArrays.upper,
          });
          
          logger.debug('cache.validation.fresh_bin_success', {
            cat: 'cache',
            ctx: {
              poolId: basePoolId.slice(0, 8),
              dex: 'meteora',
              activeId,
              binStep,
              activeBinArrayIdx,
              arrayCount: binArrays.arrays?.length || 0,
            }
          });
          
          // No issues - arrays are valid
        } else {
          // No bin arrays exist on-chain
          // STILL update the hot cache with fresh activeId, but clear invalid arrays
          logger.debug('cache.validation.bin_array_not_found', {
            cat: 'cache',
            ctx: {
              poolId: basePoolId.slice(0, 8),
              dex: 'meteora',
              freshActiveId: activeId,
              binStep,
              lowerExists: validation?.lower?.exists,
              upperExists: validation?.upper?.exists,
              activeExists: validation?.active?.exists,
            }
          });
          
          // Update hot cache with fresh activeId but ONLY include arrays that exist on-chain
          const existingHot = executionCache.getHot(basePoolId) || {};
          const validatedBinArrays: {
            lower?: string;
            upper?: string;
            active?: string;
            arrays?: any[];
          } = {};
          
          // Only include arrays that actually exist on-chain
          if (validation?.lower?.exists && binArrays?.lower) {
            validatedBinArrays.lower = binArrays.lower;
          }
          if (validation?.upper?.exists && binArrays?.upper) {
            validatedBinArrays.upper = binArrays.upper;
          }
          if (validation?.active?.exists && binArrays?.active) {
            validatedBinArrays.active = binArrays.active;
          }
          if (binArrays?.arrays && binArrays.arrays.length > 0) {
            // Filter to only existing arrays
            validatedBinArrays.arrays = binArrays.arrays.filter((a: any) => a.exists !== false);
          }
          
          executionCache.setHot(basePoolId, {
            ...existingHot,
            activeId,
            binStep,
            // Set binArrays to only contain existing arrays, or undefined if none exist
            binArrays: Object.keys(validatedBinArrays).length > 0 ? validatedBinArrays as any : undefined,
          });
          
          // Update static cache - clear arrays that don't exist
          const existingStat = executionCache.getStatic(basePoolId) || {};
          executionCache.setStatic(basePoolId, {
            ...existingStat,
            binStep,
            bin_array_lower: validation?.lower?.exists ? binArrays?.lower : undefined,
            bin_array_upper: validation?.upper?.exists ? binArrays?.upper : undefined,
          });
          
          logger.info('cache.validation.bin_array_cleared_stale', {
            cat: 'cache',
            ctx: {
              poolId: basePoolId.slice(0, 8),
              dex: 'meteora',
              freshActiveId: activeId,
              lowerExists: validation?.lower?.exists,
              upperExists: validation?.upper?.exists,
              activeExists: validation?.active?.exists,
            }
          });
          
          issues.push('No bin arrays exist on-chain (pool may have no liquidity)');
        }
      } else {
        // Couldn't fetch fresh pool data - fall back to cached data as last resort
        const cachedActiveId = hot?.activeId;
        const cachedBinStep = hot?.binStep || stat?.binStep;
        
        result.cacheData = {
          activeId: cachedActiveId,
          binStep: cachedBinStep,
        };
        
        issues.push('Failed to fetch fresh pool data from chain');
        
        // Attempt validation with cached data if available (better than nothing)
        if (hot?.binArrays) {
          const binArrays = hot.binArrays as any;
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
            
            for (let i = 0; i < keyMap.length; i++) {
              const { type, address } = keyMap[i];
              const info = infos[i];
              const exists = !!info && info.owner.equals(METEORA_DLMM_PROGRAM);
              validation[type] = { address, exists };
              
              if (!exists) {
                issues.push(`${type} bin array does not exist on-chain (using cached data)`);
              }
            }
            
            result.binArrayValidation = validation;
            
            // Warn that we're using potentially stale cached data
            issues.push('WARNING: Using cached bin data - arrays may be stale');
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
          
          // Calculate if activeId requires bitmap extension (bin array index outside ±512)
          const activeId = result.cacheData?.activeId ?? hot?.activeId;
          let activeIdRequiresBitmapExt = false;
          let binArrayIndex: number | undefined;
          const BITMAP_RANGE = 512; // Default bitmap covers indices -512 to +511
          
          if (activeId !== undefined && typeof activeId === 'number') {
            binArrayIndex = Math.floor(activeId / METEORA_BIN_ARRAY_SIZE);
            activeIdRequiresBitmapExt = binArrayIndex < -BITMAP_RANGE || binArrayIndex >= BITMAP_RANGE;
          }
          
          // Determine trading eligibility:
          // Pool is eligible if bitmap extension exists on-chain OR activeId doesn't require it
          const isEligibleForTrading = pdaExistsOnChain || !activeIdRequiresBitmapExt;
          
          const bitmapValidation: BitmapExtensionValidation = {
            cachedValue: cachedBitmapExt || null,
            derivedPda,
            pdaExistsOnChain,
            isUsingProgramIdFallback,
            isValid: false,
            activeIdRequiresBitmapExt,
            binArrayIndex,
            isEligibleForTrading,
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
          
          // Add issue if pool is not eligible for trading due to bitmap range
          if (!isEligibleForTrading) {
            const rangeIssue = `Pool at bin array index ${binArrayIndex} requires bitmap extension but none initialized - not tradeable`;
            if (!bitmapValidation.issue) {
              bitmapValidation.issue = rangeIssue;
            } else {
              bitmapValidation.issue += '; ' + rangeIssue;
            }
            issues.push(rangeIssue);
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
  
  // === Fee BPS Validation ===
  // Validate that fee_bps is present and non-zero
  // Zero fees are likely incorrect for Raydium/Meteora (fee is in separate account or nested structure)
  try {
    let feeBps: number | null = null;
    let feeSource: 'pool_cache' | 'execution_cache' | 'none' = 'none';
    
    // Check execution cache hot data first (most current)
    if (hot?.feeRate != null && Number.isFinite(hot.feeRate)) {
      feeBps = hot.feeRate;
      feeSource = 'execution_cache';
    }
    
    // Check pool caches if not found
    if (feeBps === null || feeBps === 0) {
      let poolCacheFee: number | undefined;
      if (dex === 'orca') {
        const orcaPools = peekOrcaPools();
        poolCacheFee = orcaPools?.clmm?.find(p => p.id === basePoolId)?.fee_bps;
      } else if (dex === 'raydium') {
        const raydiumPools = peekRaydiumPools();
        poolCacheFee = raydiumPools?.clmm?.find(p => p.id === basePoolId)?.fee_bps ?? 
                       raydiumPools?.amm?.find(p => p.id === basePoolId)?.fee_bps;
      } else if (dex === 'meteora') {
        const meteoraPools = peekMeteoraPools();
        poolCacheFee = meteoraPools?.clmm?.find(p => p.id === basePoolId)?.fee_bps;
      }
      
      if (poolCacheFee != null && Number.isFinite(poolCacheFee)) {
        feeBps = poolCacheFee;
        feeSource = 'pool_cache';
      }
    }
    
    const isZero = feeBps === 0;
    const isValid = feeBps !== null && Number.isFinite(feeBps) && feeBps > 0 && feeBps <= 10000;
    
    result.feeValidation = {
      feeBps,
      isValid,
      isZero,
      source: feeSource,
      issue: isZero ? 'Fee is 0 (likely incorrect for CLMM pools)' : 
             feeBps === null ? 'No fee found in cache' :
             !isValid ? `Invalid fee value: ${feeBps}` : undefined,
    };
    
    // Add fee info to cache data
    if (result.cacheData && feeBps !== null) {
      result.cacheData.feeBps = feeBps;
    }
    
    // Log warning for zero/missing fees (don't fail validation, just warn)
    if (isZero || feeBps === null) {
      logger.warn('cache.validation.fee_issue', {
        cat: 'cache',
        ctx: {
          poolId: basePoolId.slice(0, 8) + '…',
          dex,
          feeBps,
          source: feeSource,
          issue: result.feeValidation.issue,
        }
      });
    }
  } catch (e) {
    // Don't fail validation for fee check errors
    logCatchError('cacheValidator.feeValidation', e);
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
  let poolsIneligibleDueToBitmapRange = 0;  // Meteora - activeId outside ±512 bin array range
  let poolsWithInvalidExBitmap = 0;          // Raydium
  let poolsIneligibleDueToExBitmapRange = 0; // Raydium - tick outside ±512 array range with no exBitmap
  let poolsIneligibleDueToTickArray = 0;     // Orca - center tick array doesn't exist
  let poolsWithMissingAmmConfig = 0;         // Raydium - missing ammConfig
  let poolsWithZeroFee = 0;                  // Pools with 0 fee BPS
  let poolsWithMissingFee = 0;               // Pools with no fee in cache
  // Derivation validation stats
  let poolsWithStaleDerivedValues = 0;       // Pools where cached tick/activeId differed from chain
  let poolsWithDerivationUpdated = 0;        // Pools where cache was updated with fresh derivation values
  let poolsNeedingArrayRederivation = 0;     // Pools where tick/bin drift requires new arrays
  
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
        
        // Track pools ineligible due to bitmap range (Meteora only)
        if (result.bitmapExtensionValidation?.isEligibleForTrading === false) {
          poolsIneligibleDueToBitmapRange++;
        }
        
        // Track ex_bitmap issues (Raydium only)
        if (result.exBitmapValidation && !result.exBitmapValidation.isValid) {
          poolsWithInvalidExBitmap++;
        }
        
        // Track pools ineligible due to exBitmap range (Raydium only)
        if (result.exBitmapValidation?.isEligibleForTrading === false) {
          poolsIneligibleDueToExBitmapRange++;
        }
        
        // Track pools ineligible due to tick array (Orca only)
        if (result.orcaTickEligibility?.isEligibleForTrading === false) {
          poolsIneligibleDueToTickArray++;
        }
        
        // Track missing ammConfig (Raydium only)
        if (result.dex === 'raydium' && result.issues?.some(i => i.includes('ammConfig'))) {
          poolsWithMissingAmmConfig++;
        }
      }
      
      // Track fee issues (for all pools, not just invalid ones)
      if (result.feeValidation) {
        if (result.feeValidation.isZero) {
          poolsWithZeroFee++;
        } else if (result.feeValidation.feeBps === null) {
          poolsWithMissingFee++;
        }
      }
      
      // Track derivation validation stats (for all pools)
      if (result.derivationValidation) {
        if (result.derivationValidation.cacheWasStale) {
          poolsWithStaleDerivedValues++;
        }
        if (result.derivationValidation.cacheUpdated) {
          poolsWithDerivationUpdated++;
        }
        if (result.derivationValidation.needsArrayRederivation) {
          poolsNeedingArrayRederivation++;
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
      poolsIneligibleDueToBitmapRange,
      poolsWithInvalidExBitmap,
      poolsIneligibleDueToExBitmapRange,
      poolsIneligibleDueToTickArray,
      poolsWithMissingAmmConfig,
      poolsWithZeroFee,
      poolsWithMissingFee,
      // Derivation validation stats
      poolsWithStaleDerivedValues,
      poolsWithDerivationUpdated,
      poolsNeedingArrayRederivation,
      durationMs,
    }
  });
  
  // Update eligibility tracking state with validated data
  const eligibilityUpdate = updateEligibilityFromBatchValidation(results);
  
  logger.info('cache.validation.eligibility_synced', {
    cat: 'cache',
    dex,
    ...eligibilityUpdate,
  });
  
  // Update pool cache objects with validated tick/activeId data
  // This ensures snapshots save fresh data when persisted
  // ONLY include arrays that actually exist on-chain
  const poolCacheUpdates = results
    .filter(r => r.cacheData && (r.cacheData.currentTick !== undefined || r.cacheData.activeId !== undefined))
    .map(r => ({
      poolId: r.poolId,
      dex: r.dex,
      currentTick: r.cacheData?.currentTick,
      activeId: r.cacheData?.activeId,
      tickSpacing: r.cacheData?.tickSpacing,
      binStep: r.cacheData?.binStep,
      // ONLY include tick/bin arrays that exist on-chain (validated)
      tickArrayLower: r.tickArrayValidation?.lower?.exists ? r.tickArrayValidation.lower.address : undefined,
      tickArrayCenter: r.tickArrayValidation?.center?.exists ? r.tickArrayValidation.center.address : undefined,
      tickArrayUpper: r.tickArrayValidation?.upper?.exists ? r.tickArrayValidation.upper.address : undefined,
      binArrayLower: r.binArrayValidation?.lower?.exists ? r.binArrayValidation.lower.address : undefined,
      binArrayUpper: r.binArrayValidation?.upper?.exists ? r.binArrayValidation.upper.address : undefined,
    }));
  
  const poolCacheUpdate = updatePoolCacheFromValidation(poolCacheUpdates);
  
  logger.info('cache.validation.pool_cache_synced', {
    cat: 'cache',
    dex,
    ...poolCacheUpdate,
  });
  
  return {
    totalPools: results.length,
    validPools,
    invalidPools: results.length - validPools,
    poolsWithMissingCenter,
    poolsWithMissingArrays,
    poolsWithNoCacheEntry,
    poolsWithInvalidBitmapExtension,
    poolsIneligibleDueToBitmapRange,
    poolsWithInvalidExBitmap,
    poolsIneligibleDueToExBitmapRange,
    poolsIneligibleDueToTickArray,
    poolsWithMissingAmmConfig,
    poolsWithZeroFee,
    poolsWithMissingFee,
    // Derivation validation stats
    poolsWithStaleDerivedValues,
    poolsWithDerivationUpdated,
    poolsNeedingArrayRederivation,
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

// === DECIMAL VALIDATION FUNCTIONS ===

/**
 * Get pools for a specific DEX from cache
 */
function getPoolsForDex(dex: 'orca' | 'raydium' | 'meteora' | 'pumpswap' | 'meteora_balanced'): any[] {
  switch (dex) {
    case 'orca':
      return peekOrcaPools()?.clmm || [];
    case 'raydium': {
      const raydium = peekRaydiumPools();
      return [...(raydium?.clmm || []), ...(raydium?.amm || [])];
    }
    case 'meteora':
      return peekMeteoraPools()?.clmm || [];
    case 'pumpswap':
      return peekPumpswapPools()?.amm || [];
    case 'meteora_balanced':
      return peekMeteoraBalancedPools()?.amm || [];
    default:
      return [];
  }
}

/**
 * Validate and update decimals for a single pool
 * Handles was_swapped orientation correctly
 */
function validateAndUpdatePoolDecimals(
  pool: any,
  decimalMap: Map<string, number>,
  dex: 'orca' | 'raydium' | 'meteora' | 'pumpswap' | 'meteora_balanced',
  dryRun: boolean
): DecimalValidationResult {
  const issues: string[] = [];
  const result: DecimalValidationResult = {
    poolId: pool.id,
    dex,
    valid: false,
    issues,
    hadDecimalsA: Number.isFinite(pool.decimals_a),
    hadDecimalsB: Number.isFinite(pool.decimals_b),
    wasUpdated: false,
  };
  
  // Get mints in CANONICAL order (mint_a, mint_b)
  const mintA = pool.mint_a;
  const mintB = pool.mint_b;
  
  if (!mintA || !mintB) {
    issues.push('Missing mint_a or mint_b');
    return result;
  }
  
  // Get mints in NATIVE order (before swapping)
  const nativeMintA = pool.native_mint_a || mintA;
  const nativeMintB = pool.native_mint_b || mintB;
  const wasSwapped = pool.was_swapped === true;
  
  // Resolve decimals for canonical mints
  let decimalsA: number | undefined = pool.decimals_a;
  let decimalsB: number | undefined = pool.decimals_b;
  let sourceA: DecimalSource | undefined;
  let sourceB: DecimalSource | undefined;
  
  // If already have decimals in pool, use them
  if (Number.isFinite(decimalsA)) {
    sourceA = 'pool';
  } else {
    // Try to resolve from map using canonical mint
    const resolved = decimalMap.get(mintA);
    if (Number.isFinite(resolved)) {
      decimalsA = resolved;
      sourceA = 'jupiter';
    }
  }
  
  if (Number.isFinite(decimalsB)) {
    sourceB = 'pool';
  } else {
    const resolved = decimalMap.get(mintB);
    if (Number.isFinite(resolved)) {
      decimalsB = resolved;
      sourceB = 'jupiter';
    }
  }
  
  // Fallback: try native mints if canonical failed and they differ
  if (!Number.isFinite(decimalsA) && wasSwapped && nativeMintB && nativeMintB !== mintA) {
    // If swapped, canonical mintA came from native mintB
    const resolved = decimalMap.get(nativeMintB);
    if (Number.isFinite(resolved)) {
      decimalsA = resolved;
      sourceA = 'jupiter';
    }
  }
  
  if (!Number.isFinite(decimalsB) && wasSwapped && nativeMintA && nativeMintA !== mintB) {
    // If swapped, canonical mintB came from native mintA
    const resolved = decimalMap.get(nativeMintA);
    if (Number.isFinite(resolved)) {
      decimalsB = resolved;
      sourceB = 'jupiter';
    }
  }
  
  // Final fallback: use defaults based on common patterns
  if (!Number.isFinite(decimalsA)) {
    decimalsA = 9; // Default for unknown token A (often SOL or similar)
    sourceA = 'fallback';
    issues.push(`decimals_a fallback to 9 for mint ${mintA?.slice(0, 8)}…`);
  }
  
  if (!Number.isFinite(decimalsB)) {
    decimalsB = 6; // Default for unknown token B (often stablecoin)
    sourceB = 'fallback';
    issues.push(`decimals_b fallback to 6 for mint ${mintB?.slice(0, 8)}…`);
  }
  
  result.decimalsA = decimalsA;
  result.decimalsB = decimalsB;
  result.sourceA = sourceA;
  result.sourceB = sourceB;
  
  // Update pool if needed (unless dry run)
  const needsUpdate = !result.hadDecimalsA || !result.hadDecimalsB;
  if (needsUpdate && !dryRun) {
    // Update pool object
    pool.decimals_a = decimalsA;
    pool.decimals_b = decimalsB;
    
    // Also update native decimals if we have native mints
    if (pool.native_mint_a && pool.native_mint_b) {
      if (wasSwapped) {
        pool.native_decimals_a = decimalsB; // Swapped: native A = canonical B
        pool.native_decimals_b = decimalsA; // Swapped: native B = canonical A
      } else {
        pool.native_decimals_a = decimalsA;
        pool.native_decimals_b = decimalsB;
      }
    }
    
    // Update execution cache static entry
    const stat = executionCache.getStatic(pool.id);
    if (stat) {
      executionCache.setStatic(pool.id, {
        ...stat,
        decimals_a: decimalsA,
        decimals_b: decimalsB,
        native_decimals_a: wasSwapped ? decimalsB : decimalsA,
        native_decimals_b: wasSwapped ? decimalsA : decimalsB,
      });
    }
    
    result.wasUpdated = true;
    
    logger.debug('cache.decimals.pool_updated', {
      cat: 'cache',
      ctx: {
        poolId: pool.id,
        dex,
        decimalsA,
        decimalsB,
        sourceA,
        sourceB,
        wasSwapped,
      }
    });
  }
  
  // Valid only if we have real decimals (not fallback)
  result.valid = sourceA !== 'fallback' && sourceB !== 'fallback';
  
  return result;
}

/**
 * Validate and resolve decimals for all pools of a DEX
 * 
 * This function:
 * 1. Collects all unique mints from pools
 * 2. Batch resolves decimals from Jupiter/RPC
 * 3. Updates pools with missing decimals (respecting was_swapped orientation)
 * 4. Updates execution cache static entries
 */
export async function validateAndRefreshPoolDecimals(
  connection: Connection,
  dex: 'orca' | 'raydium' | 'meteora' | 'pumpswap' | 'meteora_balanced',
  options?: {
    dryRun?: boolean;
    limit?: number;
  }
): Promise<DecimalBatchValidationResult> {
  const startTime = Date.now();
  const dryRun = options?.dryRun ?? false;
  
  // Get pools from cache
  const allPools = getPoolsForDex(dex);
  const limit = options?.limit ?? allPools.length;
  const poolsToProcess = allPools.slice(0, limit);
  
  logger.info('cache.decimals.validation.start', {
    cat: 'cache',
    ctx: { 
      dex, 
      totalPools: allPools.length, 
      poolsToValidate: poolsToProcess.length, 
      limit: limit === allPools.length ? 'all' : limit,
      dryRun 
    }
  });
  
  // Collect unique mints
  const mintSet = new Set<string>();
  for (const pool of poolsToProcess) {
    if (pool.mint_a) mintSet.add(pool.mint_a);
    if (pool.mint_b) mintSet.add(pool.mint_b);
    if (pool.native_mint_a) mintSet.add(pool.native_mint_a);
    if (pool.native_mint_b) mintSet.add(pool.native_mint_b);
  }
  
  // Batch resolve all decimals upfront
  const mintArray = Array.from(mintSet);
  let decimalMap: Map<string, number>;
  
  try {
    decimalMap = await resolveManyDecimals(mintArray, { 
      normalizeMode: true,
      batchSize: 100,
    });
    
    logger.info('cache.decimals.batch_resolved', {
      cat: 'cache',
      ctx: {
        dex,
        uniqueMints: mintArray.length,
        resolved: decimalMap.size,
      }
    });
  } catch (e: any) {
    logger.warn('cache.decimals.batch_resolve_failed', {
      cat: 'cache',
      ctx: {
        dex,
        error: e.message,
      }
    });
    decimalMap = new Map();
  }
  
  const results: DecimalValidationResult[] = [];
  let poolsWithMissing = 0;
  let poolsUpdated = 0;
  let poolsStillMissing = 0;
  
  for (const pool of poolsToProcess) {
    const result = validateAndUpdatePoolDecimals(pool, decimalMap, dex, dryRun);
    results.push(result);
    
    if (!result.hadDecimalsA || !result.hadDecimalsB) {
      poolsWithMissing++;
    }
    if (result.wasUpdated) {
      poolsUpdated++;
    }
    if (!result.valid) {
      poolsStillMissing++;
    }
  }
  
  const durationMs = Date.now() - startTime;
  
  logger.info('cache.decimals.validation.complete', {
    cat: 'cache',
    ctx: {
      dex,
      totalPools: allPools.length,
      poolsValidated: poolsToProcess.length,
      poolsWithMissingDecimals: poolsWithMissing,
      poolsUpdated,
      poolsStillMissing,
      uniqueMintsResolved: decimalMap.size,
      durationMs,
      dryRun,
    }
  });
  
  return {
    dex,
    totalPools: allPools.length,
    poolsValidated: poolsToProcess.length,
    poolsWithMissingDecimals: poolsWithMissing,
    poolsUpdated,
    poolsStillMissing,
    uniqueMintsResolved: decimalMap.size,
    timestamp: Date.now(),
    durationMs,
    results,
  };
}

/**
 * Validate and refresh decimals for all DEXes
 */
export async function validateAndRefreshAllDecimals(
  connection: Connection,
  options?: {
    dryRun?: boolean;
    limit?: number;
  }
): Promise<{ 
  results: Record<string, DecimalBatchValidationResult>;
  totalDurationMs: number;
}> {
  const startTime = Date.now();
  const dexes: Array<'orca' | 'raydium' | 'meteora' | 'pumpswap' | 'meteora_balanced'> = [
    'orca', 'raydium', 'meteora', 'pumpswap', 'meteora_balanced'
  ];
  
  const results: Record<string, DecimalBatchValidationResult> = {};
  
  for (const dex of dexes) {
    try {
      results[dex] = await validateAndRefreshPoolDecimals(connection, dex, options);
    } catch (e: any) {
      logger.warn('cache.decimals.dex_failed', {
        cat: 'cache',
        ctx: { dex, error: e.message }
      });
    }
  }
  
  return {
    results,
    totalDurationMs: Date.now() - startTime,
  };
}

