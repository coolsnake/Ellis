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
import { STANDARD_CURVE_POINTS } from './types.js';
import { logger } from '../../utils/logger.js';

// ============================================================================
// Constants
// ============================================================================

/** 
 * Estimated fraction of TVL in the active bin.
 * Real pools vary (2-20%), but 10% is a conservative median.
 */
const ACTIVE_BIN_TVL_FRACTION = 0.10;

/**
 * Liquidity decay factor per bin.
 * Adjacent bins typically have 70-90% of active bin liquidity.
 */
const LIQUIDITY_DECAY_PER_BIN = 0.80;

/** Break-even slippage target (50 bps) */
const BREAK_EVEN_SLIPPAGE_BPS = 50;

/** Minimum TVL to consider (avoid edge cases) */
const MIN_TVL_USD = 100;

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
 */
export function computeDlmmCapacityCurve(
  poolId: string,
  tvlUsd: number,
  binStep: number,
  feeBps: number,
  adjustment: number = 1.0
): CapacityCurve {
  const now = Date.now();
  
  // Ensure minimum TVL
  const safeTvl = Math.max(tvlUsd, MIN_TVL_USD);
  
  // Estimate active bin liquidity
  const activeBinLiquidityUsd = safeTvl * ACTIVE_BIN_TVL_FRACTION * adjustment;
  
  // Build the curve at standard points
  const curve = new Map<number, number>();
  
  for (const sizeUsd of STANDARD_CURVE_POINTS) {
    const { outputMultiplier } = computeDlmmOutputMultiplier(
      sizeUsd,
      activeBinLiquidityUsd,
      binStep,
      feeBps
    );
    curve.set(sizeUsd, outputMultiplier);
  }
  
  // Find break-even size
  const breakEvenSizeUsd = findBreakEvenSize(
    activeBinLiquidityUsd,
    binStep,
    feeBps,
    BREAK_EVEN_SLIPPAGE_BPS
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
    },
  };
  
  logger.debug('capacity.dlmm.computed', {
    cat: 'sizing',
    poolId: poolId.slice(0, 12) + '...',
    tvlUsd: safeTvl.toFixed(2),
    activeBinLiquidityUsd: activeBinLiquidityUsd.toFixed(2),
    binStep,
    breakEvenSizeUsd: breakEvenSizeUsd.toFixed(2),
    adjustment,
  });
  
  return result;
}

/**
 * Tier 1 instant estimate for DLMM when no curve is available.
 * Uses minimal data to provide a quick estimate.
 */
export function dlmmTier1Estimate(
  inputUsd: number,
  tvlUsd: number,
  binStep: number,
  feeBps: number
): Tier1EstimateResult {
  // Estimate active bin liquidity
  const safeTvl = Math.max(tvlUsd, MIN_TVL_USD);
  const activeBinLiquidityUsd = safeTvl * ACTIVE_BIN_TVL_FRACTION;
  
  // Compute output multiplier and bins crossed
  const { outputMultiplier, binsCrossed } = computeDlmmOutputMultiplier(
    inputUsd,
    activeBinLiquidityUsd,
    binStep,
    feeBps
  );
  
  // Convert to slippage bps
  const slippageBps = Math.round((1 - outputMultiplier) * 10000);
  
  // Estimate break-even size
  const breakEvenSizeUsd = findBreakEvenSize(
    activeBinLiquidityUsd,
    binStep,
    feeBps,
    BREAK_EVEN_SLIPPAGE_BPS
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
 */
function computeDlmmOutputMultiplier(
  inputUsd: number,
  activeBinLiquidityUsd: number,
  binStep: number,
  feeBps: number
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
  
  while (remainingInput > 0 && currentBinLiquidity > 1 && binsCrossed < 50) {
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
      currentBinLiquidity *= LIQUIDITY_DECAY_PER_BIN;
    }
  }
  
  // Handle overflow with severe slippage
  if (remainingInput > 0) {
    totalOutput += remainingInput * 0.5 * feeMultiplier;
    binsCrossed += Math.ceil(remainingInput / 10); // Rough estimate
  }
  
  const outputMultiplier = Math.max(0.5, Math.min(1.0, totalOutput / inputUsd));
  return { outputMultiplier, binsCrossed };
}

/**
 * Binary search to find trade size where slippage equals target.
 */
function findBreakEvenSize(
  activeBinLiquidityUsd: number,
  binStep: number,
  feeBps: number,
  targetSlippageBps: number
): number {
  const targetMultiplier = 1 - targetSlippageBps / 10000;
  
  let low = 0.1;
  let high = activeBinLiquidityUsd * 5; // Can cross several bins
  
  // Binary search
  for (let i = 0; i < 20; i++) {
    const mid = (low + high) / 2;
    const { outputMultiplier } = computeDlmmOutputMultiplier(
      mid,
      activeBinLiquidityUsd,
      binStep,
      feeBps
    );
    
    if (outputMultiplier > targetMultiplier) {
      low = mid;
    } else {
      high = mid;
    }
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
  
  const decay = LIQUIDITY_DECAY_PER_BIN;
  const ratio = inputUsd * (1 - decay) / activeBinLiquidityUsd;
  
  if (ratio >= 1) {
    // Would exhaust all liquidity
    return 50;
  }
  
  return Math.ceil(Math.log(1 - ratio) / Math.log(decay));
}
