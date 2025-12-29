/**
 * Optimal Arbitrage Sizing Calculator
 * 
 * Uses analytical formulas and iterative optimization to find the trade size
 * that maximizes net profit after accounting for slippage.
 * 
 * Key formulas:
 * - AMM (xy=k): Δ* = R × (√(rate_product) - 1) / γ
 * - CLMM: Same as AMM but with virtual reserves L/√P
 * - DLMM: Sum of bin liquidity until cumulative slippage exceeds profit
 */

import { logger } from '../utils/logger.js';
import { logCatchError } from '../utils/errorHandler.js';

// ============================================================================
// Types
// ============================================================================

export type PoolType = 'amm' | 'clmm' | 'dlmm';

export interface HopSizingInfo {
  poolType: PoolType;
  feeBps: number;
  reserveInUsd: number;           // Reserve of input token in USD
  reserveOutUsd: number;          // Reserve of output token in USD
  rate: number;                   // Exchange rate for this hop
  // CLMM-specific
  activeLiquidity?: number;       // L from sqrt_price_x64
  currentPrice?: number;          // Current price from tick
  tickSpacing?: number;
  // DLMM-specific
  binStep?: number;
  activeBinLiquidity?: number;
}

export interface OptimalSizeResult {
  optimalSizeUsd: number;
  expectedProfitUsd: number;
  method: 'closed_form' | 'iterative' | 'heuristic';
  breakdown: {
    grossProfitUsd: number;
    slippageCostUsd: number;
    netProfitUsd: number;
  };
}

export interface OptimalSizingConfig {
  // Slippage model multipliers (1.0 = standard, higher = more conservative)
  ammSlippageMultiplier: number;     // Default 2.0
  clmmSlippageMultiplier: number;    // Default 3.0
  dlmmSlippageMultiplier: number;    // Default 1.3
  
  // Iterative search settings
  iterativeMaxIterations: number;    // Default 15
  iterativeTolerance: number;        // Default 1.0 (USD)
  
  // Safety margin on optimal (0.9 = use 90% of calculated optimal)
  safetyFactor: number;              // Default 0.85
}

export const DEFAULT_OPTIMAL_CONFIG: OptimalSizingConfig = {
  ammSlippageMultiplier: 2.0,
  clmmSlippageMultiplier: 3.0,
  dlmmSlippageMultiplier: 1.3,
  iterativeMaxIterations: 15,
  iterativeTolerance: 1.0,
  safetyFactor: 0.85,
};

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Calculate optimal arbitrage size for a cycle
 */
export function calculateOptimalArbSize(
  hops: HopSizingInfo[],
  rateProduct: number,   // Product of all hop rates (should be > 1 for profitable arb)
  minSizeUsd: number = 1,
  maxSizeUsd: number = 10000,
  method: 'optimal_analytical' | 'optimal_iterative' = 'optimal_analytical',
  config: Partial<OptimalSizingConfig> = {}
): OptimalSizeResult {
  const cfg = { ...DEFAULT_OPTIMAL_CONFIG, ...config };
  
  // Validate inputs
  if (rateProduct <= 1.0 || hops.length === 0) {
    return {
      optimalSizeUsd: 0,
      expectedProfitUsd: 0,
      method: 'closed_form',
      breakdown: { grossProfitUsd: 0, slippageCostUsd: 0, netProfitUsd: 0 }
    };
  }
  
  try {
    // Check if all hops are AMM (can use closed-form)
    const allAmm = hops.every(h => h.poolType === 'amm');
    
    let result: OptimalSizeResult;
    
    if (method === 'optimal_analytical' && allAmm) {
      result = calculateOptimalAmmCycle(hops, rateProduct, minSizeUsd, maxSizeUsd, cfg);
    } else {
      // Mixed pools or iterative requested: use golden section search
      result = calculateOptimalIterative(hops, rateProduct, minSizeUsd, maxSizeUsd, cfg);
    }
    
    // Apply safety factor
    result.optimalSizeUsd *= cfg.safetyFactor;
    result.optimalSizeUsd = Math.max(minSizeUsd, Math.min(maxSizeUsd, result.optimalSizeUsd));
    
    // Recalculate profit at safety-adjusted size
    result.breakdown = calculateProfitBreakdown(result.optimalSizeUsd, hops, rateProduct, cfg);
    result.expectedProfitUsd = result.breakdown.netProfitUsd;
    
    logger.debug('optimalSizing.calculated', {
      cat: 'arb',
      method: result.method,
      rateProduct,
      hopCount: hops.length,
      poolTypes: hops.map(h => h.poolType),
      optimalSizeUsd: result.optimalSizeUsd,
      expectedProfitUsd: result.expectedProfitUsd,
      safetyFactor: cfg.safetyFactor,
    });
    
    return result;
  } catch (e) {
    logCatchError('optimalSizing.calculateOptimalArbSize', e);
    // Fallback to minimum size
    return {
      optimalSizeUsd: minSizeUsd,
      expectedProfitUsd: 0,
      method: 'heuristic',
      breakdown: { grossProfitUsd: 0, slippageCostUsd: 0, netProfitUsd: 0 }
    };
  }
}

// ============================================================================
// Analytical Solution (AMM-only)
// ============================================================================

/**
 * Closed-form solution for pure AMM cycles
 * 
 * For N-hop cycle through constant product pools:
 * Δ* = R̄ × (R^(1/(n+1)) - 1) / γ^(1/n)
 * 
 * where:
 * - R̄ is geometric mean of reserves
 * - R is rate product
 * - γ is cumulative fee factor
 */
function calculateOptimalAmmCycle(
  hops: HopSizingInfo[],
  rateProduct: number,
  minSizeUsd: number,
  maxSizeUsd: number,
  cfg: OptimalSizingConfig
): OptimalSizeResult {
  const n = hops.length;
  
  // Compute effective fee factor (product of all gamma_i)
  const gamma = hops.reduce((acc, h) => acc * (1 - h.feeBps / 10000), 1);
  
  // Geometric mean of input reserves
  const reserveProduct = hops.reduce((acc, h) => {
    const reserve = h.reserveInUsd > 0 ? h.reserveInUsd : 1000; // Fallback
    return acc * reserve;
  }, 1);
  const geoMeanReserve = Math.pow(reserveProduct, 1 / n);
  
  // Optimal size: Δ* = R̄ × (R^(1/(n+1)) - 1) / γ^(1/n)
  const sqrtR = Math.pow(rateProduct, 1 / (n + 1));
  const gammaNorm = Math.pow(gamma, 1 / n);
  
  let optimalSize = geoMeanReserve * (sqrtR - 1) / gammaNorm;
  
  // Validate result
  if (!Number.isFinite(optimalSize) || optimalSize <= 0) {
    optimalSize = minSizeUsd;
  }
  
  // Clamp to bounds
  optimalSize = Math.max(minSizeUsd, Math.min(maxSizeUsd, optimalSize));
  
  // Calculate expected profit
  const breakdown = calculateProfitBreakdown(optimalSize, hops, rateProduct, cfg);
  
  return {
    optimalSizeUsd: optimalSize,
    expectedProfitUsd: breakdown.netProfitUsd,
    method: 'closed_form',
    breakdown
  };
}

// ============================================================================
// Iterative Optimization (Golden Section Search)
// ============================================================================

/**
 * Iterative optimization for mixed pool types using golden section search.
 * 
 * Finds the maximum of the profit function, which is typically concave:
 * profit(size) = grossProfit(size) - slippageCost(size)
 */
function calculateOptimalIterative(
  hops: HopSizingInfo[],
  rateProduct: number,
  minSizeUsd: number,
  maxSizeUsd: number,
  cfg: OptimalSizingConfig
): OptimalSizeResult {
  const goldenRatio = (Math.sqrt(5) - 1) / 2;
  
  let a = minSizeUsd;
  let b = maxSizeUsd;
  let c = b - goldenRatio * (b - a);
  let d = a + goldenRatio * (b - a);
  
  const profit = (size: number) => calculateProfitBreakdown(size, hops, rateProduct, cfg).netProfitUsd;
  
  let profitC = profit(c);
  let profitD = profit(d);
  
  const tolerance = cfg.iterativeTolerance;
  const maxIter = cfg.iterativeMaxIterations;
  
  for (let i = 0; i < maxIter && (b - a) > tolerance; i++) {
    if (profitC > profitD) {
      b = d;
      d = c;
      profitD = profitC;
      c = b - goldenRatio * (b - a);
      profitC = profit(c);
    } else {
      a = c;
      c = d;
      profitC = profitD;
      d = a + goldenRatio * (b - a);
      profitD = profit(d);
    }
  }
  
  const optimalSize = (a + b) / 2;
  const breakdown = calculateProfitBreakdown(optimalSize, hops, rateProduct, cfg);
  
  return {
    optimalSizeUsd: optimalSize,
    expectedProfitUsd: breakdown.netProfitUsd,
    method: 'iterative',
    breakdown
  };
}

// ============================================================================
// Profit Calculation
// ============================================================================

/**
 * Calculate profit breakdown at a given size.
 * 
 * Accounts for:
 * - Gross profit from arbitrage spread
 * - Slippage cost across all hops (pool-type specific)
 */
function calculateProfitBreakdown(
  sizeUsd: number,
  hops: HopSizingInfo[],
  rateProduct: number,
  cfg: OptimalSizingConfig
): { grossProfitUsd: number; slippageCostUsd: number; netProfitUsd: number } {
  if (sizeUsd <= 0 || !Number.isFinite(sizeUsd)) {
    return { grossProfitUsd: 0, slippageCostUsd: 0, netProfitUsd: 0 };
  }
  
  // Gross profit from arbitrage spread
  const grossProfitUsd = sizeUsd * (rateProduct - 1);
  
  // Calculate slippage across all hops
  let slippageCostUsd = 0;
  let currentSize = sizeUsd;
  
  for (const hop of hops) {
    const gamma = 1 - hop.feeBps / 10000;
    const reserveIn = hop.reserveInUsd > 0 ? hop.reserveInUsd : 1000; // Fallback
    
    switch (hop.poolType) {
      case 'amm': {
        // AMM slippage: approximately (size / reserve)² × size × multiplier
        const ratio = currentSize / reserveIn;
        // Exact formula: output = reserve × size × γ / (reserve + size × γ)
        // Slippage = expected - actual ≈ size × ratio² × γ for larger swaps
        const slippage = currentSize * ratio * gamma * cfg.ammSlippageMultiplier;
        slippageCostUsd += slippage;
        
        // Propagate (exact AMM output, simplified)
        const reserveOut = hop.reserveOutUsd > 0 ? hop.reserveOutUsd : reserveIn;
        currentSize = (reserveOut * currentSize * gamma) / (reserveIn + currentSize * gamma);
        break;
      }
      
      case 'clmm': {
        // CLMM: use virtual reserves from active liquidity
        const L = hop.activeLiquidity && hop.activeLiquidity > 0 ? hop.activeLiquidity : reserveIn;
        const sqrtP = Math.sqrt(hop.currentPrice && hop.currentPrice > 0 ? hop.currentPrice : 1);
        const virtualReserve = L / sqrtP;
        const effectiveReserve = virtualReserve > 0 ? virtualReserve : reserveIn;
        
        const ratio = currentSize / effectiveReserve;
        // Extra multiplier for tick crossing uncertainty
        const slippage = currentSize * ratio * gamma * cfg.clmmSlippageMultiplier;
        slippageCostUsd += slippage;
        
        // Add tick crossing cost
        const tickCrossings = Math.ceil(ratio * 10); // Rough estimate
        const tickSpacing = hop.tickSpacing || 1;
        slippageCostUsd += tickCrossings * (tickSpacing / 10000) * currentSize;
        
        currentSize = currentSize * hop.rate * gamma * Math.max(0.5, 1 - ratio);
        break;
      }
      
      case 'dlmm': {
        // DLMM: discrete bin stepping
        const binLiquidity = hop.activeBinLiquidity && hop.activeBinLiquidity > 0 
          ? hop.activeBinLiquidity 
          : reserveIn * 0.1;
        const binStep = hop.binStep || 10;
        
        const binsTraversed = Math.ceil(currentSize / binLiquidity);
        // Each bin costs binStep bps
        const slippage = currentSize * (binsTraversed * binStep / 10000) * cfg.dlmmSlippageMultiplier;
        slippageCostUsd += slippage;
        
        currentSize = currentSize * hop.rate * gamma * Math.max(0.5, 1 - binsTraversed * binStep / 10000);
        break;
      }
    }
    
    // Ensure currentSize doesn't go negative
    currentSize = Math.max(0, currentSize);
  }
  
  const netProfitUsd = grossProfitUsd - slippageCostUsd;
  
  return {
    grossProfitUsd,
    slippageCostUsd,
    netProfitUsd: Math.max(-sizeUsd, netProfitUsd) // Cap loss at input size
  };
}

// ============================================================================
// Helper: Build HopSizingInfo from Opportunity
// ============================================================================

/**
 * Build HopSizingInfo array from opportunity data and pool cache.
 * 
 * This bridges the opportunity detection (which has path info) with
 * the sizing calculator (which needs reserve data).
 */
export async function buildHopSizingInfo(
  path: string[],
  hopPoolIds: string[],
  hopDexes: string[],
  hopRates?: number[],
  hopFeeBps?: number[],
  hopLiquidityDisplay?: number[]
): Promise<HopSizingInfo[]> {
  const hops: HopSizingInfo[] = [];
  
  try {
    // Import pool accessors
    const { peekRaydiumPools, peekOrcaPools, peekMeteoraPools, peekPumpswapPools } = 
      await import('../server/pools.js');
    
    for (let i = 0; i < hopPoolIds.length; i++) {
      const poolId = hopPoolIds[i].replace(/[#-]rev$/, '');
      const dex = (hopDexes[i] || '').toLowerCase();
      
      // Determine pool type
      let poolType: PoolType = 'amm';
      if (dex.includes('clmm') || dex === 'orca' || dex.includes('raydium-clmm')) {
        poolType = 'clmm';
      } else if (dex.includes('dlmm') || dex.includes('meteora')) {
        poolType = 'dlmm';
      }
      
      // Get reserves from cached pool data
      let reserveInUsd = 1000;  // Default fallback
      let reserveOutUsd = 1000;
      let activeLiquidity: number | undefined;
      let currentPrice: number | undefined;
      let tickSpacing: number | undefined;
      let binStep: number | undefined;
      let activeBinLiquidity: number | undefined;
      
      // Use hop liquidity if available
      if (hopLiquidityDisplay && hopLiquidityDisplay[i] > 0) {
        reserveInUsd = hopLiquidityDisplay[i];
        reserveOutUsd = hopLiquidityDisplay[i];
      }
      
      // Try to get more detailed info from pool cache
      try {
        if (dex.includes('raydium')) {
          const pools = peekRaydiumPools();
          const poolList = dex.includes('clmm') ? pools.clmm : pools.amm;
          const pool = (poolList || []).find((p: any) => String(p?.id || '') === poolId);
          if (pool) {
            reserveInUsd = Number((pool as any).tvl_usd || (pool as any).amount_a_whole) || reserveInUsd;
            reserveOutUsd = Number((pool as any).tvl_usd || (pool as any).amount_b_whole) || reserveOutUsd;
            if (poolType === 'clmm') {
              activeLiquidity = Number((pool as any).liquidity) || undefined;
              tickSpacing = Number((pool as any).tick_spacing) || undefined;
            }
          }
        } else if (dex.includes('orca')) {
          const pools = peekOrcaPools();
          const pool = (pools.clmm || []).find((p: any) => String(p?.id || '') === poolId);
          if (pool) {
            reserveInUsd = Number((pool as any).tvl_usd || (pool as any).liquidity) || reserveInUsd;
            reserveOutUsd = reserveInUsd;
            activeLiquidity = Number((pool as any).liquidity) || undefined;
            tickSpacing = Number((pool as any).tick_spacing) || undefined;
          }
        } else if (dex.includes('meteora')) {
          const pools = peekMeteoraPools();
          const pool = (pools.clmm || []).find((p: any) => String(p?.id || '') === poolId);
          if (pool) {
            reserveInUsd = Number((pool as any).tvl_usd || (pool as any).liquidity_raw) || reserveInUsd;
            reserveOutUsd = reserveInUsd;
            binStep = Number((pool as any).bin_step) || 10;
            activeBinLiquidity = reserveInUsd * 0.1; // Estimate 10% in active bin
          }
        } else if (dex.includes('pumpswap')) {
          const pools = peekPumpswapPools();
          const pool = (pools.amm || []).find((p: any) => String(p?.id || '') === poolId);
          if (pool) {
            reserveInUsd = Number((pool as any).tvl_usd) || reserveInUsd;
            reserveOutUsd = reserveInUsd;
          }
        }
      } catch (e) {
        // Ignore pool lookup errors, use defaults
      }
      
      hops.push({
        poolType,
        feeBps: hopFeeBps?.[i] ?? 25,
        reserveInUsd,
        reserveOutUsd,
        rate: hopRates?.[i] ?? 1.0,
        activeLiquidity,
        currentPrice,
        tickSpacing,
        binStep,
        activeBinLiquidity,
      });
    }
  } catch (e) {
    logCatchError('optimalSizing.buildHopSizingInfo', e);
  }
  
  return hops;
}

// ============================================================================
// Convenience: Calculate from Opportunity Object
// ============================================================================

export interface OpportunityLike {
  path: string[];
  hop_pool_ids?: string[];
  hop_dexes?: string[];
  dexes?: string[];
  hop_rates?: number[];
  hop_fee_bps?: number[];
  hop_liquidity_display?: number[];
  rate_product?: number;
  profit_bps?: number;
  net_bps?: number;
  est_capacity?: number;
  min_edge_liquidity?: number;
}

/**
 * Calculate optimal size directly from an opportunity object.
 */
export async function calculateOptimalSizeFromOpportunity(
  opp: OpportunityLike,
  minSizeUsd: number,
  maxSizeUsd: number,
  method: 'optimal_analytical' | 'optimal_iterative' = 'optimal_analytical',
  config: Partial<OptimalSizingConfig> = {}
): Promise<OptimalSizeResult> {
  // Build hop info
  const hopPoolIds = opp.hop_pool_ids || [];
  const hopDexes = opp.hop_dexes || opp.dexes || [];
  
  if (hopPoolIds.length === 0) {
    // No pool IDs, can't calculate optimal
    return {
      optimalSizeUsd: minSizeUsd,
      expectedProfitUsd: 0,
      method: 'heuristic',
      breakdown: { grossProfitUsd: 0, slippageCostUsd: 0, netProfitUsd: 0 }
    };
  }
  
  const hops = await buildHopSizingInfo(
    opp.path,
    hopPoolIds,
    hopDexes,
    opp.hop_rates,
    opp.hop_fee_bps,
    opp.hop_liquidity_display
  );
  
  // Get rate product
  const rateProduct = opp.rate_product ?? (1 + (opp.profit_bps ?? 0) / 10000);
  
  return calculateOptimalArbSize(hops, rateProduct, minSizeUsd, maxSizeUsd, method, config);
}

