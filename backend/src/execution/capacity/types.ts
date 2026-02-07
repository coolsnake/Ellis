/**
 * Capacity System Types (Simplified)
 *
 * With arb-rs handling sizing via slippage simulation, this module
 * only needs to export minimal types for pool identification and basic bounds.
 */

// ============================================================================
// Pool Types
// ============================================================================

export type PoolType = 'amm' | 'clmm' | 'dlmm';

// ============================================================================
// Minimal Sizing Bounds
// ============================================================================

/**
 * Simple sizing bounds configuration.
 * Actual sizing is computed by arb-rs; these are just safety limits.
 */
export interface SizingBounds {
  /** Minimum trade size in USD (floor) */
  minSizeUsd: number;
  /** Maximum trade size in USD (ceiling) */
  maxSizeUsd: number;
  /** Whether to cap trade size to wallet balance when not using flashloan */
  respectWalletBalance: boolean;
}

export const DEFAULT_SIZING_BOUNDS: SizingBounds = {
  minSizeUsd: 0.1,
  maxSizeUsd: 500,
  respectWalletBalance: true,
};

// ============================================================================
// Legacy SizingConfig (for backward compatibility during migration)
// ============================================================================

/**
 * @deprecated Use SizingBounds instead. This is kept for migration only.
 */
export interface SizingConfig {
  enabled: boolean;
  minSizeUsd: number;
  maxSizeUsd: number;
  respectWalletBalance: boolean;
  aggressiveness: number;
  maxSlippageBps: number;
  poolTypeAdjustments: {
    amm: number;
    clmm: number;
    dlmm: number;
  };
  useBreakEvenFloor?: boolean;
  multiHopOptimization?: {
    enabled: boolean;
    [key: string]: unknown;
  };
}

/**
 * @deprecated Use DEFAULT_SIZING_BOUNDS instead.
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
  useBreakEvenFloor: false,
};

// ============================================================================
// Utility Functions
// ============================================================================

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
