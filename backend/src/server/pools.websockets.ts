import BN from 'bn.js';
import { Connection, PublicKey } from '@solana/web3.js';
import { createProgram } from '@meteora-ag/dlmm';
import { createHash } from 'crypto';
import { CONFIG } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { emit } from './realtime.js';
import { readJson } from '../utils/fs.js';
import { canonicalizePools } from './pools/canonical.js';
import type { AmmPool, ClmmPool, PoolsPayload } from './pools/types.js';
import { raydiumCache, orcaCache, meteoraCache, metbalCache, pumpswapCache, cpmmCache, vaultBalanceCache, findPoolInCache } from './pools.cache.js';
import { diffNormalizedPools, parseTokenAccountAmount, toB58Any } from './pools.utils.js';
import { executionCache } from '../execution/cache.js';
import { deriveOrcaFeeBps } from './pools/orca.js';
import { deriveRaydiumClmmCacheFields, deriveMeteoraBinArrayAddresses } from './pools.derivation.js';
import { anyToBigInt, ratioToDecimalString, sqrtPriceX64ToPriceRatio } from './pools/precision.js';
import { poolsMetrics, wsDecodeStats, wsDeltaStats, incrementSkipReason, wsDebugCounters, wsTargetDebugCounters } from './pools.metrics.js';
import { isValidPublicKey } from '../execution/builder/utils.js';

// Import modular decoders for WebSocket pool updates
// These decoders handle all DEX-specific account parsing and price pipeline processing
import {
  handleRaydiumUpdate,
  handleRaydiumCpmmUpdate,
  handleOrcaUpdate,
  handleMeteoraUpdate,
  handlePumpswapUpdate,
  handleMeteoraBalancedUpdate,
  isRaydiumOwner,
  isRaydiumCpmmOwner,
  isOrcaOwner,
  isMeteoraOwner,
  RAYDIUM_PROGRAMS,
  RAYDIUM_CPMM_PROGRAM_ID,
  ORCA_PROGRAM,
  METEORA_PROGRAM,
} from './pools/websockets/decoders/index.js';
import type { AccountInfo as DecoderAccountInfo, DerivedAccountInfo } from './pools/websockets/decoders/types.js';
// gRPC streaming support (Yellowstone/Shyft)
import { 
  startGrpcSubscriptions, 
  shutdownGrpcAdapter, 
  getGrpcStatus, 
  retargetGrpcSubscriptions,
  isGrpcConfigured 
} from './pools/grpc/index.js';
// Lazy activation support - clear state when retargeting in lazy mode
import { isLazyActivationEnabled, clearActivationState } from './pools.activation.js';
import { clearGraphCache } from './graph.js';

const METEORA_DEFAULT_PROGRAM_ID = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';
const METEORA_BIN_BITMAP_SIZE = 512;
const METEORA_BIN_ARRAY_SIZE = 70; // Bins per bin array
type MeteoraBinTracker = {
  indexes: Set<number>;
  accounts: Map<string, { id: number; index: number }>;
  binHashes: Map<string, string>;
  aggregate?: string;
};
const meteoraBinTrackers: Map<string, MeteoraBinTracker> = new Map();
const meteoraBinAccountToPool: Map<string, string> = new Map();
const derivedAccountToPool: Map<string, { 
  poolId: string; 
  accountType: 'vault' | 'reserve' | 'tick_array' | 'oracle' | 'observation';
  vaultSide?: 'A' | 'B';  // For AMM pools: which side of the pair
  otherVault?: string;    // For AMM pools: address of the other vault
}> = new Map();
const poolsWithDerivedAccounts: Set<string> = new Set();

// ============================================================================
// Pool Eligibility Tracking (Multi-DEX)
// ============================================================================
// Tracks pool eligibility based on tick/bin position and bitmap extension status.
// Pools may become ineligible if:
// - Meteora: activeId is outside ±512 bin array range and no bitmap extension
// - Raydium: currentTick is outside default range and no exBitmap extension
// - Orca: tick array for current tick doesn't exist (less common)

type DexType = 'meteora' | 'raydium' | 'orca';

interface PoolEligibilityState {
  dex: DexType;
  hasExtension: boolean;        // bitmap/exBitmap extension exists on-chain
  currentlyEligible: boolean;   // Can we trade this pool right now?
  lastTickOrBin?: number;       // Last known tick/activeId
  lastArrayIndex?: number;      // Last calculated array index
  tickSpacing?: number;         // For Raydium/Orca tick array calculation
}

// DEX-specific constants
const RAYDIUM_CLMM_PROGRAM_ID = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';
const ORCA_WHIRLPOOL_PROGRAM_ID = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
const RAYDIUM_TICK_ARRAY_SIZE = 60;
const ORCA_TICK_ARRAY_SIZE = 88;

// Bitmap/exBitmap extension ranges (default internal bitmap coverage)
// Beyond these ranges, the extension account is required
const EXTENSION_RANGE = 512;  // ±512 array indices for all DEXes

/** Pools being watched for eligibility changes */
const poolEligibility: Map<string, PoolEligibilityState> = new Map();

/** Callback for when any pool's eligibility changes */
let onPoolEligibilityChange: ((poolId: string, dex: DexType, eligible: boolean, arrayIndex: number) => void) | null = null;

/**
 * Register a callback for pool eligibility changes.
 * Called when a pool transitions between eligible/ineligible states.
 */
export function setOnPoolEligibilityChange(
  callback: (poolId: string, dex: DexType, eligible: boolean, arrayIndex: number) => void
): void {
  onPoolEligibilityChange = callback;
}

// Legacy alias for backward compatibility
export function setOnBitmapEligibilityChange(
  callback: (poolId: string, eligible: boolean, arrayIndex: number) => void
): void {
  onPoolEligibilityChange = (poolId, _dex, eligible, arrayIndex) => callback(poolId, eligible, arrayIndex);
}

/**
 * Calculate array index from tick/bin position
 */
function calculateArrayIndex(tickOrBin: number, dex: DexType, tickSpacing?: number): number {
  switch (dex) {
    case 'meteora':
      return Math.floor(tickOrBin / METEORA_BIN_ARRAY_SIZE);
    case 'raydium': {
      const spacing = tickSpacing || 1;
      const ticksInArray = RAYDIUM_TICK_ARRAY_SIZE * spacing;
      return Math.floor(tickOrBin / ticksInArray);
    }
    case 'orca': {
      const spacing = tickSpacing || 1;
      const ticksInArray = ORCA_TICK_ARRAY_SIZE * spacing;
      return Math.floor(tickOrBin / ticksInArray);
    }
    default:
      return 0;
  }
}

/**
 * Check if tick/bin position is in safe range (no extension required)
 */
function isInSafeRange(arrayIndex: number): boolean {
  return arrayIndex >= -EXTENSION_RANGE && arrayIndex < EXTENSION_RANGE;
}

/**
 * Register a pool for eligibility tracking.
 * Works for Meteora, Raydium, and Orca CLMM pools.
 * 
 * @param poolId - The pool's public key
 * @param dex - The DEX type
 * @param tickOrBin - Current tick (Raydium/Orca) or activeId (Meteora)
 * @param hasExtension - Whether bitmap/exBitmap extension exists on-chain
 * @param tickSpacing - Tick spacing for Raydium/Orca (not needed for Meteora)
 */
export function registerPoolForEligibilityWatch(
  poolId: string,
  dex: DexType,
  tickOrBin: number,
  hasExtension: boolean,
  tickSpacing?: number
): void {
  const arrayIndex = calculateArrayIndex(tickOrBin, dex, tickSpacing);
  const currentlyEligible = hasExtension || isInSafeRange(arrayIndex);
  
  poolEligibility.set(poolId, {
    dex,
    hasExtension,
    currentlyEligible,
    lastTickOrBin: tickOrBin,
    lastArrayIndex: arrayIndex,
    tickSpacing,
  });
  
  // Log initial state for pools without extension that are ineligible
  if (!hasExtension && !currentlyEligible) {
    logger.info(`${dex}.eligibility.pool_ineligible`, {
      poolId: poolId.slice(0, 8) + '…',
      tickOrBin,
      arrayIndex,
      reason: 'no_extension_and_out_of_range',
      cat: 'pools'
    });
  }
}

// Legacy Meteora-specific alias for backward compatibility
export function registerPoolForBitmapWatch(
  poolId: string, 
  activeId: number, 
  hasBitmapExtension: boolean
): void {
  registerPoolForEligibilityWatch(poolId, 'meteora', activeId, hasBitmapExtension);
}

/**
 * Bulk register Meteora pools for eligibility tracking.
 */
export function registerPoolsForBitmapWatch(
  pools: Array<{ id: string; active_id?: number; activeId?: number; bin_array_bitmap_extension?: string }>
): { registered: number; ineligible: number } {
  let registered = 0;
  let ineligible = 0;
  
  for (const pool of pools) {
    const activeId = pool.active_id ?? pool.activeId;
    if (activeId === undefined) continue;
    
    const bitmapExt = pool.bin_array_bitmap_extension;
    const hasBitmapExtension = !!bitmapExt && bitmapExt !== METEORA_DEFAULT_PROGRAM_ID;
    
    registerPoolForEligibilityWatch(pool.id, 'meteora', activeId, hasBitmapExtension);
    registered++;
    
    const state = poolEligibility.get(pool.id);
    if (state && !state.currentlyEligible) {
      ineligible++;
    }
  }
  
  logger.info('meteora.eligibility.bulk_register', {
    registered,
    ineligible,
    cat: 'pools'
  });
  
  return { registered, ineligible };
}

/**
 * Bulk register Raydium CLMM pools for eligibility tracking.
 */
export function registerRaydiumPoolsForEligibility(
  pools: Array<{ id: string; tick_current?: number; currentTick?: number; tick_spacing?: number; ex_bitmap?: string }>
): { registered: number; ineligible: number } {
  let registered = 0;
  let ineligible = 0;
  
  for (const pool of pools) {
    const currentTick = pool.tick_current ?? pool.currentTick;
    if (currentTick === undefined) continue;
    
    const exBitmap = pool.ex_bitmap;
    const hasExBitmap = !!exBitmap && exBitmap !== RAYDIUM_CLMM_PROGRAM_ID;
    const tickSpacing = pool.tick_spacing || 1;
    
    registerPoolForEligibilityWatch(pool.id, 'raydium', currentTick, hasExBitmap, tickSpacing);
    registered++;
    
    const state = poolEligibility.get(pool.id);
    if (state && !state.currentlyEligible) {
      ineligible++;
    }
  }
  
  logger.info('raydium.eligibility.bulk_register', {
    registered,
    ineligible,
    cat: 'pools'
  });
  
  return { registered, ineligible };
}

/**
 * Bulk register Orca Whirlpool pools for eligibility tracking.
 * Note: Orca doesn't have a bitmap extension, so hasExtension is based on
 * whether tick arrays exist. For simplicity, we assume they exist unless
 * explicitly told otherwise.
 */
export function registerOrcaPoolsForEligibility(
  pools: Array<{ id: string; tick_current?: number; currentTick?: number; tick_spacing?: number; hasTickArrays?: boolean }>
): { registered: number; ineligible: number } {
  let registered = 0;
  let ineligible = 0;
  
  for (const pool of pools) {
    const currentTick = pool.tick_current ?? pool.currentTick;
    if (currentTick === undefined) continue;
    
    // Orca doesn't have exBitmap - eligibility is based on tick array existence
    // For now, assume tick arrays exist (hasExtension = true equivalent)
    // This can be refined with actual tick array existence checks
    const hasTickArrays = pool.hasTickArrays !== false;
    const tickSpacing = pool.tick_spacing || 1;
    
    registerPoolForEligibilityWatch(pool.id, 'orca', currentTick, hasTickArrays, tickSpacing);
    registered++;
    
    const state = poolEligibility.get(pool.id);
    if (state && !state.currentlyEligible) {
      ineligible++;
    }
  }
  
  logger.info('orca.eligibility.bulk_register', {
    registered,
    ineligible,
    cat: 'pools'
  });
  
  return { registered, ineligible };
}

/**
 * Handle a tick/bin update for any DEX pool.
 * Checks if eligibility changed and triggers callback if so.
 * 
 * @param poolId - The pool's public key
 * @param newTickOrBin - New tick (Raydium/Orca) or activeId (Meteora)
 * @returns Object indicating if eligibility changed, or null if pool not tracked
 */
export function onPoolTickUpdate(
  poolId: string,
  newTickOrBin: number
): { changed: boolean; eligible: boolean; arrayIndex: number; dex: DexType } | null {
  const state = poolEligibility.get(poolId);
  if (!state) return null;
  
  // Pools with extension are always eligible
  if (state.hasExtension) {
    state.lastTickOrBin = newTickOrBin;
    const arrayIndex = calculateArrayIndex(newTickOrBin, state.dex, state.tickSpacing);
    state.lastArrayIndex = arrayIndex;
    return { changed: false, eligible: true, arrayIndex, dex: state.dex };
  }
  
  const arrayIndex = calculateArrayIndex(newTickOrBin, state.dex, state.tickSpacing);
  const nowEligible = isInSafeRange(arrayIndex);
  const changed = nowEligible !== state.currentlyEligible;
  
  // Update state
  state.lastTickOrBin = newTickOrBin;
  state.lastArrayIndex = arrayIndex;
  
  if (changed) {
    state.currentlyEligible = nowEligible;
    
    logger.info(`${state.dex}.eligibility.changed`, {
      poolId: poolId.slice(0, 8) + '…',
      tickOrBin: newTickOrBin,
      arrayIndex,
      eligible: nowEligible,
      previouslyEligible: !nowEligible,
      cat: 'pools'
    });
    
    // Trigger callback if registered
    if (onPoolEligibilityChange) {
      try {
        onPoolEligibilityChange(poolId, state.dex, nowEligible, arrayIndex);
      } catch (e) {
        logger.warn(`${state.dex}.eligibility.callback_error`, {
          poolId: poolId.slice(0, 8) + '…',
          error: String((e as any)?.message || e),
          cat: 'pools'
        });
      }
    }
  }
  
  return { changed, eligible: nowEligible, arrayIndex, dex: state.dex };
}

// Legacy Meteora-specific alias for backward compatibility
export function onMeteorActiveIdUpdate(
  poolId: string,
  newActiveId: number
): { changed: boolean; eligible: boolean; binArrayIndex: number } | null {
  const result = onPoolTickUpdate(poolId, newActiveId);
  if (!result) return null;
  return { changed: result.changed, eligible: result.eligible, binArrayIndex: result.arrayIndex };
}

/**
 * Check if a pool is currently eligible for trading.
 * Works for all DEX types.
 * 
 * @param poolId - The pool's public key
 * @returns true if eligible, false if not, undefined if not tracked
 */
export function isPoolEligible(poolId: string): boolean | undefined {
  const state = poolEligibility.get(poolId);
  if (!state) return undefined;
  return state.currentlyEligible;
}

// Legacy alias for backward compatibility
export function isPoolBitmapEligible(poolId: string): boolean | undefined {
  return isPoolEligible(poolId);
}

/**
 * Get the DEX type for a tracked pool
 */
export function getPoolDex(poolId: string): DexType | undefined {
  return poolEligibility.get(poolId)?.dex;
}

/**
 * Get eligibility stats for monitoring/debugging.
 * Returns stats broken down by DEX.
 */
export function getPoolEligibilityStats(): {
  total: number;
  byDex: Record<DexType, {
    tracked: number;
    withExtension: number;
    withoutExtension: number;
    eligible: number;
    ineligible: number;
  }>;
} {
  const stats: Record<DexType, {
    tracked: number;
    withExtension: number;
    withoutExtension: number;
    eligible: number;
    ineligible: number;
  }> = {
    meteora: { tracked: 0, withExtension: 0, withoutExtension: 0, eligible: 0, ineligible: 0 },
    raydium: { tracked: 0, withExtension: 0, withoutExtension: 0, eligible: 0, ineligible: 0 },
    orca: { tracked: 0, withExtension: 0, withoutExtension: 0, eligible: 0, ineligible: 0 },
  };
  
  for (const state of poolEligibility.values()) {
    const dexStats = stats[state.dex];
    dexStats.tracked++;
    
    if (state.hasExtension) {
      dexStats.withExtension++;
      dexStats.eligible++;
    } else {
      dexStats.withoutExtension++;
      if (state.currentlyEligible) {
        dexStats.eligible++;
      } else {
        dexStats.ineligible++;
      }
    }
  }
  
  return {
    total: poolEligibility.size,
    byDex: stats,
  };
}

// Legacy alias for backward compatibility
export function getBitmapEligibilityStats(): {
  tracked: number;
  withBitmapExtension: number;
  withoutBitmapExtension: number;
  currentlyEligible: number;
  currentlyIneligible: number;
} {
  const stats = getPoolEligibilityStats();
  const meteora = stats.byDex.meteora;
  return {
    tracked: meteora.tracked,
    withBitmapExtension: meteora.withExtension,
    withoutBitmapExtension: meteora.withoutExtension,
    currentlyEligible: meteora.eligible,
    currentlyIneligible: meteora.ineligible,
  };
}

/**
 * Clear all eligibility tracking (e.g., on pool refresh)
 */
export function clearPoolEligibilityTracking(): void {
  poolEligibility.clear();
}

// Legacy alias
export function clearBitmapEligibilityTracking(): void {
  clearPoolEligibilityTracking();
}

/**
 * Update pool eligibility state from cache validation results.
 * Call this after validatePoolCache to sync eligibility tracking with validated data.
 * 
 * @param poolId - The pool's public key
 * @param dex - The DEX type
 * @param validationResult - The eligibility data from validation
 * @returns Object indicating if state was updated and what changed
 */
export function updateEligibilityFromValidation(
  poolId: string,
  dex: DexType,
  validationResult: {
    tickOrBin?: number;
    tickSpacing?: number;
    hasExtension: boolean;
    isEligibleForTrading: boolean;
    arrayIndex?: number;
  }
): { updated: boolean; changed: boolean; previousEligible?: boolean } {
  const { tickOrBin, tickSpacing, hasExtension, isEligibleForTrading, arrayIndex } = validationResult;
  
  const existingState = poolEligibility.get(poolId);
  const previousEligible = existingState?.currentlyEligible;
  
  // Calculate array index if not provided
  const finalArrayIndex = arrayIndex ?? (tickOrBin !== undefined 
    ? calculateArrayIndex(tickOrBin, dex, tickSpacing) 
    : 0);
  
  // Update the state
  poolEligibility.set(poolId, {
    dex,
    hasExtension,
    currentlyEligible: isEligibleForTrading,
    lastTickOrBin: tickOrBin ?? existingState?.lastTickOrBin ?? 0,
    lastArrayIndex: finalArrayIndex,
    tickSpacing,
  });
  
  const changed = previousEligible !== undefined && previousEligible !== isEligibleForTrading;
  
  if (changed) {
    logger.info(`${dex}.eligibility.validation_updated`, {
      poolId: poolId.slice(0, 8) + '…',
      tickOrBin,
      arrayIndex: finalArrayIndex,
      eligible: isEligibleForTrading,
      previouslyEligible: previousEligible,
      hasExtension,
      cat: 'pools'
    });
    
    // Trigger callback if registered
    if (onPoolEligibilityChange) {
      try {
        onPoolEligibilityChange(poolId, dex, isEligibleForTrading, finalArrayIndex);
      } catch (e) {
        logger.warn(`${dex}.eligibility.validation_callback_error`, {
          poolId: poolId.slice(0, 8) + '…',
          error: String((e as any)?.message || e),
          cat: 'pools'
        });
      }
    }
  }
  
  return { updated: true, changed, previousEligible };
}

/**
 * Bulk update pool eligibility from batch validation results.
 * 
 * @param results - Array of validation results from validatePoolCacheBatch
 * @returns Summary of updates
 */
export function updateEligibilityFromBatchValidation(
  results: Array<{
    poolId: string;
    dex: 'orca' | 'raydium' | 'meteora';
    // Meteora
    bitmapExtensionValidation?: {
      pdaExistsOnChain: boolean;
      isEligibleForTrading?: boolean;
      binArrayIndex?: number;
    };
    // Raydium
    exBitmapValidation?: {
      pdaExistsOnChain: boolean;
      isEligibleForTrading?: boolean;
      tickArrayIndex?: number;
    };
    // Orca
    orcaTickEligibility?: {
      centerArrayExists: boolean;
      isEligibleForTrading: boolean;
      tickArrayIndex?: number;
    };
    cacheData?: {
      currentTick?: number;
      activeId?: number;
      tickSpacing?: number;
      binStep?: number;
    };
  }>
): { updated: number; changed: number; byDex: Record<DexType, { updated: number; changed: number }> } {
  let updated = 0;
  let changed = 0;
  const byDex: Record<DexType, { updated: number; changed: number }> = {
    meteora: { updated: 0, changed: 0 },
    raydium: { updated: 0, changed: 0 },
    orca: { updated: 0, changed: 0 },
  };
  
  for (const result of results) {
    const { poolId, dex, bitmapExtensionValidation, exBitmapValidation, orcaTickEligibility, cacheData } = result;
    
    let validationData: {
      tickOrBin?: number;
      tickSpacing?: number;
      hasExtension: boolean;
      isEligibleForTrading: boolean;
      arrayIndex?: number;
    } | null = null;
    
    if (dex === 'meteora' && bitmapExtensionValidation?.isEligibleForTrading !== undefined) {
      validationData = {
        tickOrBin: cacheData?.activeId,
        hasExtension: bitmapExtensionValidation.pdaExistsOnChain,
        isEligibleForTrading: bitmapExtensionValidation.isEligibleForTrading,
        arrayIndex: bitmapExtensionValidation.binArrayIndex,
      };
    } else if (dex === 'raydium' && exBitmapValidation?.isEligibleForTrading !== undefined) {
      validationData = {
        tickOrBin: cacheData?.currentTick,
        tickSpacing: cacheData?.tickSpacing,
        hasExtension: exBitmapValidation.pdaExistsOnChain,
        isEligibleForTrading: exBitmapValidation.isEligibleForTrading,
        arrayIndex: exBitmapValidation.tickArrayIndex,
      };
    } else if (dex === 'orca' && orcaTickEligibility) {
      validationData = {
        tickOrBin: cacheData?.currentTick,
        tickSpacing: cacheData?.tickSpacing,
        hasExtension: orcaTickEligibility.centerArrayExists,
        isEligibleForTrading: orcaTickEligibility.isEligibleForTrading,
        arrayIndex: orcaTickEligibility.tickArrayIndex,
      };
    }
    
    if (validationData) {
      const updateResult = updateEligibilityFromValidation(poolId, dex, validationData);
      if (updateResult.updated) {
        updated++;
        byDex[dex].updated++;
      }
      if (updateResult.changed) {
        changed++;
        byDex[dex].changed++;
      }
    }
  }
  
  logger.info('eligibility.batch_validation_update', {
    updated,
    changed,
    byDex,
    cat: 'pools'
  });
  
  return { updated, changed, byDex };
}

// ============================================================================
// End Pool Eligibility Tracking
// ============================================================================

export function isMeteoraBinArraySubscribed(address: string): boolean {
  return meteoraBinAccountToPool.has(address);
}

let wsAllowed: boolean = false;
let wsSetupActive: boolean = false;
let targetedWsActive: boolean = false;

// Flag to enable modular decoders - set via config or env
// When enabled, WebSocket updates are routed through the new modular decoder system
// which provides better separation of concerns and consistent price pipeline usage
// Default: true (modular decoders are now the primary implementation)
const useModularDecoders: boolean = Boolean((CONFIG.system as any)?.useModularWsDecoders ?? process.env.USE_MODULAR_WS_DECODERS ?? true);

type RefreshAllSourcesHandler = (force?: boolean, subscribe?: boolean, opts?: any) => Promise<{
  raydium: PoolsPayload;
  orca: PoolsPayload;
  meteora: PoolsPayload;
  meteora_balanced: PoolsPayload;
  pumpswap: PoolsPayload;
}>;

let refreshAllSourcesHandler: RefreshAllSourcesHandler | null = null;

export function setPoolRefreshHandler(handler: RefreshAllSourcesHandler): void {
  refreshAllSourcesHandler = handler;
}
let rayTimer: any | undefined;
let orcaTimer: any | undefined;
let meteoraTimer: any | undefined;
let wsUnsubscribe: (() => void) | undefined;
// Track current Connection instance and any pending close so new setups wait for a clean state
let wsConn: any | undefined;
let wsClosePromise: Promise<void> | null = null;
let healthTimer: any | undefined;
let lastWsEventMs: number = Date.now();
let wsHealthy: boolean = false;
let aggTimer: any | undefined;
const wsCounts: { raydium: number; 'raydium-cpmm'?: number; orca: number; meteora?: number; pumpswap?: number; meteora_balanced?: number } = { raydium: 0, 'raydium-cpmm': 0, orca: 0, meteora: 0, pumpswap: 0, meteora_balanced: 0 };
// wsDeltaStats, wsDecodeStats, incrementSkipReason, wsDebugCounters, and wsTargetDebugCounters
// are imported from ./pools.metrics.ts.
let meteoraProgramInstance: any | null = null;

// Validation counters for detailed failure tracking
const wsValidationStats: Record<'raydium' | 'orca' | 'meteora_dlmm' | 'meteora_damm_v1' | 'meteora_damm_v2' | 'pumpswap', { 
  missingMints: number; 
  invalidPrice: number; 
  invalidLiquidity: number;
  invalidFee: number;
  invalidTick: number;
  emptyMints: number;
}> = {
  raydium: { missingMints: 0, invalidPrice: 0, invalidLiquidity: 0, invalidFee: 0, invalidTick: 0, emptyMints: 0 },
  orca: { missingMints: 0, invalidPrice: 0, invalidLiquidity: 0, invalidFee: 0, invalidTick: 0, emptyMints: 0 },
  meteora_dlmm: { missingMints: 0, invalidPrice: 0, invalidLiquidity: 0, invalidFee: 0, invalidTick: 0, emptyMints: 0 },
  meteora_damm_v1: { missingMints: 0, invalidPrice: 0, invalidLiquidity: 0, invalidFee: 0, invalidTick: 0, emptyMints: 0 },
  meteora_damm_v2: { missingMints: 0, invalidPrice: 0, invalidLiquidity: 0, invalidFee: 0, invalidTick: 0, emptyMints: 0 },
  pumpswap: { missingMints: 0, invalidPrice: 0, invalidLiquidity: 0, invalidFee: 0, invalidTick: 0, emptyMints: 0 },
};

/**
 * Validates a decoded pool to ensure all critical fields are present and valid
 * Returns validation result with specific failure reasons for debugging
 */
function validateDecodedPool(
  dex: 'raydium' | 'orca' | 'meteora_dlmm' | 'meteora_damm_v1' | 'meteora_damm_v2' | 'pumpswap',
  pool: { mint_a?: string; mint_b?: string; price_a_per_b?: number; liquidity?: number; liquidity_base?: number; fee_bps?: number; tick_spacing?: number; sqrt_price_x64?: number },
  poolId: string
): { valid: boolean; reasons: string[] } {
  const reasons: string[] = [];
  
  // Validate mints
  if (!pool.mint_a || !pool.mint_b) {
    reasons.push('missing_mints');
    try { wsValidationStats[dex].missingMints += 1; } catch {}
  } else if (pool.mint_a.length === 0 || pool.mint_b.length === 0) {
    reasons.push('empty_mints');
    try { wsValidationStats[dex].emptyMints += 1; } catch {}
  } else if (pool.mint_a === pool.mint_b) {
    reasons.push('identical_mints');
    try { wsValidationStats[dex].missingMints += 1; } catch {}
  }
  
  // Validate price (for pools that should have it)
  if (pool.price_a_per_b != null) {
    if (!Number.isFinite(pool.price_a_per_b) || pool.price_a_per_b <= 0) {
      reasons.push('invalid_price');
      try { wsValidationStats[dex].invalidPrice += 1; } catch {}
    }
    // Sanity check: price should be within configurable bounds (default 1e-12 to 1e12)
    // Aligned with graph.edges.ts clamp values to handle micro-cap tokens with extreme prices
    const priceMin = Number(((CONFIG as any)?.sanity as any)?.priceClampMin) || 1e-12;
    const priceMax = Number(((CONFIG as any)?.sanity as any)?.priceClampMax) || 1e12;
    if (pool.price_a_per_b && (pool.price_a_per_b < priceMin || pool.price_a_per_b > priceMax)) {
      reasons.push('price_out_of_bounds');
      try { wsValidationStats[dex].invalidPrice += 1; } catch {}
    }
  }
  
  // Validate liquidity (different fields for AMM vs CLMM)
  const liq = pool.liquidity ?? pool.liquidity_base;
  if (liq != null) {
    if (!Number.isFinite(liq) || liq < 0) {
      reasons.push('invalid_liquidity');
      try { wsValidationStats[dex].invalidLiquidity += 1; } catch {}
    }
  }
  
  // Validate fee
  if (pool.fee_bps != null) {
    if (!Number.isFinite(pool.fee_bps) || pool.fee_bps < 0 || pool.fee_bps > 10000) {
      reasons.push('invalid_fee');
      try { wsValidationStats[dex].invalidFee += 1; } catch {}
    }
  }
  
  // Validate tick spacing for CLMM
  if (pool.tick_spacing != null) {
    if (!Number.isFinite(pool.tick_spacing) || pool.tick_spacing <= 0) {
      reasons.push('invalid_tick_spacing');
      try { wsValidationStats[dex].invalidTick += 1; } catch {}
    }
  }
  
  // Validate sqrt_price_x64 for CLMM (except Meteora DLMM which uses bin-based pricing)
  // Meteora DLMM doesn't store sqrt_price_x64; it calculates price from activeId/binStep
  if (pool.sqrt_price_x64 != null && dex !== 'meteora_dlmm') {
    if (!Number.isFinite(pool.sqrt_price_x64) || pool.sqrt_price_x64 <= 0) {
      reasons.push('invalid_sqrt_price');
      try { wsValidationStats[dex].invalidPrice += 1; } catch {}
    }
  }
  
  const valid = reasons.length === 0;
  
  // Log validation failures
  if (!valid && reasons.length > 0) {
    try {
      logger.warn(`${dex}.ws.validation.failed`, {
        poolId: poolId.slice(0, 8) + '…',
        reasons,
        mint_a: pool.mint_a?.slice(0, 8) + '…',
        mint_b: pool.mint_b?.slice(0, 8) + '…',
        price_a_per_b: pool.price_a_per_b,
        liquidity: pool.liquidity,
        liquidity_base: pool.liquidity_base,
        fee_bps: pool.fee_bps,
        tick_spacing: pool.tick_spacing,
        cat: 'pools'
      });
    } catch {}
  }
  
  return { valid, reasons };
}

function debugLogTargeted(source: 'raydium' | 'raydium-cpmm' | 'orca' | 'meteora' | 'meteora_balanced' | 'pumpswap', account: string, extra: Record<string, unknown>): void {
  try {
    const limit = Number((CONFIG.system as any)?.wsDebugAccountLogLimit ?? 10);
    if (!(limit > 0)) return;
    if (wsTargetDebugCounters[source] >= limit) return;
    wsTargetDebugCounters[source] += 1;
    logger.info('pools.ws debug.subscribe', { source, account, ...extra, cat: 'pools' });
  } catch {}
}

// Pre-populate vault balance cache for pumpswap pools before WebSocket subscriptions
// This prevents pool decode failures when pool events arrive before vault events
async function preloadPumpswapVaultCache(): Promise<void> {
  const pools = pumpswapCache.data?.amm || [];
  if (pools.length === 0) {
    try { logger.info('pumpswap.vault_cache.preload.skip', { reason: 'no_pools', cat: 'pools' }); } catch {}
    return;
  }
  
  const vaults: string[] = [];
  for (const pool of pools) {
    if ((pool as any).account_a) vaults.push((pool as any).account_a);
    if ((pool as any).account_b) vaults.push((pool as any).account_b);
  }
  
  if (vaults.length === 0) {
    try { logger.info('pumpswap.vault_cache.preload.skip', { reason: 'no_vaults', cat: 'pools' }); } catch {}
    return;
  }
  
  try {
    logger.info('pumpswap.vault_cache.preload.start', { vaultCount: vaults.length, cat: 'pools' });
    
    const web3 = await import('@solana/web3.js');
    const { withRpcLimit } = await import('../utils/rpcLimiter.js');
    const batchSize = 100;
    let cached = 0;
    let failed = 0;
    
    for (let i = 0; i < vaults.length; i += batchSize) {
      const batch = vaults.slice(i, i + batchSize);
      const pubkeys = batch.map(v => new web3.PublicKey(v));
      
      try {
        // Use RPC limiter for rate limiting (replaces simple delay)
        const weight = Math.max(1, Math.ceil(pubkeys.length / 100));
        const accounts = await withRpcLimit(
          () => wsConn.getMultipleAccountsInfo(pubkeys),
          weight,
          { module: 'pools', method: 'getMultipleAccountsInfo' }
        ) as Array<{ data: Buffer; executable: boolean; lamports: number; owner: any; rentEpoch?: number } | null>;
        
        for (let j = 0; j < accounts.length; j++) {
          const acc = accounts[j];
          const vaultAddr = batch[j];
          
          if (acc?.data && acc.data.length >= 72) {
            const amount = parseTokenAccountAmount(acc.data);
            if (amount !== null) {
              vaultBalanceCache.set(vaultAddr, amount);
              cached++;
            } else {
              failed++;
            }
          } else {
            failed++;
          }
        }
      } catch (e: any) {
        logger.warn('pumpswap.vault_cache.preload.batch_failed', { 
          batchIndex: Math.floor(i / batchSize),
          error: String(e?.message || e), 
          cat: 'pools' 
        });
        failed += batch.length;
      }
    }
    
    logger.info('pumpswap.vault_cache.preload.complete', { 
      cached, 
      failed,
      total: vaults.length,
      cat: 'pools' 
    });
  } catch (e: any) {
    logger.warn('pumpswap.vault_cache.preload.failed', { 
      error: String(e?.message || e), 
      cat: 'pools' 
    });
  }
}

// Pre-populate vault balance cache for meteora_balanced pools before WebSocket subscriptions
// This prevents pool decode failures when pool events arrive before vault events
async function preloadMeteoraBalancedVaultCache(): Promise<void> {
  const pools = metbalCache.data?.amm || [];
  if (pools.length === 0) {
    try { logger.debug('meteora_balanced.vault_cache.preload.skip', { reason: 'no_pools', cat: 'pools' }); } catch {}
    return;
  }
  
  const vaults: string[] = [];
  for (const pool of pools) {
    if ((pool as any).account_a) vaults.push((pool as any).account_a);
    if ((pool as any).account_b) vaults.push((pool as any).account_b);
  }
  
  if (vaults.length === 0) {
    try { logger.debug('meteora_balanced.vault_cache.preload.skip', { reason: 'no_vaults', cat: 'pools' }); } catch {}
    return;
  }
  
  try {
    logger.info('meteora_balanced.vault_cache.preload.start', { vaultCount: vaults.length, cat: 'pools' });
    
    const web3 = await import('@solana/web3.js');
    const { withRpcLimit } = await import('../utils/rpcLimiter.js');
    const batchSize = 100;
    let cached = 0;
    let failed = 0;
    
    for (let i = 0; i < vaults.length; i += batchSize) {
      const batch = vaults.slice(i, i + batchSize);
      const pubkeys = batch.map(v => new web3.PublicKey(v));
      
      try {
        // Use RPC limiter for rate limiting (replaces simple delay)
        const weight = Math.max(1, Math.ceil(pubkeys.length / 100));
        const accounts = await withRpcLimit(
          () => wsConn.getMultipleAccountsInfo(pubkeys),
          weight,
          { module: 'pools', method: 'getMultipleAccountsInfo' }
        ) as Array<{ data: Buffer; executable: boolean; lamports: number; owner: any; rentEpoch?: number } | null>;
        
        for (let j = 0; j < accounts.length; j++) {
          const acc = accounts[j];
          const vaultAddr = batch[j];
          
          if (acc?.data && acc.data.length >= 72) {
            const amount = parseTokenAccountAmount(acc.data);
            if (amount !== null) {
              vaultBalanceCache.set(vaultAddr, amount);
              cached++;
            } else {
              failed++;
            }
          } else {
            failed++;
          }
        }
      } catch (e: any) {
        logger.warn('meteora_balanced.vault_cache.preload.batch_failed', { 
          batchIndex: Math.floor(i / batchSize),
          error: String(e?.message || e), 
          cat: 'pools' 
        });
        failed += batch.length;
      }
    }
    
    logger.info('meteora_balanced.vault_cache.preload.complete', { 
      cached, 
      failed,
      total: vaults.length,
      cat: 'pools' 
    });
  } catch (e: any) {
    logger.warn('meteora_balanced.vault_cache.preload.failed', { 
      error: String(e?.message || e), 
      cat: 'pools' 
    });
  }
}

// Pre-populate vault balance cache for Raydium CPMM pools before WebSocket subscriptions
// This prevents pool decode failures when pool events arrive before vault events
async function preloadRaydiumCpmmVaultCache(): Promise<void> {
  const pools = cpmmCache.data?.cpmm || [];
  if (pools.length === 0) {
    try { logger.debug('raydium_cpmm.vault_cache.preload.skip', { reason: 'no_pools', cat: 'pools' }); } catch {}
    return;
  }
  
  const vaults: string[] = [];
  for (const pool of pools) {
    // CPMM pools use token0Vault/token1Vault or account_a/account_b
    const vaultA = (pool as any).token0Vault || (pool as any).vault_a || (pool as any).account_a;
    const vaultB = (pool as any).token1Vault || (pool as any).vault_b || (pool as any).account_b;
    if (vaultA) vaults.push(vaultA);
    if (vaultB) vaults.push(vaultB);
  }
  
  if (vaults.length === 0) {
    try { logger.debug('raydium_cpmm.vault_cache.preload.skip', { reason: 'no_vaults', cat: 'pools' }); } catch {}
    return;
  }
  
  try {
    logger.info('raydium_cpmm.vault_cache.preload.start', { vaultCount: vaults.length, poolCount: pools.length, cat: 'pools' });
    
    const web3 = await import('@solana/web3.js');
    const { withRpcLimit } = await import('../utils/rpcLimiter.js');
    const batchSize = 100;
    let cached = 0;
    let failed = 0;
    
    for (let i = 0; i < vaults.length; i += batchSize) {
      const batch = vaults.slice(i, i + batchSize);
      const pubkeys = batch.map(v => new web3.PublicKey(v));
      
      try {
        // Use RPC limiter for rate limiting
        const weight = Math.max(1, Math.ceil(pubkeys.length / 100));
        const accounts = await withRpcLimit(
          () => wsConn.getMultipleAccountsInfo(pubkeys),
          weight,
          { module: 'pools', method: 'getMultipleAccountsInfo' }
        ) as Array<{ data: Buffer; executable: boolean; lamports: number; owner: any; rentEpoch?: number } | null>;
        
        for (let j = 0; j < accounts.length; j++) {
          const acc = accounts[j];
          const vaultAddr = batch[j];
          
          if (acc?.data && acc.data.length >= 72) {
            const amount = parseTokenAccountAmount(acc.data);
            if (amount !== null) {
              vaultBalanceCache.set(vaultAddr, amount);
              cached++;
            } else {
              failed++;
            }
          } else {
            failed++;
          }
        }
      } catch (e: any) {
        logger.warn('raydium_cpmm.vault_cache.preload.batch_failed', { 
          batchIndex: Math.floor(i / batchSize),
          error: String(e?.message || e), 
          cat: 'pools' 
        });
        failed += batch.length;
      }
    }
    
    logger.info('raydium_cpmm.vault_cache.preload.complete', { 
      cached, 
      failed,
      total: vaults.length,
      cat: 'pools' 
    });
  } catch (e: any) {
    logger.warn('raydium_cpmm.vault_cache.preload.failed', { 
      error: String(e?.message || e), 
      cat: 'pools' 
    });
  }
}

// Batching queue for getAccountInfo calls during subscription setup
const accountInfoQueue: Map<string, { resolve: (info: any) => void; reject: (err: any) => void }[]> = new Map();
let accountInfoBatchTimer: NodeJS.Timeout | null = null;

async function batchGetAccountInfo(conn: any, address: string): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!accountInfoQueue.has(address)) {
      accountInfoQueue.set(address, []);
    }
    accountInfoQueue.get(address)!.push({ resolve, reject });
    
    // Schedule batch processing
    if (!accountInfoBatchTimer) {
      accountInfoBatchTimer = setTimeout(async () => {
        accountInfoBatchTimer = null;
        const addresses = Array.from(accountInfoQueue.keys());
        if (addresses.length === 0) return;
        
        try {
          const { withRpcLimit } = await import('../utils/rpcLimiter.js');
          const web3 = await import('@solana/web3.js');
          const pks = addresses.map(addr => new web3.PublicKey(addr));
          
          // Use getMultipleAccountsInfo for batch fetch
          const weight = Math.max(1, Math.ceil(addresses.length / 100));
          const infos = await withRpcLimit(
            () => conn.getMultipleAccountsInfo(pks, CONFIG.system.txCommitment as any),
            weight,
            { module: 'pools', method: 'getMultipleAccountsInfo' }
          );
          
          // Resolve all promises
          addresses.forEach((addr, idx) => {
            const waiters = accountInfoQueue.get(addr) || [];
            const info = infos[idx];
            waiters.forEach(w => w.resolve(info));
            accountInfoQueue.delete(addr);
          });
        } catch (err) {
          // Reject all on error
          addresses.forEach(addr => {
            const waiters = accountInfoQueue.get(addr) || [];
            waiters.forEach(w => w.reject(err));
            accountInfoQueue.delete(addr);
          });
        }
      }, 50); // 50ms batch window
    }
  });
}

let attachedOrcaPools: number = 0;
let attachedRaydiumPools: number = 0;
let attachedRaydiumCpmmPools: number = 0; // Subset of raydium that are CPMM
let attachedMeteoraPools: number = 0;
let attachedPumpswapPools: number = 0;
let attachedMeteoraBalancedPools: number = 0;

// When true, the next call to runWebsocketRefreshLoop will attach WS subscriptions
// without starting timers or triggering an extra initial HTTP warmup fetch.
let suppressInitialOnce: boolean = false;
export function startPoolWebsocketsOnlyOnce(): void {
  suppressInitialOnce = true;
  try { enablePoolWebsocketRefreshes(); } catch {}
  runWebsocketRefreshLoop();
}

export function getWsActivity(): {
  orca: { attached: number; events: number };
  raydium: { attached: number; events: number };
  raydium_amm_clmm: { events: number };
  raydium_cpmm: { events: number };
  meteora: { attached: number; events: number };
  pumpswap: { attached: number; events: number };
  meteora_balanced: { attached: number; events: number };
} {
  // Combine raydium AMM/CLMM and CPMM events for overall raydium health
  const raydiumAmmClmmEvents = wsCounts.raydium || 0;
  const raydiumCpmmEvents = wsCounts['raydium-cpmm'] || 0;
  const totalRaydiumEvents = raydiumAmmClmmEvents + raydiumCpmmEvents;
  
  return {
    orca: { attached: attachedOrcaPools, events: wsCounts.orca || 0 },
    raydium: { attached: attachedRaydiumPools, events: totalRaydiumEvents },
    raydium_amm_clmm: { events: raydiumAmmClmmEvents },
    raydium_cpmm: { events: raydiumCpmmEvents },
    meteora: { attached: attachedMeteoraPools, events: (wsCounts.meteora || 0) as number },
    pumpswap: { attached: attachedPumpswapPools, events: wsCounts.pumpswap || 0 },
    meteora_balanced: { attached: attachedMeteoraBalancedPools, events: wsCounts.meteora_balanced || 0 },
  };
}

// Compute target counts for WS subscriptions based on current graph edges per source
export async function getWsTargets(): Promise<{ orca: { target: number }; raydium: { target: number }; meteora: { target: number }; meteora_balanced: { target: number }; pumpswap: { target: number } }> {
  try {
    const { getGraphSnapshot } = await import('./graph.js');
    const snap = await getGraphSnapshot(false);
    const ray = new Set<string>();
    const orc = new Set<string>();
    const met = new Set<string>();
    const metBal = new Set<string>();
    const pump = new Set<string>();
    for (const e of (snap?.edges || [])) {
      const pid = String((e as any)?.pool_id || '');
      if (!pid) continue;
      const base = pid.replace(/[#-]rev$/, '');
      const dex = String((e as any)?.dex || '');
      if (dex === 'Raydium') ray.add(base);
      else if (dex === 'Orca') orc.add(base);
      else if (dex === 'Meteora') met.add(base);
      else if (dex.startsWith('MeteoraBalanced')) metBal.add(base);
      else if (dex === 'Pumpswap') pump.add(base);
    }
    const out = { orca: { target: orc.size }, raydium: { target: ray.size }, meteora: { target: met.size }, meteora_balanced: { target: metBal.size }, pumpswap: { target: pump.size } };
    try { (getWsTargets as any)._last = out; } catch {}
    return out;
  } catch {
    const out = { orca: { target: 0 }, raydium: { target: 0 }, meteora: { target: 0 }, meteora_balanced: { target: 0 }, pumpswap: { target: 0 } };
    try { (getWsTargets as any)._last = out; } catch {}
    return out;
  }
}

// Expose cache ages for observability (ms since last fetch)
export function getPoolCacheAges(): { raydium: number; orca: number; meteora: number; meteora_balanced: number; ttl: { raydium: number; orca: number; meteora: number; meteora_balanced: number } } {
  const now = Date.now();
  const rayTtl = Number((CONFIG as any)?.raydium?.cacheTtlMs || 300_000);
  const orcTtl = Number((CONFIG as any)?.orca?.cacheTtlMs || 300_000);
  const metTtl = Number(((CONFIG as any)?.meteora?.cacheTtlMs) || 300_000);
  const mblTtl = Number(((CONFIG as any)?.meteoraBalanced?.cacheTtlMs) || 300_000);
  const rayAge = raydiumCache.ts ? (now - raydiumCache.ts) : Number.POSITIVE_INFINITY;
  const orcAge = orcaCache.ts ? (now - orcaCache.ts) : Number.POSITIVE_INFINITY;
  const metAge = meteoraCache.ts ? (now - meteoraCache.ts) : Number.POSITIVE_INFINITY;
  const mblAge = metbalCache.ts ? (now - metbalCache.ts) : Number.POSITIVE_INFINITY;
  return { raydium: rayAge, orca: orcAge, meteora: metAge, meteora_balanced: mblAge, ttl: { raydium: rayTtl, orca: orcTtl, meteora: metTtl, meteora_balanced: mblTtl } };
}

// Retarget WS: unsubscribe and re-subscribe to current graph-derived targets
// Uses sequential subscription with throttling to avoid RPC burst
export async function retargetPoolWebsockets(): Promise<{ attached: { orca: number; raydium: number; raydium_cpmm: number; meteora: number; meteora_balanced: number; pumpswap: number } }> {
  const subscriptionMode = (CONFIG.system as any)?.poolSubscriptionMode || 'wss';
  
  // When lazy activation is enabled, clear the graph and activation state
  // This ensures we start fresh and only add pools as they receive updates
  if (isLazyActivationEnabled()) {
    logger.info('pools.ws.retarget.lazy_mode_reset', {
      message: 'Clearing graph and activation state for fresh lazy activation',
      cat: 'pools'
    });
    try {
      emit('log', {
        level: 'info',
        message: 'pools:ws retarget - clearing graph for lazy activation mode',
        timestamp: new Date().toISOString(),
        context: { cat: 'pools' }
      });
    } catch {}
    
    clearActivationState();
    clearGraphCache();
  }
  
  // For gRPC mode, use the gRPC retarget function
  if (subscriptionMode === 'grpc') {
    try {
      const success = await retargetGrpcSubscriptions();
      if (success) {
        const grpcStatus = getGrpcStatus();
        logger.info('pools.grpc.retarget.success', { 
          subscriptionCount: grpcStatus.subscriptionCount,
          cat: 'grpc' 
        });
        // Return placeholder counts - gRPC doesn't separate by DEX
        return { attached: { orca: 0, raydium: 0, raydium_cpmm: 0, meteora: 0, meteora_balanced: 0, pumpswap: 0 } };
      }
    } catch (err) {
      logger.error('pools.grpc.retarget.error', {
        error: String((err as Error)?.message || err),
        cat: 'grpc'
      });
    }
    // Fall through to WSS retarget as fallback
  }
  
  try { 
    emit('log', { 
      level: 'info', 
      message: 'pools:ws retarget.start - sequential resubscription with throttling', 
      timestamp: new Date().toISOString(), 
      context: { cat: 'pools' } 
    }); 
  } catch {}
  
  // Step 1: Unsubscribe all existing subscriptions
  try { disablePoolWebsocketRefreshes(); } catch {}
  
  // Step 2: Wait for websocket cleanup to complete before starting new subscriptions
  try { 
    if (wsClosePromise) { 
      await wsClosePromise.catch(() => {}); 
      wsClosePromise = null;
    } 
  } catch {}
  
  // Step 3: Cooldown period to let RPC limiter refill tokens after unsubscribe burst
  const cooldownMs = Number((CONFIG.system as any)?.wsRetargetCooldownMs || 2000);
  try { 
    logger.info('pools.ws retarget.cooldown', { ms: cooldownMs, cat: 'pools' });
    emit('log', { 
      level: 'info', 
      message: `pools:ws retarget.cooldown ${cooldownMs}ms`, 
      timestamp: new Date().toISOString(), 
      context: { cat: 'pools' } 
    }); 
  } catch {}
  await new Promise(r => setTimeout(r, cooldownMs));
  
  // Step 3.5: Wait for any active setup to complete before starting new one
  // This prevents race condition where old setup's cleanup is still running
  try {
    const maxWait = Number((CONFIG.system as any)?.wsSetupMaxWaitMs || 10000);
    const started = Date.now();
    let waited = false;
    while (wsSetupActive && (Date.now() - started) < maxWait) {
      if (!waited) {
        try { 
          logger.info('pools.ws retarget.waiting_for_setup_clear', { cat: 'pools' });
        } catch {}
        waited = true;
      }
      await new Promise(r => setTimeout(r, 100));
    }
    if (wsSetupActive) {
      try { 
        logger.warn('pools.ws retarget.setup_still_active', { 
          waitedMs: Date.now() - started, 
          maxWaitMs: maxWait,
          cat: 'pools' 
        }); 
      } catch {}
    } else if (waited) {
      try {
        logger.info('pools.ws retarget.setup_cleared', { 
          waitedMs: Date.now() - started,
          cat: 'pools' 
        });
      } catch {}
    }
  } catch {}
  
  // Step 4: Start resubscription in SEQUENTIAL mode (flag tells setup to stagger DEX sources)
  try { 
    // Set sequential mode flag before starting
    (startPoolWebsocketsOnlyOnce as any).__sequentialMode = true;
    startPoolWebsocketsOnlyOnce(); 
  } catch {}
  
  // Step 5: Give subscriptions time to attach with sequential throttling
  // With sequential mode, this takes longer: (cooldown + orca_time + stagger + raydium_time + stagger + meteora_time)
  // Estimate: 2s cooldown + 6s orca + 5s stagger + 8s raydium + 5s stagger + 4s meteora = ~30s
  const attachWaitMs = Number((CONFIG.system as any)?.wsRetargetAttachWaitMs || 15000);
  try { 
    logger.info('pools.ws retarget.waiting', { ms: attachWaitMs, reason: 'sequential attachment', cat: 'pools' });
    emit('log', { 
      level: 'info', 
      message: `pools:ws retarget.waiting ${attachWaitMs}ms for sequential attachment`, 
      timestamp: new Date().toISOString(), 
      context: { cat: 'pools' } 
    }); 
  } catch {}
  await new Promise(r => setTimeout(r, attachWaitMs));
  
  // Step 6: Check health and report results
  try {
    const st = getPoolWsStatus();
    const attached = { 
      orca: attachedOrcaPools, 
      raydium: attachedRaydiumPools, 
      raydium_cpmm: attachedRaydiumCpmmPools,
      meteora: attachedMeteoraPools, 
      meteora_balanced: attachedMeteoraBalancedPools, 
      pumpswap: attachedPumpswapPools 
    };
    if (!st.healthy) {
      try { 
        logger.warn('pools.ws retarget.unhealthy', { attached, cat: 'pools' });
        emit('log', { 
          level: 'warn', 
          message: 'pools:ws unhealthy after retarget', 
          timestamp: new Date().toISOString(), 
          context: { cat: 'pools', attached } 
        }); 
      } catch {}
    } else {
      try { 
        logger.info('pools.ws retarget.complete', { attached, cat: 'pools' });
        emit('log', { 
          level: 'info', 
          message: `pools:ws retarget.complete healthy=true`, 
          timestamp: new Date().toISOString(), 
          context: { cat: 'pools', attached } 
        }); 
      } catch {}
    }
  } catch {}
  
  return { attached: { orca: attachedOrcaPools, raydium: attachedRaydiumPools, raydium_cpmm: attachedRaydiumCpmmPools, meteora: attachedMeteoraPools, meteora_balanced: attachedMeteoraBalancedPools, pumpswap: attachedPumpswapPools } };
}

// Unified refresh orchestrator: fetch all sources and optionally (re)subscribe
// REFACTORED: Sequential operations with proper filtering stages
export interface RefreshSourcesOptions {
  force?: boolean;
  subscribe?: boolean;
  // Control which DEXes to fetch (defaults from config if not specified)
  sources?: {
    raydium?: boolean | { amm?: boolean; clmm?: boolean };
    orca?: boolean | { amm?: boolean; clmm?: boolean };
    meteora?: boolean;
    meteora_balanced?: boolean;
    pumpswap?: boolean;
  };
}
function runWebsocketRefreshLoop(): void {
  // Clear existing timers if any, to allow dynamic TTL updates
  if (rayTimer) { clearInterval(rayTimer); rayTimer = undefined; }
  if (orcaTimer) { clearInterval(orcaTimer); orcaTimer = undefined; }
  if (meteoraTimer) { clearInterval(meteoraTimer); meteoraTimer = undefined; }
  try { if (wsUnsubscribe) { wsUnsubscribe(); wsUnsubscribe = undefined; } } catch {}
  if (healthTimer) { clearInterval(healthTimer); healthTimer = undefined; }
  if (aggTimer) { clearInterval(aggTimer); aggTimer = undefined; }

  // Use unified cadence unless explicitly overridden per source
  const unified = Math.max(1000, Number((CONFIG.system as any)?.poolsRefreshMs || 60_000));
  const rayPeriod = unified;
  const orcaPeriod = unified;
  const meteoraPeriod = unified;

  const wsEnabled = !!(CONFIG.system as any)?.enablePoolWs;
  const subscriptionMode = (CONFIG.system as any)?.poolSubscriptionMode || 'wss';
  
  // Defer any activity until graph is ready
  if (!wsAllowed) { logger.info('pools.init deferred until graph ready'); return; }
  // Auto-start timers/WS when allowed by config and graph readiness

  // Check for gRPC mode - if enabled, use gRPC streaming instead of WSS
  if (subscriptionMode === 'grpc' && wsEnabled) {
    (async () => {
      try {
        if (!isGrpcConfigured()) {
          logger.warn('pools.grpc.not_configured', { 
            message: 'gRPC mode selected but endpoint/xToken not configured, falling back to WSS',
            cat: 'grpc' 
          });
          // Fall through to WSS mode below
        } else {
          const success = await startGrpcSubscriptions();
          if (success) {
            logger.info('pools.grpc.started', { mode: 'grpc', cat: 'grpc' });
            emit('log', {
              level: 'info',
              message: 'Pool subscriptions started via gRPC',
              timestamp: new Date().toISOString(),
              context: { cat: 'grpc' }
            });
            return; // Exit - gRPC is handling subscriptions
          } else {
            logger.warn('pools.grpc.start_failed', { 
              message: 'gRPC start failed, falling back to WSS',
              cat: 'grpc' 
            });
          }
        }
      } catch (err) {
        logger.error('pools.grpc.error', { 
          error: String((err as Error)?.message || err),
          cat: 'grpc' 
        });
      }
      // If gRPC fails, the WSS setup below will run as fallback
    })();
    // For gRPC mode, skip the initial HTTP refresh timer setup - gRPC handles updates
    // But still allow WSS to run as fallback if gRPC fails
  }

  // Handle disabled mode
  if (subscriptionMode === 'disabled') {
    logger.info('pools.subscriptions.disabled', { cat: 'pools' });
    // No subscriptions - only HTTP polling if wsEnabled is false
  }

    if (!wsEnabled && !suppressInitialOnce) {
    // Use unified refresh timer to ensure all filters (minPoolsPerPair, TVL, universe) are consistently applied
    rayTimer = setInterval(() => {
      try {
        logger.info('pools.refresh timer refreshAllSources', { cat: 'pools' });
        emit('log', { level: 'debug', message: 'pools:refresh timer unified (with filters)', timestamp: new Date().toISOString(), context: { cat: 'pools' } });
      } catch {}
      if (refreshAllSourcesHandler) {
        refreshAllSourcesHandler(true).catch(() => {});
      }
    }, rayPeriod);
    // Note: Individual DEX timers (orca, meteora) removed - refreshAllSources handles all sources with consistent filtering
  }
    // Proceed to initial fetch and optional WS

  // Kick immediately once activated so data is available without waiting
  // Kick immediately once, but respect min-force gap for subsequent calls
  if (!suppressInitialOnce) {
    // Only call refreshAllSources if it wasn't just called by subscribe flow
    // Check if a refresh happened in the last 5 seconds to prevent double refresh
    const lastRefresh = ((refreshAllSourcesHandler as any)?.__lastCallTime) || 0;
    const now = Date.now();
    if (now - lastRefresh > 5000) {
      if (refreshAllSourcesHandler) {
        (refreshAllSourcesHandler as any).__lastCallTime = now;
      }
      // Use refreshAllSources to ensure all filters (minPoolsPerPair, TVL, universe) are applied consistently
      // This respects DEX source control configuration internally
      try { 
        if (refreshAllSourcesHandler) {
          refreshAllSourcesHandler(true).catch(() => {}); 
        }
      } catch {}
    } else {
      try {
        logger.info('pools.refresh.initial.skipped', { 
          reason: 'recent_refresh', 
          lastRefreshMs: now - lastRefresh,
          cat: 'pools' 
        });
      } catch {}
    }
  }
  // Optional: subscribe to on-chain account changes to push updates into caches (auto-enabled)
  if (wsEnabled) {
    if (!wsAllowed) {
      logger.info('pools.ws deferred until graph ready');
      return;
    }
    try {
      const setup = async () => {
        if (wsSetupActive) { try { logger.info('pools.ws setup already active'); } catch {} return; }
        wsSetupActive = true;
        let web3: any = null;
        try { const mod = ['@solana/web3.js'].join(''); web3 = await import(mod as any); } catch {}
        if (!web3) { logger.warn('pools.ws disabled: @solana/web3.js not available'); return; }
        // If a previous unsubscribe initiated a websocket close, wait for it to finish before creating a new Connection
        try { if (wsClosePromise) { await wsClosePromise.catch(() => {}); } } catch {}
        wsClosePromise = null;
        const conn = new web3.Connection(CONFIG.rpcUrl, CONFIG.system.txCommitment as any);
        // Record connection so we can actively close its underlying WS on unsubscribe
        wsConn = conn;
        
        // Protect the RPC WebSocket from being called on closed sockets
        // This prevents web3.js's internal _updateSubscriptions from crashing
        try {
          const { protectRpcWebSocket } = await import('../drift/wsHelper.js');
          protectRpcWebSocket(conn, 'pools.setup');
        } catch (err) {
          try { 
            logger.warn('pools.ws failed to protect WebSocket', { 
              error: String(err), 
              cat: 'pools' 
            }); 
          } catch {}
        }
        
        const ensureMeteoraProgram = (): any | null => {
          if (meteoraProgramInstance) return meteoraProgramInstance;
          try {
            const idStr = String(((CONFIG as any)?.meteora?.programId) || METEORA_DEFAULT_PROGRAM_ID).trim();
            const programId = new web3.PublicKey(idStr);
            meteoraProgramInstance = createProgram(conn, { programId });
            try { logger.info('meteora.program.init', { programId: idStr, cat: 'pools' }); } catch {}
          } catch (err: any) {
            meteoraProgramInstance = null;
            try { logger.warn('meteora.program.init failed', { error: String(err?.message || err), cat: 'pools' }); } catch {}
          }
          return meteoraProgramInstance;
        };
        const rayAmm = new web3.PublicKey(String(CONFIG.raydium?.ammV4Program).trim());
        const rayClmm = new web3.PublicKey(String(CONFIG.raydium?.clmmProgram).trim());
        const rayCpmm = new web3.PublicKey(RAYDIUM_CPMM_PROGRAM_ID);
        const orcaProg = new web3.PublicKey(String(CONFIG.orca?.programId || 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc').trim());
        const subs: Array<{ kind: 'account' | 'program'; id: number }> = [];
        // Track explicit targets so we can classify events for SPL Token vault accounts (e.g., Raydium AMM vaults)
        const targetedSourceByAccount: Map<string, 'raydium' | 'raydium-cpmm' | 'orca' | 'meteora' | 'meteora_balanced' | 'pumpswap'> = new Map();
        // Debounce frequent program change bursts to at most one refresh per source per min gap
        const minGap = Number((CONFIG.system as any)?.poolRefreshMinGapMs || 3000);
        let lastRay = 0; let lastOrc = 0;
        let meteoraTargets = new Set<string>();
        // In lazy activation mode, use cache directly (graph is empty until pools activate)
        if (isLazyActivationEnabled()) {
          try {
            for (const p of (meteoraCache.data?.clmm || [])) {
              if (p?.id && isValidPublicKey(String(p.id))) {
                meteoraTargets.add(String(p.id));
              }
            }
            if (meteoraTargets.size > 0) {
              try { logger.info('pools.ws targets.meteora from cache (lazy mode)', { size: meteoraTargets.size }); } catch {}
            }
          } catch {}
        } else {
          try {
            const gmod: any = await import('./graph.js');
            // Use forced snapshot when retargeting (suppressInitialOnce) to ensure fresh data
            const snap = await gmod.getGraphSnapshot(suppressInitialOnce);
            const mset = new Set<string>();
            for (const e of (snap?.edges || [])) {
              const pid = String((e as any)?.pool_id || '');
              if (!pid) continue;
              const base = pid.replace(/[#-]rev$/, '');
              // Only add valid PublicKey addresses (filter out synthetic IDs like "mintA->mintB-Dex")
              if ((e as any)?.dex === 'Meteora' && isValidPublicKey(base)) {
                mset.add(base);
              }
            }
            meteoraTargets = mset;
            if (meteoraTargets.size > 0) {
              try { logger.info('pools.ws targets.meteora from graph', { size: meteoraTargets.size, forced: suppressInitialOnce }); } catch {}
            }
          } catch {}
        }

        const handle = async (pk: any, info: any) => {
          try {
            const beforeMs = lastWsEventMs;
            lastWsEventMs = Date.now();
            wsHealthy = true;
            
            const pk58 = toB58Any(pk);
            
            // Log at entry to track event routing
            try {
              logger.debug('pools.ws handle.entry', {
                account: pk58.slice(0,8) + '…',
                dataLength: info?.data?.length || 0,
                isDerived: derivedAccountToPool.has(pk58),
                isTargeted: targetedSourceByAccount.has(pk58),
                cat: 'pools'
              });
            } catch {}
            
            // Check if this is a derived account (vault, reserve, tick array, oracle)
            const derivedMeta = derivedAccountToPool.get(pk58);
            if (derivedMeta) {
              // CRITICAL FIX: Increment event counter for the parent DEX
              // Vault events need to be counted so they show up in aggregate logs
              // and keep the WebSocket health check alive
              const vaultSource = targetedSourceByAccount.get(pk58);
              if (vaultSource === 'pumpswap') {
                try { wsCounts.pumpswap = (wsCounts.pumpswap || 0) + 1; } catch {}
              } else if (vaultSource === 'meteora_balanced') {
                try { wsCounts.meteora_balanced = (wsCounts.meteora_balanced || 0) + 1; } catch {}
              } else if (vaultSource === 'raydium') {
                // Count raydium AMM vault events for health tracking
                try { wsCounts.raydium += 1; } catch {}
              } else if (vaultSource === 'raydium-cpmm') {
                try { wsCounts['raydium-cpmm'] = (wsCounts['raydium-cpmm'] || 0) + 1; } catch {}
              }
              
              // Process vault/reserve updates locally without RPC calls
              if (derivedMeta.accountType === 'vault' || derivedMeta.accountType === 'reserve') {
                try {
                  // Parse token account balance
                  const newBalance = parseTokenAccountAmount(info.data);
                  if (newBalance === null) {
                    logger.debug('pools.ws vault.parse.fail', { account: pk58.slice(0,8)+'…', cat: 'pools' });
                    return; // Can't parse, skip
                  }
                  
                  // CRITICAL: Cache the vault balance for instant pool price updates
                  // This eliminates RPC calls when pool events arrive
                  vaultBalanceCache.set(pk58, newBalance);
                  
                  try {
                    logger.debug('pools.ws vault.balance_cached', {
                      vault: pk58.slice(0,8)+'…',
                      balance: newBalance.toString(),
                      poolId: derivedMeta.poolId.slice(0,8)+'…',
                      cat: 'pools'
                    });
                  } catch {}
                  
                  // Find the pool in our caches
                  const poolData = findPoolInCache(derivedMeta.poolId);
                  if (!poolData) {
                    logger.debug('pools.ws vault.pool.not_found', { 
                      vault: pk58.slice(0,8)+'…', 
                      pool: derivedMeta.poolId.slice(0,8)+'…', 
                      cat: 'pools' 
                    });
                    return; // Pool not in cache yet, skip
                  }
                  
                  const { pool, source } = poolData;
                  
                  // For CLMM pools: vault changes don't directly change price
                  // The sqrt_price_x64 field determines price, not vault balances
                  // Vault changes only affect liquidity availability
                  // Just wait for the pool WebSocket update to deliver the actual price change
                  if (pool.pool_kind === 'clmm') {
                    logger.debug('pools.ws vault.clmm.skip', { 
                      vault: pk58.slice(0,8)+'…', 
                      pool: derivedMeta.poolId.slice(0,8)+'…',
                      reason: 'clmm_price_from_sqrtprice_not_vaults',
                      cat: 'pools' 
                    });
                    return; // CLMM: price isn't derived from vaults, skip
                  }
                  
                  // For AMM pools: compute price from vault balances
                  // Now that we track vault sides, we can calculate price when both are cached
                  const vaultSide = derivedMeta.vaultSide;
                  const otherVault = derivedMeta.otherVault;
                  
                  if (!vaultSide || !otherVault) {
                    // Legacy vault without side tracking - just cache and skip
                    logger.debug('pools.ws vault.amm.no_side', { 
                      vault: pk58.slice(0,8)+'…', 
                      pool: derivedMeta.poolId.slice(0,8)+'…',
                      cat: 'pools' 
                    });
                    return;
                  }
                  
                  // Get the other vault's cached balance
                  const otherBalance = vaultBalanceCache.get(otherVault);
                  if (otherBalance === undefined) {
                    // Other vault not yet cached - wait for it
                    logger.debug('pools.ws vault.amm.waiting_other', { 
                      vault: pk58.slice(0,8)+'…', 
                      pool: derivedMeta.poolId.slice(0,8)+'…',
                      side: vaultSide,
                      otherVault: otherVault.slice(0,8)+'…',
                      cat: 'pools' 
                    });
                    return;
                  }
                  
                  // We have both vault balances - calculate price!
                  // IMPORTANT: vaultSide A/B refers to native order (baseVault/quoteVault)
                  // If was_swapped is true, canonical order is reversed
                  const nativeBalanceA = vaultSide === 'A' ? newBalance : otherBalance;
                  const nativeBalanceB = vaultSide === 'B' ? newBalance : otherBalance;
                  
                  // Get pool's was_swapped flag and decimals
                  const ammPool = pool as any;
                  const wasSwapped = ammPool.was_swapped === true;
                  
                  // Map native balances to canonical order based on was_swapped
                  // Native: baseVault (A) → baseMint, quoteVault (B) → quoteMint
                  // If was_swapped: canonical mintA = quoteMint, canonical mintB = baseMint
                  const canonicalBalanceA = wasSwapped ? nativeBalanceB : nativeBalanceA;
                  const canonicalBalanceB = wasSwapped ? nativeBalanceA : nativeBalanceB;
                  
                  // Use canonical decimals (decimals_a/b are in canonical order)
                  // CRITICAL: If decimals_a/b are missing, fallback to native_decimals
                  // but RESPECT was_swapped flag - if swapped, canonical A = native B
                  const decA = ammPool.decimals_a ?? (wasSwapped ? ammPool.native_decimals_b : ammPool.native_decimals_a) ?? 9;
                  const decB = ammPool.decimals_b ?? (wasSwapped ? ammPool.native_decimals_a : ammPool.native_decimals_b) ?? 6;
                  
                  // Calculate price: price_a_per_b = "how many B for 1 A" = B/A
                  // Formula: (reserveB / reserveA) * 10^(decA - decB)
                  const reserveANum = Number(canonicalBalanceA);
                  const reserveBNum = Number(canonicalBalanceB);

                  if (reserveANum <= 0 || reserveBNum <= 0) {
                    logger.debug('pools.ws vault.amm.zero_reserve', {
                      vault: pk58.slice(0,8)+'…',
                      pool: derivedMeta.poolId.slice(0,8)+'…',
                      reserveA: reserveANum,
                      reserveB: reserveBNum,
                      wasSwapped,
                      cat: 'pools'
                    });
                    return;
                  }

                  const atomicRatio = reserveBNum / reserveANum;  // B/A ratio
                  const decimalAdjustment = Math.pow(10, decA - decB);
                  const price_a_per_b = atomicRatio * decimalAdjustment;
                  
                  if (!Number.isFinite(price_a_per_b) || price_a_per_b <= 0) {
                    logger.debug('pools.ws vault.amm.invalid_price', { 
                      vault: pk58.slice(0,8)+'…', 
                      pool: derivedMeta.poolId.slice(0,8)+'…',
                      price: price_a_per_b,
                      cat: 'pools' 
                    });
                    return;
                  }
                  
                  // Update pool in cache - handle both AMM and CPMM pools
                  const poolId = derivedMeta.poolId;
                  const isCpmm = (pool as any).pool_kind === 'cpmm' || source === 'raydium-cpmm';
                  
                  if (isCpmm) {
                    // CPMM pool: update cpmmCache
                    const cpmmPools = cpmmCache.data || { cpmm: [] };
                    const poolIdx = cpmmPools.cpmm.findIndex(p => p.id === poolId);
                    
                    if (poolIdx >= 0) {
                      const prevPool = cpmmPools.cpmm[poolIdx];
                      const hasDelta = prevPool.price_a_per_b !== price_a_per_b;
                      
                      // Update pool with new price and reserves (in canonical order)
                      cpmmPools.cpmm[poolIdx] = {
                        ...prevPool,
                        price_a_per_b,
                        reserve_a_raw: canonicalBalanceA.toString(),
                        reserve_b_raw: canonicalBalanceB.toString(),
                        updated_ms: Date.now(),
                      };
                      cpmmCache.ts = Date.now();
                      
                      // Increment event counter for cpmm
                      try { wsCounts['raydium-cpmm'] = (wsCounts['raydium-cpmm'] || 0) + 1; } catch {}
                      
                      logger.debug('pools.ws vault.cpmm.price_updated', { 
                        pool: poolId.slice(0,8)+'…',
                        price: price_a_per_b.toFixed(8),
                        reserveA: reserveANum,
                        reserveB: reserveBNum,
                        wasSwapped,
                        hasDelta,
                        cat: 'pools' 
                      });
                      
                      // Schedule graph update if price changed
                      if (hasDelta) {
                        try {
                          const gmod: any = await import('./graph.js');
                          if (typeof gmod?.applyPoolUpdates === 'function') {
                            const prev = { amm: [], clmm: [], cpmm: [prevPool] };
                            const next = { amm: [], clmm: [], cpmm: [cpmmPools.cpmm[poolIdx]] };
                            void gmod.applyPoolUpdates(prev, next, { pushToArb: false }).catch(() => {});
                          }
                        } catch {}
                        
                        // Track stats
                        try {
                          wsDeltaStats.raydium_cpmm.decoded += 1;
                          wsDeltaStats.raydium_cpmm.applied += 1;
                        } catch {}
                      }
                      
                      // Try to activate pool for lazy mode
                      try {
                        const { tryActivatePool } = await import('./pools.activation.js');
                        tryActivatePool(poolId, 'raydium-cpmm' as any, true);
                      } catch {}
                    }
                  } else {
                    // AMM pool: update raydiumCache.amm
                    const cachedPools = raydiumCache.data || { amm: [], clmm: [], cpmm: [] };
                    const poolIdx = cachedPools.amm.findIndex(p => p.id === poolId);
                    
                    if (poolIdx >= 0) {
                      const prevPool = cachedPools.amm[poolIdx];
                      const hasDelta = prevPool.price_a_per_b !== price_a_per_b;
                      
                      // Update pool with new price and reserves (in canonical order)
                      cachedPools.amm[poolIdx] = {
                        ...prevPool,
                        price_a_per_b,
                        reserve_a_raw: canonicalBalanceA.toString(),
                        reserve_b_raw: canonicalBalanceB.toString(),
                        updated_ms: Date.now(),
                      };
                      raydiumCache.ts = Date.now();
                      
                      // Increment event counter for raydium
                      try { wsCounts.raydium += 1; } catch {}
                      
                      logger.debug('pools.ws vault.amm.price_updated', { 
                        pool: poolId.slice(0,8)+'…',
                        price: price_a_per_b.toFixed(8),
                        reserveA: reserveANum,
                        reserveB: reserveBNum,
                        wasSwapped,
                        hasDelta,
                        cat: 'pools' 
                      });
                      
                      // Schedule graph update if price changed
                      if (hasDelta) {
                        try {
                          const gmod: any = await import('./graph.js');
                          if (typeof gmod?.applyPoolUpdates === 'function') {
                            const prev = { amm: [prevPool], clmm: [], cpmm: [] };
                            const next = { amm: [cachedPools.amm[poolIdx]], clmm: [], cpmm: [] };
                            void gmod.applyPoolUpdates(prev, next, { pushToArb: false }).catch(() => {});
                          }
                        } catch {}
                        
                        // Track stats
                        try {
                          wsDeltaStats.raydium_amm.decoded += 1;
                          wsDeltaStats.raydium_amm.applied += 1;
                        } catch {}
                      }
                      
                      // Try to activate pool for lazy mode
                      try {
                        const { tryActivatePool } = await import('./pools.activation.js');
                        tryActivatePool(poolId, 'raydium', true);
                      } catch {}
                    }
                  }
                  
                  return;
                  
                } catch (err) {
                  logger.debug('pools.ws vault.process.error', { 
                    vault: pk58.slice(0,8)+'…', 
                    error: String(err), 
                    cat: 'pools' 
                  });
                  return;
                }
              }
              
              // For tick arrays, oracle, observation accounts
              // These also don't directly determine price - the pool account does
              // Skip RPC fetch and let the pool's own WebSocket update handle it
              logger.debug('pools.ws derived.skip', { 
                account: pk58.slice(0,8)+'…', 
                accountType: derivedMeta.accountType,
                parentPool: derivedMeta.poolId.slice(0,8)+'…',
                reason: 'awaiting_pool_update',
                cat: 'pools' 
              });
              return;
            }
            
            // Lightweight classify: owner indicates which decoder to attempt
            const owner = toB58Any((info as any)?.owner);
            const ownerRayAmm = rayAmm.toBase58();
            const ownerRayClmm = rayClmm.toBase58();
            const ownerRayCpmm = rayCpmm.toBase58();
            const ownerOrca = orcaProg.toBase58();
            const ownerMeteora = String((CONFIG as any)?.meteora?.programId || '').trim();
            const isMeteoraTarget = meteoraTargets.has(pk58);
            const mapped = targetedSourceByAccount.get(pk58);
            
            // CRITICAL FIX: Reject SPL token accounts (vaults) from being decoded as pools
            // Vaults are owned by the Token Program, not DEX programs
            // This prevents vault addresses from being used as pool IDs in the graph
            const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
            if (owner === TOKEN_PROGRAM_ID) {
              try {
                logger.debug('pools.ws vault.rejected', {
                  account: pk58.slice(0,8)+'…',
                  reason: 'spl_token_account_cannot_be_pool',
                  owner: TOKEN_PROGRAM_ID,
                  cat: 'pools'
                });
              } catch {}
              return; // Skip SPL token accounts entirely
            }
            
            // Info log for pumpswap and meteora_balanced events to track idle timer
            if (mapped === 'pumpswap' || mapped === 'meteora_balanced') {
              const idleBeforeMs = Date.now() - beforeMs;
              try {
                logger.debug('pools.ws.event_received', {
                  source: mapped,
                  account: pk58.slice(0, 8) + '…',
                  idleBeforeMs,
                  owner: owner.slice(0, 8) + '…',
                  cat: 'pools'
                });
              } catch {}
            }
            
            try {
              const shortPk = pk ? `${toB58Any(pk).slice(0,6)}…` : '';
              const src = mapped || ((owner === ownerRayAmm || owner === ownerRayClmm) ? 'raydium' : (owner === ownerRayCpmm ? 'raydium-cpmm' : (owner === ownerOrca ? 'orca' : ((ownerMeteora && owner === ownerMeteora) || isMeteoraTarget ? 'meteora' : 'unknown'))));
              // Emit raw event snapshot (truncated) for audit
              const raw = {
                owner,
                lamports: Number(info?.lamports ?? 0),
                dataLen: Number(info?.data?.length ?? 0),
              };
              emit('log', { level: 'debug', message: `pools:ws event source=${src} acct=${shortPk}`, timestamp: new Date().toISOString(), context: { cat: 'pools', raw, source: src } });
            } catch {}
            const now = Date.now();
            // Debug account logging removed - use 'pools.ws aggregate' info logs for monitoring
            const maybeDebugAccount = (_source: 'raydium' | 'orca' | 'meteora') => {
              // No-op: debug account logs removed to respect log levels
            };
            
            // MODULAR DECODER ROUTING
            // When enabled, route account updates through the new modular decoder system
            // which provides consistent price pipeline usage and better separation of concerns
            if (useModularDecoders) {
              try {
                const accountInfo: DecoderAccountInfo = {
                  data: Buffer.isBuffer(info.data) ? info.data : Buffer.from(info.data ?? []),
                  executable: info.executable ?? false,
                  lamports: info.lamports ?? 0,
                  owner: info.owner,
                };
                
                // Route to appropriate decoder based on owner or mapped source
                if (owner === ownerRayAmm || owner === ownerRayClmm) {
                  wsCounts.raydium += 1;
                  await handleRaydiumUpdate(accountInfo, pk58, derivedAccountToPool);
                  return;
                } else if (owner === ownerRayCpmm) {
                  wsCounts['raydium-cpmm'] = (wsCounts['raydium-cpmm'] || 0) + 1;
                  await handleRaydiumCpmmUpdate(accountInfo, pk58, derivedAccountToPool);
                  return;
                } else if (owner === ownerOrca) {
                  wsCounts.orca += 1;
                  await handleOrcaUpdate(accountInfo, pk58, derivedAccountToPool, pk);
                  return;
                } else if ((ownerMeteora && owner === ownerMeteora) || isMeteoraTarget) {
                  wsCounts.meteora = (wsCounts.meteora || 0) + 1;
                  await handleMeteoraUpdate(accountInfo, pk58, derivedAccountToPool, pk);
                  return;
                } else if (mapped === 'pumpswap') {
                  wsCounts.pumpswap = (wsCounts.pumpswap || 0) + 1;
                  await handlePumpswapUpdate(accountInfo, pk58, derivedAccountToPool);
                  return;
                } else if (mapped === 'meteora_balanced') {
                  wsCounts.meteora_balanced = (wsCounts.meteora_balanced || 0) + 1;
                  await handleMeteoraBalancedUpdate(accountInfo, pk58, derivedAccountToPool);
                  return;
                }
                // Fall through to inline handlers for unknown sources
              } catch (modularErr: any) {
                logger.warn('pools.ws modular_decoder.error', {
                  account: pk58.slice(0, 8) + '…',
                  owner: owner.slice(0, 8) + '…',
                  error: String(modularErr?.message || modularErr),
                  cat: 'pools'
                });
                // Fall through to inline handlers as fallback
              }
            }
            
            // INLINE DECODER LOGIC (used when modular decoders are disabled or as fallback)
            if (owner === ownerRayAmm || owner === ownerRayClmm) {
              try { wsCounts.raydium += 1; } catch {}
              // Note: Attempts tracked per pool type in their respective sections
              const pk58 = toB58Any(pk);
              let updated = false;
              try {
                const rmod: any = await import('@raydium-io/raydium-sdk-v2').catch(() => null);
                if (!rmod || !info?.data) { throw new Error('raydium sdk missing'); }
                  // Try CLMM pool decode first
                  let state: any = null;
                const clmmLayout = (rmod as any)?.Clmm?.PoolStateLayout || (rmod as any)?.CLMM?.POOL_STATE_LAYOUT || (rmod as any)?.PoolStateLayout || (rmod as any)?.PoolInfoLayout;
                  maybeDebugAccount('raydium');
                  if (clmmLayout && typeof clmmLayout.decode === 'function') {
                    let clmmDecodeError: any = null;
                    try { state = clmmLayout.decode(info.data); } catch (err: any) { clmmDecodeError = err; state = null; }
                    if (!state && clmmDecodeError) {
                      try { logger.debug('raydium.ws clmm.decode.fail', { id: pk58, error: String(clmmDecodeError?.message || clmmDecodeError), dataLen: Number(info?.data?.length ?? 0), cat: 'pools' }); } catch {}
                    }
                    if (state) {
                      try {
                        logger.debug('raydium.ws state.inspect', {
                          id: pk58,
                          keys: Object.keys(state || {}),
                          liquidityType: typeof (state as any)?.liquidity,
                          cat: 'pools'
                        });
                      } catch {}
                    }
                    const hasLiquidityField = !!(state && (state as any)?.liquidity != null);
                    const hasMintFields = !!(state && ((state as any)?.mintA || (state as any)?.tokenMintA || (state as any)?.mint_a || (state as any)?.token_mint_a));
                    if (state && (!hasLiquidityField || !hasMintFields)) {
                      try { logger.debug('raydium.ws clmm.skip', { id: pk58, hasLiquidityField, hasMintFields, cat: 'pools' }); } catch {}
                    }
                    if (state && hasLiquidityField && hasMintFields) {
                      const mintA = ((state as any).mintA || (state as any).tokenMintA)?.toBase58?.() || '';
                      const mintB = ((state as any).mintB || (state as any).tokenMintB)?.toBase58?.() || '';
                      const sqrtRaw = anyToBigInt((state as any).sqrtPriceX64 ?? (state as any).sqrt_price_x64 ?? (state as any).sqrtPrice ?? 0);
                      
                      // FIX: Use price pipeline for consistent orientation handling (same as Meteora fix)
                      // Get decimals for the NATIVE mint order (not canonicalized cached order)
                      let processedPrice: any = undefined;
                      try {
                        let decA: number | undefined;
                        let decB: number | undefined;
                        
                        // CRITICAL FIX: Use native decimals from cache first (same pattern as AMM pools)
                        // The cache stores canonical (potentially swapped) decimals, but we need native decimals
                        // When a pool is swapped during canonicalization, decimals_a/b refer to the canonical mints,
                        // but mintA/mintB from chain state are always in native order
                        try {
                          const cachedRayPools = raydiumCache.data || { amm: [], clmm: [], cpmm: [] };
                          const existing = cachedRayPools.clmm.find(p => p.id === pk58);
                          // If native decimals are missing, derive from canonical + was_swapped
                          // When swapped: canonical A = native B, so native A decimals = canonical B decimals
                          const wasSwapped = existing?.was_swapped === true;
                          decA = existing?.native_decimals_a ?? (wasSwapped ? existing?.decimals_b : existing?.decimals_a);
                          decB = existing?.native_decimals_b ?? (wasSwapped ? existing?.decimals_a : existing?.decimals_b);
                          
                          // Fallback to execution cache if not in pool cache
                          if (!Number.isFinite(decA) || !Number.isFinite(decB)) {
                            try {
                              const { executionCache } = await import('../execution/cache.js');
                              const cached = executionCache.getStatic(pk58);
                              if (!decA && cached?.native_decimals_a) decA = cached.native_decimals_a;
                              if (!decA && cached?.decimals_a) decA = cached.decimals_a;
                              if (!decB && cached?.native_decimals_b) decB = cached.native_decimals_b;
                              if (!decB && cached?.decimals_b) decB = cached.decimals_b;
                            } catch {}
                          }
                          
                          // Only as last resort, resolve via centralized resolver
                          if (!Number.isFinite(decA) || !Number.isFinite(decB)) {
                            const { resolveDecimals } = await import('./pools/decimals.js');
                            if (!Number.isFinite(decA) && mintA) {
                              decA = await resolveDecimals(mintA);
                            }
                            if (!Number.isFinite(decB) && mintB) {
                              decB = await resolveDecimals(mintB);
                            }
                          }
                        } catch {
                          // Fallback to defaults
                          if (!Number.isFinite(decA)) decA = 9;
                          if (!Number.isFinite(decB)) decB = 6;
                        }
                        
                        if (Number.isFinite(decA) && Number.isFinite(decB) && sqrtRaw) {
                          const { processPriceThroughPipeline } = await import('./pools/pricePipeline.js');
                          processedPrice = processPriceThroughPipeline({
                            mintA,
                            mintB,
                            decimalsA: decA!,
                            decimalsB: decB!,
                            poolId: pk58,
                            dex: 'Raydium',
                            poolType: 'clmm',
                            sqrtPriceX64: sqrtRaw,
                          });
                          
                          if (!processedPrice) {
                            try {
                              logger.warn('raydium.ws.clmm.price.pipeline_failed', {
                                id: pk58,
                                mintA: mintA?.slice(0, 8),
                                mintB: mintB?.slice(0, 8),
                                cat: 'pools'
                              });
                            } catch {}
                          }
                        }
                      } catch (err: any) {
                        try {
                          logger.warn('raydium.ws.clmm.price.calc_failed', {
                            id: pk58,
                            error: String(err?.message || err),
                            cat: 'pools'
                          });
                        } catch {}
                      }
                      
                      if (processedPrice) {
                        const liqRaw = anyToBigInt((state as any).liquidity ?? 0);
                        const liq = Number((state as any).liquidity ?? 0);
                        const tick = Number((state as any).tickSpacing ?? (state as any).tick_spacing ?? 0);
                        // Skip adding to CLMM list if tickSpacing is invalid (must be > 0 for valid CLMM pools)
                        if (tick > 0) {
                        // CRITICAL: Raydium CLMM pools store fee in ammConfig account, not pool state.
                        // Fee values may be in PPM (parts per million) - need to convert to BPS.
                        // Fallback to cached fee_bps from HTTP fetch or execution cache.
                        let fee = Number((state as any).tradeFeeRate ?? (state as any).feeRate ?? (state as any).fee_rate ?? 0);
                        
                        // Convert from PPM to BPS if value appears to be in PPM format
                        if (Number.isFinite(fee) && fee > 10000) {
                          fee = Math.round(fee / 100);
                        }
                        
                        if (!Number.isFinite(fee) || fee <= 0) {
                          const cachedPools = raydiumCache.data;
                          const existingPool = cachedPools?.clmm?.find(p => p.id === pk58);
                          if (existingPool?.fee_bps && existingPool.fee_bps > 0) {
                            fee = existingPool.fee_bps;
                          } else {
                            try {
                              const hotData = executionCache.getHot(pk58);
                              if (hotData?.feeRate && hotData.feeRate > 0) {
                                fee = hotData.feeRate;
                              }
                            } catch {}
                          }
                        }
                        
                        // CRITICAL VALIDATION: Ensure this is actually a pool account, not a vault
                        // Pools must have valid mints, and the account address should NOT be in derivedAccountToPool
                        const isKnownDerivedAccount = derivedAccountToPool.has(pk58);
                        if (isKnownDerivedAccount) {
                          const derivedMeta = derivedAccountToPool.get(pk58);
                          try {
                            logger.warn('raydium.ws clmm.vault_as_pool.prevented', {
                              account: pk58.slice(0,8)+'…',
                              accountType: derivedMeta?.accountType,
                              parentPool: derivedMeta?.poolId?.slice(0,8)+'…',
                              reason: 'account_is_vault_not_pool',
                              cat: 'pools'
                            });
                          } catch {}
                          throw new Error('vault account cannot be decoded as pool');
                        }
                        
                        // Additional validation: Pools should have vault fields in their state
                        const hasVaultFields = !!(
                          (state as any)?.vaultA || (state as any)?.tokenVault0 || 
                          (state as any)?.vaultB || (state as any)?.tokenVault1
                        );
                        if (!hasVaultFields) {
                          try {
                            logger.debug('raydium.ws clmm.missing_vault_fields', {
                              account: pk58.slice(0,8)+'…',
                              reason: 'pool_must_have_vault_fields',
                              stateKeys: Object.keys(state || {}).slice(0, 20),
                              cat: 'pools'
                            });
                          } catch {}
                          // Don't throw here, as some SDK versions might use different field names
                        }
                        
                        // Use pipeline-processed result (already canonicalized)
                        const item: ClmmPool = {
                          id: pk58,
                          dex: 'Raydium',
                          mint_a: processedPrice.mintA,
                          mint_b: processedPrice.mintB,
                          fee_bps: fee,
                          sqrt_price_x64: Number.isFinite(Number(sqrtRaw)) ? Number(sqrtRaw) : Number((state as any).sqrtPriceX64 ?? (state as any).sqrt_price_x64 ?? (state as any).sqrtPrice ?? 0),
                          sqrt_price_x64_raw: sqrtRaw ? sqrtRaw.toString() : undefined,
                          liquidity: Number.isFinite(liq) ? liq : 0,
                          liquidity_raw: liqRaw ? liqRaw.toString() : undefined,
                          'tick_spacing': tick,
                          updated_ms: Date.now(),
                          pool_kind: 'clmm',
                          liquidity_display: liq,
                          price_a_per_b: processedPrice.priceForward,
                          decimals_a: processedPrice.decimalsA,
                          decimals_b: processedPrice.decimalsB,
                          was_swapped: processedPrice.wasSwapped,
                          native_mint_a: mintA,
                          native_mint_b: mintB,
                          _pipelineProcessed: true,
                        } as any;
                        
                        // Validate decoded pool before applying
                        const validation = validateDecodedPool('raydium', item, pk58);
                        if (!validation.valid) {
                          try { wsDecodeStats.raydium_clmm.failures += 1; } catch {}
                          incrementSkipReason('raydium_clmm', `validation_failed:${validation.reasons.join(',')}`);
                          try { logger.warn('raydium.ws clmm.validation.failed', { id: pk58, reasons: validation.reasons, cat: 'pools' }); } catch {}
                          updated = true; // Mark as processed to avoid further handling
                          throw new Error(`validation failed: ${validation.reasons.join(',')}`); // Skip this update
                        }
                        
                        // Track CLMM attempt
                        try { wsDecodeStats.raydium_clmm.attempts += 1; } catch {}
                        
                        // Pipeline already canonicalized, use item directly
                        const finalItem = item;
                        
                        const prev = raydiumCache.data || { amm: [], clmm: [], cpmm: [] };
                        const next: PoolsPayload = { amm: prev.amm.slice(), clmm: prev.clmm.slice(), cpmm: prev.cpmm?.slice() || [] };
                        const idx = next.clmm.findIndex(p => p.id === finalItem.id);
                        
                        // CRITICAL FIX: Handle orientation changes correctly
                        // When canonicalization changes orientation, preserve orientation-independent fields
                        if (idx >= 0) {
                          const prevPool = next.clmm[idx];
                          const orientationChanged = prevPool.mint_a !== finalItem.mint_a || prevPool.mint_b !== finalItem.mint_b;
                          if (orientationChanged) {
                            // Orientation changed - start with canonicalized item (all A/B fields correctly swapped)
                            // Then preserve orientation-independent fields from previous pool
                            const orientationIndependentFields = {
                              tvl_usd: prevPool.tvl_usd,
                              liquidity_display: prevPool.liquidity_display,
                              pool_liquidity_raw: prevPool.pool_liquidity_raw,
                              // Preserve any other fields that don't depend on orientation
                            };
                            next.clmm[idx] = { ...finalItem, ...orientationIndependentFields };
                          } else {
                            // Same orientation - safe to merge (preserves fields not in finalItem)
                            next.clmm[idx] = { ...next.clmm[idx], ...finalItem };
                          }
                        } else {
                          next.clmm.push(finalItem);
                        }
                        
                        // OPTIMIZATION: Store raw account data + derived tick arrays in execution cache for builders
                        try {
                          const { executionCache } = await import('../execution/cache.js');
                          const rawBuffer = Buffer.isBuffer(info.data) ? Buffer.from(info.data) : Buffer.from(info.data ?? []);
                          const existing = executionCache.getStatic(pk58) || {} as any;
                          const derived = await deriveRaydiumClmmCacheFields(pk58, rawBuffer, { programId: owner?.toString?.() });
                          // Derive native decimals from canonical decimals based on swap status
                          const nativeDecA = processedPrice.wasSwapped ? processedPrice.decimalsB : processedPrice.decimalsA;
                          const nativeDecB = processedPrice.wasSwapped ? processedPrice.decimalsA : processedPrice.decimalsB;
                          
                          const nextStatic: any = {
                            ...existing,
                            rawAccountData: rawBuffer,
                            rawAccountDataUpdatedMs: Date.now(),
                            // CRITICAL FIX: Store CANONICALIZED mint/decimal order (from processedPrice)
                            // This ensures execution cache matches pool cache orientation
                            mint_a: processedPrice.mintA,
                            mint_b: processedPrice.mintB,
                            decimals_a: processedPrice.decimalsA,
                            decimals_b: processedPrice.decimalsB,
                            // CRITICAL: Store native (on-chain) mint orientation for SDK compatibility
                            // The Raydium SDK expects native ordering for swap instructions
                            native_mint_a: mintA,
                            native_mint_b: mintB,
                            native_decimals_a: nativeDecA,
                            native_decimals_b: nativeDecB,
                          };
                          if (derived) {
                            if (derived.programId) nextStatic.programId = derived.programId;
                            if (derived.oracle) nextStatic.oracle = derived.oracle;
                            if (derived.observationState) nextStatic.observation_state = derived.observationState;
                            if (derived.ammConfig) (nextStatic as any).amm_config = derived.ammConfig;
                            // Store vault accounts in CANONICAL order (matching mint_a/mint_b)
                            // If pool was swapped, these need to be swapped too
                            if (derived.vaultA && derived.vaultB) {
                              if (processedPrice.wasSwapped) {
                                nextStatic.account_a = derived.vaultB;
                                nextStatic.account_b = derived.vaultA;
                              } else {
                                nextStatic.account_a = derived.vaultA;
                                nextStatic.account_b = derived.vaultB;
                              }
                              // Preserve native orientation for reference
                              nextStatic.native_account_a = derived.vaultA;
                              nextStatic.native_account_b = derived.vaultB;
                            }
                            if (derived.tickSpacing) nextStatic.tick_spacing = derived.tickSpacing;
                            // Handle both single values and arrays for backward compatibility
                            if (derived.tickArrays?.lower) {
                              nextStatic.tickArrayLower = typeof derived.tickArrays.lower === 'string' 
                                ? derived.tickArrays.lower 
                                : (Array.isArray(derived.tickArrays.lower) && derived.tickArrays.lower.length > 0 
                                  ? derived.tickArrays.lower[0] 
                                  : undefined);
                            }
                            if (derived.tickArrays?.center) nextStatic.tickArrayCenter = derived.tickArrays.center;
                            if (derived.tickArrays?.upper) {
                              nextStatic.tickArrayUpper = typeof derived.tickArrays.upper === 'string' 
                                ? derived.tickArrays.upper 
                                : (Array.isArray(derived.tickArrays.upper) && derived.tickArrays.upper.length > 0 
                                  ? derived.tickArrays.upper[0] 
                                  : undefined);
                            }
                          }
                          executionCache.setStatic(pk58, nextStatic);
                          if (derived?.tickArrays || derived?.tickCurrent !== undefined) {
                            const hotExisting = executionCache.getHot(pk58) || {};
                            executionCache.setHot(pk58, {
                              ...hotExisting,
                              currentTickIndex: derived?.tickCurrent ?? hotExisting.currentTickIndex,
                              // Include tickSpacing for boundary crossing detection in cache
                              tickSpacing: derived?.tickSpacing ?? hotExisting.tickSpacing,
                              tickArrays: {
                                ...(hotExisting?.tickArrays || {}),
                                ...(derived?.tickArrays || {}),
                              },
                            });
                            
                            // Sync tick arrays to pool cache if we have tick data
                            try {
                              const { updatePoolCacheFromValidation } = await import('./pools.cache.js');
                              const tickArrayLower = typeof derived.tickArrays?.lower === 'string' 
                                ? derived.tickArrays.lower 
                                : (Array.isArray(derived.tickArrays?.lower) && derived.tickArrays.lower.length > 0 
                                  ? derived.tickArrays.lower[0] 
                                  : undefined);
                              const tickArrayUpper = typeof derived.tickArrays?.upper === 'string' 
                                ? derived.tickArrays.upper 
                                : (Array.isArray(derived.tickArrays?.upper) && derived.tickArrays.upper.length > 0 
                                  ? derived.tickArrays.upper[0] 
                                  : undefined);
                              updatePoolCacheFromValidation([{
                                poolId: pk58,
                                dex: 'raydium',
                                currentTick: derived?.tickCurrent,
                                tickSpacing: derived?.tickSpacing,
                                tickArrayLower,
                                tickArrayCenter: derived.tickArrays?.center,
                                tickArrayUpper,
                              }]);
                            } catch (syncErr) {
                              logger.debug('raydium.ws.pool_cache_sync_failed', {
                                pool: pk58.slice(0, 8) + '…',
                                error: String((syncErr as any)?.message || syncErr),
                                cat: 'pools'
                              });
                            }
                          }
                        } catch (cacheErr) {
                          try { logger.debug('raydium.ws.cache_update_failed', { pool: pk58.slice(0, 8) + '…', error: String((cacheErr as any)?.message || cacheErr) }); } catch {}
                        }
                        
                        try { wsDecodeStats.raydium_clmm.successes += 1; } catch {}
                        wsDeltaStats.raydium_clmm.decoded += 1;
                        const d = diffNormalizedPools(prev, next);
                        raydiumCache.data = next; raydiumCache.ts = Date.now();
                        
                        const hasDelta = (d.amm.length || d.clmm.length || d.addedAmm || d.removedAmm || d.addedClmm || d.removedClmm);
                        if (hasDelta) { 
                          wsDeltaStats.raydium_clmm.applied += 1; 
                        } else { 
                          wsDeltaStats.raydium_clmm.skipped += 1;
                          // Diagnose why no delta detected
                          const prevPool = prev.clmm.find(p => p.id === item.id);
                          if (prevPool) {
                            const reasons: string[] = [];
                            if ((prevPool as any).sqrt_price_x64_raw === (item as any).sqrt_price_x64_raw) reasons.push('sqrt_price_unchanged');
                            if ((prevPool as any).liquidity_raw === (item as any).liquidity_raw) reasons.push('liquidity_raw_unchanged');
                            if (Math.abs((prevPool.liquidity || 0) - (item.liquidity || 0)) === 0) reasons.push('liquidity_unchanged');
                            if (Math.abs((prevPool.price_a_per_b || 0) - (item.price_a_per_b || 0)) <= 1e-9) reasons.push('price_unchanged');
                            if ((prevPool as any).price_a_per_b_num === (item as any).price_a_per_b_num && (prevPool as any).price_a_per_b_den === (item as any).price_a_per_b_den) reasons.push('ratio_unchanged');
                            incrementSkipReason('raydium_clmm', reasons.length > 0 ? reasons.join('+') : 'no_delta_detected');
                          } else {
                            incrementSkipReason('raydium_clmm', 'new_pool');
                          }
                        }
                        try { emit('pool-updates', { source: 'raydium', updatedAmm: d.amm.length, updatedClmm: d.clmm.length, sample: { amm: d.amm.slice(0, 20), clmm: [] }, ts: Date.now() }); } catch {}
                        // Always use incremental graph updates
                        try {
                          const gmod: any = await import('./graph.js');
                          const hasDelta = (d.amm.length || d.clmm.length || d.addedAmm || d.removedAmm || d.addedClmm || d.removedClmm);
                          if (hasDelta) {
                            await scheduleDexApply('raydium', prev as any);
                          }
                        } catch {}
                        } else {
                          // tick <= 0, invalid pool
                          try { logger.debug('raydium.ws clmm.skip.invalid_tick', { id: pk58, tick, cat: 'pools' }); } catch {}
                          updated = true;
                        }
                      } else {
                        // Price calculation failed, skip this update
                        wsDeltaStats.raydium_clmm.skipped += 1;
                        incrementSkipReason('raydium_clmm', 'price_calc_failed');
                        try { logger.debug('raydium.ws clmm.skip.no_price', { id: pk58, cat: 'pools' }); } catch {}
                        updated = true;
                      }
                    }
                  }
                  // Try AMM V4 decode
                  if (!updated) {
                    const ammLayout = (rmod as any)?.LiquidityStateLayoutV4 || (rmod as any)?.LIQUIDITY_STATE_LAYOUT_V4 || null;
                    if (ammLayout && typeof ammLayout.decode === 'function') {
                      try { state = ammLayout.decode(info.data); } catch { state = null; }
                      if (state) {
                        const mintA = (state.baseMint || state.mintA || state.mint_a)?.toBase58?.() || '';
                        const mintB = (state.quoteMint || state.mintB || state.mint_b)?.toBase58?.() || '';
                        // Reserves may be BN; best-effort convert to number
                        const rA = Number((state.baseReserve || state.reserveA || state.vaultA || 0).toString ? (state.baseReserve.toString()) : (state.baseReserve || 0));
                        const rB = Number((state.quoteReserve || state.reserveB || state.vaultB || 0).toString ? (state.quoteReserve.toString()) : (state.quoteReserve || 0));
                        let price_a_per_b: number | undefined;
                        let decA: number | undefined;
                        let decB: number | undefined;
                        try {
                          // Get decimals from pool cache (fast memory lookup)
                          const cachedRayPools = raydiumCache.data || { amm: [], clmm: [], cpmm: [] };
                          const existing = cachedRayPools.amm.find(p => p.id === pk58);
                          // CRITICAL FIX: Use native decimals, not canonical decimals
                          // The cache stores canonical (potentially swapped) decimals, but we need native decimals
                          // When a pool is swapped during canonicalization, decimals_a/b refer to the canonical mints,
                          // but mintA/mintB from chain state (baseMint/quoteMint) are always in native order
                          // If native decimals are missing, derive from canonical + was_swapped
                          // When swapped: canonical A = native B, so native A decimals = canonical B decimals
                          const wasSwapped = existing?.was_swapped === true;
                          decA = existing?.native_decimals_a ?? (wasSwapped ? existing?.decimals_b : existing?.decimals_a);
                          decB = existing?.native_decimals_b ?? (wasSwapped ? existing?.decimals_a : existing?.decimals_b);
                          
                          // Fallback to execution cache if not in pool cache
                          if (!Number.isFinite(decA) || !Number.isFinite(decB)) {
                            try {
                              const { executionCache } = await import('../execution/cache.js');
                              const cached = executionCache.getStatic(pk58);
                              if (!decA && cached?.native_decimals_a) decA = cached.native_decimals_a;
                              if (!decA && cached?.decimals_a) decA = cached.decimals_a;
                              if (!decB && cached?.native_decimals_b) decB = cached.native_decimals_b;
                              if (!decB && cached?.decimals_b) decB = cached.decimals_b;
                            } catch {}
                          }
                          
                          // Only as last resort, resolve via centralized resolver (rare for known pools)
                          if (!Number.isFinite(decA) || !Number.isFinite(decB)) {
                            try {
                              const { resolveDecimals } = await import('./pools/decimals.js');
                              if (!Number.isFinite(decA) && mintA) {
                                decA = await resolveDecimals(mintA);
                              }
                              if (!Number.isFinite(decB) && mintB) {
                                decB = await resolveDecimals(mintB);
                              }
                            } catch {
                              if (!Number.isFinite(decA)) decA = 9;
                              if (!Number.isFinite(decB)) decB = 6;
                            }
                          } else {
                            decA = Number(decA);
                            decB = Number(decB);
                          }
                          
                          if (!Number.isFinite(decA)) decA = undefined;
                          if (!Number.isFinite(decB)) decB = undefined;
                          
                          // CRITICAL FIX: Use correct AMM price formula with decimal adjustment
                          // price_a_per_b = "how many B for 1 A" = B/A
                          // Price = (reserveB / reserveA) * 10^(decimalsA - decimalsB)
                          // This accounts for different decimal places between tokens
                          if (rA > 0 && rB > 0 && Number.isFinite(decA) && Number.isFinite(decB)) {
                            const atomicRatio = rB / rA;  // B/A ratio
                            const decimalAdjustment = Math.pow(10, (decA as number) - (decB as number));
                            price_a_per_b = atomicRatio * decimalAdjustment;
                          }
                        } catch {}
                        const liqBase = (rA > 0 && rB > 0) ? Math.min(rA, rB) : 0;
                        
                        // CRITICAL VALIDATION: Ensure this is actually a pool account, not a vault
                        const isKnownDerivedAccount = derivedAccountToPool.has(pk58);
                        if (isKnownDerivedAccount) {
                          const derivedMeta = derivedAccountToPool.get(pk58);
                          try {
                            logger.warn('raydium.ws amm.vault_as_pool.prevented', {
                              account: pk58.slice(0,8)+'…',
                              accountType: derivedMeta?.accountType,
                              parentPool: derivedMeta?.poolId?.slice(0,8)+'…',
                              reason: 'account_is_vault_not_pool',
                              cat: 'pools'
                            });
                          } catch {}
                          throw new Error('vault account cannot be decoded as pool');
                        }
                        
                        // Fallback to cached fee_bps if on-chain extraction fails
                        // Fee values may be in PPM (parts per million) - need to convert to BPS.
                        let ammFee = Number((state as any).tradeFeeRate || (state as any).feeRate || 0);
                        
                        // Convert from PPM to BPS if value appears to be in PPM format
                        if (Number.isFinite(ammFee) && ammFee > 10000) {
                          ammFee = Math.round(ammFee / 100);
                        }
                        
                        if (!Number.isFinite(ammFee) || ammFee <= 0) {
                          const cachedPools = raydiumCache.data;
                          const existingPool = cachedPools?.amm?.find(p => p.id === pk58);
                          if (existingPool?.fee_bps && existingPool.fee_bps > 0) {
                            ammFee = existingPool.fee_bps;
                          } else {
                            try {
                              const hotData = executionCache.getHot(pk58);
                              if (hotData?.feeRate && hotData.feeRate > 0) {
                                ammFee = hotData.feeRate;
                              }
                            } catch {}
                          }
                        }
                        
                        const item: AmmPool = { id: pk58, dex: 'Raydium', mint_a: mintA, mint_b: mintB, fee_bps: ammFee, price_a_per_b, liquidity_base: liqBase, updated_ms: Date.now(), pool_kind: 'amm', liquidity_display: liqBase, decimals_a: decA, decimals_b: decB } as any;
                        
                        // Validate decoded pool before applying
                        const validation = validateDecodedPool('raydium', item, pk58);
                        if (!validation.valid) {
                          try { wsDecodeStats.raydium_amm.failures += 1; } catch {}
                          incrementSkipReason('raydium_amm', `validation_failed:${validation.reasons.join(',')}`);
                          try { logger.warn('raydium.ws amm.validation.failed', { id: pk58, reasons: validation.reasons, cat: 'pools' }); } catch {}
                          updated = true;
                          throw new Error(`validation failed: ${validation.reasons.join(',')}`);
                        }
                        
                        // Track AMM attempt
                        try { wsDecodeStats.raydium_amm.attempts += 1; } catch {}
                        
                        // Canonicalize pool to ensure consistent mint orientation and price
                        const [canonicalItem] = canonicalizePools([{ ...item }]);
                        const finalItem = canonicalItem || item;
                        
                        const prev = raydiumCache.data || { amm: [], clmm: [], cpmm: [] };
                        const next: PoolsPayload = { amm: prev.amm.slice(), clmm: prev.clmm.slice(), cpmm: prev.cpmm?.slice() || [] };
                        const idx = next.amm.findIndex(p => p.id === finalItem.id);
                        
                        // CRITICAL FIX: Handle orientation changes correctly
                        // When canonicalization changes orientation, preserve orientation-independent fields
                        if (idx >= 0) {
                          const prevPool = next.amm[idx];
                          const orientationChanged = prevPool.mint_a !== finalItem.mint_a || prevPool.mint_b !== finalItem.mint_b;
                          if (orientationChanged) {
                            // Orientation changed - start with canonicalized item (all A/B fields correctly swapped)
                            // Then preserve orientation-independent fields from previous pool
                            const orientationIndependentFields = {
                              tvl_usd: prevPool.tvl_usd,
                              liquidity_display: prevPool.liquidity_display,
                              pool_liquidity_raw: prevPool.pool_liquidity_raw,
                              // Preserve any other fields that don't depend on orientation
                            };
                            next.amm[idx] = { ...finalItem, ...orientationIndependentFields };
                          } else {
                            // Same orientation - safe to merge (preserves fields not in finalItem)
                            next.amm[idx] = { ...next.amm[idx], ...finalItem };
                          }
                        } else {
                          next.amm.push(finalItem);
                        }
                        
                        // OPTIMIZATION: Store raw account data in execution cache for builders
                        try {
                          const { executionCache } = await import('../execution/cache.js');
                          const existing = executionCache.getStatic(pk58) || {} as any;
                          executionCache.setStatic(pk58, {
                            ...existing,
                            rawAccountData: Buffer.from(info.data),
                            rawAccountDataUpdatedMs: Date.now(),
                          });
                        } catch {}
                        
                        try { wsDecodeStats.raydium_amm.successes += 1; } catch {}
                        wsDeltaStats.raydium_amm.decoded += 1;
                        const d = diffNormalizedPools(prev, next);
                        raydiumCache.data = next; raydiumCache.ts = Date.now();
                        const hasDelta = (d.amm.length || d.clmm.length || d.addedAmm || d.removedAmm || d.addedClmm || d.removedClmm);
                        if (hasDelta) { 
                          wsDeltaStats.raydium_amm.applied += 1; 
                        } else { 
                          wsDeltaStats.raydium_amm.skipped += 1;
                          // Diagnose why no delta detected
                          const prevPool = prev.amm.find(p => p.id === item.id);
                          if (prevPool) {
                            const reasons: string[] = [];
                            if ((prevPool as any).reserve_a_raw === (item as any).reserve_a_raw && (prevPool as any).reserve_b_raw === (item as any).reserve_b_raw) reasons.push('reserves_unchanged');
                            if (Math.abs((prevPool.liquidity_base || 0) - (item.liquidity_base || 0)) === 0) reasons.push('liquidity_unchanged');
                            if (Math.abs((prevPool.price_a_per_b || 0) - (item.price_a_per_b || 0)) <= 1e-9) reasons.push('price_unchanged');
                            incrementSkipReason('raydium_amm', reasons.length > 0 ? reasons.join('+') : 'no_delta_detected');
                          } else {
                            incrementSkipReason('raydium_amm', 'new_pool');
                          }
                        }
                        try { emit('pool-updates', { source: 'raydium', updatedAmm: d.amm.length, updatedClmm: d.clmm.length, sample: { amm: d.amm.slice(0, 20), clmm: [] }, ts: Date.now() }); } catch {}
                        // Always use incremental graph updates
                        try {
                          const gmod: any = await import('./graph.js');
                          if (hasDelta) {
                            await scheduleDexApply('raydium', prev as any);
                          }
                        } catch {}
                        updated = true;
                    }
                  }
                } else if (!(handle as any).__raydiumClmmLayoutMissing) {
                  (handle as any).__raydiumClmmLayoutMissing = true;
                  try {
                    logger.debug('raydium.ws clmm.layout.missing', {
                      id: pk58,
                      keys: Object.keys(rmod || {}),
                      cat: 'pools'
                    });
                  } catch {}
                }
              } catch (e:any) {
                // Generic failure - don't track to specific type since we don't know which decoder failed
                try { logger.warn('raydium.ws.decode failed', { id: pk58.slice(0,6)+'…', error: String(e?.message || e) }); } catch {}
              }
              // Unparsed events are tracked in aggregate metrics, no need for individual debug logs
              return;
            } else if (owner === ownerOrca) {
              try { wsCounts.orca += 1; } catch {}
              try { wsDecodeStats.orca.attempts += 1; } catch {}
              // Attempt to parse and upsert single Whirlpool from account data; fallback to full refresh on failure
              let ok = false;
              try {
                const pk58 = toB58Any(pk);
                let parsed: any = null;
                
                // PRIORITY 1: New @orca-so/whirlpools-client (v4.0)
                try {
                  const newClient = await import('@orca-so/whirlpools-client').catch(() => null);
                  if (newClient && typeof (newClient as any).getWhirlpoolDecoder === 'function') {
                    const decoder = (newClient as any).getWhirlpoolDecoder();
                    const dataBuffer = info.data instanceof Buffer ? new Uint8Array(info.data) : info.data;
                    const decoded = decoder.decode(dataBuffer);
                    if (decoded && decoded.tokenMintA && decoded.tokenMintB) {
                      // Convert to format compatible with rest of code (PublicKey objects)
                      parsed = {
                        tokenMintA: { toBase58: () => decoded.tokenMintA },
                        tokenMintB: { toBase58: () => decoded.tokenMintB },
                        sqrtPrice: decoded.sqrtPrice,
                        liquidity: decoded.liquidity,
                        tickSpacing: decoded.tickSpacing,
                        tickCurrentIndex: decoded.tickCurrentIndex,
                        feeRate: decoded.feeRate,
                        tokenVaultA: decoded.tokenVaultA ? { toBase58: () => decoded.tokenVaultA } : null,
                        tokenVaultB: decoded.tokenVaultB ? { toBase58: () => decoded.tokenVaultB } : null,
                        _decodedWithNewClient: true,
                      };
                    }
                  }
                } catch {}
                
                // PRIORITY 2: Legacy @orca-so/whirlpools-sdk (v0.16)
                if (!parsed) {
                  const sdk = await import('@orca-so/whirlpools-sdk').catch(() => null);
                  if (sdk) {
                    const { ParsableWhirlpool } = sdk as any;
                    if (ParsableWhirlpool && typeof ParsableWhirlpool.parse === 'function') {
                      try {
                        parsed = ParsableWhirlpool.parse(pk, info);
                      } catch {}
                    }
                  }
                }
                
                if (!parsed) {
                  // Log when parsing fails silently - this helps diagnose why events aren't being processed
                  try {
                    logger.debug('orca.ws.parse.returned_null', {
                      account: pk58.slice(0, 8) + '…',
                      dataLength: info?.data?.length || 0,
                      hasData: !!info?.data,
                      cat: 'pools'
                    });
                  } catch {}
                  // Still count as attempt even though parsing failed
                  try { wsDecodeStats.orca.failures += 1; } catch {}
                  return; // Skip this event
                }
                // Parsing succeeded, process the event
                {
                  maybeDebugAccount('orca');
                  const id = pk58;
                  const mintA = parsed.tokenMintA.toBase58();
                  const mintB = parsed.tokenMintB.toBase58();
                  const sqrtRaw = anyToBigInt(parsed.sqrtPrice);
                  const sqrt_price_x64 = sqrtRaw ? Number(sqrtRaw) : Number(parsed.sqrtPrice);
                  
                  // FIX: Use price pipeline for consistent orientation handling (same as Meteora/Raydium)
                  // Get decimals for the NATIVE mint order (not canonicalized cached order)
                  let processedPrice: any = undefined;
                  try {
                    let decA: number | undefined;
                    let decB: number | undefined;
                    
                    // Get decimals for native mints (mintA/mintB from on-chain state)
                    try {
                      const { resolveDecimals } = await import('./pools/decimals.js');
                      if (mintA) decA = await resolveDecimals(mintA);
                      if (mintB) decB = await resolveDecimals(mintB);
                    } catch {
                      // Fallback to defaults
                      if (!Number.isFinite(decA)) decA = 9;
                      if (!Number.isFinite(decB)) decB = 6;
                    }
                    
                    if (Number.isFinite(decA) && Number.isFinite(decB) && sqrtRaw) {
                      const { processPriceThroughPipeline } = await import('./pools/pricePipeline.js');
                      processedPrice = processPriceThroughPipeline({
                        mintA,
                        mintB,
                        decimalsA: decA!,
                        decimalsB: decB!,
                        poolId: id,
                        dex: 'Orca',
                        poolType: 'clmm',
                        sqrtPriceX64: sqrtRaw,
                      });
                      
                      if (!processedPrice) {
                        try {
                          logger.warn('orca.ws.clmm.price.pipeline_failed', {
                            id: id,
                            mintA: mintA?.slice(0, 8),
                            mintB: mintB?.slice(0, 8),
                            cat: 'pools'
                          });
                        } catch {}
                      }
                    }
                  } catch (err: any) {
                    try {
                      logger.warn('orca.ws.clmm.price.calc_failed', {
                        id: id,
                        error: String(err?.message || err),
                        cat: 'pools'
                      });
                    } catch {}
                  }
                  
                  if (processedPrice) {
                  if (processedPrice) {
                  const liquidityRaw = anyToBigInt(parsed.liquidity);
                  const liquidity = Number(parsed.liquidity);
                  const tick_spacing = Number(parsed.tickSpacing);
                  const fee_bps = deriveOrcaFeeBps(parsed as any);
                  
                  // Debug logging for fee validation issues
                  if (!Number.isFinite(fee_bps) || fee_bps < 0 || fee_bps > 10000) {
                    try {
                      logger.warn('orca.ws.invalid_fee_debug', {
                        id: id.slice(0, 8) + '…',
                        fee_bps,
                        parsed_feeRate: parsed?.feeRate,
                        parsed_fee: parsed?.fee,
                        parsed_tradeFeeRate: parsed?.tradeFeeRate,
                        parsed_tradingFeeRate: parsed?.tradingFeeRate,
                        parsed_protocolFeeRate: parsed?.protocolFeeRate,
                        cat: 'pools'
                      });
                    } catch {}
                  }
                  
                  // CRITICAL VALIDATION: Ensure this is actually a pool account, not a vault
                  const isKnownDerivedAccount = derivedAccountToPool.has(id);
                  if (isKnownDerivedAccount) {
                    const derivedMeta = derivedAccountToPool.get(id);
                    try {
                      logger.warn('orca.ws vault_as_pool.prevented', {
                        account: id.slice(0,8)+'…',
                        accountType: derivedMeta?.accountType,
                        parentPool: derivedMeta?.poolId?.slice(0,8)+'…',
                        reason: 'account_is_vault_not_pool',
                        cat: 'pools'
                      });
                    } catch {}
                    throw new Error('vault account cannot be decoded as pool');
                  }
                  
                  // Use pipeline-processed result (already canonicalized)
                  const clmmItem: ClmmPool = {
                    id,
                    dex: 'Orca',
                    mint_a: processedPrice.mintA,
                    mint_b: processedPrice.mintB,
                    fee_bps,
                    sqrt_price_x64,
                    sqrt_price_x64_raw: sqrtRaw ? sqrtRaw.toString() : undefined,
                    liquidity,
                    liquidity_raw: liquidityRaw ? liquidityRaw.toString() : undefined,
                    'tick_spacing': tick_spacing,
                    updated_ms: Date.now(),
                    pool_kind: 'clmm',
                    liquidity_display: liquidity,
                    price_a_per_b: processedPrice.priceForward,
                    decimals_a: processedPrice.decimalsA,
                    decimals_b: processedPrice.decimalsB,
                    was_swapped: processedPrice.wasSwapped,
                    native_mint_a: mintA,
                    native_mint_b: mintB,
                    _pipelineProcessed: true,
                  } as any;
                  
                  // Track derived tick arrays at handler scope for pool cache sync
                  let derivedTickArrays: { center?: string; lower?: string | string[]; upper?: string | string[] } | undefined;
                  
                  // OPTIMIZATION: Cache Orca pool state in execution cache to avoid RPC calls during tx building
                  try {
                    const { executionCache } = await import('../execution/cache.js');
                    const rawBuffer = Buffer.isBuffer(info.data) ? Buffer.from(info.data) : Buffer.from(info.data ?? []);
                    const existing = executionCache.getStatic(id) || {} as any;
                    
                    // Get native vault addresses
                    const nativeVaultA = parsed.tokenVaultA ? parsed.tokenVaultA.toBase58() : undefined;
                    const nativeVaultB = parsed.tokenVaultB ? parsed.tokenVaultB.toBase58() : undefined;
                    
                    // Store static pool data with CANONICAL orientation
                    executionCache.setStatic(id, {
                      ...existing,
                      // IMPORTANT: whirlpoolsConfig is NOT the program ID - it's a config PDA
                      // Always use the actual Orca Whirlpool program ID
                      programId: CONFIG.orca?.programId || 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
                      // Store vaults in CANONICAL order (matching mint_a/mint_b)
                      vaults: {
                        a: processedPrice.wasSwapped ? nativeVaultB : nativeVaultA,
                        b: processedPrice.wasSwapped ? nativeVaultA : nativeVaultB
                      },
                      oracle: parsed.oracle ? parsed.oracle.toBase58() : undefined,
                      tickSpacing: tick_spacing,
                      // CRITICAL FIX: Store CANONICALIZED mint/decimal order
                      mint_a: processedPrice.mintA,
                      mint_b: processedPrice.mintB,
                      decimals_a: processedPrice.decimalsA,
                      decimals_b: processedPrice.decimalsB,
                      // Preserve native orientation for reference
                      native_mint_a: mintA,
                      native_mint_b: mintB,
                      native_vault_a: nativeVaultA,
                      native_vault_b: nativeVaultB,
                      // Store raw account data for local parsing during tx building
                      rawAccountData: rawBuffer,
                      rawAccountDataUpdatedMs: Date.now()
                    });
                    
                    // Only derive tick arrays if missing - boundary crossing handled by setHot
                    const existingHot = executionCache.getHot(id);
                    const hasExistingTickArrays = existingHot?.tickArrays?.center;
                    
                    if (!hasExistingTickArrays) {
                      // Tick arrays missing - derive them
                      try {
                        const { deriveOrcaClmmCacheFields } = await import('./pools.derivation.js');
                        const derived = await deriveOrcaClmmCacheFields(
                          id,
                          Number(parsed.tickCurrentIndex),
                          tick_spacing
                        );
                        if (derived?.tickArrays) {
                          derivedTickArrays = derived.tickArrays;
                          
                          // Also update static cache with tick arrays
                          const tickArrayLower = typeof derivedTickArrays.lower === 'string'
                            ? derivedTickArrays.lower
                            : (Array.isArray(derivedTickArrays.lower) && derivedTickArrays.lower.length > 0
                              ? derivedTickArrays.lower[0]
                              : undefined);
                          const tickArrayUpper = typeof derivedTickArrays.upper === 'string'
                            ? derivedTickArrays.upper
                            : (Array.isArray(derivedTickArrays.upper) && derivedTickArrays.upper.length > 0
                              ? derivedTickArrays.upper[0]
                              : undefined);
                              
                          executionCache.setStatic(id, {
                            ...existing,
                            tickArrayLower,
                            tickArrayCenter: derivedTickArrays.center,
                            tickArrayUpper,
                          });
                        }
                      } catch (deriveErr) {
                        try { logger.debug('orca.ws.tickarray_derive_failed', { pool: id.slice(0, 8) + '…', error: String((deriveErr as any)?.message || deriveErr), cat: 'pools' }); } catch {}
                      }
                    }
                    
                    // Store hot pool data (frequently changing price/liquidity)
                    // setHot handles boundary crossing detection and will clear stale arrays
                    executionCache.setHot(id, {
                      sqrtPriceX64: sqrtRaw,
                      currentTickIndex: Number(parsed.tickCurrentIndex),
                      tickSpacing: tick_spacing,
                      liquidity: liquidityRaw,
                      feeRate: fee_bps,
                      // Only include tick arrays if we just derived them
                      ...(derivedTickArrays ? { tickArrays: derivedTickArrays } : {}),
                    });
                    
                    try {
                      logger.debug('orca.ws.cache_updated', {
                        pool: id.slice(0, 8) + '…',
                        hasRawData: !!info?.data,
                        sqrtPrice: sqrtRaw?.toString(),
                        currentTick: parsed.tickCurrentIndex,
                        liquidity: liquidityRaw?.toString(),
                        hadExistingArrays: !!hasExistingTickArrays,
                        derivedArrays: !!derivedTickArrays,
                        cat: 'pools'
                      });
                    } catch {}
                  } catch (cacheErr) {
                    try {
                      logger.warn('orca.ws.cache_update_failed', {
                        pool: id.slice(0, 8) + '…',
                        error: String((cacheErr as any)?.message || cacheErr),
                        cat: 'pools'
                      });
                    } catch {}
                  }
                  
                  // Validate decoded pool before applying
                  const validation = validateDecodedPool('orca', clmmItem, id);
                  if (!validation.valid) {
                    try { wsDecodeStats.orca.failures += 1; } catch {}
                    incrementSkipReason('orca', `validation_failed:${validation.reasons.join(',')}`);
                    try { logger.warn('orca.ws validation.failed', { id, reasons: validation.reasons, cat: 'pools' }); } catch {}
                    throw new Error(`validation failed: ${validation.reasons.join(',')}`);
                  }
                  
                  const prev = orcaCache.data || { amm: [], clmm: [], cpmm: [] };
                  const next: PoolsPayload = { amm: prev.amm.slice(), clmm: prev.clmm.slice(), cpmm: prev.cpmm?.slice() || [] };
                  const idx = next.clmm.findIndex(p => p.id === id);
                  if (idx >= 0) { next.clmm[idx] = { ...next.clmm[idx], ...clmmItem }; } else { next.clmm.push(clmmItem); }
                  try { wsDecodeStats.orca.successes += 1; } catch {}
                  wsDeltaStats.orca.decoded += 1;
                  orcaCache.data = next; orcaCache.ts = Date.now();
                  
                  // Sync tick data and tick arrays to pool cache
                  try {
                    const { updatePoolCacheFromValidation } = await import('./pools.cache.js');
                    const tickArrayLower = typeof derivedTickArrays?.lower === 'string'
                      ? derivedTickArrays.lower
                      : (Array.isArray(derivedTickArrays?.lower) && derivedTickArrays.lower.length > 0
                        ? derivedTickArrays.lower[0]
                        : undefined);
                    const tickArrayUpper = typeof derivedTickArrays?.upper === 'string'
                      ? derivedTickArrays.upper
                      : (Array.isArray(derivedTickArrays?.upper) && derivedTickArrays.upper.length > 0
                        ? derivedTickArrays.upper[0]
                        : undefined);
                    updatePoolCacheFromValidation([{
                      poolId: id,
                      dex: 'orca',
                      currentTick: Number(parsed.tickCurrentIndex),
                      tickSpacing: tick_spacing,
                      tickArrayLower,
                      tickArrayCenter: derivedTickArrays?.center,
                      tickArrayUpper,
                    }]);
                  } catch (syncErr) {
                    logger.debug('orca.ws.pool_cache_sync_failed', {
                      pool: id.slice(0, 8) + '…',
                      error: String((syncErr as any)?.message || syncErr),
                      cat: 'pools'
                    });
                  }
                  
                  const d = diffNormalizedPools(prev, next);
                  const sample = { amm: [], clmm: d.clmm.slice(0, 20) };
                  emit('pool-updates', { source: 'orca', updatedAmm: d.amm.length, updatedClmm: d.clmm.length, addedAmm: d.addedAmm, removedAmm: d.removedAmm, addedClmm: d.addedClmm, removedClmm: d.removedClmm, sample, ts: Date.now() });
                  // Delta stats are tracked in aggregate metrics
                  // Always use incremental graph updates
                  try {
                    const gmod: any = await import('./graph.js');
                    const hasDelta = (d.clmm.length || d.amm.length || d.addedClmm || d.removedClmm || d.addedAmm || d.removedAmm);
                    if (hasDelta) { 
                      wsDeltaStats.orca.applied += 1; 
                    } else { 
                      wsDeltaStats.orca.skipped += 1;
                      // Diagnose why no delta detected
                      const prevPool = prev.clmm.find(p => p.id === id);
                      if (prevPool) {
                        const reasons: string[] = [];
                        if ((prevPool as any).sqrt_price_x64_raw === (clmmItem as any).sqrt_price_x64_raw) reasons.push('sqrt_price_unchanged');
                        if ((prevPool as any).liquidity_raw === (clmmItem as any).liquidity_raw) reasons.push('liquidity_raw_unchanged');
                        if (Math.abs((prevPool.liquidity || 0) - (clmmItem.liquidity || 0)) === 0) reasons.push('liquidity_unchanged');
                        if (Math.abs((prevPool.price_a_per_b || 0) - (clmmItem.price_a_per_b || 0)) <= 1e-9) reasons.push('price_unchanged');
                        if ((prevPool as any).price_a_per_b_num === (clmmItem as any).price_a_per_b_num && (prevPool as any).price_a_per_b_den === (clmmItem as any).price_a_per_b_den) reasons.push('ratio_unchanged');
                        incrementSkipReason('orca', reasons.length > 0 ? reasons.join('+') : 'no_delta_detected');
                      } else {
                        incrementSkipReason('orca', 'new_pool');
                      }
                    }
                    // Use unified scheduleDexApply for consistency with Raydium/Meteora
                    if (hasDelta) {
                      await scheduleDexApply('orca', prev);
                    }
                  } catch {}
                  ok = true;
                  }
                  } else {
                    // Price calculation failed, skip this update
                    wsDeltaStats.orca.skipped += 1;
                    incrementSkipReason('orca', 'price_calc_failed');
                    try { logger.debug('orca.ws clmm.skip.no_price', { id: id, cat: 'pools' }); } catch {}
                  }
                }
              } catch (e:any) {
                try { wsDecodeStats.orca.failures += 1; } catch {}
                try { logger.warn('orca.ws.parse failed', { error: String(e?.message || e) }); } catch {}
              }
              // Do not fallback to HTTP refresh when user subscribed; leave updates to manual refresh
            } else if ((ownerMeteora && owner === ownerMeteora) || isMeteoraTarget) {
              try { wsCounts.meteora = (wsCounts.meteora || 0) + 1; } catch {}
              try { wsDecodeStats.meteora_dlmm.attempts += 1; } catch {}
              const pk58 = toB58Any(pk);
              const parentPoolId = meteoraBinAccountToPool.get(pk58);
              if (parentPoolId) {
                // OPTION 1: Disable bin array hash tracking - we're not subscribing to bins anymore
                // We rely solely on pool + reserve account updates for pricing
                /*
                const tracker = meteoraBinTrackers.get(parentPoolId);
                if (tracker) {
                  const accountMeta = tracker.accounts.get(pk58);
                  if (!info?.data || info.data.length === 0) {
                    if (accountMeta) {
                      tracker.indexes.delete(accountMeta.index);
                    }
                    tracker.accounts.delete(pk58);
                    tracker.binHashes.delete(pk58);
                    meteoraBinAccountToPool.delete(pk58);
                  } else {
                    const dataBuf = Buffer.isBuffer(info.data) ? info.data : Buffer.from(info.data as Uint8Array);
                    tracker.binHashes.set(pk58, hashBuffer(dataBuf));
                  }
                  await applyMeteoraBinHash(parentPoolId);
                }
                */
                logger.debug('meteora.bin_update.ignored', { 
                  pool: parentPoolId.slice(0,8)+'…', 
                  reason: 'option1_reserves_only',
                  cat: 'pools' 
                });
                return;
              }
              // Try on-chain decode via Meteora DLMM SDK; fallback to HTTP refresh if unavailable
              let updated = false;
              try {
                maybeDebugAccount('meteora');
                const poolId = pk58;
                const program = ensureMeteoraProgram();
                let state: any = null;
                let isBinArray = false;
                if (program && info?.data) {
                  try {
                    state = program.coder.accounts.decode('lbPair', info.data);
                    
                    // Enhanced diagnostic logging: compare SDK decode with direct binary reads
                    const sdkActiveId = state?.activeId ?? state?.active_id;
                    const sdkBinStep = state?.binStep ?? state?.bin_step;
                    const dataBuffer = Buffer.isBuffer(info.data) ? info.data : Buffer.from(info.data ?? []);
                    
                    let binary_activeId_240: number | null = null;
                    let binary_activeId_180: number | null = null;
                    let binary_binStep_232: number | null = null;
                    let binary_binStep_176: number | null = null;
                    
                    try { binary_activeId_240 = dataBuffer.readInt32LE(240); } catch {}
                    try { binary_activeId_180 = dataBuffer.readInt32LE(180); } catch {}
                    try { binary_binStep_232 = dataBuffer.readUInt16LE(232); } catch {}
                    try { binary_binStep_176 = dataBuffer.readUInt16LE(176); } catch {}
                    
                    logger.debug('meteora.ws.legacy.values_comparison', {
                      id: poolId.slice(0, 8) + '…',
                      sdk_activeId: sdkActiveId,
                      sdk_binStep: sdkBinStep,
                      binary_activeId_240,
                      binary_activeId_180,
                      binary_binStep_232,
                      binary_binStep_176,
                      sdk_keys: Object.keys(state || {}).slice(0, 15),
                      data_length: dataBuffer.length,
                      cat: 'pools'
                    });
                    
                    logger.debug('meteora.ws state.inspect', {
                      id: poolId,
                      gotState: true,
                      keys: Object.keys(state || {}),
                      source: 'program',
                      cat: 'pools'
                    });
                  } catch (err: any) {
                    try { logger.debug('meteora.ws decode.fail', { id: poolId, error: String(err?.message || err), cat: 'pools' }); } catch {}
                    try {
                      const bin = program.coder.accounts.decode('binArray', info.data);
                      if (bin) {
                        isBinArray = true;
                        logger.debug('meteora.ws binarray.inspect', {
                          id: poolId,
                          gotState: true,
                          keys: Object.keys(bin || {}),
                          cat: 'pools'
                        });
                      }
                    } catch {}
                  }
                }
                // Only log warning if it's not a binArray (which is expected to not have lbPair state)
                if (!state && !isBinArray) {
                  logger.warn('meteora.ws state.missing', { id: poolId, cat: 'pools' });
                }
                if (state) {
                  // OPTION 1: Disable dynamic bin array subscriptions - rely on reserves only
                  // await ensureMeteoraBinSubscriptionsForState(pk, poolId, state);
                  logger.debug('meteora.ws.skip_bin_subscription', {
                    pool: poolId.slice(0,8)+'…',
                    reason: 'option1_reserves_only',
                    cat: 'pools'
                  });
                  // Fallback: try reading minimal fields via generic accessors
                  let tokenX: string | undefined;
                  let tokenY: string | undefined;
                  let activeId: number | undefined;
                  let binStep: number | undefined;
                  try { tokenX = state?.tokenXMint?.toBase58?.() || state?.mint_x || state?.tokenXMint || state?.tokenA || undefined; } catch {}
                  try { tokenY = state?.tokenYMint?.toBase58?.() || state?.mint_y || state?.tokenYMint || state?.tokenB || undefined; } catch {}
                  try { activeId = Number(state?.activeId ?? state?.active_id); } catch {}
                  try { binStep = Number(state?.binStep ?? state?.bin_step); } catch {}
                  const accountA = toB58Any((state as any)?.reserveX);
                  const accountB = toB58Any((state as any)?.reserveY);
                  
                  // Log extracted field values for debugging
                  try {
                    logger.debug('meteora.ws.legacy.fields_extracted', {
                      id: poolId.slice(0, 8) + '…',
                      activeId,
                      binStep,
                      tokenX: tokenX?.slice(0, 8),
                      tokenY: tokenY?.slice(0, 8),
                      accountA: accountA?.slice(0, 8),
                      accountB: accountB?.slice(0, 8),
                      activeId_valid: Number.isFinite(activeId),
                      binStep_valid: Number.isFinite(binStep),
                      cat: 'pools'
                    });
                  } catch {}
                  
                  // Get decimals from pool cache (fast memory lookup)
                  const cachedMetPools = meteoraCache.data || { amm: [], clmm: [], cpmm: [] };
                  const existing = cachedMetPools.clmm.find(p => p.id === poolId);
                  // CRITICAL FIX: Use native decimals, not canonical decimals
                  // The cache stores canonical (potentially swapped) decimals, but we need native decimals for tokenX/tokenY
                  // When a pool is swapped during canonicalization, decimals_a/b refer to the canonical mints,
                  // but tokenX/tokenY from chain state are always in native order, so we must use native_decimals_a/b
                  let decA = existing?.native_decimals_a ?? existing?.decimals_a;
                  let decB = existing?.native_decimals_b ?? existing?.decimals_b;
                  
                  // Fallback to execution cache if not in pool cache
                  if (!Number.isFinite(decA) || !Number.isFinite(decB)) {
                    try {
                      const { executionCache } = await import('../execution/cache.js');
                      const cached = executionCache.getStatic(poolId);
                      if (!decA && cached?.native_decimals_a) decA = cached.native_decimals_a;
                      if (!decA && cached?.decimals_a) decA = cached.decimals_a;
                      if (!decB && cached?.native_decimals_b) decB = cached.native_decimals_b;
                      if (!decB && cached?.decimals_b) decB = cached.decimals_b;
                    } catch {}
                  }
                  
                  // Only as last resort, resolve via centralized resolver (rare for known pools)
                  if (tokenX && tokenY && (!Number.isFinite(decA) || !Number.isFinite(decB))) {
                    try {
                      const { resolveDecimals } = await import('./pools/decimals.js');
                      if (!Number.isFinite(decA)) {
                        decA = await resolveDecimals(tokenX);
                      }
                      if (!Number.isFinite(decB)) {
                        decB = await resolveDecimals(tokenY);
                      }
                    } catch {
                      if (!Number.isFinite(decA)) decA = 9;
                      if (!Number.isFinite(decB)) decB = 6;
                    }
                  }
                  
                  // Ensure valid numbers
                  if (Number.isFinite(decA)) decA = Number(decA);
                  if (Number.isFinite(decB)) decB = Number(decB);
                  if (!Number.isFinite(decA)) decA = undefined;
                  if (!Number.isFinite(decB)) decB = undefined;
                  
                  // FIX: Use the price pipeline for consistent orientation handling
                  // This ensures WebSocket updates respect canonicalization the same way HTTP does
                  let processedPrice: any = undefined;
                  if (Number.isFinite(activeId as any) && Number.isFinite(binStep as any) && decA != null && decB != null && tokenX && tokenY) {
                      try {
                        const { processPriceThroughPipeline } = await import('./pools/pricePipeline.js');
                        processedPrice = processPriceThroughPipeline({
                          mintA: tokenX,
                          mintB: tokenY,
                          decimalsA: decA,
                          decimalsB: decB,
                          poolId,
                          dex: 'Meteora',
                          poolType: 'clmm',
                          activeId: Number(activeId),
                          binStep: Number(binStep),
                          tokenXMint: tokenX,
                          tokenYMint: tokenY,
                        });
                        
                        if (!processedPrice) {
                          try {
                            logger.warn('meteora.ws.price.pipeline_failed', {
                              id: poolId,
                              activeId: Number(activeId),
                              binStep: Number(binStep),
                              tokenX: tokenX?.slice(0, 8),
                              tokenY: tokenY?.slice(0, 8),
                              cat: 'pools'
                            });
                          } catch {}
                        } else {
                          // Log calculated price for verification
                          try {
                            logger.debug('meteora.ws.legacy.price.calculated', {
                              id: poolId.slice(0, 8) + '…',
                              activeId: Number(activeId),
                              binStep: Number(binStep),
                              decimalsA: decA,
                              decimalsB: decB,
                              priceForward: processedPrice.priceForward,
                              priceReverse: processedPrice.priceReverse,
                              wasSwapped: processedPrice.wasSwapped,
                              mintA: processedPrice.mintA?.slice(0, 8),
                              mintB: processedPrice.mintB?.slice(0, 8),
                              cat: 'pools'
                            });
                          } catch {}
                        }
                      } catch (err: any) {
                        try {
                          logger.warn('meteora.ws.price.calc_failed', {
                            id: poolId,
                            activeId,
                            binStep,
                            decA,
                            decB,
                            error: String(err?.message || err),
                            cat: 'pools'
                          });
                        } catch {}
                      }
                  }
                  if (tokenX && tokenY && processedPrice) {
                    const tickSpacing = Number.isFinite(binStep as any) ? Number(binStep) : 0;
                    const liquidityRaw = anyToBigInt((state as any)?.liquidity ?? 0);
                    const liquidity = liquidityRaw ? Number(liquidityRaw) : Number((state as any)?.liquidity ?? 0);
                    const sqrtPriceRaw = anyToBigInt((state as any)?.sqrtPriceX64 ?? (state as any)?.sqrt_price_x64 ?? 0);
                    
                    // CRITICAL: Meteora DLMM pools may store fee in nested parameters structure.
                    // Fee values may be in PPM (parts per million) - need to convert to BPS.
                    // Fallback to cached fee_bps from HTTP fetch or execution cache.
                    let feeBps = Number(
                      (state as any)?.tradeFeeRate ?? 
                      (state as any)?.feeRate ?? 
                      (state as any)?.fee_rate ?? 
                      (state as any)?.fees ??
                      (state as any)?.baseFee ??
                      (state as any)?.parameters?.baseFactor ??
                      0
                    );
                    
                    // Convert from PPM to BPS if value appears to be in PPM format
                    // PPM values are typically > 10000 for any fee (since 10000 BPS = 100%)
                    // Values like 12500 PPM = 125 BPS = 1.25% fee
                    if (Number.isFinite(feeBps) && feeBps > 10000) {
                      feeBps = Math.round(feeBps / 100);
                    }
                    
                    if (!Number.isFinite(feeBps) || feeBps <= 0) {
                      const cachedPools = meteoraCache.data;
                      const existingPool = cachedPools?.clmm?.find(p => p.id === poolId);
                      if (existingPool?.fee_bps && existingPool.fee_bps > 0) {
                        feeBps = existingPool.fee_bps;
                      } else {
                        try {
                          const hotData = executionCache.getHot(poolId);
                          if (hotData?.feeRate && hotData.feeRate > 0) {
                            feeBps = hotData.feeRate;
                          }
                        } catch {}
                      }
                    }
                    
                    // CRITICAL VALIDATION: Ensure this is actually a pool account, not a reserve/bin array
                    const isKnownDerivedAccount = derivedAccountToPool.has(poolId);
                    if (isKnownDerivedAccount) {
                      const derivedMeta = derivedAccountToPool.get(poolId);
                      try {
                        logger.warn('meteora.ws derived_as_pool.prevented', {
                          account: poolId.slice(0,8)+'…',
                          accountType: derivedMeta?.accountType,
                          parentPool: derivedMeta?.poolId?.slice(0,8)+'…',
                          reason: 'account_is_derived_not_pool',
                          cat: 'pools'
                        });
                      } catch {}
                      throw new Error('derived account cannot be decoded as pool');
                    }
                    
                    // Use pipeline-processed price and mints (already canonicalized)
                    const item: ClmmPool = {
                      id: poolId,
                      dex: 'Meteora',
                      mint_a: processedPrice.mintA,
                      mint_b: processedPrice.mintB,
                      fee_bps: Number.isFinite(feeBps) ? feeBps : 0,
                      sqrt_price_x64: sqrtPriceRaw ? Number(sqrtPriceRaw) : Number((state as any)?.sqrtPriceX64 ?? (state as any)?.sqrt_price_x64 ?? 0),
                      sqrt_price_x64_raw: sqrtPriceRaw ? sqrtPriceRaw.toString() : undefined,
                      liquidity: Number.isFinite(liquidity) ? liquidity : 0,
                      liquidity_raw: liquidityRaw ? liquidityRaw.toString() : undefined,
                      'tick_spacing': tickSpacing,
                      updated_ms: Date.now(),
                      pool_kind: 'clmm',
                      price_a_per_b: processedPrice.priceForward,
                      decimals_a: processedPrice.decimalsA,
                      decimals_b: processedPrice.decimalsB,
                      // CRITICAL FIX: Store vault accounts in canonical order (matching mint_a/mint_b)
                      account_a: processedPrice.wasSwapped ? accountB : accountA,
                      account_b: processedPrice.wasSwapped ? accountA : accountB,
                      price_a_per_b_exact: processedPrice.priceForward?.toString(),
                      was_swapped: processedPrice.wasSwapped,
                      native_mint_a: tokenX,
                      native_mint_b: tokenY,
                      native_decimals_a: decA,
                      native_decimals_b: decB,
                      native_account_a: accountA,
                      native_account_b: accountB,
                      _pipelineProcessed: true,
                    } as any;
                    const tracker = meteoraBinTrackers.get(poolId);
                    if (tracker?.aggregate) (item as any).meteora_bin_hash = tracker.aggregate;
                    if (Number.isFinite(activeId as any)) (item as any).active_id = Number(activeId);
                    if (tickSpacing) (item as any).bin_step = tickSpacing;
                    const binArrayAddresses = await deriveMeteoraBinArrayAddresses(pk, program?.programId, typeof activeId === 'number' ? Number(activeId) : undefined);
                    if (binArrayAddresses.lower) (item as any).bin_array_lower = binArrayAddresses.lower;
                    if (binArrayAddresses.upper) (item as any).bin_array_upper = binArrayAddresses.upper;
                    
                    // OPTIMIZATION: Cache Meteora active bin ID and state in execution cache
                    try {
                      const { executionCache } = await import('../execution/cache.js');
                      const rawBuffer = Buffer.isBuffer(info.data) ? Buffer.from(info.data) : Buffer.from(info.data ?? []);
                      const existing = executionCache.getStatic(poolId) || {} as any;
                      const nextStatic: any = {
                        ...existing,
                        programId: String(program?.programId?.toBase58() || ''),
                        vaults: { a: accountA, b: accountB },
                        binStep: tickSpacing,
                        // CRITICAL FIX: Store CANONICALIZED mint order (not native)
                        // This must match the pool item's mint_a/mint_b to ensure consistency
                        mint_a: processedPrice.mintA,
                        mint_b: processedPrice.mintB,
                        decimals_a: processedPrice.decimalsA,
                        decimals_b: processedPrice.decimalsB,
                        token_program_a: existing.token_program_a,
                        token_program_b: existing.token_program_b,
                        // Store vault accounts in canonical order (matching mint_a/mint_b)
                        account_a: processedPrice.wasSwapped ? accountB : accountA,
                        account_b: processedPrice.wasSwapped ? accountA : accountB,
                        bin_array_bitmap_extension: existing.bin_array_bitmap_extension,
                        // Also preserve native orientation for reference
                        native_mint_a: tokenX,
                        native_mint_b: tokenY,
                        native_decimals_a: decA,
                        native_decimals_b: decB,
                        native_account_a: accountA,
                        native_account_b: accountB,
                        // Store raw account data for local parsing during tx building
                        rawAccountData: rawBuffer,
                        rawAccountDataUpdatedMs: Date.now()
                      };
                      if (binArrayAddresses.lower) nextStatic.bin_array_lower = binArrayAddresses.lower;
                      if (binArrayAddresses.upper) nextStatic.bin_array_upper = binArrayAddresses.upper;
                      executionCache.setStatic(poolId, nextStatic);
                      
                      // Store hot pool data (frequently changing active bin ID / bin arrays)
                      // Include binStep for boundary crossing detection in cache
                      if (Number.isFinite(activeId as any) || binArrayAddresses.lower || binArrayAddresses.upper) {
                        const existingHot = executionCache.getHot(poolId) || {};
                        executionCache.setHot(poolId, {
                          ...existingHot,
                          activeId: Number.isFinite(activeId as any) ? Number(activeId) : existingHot.activeId,
                          binStep: Number.isFinite(tickSpacing as any) ? tickSpacing : existingHot.binStep,
                          sqrtPriceX64: sqrtPriceRaw ?? existingHot.sqrtPriceX64,
                          liquidity: liquidityRaw ?? existingHot.liquidity,
                          feeRate: Number.isFinite(feeBps) ? feeBps : existingHot.feeRate,
                          binArrays: {
                            ...(existingHot.binArrays || {}),
                            ...binArrayAddresses,
                          },
                        });
                        
                        try {
                          logger.debug('meteora.ws.cache_updated', {
                            pool: poolId.slice(0, 8) + '…',
                            activeId: Number(activeId),
                            binStep: tickSpacing,
                            hasRawData: !!info?.data,
                            cat: 'pools'
                          });
                        } catch {}
                      }
                    } catch (cacheErr) {
                      try {
                        logger.warn('meteora.ws.cache_update_failed', {
                          pool: poolId.slice(0, 8) + '…',
                          error: String((cacheErr as any)?.message || cacheErr),
                          cat: 'pools'
                        });
                      } catch {}
                    }
                    
                    // Pipeline already canonicalized, so use item directly as finalItem
                    const finalItem = item;
                    
                    // Validate decoded pool before applying
                    const validation = validateDecodedPool('meteora_dlmm', finalItem, poolId);
                    if (!validation.valid) {
                      try { wsDecodeStats.meteora_dlmm.failures += 1; } catch {}
                      incrementSkipReason('meteora_dlmm', `validation_failed:${validation.reasons.join(',')}`);
                      try { logger.warn('meteora_dlmm.ws validation.failed', { id: poolId, reasons: validation.reasons, cat: 'pools' }); } catch {}
                      updated = true;
                      throw new Error(`validation failed: ${validation.reasons.join(',')}`);
                    }
                    
                    const prev = meteoraCache.data || { amm: [], clmm: [], cpmm: [] };
                    const next: PoolsPayload = { amm: prev.amm.slice(), clmm: prev.clmm.slice(), cpmm: prev.cpmm?.slice() || [] };
                    const idx = next.clmm.findIndex(p => p.id === finalItem.id);
                    
                    // Sync bin arrays to pool cache if we have activeId/bin array data
                    if (Number.isFinite(activeId as any) || binArrayAddresses.lower || binArrayAddresses.upper) {
                      try {
                        const { updatePoolCacheFromValidation } = await import('./pools.cache.js');
                        updatePoolCacheFromValidation([{
                          poolId: poolId,
                          dex: 'meteora',
                          activeId: Number.isFinite(activeId as any) ? Number(activeId) : undefined,
                          binStep: Number.isFinite(tickSpacing as any) ? tickSpacing : undefined,
                          binArrayLower: binArrayAddresses.lower,
                          binArrayUpper: binArrayAddresses.upper,
                        }]);
                      } catch (syncErr) {
                        logger.debug('meteora.ws.pool_cache_sync_failed', {
                          pool: poolId.slice(0, 8) + '…',
                          error: String((syncErr as any)?.message || syncErr),
                          cat: 'pools'
                        });
                      }
                    }
                    
                    // CRITICAL FIX: Handle orientation changes correctly
                    // When canonicalization changes orientation (e.g., after token swaps), we need to:
                    // 1. Use the canonicalized item (which has all A/B fields correctly swapped)
                    // 2. Preserve orientation-independent fields from previous pool (tvl_usd, liquidity_display, etc.)
                    // 3. Ensure diff logic recognizes this as an update (same id), not removal+addition
                    if (idx >= 0) {
                      const prevPool = next.clmm[idx];
                      // Check if canonicalization orientation changed (mints swapped)
                      const orientationChanged = prevPool.mint_a !== finalItem.mint_a || prevPool.mint_b !== finalItem.mint_b;
                      if (orientationChanged) {
                        // Orientation changed - start with canonicalized item (all A/B fields correctly swapped)
                        // Then preserve orientation-independent fields from previous pool
                        const orientationIndependentFields = {
                          tvl_usd: prevPool.tvl_usd,
                          liquidity_display: prevPool.liquidity_display,
                          pool_liquidity_raw: prevPool.pool_liquidity_raw,
                          // Preserve any other fields that don't depend on orientation
                        };
                        next.clmm[idx] = { ...finalItem, ...orientationIndependentFields };
                      } else {
                        // Same orientation - safe to merge (preserves fields not in finalItem)
                        next.clmm[idx] = { ...next.clmm[idx], ...finalItem };
                      }
                    } else {
                      next.clmm.push(finalItem);
                    }
                    
                    try { wsDecodeStats.meteora_dlmm.successes += 1; } catch {}
                    wsDeltaStats.meteora_dlmm.decoded += 1;
                    const d = diffNormalizedPools(prev, next);
                    meteoraCache.data = next; meteoraCache.ts = Date.now();
                    const hasDelta = (d.amm.length || d.clmm.length || d.addedAmm || d.removedAmm || d.addedClmm || d.removedClmm);
                    if (hasDelta) { 
                      wsDeltaStats.meteora_dlmm.applied += 1; 
                    } else { 
                      wsDeltaStats.meteora_dlmm.skipped += 1;
                      // Diagnose why no delta detected
                      const prevPool = prev.clmm.find(p => p.id === finalItem.id);
                      if (prevPool) {
                        const reasons: string[] = [];
                        if ((prevPool as any).sqrt_price_x64_raw === (finalItem as any).sqrt_price_x64_raw) reasons.push('sqrt_price_unchanged');
                        if ((prevPool as any).liquidity_raw === (finalItem as any).liquidity_raw) reasons.push('liquidity_raw_unchanged');
                        if (Math.abs((prevPool.liquidity || 0) - (finalItem.liquidity || 0)) === 0) reasons.push('liquidity_unchanged');
                        if (Math.abs((prevPool.price_a_per_b || 0) - (finalItem.price_a_per_b || 0)) <= 1e-9) reasons.push('price_unchanged');
                        if ((prevPool as any).meteora_bin_hash === (finalItem as any).meteora_bin_hash) reasons.push('bin_hash_unchanged');
                        incrementSkipReason('meteora_dlmm', reasons.length > 0 ? reasons.join('+') : 'no_delta_detected');
                      } else {
                        incrementSkipReason('meteora_dlmm', 'prev_pool_missing');
                      }
                    }
                    try {
                      const sample = { amm: [], clmm: d.clmm.slice(0, 20) };
                      emit('pool-updates', { source: 'meteora', updatedAmm: d.amm.length, updatedClmm: d.clmm.length, addedAmm: d.addedAmm, removedAmm: d.removedAmm, addedClmm: d.addedClmm, removedClmm: d.removedClmm, sample, ts: Date.now(), canon: (CONFIG.system as any)?.canonicalizePairs || 'none' });
                    } catch {}
                    // Use unified scheduleDexApply for consistency with other DEXes
                    // The orientation-aware cache update above ensures the cache is correct before scheduleDexApply reads it
                    if (hasDelta) {
                      await scheduleDexApply('meteora', prev as any);
                    }
                    try { logger.debug('meteora.ws clmm.fields', { id: poolId, priceForward: processedPrice.priceForward, binStep: tickSpacing, activeId, decimals: { a: processedPrice.decimalsA, b: processedPrice.decimalsB }, wasSwapped: processedPrice.wasSwapped, cat: 'pools' }); } catch {}
                    updated = true;
                  } else {
                    wsDeltaStats.meteora_dlmm.skipped += 1;
                    const tokenReason = `missing_${!tokenX ? 'tokenX' : ''}${!tokenY ? 'tokenY' : ''}${!processedPrice ? '_priceCalc' : ''}`;
                    incrementSkipReason('meteora_dlmm', tokenReason);
                    try { logger.debug('meteora_dlmm.ws state.skip', { id: poolId, hasTokenX: !!tokenX, hasTokenY: !!tokenY, hasProcessedPrice: !!processedPrice, activeId, binStep, cat: 'pools' }); } catch {}
                  }
                }
              } catch {}
              if (!updated) {
                // Fallback: debounced HTTP refresh
                const minGap = Number((CONFIG.system as any)?.poolRefreshMinGapMs || 3000);
                const { getMeteoraPoolsCached } = await import('./pools.js');
                const last = (getMeteoraPoolsCached as any).__lastForceAt || 0;
                const nowMs = Date.now();
                if (nowMs - last >= minGap) {
                  (getMeteoraPoolsCached as any).__lastForceAt = nowMs;
                  getMeteoraPoolsCached(true).catch(() => {});
                }
              }
              return;
            } else if (pk) {
              // Fallback: if account belongs to any known program, refresh both
              // Disabled while subscribed
            }
          } catch {}
        };
        // Helper: subscribe with retry/backoff to avoid calling while WS is closing
        const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
        
        // Use shared WebSocket utilities
        const { getWebSocketReadyState, waitUntilWsReady: waitUntilWsReadyShared } = await import('../drift/wsHelper.js');
        const getRpcWebSocketReadyState = () => getWebSocketReadyState(conn);
        
        const subscribeAccountWithRetry = async (accountPk: any, cb: (pk: any, info: any) => void): Promise<number> => {
          const maxAttempts = Math.max(1, Number(((CONFIG.system as any)?.wsSubscribeMaxAttempts) || 10));
          const baseBackoffMs = Math.max(50, Number(((CONFIG.system as any)?.wsSubscribeBackoffMs) || 250));
          let attempt = 0;
          
          // Import RPC limiter and debouncing
          const { withDebounce, acquireRpcSlots } = await import('../utils/rpcLimiter.js');
          
          // Use account pubkey as debounce key to prevent duplicate rapid subscriptions
          const debounceKey = `pools:accountSubscribe:${accountPk.toBase58()}`;
          
          // Attempt loop
          for (;;) {
            await waitUntilWsReadyShared(conn, 'pools.subscribeAccount');
            try {
              // Apply debouncing and rate limiting to prevent rapid-fire subscription attempts
              const id = await withDebounce(
                debounceKey,
                async () => {
                  // CRITICAL FIX: Acquire RPC slot first, then call onAccountChange synchronously
                  // onAccountChange returns synchronously, so we need to acquire the slot before calling it
                  await acquireRpcSlots(1);
                  
                  // Call onAccountChange synchronously after acquiring slot
                  // Capture subscriptionId in closure for callback logging
                  const subscriptionId = conn.onAccountChange(accountPk, (info: any) => { 
                      try { 
                        // Log every WebSocket event for diagnostics
                        try {
                          logger.debug('pools.ws event.received', {
                            account: accountPk.toBase58().slice(0,8) + '…',
                          subscriptionId: subscriptionId, // ✅ FIX: Use captured variable
                            dataLength: info?.data?.length || 0,
                            cat: 'pools'
                          });
                        } catch {}
                        cb(accountPk, info); 
                      } catch (callbackErr: any) {
                        // Log callback errors (should never happen but catch just in case)
                        try {
                          logger.warn('pools.ws event.callback_error', {
                            account: accountPk.toBase58().slice(0,8) + '…',
                            error: String(callbackErr?.message || callbackErr),
                            cat: 'pools'
                          });
                        } catch {}
                      }
                  });
                  
                  return subscriptionId;
                },
                150 // 150ms debounce for account subscriptions
              );
              
              // Log successful subscription
              try {
                logger.debug('pools.ws subscribe.success', {
                  account: accountPk.toBase58().slice(0,8) + '…',
                  subscriptionId: id,
                  cat: 'pools'
                });
              } catch {}
              
              return id as unknown as number;
            } catch (e: any) {
              const msg = String(e?.message || e);
              const isWsState = msg.includes('socket was not') || msg.includes('readyState') || msg.includes('not ready');
              attempt += 1;
              if (!isWsState || attempt >= maxAttempts) {
                // Give up on non-WS errors or after exhausting retries
                throw e;
              }
              const delay = Math.min(5000, Math.floor(baseBackoffMs * Math.pow(1.5, attempt - 1)));
              // Retry attempts are expected behavior, no need to log each one
              await sleep(delay);
            }
          }
        };
        const subscribeProgramWithRetry = async (programPk: any, cb: (ch: any) => void): Promise<number> => {
          const maxAttempts = Math.max(1, Number(((CONFIG.system as any)?.wsSubscribeMaxAttempts) || 10));
          const baseBackoffMs = Math.max(50, Number(((CONFIG.system as any)?.wsSubscribeBackoffMs) || 250));
          let attempt = 0;
          
          // Import RPC limiter and debouncing
          const { withDebounce, acquireRpcSlots } = await import('../utils/rpcLimiter.js');
          
          // Use program pubkey as debounce key
          const debounceKey = `pools:programSubscribe:${programPk.toBase58()}`;
          
          for (;;) {
            await waitUntilWsReadyShared(conn, 'pools.subscribeProgram');
            try {
              // Apply debouncing and rate limiting to prevent rapid-fire subscription attempts
              const id = await withDebounce(
                debounceKey,
                async () => {
                  // CRITICAL FIX: Acquire RPC slot first, then call onProgramAccountChange synchronously
                  // onProgramAccountChange returns synchronously, so we need to acquire the slot before calling it
                  await acquireRpcSlots(1);
                  
                  // Call onProgramAccountChange synchronously after acquiring slot
                  const subscriptionId = conn.onProgramAccountChange(programPk, (ch: any) => { 
                    try { cb(ch); } catch {} 
                  });
                  
                  return subscriptionId;
                },
                150 // 150ms debounce for program subscriptions
              );
              
              return id as unknown as number;
            } catch (e: any) {
              const msg = String(e?.message || e);
              const isWsState = msg.includes('socket was not') || msg.includes('readyState') || msg.includes('not ready');
              attempt += 1;
              if (!isWsState || attempt >= maxAttempts) {
                throw e;
              }
              const delay = Math.min(5000, Math.floor(baseBackoffMs * Math.pow(1.5, attempt - 1)));
              // Retry attempts are expected behavior, no need to log each one
              await sleep(delay);
            }
          }
        };
        // Debounced per-DEX apply: coalesce multiple WS updates into a single apply+push
        const wsApply: Record<'raydium'|'orca'|'meteora'|'pumpswap'|'meteora_balanced', { timer: NodeJS.Timeout | null; baseline: any | null }> = {
          raydium: { timer: null, baseline: null },
          orca: { timer: null, baseline: null },
          meteora: { timer: null, baseline: null },
          pumpswap: { timer: null, baseline: null },
          meteora_balanced: { timer: null, baseline: null },
        };
        const WS_APPLY_DEBOUNCE_MS = Math.max(10, Number(((CONFIG.system as any)?.wsApplyDebounceMs) || 100));
        const getCurrentCache = (dex: 'raydium'|'orca'|'meteora'|'pumpswap'|'meteora_balanced'): any => {
          if (dex === 'raydium') return raydiumCache.data || { amm: [], clmm: [], cpmm: [] };
          if (dex === 'orca') return orcaCache.data || { amm: [], clmm: [], cpmm: [] };
          if (dex === 'meteora') return meteoraCache.data || { amm: [], clmm: [], cpmm: [] };
          if (dex === 'pumpswap') return pumpswapCache.data || { amm: [], clmm: [], cpmm: [] };
          return metbalCache.data || { amm: [], clmm: [], cpmm: [] };
        };
        async function scheduleDexApply(dex: 'raydium'|'orca'|'meteora'|'pumpswap'|'meteora_balanced', baseline: any): Promise<void> {
          try {
            if (!wsApply[dex].baseline) wsApply[dex].baseline = baseline;
            // Reset timer on new updates - clear existing timer if present
            if (wsApply[dex].timer) {
              clearTimeout(wsApply[dex].timer);
              wsApply[dex].timer = null;
            }
            wsApply[dex].timer = setTimeout(async () => {
              const base = wsApply[dex].baseline; wsApply[dex].baseline = null; wsApply[dex].timer = null;
              if (!base) return;
              try {
                const gmod: any = await import('./graph.js');
                const cur = getCurrentCache(dex);
                if (typeof gmod.applyPoolUpdates === 'function') {
                  // pushToArb: false - updates accumulate and flush when arb-rs calls /arb/detect/complete
                  await gmod.applyPoolUpdates(base, cur, { pushToArb: false });
                }
              } catch {}
            }, WS_APPLY_DEBOUNCE_MS);
          } catch {}
        }
        const bnFrom = (value: any): BN => {
          if (BN.isBN && BN.isBN(value)) return value as BN;
          if (value instanceof BN) return value;
          if (typeof value === 'bigint') return new BN(value.toString());
          if (typeof value === 'number') return new BN(value);
          if (typeof value === 'string') {
            try { return new BN(value, 10); } catch { return new BN(0); }
          }
          if (value && typeof value === 'object') {
            try {
              if (typeof value.toArrayLike === 'function') return new BN(value.toArrayLike(Buffer, 'le', 32));
              if (Array.isArray(value)) return bnFrom(value[0]);
            } catch {}
          }
          return new BN(0);
        };

        const computeMeteoraBinIndexes = (state: any): number[] => {
          const words: BN[] = Array.isArray(state?.binArrayBitmap)
            ? state.binArrayBitmap.map((w: any) => bnFrom(w))
            : [];
          if (!words.length) return [];
          const indexes: number[] = [];
          const totalBits = METEORA_BIN_BITMAP_SIZE * 2; // default coverage (-512 .. 511)
          const offset = METEORA_BIN_BITMAP_SIZE;
          for (let bit = 0; bit < totalBits; bit++) {
            const wordIndex = Math.floor(bit / 64);
            const bitIndex = bit % 64;
            const word = words[wordIndex];
            if (!word || typeof word.testn !== 'function') continue;
            if (word.testn(bitIndex)) {
              const index = bit - offset;
              indexes.push(index);
            }
          }
          return Array.from(new Set(indexes));
        };

        const deriveMeteoraBinArrayAddress = (pairPk: any, index: number, programId: any): any => {
          const idx = new BN(index);
          const seed = idx.isNeg()
            ? idx.toTwos(64).toArrayLike(Buffer, 'le', 8)
            : idx.toArrayLike(Buffer, 'le', 8);
          return (web3.PublicKey as any).findProgramAddressSync([
            Buffer.from('bin_array'),
            pairPk.toBuffer(),
            Buffer.from(seed),
          ], programId)[0];
        };

        const getMeteoraTracker = (poolId: string): MeteoraBinTracker => {
          let tracker = meteoraBinTrackers.get(poolId);
          if (!tracker) {
            tracker = { indexes: new Set(), accounts: new Map(), binHashes: new Map(), aggregate: undefined };
            meteoraBinTrackers.set(poolId, tracker);
          }
          return tracker;
        };
        const hashBuffer = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

        const applyMeteoraBinHash = async (poolId: string): Promise<void> => {
          const tracker = meteoraBinTrackers.get(poolId);
          if (!tracker) return;
          wsDeltaStats.meteora_dlmm.decoded += 1;
          const aggregate = (() => {
            if (tracker.binHashes.size === 0) return undefined;
            const digest = createHash('sha256');
            const sorted = Array.from(tracker.binHashes.entries()).sort(([a], [b]) => a.localeCompare(b));
            for (const [addr, hash] of sorted) {
              digest.update(addr);
              digest.update(':');
              digest.update(hash);
              digest.update('|');
            }
            return digest.digest('hex');
          })();
          if (aggregate === tracker.aggregate) {
            wsDeltaStats.meteora_dlmm.skipped += 1;
            incrementSkipReason('meteora_dlmm', 'bin_hash_aggregate_unchanged');
            return;
          }
          tracker.aggregate = aggregate;
          const prev = meteoraCache.data || { amm: [], clmm: [], cpmm: [] };
          const next: PoolsPayload = { amm: prev.amm.slice(), clmm: prev.clmm.slice(), cpmm: prev.cpmm?.slice() || [] };
          const idx = next.clmm.findIndex(p => p.id === poolId);
          if (idx === -1) {
            // Pool snapshot not yet cached; bin state will be included on next pair update
            wsDeltaStats.meteora_dlmm.skipped += 1;
            incrementSkipReason('meteora_dlmm', 'bin_update_pool_not_cached');
            return;
          }
          const updated: any = { ...next.clmm[idx] };
          if (aggregate) updated.meteora_bin_hash = aggregate; else delete updated.meteora_bin_hash;
          next.clmm[idx] = updated;
          const d = diffNormalizedPools(prev, next);
          meteoraCache.data = next; meteoraCache.ts = Date.now();
          const hasDelta = (d.amm.length || d.clmm.length || d.addedAmm || d.removedAmm || d.addedClmm || d.removedClmm);
          if (hasDelta) {
            wsDeltaStats.meteora_dlmm.applied += 1;
          } else {
            wsDeltaStats.meteora_dlmm.skipped += 1;
            incrementSkipReason('meteora_dlmm', 'bin_update_no_delta');
          }
          try {
            const sample = { amm: [], clmm: d.clmm.slice(0, 20) };
            emit('pool-updates', { source: 'meteora', updatedAmm: d.amm.length, updatedClmm: d.clmm.length, addedAmm: d.addedAmm, removedAmm: d.removedAmm, addedClmm: d.addedClmm, removedClmm: d.removedClmm, sample, ts: Date.now(), canon: (CONFIG.system as any)?.canonicalizePairs || 'none' });
          } catch {}
          try {
            const gmod: any = await import('./graph.js');
            if (hasDelta) {
              await scheduleDexApply('meteora', prev as any);
            }
          } catch {}
        };

        const ensureMeteoraBinSubscriptionsForState = async (pairPk: any, poolId: string, state: any): Promise<void> => {
          try {
            const program = ensureMeteoraProgram();
            if (!program) return;
            const programId = program.programId;
            const indexes = computeMeteoraBinIndexes(state);
            if (indexes.length === 0) return;
            const tracker = getMeteoraTracker(poolId);
            const newIndexes = indexes.filter((idx) => !tracker.indexes.has(idx));
            for (const index of newIndexes) {
              try {
                const binPk = deriveMeteoraBinArrayAddress(pairPk, index, programId);
                const id = await subscribeAccountWithRetry(binPk, handle);
                subs.push({ kind: 'account', id });
                const acct = binPk.toBase58();
                meteoraBinAccountToPool.set(acct, poolId);
                tracker.accounts.set(acct, { id, index });
                tracker.indexes.add(index);
                targetedSourceByAccount.set(acct, 'meteora');
                debugLogTargeted('meteora', acct, { kind: 'bin_array', index });
                // Don't fetch initial bin data via RPC - wait for WebSocket update
                // The first WebSocket update will populate the hash
                // This eliminates RPC calls during pool updates when price moves to new bins
                try {
                  logger.debug('meteora.bin.subscribed', { 
                    pool: poolId, 
                    index, 
                    binAccount: acct.slice(0,8)+'…', 
                    reason: 'awaiting_first_ws_update',
                    cat: 'pools' 
                  });
                } catch {}
              } catch (err) {
                try { logger.info('meteora.ws bin.subscribe.fail', { pool: poolId, index, error: String((err as any)?.message || err) }); } catch {}
              }
            }
            // Ensure aggregate reflects any freshly fetched hashes
            if (tracker.binHashes.size > 0) {
              await applyMeteoraBinHash(poolId);
            }
          } catch (err) {
            try { logger.debug('meteora.ws bin.ensure.failed', { pool: poolId, error: String((err as any)?.message || err) }); } catch {}
          }
        };

        // Helper: attach Raydium AMM vault (token) accounts for a given AMM pool address
        const attachRaydiumAmmVaults = async (poolAddr: string, opts?: { poolAccount?: any }) => {
          try {
            logger.info('raydium.amm.attach.start', { pool: poolAddr.slice(0,8)+'…', cat: 'pools' });
            const pk = new web3.PublicKey(poolAddr);
            const { withRpcRetry } = await import('../utils/rpcLimiter.js');
            
            // Prefer caller-provided account data to avoid duplicate RPC fetches
            const acc: any = opts?.poolAccount ?? await withRpcRetry(
              () => conn.getAccountInfo(pk, CONFIG.system.txCommitment as any),
              { 
                timeoutMs: 5000,  // 5 second timeout per attempt
                retries: 2,        // 2 retries
                weight: 1,
                module: 'pools',
                method: 'getAccountInfo',
                label: 'raydium.amm.getAccountInfo'
              }
            ).catch((err) => {
              logger.info('raydium.amm.attach.rpc_fail', { pool: poolAddr.slice(0,8)+'…', error: String(err), cat: 'pools' });
              return null;
            });
            
            if (!acc || !acc.data) {
              logger.info('raydium.amm.attach.no_data', { 
                pool: poolAddr.slice(0,8)+'…', 
                hasAcc: !!acc,
                hasData: !!(acc?.data),
                cat: 'pools' 
              });
              return;
            }
            
            const rmod: any = await import('@raydium-io/raydium-sdk-v2').catch(() => null);
            // SDK v2 exports: liquidityStateV4Layout (lowercase 'l')
            const ammLayout = rmod?.liquidityStateV4Layout || rmod?.LiquidityStateLayoutV4 || rmod?.LIQUIDITY_STATE_LAYOUT_V4;
            if (!ammLayout || typeof ammLayout.decode !== 'function') {
              logger.info('raydium.amm.attach.no_layout', { 
                pool: poolAddr.slice(0,8)+'…', 
                availableKeys: Object.keys(rmod || {}).filter((k: string) => k.toLowerCase().includes('liquidity')).slice(0, 5),
                cat: 'pools' 
              });
              return;
            }
            
            let state: any = null;
            try { state = ammLayout.decode((acc as any).data); } catch { state = null; }
            
            const vA = state?.baseVault?.toBase58?.() || state?.vaultA?.toBase58?.();
            const vB = state?.quoteVault?.toBase58?.() || state?.vaultB?.toBase58?.();
            
            // Subscribe to vault A with side tracking
            if (vA) {
              try {
                const vpk = new web3.PublicKey(vA);
                const id = await subscribeAccountWithRetry(vpk, handle);
                subs.push({ kind: 'account', id });
                targetedSourceByAccount.set(vA, 'raydium');
                debugLogTargeted('raydium', vA, { kind: 'vault_a' });
                // Track vault side for AMM price calculation
                derivedAccountToPool.set(vA, { 
                  poolId: poolAddr, 
                  accountType: 'vault',
                  vaultSide: 'A',
                  otherVault: vB || undefined
                });
              } catch {}
            }
            
            // Subscribe to vault B with side tracking
            if (vB && vB !== vA) {
              try {
                const vpk = new web3.PublicKey(vB);
                const id = await subscribeAccountWithRetry(vpk, handle);
                subs.push({ kind: 'account', id });
                targetedSourceByAccount.set(vB, 'raydium');
                debugLogTargeted('raydium', vB, { kind: 'vault_b' });
                // Track vault side for AMM price calculation
                derivedAccountToPool.set(vB, { 
                  poolId: poolAddr, 
                  accountType: 'vault',
                  vaultSide: 'B',
                  otherVault: vA || undefined
                });
              } catch {}
            }
            
            logger.info('raydium.amm.attach.complete', { 
              pool: poolAddr.slice(0,8)+'…', 
              vaultA: vA?.slice(0,8)+'…',
              vaultB: vB?.slice(0,8)+'…',
              cat: 'pools' 
            });
          } catch (err) {
            logger.info('raydium.amm.attach.error', { pool: poolAddr.slice(0,8)+'…', error: String(err), cat: 'pools' });
          }
        };

        // Helper: attach Raydium CLMM vault, observation, and tick array accounts for a given CLMM pool address
        const attachRaydiumClmmAccounts = async (poolAddr: string, opts?: { poolAccount?: any }) => {
          try {
            logger.info('raydium.clmm.attach.start', { pool: poolAddr.slice(0,8)+'…', cat: 'pools' });
            const pk = new web3.PublicKey(poolAddr);
            const { withRpcRetry } = await import('../utils/rpcLimiter.js');
            
            // Prefer caller-provided account data to avoid duplicate RPC fetches
            const acc: any = opts?.poolAccount ?? await withRpcRetry(
              () => conn.getAccountInfo(pk, CONFIG.system.txCommitment as any),
              { 
                timeoutMs: 5000,  // 5 second timeout per attempt
                retries: 2,        // 2 retries
                weight: 1,
                module: 'pools',
                method: 'getAccountInfo',
                label: 'raydium.clmm.getAccountInfo'
              }
            ).catch((err) => {
              logger.info('raydium.clmm.attach.rpc_fail', { pool: poolAddr.slice(0,8)+'…', error: String(err), cat: 'pools' });
              return null;
            });
            
            if (!acc || !acc.data) {
              logger.info('raydium.clmm.attach.no_data', { 
                pool: poolAddr.slice(0,8)+'…', 
                hasAcc: !!acc,
                hasData: !!(acc?.data),
                cat: 'pools' 
              });
              return;
            }
            
            const rmod: any = await import('@raydium-io/raydium-sdk-v2').catch(() => null);
            // SDK v2 exports: PoolInfoLayout for CLMM pools
            const clmmLayout = rmod?.PoolInfoLayout || rmod?.Clmm?.PoolInfoLayout || rmod?.AmmV3PoolPersonalPosition || rmod?.PoolState;
            if (!clmmLayout || typeof clmmLayout.decode !== 'function') {
              logger.info('raydium.clmm.attach.no_layout', { 
                pool: poolAddr.slice(0,8)+'…', 
                availableKeys: Object.keys(rmod || {}).filter((k: string) => k.toLowerCase().includes('pool')).slice(0, 5),
                cat: 'pools' 
              });
              return;
            }
            
            let state: any = null;
            try { state = clmmLayout.decode((acc as any).data); } catch {
              logger.info('raydium.clmm.attach.decode_fail', { pool: poolAddr.slice(0,8)+'…', cat: 'pools' });
              return;
            }
            
            // Subscribe to vaults
            const vA = state?.vaultA?.toBase58?.() || state?.tokenVault0?.toBase58?.();
            const vB = state?.vaultB?.toBase58?.() || state?.tokenVault1?.toBase58?.();
            const vaults = Array.from(new Set([vA, vB].filter(Boolean)));
            for (const v of vaults) {
              try {
                const vpk = new web3.PublicKey(v as string);
                const id = await subscribeAccountWithRetry(vpk, handle);
                subs.push({ kind: 'account', id });
                targetedSourceByAccount.set(String(v), 'raydium');
                debugLogTargeted('raydium', String(v), { kind: 'clmm_vault' });
                derivedAccountToPool.set(String(v), { poolId: poolAddr, accountType: 'vault' });
          } catch {}
            }
            
            // Subscribe to observationId
            const obsId = state?.observationId?.toBase58?.() || state?.observationKey?.toBase58?.();
            if (obsId) {
              try {
                const obsPk = new web3.PublicKey(obsId);
                const id = await subscribeAccountWithRetry(obsPk, handle);
                subs.push({ kind: 'account', id });
                targetedSourceByAccount.set(String(obsId), 'raydium');
                debugLogTargeted('raydium', String(obsId), { kind: 'observation' });
                derivedAccountToPool.set(String(obsId), { poolId: poolAddr, accountType: 'observation' });
              } catch {}
            }
            
            // Subscribe to oracle
            const oracle = state?.oracle?.toBase58?.();
            if (oracle) {
              try {
                const oraclePk = new web3.PublicKey(oracle);
                const id = await subscribeAccountWithRetry(oraclePk, handle);
                subs.push({ kind: 'account', id });
                targetedSourceByAccount.set(String(oracle), 'raydium');
                debugLogTargeted('raydium', String(oracle), { kind: 'oracle' });
                derivedAccountToPool.set(String(oracle), { poolId: poolAddr, accountType: 'oracle' });
              } catch {}
            }
            
            // Subscribe to active tick arrays
            const currentTick = state?.tickCurrent ?? state?.tick_current;
            const tickSpacing = state?.tickSpacing ?? state?.tick_spacing;
            if (currentTick !== undefined && tickSpacing) {
              try {
                const clmmProgramId = new web3.PublicKey(String((CONFIG as any)?.raydium?.clmmProgram || 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK'));
                
                for (let offset = -1; offset <= 1; offset++) {
                  try {
                    const startTickIndex = Math.floor(currentTick / (tickSpacing * 60)) + offset;
                    const actualStartTick = startTickIndex * tickSpacing * 60;
                    const startIndexBuffer = Buffer.alloc(4);
                    startIndexBuffer.writeInt32LE(actualStartTick, 0);
                    const [tickArrayPda] = web3.PublicKey.findProgramAddressSync(
                      [Buffer.from('tick_array'), pk.toBuffer(), startIndexBuffer],
                      clmmProgramId
                    );
                    
                    const id = await subscribeAccountWithRetry(tickArrayPda, handle);
                    subs.push({ kind: 'account', id });
                    targetedSourceByAccount.set(tickArrayPda.toBase58(), 'raydium');
                    debugLogTargeted('raydium', tickArrayPda.toBase58(), { kind: 'tick_array', offset });
                    derivedAccountToPool.set(tickArrayPda.toBase58(), { poolId: poolAddr, accountType: 'tick_array' });
                  } catch (err) {
                    logger.info('raydium.clmm.tickarray.subscribe.fail', { pool: poolAddr, offset, error: String((err as any)?.message || err) });
                  }
                }
              } catch (err) {
                logger.info('raydium.clmm.tickarray.derive.fail', { pool: poolAddr, error: String((err as any)?.message || err) });
              }
            }
            
            logger.info('raydium.clmm.attach.complete', { pool: poolAddr.slice(0,8)+'…', cat: 'pools' });
          } catch (err) {
            logger.info('raydium.clmm.attach.error', { pool: poolAddr.slice(0,8)+'…', error: String(err), cat: 'pools' });
          }
        };

        // Helper: attach Raydium CPMM vault accounts for a given CPMM pool address
        // CPMM Program ID: CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C
        const RAYDIUM_CPMM_PROGRAM = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';
        const attachRaydiumCpmmAccounts = async (poolAddr: string, opts?: { poolAccount?: any }) => {
          try {
            logger.info('raydium.cpmm.attach.start', { pool: poolAddr.slice(0,8)+'…', cat: 'pools' });
            const pk = new web3.PublicKey(poolAddr);
            const { withRpcRetry } = await import('../utils/rpcLimiter.js');
            
            // Prefer caller-provided account data to avoid duplicate RPC fetches
            const acc: any = opts?.poolAccount ?? await withRpcRetry(
              () => conn.getAccountInfo(pk, CONFIG.system.txCommitment as any),
              { 
                timeoutMs: 5000,
                retries: 2,
                weight: 1,
                module: 'pools',
                method: 'getAccountInfo',
                label: 'raydium.cpmm.getAccountInfo'
              }
            ).catch((err) => {
              logger.info('raydium.cpmm.attach.rpc_fail', { pool: poolAddr.slice(0,8)+'…', error: String(err), cat: 'pools' });
              return null;
            });
            
            if (!acc || !acc.data) {
              logger.info('raydium.cpmm.attach.no_data', { 
                pool: poolAddr.slice(0,8)+'…', 
                hasAcc: !!acc,
                hasData: !!(acc?.data),
                cat: 'pools' 
              });
              return;
            }
            
            // CPMM pool layout offsets (anchor with 8-byte discriminator)
            // token0Vault at offset 72, token1Vault at offset 104
            const CPMM_TOKEN_0_VAULT_OFFSET = 72;
            const CPMM_TOKEN_1_VAULT_OFFSET = 104;
            const MIN_LENGTH = 136; // Need at least 104 + 32 bytes for both vaults
            
            const data = Buffer.from(acc.data);
            if (data.length < MIN_LENGTH) {
              logger.info('raydium.cpmm.attach.data_too_short', { 
                pool: poolAddr.slice(0,8)+'…', 
                dataLen: data.length,
                required: MIN_LENGTH,
                cat: 'pools' 
              });
              return;
            }
            
            // Extract vault addresses using raw buffer parsing (same as decoder)
            const readPubkey = (buf: Buffer, offset: number): string => {
              try {
                if (offset + 32 > buf.length) return '';
                const slice = buf.slice(offset, offset + 32);
                return new web3.PublicKey(slice).toBase58();
              } catch { return ''; }
            };
            
            const vA = readPubkey(data, CPMM_TOKEN_0_VAULT_OFFSET);
            const vB = readPubkey(data, CPMM_TOKEN_1_VAULT_OFFSET);
            
            // Subscribe to vault A (token0) with side tracking
            if (vA) {
              try {
                const vpk = new web3.PublicKey(vA);
                const id = await subscribeAccountWithRetry(vpk, handle);
                subs.push({ kind: 'account', id });
                targetedSourceByAccount.set(vA, 'raydium-cpmm');
                debugLogTargeted('raydium-cpmm', vA, { kind: 'cpmm_vault_a' });
                // Track vault side for CPMM price calculation
                derivedAccountToPool.set(vA, { 
                  poolId: poolAddr, 
                  accountType: 'vault',
                  vaultSide: 'A',
                  otherVault: vB || undefined
                });
              } catch {}
            }
            
            // Subscribe to vault B (token1) with side tracking
            if (vB && vB !== vA) {
              try {
                const vpk = new web3.PublicKey(vB);
                const id = await subscribeAccountWithRetry(vpk, handle);
                subs.push({ kind: 'account', id });
                targetedSourceByAccount.set(vB, 'raydium-cpmm');
                debugLogTargeted('raydium-cpmm', vB, { kind: 'cpmm_vault_b' });
                // Track vault side for CPMM price calculation
                derivedAccountToPool.set(vB, { 
                  poolId: poolAddr, 
                  accountType: 'vault',
                  vaultSide: 'B',
                  otherVault: vA || undefined
                });
              } catch {}
            }
            
            logger.info('raydium.cpmm.attach.complete', { 
              pool: poolAddr.slice(0,8)+'…', 
              vaultA: vA?.slice(0,8)+'…',
              vaultB: vB?.slice(0,8)+'…',
              cat: 'pools' 
            });
          } catch (err) {
            logger.info('raydium.cpmm.attach.error', { pool: poolAddr.slice(0,8)+'…', error: String(err), cat: 'pools' });
          }
        };

        // Helper: attach Orca Whirlpool vault, oracle, and tick array accounts for a given pool address
        const attachOrcaWhirlpoolAccounts = async (poolAddr: string) => {
          try {
            logger.info('orca.attach.start', { pool: poolAddr.slice(0,8)+'…', cat: 'pools' });
            const pk = new web3.PublicKey(poolAddr);
            const { withRpcRetry } = await import('../utils/rpcLimiter.js');
            
            // Use withRpcRetry which handles rate limiting, timeout, and retries
            const acc: any = await withRpcRetry(
              () => conn.getAccountInfo(pk, CONFIG.system.txCommitment as any),
              { 
                timeoutMs: 5000,  // 5 second timeout per attempt
                retries: 2,        // 2 retries
                weight: 1,
                module: 'pools',
                method: 'getAccountInfo',
                label: 'orca.getAccountInfo'
              }
            ).catch((err) => {
              logger.info('orca.attach.rpc_fail', { pool: poolAddr.slice(0,8)+'…', error: String(err), cat: 'pools' });
              return null;
            });
            
            if (!acc || !acc.data) {
              logger.info('orca.attach.no_data', { pool: poolAddr.slice(0,8)+'…', cat: 'pools' });
              return;
            }
            
            let whirlpoolData: any = null;
            let decoderUsed = 'none';
            
            // ============================================
            // PRIORITY 1: New @orca-so/whirlpools-client (v4.0)
            // ============================================
            let newClient: any = null;
            try {
              newClient = await import('@orca-so/whirlpools-client').catch(() => null);
              if (newClient && typeof (newClient as any).getWhirlpoolDecoder === 'function') {
                const decoder = (newClient as any).getWhirlpoolDecoder();
                const dataBuffer = acc.data instanceof Buffer ? new Uint8Array(acc.data) : acc.data;
                const decoded = decoder.decode(dataBuffer);
                
                if (decoded && decoded.tokenVaultA && decoded.tokenVaultB) {
                  // Oracle is NOT stored in the Whirlpool account - it's a derived PDA
                  // We'll derive it below after parsing the whirlpool data
                  
                  // Convert string addresses to PublicKey objects for compatibility
                  whirlpoolData = {
                    tokenVaultA: new web3.PublicKey(decoded.tokenVaultA),
                    tokenVaultB: new web3.PublicKey(decoded.tokenVaultB),
                    oracle: null, // Will be derived as PDA below
                    tickSpacing: decoded.tickSpacing,
                    tickCurrentIndex: decoded.tickCurrentIndex,
                    tokenMintA: new web3.PublicKey(decoded.tokenMintA),
                    tokenMintB: new web3.PublicKey(decoded.tokenMintB),
                  };
                  decoderUsed = 'new_client';
                  logger.info('orca.attach.new_client_success', { 
                    pool: poolAddr.slice(0,8)+'…', 
                    cat: 'pools' 
                  });
                }
              }
            } catch (newClientErr: any) {
              logger.debug('orca.attach.new_client_fail', { 
                pool: poolAddr.slice(0,8)+'…', 
                error: String(newClientErr?.message || newClientErr),
                cat: 'pools' 
              });
            }
            
            // ============================================
            // PRIORITY 2: Legacy @orca-so/whirlpools-sdk (v0.16)
            // ============================================
            if (!whirlpoolData) {
              const sdkAny: any = await import('@orca-so/whirlpools-sdk').catch(() => null);
              const ParsableWhirlpool = sdkAny?.ParsableWhirlpool;
              
              if (ParsableWhirlpool && typeof ParsableWhirlpool.parse === 'function') {
                try { 
                  whirlpoolData = ParsableWhirlpool.parse(pk, acc);
                  if (whirlpoolData) {
                    decoderUsed = 'legacy_sdk';
                  }
                } catch (err: any) { 
                  logger.debug('orca.attach.legacy_sdk_parse_fail', { 
                    pool: poolAddr.slice(0,8)+'…', 
                    error: String(err?.message || err), 
                    cat: 'pools' 
                  });
                }
              }
            }
            
            // ============================================
            // PRIORITY 3: Manual decoding (fallback)
            // ============================================
            if (!whirlpoolData) {
              try {
                // Manual decode using known offsets
                const data = Buffer.from(acc.data);
                const DISCRIMINATOR = Buffer.from([63, 149, 209, 12, 225, 128, 99, 9]);
                
                if (data.length >= 300 && data.subarray(0, 8).equals(DISCRIMINATOR)) {
                  let offset = 8 + 32 + 1 + 2 + 2 + 2 + 2 + 16 + 16 + 4 + 8 + 8; // = 101
                  const tokenMintA = new web3.PublicKey(data.subarray(offset, offset + 32)); offset += 32;
                  const tokenMintB = new web3.PublicKey(data.subarray(offset, offset + 32)); offset += 32;
                  const tokenVaultA = new web3.PublicKey(data.subarray(offset, offset + 32)); offset += 32;
                  const tokenVaultB = new web3.PublicKey(data.subarray(offset, offset + 32)); offset += 32;
                  
                  // Skip feeGrowthGlobalA(16), feeGrowthGlobalB(16), rewardLastUpdatedTimestamp(8), rewardInfos(384)
                  offset += 16 + 16 + 8 + 384;
                  const oracle = data.length >= offset + 32 
                    ? new web3.PublicKey(data.subarray(offset, offset + 32))
                    : null;
                  
                  // Read tickSpacing and tickCurrentIndex from earlier offsets
                  const tickSpacing = data.readUInt16LE(8 + 32 + 1);
                  const tickCurrentIndex = data.readInt32LE(8 + 32 + 1 + 2 + 2 + 2 + 2 + 16 + 16);
                  
                  whirlpoolData = {
                    tokenVaultA,
                    tokenVaultB,
                    oracle,
                    tickSpacing,
                    tickCurrentIndex,
                    tokenMintA,
                    tokenMintB,
                  };
                  decoderUsed = 'manual';
                  logger.info('orca.attach.manual_decode_success', { 
                    pool: poolAddr.slice(0,8)+'…', 
                    cat: 'pools' 
                  });
                }
              } catch (manualErr: any) {
                logger.debug('orca.attach.manual_decode_fail', { 
                  pool: poolAddr.slice(0,8)+'…', 
                  error: String(manualErr?.message || manualErr),
                  cat: 'pools' 
                });
              }
            }
            
            if (!whirlpoolData) {
              logger.info('orca.attach.all_decoders_failed', { pool: poolAddr.slice(0,8)+'…', cat: 'pools' });
              return;
            }
            
            logger.info('orca.attach.parsed', { 
              pool: poolAddr.slice(0,8)+'…', 
              decoder: decoderUsed,
              hasTokenVaultA: !!whirlpoolData?.tokenVaultA,
              hasTokenVaultB: !!whirlpoolData?.tokenVaultB,
              hasOracle: !!whirlpoolData?.oracle,
              hasTickSpacing: whirlpoolData?.tickSpacing !== undefined,
              hasTickCurrentIndex: whirlpoolData?.tickCurrentIndex !== undefined,
              cat: 'pools' 
            });
            
            // Note: We use manual PDA derivation for tick arrays instead of the SDK
            // The SDK import can fail with "Account not found: AdaptiveFeeTier" for some pools
            // Manual derivation is more reliable and doesn't require network calls during import

            // Subscribe to vaults
            const vaultA = whirlpoolData?.tokenVaultA;
            const vaultB = whirlpoolData?.tokenVaultB;
            const vaults = [vaultA, vaultB].filter(Boolean);
            logger.info('orca.vaults.attempting', { pool: poolAddr.slice(0,8)+'…', count: vaults.length, hasA: !!vaultA, hasB: !!vaultB, cat: 'pools' });
            for (const vault of vaults) {
              try {
                const id = await subscribeAccountWithRetry(vault, handle);
                subs.push({ kind: 'account', id });
                targetedSourceByAccount.set(vault.toBase58(), 'orca');
                debugLogTargeted('orca', vault.toBase58(), { kind: 'vault' });
                derivedAccountToPool.set(vault.toBase58(), { poolId: poolAddr, accountType: 'vault' });
                logger.info('orca.vault.subscribed', { pool: poolAddr.slice(0,8)+'…', vault: vault.toBase58().slice(0,8)+'…', cat: 'pools' });
              } catch (err) {
                logger.info('orca.vault.subscribe.fail', { pool: poolAddr.slice(0,8)+'…', error: String(err), cat: 'pools' });
              }
            }
            
            // Get Orca program ID for PDA derivations
            const orcaProgramId = new web3.PublicKey(String(CONFIG.orca?.programId || 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc'));
            
            // Subscribe to oracle - it's a derived PDA, not a field in the Whirlpool account
            // The Oracle PDA is derived using seeds: ["oracle", whirlpool_address]
            try {
              let oraclePk: any = null;
              
              // Try using new client's getOracleAddress function
              if (newClient && typeof (newClient as any).getOracleAddress === 'function') {
                try {
                  const oracleResult = await (newClient as any).getOracleAddress(poolAddr);
                  if (oracleResult && oracleResult[0]) {
                    oraclePk = new web3.PublicKey(oracleResult[0]);
                  }
                } catch {}
              }
              
              // Fallback: derive Oracle PDA manually
              if (!oraclePk) {
                try {
                  const [derivedOracle] = web3.PublicKey.findProgramAddressSync(
                    [Buffer.from('oracle'), pk.toBuffer()],
                    orcaProgramId
                  );
                  oraclePk = derivedOracle;
                } catch {}
              }
              
              if (oraclePk) {
                const id = await subscribeAccountWithRetry(oraclePk, handle);
                subs.push({ kind: 'account', id });
                targetedSourceByAccount.set(oraclePk.toBase58(), 'orca');
                debugLogTargeted('orca', oraclePk.toBase58(), { kind: 'oracle' });
                derivedAccountToPool.set(oraclePk.toBase58(), { poolId: poolAddr, accountType: 'oracle' });
                logger.info('orca.oracle.subscribed', { pool: poolAddr.slice(0,8)+'…', oracle: oraclePk.toBase58().slice(0,8)+'…', cat: 'pools' });
              } else {
                logger.info('orca.oracle.derive_failed', { pool: poolAddr.slice(0,8)+'…', cat: 'pools' });
              }
            } catch (err) {
              logger.info('orca.oracle.subscribe.fail', { pool: poolAddr.slice(0,8)+'…', error: String(err), cat: 'pools' });
            }
            
            // Subscribe to active tick arrays
            const tickSpacing = whirlpoolData?.tickSpacing;
            const currentTick = whirlpoolData?.tickCurrentIndex;
            logger.info('orca.tickarrays.attempting', { pool: poolAddr.slice(0,8)+'…', tickSpacing, currentTick, cat: 'pools' });
            
            // Helper: Calculate start tick index manually (same logic as TickUtil.getStartTickIndex)
            const getStartTickIndexManual = (tick: number, spacing: number, offset: number): number => {
              const ticksInArray = spacing * 88; // TICK_ARRAY_SIZE = 88
              let startTickIndex = Math.floor(tick / ticksInArray) * ticksInArray;
              if (offset !== 0) {
                startTickIndex += offset * ticksInArray;
              }
              return startTickIndex;
            };
            
            // Helper: Derive tick array PDA manually
            const deriveTickArrayPda = (programId: any, whirlpoolPk: any, startTick: number): any => {
              try {
                const startTickBuffer = Buffer.alloc(4);
                startTickBuffer.writeInt32LE(startTick, 0);
                const [pda] = web3.PublicKey.findProgramAddressSync(
                  [Buffer.from('tick_array'), whirlpoolPk.toBuffer(), startTickBuffer],
                  programId
                );
                return pda;
              } catch {
                return null;
              }
            };
            
            if (tickSpacing !== undefined && currentTick !== undefined) {
              try {
                let tickArrayCount = 0;
                const tickArrayAddresses: { lower?: string; center?: string; upper?: string } = {};

                for (let offset = -1; offset <= 1; offset++) {
                  try {
                    // Use manual derivation (more reliable than SDK which can fail on import)
                    const startTick = getStartTickIndexManual(currentTick, tickSpacing, offset);
                    const tickArrayPk = deriveTickArrayPda(orcaProgramId, pk, startTick);

                    if (tickArrayPk) {
                      const id = await subscribeAccountWithRetry(tickArrayPk, handle);
                      subs.push({ kind: 'account', id });
                      targetedSourceByAccount.set(tickArrayPk.toBase58(), 'orca');
                      debugLogTargeted('orca', tickArrayPk.toBase58(), { kind: 'tick_array', offset });
                      derivedAccountToPool.set(tickArrayPk.toBase58(), { poolId: poolAddr, accountType: 'tick_array' });
                      
                      // Store tick array address by offset
                      const address = tickArrayPk.toBase58();
                      if (offset === -1) tickArrayAddresses.lower = address;
                      else if (offset === 0) tickArrayAddresses.center = address;
                      else if (offset === 1) tickArrayAddresses.upper = address;
                      
                      tickArrayCount++;
                    }
                  } catch (err) {
                    logger.info('orca.whirlpool.tickarray.subscribe.fail', { pool: poolAddr, offset, error: String((err as any)?.message || err) });
                  }
                }
                
                // Cache tick array addresses in execution cache
                // Include tickSpacing for boundary crossing detection
                if (tickArrayCount > 0) {
                  try {
                    const { executionCache } = await import('../execution/cache.js');
                    const existing = executionCache.getHot(poolAddr);
                    executionCache.setHot(poolAddr, {
                      ...existing,
                      tickSpacing,
                      currentTickIndex: currentTick,
                      tickArrays: tickArrayAddresses
                    });
                    
                    logger.info('orca.tickarrays.cached', { 
                      pool: poolAddr.slice(0,8)+'…', 
                      count: tickArrayCount,
                      lower: tickArrayAddresses.lower?.slice(0,8) + '…',
                      center: tickArrayAddresses.center?.slice(0,8) + '…',
                      upper: tickArrayAddresses.upper?.slice(0,8) + '…',
                      cat: 'pools' 
                    });
                  } catch {}
                }
                
                logger.info('orca.tickarrays.subscribed', { pool: poolAddr.slice(0,8)+'…', count: tickArrayCount, cat: 'pools' });
              } catch (err) {
                logger.info('orca.whirlpool.tickarray.derive.fail', { pool: poolAddr, error: String((err as any)?.message || err) });
              }
            } else {
              logger.info('orca.tickarrays.skipped', { pool: poolAddr.slice(0,8)+'…', reason: !tickSpacing ? 'no_spacing' : 'no_tick', cat: 'pools' });
            }
            
            logger.info('orca.attach.complete', { pool: poolAddr.slice(0,8)+'…', cat: 'pools' });
          } catch (err) {
            logger.info('orca.attach.error', { pool: poolAddr.slice(0,8)+'…', error: String(err), cat: 'pools' });
          }
        };

        // Helper: attach Meteora DLMM reserve accounts (reserveX, reserveY) and oracle for a given pool address
        // OPTIMIZED: Use SDK derivation without RPC fetch!
        const attachMeteoraReserves = async (poolAddr: string) => {
          try {
            logger.info('meteora.attach.start.reserves_only', { 
              pool: poolAddr.slice(0,8)+'…', 
              strategy: 'option1_no_bin_arrays',
              cat: 'pools' 
            });
            const pk = new web3.PublicKey(poolAddr);
            const program = ensureMeteoraProgram();
            if (!program) {
              logger.info('meteora.attach.no_program', { pool: poolAddr.slice(0,8)+'…', cat: 'pools' });
              return;
            }
            const programId = program.programId;
            
            // NO RPC FETCH NEEDED - Pure SDK derivation!
            const DLMM: any = await import('@meteora-ag/dlmm').catch(() => null);
            const deriveReserve = DLMM?.DLMM?.deriveReserve;
            
            if (typeof deriveReserve === 'function') {
              try {
                // Derive reserveX (deterministic, no RPC)
                const rxResult = await deriveReserve(programId, pk, true);
                const reserveX = rxResult?.publicKey || rxResult;
                if (reserveX) {
                  const id = await subscribeAccountWithRetry(reserveX, handle);
                  subs.push({ kind: 'account', id });
                  targetedSourceByAccount.set(reserveX.toBase58(), 'meteora');
                  debugLogTargeted('meteora', reserveX.toBase58(), { kind: 'reserveX' });
                  derivedAccountToPool.set(reserveX.toBase58(), { poolId: poolAddr, accountType: 'reserve' });
                  logger.info('meteora.reserve.x.subscribed', { pool: poolAddr.slice(0,8)+'…', reserve: reserveX.toBase58().slice(0,8)+'…', cat: 'pools' });
                }
              } catch (err) {
                try { logger.info('meteora.reserve.x.subscribe.fail', { pool: poolAddr, error: String((err as any)?.message || err) }); } catch {}
              }
              
              try {
                // Derive reserveY (deterministic, no RPC)
                const ryResult = await deriveReserve(programId, pk, false);
                const reserveY = ryResult?.publicKey || ryResult;
                if (reserveY) {
                  const id = await subscribeAccountWithRetry(reserveY, handle);
                  subs.push({ kind: 'account', id });
                  targetedSourceByAccount.set(reserveY.toBase58(), 'meteora');
                  debugLogTargeted('meteora', reserveY.toBase58(), { kind: 'reserveY' });
                  derivedAccountToPool.set(reserveY.toBase58(), { poolId: poolAddr, accountType: 'reserve' });
                  logger.info('meteora.reserve.y.subscribed', { pool: poolAddr.slice(0,8)+'…', reserve: reserveY.toBase58().slice(0,8)+'…', cat: 'pools' });
                }
              } catch (err) {
                try { logger.info('meteora.reserve.y.subscribe.fail', { pool: poolAddr, error: String((err as any)?.message || err) }); } catch {}
              }
            }
            
            // Derive oracle (deterministic, no RPC)
            const deriveOracle = DLMM?.DLMM?.deriveOracle;
            if (typeof deriveOracle === 'function') {
              try {
                const oracleResult = await deriveOracle(programId, pk);
                const oracle = oracleResult?.publicKey || oracleResult;
                if (oracle) {
                  const id = await subscribeAccountWithRetry(oracle, handle);
                  subs.push({ kind: 'account', id });
                  targetedSourceByAccount.set(oracle.toBase58(), 'meteora');
                  debugLogTargeted('meteora', oracle.toBase58(), { kind: 'oracle' });
                  derivedAccountToPool.set(oracle.toBase58(), { poolId: poolAddr, accountType: 'oracle' });
                  logger.info('meteora.oracle.subscribed', { pool: poolAddr.slice(0,8)+'…', oracle: oracle.toBase58().slice(0,8)+'…', cat: 'pools' });
                }
              } catch (err) {
                try { logger.info('meteora.oracle.subscribe.fail', { pool: poolAddr, error: String((err as any)?.message || err) }); } catch {}
              }
            }
            
            logger.info('meteora.attach.complete', { pool: poolAddr.slice(0,8)+'…', cat: 'pools' });
          } catch (err) {
            logger.info('meteora.attach.error', { pool: poolAddr.slice(0,8)+'…', error: String(err), cat: 'pools' });
          }
        };

        // Check if sequential mode is enabled (used during retarget to avoid RPC burst)
        const isSequentialMode = suppressInitialOnce === true && !!(startPoolWebsocketsOnlyOnce as any).__sequentialMode;
        const staggerDelayMs = isSequentialMode ? Number((CONFIG.system as any)?.wsRetargetStaggerMs || 3000) : 0;
        
        if (isSequentialMode) {
          logger.info('pools.ws sequential.mode', { enabled: true, staggerMs: staggerDelayMs, cat: 'pools' });
        }

        // Subscribe to Orca Whirlpool POOL accounts only: prefer graph edge pool ids, else derive PDAs from watchlist
        // CRITICAL: Check if Orca is enabled in dex source control before subscribing
        const orcaEnabled = (() => {
          try {
            const configSources = (CONFIG.system as any)?.enabledDexSources || {};
            return configSources.orca !== false;
          } catch {
            return true; // Default to enabled if no config
          }
        })();
        
        if (!orcaEnabled) {
          try { logger.info('pools.ws dex.subscribe.skipped', { dex: 'orca', reason: 'disabled_in_source_control', cat: 'pools' }); } catch {}
        } else {
        logger.info('pools.ws dex.subscribe.start', { dex: 'orca', sequential: isSequentialMode, cat: 'pools' });
        try {
          const { PublicKey } = web3;
          const sdkAny: any = await import('@orca-so/whirlpools-sdk').catch(() => null);
          const PDAUtil = sdkAny?.PDAUtil;
          const programId = new PublicKey(String(CONFIG.orca?.programId));
          const configPk = new PublicKey(String(CONFIG.orca?.configPubkey));
          const wl = await readJson<any[]>(CONFIG.watchlistPath, []);
          // Build target set from current graph snapshot edges
          // In lazy activation mode, use cache directly (graph is empty until pools activate)
          const edgePoolIds = new Set<string>();
          if (isLazyActivationEnabled()) {
            try {
              for (const p of (orcaCache.data?.clmm || [])) {
                if (p?.id && isValidPublicKey(String(p.id))) {
                  edgePoolIds.add(String(p.id));
                }
              }
              if (edgePoolIds.size > 0) {
                try { logger.info('pools.ws targets.orca from cache (lazy mode)', { size: edgePoolIds.size }); } catch {}
              }
            } catch {}
          } else {
            // Force a fresh snapshot to ensure we have the fully filtered graph
            try {
              const gmod: any = await import('./graph.js');
              const snap = await gmod.getGraphSnapshot(true);
              for (const e of (snap?.edges || [])) {
                const dex = String((e as any)?.dex || '');
                if (dex !== 'Orca') continue;
                const pid = String((e as any)?.pool_id || '');
                if (pid) {
                  const base = pid.replace(/[#-]rev$/,'');
                  // Only add valid PublicKey addresses (filter out synthetic IDs like "mintA->mintB-Dex")
                  if (isValidPublicKey(base)) {
                    edgePoolIds.add(base);
                  }
                }
              }
              try { logger.info('pools.ws targets.orca from graph', { size: edgePoolIds.size }); } catch {}
            } catch {}
          }
          const SOL = 'So11111111111111111111111111111111111111112';
          const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
          const tickSpacings = [8, 16, 32, 64, 128, 256];
          let uniq: string[] = [];
          if (edgePoolIds.size > 0) {
            uniq = Array.from(edgePoolIds);
            targetedWsActive = true;
          } else if (!isLazyActivationEnabled()) {
            // If no graph edges found, retry with fresh snapshot (like Meteora does)
            // This handles the case where subscriptions start before graph is fully built
            // Skip retries in lazy mode - graph is intentionally empty
            const maxRetries = Math.max(1, Number(((CONFIG.system as any)?.orcaWsRetryCount) || 2));
            const delayMs = Math.max(200, Number(((CONFIG.system as any)?.orcaWsRetryDelayMs) || 600));
            for (let i = 0; i < maxRetries && edgePoolIds.size === 0; i++) {
              try {
                const gmod: any = await import('./graph.js');
                const snap = await gmod.getGraphSnapshot(true);
                for (const e of (snap?.edges || [])) {
                  const dex = String((e as any)?.dex || '');
                  if (dex !== 'Orca') continue;
                  const pid = String((e as any)?.pool_id || '');
                  if (pid) {
                    const base = pid.replace(/[#-]rev$/,'');
                    if (isValidPublicKey(base)) {
                      edgePoolIds.add(base);
                    }
                  }
                }
                if (edgePoolIds.size > 0) {
                  uniq = Array.from(edgePoolIds);
                  targetedWsActive = true;
                  try { logger.info('pools.ws targets.orca from graph (retry)', { size: uniq.length, attempt: i + 1 }); } catch {}
                  break;
                }
              } catch {}
              if (edgePoolIds.size === 0 && i < maxRetries - 1) {
                await new Promise(r => setTimeout(r, delayMs));
              }
            }
          }
            
          // Only fallback to watchlist derivation if graph still has no Orca pools after retries
          // This should rarely happen if graph is properly built (or in lazy mode with empty cache)
          if (uniq.length === 0) {
              try { logger.warn('pools.ws targets.orca no graph edges, using watchlist fallback', { cat: 'pools' }); } catch {}
              const pairs: Array<[string, string]> = [];
              const watchMints: string[] = Array.from(new Set(wl.map((t: any) => (typeof t === 'string' ? t : t?.id)).filter(Boolean)));
              for (const m of watchMints.slice(0, 100)) { if (m !== USDC) pairs.push([m, USDC]); if (m !== SOL) pairs.push([m, SOL]); }
              pairs.push([SOL, USDC]);
              const poolAddrs: string[] = [];
              if (PDAUtil) {
                for (const [a, b] of pairs) {
                  const [mintA, mintB] = String(a) < String(b) ? [a, b] : [b, a];
                  for (const ts of tickSpacings) {
                    try {
                      const pda = PDAUtil.getWhirlpool(programId, configPk, new PublicKey(mintA), new PublicKey(mintB), ts);
                      poolAddrs.push(pda.publicKey.toBase58());
                    } catch {}
                  }
                }
              }
              uniq = Array.from(new Set(poolAddrs));
          }
          const startTsOrca = Date.now();
          let attached = 0;
          // Rate-limit new attachments per second based on config
          // During retarget (sequential mode), use slower rate to avoid overwhelming RPC limiter
          const basePerSec = Math.max(1, Number(((CONFIG.system as any)?.wsAttachPerSec) || 10));
          const perSec = isSequentialMode 
            ? Math.max(1, Number((CONFIG.system as any)?.wsRetargetAttachPerSec || Math.floor(basePerSec / 2)))
            : basePerSec;
          const intervalMs = Math.floor(1000 / perSec);
          const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
          logger.info('pools.ws orca.loop.start', { 
            poolCount: uniq.length, 
            rateLimit: `${perSec}/sec`, 
            intervalMs, 
            sequential: isSequentialMode,
            cat: 'pools' 
          });
          for (let i = 0; i < uniq.length; i++) {
            const addr = uniq[i];
            logger.info('pools.ws orca.pool.processing', { index: i, total: uniq.length, pool: addr.slice(0,8)+'…', cat: 'pools' });
            try {
              const pk = new PublicKey(addr);
              const id = await subscribeAccountWithRetry(pk, handle);
              subs.push({ kind: 'account', id }); attached++;
              try {
                const acct = pk.toBase58();
                targetedSourceByAccount.set(acct, 'orca');
                debugLogTargeted('orca', acct, { kind: 'pool' });
                logger.info('pools.ws orca.pool.subscribed', { index: i, pool: addr.slice(0,8)+'…', cat: 'pools' });
              } catch {}
              // Attach Orca Whirlpool vault, oracle, and tick array listeners
              // Await to respect rate limiter (additional attachments also consume WS attach slots)
              await attachOrcaWhirlpoolAccounts(addr).catch((err) => {
                try { logger.info('orca.attach.fail', { pool: addr.slice(0,8)+'…', error: String(err?.message || err), stack: err?.stack }); } catch {}
              });
              logger.info('pools.ws orca.pool.attached', { index: i, pool: addr.slice(0,8)+'…', cat: 'pools' });
            } catch {}
            if (i < uniq.length - 1 && intervalMs > 0) { await sleep(intervalMs); }
            logger.info('pools.ws orca.pool.complete', { index: i, pool: addr.slice(0,8)+'…', cat: 'pools' });
          }
          attachedOrcaPools = attached;
          logger.info('pools.ws subscribe orca.pools', { attached, target: uniq.length, source: 'orca', ms: Date.now() - startTsOrca });
          // Subscribe at program level only if we had no targeted addresses and explicit fallback is allowed
          if (attached === 0 && !!((CONFIG.system as any)?.wsFallbackPrograms) && ((CONFIG.system as any)?.wsFallbackAllowZeroTargets === true)) {
            try { logger.info('pools.ws subscribe orca(program)', { source: 'orca', cat: 'pools' }); } catch {}
            {
              const id = await subscribeProgramWithRetry(orcaProg, (ch: any) => handle(ch.accountId, ch.accountInfo));
              subs.push({ kind: 'program', id });
            }
          }
        } catch (e:any) {
          logger.warn('pools.ws orca address subscribe failed', { error: String(e?.message || e) });
          // Fallback to program-level subscription (may include non-pool accounts) only when explicitly allowed
          if (!!((CONFIG.system as any)?.wsFallbackPrograms) && ((CONFIG.system as any)?.wsFallbackAllowZeroTargets === true)) {
            try { logger.info('pools.ws subscribe orca(fallback)', { source: 'orca', cat: 'pools' }); } catch {}
            {
              const id = await subscribeProgramWithRetry(orcaProg, (ch: any) => handle(ch.accountId, ch.accountInfo));
              subs.push({ kind: 'program', id });
            }
          }
        }
        } // End of orcaEnabled check
        // Stagger delay between DEX sources in sequential mode to avoid RPC burst
        if (isSequentialMode && staggerDelayMs > 0) {
          logger.info('pools.ws sequential.stagger', { 
            afterDex: 'orca', 
            beforeDex: 'raydium', 
            delayMs: staggerDelayMs, 
            cat: 'pools' 
          });
          await new Promise(r => setTimeout(r, staggerDelayMs));
        }
        
        // Raydium address-level subscriptions when we have known pool ids (from prior refresh)
        // CRITICAL: Check if Raydium is enabled in dex source control before subscribing
        const raydiumEnabled = (() => {
          try {
            const configSources = (CONFIG.system as any)?.enabledDexSources || {};
            return configSources.raydium !== false;
          } catch {
            return true; // Default to enabled if no config
          }
        })();
        
        if (!raydiumEnabled) {
          try { logger.info('pools.ws dex.subscribe.skipped', { dex: 'raydium', reason: 'disabled_in_source_control', cat: 'pools' }); } catch {}
        } else {
        logger.info('pools.ws dex.subscribe.start', { dex: 'raydium', sequential: isSequentialMode, cat: 'pools' });
        try {
          // Prefer graph edge pool ids if available
          // In lazy activation mode, use cache directly (graph is empty until pools activate)
          const edgePoolIds = new Set<string>();
          if (!isLazyActivationEnabled()) {
            try {
              const gmod: any = await import('./graph.js');
              const snap = await gmod.getGraphSnapshot(false);
              for (const e of (snap?.edges || [])) {
                const dex = String((e as any)?.dex || '');
                if (dex !== 'Raydium') continue;
                const pid = String((e as any)?.pool_id || '');
                if (pid) {
                  const base = pid.replace(/[#-]rev$/,'');
                  // Only add valid PublicKey addresses (filter out synthetic IDs like "mintA->mintB-Dex")
                  if (isValidPublicKey(base)) {
                    edgePoolIds.add(base);
                  }
                }
              }
              try { logger.info('pools.ws targets.raydium from graph', { size: edgePoolIds.size }); } catch {}
            } catch {}
          }
          const rayKnown: string[] = [];
          let ammCount = 0, clmmCount = 0, cpmmCount = 0;
          try { for (const p of (raydiumCache.data?.amm || [])) if (p?.id) { rayKnown.push(String(p.id)); ammCount++; } } catch {}
          try { for (const p of (raydiumCache.data?.clmm || [])) if (p?.id) { rayKnown.push(String(p.id)); clmmCount++; } } catch {}
          try { for (const p of (cpmmCache.data?.cpmm || [])) if (p?.id) { rayKnown.push(String(p.id)); cpmmCount++; } } catch {}
          const startTsRay = Date.now();
          
          // Log CPMM cache status for debugging
          logger.info('pools.ws raydium.cpmm_cache_status', {
            cpmmCacheExists: !!cpmmCache.data,
            cpmmPoolCount: cpmmCache.data?.cpmm?.length || 0,
            cpmmCountAdded: cpmmCount,
            cat: 'pools'
          });
          
          // In lazy mode, edgePoolIds will be empty so we'll use rayKnown (cache)
          // IMPORTANT: Always include CPMM pools from cache even in non-lazy mode
          // since they may not be in graph edges yet
          let base: string[];
          if (edgePoolIds.size > 0) {
            // Merge graph edges with CPMM pools from cache
            const cpmmPoolIds = (cpmmCache.data?.cpmm || []).map(p => p?.id).filter(Boolean) as string[];
            base = [...Array.from(edgePoolIds), ...cpmmPoolIds];
            logger.info('pools.ws targets.raydium merged', { 
              fromGraph: edgePoolIds.size,
              cpmmFromCache: cpmmPoolIds.length,
              total: base.length,
              cat: 'pools'
            });
          } else {
            base = rayKnown;
          }
          
          if (isLazyActivationEnabled() && rayKnown.length > 0) {
            try { logger.info('pools.ws targets.raydium from cache (lazy mode)', { 
              size: rayKnown.length, 
              amm: ammCount, 
              clmm: clmmCount, 
              cpmm: cpmmCount,
              cat: 'pools' 
            }); } catch {}
          }
          const uniqueRay = Array.from(new Set(base.filter(Boolean)));
          let attachedRay = 0;
          attachedRaydiumCpmmPools = 0; // Reset CPMM counter before loop
          // Rate-limit new attachments per second based on config
          // During retarget (sequential mode), use slower rate to avoid overwhelming RPC limiter
          const basePerSecRay = Math.max(1, Number(((CONFIG.system as any)?.wsAttachPerSec) || 10));
          const perSecRay = isSequentialMode 
            ? Math.max(1, Number((CONFIG.system as any)?.wsRetargetAttachPerSec || Math.floor(basePerSecRay / 2)))
            : basePerSecRay;
          const intervalMsRay = Math.floor(1000 / perSecRay);
          const sleepRay = (ms: number) => new Promise(r => setTimeout(r, ms));
          logger.info('pools.ws raydium.loop.start', { 
            poolCount: uniqueRay.length, 
            rateLimit: `${perSecRay}/sec`, 
            intervalMs: intervalMsRay, 
            sequential: isSequentialMode,
            cat: 'pools' 
          });
          
          // CRITICAL: Pre-populate vault balance cache for CPMM pools before subscribing to WebSocket
          // This ensures pool events can decode immediately without waiting for vault events
          if ((cpmmCache.data?.cpmm || []).length > 0) {
            await preloadRaydiumCpmmVaultCache();
          }
          
          for (let i = 0; i < uniqueRay.length; i++) {
            const addr = uniqueRay[i];
            try {
              const pk = new web3.PublicKey(addr);
              const id = await subscribeAccountWithRetry(pk, handle);
              subs.push({ kind: 'account', id }); attachedRay++;
              try {
                const acct = pk.toBase58();
                targetedSourceByAccount.set(acct, 'raydium');
                debugLogTargeted('raydium', acct, { kind: 'pool' });
              } catch {}
              // Detect pool type (AMM vs CLMM) and attach appropriate accounts
              // Check account owner to determine pool type
              try {
                const { withRpcLimit } = await import('../utils/rpcLimiter.js');
                const poolAcc: any = await withRpcLimit(
                  () => conn.getAccountInfo(pk, CONFIG.system.txCommitment as any),
                  1,
                  { module: 'pools', method: 'getAccountInfo' }
                );
                if (poolAcc) {
                  const owner = poolAcc.owner?.toBase58?.();
                  const rayAmmOwner = rayAmm.toBase58();
                  const rayClmmOwner = rayClmm.toBase58();
                  const rayCpmmOwner = rayCpmm.toBase58();
                  
                  if (owner === rayClmmOwner) {
                    // CLMM pool: attach vaults, observation, tick arrays
                    await attachRaydiumClmmAccounts(addr, { poolAccount: poolAcc }).catch((err) => {
                      try { logger.info('raydium.clmm.attach.fail', { pool: addr.slice(0,8)+'…', error: String(err?.message || err) }); } catch {}
                    });
                  } else if (owner === rayAmmOwner) {
                    // AMM pool: attach vaults
                    await attachRaydiumAmmVaults(addr, { poolAccount: poolAcc }).catch((err) => {
                      try { logger.info('raydium.amm.attach.fail', { pool: addr.slice(0,8)+'…', error: String(err?.message || err) }); } catch {}
                    });
                  } else if (owner === rayCpmmOwner) {
                    // CPMM pool: attach vaults
                    logger.info('raydium.cpmm.attach.detected', { pool: addr.slice(0,8)+'…', cat: 'pools' });
                    attachedRaydiumCpmmPools++;
                    await attachRaydiumCpmmAccounts(addr, { poolAccount: poolAcc }).catch((err) => {
                      try { logger.info('raydium.cpmm.attach.fail', { pool: addr.slice(0,8)+'…', error: String(err?.message || err) }); } catch {}
                    });
                  } else {
                    // Unknown type, try AMM first (more common)
                    logger.debug('raydium.pool.unknown_owner', { pool: addr.slice(0,8)+'…', owner: owner?.slice(0,8)+'…', cat: 'pools' });
                    await attachRaydiumAmmVaults(addr, { poolAccount: poolAcc }).catch((err) => {
                      try { logger.info('raydium.unknown.attach.fail', { pool: addr.slice(0,8)+'…', error: String(err?.message || err) }); } catch {}
                    });
                  }
                } else {
                  // Pool account fetch returned null - account may not exist or RPC rate limited
                  logger.info('raydium.pool.fetch_null', { pool: addr.slice(0,8)+'…', cat: 'pools' });
                }
              } catch (fetchErr: any) {
                // Fallback: try AMM first when pool type detection fails
                logger.info('raydium.pool.fetch_error', { pool: addr.slice(0,8)+'…', error: String(fetchErr?.message || fetchErr), cat: 'pools' });
                await attachRaydiumAmmVaults(addr).catch((err) => {
                  try { logger.info('raydium.attach.fallback.fail', { pool: addr.slice(0,8)+'…', error: String(err?.message || err) }); } catch {}
                });
              }
            } catch {}
            if (i < uniqueRay.length - 1 && intervalMsRay > 0) { await sleepRay(intervalMsRay); }
          }
          attachedRaydiumPools = attachedRay;
          logger.info('pools.ws subscribe raydium.pools', { 
            attached: attachedRay, 
            cpmm: attachedRaydiumCpmmPools,
            target: uniqueRay.length, 
            ms: Date.now() - startTsRay 
          });
          // Fallback to program-level if none attached and explicit fallback is allowed
          if (attachedRay === 0 && !!((CONFIG.system as any)?.wsFallbackPrograms) && ((CONFIG.system as any)?.wsFallbackAllowZeroTargets === true)) {
            try { logger.info('pools.ws subscribe raydium.amm(fallback)', { source: 'raydium', cat: 'pools' }); } catch {}
            {
              const idA = await subscribeProgramWithRetry(rayAmm, (ch: any) => handle(ch.accountId, ch.accountInfo));
              subs.push({ kind: 'program', id: idA });
            }
            try { logger.info('pools.ws subscribe raydium.clmm(fallback)', { source: 'raydium', cat: 'pools' }); } catch {}
            {
              const idC = await subscribeProgramWithRetry(rayClmm, (ch: any) => handle(ch.accountId, ch.accountInfo));
              subs.push({ kind: 'program', id: idC });
            }
          }
        } catch {}
        } // End of raydiumEnabled check
        
        // Stagger delay between DEX sources in sequential mode to avoid RPC burst
        if (isSequentialMode && staggerDelayMs > 0) {
          logger.info('pools.ws sequential.stagger', { 
            afterDex: 'raydium', 
            beforeDex: 'meteora', 
            delayMs: staggerDelayMs, 
            cat: 'pools' 
          });
          await new Promise(r => setTimeout(r, staggerDelayMs));
        }
        
        // Meteora targeted subscriptions from graph edges. Fallback to cached pools if graph doesn't have edges yet.
        // CRITICAL: Check if Meteora is enabled in dex source control before subscribing
        const meteoraEnabled = (() => {
          try {
            const configSources = (CONFIG.system as any)?.enabledDexSources || {};
            return configSources.meteora !== false;
          } catch {
            return true; // Default to enabled if no config
          }
        })();
        
        if (!meteoraEnabled) {
          try { logger.info('pools.ws dex.subscribe.skipped', { dex: 'meteora', reason: 'disabled_in_source_control', cat: 'pools' }); } catch {}
        } else {
        logger.info('pools.ws dex.subscribe.start', { dex: 'meteora', sequential: isSequentialMode, cat: 'pools' });
        try {
          const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
          
          // Build target set: prefer graph edges, fallback to cached pools (like Raydium does)
          let meteoraPoolIds = Array.from(meteoraTargets);
          if (meteoraPoolIds.length === 0) {
            // Fallback to cached pool IDs
            const meteoraKnown: string[] = [];
            try { for (const p of (meteoraCache.data?.clmm || [])) if (p?.id) meteoraKnown.push(String(p.id)); } catch {}
            meteoraPoolIds = meteoraKnown;
            if (meteoraPoolIds.length > 0) {
              try { logger.info('pools.ws targets.meteora from cache', { size: meteoraPoolIds.length }); } catch {}
              // Also update meteoraTargets Set so handle() closure can recognize events
              for (const id of meteoraPoolIds) { meteoraTargets.add(id); }
            }
          }
          
          const attachMeteora = async (targetIds: string[]): Promise<number> => {
            const startTs = Date.now();
            let attached = 0;
            let failed = 0;
            const edgeIds: string[] = targetIds;
            // Rate-limit new attachments per second based on config
            // During retarget (sequential mode), use slower rate to avoid overwhelming RPC limiter
            const basePerSecMet = Math.max(1, Number(((CONFIG.system as any)?.wsAttachPerSec) || 10));
            const perSecMet = isSequentialMode 
              ? Math.max(1, Number((CONFIG.system as any)?.wsRetargetAttachPerSec || Math.floor(basePerSecMet / 2)))
              : basePerSecMet;
            const intervalMsMet = Math.floor(1000 / perSecMet);
            const sleepMet = (ms: number) => new Promise(r => setTimeout(r, ms));
            logger.info('pools.ws meteora.loop.start', { 
              poolCount: edgeIds.length, 
              rateLimit: `${perSecMet}/sec`, 
              intervalMs: intervalMsMet, 
              sequential: isSequentialMode,
              cat: 'pools' 
            });
            for (let i = 0; i < edgeIds.length; i++) {
              const addr = edgeIds[i];
              try {
                const pk = new web3.PublicKey(addr);
                const id = await subscribeAccountWithRetry(pk, handle);
                subs.push({ kind: 'account', id }); attached++;
                try {
                  const acct = pk.toBase58();
                  targetedSourceByAccount.set(acct, 'meteora');
                  debugLogTargeted('meteora', acct, { kind: 'pool' });
                } catch {}
                // Attach Meteora reserve and oracle accounts
                // Await to respect rate limiter (additional attachments also consume WS attach slots)
                await attachMeteoraReserves(addr).catch((err) => {
                  try { logger.info('meteora.attach.fail', { pool: addr.slice(0,8)+'…', error: String(err?.message || err), stack: err?.stack }); } catch {}
                });
                // Ensure meteoraTargets Set includes this ID for handle() closure
                meteoraTargets.add(addr);
              } catch (e: any) {
                failed++;
                try { logger.info('pools.ws meteora subscribe failed for pool', { addr: addr.slice(0,8)+'…', error: String(e?.message || e).slice(0,100) }); } catch {}
              }
              if (i < edgeIds.length - 1 && intervalMsMet > 0) { await sleepMet(intervalMsMet); }
            }
            if (failed > 0) {
              try { logger.warn('pools.ws meteora subscribe partial failure', { attached, failed, total: edgeIds.length }); } catch {}
            }
            try {
              logger.info('pools.ws meteora.attach.complete', { attached, failed, total: edgeIds.length, ms: Date.now() - startTs, cat: 'pools' });
            } catch {}
            return attached;
          };
          
          // Try immediate targets; if none, make a couple of quick retries to allow first graph to include Meteora edges
          let attachedMet = await attachMeteora(meteoraPoolIds);
          if (attachedMet === 0 && meteoraTargets.size === 0) {
            const maxRetries = Math.max(1, Number(((CONFIG.system as any)?.meteoraWsRetryCount) || 2));
            const delayMs = Math.max(200, Number(((CONFIG.system as any)?.meteoraWsRetryDelayMs) || 600));
            for (let i = 0; i < maxRetries && attachedMet === 0; i++) {
              try {
                // Refresh targets from a fresh graph snapshot
                const gmod: any = await import('./graph.js');
                const snap = await gmod.getGraphSnapshot(true);
                const mset = new Set<string>();
                for (const e of (snap?.edges || [])) {
                  const pid = String((e as any)?.pool_id || '');
                  if (!pid) continue;
                  const base = pid.replace(/[#-]rev$/, '');
                  if ((e as any)?.dex === 'Meteora') mset.add(base);
                }
                // Merge new targets into existing Set (don't replace, to preserve any already subscribed)
                for (const id of mset) { meteoraTargets.add(id); }
                meteoraPoolIds = Array.from(meteoraTargets);
              } catch {}
              if (meteoraPoolIds.length > 0) attachedMet = await attachMeteora(meteoraPoolIds);
              if (attachedMet === 0) await sleep(delayMs);
            }
          }
          attachedMeteoraPools = attachedMet;
          
          // Always log (like Orca and Raydium do), even if attachedMet === 0
          logger.info('pools.ws subscribe meteora.pools', { attached: attachedMet, target: meteoraPoolIds.length, source: 'meteora' });
          
          // Program-level fallback when configured
          if (attachedMet === 0) {
            const meteoraProg = String((CONFIG as any)?.meteora?.programId || '').trim();
            if (meteoraProg && !!((CONFIG.system as any)?.meteoraWsProgramFallback)) {
              try { logger.info('pools.ws subscribe meteora(program)', { source: 'meteora', cat: 'pools' }); } catch {}
              {
                const id = await subscribeProgramWithRetry(new web3.PublicKey(meteoraProg), (ch: any) => handle(ch.accountId, ch.accountInfo));
                subs.push({ kind: 'program', id });
              }
              attachedMeteoraPools = 1;
            }
          }
        } catch (e:any) {
          logger.warn('pools.ws meteora subscribe failed', { error: String(e?.message || e), stack: String(e?.stack || '').slice(0,200) });
          attachedMeteoraPools = 0;
        }
        } // End of meteoraEnabled check
        
        // Stagger delay between DEX sources in sequential mode
        if (isSequentialMode && staggerDelayMs > 0) {
          logger.info('pools.ws sequential.stagger', { 
            afterDex: 'meteora', 
            beforeDex: 'pumpswap', 
            delayMs: staggerDelayMs, 
            cat: 'pools' 
          });
          await new Promise(r => setTimeout(r, staggerDelayMs));
        }
        
        // Pumpswap pool subscriptions
        // CRITICAL: Check if Pumpswap is enabled in dex source control before subscribing
        const pumpswapEnabled = (() => {
          try {
            const configSources = (CONFIG.system as any)?.enabledDexSources || {};
            return configSources.pumpswap !== false;
          } catch {
            return true; // Default to enabled if no config
          }
        })();
        
        if (!pumpswapEnabled) {
          try { logger.info('pools.ws dex.subscribe.skipped', { dex: 'pumpswap', reason: 'disabled_in_source_control', cat: 'pools' }); } catch {}
        } else {
        logger.info('pools.ws dex.subscribe.start', { dex: 'pumpswap', sequential: isSequentialMode, cat: 'pools' });
        try {
          const { PUMPSWAP_PROGRAM_ID } = await import('./pools/pumpswap.js');
          const pumpswapProg = new web3.PublicKey(PUMPSWAP_PROGRAM_ID);
          
          // Get pool IDs from cache or graph
          // In lazy activation mode, use cache directly (graph is empty until pools activate)
          const edgePoolIds = new Set<string>();
          if (!isLazyActivationEnabled()) {
            try {
              const gmod: any = await import('./graph.js');
              const snap = await gmod.getGraphSnapshot(false);
              for (const e of (snap?.edges || [])) {
                const dex = String((e as any)?.dex || '');
                if (dex !== 'Pumpswap') continue;
                const pid = String((e as any)?.pool_id || '');
                if (pid) {
                  const base = pid.replace(/[#-]rev$/,'');
                  // Only add valid PublicKey addresses (filter out synthetic IDs like "mintA->mintB-Dex")
                  if (isValidPublicKey(base)) {
                    edgePoolIds.add(base);
                  }
                }
              }
              try { logger.info('pools.ws targets.pumpswap from graph', { size: edgePoolIds.size }); } catch {}
            } catch {}
          }
          
          const pumpKnown: string[] = [];
          try { for (const p of (pumpswapCache.data?.amm || [])) if (p?.id) pumpKnown.push(String(p.id)); } catch {}
          
          const startTsPump = Date.now();
          // In lazy mode, edgePoolIds will be empty so we'll use pumpKnown (cache)
          const base = edgePoolIds.size > 0 ? Array.from(edgePoolIds) : pumpKnown;
          if (isLazyActivationEnabled() && pumpKnown.length > 0) {
            try { logger.info('pools.ws targets.pumpswap from cache (lazy mode)', { size: pumpKnown.length }); } catch {}
          }
          const uniquePump = Array.from(new Set(base.filter(Boolean)));
          let attachedPump = 0;
          
          // Rate-limit attachments
          const basePerSecPump = Math.max(1, Number(((CONFIG.system as any)?.wsAttachPerSec) || 10));
          const perSecPump = isSequentialMode 
            ? Math.max(1, Number((CONFIG.system as any)?.wsRetargetAttachPerSec || Math.floor(basePerSecPump / 2)))
            : basePerSecPump;
          const intervalMsPump = Math.floor(1000 / perSecPump);
          const sleepPump = (ms: number) => new Promise(r => setTimeout(r, ms));
          
          logger.info('pools.ws pumpswap.loop.start', { 
            poolCount: uniquePump.length, 
            rateLimit: `${perSecPump}/sec`, 
            intervalMs: intervalMsPump, 
            sequential: isSequentialMode,
            cat: 'pools' 
          });
          
          // CRITICAL: Pre-populate vault balance cache before subscribing to WebSocket
          // This ensures pool events can decode immediately without waiting for vault events
          if (uniquePump.length > 0) {
            await preloadPumpswapVaultCache();
          }
          
          for (let i = 0; i < uniquePump.length; i++) {
            const addr = uniquePump[i];
            try {
              const pk = new web3.PublicKey(addr);
              const id = await subscribeAccountWithRetry(pk, handle);
              subs.push({ kind: 'account', id }); 
              attachedPump++;
              
              try {
                const acct = pk.toBase58();
                targetedSourceByAccount.set(acct, 'pumpswap');
                debugLogTargeted('pumpswap' as any, acct, { kind: 'pool' });
                logger.debug('pools.ws pumpswap.pool.subscribed', { index: i, pool: addr.slice(0,8)+'…', cat: 'pools' });
              } catch {}
              
              // Attach vault listeners for Pumpswap AMM pools
              try {
                const pool = pumpswapCache.data?.amm?.find(p => p.id === addr);
                if (pool) {
                  // Use native_account_a/b (set by pumpswap normalization) with fallback to account_a/b
                  const vaultAddrA = pool.native_account_a || pool.account_a;
                  const vaultAddrB = pool.native_account_b || pool.account_b;
                  
                  if (vaultAddrA) {
                    const vaultAPk = new web3.PublicKey(vaultAddrA);
                    const vaultAId = await subscribeAccountWithRetry(vaultAPk, handle);
                    subs.push({ kind: 'account', id: vaultAId });
                    derivedAccountToPool.set(vaultAddrA, { poolId: addr, accountType: 'vault' });
                    targetedSourceByAccount.set(vaultAddrA, 'pumpswap');
                    debugLogTargeted('pumpswap' as any, vaultAddrA, { kind: 'vault', side: 'a' });
                  }
                  if (vaultAddrB) {
                    const vaultBPk = new web3.PublicKey(vaultAddrB);
                    const vaultBId = await subscribeAccountWithRetry(vaultBPk, handle);
                    subs.push({ kind: 'account', id: vaultBId });
                    derivedAccountToPool.set(vaultAddrB, { poolId: addr, accountType: 'vault' });
                    targetedSourceByAccount.set(vaultAddrB, 'pumpswap');
                    debugLogTargeted('pumpswap' as any, vaultAddrB, { kind: 'vault', side: 'b' });
                  }
                }
              } catch (e: any) {
                try { logger.debug('pools.ws pumpswap.vault.attach.fail', { pool: addr.slice(0,8)+'…', error: String(e?.message || e), cat: 'pools' }); } catch {}
              }
            } catch {}
            
            if (i < uniquePump.length - 1 && intervalMsPump > 0) { await sleepPump(intervalMsPump); }
          }
          
          attachedPumpswapPools = attachedPump;
          logger.info('pools.ws subscribe pumpswap.pools', { attached: attachedPump, target: uniquePump.length, source: 'pumpswap', ms: Date.now() - startTsPump });
          
          // Program-level fallback when configured
          if (attachedPump === 0 && !!((CONFIG.system as any)?.pumpswapWsProgramFallback)) {
            try { logger.info('pools.ws subscribe pumpswap(program)', { source: 'pumpswap', cat: 'pools' }); } catch {}
            {
              const id = await subscribeProgramWithRetry(pumpswapProg, (ch: any) => handle(ch.accountId, ch.accountInfo));
              subs.push({ kind: 'program', id });
            }
            attachedPumpswapPools = 1;
          }
        } catch (e:any) {
          logger.warn('pools.ws pumpswap subscribe failed', { error: String(e?.message || e), stack: String(e?.stack || '').slice(0,200) });
          attachedPumpswapPools = 0;
        }
        } // End of pumpswapEnabled check
        
        // Stagger delay between DEX sources in sequential mode
        if (isSequentialMode && staggerDelayMs > 0) {
          logger.info('pools.ws sequential.stagger', { 
            afterDex: 'pumpswap', 
            beforeDex: 'meteora_balanced', 
            delayMs: staggerDelayMs, 
            cat: 'pools' 
          });
          await new Promise(r => setTimeout(r, staggerDelayMs));
        }
        
        // Meteora Balanced pool subscriptions (AMM)
        // CRITICAL: Check if Meteora Balanced is enabled in dex source control before subscribing
        const meteoraBalancedEnabled = (() => {
          try {
            const configSources = (CONFIG.system as any)?.enabledDexSources || {};
            return configSources.meteora_balanced !== false;
          } catch {
            return true; // Default to enabled if no config
          }
        })();
        
        if (!meteoraBalancedEnabled) {
          try { logger.info('pools.ws dex.subscribe.skipped', { dex: 'meteora_balanced', reason: 'disabled_in_source_control', cat: 'pools' }); } catch {}
        } else {
        logger.info('pools.ws dex.subscribe.start', { dex: 'meteora_balanced', sequential: isSequentialMode, cat: 'pools' });
        try {
          // Get pool IDs from graph edges
          // In lazy activation mode, use cache directly (graph is empty until pools activate)
          const edgePoolIds = new Set<string>();
          if (!isLazyActivationEnabled()) {
            try {
              const gmod: any = await import('./graph.js');
              const snap = await gmod.getGraphSnapshot(false);
              for (const e of (snap?.edges || [])) {
                const dex = String((e as any)?.dex || '');
                // Match MeteoraBalanced, MeteoraBalanced_v1, MeteoraBalanced_v2
                if (!dex.startsWith('MeteoraBalanced')) continue;
                const pid = String((e as any)?.pool_id || '');
                if (pid) {
                  const base = pid.replace(/[#-]rev$/,'');
                  // Only add valid PublicKey addresses (filter out synthetic IDs like "mintA->mintB-Dex")
                  if (isValidPublicKey(base)) {
                    edgePoolIds.add(base);
                  }
                }
              }
              try { logger.info('pools.ws targets.meteora_balanced from graph', { size: edgePoolIds.size }); } catch {}
            } catch {}
          }
          
          // Fallback: use cache
          const mbalKnown: string[] = [];
          try { 
            for (const p of (metbalCache.data?.amm || [])) {
              if (p?.id) mbalKnown.push(String(p.id)); 
            }
          } catch {}
          
          const startTsMbal = Date.now();
          // In lazy mode, edgePoolIds will be empty so we'll use mbalKnown (cache)
          const base = edgePoolIds.size > 0 ? Array.from(edgePoolIds) : mbalKnown;
          if (isLazyActivationEnabled() && mbalKnown.length > 0) {
            try { logger.info('pools.ws targets.meteora_balanced from cache (lazy mode)', { size: mbalKnown.length }); } catch {}
          }
          const uniqueMbal = Array.from(new Set(base.filter(Boolean)));
          let attachedMbal = 0;
          
          // Rate-limit attachments
          const basePerSecMbal = Math.max(1, Number(((CONFIG.system as any)?.wsAttachPerSec) || 10));
          const perSecMbal = isSequentialMode 
            ? Math.max(1, Number((CONFIG.system as any)?.wsRetargetAttachPerSec || Math.floor(basePerSecMbal / 2)))
            : basePerSecMbal;
          const intervalMsMbal = Math.floor(1000 / perSecMbal);
          const sleepMbal = (ms: number) => new Promise(r => setTimeout(r, ms));
          
          logger.info('pools.ws meteora_balanced.loop.start', { 
            poolCount: uniqueMbal.length, 
            rateLimit: `${perSecMbal}/sec`, 
            intervalMs: intervalMsMbal, 
            sequential: isSequentialMode,
            cat: 'pools' 
          });
          
          // CRITICAL: Pre-populate vault balance cache before subscribing to WebSocket
          // This ensures pool events can decode immediately without waiting for vault events
          if (uniqueMbal.length > 0) {
            await preloadMeteoraBalancedVaultCache();
          }
          
          for (let i = 0; i < uniqueMbal.length; i++) {
            const addr = uniqueMbal[i];
            try {
              const pk = new web3.PublicKey(addr);
              const id = await subscribeAccountWithRetry(pk, handle);
              subs.push({ kind: 'account', id }); 
              attachedMbal++;
              
              try {
                const acct = pk.toBase58();
                targetedSourceByAccount.set(acct, 'meteora_balanced');
                debugLogTargeted('meteora_balanced', acct, { kind: 'pool' });
                logger.debug('pools.ws meteora_balanced.pool.subscribed', { index: i, pool: addr.slice(0,8)+'…', cat: 'pools' });
              } catch {}
              
              // Attach vault listeners for Meteora Balanced AMM pools
              // Use native_account_a/b (set by normalization) with fallback to account_a/b
              try {
                const pool = metbalCache.data?.amm?.find(p => p.id === addr);
                if (pool) {
                  const vaultAddrA = pool.native_account_a || pool.account_a;
                  const vaultAddrB = pool.native_account_b || pool.account_b;

                  if (vaultAddrA) {
                    const vaultAPk = new web3.PublicKey(vaultAddrA);
                    const vaultAId = await subscribeAccountWithRetry(vaultAPk, handle);
                    subs.push({ kind: 'account', id: vaultAId });
                    derivedAccountToPool.set(vaultAddrA, { poolId: addr, accountType: 'vault' });
                    targetedSourceByAccount.set(vaultAddrA, 'meteora_balanced');
                    debugLogTargeted('meteora_balanced', vaultAddrA, { kind: 'vault', side: 'a' });
                  }
                  if (vaultAddrB) {
                    const vaultBPk = new web3.PublicKey(vaultAddrB);
                    const vaultBId = await subscribeAccountWithRetry(vaultBPk, handle);
                    subs.push({ kind: 'account', id: vaultBId });
                    derivedAccountToPool.set(vaultAddrB, { poolId: addr, accountType: 'vault' });
                    targetedSourceByAccount.set(vaultAddrB, 'meteora_balanced');
                    debugLogTargeted('meteora_balanced', vaultAddrB, { kind: 'vault', side: 'b' });
                  }
                }
              } catch (e: any) {
                try { logger.debug('pools.ws meteora_balanced.vault.attach.fail', { pool: addr.slice(0,8)+'…', error: String(e?.message || e), cat: 'pools' }); } catch {}
              }
            } catch {}
            
            if (i < uniqueMbal.length - 1 && intervalMsMbal > 0) { await sleepMbal(intervalMsMbal); }
          }
          
          attachedMeteoraBalancedPools = attachedMbal;
          logger.info('pools.ws subscribe meteora_balanced.pools', { 
            attached: attachedMbal, 
            target: uniqueMbal.length, 
            source: 'meteora_balanced', 
            ms: Date.now() - startTsMbal 
          });
        } catch (e: any) {
          logger.warn('pools.ws meteora_balanced subscribe failed', { 
            error: String(e?.message || e), 
            stack: String(e?.stack || '').slice(0,200) 
          });
          attachedMeteoraBalancedPools = 0;
        }
        } // End of meteoraBalancedEnabled check

        wsUnsubscribe = () => {
          try {
            // Begin async teardown and websocket close; future setups will await wsClosePromise
            wsClosePromise = (async () => {
              try {
                // Collect all bin subscriptions from trackers before clearing
                // These might not be in the subs array if setup() was called multiple times
                const binSubIds: number[] = [];
                try {
                  for (const tracker of meteoraBinTrackers.values()) {
                    for (const accountInfo of tracker.accounts.values()) {
                      if (typeof accountInfo.id === 'number') {
                        binSubIds.push(accountInfo.id);
                      }
                    }
                  }
                } catch {}

                // Best-effort await listener removals, but avoid calling into RPC when WS is CLOSING/CLOSED
                const removals: Array<Promise<any>> = [];
                const wsAny = (wsConn as any)?._rpcWebSocket?._ws;
                const ready: number = Number(wsAny?.readyState);
                // Only allow RPC calls if socket is OPEN (1), not CONNECTING (0) as CONNECTING may fail
                const canRpc = (ready === 1); // Only OPEN, not CONNECTING
                
                // Unsubscribe from main subs array BEFORE closing WebSocket
                // This ensures subscription maps are still intact during unsubscribe
                for (const s of subs) {
                  try {
                    if (!canRpc) continue;
                    if (s.kind === 'account') {
                      removals.push((conn as any).removeAccountChangeListener(s.id).catch(() => {}));
                    } else {
                      removals.push((conn as any).removeProgramAccountChangeListener(s.id).catch(() => {}));
                    }
                  } catch {}
                }
                
                // Also unsubscribe from bin subscriptions that might not be in subs array
                for (const binId of binSubIds) {
                  try {
                    if (!canRpc) continue;
                    // Check if this ID is already in subs to avoid double-unsubscribe
                    const alreadyInSubs = subs.some(s => s.id === binId);
                    if (!alreadyInSubs) {
                      removals.push((conn as any).removeAccountChangeListener(binId).catch(() => {}));
                    }
                  } catch {}
                }
                
                // Wait for all unsubscribe operations to complete before closing WebSocket
                if (canRpc && removals.length) {
                  try { await Promise.allSettled(removals); } catch {}
                }
                
                // NOW close WebSocket and clear subscription maps AFTER unsubscribing
                // This prevents "Ignored unsubscribe request" warnings from web3.js
                const { safeCloseWebSocket } = await import('../drift/wsHelper.js');
                await safeCloseWebSocket(conn, 'pools.unsubscribe');
                
                // Clear bin trackers after unsubscribing to prevent stale references
                try {
                  meteoraBinTrackers.clear();
                  meteoraBinAccountToPool.clear();
                } catch {}

                // Give a small delay to allow any in-flight subscription updates to complete
                await new Promise(r => setTimeout(r, 100));

                // Close underlying websocket if present to avoid CLOSING race on next subscribe
                try {
                  const wsAny2 = (wsConn as any)?._rpcWebSocket?._ws;
                  const rs: number | undefined = Number(wsAny2?.readyState);
                  // 0 CONNECTING, 1 OPEN, 2 CLOSING, 3 CLOSED
                  if (wsAny2 && (rs === 1 || rs === 2)) { // Only close if OPEN or CLOSING, not CONNECTING
                    try { (wsConn as any)?._rpcWebSocket?.close?.(); } catch {}
                  }
                  // Wait until CLOSED (3) or socket disappears, with small timeout
                  const deadline = Date.now() + Math.max(500, Number(((CONFIG.system as any)?.wsCloseWaitMs) || 2000));
                  let cur = Number(wsAny2?.readyState);
                  while (wsAny2 && cur !== 3 && Date.now() < deadline) {
                    await new Promise(r => setTimeout(r, 100));
                    cur = Number(wsAny2?.readyState);
                  }
                } catch {}
              } finally {
                try { wsConn = undefined; } catch {}
              }
            })();
            // Detach immediately; actual close will be awaited by the next setup
            wsClosePromise?.catch(() => {});
          } catch {}
        };
        logger.info('pools.ws subscriptions active');
        // Immediately emit a ws-activity snapshot so UI reflects attached counts without waiting for first aggregate tick
        try {
          emit('ws-activity', {
            healthy: wsHealthy,
            lastEventMs: lastWsEventMs,
            orca: { attached: attachedOrcaPools, events: 0 },
            raydium: { attached: attachedRaydiumPools, events: 0 },
            meteora: { attached: attachedMeteoraPools, events: 0 },
            pumpswap: { attached: attachedPumpswapPools, events: 0 },
            meteora_balanced: { attached: attachedMeteoraBalancedPools, events: 0 },
          });
        } catch {}

        // Health monitor: if no WS events for timeoutMs, trigger periodic refresh as fallback
        const timeoutMs = Math.max(5000, Number((CONFIG.system as any)?.wsHealthTimeoutMs || 15000));
        if (healthTimer) { clearInterval(healthTimer); healthTimer = undefined; }
        healthTimer = setInterval(() => {
          try {
            const now = Date.now();
            const idle = now - (lastWsEventMs || 0);
            const healthy = wsHealthy && idle < timeoutMs * 2;
            if (!healthy) {
              // WS unhealthy: attempt auto-retarget with exponential backoff and reconnect hints
              try { logger.warn('pools.ws unhealthy', { idleMs: idle, timeoutMs }); } catch {}
              wsHealthy = false;
              (async () => {
                try {
                  const last = (reconcileNow as any)._last || 0;
                  const gap = Math.max(2000, Number((CONFIG.system as any)?.wsReconnectMinGapMs || 5000));
                  if (Date.now() - last > gap) {
                    await reconcileNow();
                  }
                } catch {}
              })();
            }
          } catch {}
        }, Math.max(2000, Math.floor((Number((CONFIG.system as any)?.wsHealthTimeoutMs || 15000)) / 3)));

        // Periodic aggregate logs for WS activity
        const aggPeriod = Math.max(5000, Number((CONFIG.system as any)?.wsAggLogPeriodMs || 15000));
        aggTimer = setInterval(() => {
          try {
            const snapshot = { 
              raydium: wsCounts.raydium, 
              raydium_cpmm: wsCounts['raydium-cpmm'] || 0,
              orca: wsCounts.orca, 
              meteora: wsCounts.meteora,
              pumpswap: wsCounts.pumpswap || 0,
              meteora_balanced: wsCounts.meteora_balanced || 0
            } as any;
            wsCounts.raydium = 0; wsCounts['raydium-cpmm'] = 0; wsCounts.orca = 0; wsCounts.meteora = 0; wsCounts.pumpswap = 0; wsCounts.meteora_balanced = 0;
            
            // Only log non-zero metrics to reduce size
            const activeProtocols = Object.entries(snapshot)
              .filter(([_, count]) => (count as number) > 0)
              .map(([proto]) => proto);
            
            // Simplified log with only essential data
            const logData: any = { 
              events: snapshot, 
              healthy: wsHealthy, 
              lastEventMs: lastWsEventMs,
            };
            
            // Only include detailed metrics for active protocols
            if (activeProtocols.length > 0) {
              logData.metrics = {};
              logData.attached = {};
              
              for (const proto of activeProtocols) {
                const stats = wsDeltaStats[proto as keyof typeof wsDeltaStats];
                logData.metrics[proto] = {
                  decoded: stats.decoded,
                  applied: stats.applied,
                  skipped: stats.skipped,
                  // Only include top skip reason if skipped > 0
                  ...(stats.skipped > 0 && Object.keys(stats.skipReasons).length > 0 
                    ? { topSkipReason: Object.entries(stats.skipReasons).sort(([,a], [,b]) => (b as number) - (a as number))[0]?.[0] }
                    : {})
                };
                
                // Attached count for active protocols only
                if (proto === 'raydium') logData.attached.raydium = attachedRaydiumPools;
                else if (proto === 'orca') logData.attached.orca = attachedOrcaPools;
                else if (proto === 'meteora') logData.attached.meteora = attachedMeteoraPools;
                else if (proto === 'pumpswap') logData.attached.pumpswap = attachedPumpswapPools;
                else if (proto === 'meteora_balanced') logData.attached.meteora_balanced = attachedMeteoraBalancedPools;
              }
            }
            
            logger.info('pools.ws aggregate', logData);
            wsDeltaStats.raydium_amm = { decoded: 0, applied: 0, skipped: 0, skipReasons: {} };
            wsDeltaStats.raydium_clmm = { decoded: 0, applied: 0, skipped: 0, skipReasons: {} };
            wsDeltaStats.raydium_cpmm = { decoded: 0, applied: 0, skipped: 0, skipReasons: {} };
            wsDeltaStats.orca = { decoded: 0, applied: 0, skipped: 0, skipReasons: {} };
            wsDeltaStats.meteora_dlmm = { decoded: 0, applied: 0, skipped: 0, skipReasons: {} };
            wsDeltaStats.meteora_damm_v1 = { decoded: 0, applied: 0, skipped: 0, skipReasons: {} };
            wsDeltaStats.meteora_damm_v2 = { decoded: 0, applied: 0, skipped: 0, skipReasons: {} };
            wsDeltaStats.pumpswap = { decoded: 0, applied: 0, skipped: 0, skipReasons: {} };
            wsDecodeStats.raydium_amm = { attempts: 0, successes: 0, failures: 0 };
            wsDecodeStats.raydium_clmm = { attempts: 0, successes: 0, failures: 0 };
            wsDecodeStats.raydium_cpmm = { attempts: 0, successes: 0, failures: 0 };
            wsDecodeStats.orca = { attempts: 0, successes: 0, failures: 0 };
            wsDecodeStats.meteora_dlmm = { attempts: 0, successes: 0, failures: 0 };
            wsDecodeStats.meteora_damm_v1 = { attempts: 0, successes: 0, failures: 0 };
            wsDecodeStats.meteora_damm_v2 = { attempts: 0, successes: 0, failures: 0 };
            wsDecodeStats.pumpswap = { attempts: 0, successes: 0, failures: 0 };
            wsValidationStats.raydium = { missingMints: 0, invalidPrice: 0, invalidLiquidity: 0, invalidFee: 0, invalidTick: 0, emptyMints: 0 };
            wsValidationStats.orca = { missingMints: 0, invalidPrice: 0, invalidLiquidity: 0, invalidFee: 0, invalidTick: 0, emptyMints: 0 };
            wsValidationStats.meteora_dlmm = { missingMints: 0, invalidPrice: 0, invalidLiquidity: 0, invalidFee: 0, invalidTick: 0, emptyMints: 0 };
            wsValidationStats.meteora_damm_v1 = { missingMints: 0, invalidPrice: 0, invalidLiquidity: 0, invalidFee: 0, invalidTick: 0, emptyMints: 0 };
            wsValidationStats.meteora_damm_v2 = { missingMints: 0, invalidPrice: 0, invalidLiquidity: 0, invalidFee: 0, invalidTick: 0, emptyMints: 0 };
            wsValidationStats.pumpswap = { missingMints: 0, invalidPrice: 0, invalidLiquidity: 0, invalidFee: 0, invalidTick: 0, emptyMints: 0 };
            // Emit a dedicated ws-activity event for UI regardless of log filtering
            try {
              emit('ws-activity', {
                healthy: wsHealthy,
                lastEventMs: lastWsEventMs,
                orca: { attached: attachedOrcaPools, events: snapshot.orca || 0 },
                raydium: { attached: attachedRaydiumPools, events: snapshot.raydium || 0 },
                meteora: { attached: attachedMeteoraPools, events: snapshot.meteora || 0 },
                pumpswap: { attached: attachedPumpswapPools, events: snapshot.pumpswap || 0 },
                meteora_balanced: { attached: attachedMeteoraBalancedPools, events: snapshot.meteora_balanced || 0 },
              });
            } catch {}
            // Aggregate metrics are already logged above via logger.info('pools.ws aggregate', ...), no need for duplicate emit
            // Reconcile targets vs attached (debounced): if attached << targets, trigger retarget
            (async () => {
              try {
                // Check if auto-reconciliation is enabled
                const autoReconcile = (CONFIG.system as any)?.wsAutoReconcile !== false;
                if (!autoReconcile) return; // Skip reconciliation if disabled
                
                const tgt = await getWsTargets();
                const needRay = Math.max(0, (tgt.raydium.target || 0) - (attachedRaydiumPools || 0));
                const needOrc = Math.max(0, (tgt.orca.target || 0) - (attachedOrcaPools || 0));
                const needMet = Math.max(0, (tgt.meteora.target || 0) - (attachedMeteoraPools || 0));
                const needPump = Math.max(0, (tgt.pumpswap.target || 0) - (attachedPumpswapPools || 0));
                const sumNeed = needRay + needOrc + needMet + needPump;
                
                // Also retarget if significantly over target (shed excess subs)
                const lastTgts: any = (getWsTargets as any)?._last || {};
                const tgtRay = Math.max(0, Number(lastTgts?.raydium?.target || 0));
                const tgtOrc = Math.max(0, Number(lastTgts?.orca?.target || 0));
                const tgtMet = Math.max(0, Number(lastTgts?.meteora?.target || 0));
                const tgtPump = Math.max(0, Number(lastTgts?.pumpswap?.target || 0));
                const overRay = (tgtRay > 0) && (attachedRaydiumPools || 0) > Math.floor(tgtRay * 1.5);
                const overOrc = (tgtOrc > 0) && (attachedOrcaPools || 0) > Math.floor(tgtOrc * 1.5);
                const overMet = (tgtMet > 0) && (attachedMeteoraPools || 0) > Math.floor(tgtMet * 1.5);
                const overPump = (tgtPump > 0) && (attachedPumpswapPools || 0) > Math.floor(tgtPump * 1.5);
                
                // Only reconcile if mismatch exceeds threshold
                const threshold = Math.max(1, Number((CONFIG.system as any)?.wsReconcileThreshold || 10));
                const minGap = Number((CONFIG.system as any)?.wsReconcileMinGapMs || 60000);
                
                if (sumNeed > threshold || overRay || overOrc || overMet || overPump) {
                  const last = (reconcileNow as any)._last || 0;
                  if (Date.now() - last > minGap) {
                    try {
                      logger.info('pools.ws reconcile.triggered', {
                        reason: sumNeed > threshold ? 'missing_subscriptions' : 'excess_subscriptions',
                        missing: { total: sumNeed, raydium: needRay, orca: needOrc, meteora: needMet, pumpswap: needPump },
                        excess: { raydium: overRay, orca: overOrc, meteora: overMet, pumpswap: overPump },
                        threshold,
                        minGapMs: minGap,
                        cat: 'pools'
                      });
                    } catch {}
                    await reconcileNow();
                  }
                }
              } catch {}
            })();
          } catch {}
        }, aggPeriod);
      };
      setup()
        .catch((e: any) => logger.warn('pools.ws setup failed', { error: String(e?.message || e) }))
        .finally(() => { 
          wsSetupActive = false; 
          // Clear sequential mode flag after setup completes
          try { delete (startPoolWebsocketsOnlyOnce as any).__sequentialMode; } catch {}
        });
    } catch (e: any) {
      logger.warn('pools.ws unavailable', { error: String(e?.message || e) });
    }
  }
  // Reset the one-shot suppression flag
  suppressInitialOnce = false;
}
async function reconcileNow(): Promise<void> {
  try {
    (reconcileNow as any)._last = Date.now();
    await retargetPoolWebsockets();
  } catch {}
}

// Stop all pool activity: timers and websocket subscriptions
export function stopPoolRefreshLoop(): void {
  try { if (rayTimer) { clearInterval(rayTimer); rayTimer = undefined; } } catch {}
  try { if (orcaTimer) { clearInterval(orcaTimer); orcaTimer = undefined; } } catch {}
  try { if (aggTimer) { clearInterval(aggTimer); aggTimer = undefined; } } catch {}
  try { if (meteoraTimer) { clearInterval(meteoraTimer); meteoraTimer = undefined; } } catch {}
  try { if (healthTimer) { clearInterval(healthTimer); healthTimer = undefined; } } catch {}
  try { if (wsUnsubscribe) { wsUnsubscribe(); wsUnsubscribe = undefined; } } catch {}
  wsHealthy = false; lastWsEventMs = Date.now();
  
  // Clear Meteora bin trackers to prevent stale subscription references
  try {
    meteoraBinTrackers.clear();
    meteoraBinAccountToPool.clear();
    vaultBalanceCache.clear(); // Clear vault cache to prevent stale data
  } catch {}
  
  try { logger.info('pools.stop all timers and ws unsubscribed'); } catch {}
}

// Allow external trigger (from graph start) to enable websocket-based refreshes
export function enablePoolWebsocketRefreshes(): void {
  if (wsAllowed) return;
  wsAllowed = true;
  try {
    // Only mark allowed; actual start is controlled by subscribe/unsubscribe routes
    logger.info('pools.ws allowed');
  } catch {}
}

export function disablePoolWebsocketRefreshes(): void {
  try {
    // Shutdown gRPC adapter if running
    try {
      shutdownGrpcAdapter().catch(() => {});
    } catch {}
    
    if (wsUnsubscribe) { wsUnsubscribe(); wsUnsubscribe = undefined; }
    if (healthTimer) { clearInterval(healthTimer); healthTimer = undefined; }
    wsHealthy = false; lastWsEventMs = Date.now();
    // Reset wsSetupActive to allow new setup to proceed
    wsSetupActive = false;
    
    // Clear ALL tracking maps to prevent stale subscription references
    // that could trigger _updateSubscriptions after shutdown
    try {
      // Meteora bin trackers
      meteoraBinTrackers.clear();
      meteoraBinAccountToPool.clear();
      
      // Derived account mappings (vaults, reserves, tick arrays, oracles, observations)
      // These track all accounts subscribed to for pools in the graph
      derivedAccountToPool.clear();
      poolsWithDerivedAccounts.clear();
      
      // Vault balance cache
      vaultBalanceCache.clear();
    } catch {}
    
    logger.info('pools.ws unsubscribed - all subscriptions and tracking maps cleared');
  } catch {}
}

export function getPoolWsStatus(): { 
  enabled: boolean; 
  healthy: boolean; 
  lastEventMs: number;
  mode: 'wss' | 'grpc' | 'disabled';
  grpc?: {
    configured: boolean;
    connected: boolean;
    subscriptionCount: number;
    eventCount: number;
  };
} {
  const enabled = !!((CONFIG.system as any)?.enablePoolWs) && wsAllowed;
  const mode = (CONFIG.system as any)?.poolSubscriptionMode || 'wss';
  
  // Get gRPC status if available
  let grpcInfo: { configured: boolean; connected: boolean; subscriptionCount: number; eventCount: number } | undefined;
  try {
    const grpcStatus = getGrpcStatus();
    grpcInfo = {
      configured: grpcStatus.configured,
      connected: grpcStatus.connected,
      subscriptionCount: grpcStatus.subscriptionCount,
      eventCount: grpcStatus.eventCount,
    };
  } catch {}
  
  return { 
    enabled, 
    healthy: mode === 'grpc' ? (grpcInfo?.connected ?? false) : !!wsHealthy, 
    lastEventMs: mode === 'grpc' ? (getGrpcStatus().lastEventMs || 0) : (lastWsEventMs || 0),
    mode: mode as 'wss' | 'grpc' | 'disabled',
    grpc: grpcInfo,
  };
}

// Clear all in-memory normalized caches to force a fresh rebuild next boot
