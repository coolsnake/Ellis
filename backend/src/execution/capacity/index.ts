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
  DEFAULT_BREAK_EVEN_SLIPPAGE_BPS,
  CONFIDENCE_SAFETY_FACTORS,
  interpolateCurve,
  findSizeAtSlippage,
  getPoolTypeFromDex,
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
import { getPoolCalibration, getCalibrationWithFallback, getPoolTypeCalibration } from './calibrationStore.js';

import { logger } from '../../utils/logger.js';

// Re-export types and utilities
export type { CapacityCurve, PoolType, SizingConfig, OptimalSizeResult, Tier1EstimateResult };
export { DEFAULT_SIZING_CONFIG, getPoolTypeFromDex } from './types.js';
export { getCapacityCurve, setCapacityCurve, invalidateCapacityCurve, hasValidCurve } from './curveCache.js';
export {
  migrateFromDynamicSizing,
  migrateExecutorConfig,
  needsMigration,
  validateSizingConfig,
  uiAdjustmentToMultiplier,
  multiplierToUiAdjustment,
} from './configMigration.js';

// Re-export calibration store functions
export {
  loadCalibrations,
  saveCalibrations,
  saveOnShutdown,
  getPoolCalibration,
  getCalibrationWithFallback,
  getPoolTypeCalibration,
  recordObservation,
  getCalibrationStats,
  getCalibratedPoolCount,
  clearCalibrations,
  type SlippageObservation,
  type PoolCalibration,
} from './calibrationStore.js';

// Re-export feedback collector functions
export {
  recordSlippageFeedback,
  recordPoolFeedback,
  type FeedbackOutcome,
} from './feedbackCollector.js';

// Re-export multi-hop optimization types and functions
export type {
  MultiHopOptimizationConfig,
  SlippageModelParams,
} from './types.js';
export {
  DEFAULT_MULTIHOP_CONFIG,
  DEFAULT_SLIPPAGE_PARAMS,
} from './types.js';

// Re-export multi-hop sizing functions
export {
  calculateMultiHopOptimalSize,
  getQuickMultiHopEstimate,
  isMultiHopOptimizationEnabled,
  getMultiHopConfig,
  type OpportunityData,
  type MultiHopSizingResult,
} from './multiHopSizing.js';

// Re-export profit optimizer functions
export {
  findOptimalSize,
  quickOptimalEstimate,
  simulateMultiHopTrade,
  computeProfitAtSize,
  computeSearchBounds,
  type OptimizationResult,
  type OptimizationConfig,
  type SearchBounds,
} from './profitOptimizer.js';

// Re-export slippage models
export {
  computeHopOutput,
  computeAmmOutput,
  computeClmmOutput,
  computeDlmmOutput,
  hasValidHopData,
  getHopLiquidityUsd,
  type HopParams,
} from './slippageModels.js';

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
 * @param skipCalibration - Whether to skip learned calibration (for multi-hop mode)
 */
export function lookupCapacity(
  poolId: string,
  poolType: PoolType,
  hot: PoolHotData,
  config: SizingConfig = DEFAULT_SIZING_CONFIG,
  triggerCompute: boolean = true,
  skipCalibration: boolean = false
): CapacityCurve {
  // 1. Check cache first (instant) - but only if we're not skipping calibration
  // When skipping calibration, we need fresh computation without learned factors
  if (!skipCalibration) {
    const cached = getCapacityCurve(poolId);
    if (cached) {
      logger.debug('capacity.lookup.cache_hit', {
        cat: 'sizing',
        poolId: poolId.slice(0, 12) + '...',
        poolType,
        breakEvenSizeUsd: cached.breakEvenSizeUsd.toFixed(2),
        confidence: cached.confidence,
        hasCalibration: !!cached.metadata?.calibration,
      });
      return cached;
    }
  }
  
  // 2. No cache - try SYNCHRONOUS full computation first for accurate sizing
  // This ensures the first call gets the best possible estimate with calibration
  if (triggerCompute) {
    const fullCurve = computeAndCacheCapacityCurve(poolId, poolType, hot, config, DEFAULT_BREAK_EVEN_SLIPPAGE_BPS, skipCalibration);
    if (fullCurve) {
      logger.debug('capacity.lookup.computed', {
        cat: 'sizing',
        poolId: poolId.slice(0, 12) + '...',
        poolType,
        breakEvenSizeUsd: fullCurve.breakEvenSizeUsd.toFixed(2),
        confidence: fullCurve.confidence,
        hasCalibration: !!fullCurve.metadata?.calibration,
        hotDataAvailable: !!(hot.liquidity || hot.sqrtPriceX64),
        skipCalibration,
      });
      return fullCurve;
    }
  }
  
  // 3. Fall back to Tier 1 estimate if full computation failed
  // Tier 1 now also applies calibration if available (unless skipped)
  const tier1Curve = generateTier1Curve(poolId, poolType, hot, config, DEFAULT_BREAK_EVEN_SLIPPAGE_BPS, skipCalibration);
  
  logger.debug('capacity.lookup.tier1_fallback', {
    cat: 'sizing',
    poolId: poolId.slice(0, 12) + '...',
    poolType,
    breakEvenSizeUsd: tier1Curve.breakEvenSizeUsd.toFixed(2),
    hasCalibration: !!tier1Curve.metadata?.calibration,
    reason: 'full_computation_failed_or_disabled',
    skipCalibration,
  });
  
  // Cache the Tier 1 curve so future lookups don't recompute
  // But only cache if we didn't skip calibration (calibration-free curves shouldn't pollute cache)
  if (!skipCalibration) {
    setCapacityCurve(poolId, tier1Curve);
  }
  
  return tier1Curve;
}

/**
 * Calculate optimal trade size from a capacity curve.
 * 
 * The algorithm:
 * 1. Find the size where slippage equals the profit margin (break-even)
 * 2. Apply confidence-based safety factor (lower confidence = smaller trades)
 * 3. Apply aggressiveness factor (e.g., use 70% of break-even capacity)
 * 4. Clamp to min/max bounds
 * 5. Optionally cap to max slippage
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
  let sizeUsd: number;
  let constrainedBy: OptimalSizeResult['constrainedBy'] = undefined;
  
  // Get confidence-based safety factor
  // Lower confidence = more conservative sizing to account for uncertainty
  const confidenceFactor = CONFIDENCE_SAFETY_FACTORS[curve.confidence];
  
  if (config.useBreakEvenFloor) {
    // Traditional behavior: Start with break-even capacity
    sizeUsd = curve.breakEvenSizeUsd;
    
    // Apply profit-based scaling
    // The break-even target is stored in curve metadata, fallback to 50 bps
    const breakEvenTargetBps = (curve.metadata as any)?.breakEvenTargetBps ?? DEFAULT_BREAK_EVEN_SLIPPAGE_BPS;
    const profitRatio = profitBps / breakEvenTargetBps;
    if (profitRatio > 0) {
      sizeUsd *= Math.min(2, Math.sqrt(profitRatio)); // Square root scaling, capped at 2x
    }
    
    // Apply aggressiveness factor
    sizeUsd *= config.aggressiveness;
    
    // Apply confidence-based safety factor
    // This scales down trades when we're less certain about our estimates
    sizeUsd *= confidenceFactor;
  } else {
    // New behavior: Don't use break-even as floor
    // Start from minSizeUsd and let on-chain router validate profitability
    // This allows smaller trades when the on-chain profit check will verify
    sizeUsd = config.minSizeUsd;
  }
  
  // Apply max slippage constraint
  const maxSlippageSize = findSizeAtSlippage(curve.curve, config.maxSlippageBps);
  if (sizeUsd > maxSlippageSize) {
    sizeUsd = maxSlippageSize;
    constrainedBy = 'max_slippage';
  }
  
  // Apply capacity constraint (based on active liquidity)
  // Don't exceed a fraction of active liquidity even if break-even suggests we can
  const maxCapacitySize = curve.activeLiquidityUsd * 0.3 * confidenceFactor;
  if (sizeUsd > maxCapacitySize && maxCapacitySize > config.minSizeUsd) {
    sizeUsd = maxCapacitySize;
    constrainedBy = 'capacity';
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
 * 
 * @param poolId - Pool identifier
 * @param poolType - Pool type (amm, clmm, dlmm)
 * @param hot - Hot data from execution cache
 * @param config - Sizing configuration
 * @param profitBps - Optional profit margin in bps (defaults to 50)
 * @param skipCalibration - Whether to skip learned calibration
 */
export function computeAndCacheCapacityCurve(
  poolId: string,
  poolType: PoolType,
  hot: PoolHotData,
  config: SizingConfig = DEFAULT_SIZING_CONFIG,
  profitBps: number = DEFAULT_BREAK_EVEN_SLIPPAGE_BPS,
  skipCalibration: boolean = false
): CapacityCurve | null {
  try {
    // Get user-configured adjustment
    const userAdjustment = config.poolTypeAdjustments[poolType];
    
    // Get calibration with fallback to pool-type aggregate for cold start
    // Skip calibration if requested (e.g., when multi-hop mode is enabled)
    let calibration: ReturnType<typeof getCalibrationWithFallback> = undefined;
    let learnedFactor = 1.0;
    let isFallbackCalibration = false;
    
    if (!skipCalibration) {
      calibration = getCalibrationWithFallback(poolId, poolType);
      learnedFactor = calibration && calibration.confidence > 0.2 
        ? calibration.scaleFactor 
        : 1.0;
      isFallbackCalibration = calibration && (calibration as any).isFallback === true;
    }
    
    // Combine adjustments: user preference * learned correction
    const adjustment = userAdjustment * learnedFactor;
    
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
          adjustment,
          profitBps
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
          adjustment,
          profitBps
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
          adjustment,
          profitBps
        );
        break;
      }
    }
    
    // Add calibration info to curve metadata (only if calibration was used)
    if (!skipCalibration && calibration && calibration.confidence > 0.2) {
      const poolCal = calibration as any;
      curve.metadata = {
        ...curve.metadata,
        calibration: {
          scaleFactor: calibration.scaleFactor,
          confidence: calibration.confidence,
          observationCount: poolCal.observations?.length ?? 0,
          avgSlippageError: poolCal.avgSlippageError ?? 0,
          isFallback: isFallbackCalibration,
        },
      };
      
      logger.debug('capacity.compute.calibration_applied', {
        cat: 'sizing',
        poolId: poolId.slice(0, 12) + '...',
        poolType,
        learnedFactor: learnedFactor.toFixed(3),
        confidence: calibration.confidence.toFixed(2),
        effectiveAdjustment: adjustment.toFixed(3),
        isFallback: isFallbackCalibration,
        profitBps,
      });
    }
    
    // Cache the result (only if calibration wasn't skipped to avoid polluting cache)
    if (!skipCalibration) {
      setCapacityCurve(poolId, curve);
    }
    
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
 * 
 * Now also applies learned calibration if available, with fallback
 * to pool-type aggregate calibration for cold start.
 * 
 * @param poolId - Pool identifier
 * @param poolType - Pool type
 * @param hot - Hot data from execution cache
 * @param config - Sizing configuration
 * @param profitBps - Optional profit margin in bps (defaults to 50)
 * @param skipCalibration - Whether to skip learned calibration
 */
function generateTier1Curve(
  poolId: string,
  poolType: PoolType,
  hot: PoolHotData,
  config: SizingConfig,
  profitBps: number = DEFAULT_BREAK_EVEN_SLIPPAGE_BPS,
  skipCalibration: boolean = false
): CapacityCurve {
  const now = Date.now();
  
  // Get user-configured adjustment
  const userAdjustment = config.poolTypeAdjustments[poolType];
  
  // Get calibration with fallback to pool-type aggregate for cold start
  // Skip calibration if requested (e.g., when multi-hop mode is enabled)
  let calibration: ReturnType<typeof getCalibrationWithFallback> = undefined;
  let learnedFactor = 1.0;
  let isFallbackCalibration = false;
  
  if (!skipCalibration) {
    calibration = getCalibrationWithFallback(poolId, poolType);
    learnedFactor = calibration && calibration.confidence > 0.2 
      ? calibration.scaleFactor 
      : 1.0;
    isFallbackCalibration = calibration && (calibration as any).isFallback === true;
  }
  
  // Combine adjustments: user preference * learned correction
  const adjustment = userAdjustment * learnedFactor;
  
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
        const estimate = clmmTier1Estimate(size, liquidity, sqrtPriceX64, tickSpacing, feeBps, profitBps);
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
        const estimate = dlmmTier1Estimate(size, tvlUsd, binStep, feeBps, profitBps);
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
        const estimate = ammTier1Estimate(size, reserveUsd, reserveUsd, feeBps, profitBps);
        curve.set(size, estimate.outputMultiplier);
        if (size === 50) {
          breakEvenSizeUsd = estimate.breakEvenSizeUsd * adjustment;
          activeLiquidityUsd = reserveUsd * adjustment;
        }
      }
      break;
    }
  }
  
  // Build calibration metadata if calibration was applied
  const calibrationMeta = calibration && calibration.confidence > 0.2 ? {
    calibration: {
      scaleFactor: calibration.scaleFactor,
      confidence: calibration.confidence,
      observationCount: (calibration as any).observations?.length ?? 0,
      avgSlippageError: (calibration as any).avgSlippageError ?? 0,
      isFallback: isFallbackCalibration,
    },
  } : {};
  
  // Log when calibration is applied in Tier 1
  if (calibration && calibration.confidence > 0.2) {
    logger.debug('capacity.tier1.calibration_applied', {
      cat: 'sizing',
      poolId: poolId.slice(0, 12) + '...',
      poolType,
      learnedFactor: learnedFactor.toFixed(3),
      confidence: calibration.confidence.toFixed(2),
      effectiveAdjustment: adjustment.toFixed(3),
      breakEvenSizeUsd: breakEvenSizeUsd.toFixed(2),
      isFallback: isFallbackCalibration,
      profitBps,
    });
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
      breakEvenTargetBps: profitBps,
      ...calibrationMeta,
    },
  };
}

// ============================================================================
// Utility Functions
// ============================================================================

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
