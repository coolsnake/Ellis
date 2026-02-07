/**
 * Capacity System - Simplified API
 *
 * With arb-rs handling sizing via slippage simulation, this module
 * only exports minimal utilities for pool type identification.
 *
 * The following have been REMOVED (now handled by arb-rs):
 * - lookupCapacity() - capacity curve lookup
 * - getOptimalSizeFromCurve() - size optimization
 * - computeCapacityCurve() - curve computation
 * - calculateMultiHopOptimalSize() - multi-hop optimization
 * - All slippage models (AMM, CLMM, DLMM)
 * - Calibration store
 * - Curve caching
 */

// Re-export types
export type { PoolType, SizingConfig, SizingBounds } from './types.js';
export { DEFAULT_SIZING_CONFIG, DEFAULT_SIZING_BOUNDS, getPoolTypeFromDex } from './types.js';
