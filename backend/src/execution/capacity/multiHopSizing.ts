/**
 * Multi-Hop Sizing Entry Point
 * 
 * Main integration module that connects the profit optimization system
 * to the arbExecutor. Extracts hop parameters from opportunity data
 * and execution cache, then runs the optimization.
 */

import type {
  SizingConfig,
  MultiHopOptimizationConfig,
  ConfidenceLevel,
} from './types.js';
import { DEFAULT_MULTIHOP_CONFIG, DEFAULT_SLIPPAGE_PARAMS, getPoolTypeFromDex } from './types.js';
import { findOptimalSize, quickOptimalEstimate, type OptimizationResult } from './profitOptimizer.js';
import { type HopParams, hasValidHopData, getHopLiquidityUsd } from './slippageModels.js';
import { executionCache } from '../cache.js';
import { logger } from '../../utils/logger.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Opportunity data needed for multi-hop sizing.
 * Matches the Opportunity interface from arbExecutor.
 */
export interface OpportunityData {
  path: string[];
  profit_bps: number;
  net_bps?: number;
  hop_pool_ids?: string[];
  hop_dexes?: string[];
  hop_fee_bps?: number[];
  hop_liquidity_display?: number[];
  est_capacity?: number;
  min_edge_liquidity?: number;
}

/**
 * Result from multi-hop sizing calculation.
 */
export interface MultiHopSizingResult {
  /** Optimal trade size in USD */
  sizeUsd: number;
  
  /** Expected profit in USD */
  expectedProfitUsd: number;
  
  /** Expected slippage in basis points */
  expectedSlippageBps: number;
  
  /** Confidence level */
  confidence: ConfidenceLevel;
  
  /** Sizing method used */
  method: 'multi_hop_optimization' | 'bottleneck_fallback';
  
  /** Additional details for debugging */
  details?: {
    iterations?: number;
    hopsAnalyzed?: number;
    missingDataHops?: number;
    rawOptimalSize?: number;
    searchBoundsLower?: number;
    searchBoundsUpper?: number;
  };
}

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Calculate optimal trade size using multi-hop profit optimization.
 * 
 * This is called from arbExecutor.calculateCapacityBasedSize() when
 * multiHopOptimization is enabled.
 * 
 * @param opp - Opportunity data from arb-rs
 * @param config - Sizing configuration
 * @param walletBalanceUsd - Available wallet balance (for constraint)
 * @returns MultiHopSizingResult or null if optimization fails/insufficient data
 */
export function calculateMultiHopOptimalSize(
  opp: OpportunityData,
  config: SizingConfig,
  walletBalanceUsd: number = Infinity
): MultiHopSizingResult | null {
  const multiHopConfig = config.multiHopOptimization ?? DEFAULT_MULTIHOP_CONFIG;
  
  // Check if enabled
  if (!multiHopConfig.enabled) {
    return null;
  }
  
  const hopPoolIds = opp.hop_pool_ids ?? [];
  const hopDexes = opp.hop_dexes ?? [];
  const hopFeeBps = opp.hop_fee_bps ?? [];
  const hopLiquidityDisplay = opp.hop_liquidity_display ?? [];
  
  // Need at least one hop
  if (hopPoolIds.length === 0) {
    logger.debug('multiHopSizing.no_hop_data', {
      cat: 'sizing',
      path: opp.path.join('->'),
    });
    return null;
  }
  
  // Build hop parameters from execution cache and opportunity data
  const { hops, missingDataCount } = buildHopParams(
    hopPoolIds,
    hopDexes,
    hopFeeBps,
    hopLiquidityDisplay,
    multiHopConfig.slippageParams ?? DEFAULT_SLIPPAGE_PARAMS
  );
  
  // Check if too much data is missing
  const missingRatio = missingDataCount / hops.length;
  if (missingRatio > 0.5 && multiHopConfig.fallbackToBottleneck) {
    logger.debug('multiHopSizing.insufficient_data', {
      cat: 'sizing',
      path: opp.path.join('->'),
      missingDataCount,
      totalHops: hops.length,
      missingRatio: missingRatio.toFixed(2),
    });
    return null; // Caller should fall back to bottleneck method
  }
  
  // Get profit in basis points
  const profitBps = opp.net_bps ?? opp.profit_bps ?? 50;
  
  // Constrain max size by wallet balance
  const effectiveMaxSize = Math.min(config.maxSizeUsd, walletBalanceUsd);
  
  // Build optimization config
  const optimizationConfig = {
    minSizeUsd: config.minSizeUsd,
    maxSizeUsd: effectiveMaxSize,
    fixedCostUsd: multiHopConfig.fixedCostUsd,
    safetyMargin: multiHopConfig.safetyMargin,
    searchPrecisionUsd: multiHopConfig.searchPrecisionUsd,
    maxIterations: multiHopConfig.maxIterations,
    slippageParams: multiHopConfig.slippageParams ?? DEFAULT_SLIPPAGE_PARAMS,
  };
  
  try {
    // Run profit optimization
    const result = findOptimalSize(profitBps, hops, optimizationConfig);
    
    // Log the result
    logger.debug('multiHopSizing.optimized', {
      cat: 'sizing',
      path: opp.path.join('->'),
      profitBps,
      optimalSizeUsd: result.optimalSizeUsd.toFixed(2),
      expectedProfitUsd: result.expectedProfitUsd.toFixed(4),
      expectedSlippageBps: result.totalSlippageBps,
      iterations: result.iterations,
      confidence: result.confidence,
      hops: hops.length,
      missingData: missingDataCount,
      rawOptimal: result.rawOptimalSizeUsd?.toFixed(2),
    });
    
    return {
      sizeUsd: result.optimalSizeUsd,
      expectedProfitUsd: result.expectedProfitUsd,
      expectedSlippageBps: result.totalSlippageBps,
      confidence: result.confidence,
      method: 'multi_hop_optimization',
      details: {
        iterations: result.iterations,
        hopsAnalyzed: hops.length,
        missingDataHops: missingDataCount,
        rawOptimalSize: result.rawOptimalSizeUsd,
      },
    };
  } catch (e) {
    logger.warn('multiHopSizing.optimization_failed', {
      cat: 'sizing',
      path: opp.path.join('->'),
      error: String((e as any)?.message ?? e),
    });
    return null;
  }
}

/**
 * Get a quick analytical estimate without full optimization.
 * Useful for fast fallback or comparison.
 * 
 * @param opp - Opportunity data
 * @param config - Sizing configuration
 * @returns Estimated optimal size in USD
 */
export function getQuickMultiHopEstimate(
  opp: OpportunityData,
  config: SizingConfig
): number {
  const profitBps = opp.net_bps ?? opp.profit_bps ?? 50;
  const numHops = opp.hop_pool_ids?.length ?? (opp.path.length - 1);
  const bottleneckLiq = opp.est_capacity ?? opp.min_edge_liquidity ?? 10000;
  
  const estimate = quickOptimalEstimate(profitBps, bottleneckLiq, numHops);
  
  // Apply aggressiveness and clamp to bounds
  let size = estimate * config.aggressiveness;
  size = Math.max(config.minSizeUsd, Math.min(config.maxSizeUsd, size));
  
  return size;
}

// ============================================================================
// Hop Parameter Extraction
// ============================================================================

/**
 * Build hop parameters from opportunity data and execution cache.
 * 
 * @param hopPoolIds - Pool IDs for each hop
 * @param hopDexes - DEX names for each hop
 * @param hopFeeBps - Fee in bps for each hop
 * @param hopLiquidityDisplay - Liquidity display values for each hop
 * @param slippageParams - Slippage model parameters
 * @returns Array of HopParams and count of hops with missing data
 */
function buildHopParams(
  hopPoolIds: string[],
  hopDexes: string[],
  hopFeeBps: number[],
  hopLiquidityDisplay: number[],
  slippageParams: typeof DEFAULT_SLIPPAGE_PARAMS
): { hops: HopParams[]; missingDataCount: number } {
  const hops: HopParams[] = [];
  let missingDataCount = 0;
  
  for (let i = 0; i < hopPoolIds.length; i++) {
    // Clean up pool ID (remove reverse suffix)
    const poolId = hopPoolIds[i].replace(/[#-]rev$/, '');
    const dex = hopDexes[i] ?? '';
    const poolType = getPoolTypeFromDex(dex);
    const feeBps = hopFeeBps[i] ?? 25;
    const liquidityDisplay = hopLiquidityDisplay[i];
    
    // Get data from execution cache
    const hot = executionCache.getHot(poolId);
    const staticData = executionCache.getStatic(poolId);
    
    const hop: HopParams = {
      poolId,
      poolType,
      feeBps,
    };
    
    // Populate pool-type-specific data
    let hasData = false;
    
    if (poolType === 'amm') {
      // AMM: Try to get reserves from static cache
      // Note: native_reserve_a_raw/b_raw are added dynamically to static cache, not in PoolStatic type
      const staticAny = staticData as any;
      const reserveA = parseReserveRaw(staticAny?.native_reserve_a_raw);
      const reserveB = parseReserveRaw(staticAny?.native_reserve_b_raw);
      
      if (reserveA > 0 && reserveB > 0) {
        // We have raw reserves - convert to USD approximation
        // Use liquidity_display as a sanity check
        hop.reserveIn = reserveA;
        hop.reserveOut = reserveB;
        hasData = true;
      } else if (liquidityDisplay && liquidityDisplay > 0) {
        // Fallback: estimate reserves from liquidity display
        // Assume roughly balanced pool
        hop.reserveIn = liquidityDisplay / 2;
        hop.reserveOut = liquidityDisplay / 2;
        hasData = true;
      }
    } else if (poolType === 'clmm') {
      // CLMM: Get liquidity and sqrt price from hot cache
      hop.activeLiquidity = hot?.liquidity;
      hop.sqrtPriceX64 = hot?.sqrtPriceX64;
      hop.tickSpacing = hot?.tickSpacing ?? staticData?.tickSpacing ?? staticData?.tick_spacing ?? 1;
      
      if (hop.activeLiquidity && hop.activeLiquidity > BigInt(0)) {
        hasData = true;
      } else if (liquidityDisplay && liquidityDisplay > 0) {
        // Fallback: convert liquidity_display to approximate active liquidity
        // This is a rough approximation
        hop.activeLiquidity = BigInt(Math.floor(liquidityDisplay * 1e6));
        hasData = true;
      }
    } else if (poolType === 'dlmm') {
      // DLMM: Get bin data from hot cache
      hop.binStep = hot?.binStep ?? staticData?.binStep ?? 10;
      hop.tvlUsd = liquidityDisplay;
      
      if (hop.tvlUsd && hop.tvlUsd > 0) {
        // Estimate active bin liquidity
        hop.activeBinLiquidity = hop.tvlUsd * slippageParams.dlmm.activeBinFraction;
        hasData = true;
      }
    }
    
    hops.push(hop);
    
    if (!hasData) {
      missingDataCount++;
    }
  }
  
  return { hops, missingDataCount };
}

/**
 * Parse raw reserve value from cache.
 * Handles string representations of big integers.
 */
function parseReserveRaw(raw: string | undefined): number {
  if (!raw) return 0;
  
  try {
    // Raw reserves are typically in atomic units
    // Convert to a rough USD value by dividing by 1e6 (approximate)
    // This is a simplification - actual conversion depends on token decimals and price
    const rawBigInt = BigInt(raw);
    return Number(rawBigInt) / 1e6;
  } catch {
    return 0;
  }
}

// ============================================================================
// Exported Utilities
// ============================================================================

/**
 * Check if multi-hop optimization is enabled in config.
 */
export function isMultiHopOptimizationEnabled(config: SizingConfig): boolean {
  return config.multiHopOptimization?.enabled ?? false;
}

/**
 * Get the merged multi-hop config with defaults.
 */
export function getMultiHopConfig(config: SizingConfig): MultiHopOptimizationConfig {
  const userConfig = config.multiHopOptimization;
  if (!userConfig) {
    return DEFAULT_MULTIHOP_CONFIG;
  }
  return {
    ...DEFAULT_MULTIHOP_CONFIG,
    ...userConfig,
    slippageParams: {
      ...DEFAULT_SLIPPAGE_PARAMS,
      ...(userConfig.slippageParams ?? {}),
    },
  };
}
