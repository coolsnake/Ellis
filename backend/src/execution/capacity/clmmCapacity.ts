/**
 * CLMM (Concentrated Liquidity Market Maker) Capacity Computation
 * 
 * Computes capacity curves for Orca Whirlpool and Raydium CLMM pools.
 * Uses cached liquidity (L) and sqrtPriceX64 values to estimate
 * price impact without requiring full tick array data.
 * 
 * Math model:
 * - CLMM pools have liquidity concentrated around the current tick
 * - Each tick crossing causes a discrete price jump of tickSpacing bps
 * - For small trades within one tick: slippage ≈ (trade / virtualReserve)²
 * - For larger trades: slippage accumulates as ticks are crossed
 */

import type { CapacityCurve, Tier1EstimateResult } from './types.js';
import { STANDARD_CURVE_POINTS, DEFAULT_BREAK_EVEN_SLIPPAGE_BPS } from './types.js';
import { logger } from '../../utils/logger.js';

// ============================================================================
// Constants
// ============================================================================

/** Q64.64 fixed-point multiplier for sqrtPriceX64 */
const Q64 = BigInt(1) << BigInt(64);

/** Minimum liquidity to consider (avoid division by zero) */
const MIN_LIQUIDITY = BigInt(1000);

/** 
 * Default liquidity decay per tick crossing when no tick array data is available.
 * This is conservative - real pools vary widely.
 * 0.70 means each subsequent tick has ~70% of previous tick's liquidity.
 * (Reduced from 0.85 to be more conservative given uncertainty)
 */
const DEFAULT_LIQUIDITY_DECAY_PER_TICK = 0.70;

/**
 * Liquidity decay factors based on tick spacing.
 * Pools with larger tick spacing tend to have more concentrated liquidity.
 * These values are empirically tuned.
 */
const LIQUIDITY_DECAY_BY_TICK_SPACING: Record<number, number> = {
  1: 0.60,    // Very tight spacing (Orca 1-tick) - liquidity falls off fast
  8: 0.65,    // Tight spacing (common for stablecoins)
  10: 0.65,   // Raydium common
  60: 0.70,   // Medium spacing (Orca default for volatile pairs)
  64: 0.70,   // Raydium common
  100: 0.75,  // Wide spacing
  200: 0.80,  // Very wide spacing
};

// ============================================================================
// Main Curve Computation
// ============================================================================

/**
 * Compute a capacity curve for a CLMM pool.
 * 
 * @param poolId - Pool identifier
 * @param liquidity - Current liquidity (L) from pool state
 * @param sqrtPriceX64 - Current sqrt price in Q64.64 format
 * @param tickSpacing - Tick spacing for the pool
 * @param feeBps - Pool fee in basis points
 * @param adjustment - Multiplier from user config (0.75, 1.0, or 1.25)
 * @param breakEvenSlippageBps - Target slippage in bps (defaults to 50, should be actual profitBps)
 */
export function computeClmmCapacityCurve(
  poolId: string,
  liquidity: bigint,
  sqrtPriceX64: bigint,
  tickSpacing: number,
  feeBps: number,
  adjustment: number = 1.0,
  breakEvenSlippageBps: number = DEFAULT_BREAK_EVEN_SLIPPAGE_BPS
): CapacityCurve {
  const now = Date.now();
  
  // Ensure minimum liquidity
  const L = liquidity > MIN_LIQUIDITY ? liquidity : MIN_LIQUIDITY;
  
  // Convert sqrtPriceX64 to decimal price
  // price = (sqrtPriceX64 / 2^64)²
  const sqrtPriceDecimal = Number(sqrtPriceX64) / Number(Q64);
  const price = sqrtPriceDecimal * sqrtPriceDecimal;
  
  // Calculate virtual reserves from L and sqrtPrice
  // For xy=k with concentrated liquidity:
  // x = L / sqrtP (token A)
  // y = L * sqrtP (token B)
  // We use USD equivalent, assuming price is in USD terms
  const virtualReserveA = Number(L) / sqrtPriceDecimal;
  const virtualReserveB = Number(L) * sqrtPriceDecimal;
  
  // Use geometric mean as representative liquidity in USD
  // This provides a direction-agnostic capacity estimate
  const activeLiquidityUsd = Math.sqrt(virtualReserveA * virtualReserveB) * adjustment;
  
  // Single tick capacity (trade size that causes 1 tick worth of price movement)
  // For tickSpacing of 1, each tick is ~1 bps price change
  // singleTickCapacity ≈ activeLiquidity * (tickSpacing / 10000)
  const singleTickCapacityUsd = activeLiquidityUsd * (tickSpacing / 10000);
  
  // Get tick-spacing-specific liquidity decay factor
  const liquidityDecay = getLiquidityDecayForTickSpacing(tickSpacing);
  
  // Build the curve at standard points
  const curve = new Map<number, number>();
  
  for (const sizeUsd of STANDARD_CURVE_POINTS) {
    const outputMultiplier = computeClmmOutputMultiplier(
      sizeUsd,
      activeLiquidityUsd,
      singleTickCapacityUsd,
      feeBps,
      tickSpacing,
      liquidityDecay
    );
    curve.set(sizeUsd, outputMultiplier);
  }
  
  // Find break-even size using actual profit margin (not hardcoded 50 bps)
  const breakEvenSizeUsd = findBreakEvenSize(
    activeLiquidityUsd,
    singleTickCapacityUsd,
    feeBps,
    tickSpacing,
    breakEvenSlippageBps,
    liquidityDecay
  );
  
  const result: CapacityCurve = {
    poolId,
    poolType: 'clmm',
    computedAt: now,
    confidence: 'medium', // Medium because we're using estimated decay
    breakEvenSizeUsd,
    activeLiquidityUsd,
    curve,
    metadata: {
      tickSpacing,
      feeBps,
      adjustment,
      // Track the break-even target used for transparency
      breakEvenTargetBps: breakEvenSlippageBps,
      liquidityDecay,
    },
  };
  
  logger.debug('capacity.clmm.computed', {
    cat: 'sizing',
    poolId: poolId.slice(0, 12) + '...',
    liquidity: L.toString().slice(0, 15) + '...',
    sqrtPrice: sqrtPriceDecimal.toFixed(6),
    activeLiquidityUsd: activeLiquidityUsd.toFixed(2),
    singleTickCapacityUsd: singleTickCapacityUsd.toFixed(2),
    breakEvenSizeUsd: breakEvenSizeUsd.toFixed(2),
    breakEvenTargetBps: breakEvenSlippageBps,
    liquidityDecay,
    adjustment,
  });
  
  return result;
}

/**
 * Get liquidity decay factor based on tick spacing.
 * Pools with different tick spacing have different liquidity distributions.
 */
function getLiquidityDecayForTickSpacing(tickSpacing: number): number {
  // Check for exact match first
  if (LIQUIDITY_DECAY_BY_TICK_SPACING[tickSpacing] !== undefined) {
    return LIQUIDITY_DECAY_BY_TICK_SPACING[tickSpacing];
  }
  
  // Interpolate/extrapolate based on tick spacing
  // Smaller tick spacing = more concentrated = faster decay
  // Larger tick spacing = more spread out = slower decay
  if (tickSpacing <= 1) return 0.55;
  if (tickSpacing <= 10) return 0.60 + (tickSpacing - 1) * 0.005;
  if (tickSpacing <= 64) return 0.65 + (tickSpacing - 10) * 0.001;
  if (tickSpacing <= 200) return 0.70 + (tickSpacing - 64) * 0.0007;
  return 0.80; // Very wide spacing
}

/**
 * Tier 1 instant estimate for CLMM when no curve is available.
 * Uses minimal data to provide a quick (but less accurate) estimate.
 * 
 * @param inputUsd - Trade size to estimate
 * @param liquidityRaw - Raw liquidity from pool state
 * @param sqrtPriceX64 - Sqrt price in Q64.64 format
 * @param tickSpacing - Tick spacing
 * @param feeBps - Fee in basis points
 * @param breakEvenSlippageBps - Target slippage for break-even (default: 50 bps)
 */
export function clmmTier1Estimate(
  inputUsd: number,
  liquidityRaw: bigint,
  sqrtPriceX64: bigint,
  tickSpacing: number,
  feeBps: number,
  breakEvenSlippageBps: number = DEFAULT_BREAK_EVEN_SLIPPAGE_BPS
): Tier1EstimateResult {
  // Convert to usable values
  const L = liquidityRaw > MIN_LIQUIDITY ? liquidityRaw : MIN_LIQUIDITY;
  const sqrtPriceDecimal = Number(sqrtPriceX64) / Number(Q64);
  
  // Estimate active liquidity
  const virtualReserveA = Number(L) / sqrtPriceDecimal;
  const virtualReserveB = Number(L) * sqrtPriceDecimal;
  const activeLiquidityUsd = Math.sqrt(virtualReserveA * virtualReserveB);
  
  const singleTickCapacityUsd = activeLiquidityUsd * (tickSpacing / 10000);
  
  // Get tick-spacing-specific liquidity decay
  const liquidityDecay = getLiquidityDecayForTickSpacing(tickSpacing);
  
  // Compute output multiplier
  const outputMultiplier = computeClmmOutputMultiplier(
    inputUsd,
    activeLiquidityUsd,
    singleTickCapacityUsd,
    feeBps,
    tickSpacing,
    liquidityDecay
  );
  
  // Convert to slippage bps
  const slippageBps = Math.round((1 - outputMultiplier) * 10000);
  
  // Estimate ticks crossed
  const ticksCrossed = Math.ceil(inputUsd / singleTickCapacityUsd);
  
  // Estimate break-even size using actual profit margin
  const breakEvenSizeUsd = findBreakEvenSize(
    activeLiquidityUsd,
    singleTickCapacityUsd,
    feeBps,
    tickSpacing,
    breakEvenSlippageBps,
    liquidityDecay
  );
  
  return {
    outputMultiplier,
    slippageBps,
    confidence: 'low',
    breakEvenSizeUsd,
    details: {
      ticksEstimated: ticksCrossed,
    },
  };
}

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * Compute output multiplier for a given trade size.
 * Models tick crossing with decaying liquidity.
 * 
 * @param inputUsd - Trade size in USD
 * @param activeLiquidityUsd - Liquidity in the active tick (USD)
 * @param singleTickCapacityUsd - Trade size that fills one tick
 * @param feeBps - Fee in basis points
 * @param tickSpacing - Tick spacing
 * @param liquidityDecay - Decay factor per tick crossing (0-1)
 */
function computeClmmOutputMultiplier(
  inputUsd: number,
  activeLiquidityUsd: number,
  singleTickCapacityUsd: number,
  feeBps: number,
  tickSpacing: number,
  liquidityDecay: number = DEFAULT_LIQUIDITY_DECAY_PER_TICK
): number {
  if (inputUsd <= 0 || activeLiquidityUsd <= 0) return 1.0;
  
  // Fee impact
  const feeMultiplier = 1 - feeBps / 10000;
  
  // For very small trades (within single tick), use AMM-like formula
  if (inputUsd <= singleTickCapacityUsd * 0.5) {
    // Within-tick slippage: approximately (trade / liquidity)
    const withinTickSlippage = inputUsd / activeLiquidityUsd;
    return feeMultiplier * (1 - withinTickSlippage);
  }
  
  // For larger trades, simulate tick crossing
  let remainingInput = inputUsd;
  let totalOutput = 0;
  let currentLiquidity = activeLiquidityUsd;
  let currentTickCapacity = singleTickCapacityUsd;
  let ticksCrossed = 0;
  
  // Cap iterations to prevent infinite loops
  const maxTicks = Math.min(100, Math.ceil(inputUsd / (singleTickCapacityUsd * 0.1)));
  
  while (remainingInput > 0 && currentLiquidity > 1 && ticksCrossed < maxTicks) {
    // Amount we can swap in this tick
    const amountInTick = Math.min(remainingInput, currentTickCapacity);
    
    // Output from this tick (with within-tick slippage)
    const tickSlippage = amountInTick / currentLiquidity;
    const tickOutput = amountInTick * (1 - tickSlippage) * feeMultiplier;
    
    totalOutput += tickOutput;
    remainingInput -= amountInTick;
    
    // Move to next tick with decayed liquidity
    ticksCrossed++;
    currentLiquidity *= liquidityDecay;
    currentTickCapacity = currentLiquidity * (tickSpacing / 10000);
  }
  
  // If we still have remaining input, it means we've exhausted available liquidity
  // Add it with severe slippage (scaled by how much overflow)
  if (remainingInput > 0) {
    const overflowRatio = remainingInput / inputUsd;
    const overflowPenalty = 0.3 + 0.2 * (1 - overflowRatio); // 30-50% for overflow
    totalOutput += remainingInput * overflowPenalty * feeMultiplier;
  }
  
  // Output multiplier = total output / input
  // Don't clamp too aggressively - let callers see extreme slippage
  return Math.max(0.3, Math.min(1.0, totalOutput / inputUsd));
}

/**
 * Binary search to find the trade size where slippage equals target.
 */
function findBreakEvenSize(
  activeLiquidityUsd: number,
  singleTickCapacityUsd: number,
  feeBps: number,
  tickSpacing: number,
  targetSlippageBps: number,
  liquidityDecay: number = DEFAULT_LIQUIDITY_DECAY_PER_TICK
): number {
  const targetMultiplier = 1 - targetSlippageBps / 10000;
  
  let low = 0.1;
  let high = activeLiquidityUsd * 0.5; // Cap at 50% of active liquidity
  
  // Binary search with early termination
  for (let i = 0; i < 20; i++) {
    const mid = (low + high) / 2;
    const mult = computeClmmOutputMultiplier(
      mid,
      activeLiquidityUsd,
      singleTickCapacityUsd,
      feeBps,
      tickSpacing,
      liquidityDecay
    );
    
    if (mult > targetMultiplier) {
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
 * Convert tick index to price
 * price = 1.0001^tick
 */
export function tickToPrice(tick: number): number {
  return Math.pow(1.0001, tick);
}

/**
 * Convert price to tick index
 * tick = log(price) / log(1.0001)
 */
export function priceToTick(price: number): number {
  return Math.floor(Math.log(price) / Math.log(1.0001));
}
