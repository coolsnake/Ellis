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
  // Vault constraint fields (for CLMM/DLMM capacity estimation)
  inputMint?: string;             // Input mint for this hop
  outputMint?: string;            // Output mint for this hop
  outputVaultUsd?: number;        // Output token vault balance in USD
  inputVaultUsd?: number;         // Input token vault balance in USD
  vaultImbalanceRatio?: number;   // min(vaultA,vaultB)/max(vaultA,vaultB) - closer to 1 = balanced
  hopCapacityUsd?: number;        // Estimated realistic trade capacity for this hop
  capacityLimitingFactor?: string; // What limits capacity: 'profit_margin' | 'active_liquidity' | 'vault_balance' | 'tvl'
  capacityWarnings?: string[];    // Warnings about this hop's capacity
}

// ============================================================================
// CLMM/DLMM Capacity Estimation
// ============================================================================

export interface ClmmCapacityEstimate {
  /** Maximum safe trade size in USD considering all constraints */
  capacityUsd: number;
  /** Which constraint is binding */
  limitingFactor: 'profit_margin' | 'active_liquidity' | 'vault_balance' | 'tvl';
  /** Detailed breakdown */
  breakdown: {
    /** Capacity based on profit margin tolerance */
    profitConstrainedUsd: number;
    /** Capacity based on active liquidity */
    liquidityConstrainedUsd: number;
    /** Capacity based on output vault balance */
    vaultConstrainedUsd: number;
    /** Raw output vault balance USD */
    outputVaultUsd: number;
    /** Vault imbalance ratio (0-1, 1=balanced) */
    vaultImbalanceRatio: number;
  };
  /** Whether this hop looks risky */
  warnings: string[];
}

/**
 * Estimate realistic trade capacity for a CLMM/DLMM hop.
 * 
 * This considers:
 * 1. Profit margin - how much slippage we can tolerate
 * 2. Active liquidity - how much is deployed at current price
 * 3. Vault balance - hard cap on available output tokens
 * 4. Vault imbalance - signals we're at edge of LP ranges
 * 
 * For CLMM pools, vault imbalance is a critical signal:
 * - If output vault is depleted (e.g., $135 USDC vs $3000 JUP), price has moved
 *   to the edge of LP ranges and available liquidity is scarce
 * - The remaining output tokens may be in ticks/bins far from current price
 * - This severely limits realistic trade capacity
 */
export function estimateClmmCapacity(
  profitBps: number,
  poolType: 'clmm' | 'dlmm',
  activeLiquidity: number,      // In USD (from liquidity_raw or liquidity_display)
  outputVaultUsd: number,       // Output token vault balance in USD
  inputVaultUsd: number,        // Input token vault balance in USD
  tvlUsd?: number,              // Total pool TVL if known
  binStep?: number,             // For DLMM: bin step in bps
): ClmmCapacityEstimate {
  const warnings: string[] = [];
  
  // =========================================================================
  // 1. Profit-Constrained Capacity
  // =========================================================================
  // At X bps profit, we can tolerate ~X bps slippage before breaking even.
  // For CLMM: slippage ≈ k * (trade_size / active_liquidity)
  // where k depends on pool type (CLMM vs DLMM behavior)
  
  const slippageMultiplier = poolType === 'clmm' ? 1.5 : 1.2; // CLMM has steeper curves
  const tolerableSlippageBps = Math.max(1, profitBps * 0.7); // Use 70% of profit as slippage budget
  
  // trade_size / L ≈ slippage_bps / (k * 10000)
  // trade_size ≈ L * slippage_bps / (k * 10000)
  const profitConstrainedUsd = activeLiquidity > 0 
    ? (activeLiquidity * tolerableSlippageBps) / (slippageMultiplier * 10000)
    : 0;
  
  // =========================================================================
  // 2. Liquidity-Constrained Capacity
  // =========================================================================
  // Even ignoring profit, you can't extract more than a fraction of active liquidity
  // without severe price impact. Conservative estimate: 1-3% of active liquidity.
  
  const maxLiquidityFraction = poolType === 'dlmm' 
    ? (binStep && binStep > 50 ? 0.03 : 0.02)  // Wider bins = more tolerance
    : 0.015; // CLMM is more sensitive
    
  const liquidityConstrainedUsd = activeLiquidity * maxLiquidityFraction;
  
  // =========================================================================
  // 3. Vault-Constrained Capacity
  // =========================================================================
  // The output vault provides a hard ceiling. But we also need to account
  // for the distribution of liquidity - imbalanced vaults mean less accessible liquidity.
  
  const maxVault = Math.max(outputVaultUsd, inputVaultUsd);
  const minVault = Math.min(outputVaultUsd, inputVaultUsd);
  const vaultImbalanceRatio = maxVault > 0 ? minVault / maxVault : 0;
  
  // Extraction factor decreases as vault becomes more imbalanced
  // At 1:1 ratio: can extract up to 15% of output vault
  // At 10:1 ratio: can extract maybe 2% (liquidity is likely at edge of ranges)
  // At 20:1 ratio: can extract ~1% (severely constrained)
  let extractionFactor: number;
  if (vaultImbalanceRatio >= 0.5) {
    extractionFactor = 0.15;  // Balanced - can extract 15%
  } else if (vaultImbalanceRatio >= 0.2) {
    extractionFactor = 0.08;  // Moderately imbalanced
  } else if (vaultImbalanceRatio >= 0.1) {
    extractionFactor = 0.04;  // Imbalanced
  } else if (vaultImbalanceRatio >= 0.05) {
    extractionFactor = 0.02;  // Severely imbalanced (like 20:1)
    warnings.push(`Severe vault imbalance (${(vaultImbalanceRatio * 100).toFixed(1)}%)`);
  } else {
    extractionFactor = 0.01;  // Extremely imbalanced - nearly depleted
    warnings.push(`Output vault nearly depleted (${(vaultImbalanceRatio * 100).toFixed(2)}%)`);
  }
  
  const vaultConstrainedUsd = outputVaultUsd * extractionFactor;
  
  // =========================================================================
  // 4. TVL Sanity Check
  // =========================================================================
  // Never try to extract more than 2% of total pool TVL
  const tvlConstrainedUsd = tvlUsd && tvlUsd > 0 ? tvlUsd * 0.02 : Infinity;
  
  // =========================================================================
  // Final Capacity = Minimum of All Constraints
  // =========================================================================
  type CapacityFactor = ClmmCapacityEstimate['limitingFactor'];
  const allCandidates: { factor: CapacityFactor; value: number }[] = [
    { factor: 'profit_margin' as CapacityFactor, value: profitConstrainedUsd },
    { factor: 'active_liquidity' as CapacityFactor, value: liquidityConstrainedUsd },
    { factor: 'vault_balance' as CapacityFactor, value: vaultConstrainedUsd },
    { factor: 'tvl' as CapacityFactor, value: tvlConstrainedUsd },
  ];
  const candidates = allCandidates.filter(c => c.value > 0 && Number.isFinite(c.value));
  
  const binding = candidates.length > 0
    ? candidates.reduce((min, c) => c.value < min.value ? c : min)
    : { factor: 'tvl' as const, value: 0 };
  
  // Add warning if vault is the binding constraint (common for imbalanced pools)
  if (binding.factor === 'vault_balance' && vaultImbalanceRatio < 0.3) {
    warnings.push(`Vault imbalance limits capacity to $${binding.value.toFixed(2)}`);
  }
  
  // Add warning for very low capacity
  if (binding.value < 1) {
    warnings.push(`Very low capacity: $${binding.value.toFixed(2)}`);
  }
  
  return {
    capacityUsd: Math.max(0, binding.value),
    limitingFactor: binding.factor,
    breakdown: {
      profitConstrainedUsd,
      liquidityConstrainedUsd,
      vaultConstrainedUsd,
      outputVaultUsd,
      vaultImbalanceRatio,
    },
    warnings,
  };
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
    // =========================================================================
    // Apply CLMM/DLMM Capacity Constraints
    // =========================================================================
    // For CLMM/DLMM pools, vault imbalance severely limits realistic trade capacity.
    // Find the minimum capacity across all concentrated liquidity hops.
    const clmmCapacities = hops
      .filter(h => h.poolType !== 'amm' && h.hopCapacityUsd != null && h.hopCapacityUsd > 0)
      .map(h => h.hopCapacityUsd!);
    
    const capacityConstraint = clmmCapacities.length > 0 
      ? Math.min(...clmmCapacities)
      : Infinity;
    
    // Apply capacity constraint to maxSizeUsd
    const effectiveMaxSize = Math.min(maxSizeUsd, capacityConstraint);
    
    // Log if capacity constraint reduces our max size significantly
    if (capacityConstraint < maxSizeUsd && capacityConstraint < Infinity) {
      const constrainedHops = hops
        .filter(h => h.hopCapacityUsd != null && h.hopCapacityUsd <= capacityConstraint)
        .map((h, idx) => ({
          hop: idx,
          poolType: h.poolType,
          capacity: h.hopCapacityUsd?.toFixed(2),
          limitingFactor: h.capacityLimitingFactor,
          vaultImbalance: h.vaultImbalanceRatio ? (h.vaultImbalanceRatio * 100).toFixed(1) + '%' : 'N/A',
          warnings: h.capacityWarnings,
        }));
      
      logger.info('optimalSizing.capacity_constraint_applied', {
        cat: 'sizing',
        ctx: {
          originalMaxUsd: maxSizeUsd.toFixed(2),
          capacityConstraint: capacityConstraint.toFixed(2),
          effectiveMaxUsd: effectiveMaxSize.toFixed(2),
          reductionPct: ((1 - effectiveMaxSize / maxSizeUsd) * 100).toFixed(1) + '%',
          constrainedHops,
        }
      });
    }
    
    // If capacity is very low, warn and potentially skip
    if (effectiveMaxSize < minSizeUsd) {
      logger.warn('optimalSizing.capacity_below_minimum', {
        cat: 'sizing',
        ctx: {
          minSizeUsd,
          capacityConstraint: capacityConstraint.toFixed(2),
          reason: 'CLMM/DLMM vault capacity too low for minimum trade size',
        }
      });
      return {
        optimalSizeUsd: 0,
        expectedProfitUsd: 0,
        method: 'heuristic',
        breakdown: { grossProfitUsd: 0, slippageCostUsd: 0, netProfitUsd: 0 }
      };
    }
    
    // Check if all hops are AMM (can use closed-form)
    const allAmm = hops.every(h => h.poolType === 'amm');
    
    let result: OptimalSizeResult;
    
    if (method === 'optimal_analytical' && allAmm) {
      result = calculateOptimalAmmCycle(hops, rateProduct, minSizeUsd, effectiveMaxSize, cfg);
    } else {
      // Mixed pools or iterative requested: use golden section search
      result = calculateOptimalIterative(hops, rateProduct, minSizeUsd, effectiveMaxSize, cfg);
    }
    
    // Apply safety factor
    result.optimalSizeUsd *= cfg.safetyFactor;
    result.optimalSizeUsd = Math.max(minSizeUsd, Math.min(effectiveMaxSize, result.optimalSizeUsd));
    
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
      capacityConstraintApplied: capacityConstraint < maxSizeUsd,
      capacityConstraint: capacityConstraint < Infinity ? capacityConstraint.toFixed(2) : 'none',
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
 * 
 * For CLMM/DLMM pools, also calculates realistic trade capacity based on:
 * - Profit margin (how much slippage can be tolerated)
 * - Active liquidity at current price
 * - Vault balances (hard cap on available output)
 * - Vault imbalance (signals edge of LP ranges)
 */
export async function buildHopSizingInfo(
  path: string[],
  hopPoolIds: string[],
  hopDexes: string[],
  hopRates?: number[],
  hopFeeBps?: number[],
  hopLiquidityDisplay?: number[],
  profitBps?: number  // Overall opportunity profit for capacity estimation
): Promise<HopSizingInfo[]> {
  const hops: HopSizingInfo[] = [];
  
  // Import price store for USD conversions
  let getPriceByMint: ((mint: string) => { usdc: number | null; sol: number | null } | undefined) | undefined;
  try {
    const priceModule = await import('../server/priceStore.js');
    getPriceByMint = priceModule.getPriceByMint;
  } catch {
    // Price store not available, will skip USD conversions
  }
  
  try {
    // Import pool accessors
    const { peekRaydiumPools, peekOrcaPools, peekMeteoraPools, peekPumpswapPools } = 
      await import('../server/pools.js');
    
    for (let i = 0; i < hopPoolIds.length; i++) {
      const poolId = hopPoolIds[i].replace(/[#-]rev$/, '');
      const dex = (hopDexes[i] || '').toLowerCase();
      const inputMint = path[i];
      const outputMint = path[i + 1];
      
      // Determine pool type
      let poolType: PoolType = 'amm';
      if (dex.includes('clmm') || dex === 'orca' || dex.includes('raydium-clmm')) {
        poolType = 'clmm';
      } else if (dex.includes('dlmm') || (dex.includes('meteora') && !dex.includes('balanced'))) {
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
      let tvlUsd: number | undefined;
      
      // Vault tracking for CLMM/DLMM capacity estimation
      let outputVaultUsd: number | undefined;
      let inputVaultUsd: number | undefined;
      let vaultImbalanceRatio: number | undefined;
      let hopCapacityUsd: number | undefined;
      let capacityLimitingFactor: string | undefined;
      let capacityWarnings: string[] = [];
      
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
            tvlUsd = Number((pool as any).tvl_usd) || undefined;
            reserveInUsd = tvlUsd || Number((pool as any).amount_a_whole) || reserveInUsd;
            reserveOutUsd = tvlUsd || Number((pool as any).amount_b_whole) || reserveOutUsd;
            if (poolType === 'clmm') {
              activeLiquidity = Number((pool as any).liquidity_display || (pool as any).liquidity) || undefined;
              tickSpacing = Number((pool as any).tick_spacing) || undefined;
              
              // Extract vault balances for capacity estimation
              const poolMintA = String((pool as any)?.mint_a || '');
              const poolMintB = String((pool as any)?.mint_b || '');
              const amountAWhole = Number((pool as any)?.amount_a_whole || 0);
              const amountBWhole = Number((pool as any)?.amount_b_whole || 0);
              
              if (amountAWhole > 0 || amountBWhole > 0) {
                const outputIsA = outputMint === poolMintA;
                const outputIsB = outputMint === poolMintB;
                
                // Get USD prices for vault values
                if (getPriceByMint) {
                  const priceA = Number(getPriceByMint(poolMintA)?.usdc ?? 0);
                  const priceB = Number(getPriceByMint(poolMintB)?.usdc ?? 0);
                  
                  if (outputIsA && priceA > 0) {
                    outputVaultUsd = amountAWhole * priceA;
                    inputVaultUsd = priceB > 0 ? amountBWhole * priceB : amountBWhole;
                  } else if (outputIsB && priceB > 0) {
                    outputVaultUsd = amountBWhole * priceB;
                    inputVaultUsd = priceA > 0 ? amountAWhole * priceA : amountAWhole;
                  }
                } else {
                  // Fallback: use whole amounts as rough estimate
                  outputVaultUsd = outputMint === poolMintA ? amountAWhole : amountBWhole;
                  inputVaultUsd = outputMint === poolMintA ? amountBWhole : amountAWhole;
                }
              }
            }
          }
        } else if (dex.includes('orca')) {
          const pools = peekOrcaPools();
          const pool = (pools.clmm || []).find((p: any) => String(p?.id || '') === poolId);
          if (pool) {
            tvlUsd = Number((pool as any).tvl_usd) || undefined;
            activeLiquidity = Number((pool as any).liquidity_display || (pool as any).liquidity) || undefined;
            reserveInUsd = tvlUsd || activeLiquidity || reserveInUsd;
            reserveOutUsd = reserveInUsd;
            tickSpacing = Number((pool as any).tick_spacing) || undefined;
            
            // Extract vault balances for capacity estimation
            const poolMintA = String((pool as any)?.mint_a || '');
            const poolMintB = String((pool as any)?.mint_b || '');
            const amountAWhole = Number((pool as any)?.amount_a_whole || 0);
            const amountBWhole = Number((pool as any)?.amount_b_whole || 0);
            
            if (amountAWhole > 0 || amountBWhole > 0) {
              const outputIsA = outputMint === poolMintA;
              const outputIsB = outputMint === poolMintB;
              
              if (getPriceByMint) {
                const priceA = Number(getPriceByMint(poolMintA)?.usdc ?? 0);
                const priceB = Number(getPriceByMint(poolMintB)?.usdc ?? 0);
                
                if (outputIsA && priceA > 0) {
                  outputVaultUsd = amountAWhole * priceA;
                  inputVaultUsd = priceB > 0 ? amountBWhole * priceB : amountBWhole;
                } else if (outputIsB && priceB > 0) {
                  outputVaultUsd = amountBWhole * priceB;
                  inputVaultUsd = priceA > 0 ? amountAWhole * priceA : amountAWhole;
                }
              } else {
                outputVaultUsd = outputMint === poolMintA ? amountAWhole : amountBWhole;
                inputVaultUsd = outputMint === poolMintA ? amountBWhole : amountAWhole;
              }
            }
          }
        } else if (dex.includes('meteora') && !dex.includes('balanced')) {
          // Meteora DLMM
          const pools = peekMeteoraPools();
          const pool = (pools.clmm || []).find((p: any) => String(p?.id || '') === poolId);
          if (pool) {
            tvlUsd = Number((pool as any).tvl_usd) || undefined;
            activeLiquidity = Number((pool as any).liquidity_display || (pool as any).liquidity) || undefined;
            reserveInUsd = tvlUsd || activeLiquidity || Number((pool as any).liquidity_raw) || reserveInUsd;
            reserveOutUsd = reserveInUsd;
            binStep = Number((pool as any).bin_step) || 10;
            activeBinLiquidity = reserveInUsd * 0.1; // Estimate 10% in active bin
            
            // Extract vault balances for capacity estimation
            const poolMintA = String((pool as any)?.mint_a || '');
            const poolMintB = String((pool as any)?.mint_b || '');
            const amountAWhole = Number((pool as any)?.amount_a_whole || 0);
            const amountBWhole = Number((pool as any)?.amount_b_whole || 0);
            
            if (amountAWhole > 0 || amountBWhole > 0) {
              const outputIsA = outputMint === poolMintA;
              const outputIsB = outputMint === poolMintB;
              
              if (getPriceByMint) {
                const priceA = Number(getPriceByMint(poolMintA)?.usdc ?? 0);
                const priceB = Number(getPriceByMint(poolMintB)?.usdc ?? 0);
                
                if (outputIsA && priceA > 0) {
                  outputVaultUsd = amountAWhole * priceA;
                  inputVaultUsd = priceB > 0 ? amountBWhole * priceB : amountBWhole;
                } else if (outputIsB && priceB > 0) {
                  outputVaultUsd = amountBWhole * priceB;
                  inputVaultUsd = priceA > 0 ? amountAWhole * priceA : amountAWhole;
                }
              } else {
                outputVaultUsd = outputMint === poolMintA ? amountAWhole : amountBWhole;
                inputVaultUsd = outputMint === poolMintA ? amountBWhole : amountAWhole;
              }
            }
          }
        } else if (dex.includes('pumpswap') || dex.includes('balanced')) {
          // AMM pools (Pumpswap, Meteora Balanced)
          const pools = dex.includes('pumpswap') ? peekPumpswapPools() : peekMeteoraPools();
          const poolList = dex.includes('pumpswap') ? pools.amm : (pools as any).amm;
          const pool = (poolList || []).find((p: any) => String(p?.id || '') === poolId);
          if (pool) {
            tvlUsd = Number((pool as any).tvl_usd) || undefined;
            reserveInUsd = tvlUsd || reserveInUsd;
            reserveOutUsd = reserveInUsd;
          }
        }
      } catch (e) {
        // Ignore pool lookup errors, use defaults
      }
      
      // Calculate CLMM/DLMM capacity if we have vault data
      if (poolType !== 'amm' && outputVaultUsd != null && outputVaultUsd > 0) {
        // Use hop rate to estimate per-hop profit contribution
        const hopProfitBps = hopRates?.[i] 
          ? Math.max(1, (hopRates[i] - 1) * 10000)
          : profitBps || 10; // Use overall profit or conservative default
        
        const estimate = estimateClmmCapacity(
          hopProfitBps,
          poolType === 'dlmm' ? 'dlmm' : 'clmm',
          activeLiquidity || reserveInUsd,
          outputVaultUsd,
          inputVaultUsd || reserveInUsd,
          tvlUsd,
          binStep,
        );
        
        hopCapacityUsd = estimate.capacityUsd;
        capacityLimitingFactor = estimate.limitingFactor;
        capacityWarnings = estimate.warnings;
        vaultImbalanceRatio = estimate.breakdown.vaultImbalanceRatio;
        
        // Log warnings for problematic hops
        if (estimate.warnings.length > 0) {
          logger.info('optimalSizing.clmm.capacity_warning', {
            cat: 'sizing',
            ctx: {
              hopIndex: i,
              poolId: poolId.slice(0, 12) + '...',
              poolType,
              dex,
              capacityUsd: estimate.capacityUsd.toFixed(2),
              limitingFactor: estimate.limitingFactor,
              outputVaultUsd: outputVaultUsd.toFixed(2),
              inputVaultUsd: (inputVaultUsd || 0).toFixed(2),
              vaultImbalance: (estimate.breakdown.vaultImbalanceRatio * 100).toFixed(1) + '%',
              warnings: estimate.warnings,
            }
          });
        }
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
        // Vault constraint fields
        inputMint,
        outputMint,
        outputVaultUsd,
        inputVaultUsd,
        vaultImbalanceRatio,
        hopCapacityUsd,
        capacityLimitingFactor,
        capacityWarnings,
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
 * 
 * For CLMM/DLMM pools, this includes vault capacity estimation based on:
 * - Profit margin (how much slippage can be tolerated)
 * - Active liquidity at current price
 * - Vault balances and imbalance ratio
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
  
  // Get profit margin for capacity estimation
  const profitBps = opp.net_bps ?? opp.profit_bps ?? 0;
  
  const hops = await buildHopSizingInfo(
    opp.path,
    hopPoolIds,
    hopDexes,
    opp.hop_rates,
    opp.hop_fee_bps,
    opp.hop_liquidity_display,
    profitBps  // Pass profit for CLMM/DLMM capacity estimation
  );
  
  // Get rate product
  const rateProduct = opp.rate_product ?? (1 + profitBps / 10000);
  
  return calculateOptimalArbSize(hops, rateProduct, minSizeUsd, maxSizeUsd, method, config);
}

