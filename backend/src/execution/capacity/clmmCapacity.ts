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
import { STANDARD_CURVE_POINTS } from './types.js';
import { logger } from '../../utils/logger.js';

// ============================================================================
// Constants
// ============================================================================

/** Q64.64 fixed-point multiplier for sqrtPriceX64 */
const Q64 = BigInt(1) << BigInt(64);

/** Minimum liquidity to consider (avoid division by zero) */
const MIN_LIQUIDITY = BigInt(1000);

/** 
 * Conservative estimate of liquidity decay per tick crossing.
 * Real pools vary, but this provides a safe approximation.
 * 0.85 means each subsequent tick has ~85% of previous tick's liquidity.
 */
const LIQUIDITY_DECAY_PER_TICK = 0.85;

/** Break-even slippage target (50 bps) for estimating break-even size */
const BREAK_EVEN_SLIPPAGE_BPS = 50;

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
 */
export function computeClmmCapacityCurve(
  poolId: string,
  liquidity: bigint,
  sqrtPriceX64: bigint,
  tickSpacing: number,
  feeBps: number,
  adjustment: number = 1.0
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
  
  // Build the curve at standard points
  const curve = new Map<number, number>();
  
  for (const sizeUsd of STANDARD_CURVE_POINTS) {
    const outputMultiplier = computeClmmOutputMultiplier(
      sizeUsd,
      activeLiquidityUsd,
      singleTickCapacityUsd,
      feeBps,
      tickSpacing
    );
    curve.set(sizeUsd, outputMultiplier);
  }
  
  // Find break-even size (where slippage = BREAK_EVEN_SLIPPAGE_BPS)
  const breakEvenSizeUsd = findBreakEvenSize(
    activeLiquidityUsd,
    singleTickCapacityUsd,
    feeBps,
    tickSpacing,
    BREAK_EVEN_SLIPPAGE_BPS
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
    adjustment,
  });
  
  return result;
}

/**
 * Tier 1 instant estimate for CLMM when no curve is available.
 * Uses minimal data to provide a quick (but less accurate) estimate.
 */
export function clmmTier1Estimate(
  inputUsd: number,
  liquidityRaw: bigint,
  sqrtPriceX64: bigint,
  tickSpacing: number,
  feeBps: number
): Tier1EstimateResult {
  // Convert to usable values
  const L = liquidityRaw > MIN_LIQUIDITY ? liquidityRaw : MIN_LIQUIDITY;
  const sqrtPriceDecimal = Number(sqrtPriceX64) / Number(Q64);
  
  // Estimate active liquidity
  const virtualReserveA = Number(L) / sqrtPriceDecimal;
  const virtualReserveB = Number(L) * sqrtPriceDecimal;
  const activeLiquidityUsd = Math.sqrt(virtualReserveA * virtualReserveB);
  
  const singleTickCapacityUsd = activeLiquidityUsd * (tickSpacing / 10000);
  
  // Compute output multiplier
  const outputMultiplier = computeClmmOutputMultiplier(
    inputUsd,
    activeLiquidityUsd,
    singleTickCapacityUsd,
    feeBps,
    tickSpacing
  );
  
  // Convert to slippage bps
  const slippageBps = Math.round((1 - outputMultiplier) * 10000);
  
  // Estimate ticks crossed
  const ticksCrossed = Math.ceil(inputUsd / singleTickCapacityUsd);
  
  // Estimate break-even size
  const breakEvenSizeUsd = findBreakEvenSize(
    activeLiquidityUsd,
    singleTickCapacityUsd,
    feeBps,
    tickSpacing,
    BREAK_EVEN_SLIPPAGE_BPS
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
 */
function computeClmmOutputMultiplier(
  inputUsd: number,
  activeLiquidityUsd: number,
  singleTickCapacityUsd: number,
  feeBps: number,
  tickSpacing: number
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
  
  while (remainingInput > 0 && currentLiquidity > 1 && ticksCrossed < 100) {
    // Amount we can swap in this tick
    const amountInTick = Math.min(remainingInput, currentTickCapacity);
    
    // Output from this tick (with within-tick slippage)
    const tickSlippage = amountInTick / currentLiquidity;
    const tickOutput = amountInTick * (1 - tickSlippage) * feeMultiplier;
    
    totalOutput += tickOutput;
    remainingInput -= amountInTick;
    
    // Move to next tick with decayed liquidity
    ticksCrossed++;
    currentLiquidity *= LIQUIDITY_DECAY_PER_TICK;
    currentTickCapacity = currentLiquidity * (tickSpacing / 10000);
  }
  
  // If we still have remaining input, it means we've exhausted available liquidity
  // Add it with severe slippage
  if (remainingInput > 0) {
    totalOutput += remainingInput * 0.5 * feeMultiplier; // 50% slippage for overflow
  }
  
  // Output multiplier = total output / input
  return Math.max(0.5, Math.min(1.0, totalOutput / inputUsd));
}

/**
 * Binary search to find the trade size where slippage equals target.
 */
function findBreakEvenSize(
  activeLiquidityUsd: number,
  singleTickCapacityUsd: number,
  feeBps: number,
  tickSpacing: number,
  targetSlippageBps: number
): number {
  const targetMultiplier = 1 - targetSlippageBps / 10000;
  
  let low = 0.1;
  let high = activeLiquidityUsd * 0.5; // Cap at 50% of active liquidity
  
  // Binary search
  for (let i = 0; i < 20; i++) {
    const mid = (low + high) / 2;
    const mult = computeClmmOutputMultiplier(
      mid,
      activeLiquidityUsd,
      singleTickCapacityUsd,
      feeBps,
      tickSpacing
    );
    
    if (mult > targetMultiplier) {
      low = mid;
    } else {
      high = mid;
    }
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
