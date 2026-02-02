/**
 * Profit Optimizer for Multi-Hop Sizing
 * 
 * Finds the optimal trade size that maximizes expected profit
 * for a multi-hop arbitrage path using ternary search.
 * 
 * The profit function is typically unimodal (single peak):
 * - Small sizes: profit increases with size (more absolute profit)
 * - Peak: optimal size where marginal slippage equals marginal profit
 * - Large sizes: profit decreases (slippage exceeds profit margin)
 */

import type { SlippageModelParams, ConfidenceLevel } from './types.js';
import { computeHopOutput, getHopLiquidityUsd, type HopParams } from './slippageModels.js';

// ============================================================================
// Result Types
// ============================================================================

/**
 * Result from the profit optimization search.
 */
export interface OptimizationResult {
  /** Optimal trade size in USD (after safety margin) */
  optimalSizeUsd: number;
  
  /** Expected profit at optimal size in USD */
  expectedProfitUsd: number;
  
  /** Expected final output in USD */
  expectedOutputUsd: number;
  
  /** Total slippage across all hops in basis points */
  totalSlippageBps: number;
  
  /** Number of iterations used in search */
  iterations: number;
  
  /** Optimization method used */
  method: 'ternary_search' | 'binary_search' | 'analytical';
  
  /** Confidence level of the result */
  confidence: ConfidenceLevel;
  
  /** Raw optimal size before safety margin */
  rawOptimalSizeUsd?: number;
}

/**
 * Configuration for the optimization search.
 */
export interface OptimizationConfig {
  /** Minimum trade size in USD */
  minSizeUsd: number;
  
  /** Maximum trade size in USD */
  maxSizeUsd: number;
  
  /** Fixed costs to subtract from profit (gas, tips) */
  fixedCostUsd: number;
  
  /** Safety margin multiplier (0.5-1.0) */
  safetyMargin: number;
  
  /** Stop when search interval is smaller than this */
  searchPrecisionUsd: number;
  
  /** Maximum iterations */
  maxIterations: number;
  
  /** Slippage model parameters */
  slippageParams: SlippageModelParams;
}

/**
 * Search bounds computed from opportunity data.
 */
export interface SearchBounds {
  /** Lower bound for search */
  lower: number;
  
  /** Upper bound for search */
  upper: number;
  
  /** Analytical estimate of optimal size */
  estimate: number;
  
  /** Confidence in the bounds estimate */
  confidence: ConfidenceLevel;
}

// ============================================================================
// Multi-Hop Simulation
// ============================================================================

/**
 * Simulate a trade through all hops.
 * 
 * @param inputUsd - Initial input amount in USD
 * @param hops - Array of hop parameters
 * @param params - Slippage model parameters
 * @returns Final output and per-hop outputs
 */
export function simulateMultiHopTrade(
  inputUsd: number,
  hops: HopParams[],
  params: SlippageModelParams
): { finalOutput: number; hopOutputs: number[] } {
  if (inputUsd <= 0 || hops.length === 0) {
    return { finalOutput: 0, hopOutputs: [] };
  }
  
  let currentAmount = inputUsd;
  const hopOutputs: number[] = [];
  
  for (const hop of hops) {
    currentAmount = computeHopOutput(currentAmount, hop, params);
    hopOutputs.push(currentAmount);
    
    // Early exit if amount becomes negligible
    if (currentAmount <= 0.001) {
      break;
    }
  }
  
  return { finalOutput: currentAmount, hopOutputs };
}

/**
 * Compute expected profit at a given trade size.
 * 
 * Profit = FinalOutput - Input - FixedCosts
 * 
 * @param sizeUsd - Trade size in USD
 * @param hops - Array of hop parameters
 * @param fixedCostUsd - Fixed costs (gas, tips) in USD
 * @param params - Slippage model parameters
 * @returns Expected profit in USD (can be negative)
 */
export function computeProfitAtSize(
  sizeUsd: number,
  hops: HopParams[],
  fixedCostUsd: number,
  params: SlippageModelParams
): number {
  const { finalOutput } = simulateMultiHopTrade(sizeUsd, hops, params);
  return finalOutput - sizeUsd - fixedCostUsd;
}

// ============================================================================
// Search Bounds Computation
// ============================================================================

/**
 * Compute optimal search bounds using analytical estimates.
 * 
 * For a single constant-product AMM with profit rate p:
 *   optimal_size = Reserve * (sqrt(p) - 1)
 * 
 * For multi-hop, we adjust for compounding slippage:
 *   optimal_estimate = bottleneck_liquidity * (sqrt(p) - 1) / sqrt(numHops)
 * 
 * @param profitBps - Theoretical profit in basis points
 * @param hops - Array of hop parameters
 * @param config - Optimization config (for min/max bounds)
 * @returns Search bounds
 */
export function computeSearchBounds(
  profitBps: number,
  hops: HopParams[],
  config: OptimizationConfig
): SearchBounds {
  const numHops = hops.length;
  
  if (numHops === 0 || profitBps <= 0) {
    return {
      lower: config.minSizeUsd,
      upper: config.maxSizeUsd,
      estimate: config.minSizeUsd,
      confidence: 'low',
    };
  }
  
  // Convert profit bps to rate (e.g., 50 bps -> 1.005)
  const profitRate = 1 + profitBps / 10000;
  
  // Find bottleneck liquidity (minimum across hops)
  let minLiquidity = Infinity;
  let dataQuality = 0;
  
  for (const hop of hops) {
    const hopLiq = getHopLiquidityUsd(hop, config.slippageParams);
    if (hopLiq > 0 && hopLiq < minLiquidity) {
      minLiquidity = hopLiq;
    }
    // Track data quality
    if (hop.reserveIn || hop.activeLiquidity || hop.tvlUsd) {
      dataQuality++;
    }
  }
  
  // Fallback if no liquidity data
  if (!Number.isFinite(minLiquidity) || minLiquidity <= 0) {
    minLiquidity = 10000;
  }
  
  // Analytical estimate for optimal size
  // Single-pool: optimal = L * (sqrt(p) - 1)
  // Multi-hop adjustment: divide by sqrt(numHops) to account for compounding
  const singlePoolFactor = Math.sqrt(profitRate) - 1;
  const multiHopFactor = singlePoolFactor / Math.sqrt(numHops);
  const estimate = minLiquidity * multiHopFactor;
  
  // Determine confidence based on data availability
  let confidence: ConfidenceLevel;
  if (dataQuality === numHops) {
    confidence = 'high';
  } else if (dataQuality >= numHops / 2) {
    confidence = 'medium';
  } else {
    confidence = 'low';
  }
  
  // Compute search bounds with safety margins
  // Lower: don't search below 10% of estimate or minSizeUsd
  const lower = Math.max(
    config.minSizeUsd,
    estimate * 0.1
  );
  
  // Upper: don't search above 10x estimate, 15% of bottleneck, or maxSizeUsd
  const upper = Math.min(
    config.maxSizeUsd,
    estimate * 10,
    minLiquidity * 0.15
  );
  
  // Ensure lower <= upper
  if (lower > upper) {
    return {
      lower: config.minSizeUsd,
      upper: Math.max(config.minSizeUsd * 2, upper),
      estimate: config.minSizeUsd,
      confidence: 'low',
    };
  }
  
  return { lower, upper, estimate, confidence };
}

// ============================================================================
// Ternary Search Optimization
// ============================================================================

/**
 * Find optimal trade size using ternary search.
 * 
 * Ternary search is optimal for finding the maximum of a unimodal function.
 * It narrows the search interval by 1/3 each iteration.
 * 
 * The profit function is typically unimodal because:
 * - Small trades: slippage is minimal, profit grows with size
 * - Large trades: slippage dominates, profit decreases
 * 
 * @param hops - Array of hop parameters
 * @param bounds - Search bounds
 * @param config - Optimization configuration
 * @returns Optimization result
 */
export function findOptimalSizeTernarySearch(
  hops: HopParams[],
  bounds: SearchBounds,
  config: OptimizationConfig
): OptimizationResult {
  let low = bounds.lower;
  let high = bounds.upper;
  let iterations = 0;
  
  // Quick check: is any profit possible?
  const profitAtLow = computeProfitAtSize(low, hops, config.fixedCostUsd, config.slippageParams);
  const profitAtHigh = computeProfitAtSize(high, hops, config.fixedCostUsd, config.slippageParams);
  
  if (profitAtLow <= 0 && profitAtHigh <= 0) {
    // Try the estimate
    const profitAtEstimate = computeProfitAtSize(bounds.estimate, hops, config.fixedCostUsd, config.slippageParams);
    
    if (profitAtEstimate <= 0) {
      // No profitable size found
      return buildResult(config.minSizeUsd, hops, config, iterations, bounds.confidence);
    }
    
    // Estimate is profitable, search around it
    low = Math.max(config.minSizeUsd, bounds.estimate * 0.5);
    high = bounds.estimate * 2;
  }
  
  // Ternary search for maximum
  while (high - low > config.searchPrecisionUsd && iterations < config.maxIterations) {
    const third = (high - low) / 3;
    const mid1 = low + third;
    const mid2 = high - third;
    
    const profit1 = computeProfitAtSize(mid1, hops, config.fixedCostUsd, config.slippageParams);
    const profit2 = computeProfitAtSize(mid2, hops, config.fixedCostUsd, config.slippageParams);
    
    if (profit1 < profit2) {
      // Maximum is in right 2/3
      low = mid1;
    } else {
      // Maximum is in left 2/3
      high = mid2;
    }
    
    iterations++;
  }
  
  // Optimal is at midpoint of final interval
  const rawOptimal = (low + high) / 2;
  
  return buildResult(rawOptimal, hops, config, iterations, bounds.confidence);
}

/**
 * Build the optimization result with safety margin applied.
 */
function buildResult(
  rawOptimalSizeUsd: number,
  hops: HopParams[],
  config: OptimizationConfig,
  iterations: number,
  confidence: ConfidenceLevel
): OptimizationResult {
  // Apply safety margin
  const safeSize = rawOptimalSizeUsd * config.safetyMargin;
  
  // Clamp to bounds
  const finalSize = Math.max(
    config.minSizeUsd,
    Math.min(config.maxSizeUsd, safeSize)
  );
  
  // Compute final metrics at safe size
  const { finalOutput } = simulateMultiHopTrade(finalSize, hops, config.slippageParams);
  const expectedProfit = finalOutput - finalSize - config.fixedCostUsd;
  
  // Calculate total slippage
  const idealOutput = finalSize; // Without slippage, output = input for arb
  const totalSlippageBps = idealOutput > 0
    ? Math.round((1 - finalOutput / idealOutput) * 10000)
    : 0;
  
  return {
    optimalSizeUsd: finalSize,
    expectedProfitUsd: expectedProfit,
    expectedOutputUsd: finalOutput,
    totalSlippageBps: Math.max(0, totalSlippageBps),
    iterations,
    method: 'ternary_search',
    confidence,
    rawOptimalSizeUsd,
  };
}

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Find the optimal trade size for a multi-hop arbitrage.
 * 
 * This is the main entry point that:
 * 1. Computes search bounds from analytical estimates
 * 2. Runs ternary search to find the maximum profit
 * 3. Applies safety margin and returns result
 * 
 * @param profitBps - Theoretical profit in basis points
 * @param hops - Array of hop parameters
 * @param config - Optimization configuration
 * @returns Optimization result
 */
export function findOptimalSize(
  profitBps: number,
  hops: HopParams[],
  config: OptimizationConfig
): OptimizationResult {
  // Compute search bounds
  const bounds = computeSearchBounds(profitBps, hops, config);
  
  // Run ternary search
  return findOptimalSizeTernarySearch(hops, bounds, config);
}

/**
 * Quick analytical estimate without full search.
 * Useful for fast fallback or initial estimate.
 * 
 * @param profitBps - Theoretical profit in basis points
 * @param bottleneckLiquidityUsd - Minimum liquidity across hops
 * @param numHops - Number of hops
 * @returns Estimated optimal size in USD
 */
export function quickOptimalEstimate(
  profitBps: number,
  bottleneckLiquidityUsd: number,
  numHops: number
): number {
  if (profitBps <= 0 || bottleneckLiquidityUsd <= 0 || numHops <= 0) {
    return 0;
  }
  
  const profitRate = 1 + profitBps / 10000;
  const factor = (Math.sqrt(profitRate) - 1) / Math.sqrt(numHops);
  
  return bottleneckLiquidityUsd * factor;
}
