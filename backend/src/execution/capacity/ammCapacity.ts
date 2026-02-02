/**
 * AMM (Automated Market Maker) Capacity Computation
 * 
 * Computes capacity curves for constant product (xy=k) pools:
 * - Raydium AMM
 * - Pumpswap
 * - Meteora Balanced/DAMM
 * 
 * Math model:
 * - For xy=k: output = y * dx / (x + dx)
 * - Price impact = dx / x (approximately, for small trades)
 * - Slippage grows quadratically with trade size
 * 
 * This is the simplest and most predictable pool type.
 */

import type { CapacityCurve, Tier1EstimateResult } from './types.js';
import { STANDARD_CURVE_POINTS, DEFAULT_BREAK_EVEN_SLIPPAGE_BPS } from './types.js';
import { logger } from '../../utils/logger.js';

// ============================================================================
// Constants
// ============================================================================

/** Minimum reserve to consider (avoid division by zero) */
const MIN_RESERVE_USD = 100;

// ============================================================================
// Main Curve Computation
// ============================================================================

/**
 * Compute a capacity curve for an AMM pool.
 * 
 * @param poolId - Pool identifier
 * @param reserveInUsd - Reserve of input token in USD
 * @param reserveOutUsd - Reserve of output token in USD
 * @param feeBps - Pool fee in basis points
 * @param adjustment - Multiplier from user config (0.75, 1.0, or 1.25)
 * @param breakEvenSlippageBps - Target slippage for break-even (defaults to 50, should be actual profitBps)
 */
export function computeAmmCapacityCurve(
  poolId: string,
  reserveInUsd: number,
  reserveOutUsd: number,
  feeBps: number,
  adjustment: number = 1.0,
  breakEvenSlippageBps: number = DEFAULT_BREAK_EVEN_SLIPPAGE_BPS
): CapacityCurve {
  const now = Date.now();
  
  // Ensure minimum reserves
  const safeReserveIn = Math.max(reserveInUsd, MIN_RESERVE_USD);
  const safeReserveOut = Math.max(reserveOutUsd, MIN_RESERVE_USD);
  
  // Compute both direction-specific and direction-agnostic liquidity
  // Direction-specific: use actual reserveIn for capacity
  // Direction-agnostic: use geometric mean
  const geometricMeanLiquidity = Math.sqrt(safeReserveIn * safeReserveOut);
  
  // For imbalanced pools, capacity is constrained by the smaller side
  // Use the minimum of input reserve and geometric mean for conservative estimate
  const effectiveLiquidity = Math.min(safeReserveIn, geometricMeanLiquidity);
  const activeLiquidityUsd = effectiveLiquidity * adjustment;
  
  // Track imbalance for logging
  const imbalanceRatio = safeReserveIn / safeReserveOut;
  const isImbalanced = imbalanceRatio < 0.5 || imbalanceRatio > 2.0;
  
  // Build the curve at standard points
  const curve = new Map<number, number>();
  
  for (const sizeUsd of STANDARD_CURVE_POINTS) {
    const outputMultiplier = computeAmmOutputMultiplier(
      sizeUsd,
      safeReserveIn,
      safeReserveOut,
      feeBps
    );
    curve.set(sizeUsd, outputMultiplier);
  }
  
  // Find break-even size using actual profit margin
  const breakEvenSizeUsd = findBreakEvenSize(
    safeReserveIn,
    feeBps,
    breakEvenSlippageBps
  );
  
  const result: CapacityCurve = {
    poolId,
    poolType: 'amm',
    computedAt: now,
    confidence: 'high', // High because AMM math is deterministic
    breakEvenSizeUsd: breakEvenSizeUsd * adjustment,
    activeLiquidityUsd,
    curve,
    metadata: {
      feeBps,
      adjustment,
      breakEvenTargetBps: breakEvenSlippageBps,
      // Track reserve ratio for transparency
      reserveRatio: imbalanceRatio,
      isImbalanced,
    },
  };
  
  logger.debug('capacity.amm.computed', {
    cat: 'sizing',
    poolId: poolId.slice(0, 12) + '...',
    reserveInUsd: safeReserveIn.toFixed(2),
    reserveOutUsd: safeReserveOut.toFixed(2),
    activeLiquidityUsd: activeLiquidityUsd.toFixed(2),
    breakEvenSizeUsd: breakEvenSizeUsd.toFixed(2),
    breakEvenTargetBps: breakEvenSlippageBps,
    imbalanceRatio: imbalanceRatio.toFixed(2),
    isImbalanced,
    adjustment,
  });
  
  return result;
}

/**
 * Tier 1 instant estimate for AMM when no curve is available.
 * AMM is simple enough that Tier 1 is quite accurate.
 * 
 * @param inputUsd - Trade size to estimate
 * @param reserveInUsd - Reserve of input token in USD
 * @param reserveOutUsd - Reserve of output token in USD
 * @param feeBps - Fee in basis points
 * @param breakEvenSlippageBps - Target slippage for break-even (default: 50 bps)
 */
export function ammTier1Estimate(
  inputUsd: number,
  reserveInUsd: number,
  reserveOutUsd: number,
  feeBps: number,
  breakEvenSlippageBps: number = DEFAULT_BREAK_EVEN_SLIPPAGE_BPS
): Tier1EstimateResult {
  // Ensure minimum reserves
  const safeReserveIn = Math.max(reserveInUsd, MIN_RESERVE_USD);
  const safeReserveOut = Math.max(reserveOutUsd, MIN_RESERVE_USD);
  
  // Compute output multiplier
  const outputMultiplier = computeAmmOutputMultiplier(
    inputUsd,
    safeReserveIn,
    safeReserveOut,
    feeBps
  );
  
  // Convert to slippage bps
  const slippageBps = Math.round((1 - outputMultiplier) * 10000);
  
  // Find break-even size using actual profit margin
  const breakEvenSizeUsd = findBreakEvenSize(
    safeReserveIn,
    feeBps,
    breakEvenSlippageBps
  );
  
  return {
    outputMultiplier,
    slippageBps,
    confidence: 'low', // Still marked low because it's Tier 1, but AMM is reliable
    breakEvenSizeUsd,
  };
}

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * Compute output multiplier for a given trade size in AMM.
 * 
 * For constant product AMM (xy = k):
 * - After trade: (x + dx)(y - dy) = k = xy
 * - dy = y * dx / (x + dx)
 * - Ideal output (no slippage) = dx * (y/x) = dx * price
 * - Actual output = y * dx / (x + dx)
 * - Output multiplier = actual / ideal = x / (x + dx)
 */
function computeAmmOutputMultiplier(
  inputUsd: number,
  reserveInUsd: number,
  reserveOutUsd: number,
  feeBps: number
): number {
  if (inputUsd <= 0 || reserveInUsd <= 0) return 1.0;
  
  // Fee impact (applied to input)
  const feeMultiplier = 1 - feeBps / 10000;
  const effectiveInput = inputUsd * feeMultiplier;
  
  // AMM output multiplier: x / (x + dx)
  // This represents how much of the "ideal" output we get
  const ammMultiplier = reserveInUsd / (reserveInUsd + effectiveInput);
  
  // Total multiplier includes fee
  return feeMultiplier * ammMultiplier;
}

/**
 * Find trade size where slippage equals target.
 * 
 * For AMM: slippage = 1 - x/(x+dx) = dx/(x+dx)
 * Solving for dx: dx = x * slippage / (1 - slippage)
 */
function findBreakEvenSize(
  reserveInUsd: number,
  feeBps: number,
  targetSlippageBps: number
): number {
  // Account for fee in target
  const feeMultiplier = 1 - feeBps / 10000;
  const targetSlippage = targetSlippageBps / 10000;
  
  // Solve for the AMM portion of slippage (excluding fee)
  // Total slippage = 1 - feeMultiplier * ammMultiplier
  // targetSlippage = 1 - feeMultiplier * ammMultiplier
  // ammMultiplier = (1 - targetSlippage) / feeMultiplier
  const targetAmmMultiplier = (1 - targetSlippage) / feeMultiplier;
  
  // ammMultiplier = x / (x + dx)
  // targetAmmMultiplier = x / (x + dx)
  // x + dx = x / targetAmmMultiplier
  // dx = x * (1/targetAmmMultiplier - 1)
  // dx = x * (1 - targetAmmMultiplier) / targetAmmMultiplier
  
  if (targetAmmMultiplier <= 0 || targetAmmMultiplier >= 1) {
    return reserveInUsd * 0.01; // 1% of reserve as fallback
  }
  
  return reserveInUsd * (1 - targetAmmMultiplier) / targetAmmMultiplier;
}

/**
 * Calculate exact AMM output for a given input.
 * 
 * dy = y * dx * gamma / (x + dx * gamma)
 * where gamma = 1 - feeBps/10000
 */
export function calculateAmmOutput(
  inputAmount: number,
  reserveIn: number,
  reserveOut: number,
  feeBps: number
): number {
  if (inputAmount <= 0 || reserveIn <= 0 || reserveOut <= 0) return 0;
  
  const gamma = 1 - feeBps / 10000;
  const effectiveInput = inputAmount * gamma;
  
  return (reserveOut * effectiveInput) / (reserveIn + effectiveInput);
}

/**
 * Calculate required input for a desired output.
 * 
 * Inverse of calculateAmmOutput:
 * dx = x * dy / ((y - dy) * gamma)
 */
export function calculateAmmInput(
  outputAmount: number,
  reserveIn: number,
  reserveOut: number,
  feeBps: number
): number {
  if (outputAmount <= 0 || reserveIn <= 0 || reserveOut <= 0) return Infinity;
  if (outputAmount >= reserveOut) return Infinity; // Can't extract more than reserve
  
  const gamma = 1 - feeBps / 10000;
  
  return (reserveIn * outputAmount) / ((reserveOut - outputAmount) * gamma);
}

/**
 * Calculate price impact for a trade.
 * Returns impact in basis points.
 */
export function calculateAmmPriceImpact(
  inputAmount: number,
  reserveIn: number,
  feeBps: number
): number {
  if (inputAmount <= 0 || reserveIn <= 0) return 0;
  
  const gamma = 1 - feeBps / 10000;
  const effectiveInput = inputAmount * gamma;
  
  // Price impact = dx / (x + dx) as bps
  const impact = effectiveInput / (reserveIn + effectiveInput);
  
  return Math.round(impact * 10000);
}
