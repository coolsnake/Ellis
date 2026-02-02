/**
 * DLMM (Dynamic Liquidity Market Maker) Capacity Computation
 * 
 * Computes capacity curves for Meteora DLMM pools.
 * Uses cached TVL and bin step to estimate price impact
 * without requiring full bin array data.
 * 
 * Math model:
 * - DLMM pools have liquidity distributed across discrete bins
 * - Each bin represents a price range of (1 + binStep/10000)
 * - When a bin is exhausted, price jumps to the next bin
 * - For typical pools, ~5-15% of TVL is in the active bin
 */

import type { CapacityCurve, Tier1EstimateResult } from './types.js';
import { STANDARD_CURVE_POINTS, DEFAULT_BREAK_EVEN_SLIPPAGE_BPS } from './types.js';
import { logger } from '../../utils/logger.js';

// ============================================================================
// Constants
// ============================================================================

/** 
 * Base fraction of TVL in the active bin when bin step is unknown.
 * This is conservative - we scale it based on actual bin step.
 */
const BASE_ACTIVE_BIN_TVL_FRACTION = 0.08;

/**
 * Default liquidity decay factor per bin.
 * Adjacent bins typically have 60-85% of active bin liquidity.
 * We use a conservative default that gets adjusted by bin step.
 */
const DEFAULT_LIQUIDITY_DECAY_PER_BIN = 0.70;

/** Minimum TVL to consider (avoid edge cases) */
const MIN_TVL_USD = 100;

/**
 * Bin step to active liquidity fraction mapping.
 * Smaller bin steps = more concentrated liquidity per bin.
 * Larger bin steps = liquidity spread across more bins.
 * 
 * bin_step is in basis points (1 = 0.01%, 100 = 1%)
 */
function getActiveBinFractionForBinStep(binStep: number): number {
  // Smaller bin steps have MORE liquidity in active bin (more concentrated)
  // Typical ranges: 1-5 bps (stables), 10-30 bps (volatile pairs), 50-100 bps (exotic)
  if (binStep <= 1) return 0.20;    // Very tight bins - 20% in active
  if (binStep <= 5) return 0.15;    // Tight bins (stables) - 15%
  if (binStep <= 10) return 0.12;   // Medium-tight - 12%
  if (binStep <= 20) return 0.10;   // Medium - 10%
  if (binStep <= 50) return 0.08;   // Wide - 8%
  if (binStep <= 100) return 0.06;  // Very wide - 6%
  return 0.04;                       // Ultra wide - 4%
}

/**
 * Bin step to liquidity decay mapping.
 * Smaller bin steps have faster decay (liquidity more concentrated).
 */
function getLiquidityDecayForBinStep(binStep: number): number {
  if (binStep <= 1) return 0.55;    // Very tight - fast decay
  if (binStep <= 5) return 0.60;    // Tight - fast decay
  if (binStep <= 10) return 0.65;   // Medium-tight
  if (binStep <= 20) return 0.70;   // Medium
  if (binStep <= 50) return 0.75;   // Wide
  if (binStep <= 100) return 0.80;  // Very wide
  return 0.85;                       // Ultra wide - slow decay
}

// ============================================================================
// Main Curve Computation
// ============================================================================

/**
 * Compute a capacity curve for a DLMM pool.
 * 
 * @param poolId - Pool identifier
 * @param tvlUsd - Total value locked in the pool (USD)
 * @param binStep - Bin step in basis points (price increment per bin)
 * @param feeBps - Pool fee in basis points
 * @param adjustment - Multiplier from user config (0.75, 1.0, or 1.25)
 * @param breakEvenSlippageBps - Target slippage for break-even (defaults to 50, should be actual profitBps)
 */
export function computeDlmmCapacityCurve(
  poolId: string,
  tvlUsd: number,
  binStep: number,
  feeBps: number,
  adjustment: number = 1.0,
  breakEvenSlippageBps: number = DEFAULT_BREAK_EVEN_SLIPPAGE_BPS
): CapacityCurve {
  const now = Date.now();
  
  // Ensure minimum TVL
  const safeTvl = Math.max(tvlUsd, MIN_TVL_USD);
  
  // Get bin-step-specific parameters (instead of hardcoded constants)
  const activeBinFraction = getActiveBinFractionForBinStep(binStep);
  const liquidityDecay = getLiquidityDecayForBinStep(binStep);
  
  // Estimate active bin liquidity using bin-step-aware fraction
  const activeBinLiquidityUsd = safeTvl * activeBinFraction * adjustment;
  
  // Build the curve at standard points
  const curve = new Map<number, number>();
  
  for (const sizeUsd of STANDARD_CURVE_POINTS) {
    const { outputMultiplier } = computeDlmmOutputMultiplier(
      sizeUsd,
      activeBinLiquidityUsd,
      binStep,
      feeBps,
      liquidityDecay
    );
    curve.set(sizeUsd, outputMultiplier);
  }
  
  // Find break-even size using actual profit margin
  const breakEvenSizeUsd = findBreakEvenSize(
    activeBinLiquidityUsd,
    binStep,
    feeBps,
    breakEvenSlippageBps,
    liquidityDecay
  );
  
  const result: CapacityCurve = {
    poolId,
    poolType: 'dlmm',
    computedAt: now,
    confidence: 'medium', // Medium because we're estimating bin distribution
    breakEvenSizeUsd,
    activeLiquidityUsd: activeBinLiquidityUsd,
    curve,
    metadata: {
      binStep,
      feeBps,
      adjustment,
      // Track parameters for transparency
      breakEvenTargetBps: breakEvenSlippageBps,
      activeBinFraction,
      liquidityDecay,
    },
  };
  
  logger.debug('capacity.dlmm.computed', {
    cat: 'sizing',
    poolId: poolId.slice(0, 12) + '...',
    tvlUsd: safeTvl.toFixed(2),
    activeBinLiquidityUsd: activeBinLiquidityUsd.toFixed(2),
    activeBinFraction,
    binStep,
    breakEvenSizeUsd: breakEvenSizeUsd.toFixed(2),
    breakEvenTargetBps: breakEvenSlippageBps,
    liquidityDecay,
    adjustment,
  });
  
  return result;
}

/**
 * Tier 1 instant estimate for DLMM when no curve is available.
 * Uses minimal data to provide a quick estimate.
 * 
 * @param inputUsd - Trade size to estimate
 * @param tvlUsd - Total value locked in pool
 * @param binStep - Bin step in basis points
 * @param feeBps - Fee in basis points
 * @param breakEvenSlippageBps - Target slippage for break-even (default: 50 bps)
 */
export function dlmmTier1Estimate(
  inputUsd: number,
  tvlUsd: number,
  binStep: number,
  feeBps: number,
  breakEvenSlippageBps: number = DEFAULT_BREAK_EVEN_SLIPPAGE_BPS
): Tier1EstimateResult {
  // Estimate active bin liquidity using bin-step-aware fractions
  const safeTvl = Math.max(tvlUsd, MIN_TVL_USD);
  const activeBinFraction = getActiveBinFractionForBinStep(binStep);
  const liquidityDecay = getLiquidityDecayForBinStep(binStep);
  const activeBinLiquidityUsd = safeTvl * activeBinFraction;
  
  // Compute output multiplier and bins crossed
  const { outputMultiplier, binsCrossed } = computeDlmmOutputMultiplier(
    inputUsd,
    activeBinLiquidityUsd,
    binStep,
    feeBps,
    liquidityDecay
  );
  
  // Convert to slippage bps
  const slippageBps = Math.round((1 - outputMultiplier) * 10000);
  
  // Estimate break-even size using actual profit margin
  const breakEvenSizeUsd = findBreakEvenSize(
    activeBinLiquidityUsd,
    binStep,
    feeBps,
    breakEvenSlippageBps,
    liquidityDecay
  );
  
  return {
    outputMultiplier,
    slippageBps,
    confidence: 'low',
    breakEvenSizeUsd,
    details: {
      binsEstimated: binsCrossed,
    },
  };
}

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * Compute output multiplier for a given trade size in DLMM.
 * Models bin stepping with decaying liquidity.
 * 
 * @param inputUsd - Trade size in USD
 * @param activeBinLiquidityUsd - Liquidity in the active bin (USD)
 * @param binStep - Bin step in basis points
 * @param feeBps - Fee in basis points
 * @param liquidityDecay - Decay factor per bin crossing (0-1)
 */
function computeDlmmOutputMultiplier(
  inputUsd: number,
  activeBinLiquidityUsd: number,
  binStep: number,
  feeBps: number,
  liquidityDecay: number = DEFAULT_LIQUIDITY_DECAY_PER_BIN
): { outputMultiplier: number; binsCrossed: number } {
  if (inputUsd <= 0 || activeBinLiquidityUsd <= 0) {
    return { outputMultiplier: 1.0, binsCrossed: 0 };
  }
  
  // Fee impact
  const feeMultiplier = 1 - feeBps / 10000;
  
  // Bin step as decimal (e.g., 10 bps = 0.001)
  const binStepDecimal = binStep / 10000;
  
  // For very small trades (within active bin), simple calculation
  if (inputUsd <= activeBinLiquidityUsd * 0.5) {
    // Within-bin slippage is minimal for DLMM (constant sum within bin)
    // Main cost is fee + small price impact
    const withinBinImpact = (inputUsd / activeBinLiquidityUsd) * binStepDecimal;
    const outputMultiplier = feeMultiplier * (1 - withinBinImpact);
    return { outputMultiplier, binsCrossed: 0 };
  }
  
  // For larger trades, simulate bin crossings
  let remainingInput = inputUsd;
  let totalOutput = 0;
  let currentBinLiquidity = activeBinLiquidityUsd;
  let binsCrossed = 0;
  let cumulativePriceImpact = 0;
  
  // Cap iterations based on expected range
  const maxBins = Math.min(50, Math.ceil(inputUsd / (activeBinLiquidityUsd * 0.1)));
  
  while (remainingInput > 0 && currentBinLiquidity > 1 && binsCrossed < maxBins) {
    // Amount we can swap in this bin
    const amountInBin = Math.min(remainingInput, currentBinLiquidity);
    
    // DLMM bins have constant price within bin
    // Output = input * (1 - cumulativePriceImpact) * feeMultiplier
    const binOutput = amountInBin * (1 - cumulativePriceImpact) * feeMultiplier;
    
    totalOutput += binOutput;
    remainingInput -= amountInBin;
    
    // If we exhausted this bin, move to next
    if (amountInBin >= currentBinLiquidity * 0.95) {
      binsCrossed++;
      cumulativePriceImpact += binStepDecimal;
      currentBinLiquidity *= liquidityDecay;
    }
  }
  
  // Handle overflow with severe slippage (scaled by overflow amount)
  if (remainingInput > 0) {
    const overflowRatio = remainingInput / inputUsd;
    const overflowPenalty = 0.3 + 0.2 * (1 - overflowRatio); // 30-50% for overflow
    totalOutput += remainingInput * overflowPenalty * feeMultiplier;
    binsCrossed += Math.ceil(remainingInput / activeBinLiquidityUsd);
  }
  
  // Don't clamp too aggressively - let callers see extreme slippage
  const outputMultiplier = Math.max(0.3, Math.min(1.0, totalOutput / inputUsd));
  return { outputMultiplier, binsCrossed };
}

/**
 * Binary search to find trade size where slippage equals target.
 */
function findBreakEvenSize(
  activeBinLiquidityUsd: number,
  binStep: number,
  feeBps: number,
  targetSlippageBps: number,
  liquidityDecay: number = DEFAULT_LIQUIDITY_DECAY_PER_BIN
): number {
  const targetMultiplier = 1 - targetSlippageBps / 10000;
  
  let low = 0.1;
  let high = activeBinLiquidityUsd * 5; // Can cross several bins
  
  // Binary search with early termination
  for (let i = 0; i < 20; i++) {
    const mid = (low + high) / 2;
    const { outputMultiplier } = computeDlmmOutputMultiplier(
      mid,
      activeBinLiquidityUsd,
      binStep,
      feeBps,
      liquidityDecay
    );
    
    if (outputMultiplier > targetMultiplier) {
      low = mid;
    } else {
      high = mid;
    }
    
    // Early termination if converged
    if (Math.abs(high - low) < 0.01) break;
  }
  
  return (low + high) / 2;
}

/**
 * Convert bin ID to price
 * For DLMM: price = (1 + binStep/10000)^binId
 */
export function binIdToPrice(binId: number, binStep: number): number {
  const binStepMultiplier = 1 + binStep / 10000;
  return Math.pow(binStepMultiplier, binId);
}

/**
 * Convert price to bin ID
 */
export function priceToBinId(price: number, binStep: number): number {
  const binStepMultiplier = 1 + binStep / 10000;
  return Math.floor(Math.log(price) / Math.log(binStepMultiplier));
}

/**
 * Estimate how many bins a trade will cross
 */
export function estimateBinsCrossed(
  inputUsd: number,
  activeBinLiquidityUsd: number
): number {
  if (activeBinLiquidityUsd <= 0) return 0;
  
  // Simple estimate: each bin holds ~activeBinLiquidity (with decay)
  // Total capacity over N bins ≈ activeBinLiquidity * (1 - decay^N) / (1 - decay)
  // Inverting: N ≈ log(1 - input * (1-decay) / activeBinLiquidity) / log(decay)
  
  const decay = DEFAULT_LIQUIDITY_DECAY_PER_BIN;
  const ratio = inputUsd * (1 - decay) / activeBinLiquidityUsd;
  
  if (ratio >= 1) {
    // Would exhaust all liquidity
    return 50;
  }
  
  return Math.ceil(Math.log(1 - ratio) / Math.log(decay));
}
