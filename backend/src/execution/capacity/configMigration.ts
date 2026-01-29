/**
 * Config Migration Utilities
 * 
 * Ensures sizingConfig exists in executor config.
 * For backward compatibility, migrates old dynamicSizing configs if found.
 */

import type { SizingConfig } from './types.js';
import { DEFAULT_SIZING_CONFIG } from './types.js';

// ============================================================================
// Legacy Config Types
// ============================================================================

interface LegacyDynamicSizingConfig {
  enabled: boolean;
  minSizeUsd: number;
  maxSizeUsd: number;
  method: 'heuristic' | 'optimal_analytical' | 'optimal_iterative';
  bottleneckFraction: number;
  profitScaling: boolean;
  optimalSettings?: {
    ammSlippageMultiplier: number;
    clmmSlippageMultiplier: number;
    dlmmSlippageMultiplier: number;
    iterativeMaxIterations: number;
    iterativeTolerance: number;
    safetyFactor: number;
  };
}

interface LegacyExecutorConfig {
  dynamicSizing?: LegacyDynamicSizingConfig;
  sizingConfig?: SizingConfig;
  // ... other fields
  [key: string]: any;
}

// ============================================================================
// Migration Functions
// ============================================================================

/**
 * Migrate old dynamicSizing config to new sizingConfig format.
 * 
 * Mapping:
 * - dynamicSizing.enabled -> sizingConfig.enabled
 * - dynamicSizing.minSizeUsd -> sizingConfig.minSizeUsd
 * - dynamicSizing.maxSizeUsd -> sizingConfig.maxSizeUsd
 * - dynamicSizing.optimalSettings.safetyFactor -> sizingConfig.aggressiveness
 * - Slippage multipliers -> poolTypeAdjustments
 * 
 * The new system always uses capacity-based sizing (no method selection).
 */
export function migrateFromDynamicSizing(legacy: LegacyDynamicSizingConfig): SizingConfig {
  const optSettings = legacy.optimalSettings;
  
  // Convert safety factor to aggressiveness
  // safetyFactor was 0.5-1.0, aggressiveness is 0.5-0.95
  const aggressiveness = Math.min(0.95, optSettings?.safetyFactor ?? 0.70);
  
  // Convert slippage multipliers to pool type adjustments
  // Old multipliers: 1.0 = standard, 2.0+ = more conservative
  // New adjustments: 0.75 = cautious, 1.0 = default, 1.25 = aggressive
  const ammMultiplier = optSettings?.ammSlippageMultiplier ?? 2.0;
  const clmmMultiplier = optSettings?.clmmSlippageMultiplier ?? 3.0;
  const dlmmMultiplier = optSettings?.dlmmSlippageMultiplier ?? 1.3;
  
  // Higher old multiplier = more conservative = lower new adjustment
  // 1.0-1.5 old -> 1.25 new (aggressive)
  // 1.5-2.5 old -> 1.0 new (default)
  // 2.5+ old -> 0.75 new (cautious)
  function multiplierToAdjustment(mult: number): number {
    if (mult <= 1.5) return 1.25;
    if (mult >= 2.5) return 0.75;
    return 1.0;
  }
  
  return {
    enabled: legacy.enabled,
    minSizeUsd: legacy.minSizeUsd || DEFAULT_SIZING_CONFIG.minSizeUsd,
    maxSizeUsd: legacy.maxSizeUsd || DEFAULT_SIZING_CONFIG.maxSizeUsd,
    respectWalletBalance: true, // New feature, default to safe behavior
    aggressiveness,
    maxSlippageBps: 500, // Reasonable default
    poolTypeAdjustments: {
      amm: multiplierToAdjustment(ammMultiplier),
      clmm: multiplierToAdjustment(clmmMultiplier),
      dlmm: multiplierToAdjustment(dlmmMultiplier),
    },
  };
}

/**
 * Migrate executor config to ensure it has the new sizingConfig.
 * 
 * If sizingConfig is already present, returns config unchanged.
 * If only dynamicSizing is present, migrates it to sizingConfig.
 * If neither is present, adds default sizingConfig.
 */
export function migrateExecutorConfig<T extends LegacyExecutorConfig>(config: T): T & { sizingConfig: SizingConfig } {
  // If sizingConfig already exists, return as-is
  if (config.sizingConfig) {
    return config as T & { sizingConfig: SizingConfig };
  }
  
  // If dynamicSizing exists, migrate it
  if (config.dynamicSizing) {
    const sizingConfig = migrateFromDynamicSizing(config.dynamicSizing);
    return {
      ...config,
      sizingConfig,
    };
  }
  
  // Neither exists, use defaults
  return {
    ...config,
    sizingConfig: { ...DEFAULT_SIZING_CONFIG },
  };
}

/**
 * Check if config needs migration
 */
export function needsMigration(config: LegacyExecutorConfig): boolean {
  return !config.sizingConfig && !!config.dynamicSizing;
}

/**
 * Validate sizingConfig and fill in missing fields with defaults
 */
export function validateSizingConfig(config: Partial<SizingConfig>): SizingConfig {
  return {
    enabled: config.enabled ?? DEFAULT_SIZING_CONFIG.enabled,
    minSizeUsd: config.minSizeUsd ?? DEFAULT_SIZING_CONFIG.minSizeUsd,
    maxSizeUsd: config.maxSizeUsd ?? DEFAULT_SIZING_CONFIG.maxSizeUsd,
    respectWalletBalance: config.respectWalletBalance ?? DEFAULT_SIZING_CONFIG.respectWalletBalance,
    aggressiveness: Math.max(0.5, Math.min(0.95, config.aggressiveness ?? DEFAULT_SIZING_CONFIG.aggressiveness)),
    maxSlippageBps: config.maxSlippageBps ?? DEFAULT_SIZING_CONFIG.maxSlippageBps,
    poolTypeAdjustments: {
      amm: config.poolTypeAdjustments?.amm ?? DEFAULT_SIZING_CONFIG.poolTypeAdjustments.amm,
      clmm: config.poolTypeAdjustments?.clmm ?? DEFAULT_SIZING_CONFIG.poolTypeAdjustments.clmm,
      dlmm: config.poolTypeAdjustments?.dlmm ?? DEFAULT_SIZING_CONFIG.poolTypeAdjustments.dlmm,
    },
  };
}

/**
 * Convert UI adjustment string to numeric multiplier
 */
export function uiAdjustmentToMultiplier(adj: 'default' | 'cautious' | 'aggressive' | string): number {
  switch (adj) {
    case 'cautious': return 0.75;
    case 'aggressive': return 1.25;
    default: return 1.0;
  }
}

/**
 * Convert numeric multiplier to UI adjustment string
 */
export function multiplierToUiAdjustment(mult: number): 'default' | 'cautious' | 'aggressive' {
  if (mult <= 0.8) return 'cautious';
  if (mult >= 1.2) return 'aggressive';
  return 'default';
}
