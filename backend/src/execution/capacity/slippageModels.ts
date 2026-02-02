/**
 * Slippage Models for Multi-Hop Sizing
 * 
 * Per-pool-type slippage computation functions that model how output
 * decreases relative to input due to price impact and fees.
 * 
 * These models are used to simulate trades through multiple hops
 * to find the optimal trade size that maximizes profit.
 */

import type { SlippageModelParams, PoolType } from './types.js';

// ============================================================================
// Hop Parameters
// ============================================================================

/**
 * Parameters for a single hop in a multi-hop trade.
 * Contains all data needed to compute output for that hop.
 */
export interface HopParams {
  /** Pool identifier */
  poolId: string;
  
  /** Pool type determines which math model to use */
  poolType: PoolType;
  
  /** Fee in basis points */
  feeBps: number;
  
  // AMM-specific parameters
  /** Reserve of input token (USD equivalent) */
  reserveIn?: number;
  /** Reserve of output token (USD equivalent) */
  reserveOut?: number;
  
  // CLMM-specific parameters
  /** Active liquidity in current tick range */
  activeLiquidity?: bigint;
  /** Current sqrt price in Q64.64 format */
  sqrtPriceX64?: bigint;
  /** Tick spacing */
  tickSpacing?: number;
  
  // DLMM-specific parameters
  /** Active bin liquidity (USD equivalent) */
  activeBinLiquidity?: number;
  /** Bin step in basis points */
  binStep?: number;
  /** Total TVL of pool (USD) */
  tvlUsd?: number;
}

// ============================================================================
// Main Router Function
// ============================================================================

/**
 * Compute output amount for a single hop.
 * Routes to the appropriate pool-type-specific function.
 * 
 * @param inputUsd - Input amount in USD
 * @param hop - Hop parameters
 * @param params - Slippage model parameters
 * @returns Output amount in USD
 */
export function computeHopOutput(
  inputUsd: number,
  hop: HopParams,
  params: SlippageModelParams
): number {
  if (inputUsd <= 0) return 0;
  
  switch (hop.poolType) {
    case 'amm':
      return computeAmmOutput(inputUsd, hop, params.amm);
    case 'clmm':
      return computeClmmOutput(inputUsd, hop, params.clmm);
    case 'dlmm':
      return computeDlmmOutput(inputUsd, hop, params.dlmm);
    default:
      // Fallback: assume only fee impact, no slippage
      return inputUsd * (1 - hop.feeBps / 10000);
  }
}

// ============================================================================
// AMM (Constant Product) Model
// ============================================================================

/**
 * Compute output for an AMM (constant product xy=k) pool.
 * 
 * Formula: output = reserveOut * input / (reserveIn + input) * (1 - fee)
 * 
 * For constant product AMM:
 * - After trade: (reserveIn + input)(reserveOut - output) = k = reserveIn * reserveOut
 * - Solving: output = reserveOut * input / (reserveIn + input)
 * - With fee applied to input: effectiveInput = input * (1 - fee)
 * 
 * @param inputUsd - Input amount in USD
 * @param hop - Hop parameters (must have reserveIn and reserveOut)
 * @param params - AMM slippage parameters
 * @returns Output amount in USD
 */
export function computeAmmOutput(
  inputUsd: number,
  hop: HopParams,
  params: { reserveMultiplier: number }
): number {
  // Apply reserve multiplier to account for potentially unavailable depth
  const reserveIn = (hop.reserveIn ?? 10000) * params.reserveMultiplier;
  const reserveOut = (hop.reserveOut ?? 10000) * params.reserveMultiplier;
  
  if (reserveIn <= 0 || reserveOut <= 0) {
    // No liquidity - severe slippage
    return inputUsd * 0.5 * (1 - hop.feeBps / 10000);
  }
  
  // Fee is applied to input
  const feeMultiplier = 1 - hop.feeBps / 10000;
  const effectiveInput = inputUsd * feeMultiplier;
  
  // Constant product formula: output = reserveOut * effectiveInput / (reserveIn + effectiveInput)
  const output = (reserveOut * effectiveInput) / (reserveIn + effectiveInput);
  
  return output;
}

/**
 * Compute the output multiplier (efficiency) for an AMM trade.
 * multiplier = output / input, where 1.0 = no slippage
 */
export function computeAmmOutputMultiplier(
  inputUsd: number,
  reserveIn: number,
  reserveOut: number,
  feeBps: number
): number {
  if (inputUsd <= 0 || reserveIn <= 0 || reserveOut <= 0) return 1.0;
  
  const feeMultiplier = 1 - feeBps / 10000;
  const effectiveInput = inputUsd * feeMultiplier;
  
  // For balanced reserves (reserveIn ≈ reserveOut), ideal output = input
  // Output multiplier = actual_output / input
  // actual_output = reserveOut * effectiveInput / (reserveIn + effectiveInput)
  // For balanced: = reserveIn * effectiveInput / (reserveIn + effectiveInput)
  //              = effectiveInput / (1 + effectiveInput/reserveIn)
  // multiplier = (reserveIn / (reserveIn + effectiveInput)) * feeMultiplier
  
  const ammMultiplier = reserveIn / (reserveIn + effectiveInput);
  return ammMultiplier * feeMultiplier;
}

// ============================================================================
// CLMM (Concentrated Liquidity) Model
// ============================================================================

/** Q64.64 fixed-point multiplier for sqrtPriceX64 */
const Q64 = BigInt(1) << BigInt(64);

/** Minimum liquidity to consider (avoid division by zero) */
const MIN_LIQUIDITY = BigInt(1000);

/**
 * Compute output for a CLMM (concentrated liquidity) pool.
 * 
 * CLMM pools have liquidity concentrated around the current tick.
 * As trades move the price, they cross tick boundaries where
 * liquidity may change (usually decreasing away from current price).
 * 
 * This model simulates tick crossing with decaying liquidity.
 * 
 * @param inputUsd - Input amount in USD
 * @param hop - Hop parameters (should have activeLiquidity, sqrtPriceX64, tickSpacing)
 * @param params - CLMM slippage parameters
 * @returns Output amount in USD
 */
export function computeClmmOutput(
  inputUsd: number,
  hop: HopParams,
  params: { liquidityDecayPerTick: number; maxTickSimulation: number }
): number {
  // Get liquidity in USD terms
  let activeLiquidityUsd: number;
  
  if (hop.activeLiquidity && hop.activeLiquidity > MIN_LIQUIDITY) {
    // Convert liquidity to USD-equivalent virtual reserve
    // For CLMM: L represents geometric mean of reserves
    // Rough conversion: L / 1e6 gives approximate USD value
    // This is a simplification - actual conversion depends on sqrtPrice
    if (hop.sqrtPriceX64) {
      const sqrtPriceDecimal = Number(hop.sqrtPriceX64) / Number(Q64);
      const virtualReserveA = Number(hop.activeLiquidity) / sqrtPriceDecimal;
      const virtualReserveB = Number(hop.activeLiquidity) * sqrtPriceDecimal;
      activeLiquidityUsd = Math.sqrt(virtualReserveA * virtualReserveB) / 1e6;
    } else {
      activeLiquidityUsd = Number(hop.activeLiquidity) / 1e6;
    }
  } else {
    // No liquidity data - use reasonable fallback
    activeLiquidityUsd = 10000;
  }
  
  const tickSpacing = hop.tickSpacing ?? 1;
  const feeMultiplier = 1 - hop.feeBps / 10000;
  const decayFactor = params.liquidityDecayPerTick;
  
  // Single tick capacity (trade size that causes ~1 tick of price movement)
  // Each tick is ~1 bps (0.01%) price change, scaled by tickSpacing
  const singleTickCapacityUsd = activeLiquidityUsd * (tickSpacing / 10000);
  
  // For very small trades (within half a tick), use AMM-like formula
  if (inputUsd <= singleTickCapacityUsd * 0.5) {
    const withinTickSlippage = inputUsd / activeLiquidityUsd;
    return inputUsd * feeMultiplier * (1 - withinTickSlippage);
  }
  
  // For larger trades, simulate tick crossing with decaying liquidity
  let remainingInput = inputUsd;
  let totalOutput = 0;
  let currentLiquidity = activeLiquidityUsd;
  let currentTickCapacity = singleTickCapacityUsd;
  let ticksCrossed = 0;
  
  const maxTicks = Math.min(params.maxTickSimulation, Math.ceil(inputUsd / (singleTickCapacityUsd * 0.1)));
  
  while (remainingInput > 0 && currentLiquidity > 1 && ticksCrossed < maxTicks) {
    // Amount we can swap in this tick
    const amountInTick = Math.min(remainingInput, currentTickCapacity);
    
    // Within-tick slippage follows AMM-like behavior
    const tickSlippage = amountInTick / currentLiquidity;
    const tickOutput = amountInTick * (1 - tickSlippage) * feeMultiplier;
    
    totalOutput += tickOutput;
    remainingInput -= amountInTick;
    
    // Move to next tick with decayed liquidity
    ticksCrossed++;
    currentLiquidity *= decayFactor;
    currentTickCapacity = currentLiquidity * (tickSpacing / 10000);
  }
  
  // Handle overflow (input exceeds simulated liquidity)
  if (remainingInput > 0) {
    // Severe slippage for remaining amount
    const overflowPenalty = 0.3 + 0.2 * (1 - remainingInput / inputUsd);
    totalOutput += remainingInput * overflowPenalty * feeMultiplier;
  }
  
  return totalOutput;
}

// ============================================================================
// DLMM (Discrete Liquidity Bins) Model
// ============================================================================

/**
 * Compute output for a DLMM (discrete liquidity bins) pool.
 * 
 * DLMM pools distribute liquidity across discrete price bins.
 * Each bin has a fixed price range, and liquidity is deployed
 * within bins at specific price points.
 * 
 * Similar to CLMM but with discrete bin structure instead of ticks.
 * 
 * @param inputUsd - Input amount in USD
 * @param hop - Hop parameters (should have activeBinLiquidity, binStep, tvlUsd)
 * @param params - DLMM slippage parameters
 * @returns Output amount in USD
 */
export function computeDlmmOutput(
  inputUsd: number,
  hop: HopParams,
  params: { activeBinFraction: number; liquidityDecayPerBin: number }
): number {
  // Estimate active bin liquidity
  let activeBinLiquidity: number;
  
  if (hop.activeBinLiquidity && hop.activeBinLiquidity > 0) {
    activeBinLiquidity = hop.activeBinLiquidity;
  } else if (hop.tvlUsd && hop.tvlUsd > 0) {
    // Estimate: fraction of TVL is in active bin
    activeBinLiquidity = hop.tvlUsd * params.activeBinFraction;
  } else {
    // Fallback
    activeBinLiquidity = 1000;
  }
  
  const binStep = hop.binStep ?? 10;
  const feeMultiplier = 1 - hop.feeBps / 10000;
  const decayFactor = params.liquidityDecayPerBin;
  
  // Single bin capacity
  // Each bin step is binStep bps price range
  const singleBinCapacityUsd = activeBinLiquidity * (binStep / 10000);
  
  // For small trades within the active bin
  if (inputUsd <= singleBinCapacityUsd * 0.5) {
    const withinBinSlippage = inputUsd / activeBinLiquidity;
    return inputUsd * feeMultiplier * (1 - withinBinSlippage);
  }
  
  // Simulate bin crossing
  let remainingInput = inputUsd;
  let totalOutput = 0;
  let currentBinLiquidity = activeBinLiquidity;
  let binsCrossed = 0;
  const maxBins = 30;
  
  while (remainingInput > 0 && currentBinLiquidity > 1 && binsCrossed < maxBins) {
    const currentBinCapacity = currentBinLiquidity * (binStep / 10000);
    const amountInBin = Math.min(remainingInput, currentBinCapacity);
    
    const binSlippage = amountInBin / currentBinLiquidity;
    const binOutput = amountInBin * (1 - binSlippage) * feeMultiplier;
    
    totalOutput += binOutput;
    remainingInput -= amountInBin;
    
    binsCrossed++;
    currentBinLiquidity *= decayFactor;
  }
  
  // Handle overflow
  if (remainingInput > 0) {
    const overflowPenalty = 0.3 + 0.2 * (1 - remainingInput / inputUsd);
    totalOutput += remainingInput * overflowPenalty * feeMultiplier;
  }
  
  return totalOutput;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Validate that hop parameters have sufficient data for simulation.
 * Returns true if the hop can be simulated, false if data is missing.
 */
export function hasValidHopData(hop: HopParams): boolean {
  switch (hop.poolType) {
    case 'amm':
      // AMM needs reserves
      return (hop.reserveIn ?? 0) > 0 && (hop.reserveOut ?? 0) > 0;
    case 'clmm':
      // CLMM needs liquidity
      return (hop.activeLiquidity ?? BigInt(0)) > BigInt(0);
    case 'dlmm':
      // DLMM needs either active bin liquidity or TVL
      return (hop.activeBinLiquidity ?? 0) > 0 || (hop.tvlUsd ?? 0) > 0;
    default:
      return false;
  }
}

/**
 * Get estimated active liquidity for a hop in USD.
 * Used for computing search bounds.
 */
export function getHopLiquidityUsd(hop: HopParams, params: SlippageModelParams): number {
  switch (hop.poolType) {
    case 'amm': {
      const reserveIn = (hop.reserveIn ?? 10000) * params.amm.reserveMultiplier;
      const reserveOut = (hop.reserveOut ?? 10000) * params.amm.reserveMultiplier;
      // Use geometric mean of reserves
      return Math.sqrt(reserveIn * reserveOut);
    }
    case 'clmm': {
      if (hop.activeLiquidity && hop.sqrtPriceX64) {
        const sqrtPriceDecimal = Number(hop.sqrtPriceX64) / Number(Q64);
        const virtualReserveA = Number(hop.activeLiquidity) / sqrtPriceDecimal;
        const virtualReserveB = Number(hop.activeLiquidity) * sqrtPriceDecimal;
        return Math.sqrt(virtualReserveA * virtualReserveB) / 1e6;
      }
      return Number(hop.activeLiquidity ?? BigInt(0)) / 1e6 || 10000;
    }
    case 'dlmm': {
      if (hop.activeBinLiquidity && hop.activeBinLiquidity > 0) {
        return hop.activeBinLiquidity;
      }
      return (hop.tvlUsd ?? 10000) * params.dlmm.activeBinFraction;
    }
    default:
      return 10000;
  }
}
