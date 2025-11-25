import type { SlippageConfig, PoolType } from './types.js';
import { logger } from '../../utils/logger.js';

// Default configuration - conservative but reasonable
export const DEFAULT_SLIPPAGE_CONFIG: SlippageConfig = {
  safetyBufferBps: 10,              // 0.1% buffer for execution delay
  enforceMinimumAsFee: true,        // Never allow slippage below pool fee + buffer
  maxSlippageBps: 1000,             // Cap at 10%

  impactMultipliers: {
    amm: 1.0,                       // xy=k formula is exact
    clmm: 1.5,                      // Concentrated liquidity - add 50% uncertainty
    dlmm: 1.3,                      // Bin traversal is fairly predictable
    damm: 1.0,                      // Similar to AMM
  },

  noLiquidityMultiplier: {
    amm: 2.0,                       // Double the fee when no liquidity data
    clmm: 3.0,                      // Triple the fee (more uncertain)
    dlmm: 3.0,                      // Triple the fee
    damm: 2.0,                      // Double the fee
  },
};

let currentConfig: SlippageConfig = { ...DEFAULT_SLIPPAGE_CONFIG };

export function getSlippageConfig(): SlippageConfig {
  return currentConfig;
}

export function updateSlippageConfig(updates: Partial<SlippageConfig>): void {
  currentConfig = {
    ...currentConfig,
    ...updates,
    impactMultipliers: { ...currentConfig.impactMultipliers, ...updates.impactMultipliers },
    noLiquidityMultiplier: { ...currentConfig.noLiquidityMultiplier, ...updates.noLiquidityMultiplier },
  };

  try {
    logger.info('slippage.config.updated', {
      cat: 'tx',
      config: currentConfig,
    });
  } catch {
    // Best effort logging
  }
}

export function resetSlippageConfig(): void {
  currentConfig = { ...DEFAULT_SLIPPAGE_CONFIG };
}

/**
 * Determine pool type from DEX and variant strings
 */
export function getPoolType(dex: string, variant?: string): PoolType {
  const dexLower = (dex || '').toLowerCase();
  const variantLower = (variant || '').toLowerCase();

  // Meteora DAMM (balanced pools)
  if (dexLower === 'meteora_balanced' || variantLower.includes('damm')) {
    return 'damm';
  }

  // Meteora DLMM
  if (dexLower === 'meteora' || variantLower === 'dlmm') {
    return 'dlmm';
  }

  // CLMM pools (Orca Whirlpools, Raydium CLMM)
  if (variantLower === 'clmm' || dexLower === 'orca') {
    return 'clmm';
  }

  // Default to AMM (Raydium AMM, PumpSwap, etc.)
  return 'amm';
}

