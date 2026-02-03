/**
 * Capacity System Types
 * 
 * Defines the core types for the event-driven capacity curve computation system.
 * This system pre-computes price impact curves when tick/bin boundaries cross,
 * enabling instant (sub-millisecond) trade size lookups during execution.
 */

// ============================================================================
// Pool Types
// ============================================================================

export type PoolType = 'amm' | 'clmm' | 'dlmm';

export type ConfidenceLevel = 'high' | 'medium' | 'low';

// ============================================================================
// Capacity Curve
// ============================================================================

/**
 * Pre-computed capacity curve for a pool.
 * 
 * The curve maps trade sizes (USD) to output multipliers, where:
 * - 1.0 = no slippage (theoretical)
 * - 0.99 = 1% slippage (100 bps)
 * - 0.95 = 5% slippage (500 bps)
 * 
 * This allows instant lookup of expected slippage at any trade size,
 * and finding the optimal size given a profit margin.
 */
export interface CapacityCurve {
  /** Pool identifier */
  poolId: string;
  
  /** Pool type determines the math model used */
  poolType: PoolType;
  
  /** Timestamp when this curve was computed */
  computedAt: number;
  
  /** 
   * Confidence level of the estimate:
   * - 'high': Computed from validated tick/bin array data
   * - 'medium': Computed from cached liquidity data
   * - 'low': Tier 1 estimate from minimal data (fallback)
   */
  confidence: ConfidenceLevel;
  
  /** 
   * USD size where slippage equals a typical profit margin (~50 bps).
   * Trades above this size are likely to be unprofitable.
   */
  breakEvenSizeUsd: number;
  
  /** 
   * Liquidity deployed in the active tick/bin (USD).
   * For AMM: total reserve value
   * For CLMM: virtual reserve at current tick
   * For DLMM: liquidity in active bin
   */
  activeLiquidityUsd: number;
  
  /** 
   * Pre-computed output multipliers at standard USD sizes.
   * Keys are trade sizes, values are output multipliers (0-1).
   * Interpolate between points for intermediate sizes.
   */
  curve: Map<number, number>;
  
  /**
   * Additional metadata for debugging and logging
   */
  metadata?: {
    /** Tick index when computed (CLMM) */
    tickIndex?: number;
    /** Active bin ID when computed (DLMM) */
    activeBinId?: number;
    /** Tick spacing (CLMM) */
    tickSpacing?: number;
    /** Bin step (DLMM) */
    binStep?: number;
    /** Fee in basis points */
    feeBps?: number;
    /** Adjustment factor applied */
    adjustment?: number;
    /** Break-even slippage target used for computation (bps) */
    breakEvenTargetBps?: number;
    /** Liquidity decay factor per tick/bin crossing (CLMM/DLMM) */
    liquidityDecay?: number;
    /** Fraction of TVL in active bin (DLMM) */
    activeBinFraction?: number;
    /** Reserve ratio (reserveIn / reserveOut) for AMM pools */
    reserveRatio?: number;
    /** Whether pool reserves are significantly imbalanced (AMM) */
    isImbalanced?: boolean;
    /** Learned calibration data (if applied) */
    calibration?: {
      scaleFactor: number;
      confidence: number;
      observationCount: number;
      avgSlippageError: number;
      /** Whether this calibration is from pool-type aggregate fallback */
      isFallback?: boolean;
    };
  };
}

// ============================================================================
// Sizing Configuration
// ============================================================================

/**
 * User-facing sizing configuration.
 * 
 * Replaces the old complex config with:
 * - 11+ parameters including magic multipliers
 * - 3 different sizing methods
 * - Iteration settings
 * 
 * New design:
 * - 6 core parameters with intuitive meanings
 * - Single unified method (capacity-based)
 * - Optional per-pool-type adjustments
 */
export interface SizingConfig {
  /** Master toggle for dynamic sizing */
  enabled: boolean;
  
  /** Minimum trade size in USD (floor) */
  minSizeUsd: number;
  
  /** Maximum trade size in USD (ceiling) */
  maxSizeUsd: number;
  
  /** Whether to cap trade size to wallet balance when not using flashloan */
  respectWalletBalance: boolean;
  
  /** 
   * Fraction of break-even capacity to use (0.5 to 0.95).
   * - 0.50 = Very conservative (use 50% of capacity)
   * - 0.70 = Balanced (default)
   * - 0.95 = Aggressive (use 95% of capacity)
   */
  aggressiveness: number;
  
  /** 
   * Maximum acceptable slippage in basis points.
   * Trade sizes will be capped where slippage would exceed this.
   */
  maxSlippageBps: number;
  
  /**
   * Per-pool-type capacity adjustment multipliers.
   * - 0.75 = Cautious (-25% capacity)
   * - 1.0  = Default
   * - 1.25 = Aggressive (+25% capacity)
   */
  poolTypeAdjustments: {
    amm: number;
    clmm: number;
    dlmm: number;
  };
  
  /**
   * Whether to use break-even capacity as a floor for sizing.
   * - true = Use break-even as starting point (traditional behavior)
   * - false = Don't limit based on break-even; let on-chain profit check validate
   * Default: false (disabled - on-chain router validates profitability)
   */
  useBreakEvenFloor?: boolean;
  
  /**
   * Multi-hop profit optimization settings.
   * When enabled, simulates trades through all hops to find the size
   * that maximizes expected profit, rather than using single-pool bottleneck.
   */
  multiHopOptimization?: MultiHopOptimizationConfig;
}

// ============================================================================
// Multi-Hop Optimization Configuration
// ============================================================================

/**
 * Slippage model parameters for each pool type.
 * These control how slippage is estimated during multi-hop simulation.
 */
export interface SlippageModelParams {
  /** AMM (constant product) parameters */
  amm: {
    /** 
     * Effective reserve multiplier (accounts for hidden depth).
     * 0.95 = assume 95% of reported reserve is available.
     */
    reserveMultiplier: number;
  };
  /** CLMM (concentrated liquidity) parameters */
  clmm: {
    /** 
     * Liquidity decay factor per tick crossing (0-1).
     * 0.70 = each subsequent tick has 70% of previous tick's liquidity.
     */
    liquidityDecayPerTick: number;
    /** Max ticks to simulate before using extrapolation */
    maxTickSimulation: number;
  };
  /** DLMM (discrete liquidity bins) parameters */
  dlmm: {
    /** 
     * Fraction of TVL assumed in active bin (0-1).
     * 0.10 = 10% of pool TVL is in the active bin.
     */
    activeBinFraction: number;
    /** Liquidity decay factor per bin crossing (0-1) */
    liquidityDecayPerBin: number;
  };
}

/**
 * Configuration for multi-hop profit optimization.
 */
export interface MultiHopOptimizationConfig {
  /** Enable multi-hop profit optimization */
  enabled: boolean;
  
  /** 
   * Optimization method:
   * - 'ternary_search': Finds maximum of unimodal profit function (recommended)
   * - 'binary_search': Alternative search method
   */
  method: 'ternary_search' | 'binary_search';
  
  /** 
   * Fixed costs to subtract from profit (USD).
   * Includes: Jito tip estimate, transaction fee, priority fee.
   * Default: 0.001 (roughly 10k lamports at $150 SOL)
   */
  fixedCostUsd: number;
  
  /**
   * Safety margin multiplier (0.5-1.0).
   * Applied to computed optimal size to account for model uncertainty.
   * 0.8 = use 80% of computed optimal (default)
   */
  safetyMargin: number;
  
  /**
   * Search precision (USD).
   * Stop optimization when search interval < this value.
   * Default: 0.10
   */
  searchPrecisionUsd: number;
  
  /**
   * Maximum iterations for optimization search.
   * Default: 20 (sufficient for log3(maxSize/minSize) precision)
   */
  maxIterations: number;
  
  /**
   * Fallback to single-pool bottleneck method when:
   * - Missing reserve data for any hop
   * - Forward simulation fails
   * Default: true
   */
  fallbackToBottleneck: boolean;
  
  /**
   * Disable learned calibration from feedback (6007 errors, etc.).
   * 
   * When true:
   * - Multi-hop sizing uses only its slippage models (no learned adjustments)
   * - Bottleneck fallback ignores calibration scale factors
   * - Simulation feedback is not recorded for calibration
   * 
   * This prevents the downward drift where repeated 6007 errors cause
   * sizes to shrink toward the minimum over time.
   * 
   * Default: true (when multi-hop enabled, trust the models not learned data)
   */
  disableCalibration: boolean;
  
  /**
   * Slippage model parameters for each pool type.
   * Controls how slippage is estimated during multi-hop simulation.
   */
  slippageParams: SlippageModelParams;
}

/**
 * Default sizing configuration
 */
export const DEFAULT_SIZING_CONFIG: SizingConfig = {
  enabled: true,
  minSizeUsd: 0.1,
  maxSizeUsd: 500,
  respectWalletBalance: true,
  aggressiveness: 0.70,
  maxSlippageBps: 500,
  poolTypeAdjustments: {
    amm: 1.0,
    clmm: 1.0,
    dlmm: 1.0,
  },
  useBreakEvenFloor: false, // Let on-chain router validate profitability
};

/**
 * Default slippage model parameters
 */
export const DEFAULT_SLIPPAGE_PARAMS: SlippageModelParams = {
  amm: {
    reserveMultiplier: 0.95,
  },
  clmm: {
    liquidityDecayPerTick: 0.70,
    maxTickSimulation: 50,
  },
  dlmm: {
    activeBinFraction: 0.10,
    liquidityDecayPerBin: 0.75,
  },
};

/**
 * Default multi-hop optimization configuration
 */
export const DEFAULT_MULTIHOP_CONFIG: MultiHopOptimizationConfig = {
  enabled: false, // Disabled by default for backward compatibility
  method: 'ternary_search',
  fixedCostUsd: 0.001,
  safetyMargin: 0.80,
  searchPrecisionUsd: 0.10,
  maxIterations: 20,
  fallbackToBottleneck: true,
  disableCalibration: true, // When multi-hop enabled, trust models not learned data
  slippageParams: DEFAULT_SLIPPAGE_PARAMS,
};

// ============================================================================
// Tier 1 Estimate Result
// ============================================================================

/**
 * Result from a Tier 1 (instant fallback) estimate.
 * Used when no pre-computed curve is available.
 */
export interface Tier1EstimateResult {
  /** Output multiplier (0-1, where 1.0 = no slippage) */
  outputMultiplier: number;
  
  /** Estimated slippage in basis points */
  slippageBps: number;
  
  /** Always 'low' for Tier 1 estimates */
  confidence: 'low';
  
  /** Estimated break-even size in USD */
  breakEvenSizeUsd: number;
  
  /** Additional info for specific pool types */
  details?: {
    /** Number of bins estimated to cross (DLMM) */
    binsEstimated?: number;
    /** Number of ticks estimated to cross (CLMM) */
    ticksEstimated?: number;
  };
}

// ============================================================================
// Optimal Size Result
// ============================================================================

/**
 * Result from optimal size calculation
 */
export interface OptimalSizeResult {
  /** Recommended trade size in USD */
  sizeUsd: number;
  
  /** Expected slippage at this size in basis points */
  expectedSlippageBps: number;
  
  /** Confidence level of the estimate */
  confidence: ConfidenceLevel;
  
  /** Which constraint was binding (if any) */
  constrainedBy?: 'min_size' | 'max_size' | 'wallet_balance' | 'max_slippage' | 'capacity';
  
  /** The capacity curve used (if available) */
  curveUsed?: CapacityCurve;
}

// ============================================================================
// Standard Curve Points
// ============================================================================

/**
 * Standard USD sizes at which to pre-compute curve points.
 * These provide good coverage for typical arbitrage trade sizes.
 */
export const STANDARD_CURVE_POINTS = [
  1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000
];

/**
 * Default break-even slippage target in basis points.
 * This is the slippage at which profit margin is consumed.
 * In practice, this should be overridden by actual profitBps from opportunities.
 */
export const DEFAULT_BREAK_EVEN_SLIPPAGE_BPS = 50;

/**
 * Confidence-based safety factors for sizing.
 * When confidence is lower, we scale down trade sizes to reduce risk.
 */
export const CONFIDENCE_SAFETY_FACTORS = {
  high: 1.0,    // Full capacity for high-confidence estimates
  medium: 0.75, // 75% capacity for medium-confidence (CLMM/DLMM estimates)
  low: 0.5,     // 50% capacity for low-confidence (Tier 1 fallbacks)
} as const;

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Convert a UI adjustment selection to a numeric multiplier
 */
export function adjustmentToMultiplier(adj: 'default' | 'cautious' | 'aggressive'): number {
  switch (adj) {
    case 'cautious': return 0.75;
    case 'aggressive': return 1.25;
    default: return 1.0;
  }
}

/**
 * Convert a numeric multiplier to a UI adjustment selection
 */
export function multiplierToAdjustment(mult: number): 'default' | 'cautious' | 'aggressive' {
  if (mult <= 0.8) return 'cautious';
  if (mult >= 1.2) return 'aggressive';
  return 'default';
}

/**
 * Interpolate output multiplier from a curve at a given size
 */
export function interpolateCurve(curve: Map<number, number>, sizeUsd: number): number {
  // Get sorted keys
  const sizes = Array.from(curve.keys()).sort((a, b) => a - b);
  
  if (sizes.length === 0) return 1.0;
  
  // Below minimum
  if (sizeUsd <= sizes[0]) {
    return curve.get(sizes[0]) ?? 1.0;
  }
  
  // Above maximum
  if (sizeUsd >= sizes[sizes.length - 1]) {
    return curve.get(sizes[sizes.length - 1]) ?? 0.5;
  }
  
  // Find bracketing points
  let lower = sizes[0];
  let upper = sizes[sizes.length - 1];
  
  for (let i = 0; i < sizes.length - 1; i++) {
    if (sizes[i] <= sizeUsd && sizes[i + 1] >= sizeUsd) {
      lower = sizes[i];
      upper = sizes[i + 1];
      break;
    }
  }
  
  // Linear interpolation
  const lowerMult = curve.get(lower) ?? 1.0;
  const upperMult = curve.get(upper) ?? 0.5;
  
  if (upper === lower) return lowerMult;
  
  const t = (sizeUsd - lower) / (upper - lower);
  return lowerMult + t * (upperMult - lowerMult);
}

/**
 * Find the size where slippage equals a target (inverse lookup)
 */
export function findSizeAtSlippage(curve: Map<number, number>, targetSlippageBps: number): number {
  const targetMultiplier = 1 - targetSlippageBps / 10000;
  
  const sizes = Array.from(curve.keys()).sort((a, b) => a - b);
  
  if (sizes.length === 0) return 0;
  
  // Find where multiplier crosses target
  for (let i = 0; i < sizes.length - 1; i++) {
    const mult1 = curve.get(sizes[i]) ?? 1.0;
    const mult2 = curve.get(sizes[i + 1]) ?? 0.5;
    
    if (mult1 >= targetMultiplier && mult2 <= targetMultiplier) {
      // Interpolate
      if (mult1 === mult2) return sizes[i];
      const t = (mult1 - targetMultiplier) / (mult1 - mult2);
      return sizes[i] + t * (sizes[i + 1] - sizes[i]);
    }
  }
  
  // Target not found in range - return max if we never hit target slippage
  const lastMult = curve.get(sizes[sizes.length - 1]) ?? 0.5;
  if (lastMult >= targetMultiplier) {
    return sizes[sizes.length - 1];
  }
  
  return sizes[0]; // Very high slippage even at minimum
}

/**
 * Determine pool type from dex string
 */
export function getPoolTypeFromDex(dex: string, variant?: string): PoolType {
  const dexLower = (dex || '').toLowerCase();
  const variantLower = (variant || '').toLowerCase();
  
  // CLMM pools
  if (dexLower.includes('clmm') || dexLower === 'orca' || variantLower === 'clmm') {
    return 'clmm';
  }
  
  // DLMM pools (Meteora non-balanced)
  if (dexLower.includes('dlmm') || (dexLower === 'meteora' && !dexLower.includes('balanced'))) {
    return 'dlmm';
  }
  
  // Everything else is AMM
  return 'amm';
}
