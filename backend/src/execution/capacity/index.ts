/**
 * Capacity System - Unified API
 * 
 * This module provides the main entry points for the capacity-based
 * trade sizing system:
 * 
 * 1. lookupCapacity() - Get or compute capacity curve for a pool
 * 2. getOptimalSizeFromCurve() - Calculate optimal trade size given a curve
 * 3. computeCapacityCurve() - Compute a new capacity curve for a pool
 * 
 * The system is designed for minimal hot-path latency:
 * - Pre-computed curves are cached and looked up instantly
 * - Tier 1 fallbacks provide instant estimates when no curve exists
 * - Curve recomputation happens asynchronously on boundary crossings
 */

import type {
  CapacityCurve,
  PoolType,
  SizingConfig,
  OptimalSizeResult,
  Tier1EstimateResult,
} from './types.js';

import {
  DEFAULT_SIZING_CONFIG,
  interpolateCurve,
  findSizeAtSlippage,
} from './types.js';

import {
  getCapacityCurve,
  setCapacityCurve,
  invalidateCapacityCurve,
  hasValidCurve,
} from './curveCache.js';

import { computeClmmCapacityCurve, clmmTier1Estimate } from './clmmCapacity.js';
import { computeDlmmCapacityCurve, dlmmTier1Estimate } from './dlmmCapacity.js';
import { computeAmmCapacityCurve, ammTier1Estimate } from './ammCapacity.js';

import { logger } from '../../utils/logger.js';

// Re-export types and utilities
export type { CapacityCurve, PoolType, SizingConfig, OptimalSizeResult, Tier1EstimateResult };
export { DEFAULT_SIZING_CONFIG } from './types.js';
export { getCapacityCurve, setCapacityCurve, invalidateCapacityCurve, hasValidCurve } from './curveCache.js';
export {
  migrateFromDynamicSizing,
  migrateExecutorConfig,
  needsMigration,
  validateSizingConfig,
  uiAdjustmentToMultiplier,
  multiplierToUiAdjustment,
} from './configMigration.js';

// ============================================================================
// Pool Hot Data Interface (matches ExecutionCache.PoolHot)
// ============================================================================

interface PoolHotData {
  sqrtPriceX64?: bigint;
  currentTickIndex?: number;
  activeId?: number;
  liquidity?: bigint;
  feeRate?: number;
  tickSpacing?: number;
  binStep?: number;
}

interface PoolStaticData {
  pool_kind?: 'amm' | 'clmm' | 'cpmm';
  dex?: string;
}

// ============================================================================
// Main API
// ============================================================================

/**
 * Look up or compute a capacity curve for a pool.
 * 
 * Flow:
 * 1. Check cache for existing valid curve
 * 2. If found, return it (instant)
 * 3. If not found, compute Tier 1 estimate (instant fallback)
 * 4. Optionally trigger async curve computation for future requests
 * 
 * @param poolId - Pool identifier
 * @param poolType - Type of pool (amm, clmm, dlmm)
 * @param hot - Hot data from ExecutionCache
 * @param config - Sizing configuration
 * @param triggerCompute - Whether to trigger async curve computation on miss
 */
export function lookupCapacity(
  poolId: string,
  poolType: PoolType,
  hot: PoolHotData,
  config: SizingConfig = DEFAULT_SIZING_CONFIG,
  triggerCompute: boolean = true
): CapacityCurve {
  // 1. Check cache first (instant)
  const cached = getCapacityCurve(poolId);
  if (cached) {
    return cached;
  }
  
  // 2. No cache - generate Tier 1 estimate
  const tier1Curve = generateTier1Curve(poolId, poolType, hot, config);
  
  // 3. Optionally trigger async computation for future requests
  if (triggerCompute) {
    setImmediate(() => {
      computeAndCacheCapacityCurve(poolId, poolType, hot, config);
    });
  }
  
  return tier1Curve;
}

/**
 * Calculate optimal trade size from a capacity curve.
 * 
 * The algorithm:
 * 1. Find the size where slippage equals the profit margin (break-even)
 * 2. Apply aggressiveness factor (e.g., use 70% of break-even capacity)
 * 3. Clamp to min/max bounds
 * 4. Optionally cap to max slippage
 * 
 * @param curve - Pre-computed capacity curve
 * @param profitBps - Expected profit in basis points
 * @param config - Sizing configuration
 * @param walletBalanceUsd - Optional wallet balance for capping
 */
export function getOptimalSizeFromCurve(
  curve: CapacityCurve,
  profitBps: number,
  config: SizingConfig = DEFAULT_SIZING_CONFIG,
  walletBalanceUsd?: number
): OptimalSizeResult {
  // Start with break-even capacity
  let sizeUsd = curve.breakEvenSizeUsd;
  let constrainedBy: OptimalSizeResult['constrainedBy'] = undefined;
  
  // Apply profit-based scaling
  // If profit is higher than break-even target (50 bps), we can size up
  // If lower, we should size down
  const profitRatio = profitBps / 50; // 50 bps is our break-even target
  if (profitRatio > 0) {
    sizeUsd *= Math.min(2, Math.sqrt(profitRatio)); // Square root scaling, capped at 2x
  }
  
  // Apply aggressiveness factor
  sizeUsd *= config.aggressiveness;
  
  // Apply max slippage constraint
  const maxSlippageSize = findSizeAtSlippage(curve.curve, config.maxSlippageBps);
  if (sizeUsd > maxSlippageSize) {
    sizeUsd = maxSlippageSize;
    constrainedBy = 'max_slippage';
  }
  
  // Apply min/max bounds
  if (sizeUsd < config.minSizeUsd) {
    sizeUsd = config.minSizeUsd;
    constrainedBy = 'min_size';
  }
  if (sizeUsd > config.maxSizeUsd) {
    sizeUsd = config.maxSizeUsd;
    constrainedBy = 'max_size';
  }
  
  // Apply wallet balance constraint
  if (config.respectWalletBalance && walletBalanceUsd !== undefined && walletBalanceUsd > 0) {
    if (sizeUsd > walletBalanceUsd) {
      sizeUsd = walletBalanceUsd;
      constrainedBy = 'wallet_balance';
    }
  }
  
  // Calculate expected slippage at final size
  const outputMultiplier = interpolateCurve(curve.curve, sizeUsd);
  const expectedSlippageBps = Math.round((1 - outputMultiplier) * 10000);
  
  return {
    sizeUsd,
    expectedSlippageBps,
    confidence: curve.confidence,
    constrainedBy,
    curveUsed: curve,
  };
}

/**
 * Compute and cache a capacity curve for a pool.
 * 
 * This is the "slow path" that does full curve computation.
 * It's called asynchronously and the result is cached.
 */
export function computeAndCacheCapacityCurve(
  poolId: string,
  poolType: PoolType,
  hot: PoolHotData,
  config: SizingConfig = DEFAULT_SIZING_CONFIG
): CapacityCurve | null {
  try {
    const adjustment = config.poolTypeAdjustments[poolType];
    let curve: CapacityCurve;
    
    switch (poolType) {
      case 'clmm': {
        const liquidity = hot.liquidity ?? BigInt(0);
        const sqrtPriceX64 = hot.sqrtPriceX64 ?? BigInt(1) << BigInt(64);
        const tickSpacing = hot.tickSpacing ?? 1;
        const feeBps = hot.feeRate ?? 30;
        
        if (liquidity <= BigInt(0)) {
          logger.debug('capacity.compute.skip_no_liquidity', {
            cat: 'sizing',
            poolId: poolId.slice(0, 12) + '...',
            poolType,
          });
          return null;
        }
        
        curve = computeClmmCapacityCurve(
          poolId,
          liquidity,
          sqrtPriceX64,
          tickSpacing,
          feeBps,
          adjustment
        );
        break;
      }
      
      case 'dlmm': {
        // For DLMM, we estimate TVL from liquidity or use a fallback
        // In reality, this should come from pool cache
        const tvlUsd = hot.liquidity ? Number(hot.liquidity) / 1e6 : 10000; // Rough estimate
        const binStep = hot.binStep ?? 10;
        const feeBps = hot.feeRate ?? 25;
        
        curve = computeDlmmCapacityCurve(
          poolId,
          tvlUsd,
          binStep,
          feeBps,
          adjustment
        );
        break;
      }
      
      case 'amm':
      default: {
        // For AMM, use liquidity as approximate reserve
        const reserveUsd = hot.liquidity ? Number(hot.liquidity) / 1e6 : 10000;
        const feeBps = hot.feeRate ?? 25;
        
        curve = computeAmmCapacityCurve(
          poolId,
          reserveUsd,
          reserveUsd,
          feeBps,
          adjustment
        );
        break;
      }
    }
    
    // Cache the result
    setCapacityCurve(poolId, curve);
    
    return curve;
  } catch (e) {
    logger.warn('capacity.compute.error', {
      cat: 'sizing',
      poolId: poolId.slice(0, 12) + '...',
      poolType,
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

/**
 * Invalidate and recompute capacity curve for a pool.
 * Called when tick/bin boundary crossing is detected.
 */
export function recomputeCapacityCurve(
  poolId: string,
  poolType: PoolType,
  hot: PoolHotData,
  config: SizingConfig = DEFAULT_SIZING_CONFIG
): void {
  // Invalidate existing curve
  invalidateCapacityCurve(poolId);
  
  // Recompute asynchronously
  setImmediate(() => {
    computeAndCacheCapacityCurve(poolId, poolType, hot, config);
  });
}

// ============================================================================
// Tier 1 Fallback (Instant Estimates)
// ============================================================================

/**
 * Generate a Tier 1 (instant) capacity curve estimate.
 * Used when no pre-computed curve is available.
 */
function generateTier1Curve(
  poolId: string,
  poolType: PoolType,
  hot: PoolHotData,
  config: SizingConfig
): CapacityCurve {
  const now = Date.now();
  const adjustment = config.poolTypeAdjustments[poolType];
  
  // Standard points for the curve
  const sizes = [1, 5, 10, 50, 100, 500, 1000];
  const curve = new Map<number, number>();
  
  let breakEvenSizeUsd = 50; // Default fallback
  let activeLiquidityUsd = 1000; // Default fallback
  
  switch (poolType) {
    case 'clmm': {
      const liquidity = hot.liquidity ?? BigInt(1000000);
      const sqrtPriceX64 = hot.sqrtPriceX64 ?? BigInt(1) << BigInt(64);
      const tickSpacing = hot.tickSpacing ?? 1;
      const feeBps = hot.feeRate ?? 30;
      
      for (const size of sizes) {
        const estimate = clmmTier1Estimate(size, liquidity, sqrtPriceX64, tickSpacing, feeBps);
        curve.set(size, estimate.outputMultiplier);
        if (size === 50) {
          breakEvenSizeUsd = estimate.breakEvenSizeUsd * adjustment;
          activeLiquidityUsd = breakEvenSizeUsd * 2; // Rough estimate
        }
      }
      break;
    }
    
    case 'dlmm': {
      const tvlUsd = hot.liquidity ? Number(hot.liquidity) / 1e6 : 10000;
      const binStep = hot.binStep ?? 10;
      const feeBps = hot.feeRate ?? 25;
      
      for (const size of sizes) {
        const estimate = dlmmTier1Estimate(size, tvlUsd, binStep, feeBps);
        curve.set(size, estimate.outputMultiplier);
        if (size === 50) {
          breakEvenSizeUsd = estimate.breakEvenSizeUsd * adjustment;
          activeLiquidityUsd = tvlUsd * 0.1 * adjustment; // 10% of TVL in active bin
        }
      }
      break;
    }
    
    case 'amm':
    default: {
      const reserveUsd = hot.liquidity ? Number(hot.liquidity) / 1e6 : 10000;
      const feeBps = hot.feeRate ?? 25;
      
      for (const size of sizes) {
        const estimate = ammTier1Estimate(size, reserveUsd, reserveUsd, feeBps);
        curve.set(size, estimate.outputMultiplier);
        if (size === 50) {
          breakEvenSizeUsd = estimate.breakEvenSizeUsd * adjustment;
          activeLiquidityUsd = reserveUsd * adjustment;
        }
      }
      break;
    }
  }
  
  return {
    poolId,
    poolType,
    computedAt: now,
    confidence: 'low',
    breakEvenSizeUsd,
    activeLiquidityUsd,
    curve,
    metadata: {
      tickSpacing: hot.tickSpacing,
      binStep: hot.binStep,
      feeBps: hot.feeRate,
      adjustment,
    },
  };
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Determine pool type from dex string
 */
export function getPoolTypeFromDex(dex: string, variant?: string): PoolType {
  const dexLower = (dex || '').toLowerCase();
  const variantLower = (variant || '').toLowerCase();
  
  // CLMM pools
  if (dexLower.includes('clmm') || dexLower === 'orca' || variantLower === 'clmm') {
    return 'clmm';
  }
  
  // DLMM pools (Meteora non-balanced)
  if (dexLower.includes('dlmm') || (dexLower === 'meteora' && !dexLower.includes('balanced'))) {
    return 'dlmm';
  }
  
  // Everything else is AMM
  return 'amm';
}

/**
 * Quick estimate of capacity without full curve computation.
 * Useful for filtering opportunities before detailed analysis.
 */
export function quickCapacityEstimate(
  poolType: PoolType,
  tvlUsd: number,
  adjustment: number = 1.0
): number {
  // Rule of thumb capacity based on pool type
  switch (poolType) {
    case 'amm':
      // AMM: can trade ~2% of TVL before 50 bps slippage
      return tvlUsd * 0.02 * adjustment;
    
    case 'clmm':
      // CLMM: more sensitive, ~1% of TVL
      return tvlUsd * 0.01 * adjustment;
    
    case 'dlmm':
      // DLMM: varies widely, ~1.5% of TVL
      return tvlUsd * 0.015 * adjustment;
    
    default:
      return tvlUsd * 0.01 * adjustment;
  }
}

/**
 * Get minimum viable trade size for a pool type.
 * Below this, fees dominate and trades are likely unprofitable.
 */
export function getMinViableSize(poolType: PoolType, feeBps: number): number {
  // Minimum size where expected profit can exceed fees
  // Assuming ~10 bps profit opportunity, need fee < 10 bps of trade
  // So trade > fee_usd / 0.001 roughly
  const feeDecimal = feeBps / 10000;
  
  // At $1 trade with 25 bps fee, fee is $0.0025
  // Need profit > fee, so at 10 bps profit, need trade where 10 bps > fee
  // This gives minimum around $2-5 for typical pools
  
  return Math.max(1, 5 * feeDecimal * 100); // Rough heuristic
}
