/**
 * Orientation Consistency Validation
 * 
 * This module ensures consistency between HTTP-fetched pools and WebSocket updates
 * by detecting and correcting orientation mismatches.
 * 
 * The problem:
 * - HTTP/GraphQL pool data goes through canonicalization (was_swapped flag set)
 * - WebSocket updates may decode pools in native orientation
 * - If orientations don't match, prices can be inverted (100x → 0.01 errors)
 * 
 * The solution:
 * - Track the authoritative orientation from HTTP fetch
 * - Validate WS updates match expected orientation
 * - When mismatches occur, correct by applying proper canonicalization
 */

import { logger } from '../../utils/logger.js';
import { logCatchError } from '../../utils/errorHandler.js';
import { canonicalOrientation, swapPoolFields } from './canonical.js';
import type { AmmPool, ClmmPool, CpmmPool } from './types.js';

/**
 * Orientation validation metrics
 */
interface OrientationMetrics {
  validations: number;
  mismatches: number;
  corrections: number;
  flipDetections: number;
  lastMismatchMs: number;
}

const orientationMetrics: OrientationMetrics = {
  validations: 0,
  mismatches: 0,
  corrections: 0,
  flipDetections: 0,
  lastMismatchMs: 0,
};

/**
 * Cache of authoritative orientations from HTTP fetch
 * Maps poolId -> { wasSwapped, mintA, mintB, nativeMintA, nativeMintB }
 */
interface PoolOrientation {
  wasSwapped: boolean;
  mintA: string;  // Canonical mint A
  mintB: string;  // Canonical mint B
  nativeMintA: string;  // On-chain mint A
  nativeMintB: string;  // On-chain mint B
  decimalsA: number;
  decimalsB: number;
  nativeDecimalsA: number;
  nativeDecimalsB: number;
  dex: string;
  poolKind: 'amm' | 'clmm' | 'cpmm';
  updatedAt: number;
}

const orientationCache = new Map<string, PoolOrientation>();

/**
 * Store authoritative orientation from HTTP fetch
 * Call this when pools are fetched via GraphQL/HTTP
 */
export function setPoolOrientation(
  poolId: string,
  pool: AmmPool | ClmmPool | CpmmPool
): void {
  const nativeMintA = (pool as any).native_mint_a || pool.mint_a;
  const nativeMintB = (pool as any).native_mint_b || pool.mint_b;
  const wasSwapped = (pool as any).was_swapped ?? false;
  
  orientationCache.set(poolId, {
    wasSwapped,
    mintA: pool.mint_a,
    mintB: pool.mint_b,
    nativeMintA,
    nativeMintB,
    decimalsA: pool.decimals_a ?? 9,
    decimalsB: pool.decimals_b ?? 6,
    nativeDecimalsA: (pool as any).native_decimals_a ?? pool.decimals_a ?? 9,
    nativeDecimalsB: (pool as any).native_decimals_b ?? pool.decimals_b ?? 6,
    dex: pool.dex,
    poolKind: (pool as any).pool_kind || 'amm',
    updatedAt: Date.now(),
  });
}

/**
 * Get stored orientation for a pool
 */
export function getPoolOrientation(poolId: string): PoolOrientation | undefined {
  return orientationCache.get(poolId);
}

/**
 * Clear orientation cache (for testing or reset)
 */
export function clearOrientationCache(): void {
  orientationCache.clear();
}

/**
 * Get orientation metrics
 */
export function getOrientationMetrics(): OrientationMetrics {
  return { ...orientationMetrics };
}

/**
 * Reset orientation metrics
 */
export function resetOrientationMetrics(): void {
  orientationMetrics.validations = 0;
  orientationMetrics.mismatches = 0;
  orientationMetrics.corrections = 0;
  orientationMetrics.flipDetections = 0;
}

/**
 * Validation result from orientation check
 */
export interface OrientationValidationResult {
  valid: boolean;
  needsCorrection: boolean;
  correctionType?: 'swap_mints' | 'invert_price' | 'full_swap';
  mismatchDetails?: {
    expectedMintA: string;
    expectedMintB: string;
    actualMintA: string;
    actualMintB: string;
    expectedWasSwapped: boolean;
    actualWasSwapped: boolean;
  };
}

/**
 * Validate that a WS update has consistent orientation with the authoritative HTTP data
 * 
 * @param poolId Pool ID
 * @param wsPool The pool data from WebSocket update
 * @returns Validation result with correction guidance
 */
export function validateOrientation(
  poolId: string,
  wsPool: Partial<AmmPool | ClmmPool | CpmmPool>
): OrientationValidationResult {
  orientationMetrics.validations++;
  
  const authoritative = orientationCache.get(poolId);
  
  // No authoritative data - can't validate (allow through)
  if (!authoritative) {
    return { valid: true, needsCorrection: false };
  }
  
  const wsMintA = wsPool.mint_a;
  const wsMintB = wsPool.mint_b;
  const wsWasSwapped = (wsPool as any).was_swapped ?? false;
  
  if (!wsMintA || !wsMintB) {
    return { valid: true, needsCorrection: false };
  }
  
  // Check if mints match expected canonical order
  const mintsMatch = wsMintA === authoritative.mintA && wsMintB === authoritative.mintB;
  const mintsReversed = wsMintA === authoritative.mintB && wsMintB === authoritative.mintA;
  
  if (mintsMatch) {
    // Mints in correct order
    if (wsWasSwapped !== authoritative.wasSwapped) {
      // was_swapped flag mismatch, but mints are correct - minor issue
      orientationMetrics.flipDetections++;
      logger.debug('orientation.flag_mismatch', {
        poolId: poolId.slice(0, 8) + '…',
        expectedWasSwapped: authoritative.wasSwapped,
        actualWasSwapped: wsWasSwapped,
        cat: 'orientation'
      });
    }
    return { valid: true, needsCorrection: false };
  }
  
  if (mintsReversed) {
    // Mints are reversed from expected canonical order - needs correction
    orientationMetrics.mismatches++;
    orientationMetrics.lastMismatchMs = Date.now();
    
    logger.warn('orientation.mismatch.reversed', {
      poolId: poolId.slice(0, 8) + '…',
      dex: authoritative.dex,
      expectedMintA: authoritative.mintA.slice(0, 8) + '…',
      expectedMintB: authoritative.mintB.slice(0, 8) + '…',
      actualMintA: wsMintA.slice(0, 8) + '…',
      actualMintB: wsMintB.slice(0, 8) + '…',
      cat: 'orientation'
    });
    
    return {
      valid: false,
      needsCorrection: true,
      correctionType: 'full_swap',
      mismatchDetails: {
        expectedMintA: authoritative.mintA,
        expectedMintB: authoritative.mintB,
        actualMintA: wsMintA,
        actualMintB: wsMintB,
        expectedWasSwapped: authoritative.wasSwapped,
        actualWasSwapped: wsWasSwapped,
      },
    };
  }
  
  // Mints don't match at all - something is very wrong
  orientationMetrics.mismatches++;
  orientationMetrics.lastMismatchMs = Date.now();
  
  logger.error('orientation.mismatch.unknown', {
    poolId: poolId.slice(0, 8) + '…',
    dex: authoritative.dex,
    expectedMintA: authoritative.mintA.slice(0, 8) + '…',
    expectedMintB: authoritative.mintB.slice(0, 8) + '…',
    actualMintA: wsMintA.slice(0, 8) + '…',
    actualMintB: wsMintB.slice(0, 8) + '…',
    warning: 'Mints do not match expected pool - possible pool ID collision',
    cat: 'orientation'
  });
  
  return {
    valid: false,
    needsCorrection: false,  // Can't correct if mints are completely different
    mismatchDetails: {
      expectedMintA: authoritative.mintA,
      expectedMintB: authoritative.mintB,
      actualMintA: wsMintA,
      actualMintB: wsMintB,
      expectedWasSwapped: authoritative.wasSwapped,
      actualWasSwapped: wsWasSwapped,
    },
  };
}

/**
 * Correct pool orientation to match authoritative data
 * 
 * @param poolId Pool ID
 * @param pool Pool data that needs correction
 * @returns Corrected pool data
 */
export function correctOrientation<T extends Partial<AmmPool | ClmmPool | CpmmPool>>(
  poolId: string,
  pool: T
): T {
  const authoritative = orientationCache.get(poolId);
  if (!authoritative) {
    return pool;
  }
  
  const validation = validateOrientation(poolId, pool);
  
  if (!validation.needsCorrection) {
    return pool;
  }
  
  orientationMetrics.corrections++;
  
  logger.info('orientation.correcting', {
    poolId: poolId.slice(0, 8) + '…',
    correctionType: validation.correctionType,
    cat: 'orientation'
  });
  
  if (validation.correctionType === 'full_swap') {
    // Apply full swap to align with canonical orientation
    const swapped = swapPoolFields(pool as any) as T;
    
    // Ensure canonical fields are correct
    (swapped as any).mint_a = authoritative.mintA;
    (swapped as any).mint_b = authoritative.mintB;
    (swapped as any).decimals_a = authoritative.decimalsA;
    (swapped as any).decimals_b = authoritative.decimalsB;
    (swapped as any).was_swapped = authoritative.wasSwapped;
    
    // Preserve native fields
    (swapped as any).native_mint_a = authoritative.nativeMintA;
    (swapped as any).native_mint_b = authoritative.nativeMintB;
    (swapped as any).native_decimals_a = authoritative.nativeDecimalsA;
    (swapped as any).native_decimals_b = authoritative.nativeDecimalsB;
    
    return swapped;
  }
  
  return pool;
}

/**
 * Validate and optionally correct orientation for a WS update
 * 
 * This is the main entry point for WebSocket decoders.
 * It validates the orientation and returns either:
 * - The original pool (if valid)
 * - A corrected pool (if orientation was mismatched)
 * 
 * @param poolId Pool ID
 * @param wsPool Pool data from WebSocket
 * @param autoCorrect Whether to auto-correct mismatches (default: true)
 * @returns Pool with validated/corrected orientation
 */
export function ensureOrientationConsistency<T extends Partial<AmmPool | ClmmPool | CpmmPool>>(
  poolId: string,
  wsPool: T,
  autoCorrect: boolean = true
): { pool: T; wasValidated: boolean; wasCorrected: boolean } {
  const validation = validateOrientation(poolId, wsPool);
  
  if (validation.valid) {
    return {
      pool: wsPool,
      wasValidated: true,
      wasCorrected: false,
    };
  }
  
  if (autoCorrect && validation.needsCorrection) {
    const corrected = correctOrientation(poolId, wsPool);
    return {
      pool: corrected,
      wasValidated: false,
      wasCorrected: true,
    };
  }
  
  // Return original pool even if invalid (let caller decide)
  return {
    pool: wsPool,
    wasValidated: false,
    wasCorrected: false,
  };
}

/**
 * Synchronize orientation for a pool that was fetched from cache
 * 
 * Call this when loading pools from persistence to ensure
 * orientation cache is populated.
 */
export function syncOrientationFromPool(pool: AmmPool | ClmmPool | CpmmPool): void {
  if (!pool.id) return;
  setPoolOrientation(pool.id, pool);
}

/**
 * Bulk sync orientations from a pool payload
 */
export function syncOrientationsFromPayload(payload: {
  amm?: AmmPool[];
  clmm?: ClmmPool[];
  cpmm?: CpmmPool[];
}): void {
  for (const pool of payload.amm || []) {
    syncOrientationFromPool(pool);
  }
  for (const pool of payload.clmm || []) {
    syncOrientationFromPool(pool);
  }
  for (const pool of payload.cpmm || []) {
    syncOrientationFromPool(pool);
  }
  
  logger.info('orientation.sync.complete', {
    amm: (payload.amm || []).length,
    clmm: (payload.clmm || []).length,
    cpmm: (payload.cpmm || []).length,
    cacheSize: orientationCache.size,
    cat: 'orientation'
  });
}
