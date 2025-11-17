/**
 * Pool validation utilities
 * 
 * Validates decoded pools and tracks validation statistics
 */

import { logger } from '../../../utils/logger.js';
import type { DexSource, ValidationResult, ValidationStats } from './types.js';

/**
 * Validation statistics per DEX
 */
const wsValidationStats: Record<DexSource, ValidationStats> = {
  raydium: { missingMints: 0, invalidPrice: 0, invalidLiquidity: 0, invalidFee: 0, invalidTick: 0, emptyMints: 0 },
  orca: { missingMints: 0, invalidPrice: 0, invalidLiquidity: 0, invalidFee: 0, invalidTick: 0, emptyMints: 0 },
  meteora: { missingMints: 0, invalidPrice: 0, invalidLiquidity: 0, invalidFee: 0, invalidTick: 0, emptyMints: 0 },
  pumpswap: { missingMints: 0, invalidPrice: 0, invalidLiquidity: 0, invalidFee: 0, invalidTick: 0, emptyMints: 0 },
  meteora_balanced: { missingMints: 0, invalidPrice: 0, invalidLiquidity: 0, invalidFee: 0, invalidTick: 0, emptyMints: 0 },
};

/**
 * Get validation statistics for a DEX
 */
export function getValidationStats(dex: DexSource): ValidationStats {
  return { ...wsValidationStats[dex] };
}

/**
 * Get all validation statistics
 */
export function getAllValidationStats(): Record<DexSource, ValidationStats> {
  return {
    raydium: { ...wsValidationStats.raydium },
    orca: { ...wsValidationStats.orca },
    meteora: { ...wsValidationStats.meteora },
    pumpswap: { ...wsValidationStats.pumpswap },
    meteora_balanced: { ...wsValidationStats.meteora_balanced },
  };
}

/**
 * Validates a decoded pool to ensure all critical fields are present and valid
 * Returns validation result with specific failure reasons for debugging
 */
export function validateDecodedPool(
  dex: DexSource,
  pool: { 
    mint_a?: string; 
    mint_b?: string; 
    price_a_per_b?: number; 
    liquidity?: number; 
    liquidity_base?: number; 
    fee_bps?: number; 
    tick_spacing?: number; 
    sqrt_price_x64?: number 
  },
  poolId: string
): ValidationResult {
  const reasons: string[] = [];
  
  // Validate mints
  if (!pool.mint_a || !pool.mint_b) {
    reasons.push('missing_mints');
    try { wsValidationStats[dex].missingMints += 1; } catch {}
  } else if (pool.mint_a.length === 0 || pool.mint_b.length === 0) {
    reasons.push('empty_mints');
    try { wsValidationStats[dex].emptyMints += 1; } catch {}
  } else if (pool.mint_a === pool.mint_b) {
    reasons.push('identical_mints');
    try { wsValidationStats[dex].missingMints += 1; } catch {}
  }
  
  // Validate price (for pools that should have it)
  if (pool.price_a_per_b != null) {
    if (!Number.isFinite(pool.price_a_per_b) || pool.price_a_per_b <= 0) {
      reasons.push('invalid_price');
      try { wsValidationStats[dex].invalidPrice += 1; } catch {}
    }
    // Sanity check: price should be within reasonable bounds (0.00000001 to 100000000)
    if (pool.price_a_per_b && (pool.price_a_per_b < 1e-8 || pool.price_a_per_b > 1e8)) {
      reasons.push('price_out_of_bounds');
      try { wsValidationStats[dex].invalidPrice += 1; } catch {}
    }
  }
  
  // Validate liquidity (different fields for AMM vs CLMM)
  const liq = pool.liquidity ?? pool.liquidity_base;
  if (liq != null) {
    if (!Number.isFinite(liq) || liq < 0) {
      reasons.push('invalid_liquidity');
      try { wsValidationStats[dex].invalidLiquidity += 1; } catch {}
    }
  }
  
  // Validate fee
  if (pool.fee_bps != null) {
    if (!Number.isFinite(pool.fee_bps) || pool.fee_bps < 0 || pool.fee_bps > 10000) {
      reasons.push('invalid_fee');
      try { wsValidationStats[dex].invalidFee += 1; } catch {}
    }
  }
  
  // Validate tick spacing for CLMM
  if (pool.tick_spacing != null) {
    if (!Number.isFinite(pool.tick_spacing) || pool.tick_spacing <= 0) {
      reasons.push('invalid_tick_spacing');
      try { wsValidationStats[dex].invalidTick += 1; } catch {}
    }
  }
  
  // Validate sqrt_price_x64 for CLMM (except Meteora which uses bin-based pricing)
  // Meteora DLMM doesn't store sqrt_price_x64; it calculates price from activeId/binStep
  if (pool.sqrt_price_x64 != null && dex !== 'meteora') {
    if (!Number.isFinite(pool.sqrt_price_x64) || pool.sqrt_price_x64 <= 0) {
      reasons.push('invalid_sqrt_price');
      try { wsValidationStats[dex].invalidPrice += 1; } catch {}
    }
  }
  
  const valid = reasons.length === 0;
  
  // Log validation failures
  if (!valid && reasons.length > 0) {
    try {
      logger.warn(`${dex}.ws.validation.failed`, {
        poolId: poolId.slice(0, 8) + '…',
        reasons,
        mint_a: pool.mint_a?.slice(0, 8) + '…',
        mint_b: pool.mint_b?.slice(0, 8) + '…',
        price_a_per_b: pool.price_a_per_b,
        liquidity: pool.liquidity,
        liquidity_base: pool.liquidity_base,
        fee_bps: pool.fee_bps,
        tick_spacing: pool.tick_spacing,
        cat: 'pools'
      });
    } catch {}
  }
  
  return { valid, reasons };
}

/**
 * Debug logging helper for targeted pools
 */
export function debugLogTargeted(
  source: DexSource, 
  account: string, 
  extra: Record<string, unknown>
): void {
  try {
    logger.debug(`${source}.ws.targeted`, {
      account: account.slice(0, 8) + '…',
      ...extra,
      cat: 'pools'
    });
  } catch {}
}

