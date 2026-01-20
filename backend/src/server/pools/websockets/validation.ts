/**
 * Pool validation utilities
 *
 * Validates decoded pools and tracks validation statistics
 */

import { logger } from '../../../utils/logger.js';
import { CONFIG } from '../../../utils/config.js';
import type { DexSource, ValidationResult, ValidationStats } from './types.js';
import { logCatchError } from '../../../utils/errorHandler.js';

// Price validation bounds - aligned with graph.edges.ts clamp values
// These are configurable via CONFIG.sanity.priceClampMin/Max
const getPriceClampMin = (): number => {
  const val = Number(((CONFIG as any)?.sanity as any)?.priceClampMin);
  return Number.isFinite(val) && val > 0 ? val : 1e-12;
};
const getPriceClampMax = (): number => {
  const val = Number(((CONFIG as any)?.sanity as any)?.priceClampMax);
  return Number.isFinite(val) && val > 0 ? val : 1e12;
};

/**
 * Validation statistics per DEX
 */
const wsValidationStats: Record<DexSource, ValidationStats> = {
  raydium: { missingMints: 0, invalidPrice: 0, invalidLiquidity: 0, invalidFee: 0, invalidTick: 0, emptyMints: 0 },
  'raydium-cpmm': { missingMints: 0, invalidPrice: 0, invalidLiquidity: 0, invalidFee: 0, invalidTick: 0, emptyMints: 0 },
  orca: { missingMints: 0, invalidPrice: 0, invalidLiquidity: 0, invalidFee: 0, invalidTick: 0, emptyMints: 0 },
  meteora_dlmm: { missingMints: 0, invalidPrice: 0, invalidLiquidity: 0, invalidFee: 0, invalidTick: 0, emptyMints: 0 },
  meteora_damm_v1: { missingMints: 0, invalidPrice: 0, invalidLiquidity: 0, invalidFee: 0, invalidTick: 0, emptyMints: 0 },
  meteora_damm_v2: { missingMints: 0, invalidPrice: 0, invalidLiquidity: 0, invalidFee: 0, invalidTick: 0, emptyMints: 0 },
  pumpswap: { missingMints: 0, invalidPrice: 0, invalidLiquidity: 0, invalidFee: 0, invalidTick: 0, emptyMints: 0 },
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
    'raydium-cpmm': { ...wsValidationStats['raydium-cpmm'] },
    orca: { ...wsValidationStats.orca },
    meteora_dlmm: { ...wsValidationStats.meteora_dlmm },
    meteora_damm_v1: { ...wsValidationStats.meteora_damm_v1 },
    meteora_damm_v2: { ...wsValidationStats.meteora_damm_v2 },
    pumpswap: { ...wsValidationStats.pumpswap },
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
    try { wsValidationStats[dex].missingMints += 1; } catch (e) { logCatchError('pools.ws.validation', e); }
  } else if (pool.mint_a.length === 0 || pool.mint_b.length === 0) {
    reasons.push('empty_mints');
    try { wsValidationStats[dex].emptyMints += 1; } catch (e) { logCatchError('pools.ws.validation', e); }
  } else if (pool.mint_a === pool.mint_b) {
    reasons.push('identical_mints');
    try { wsValidationStats[dex].missingMints += 1; } catch (e) { logCatchError('pools.ws.validation', e); }
  }
  
  // Validate price (for pools that should have it)
  if (pool.price_a_per_b != null) {
    if (!Number.isFinite(pool.price_a_per_b) || pool.price_a_per_b <= 0) {
      reasons.push('invalid_price');
      try { wsValidationStats[dex].invalidPrice += 1; } catch (e) { logCatchError('pools.ws.validation', e); }
    }
    // Sanity check: price should be within configurable bounds (default 1e-12 to 1e12)
    // Aligned with graph.edges.ts clamp values to handle micro-cap tokens with extreme prices
    const priceMin = getPriceClampMin();
    const priceMax = getPriceClampMax();
    if (pool.price_a_per_b && (pool.price_a_per_b < priceMin || pool.price_a_per_b > priceMax)) {
      reasons.push('price_out_of_bounds');
      try { wsValidationStats[dex].invalidPrice += 1; } catch (e) { logCatchError('pools.ws.validation', e); }
    }
  }
  
  // Validate liquidity (different fields for AMM vs CLMM)
  const liq = pool.liquidity ?? pool.liquidity_base;
  if (liq != null) {
    if (!Number.isFinite(liq) || liq < 0) {
      reasons.push('invalid_liquidity');
      try { wsValidationStats[dex].invalidLiquidity += 1; } catch (e) { logCatchError('pools.ws.validation', e); }
    }
  }
  
  // Validate fee
  if (pool.fee_bps != null) {
    if (!Number.isFinite(pool.fee_bps) || pool.fee_bps < 0 || pool.fee_bps > 10000) {
      reasons.push('invalid_fee');
      try { wsValidationStats[dex].invalidFee += 1; } catch (e) { logCatchError('pools.ws.validation', e); }
    }
    // Warn about zero fees for Raydium/Meteora (these DEXes store fees elsewhere)
    // Don't fail validation, just log a warning for monitoring
    if (pool.fee_bps === 0 && (dex === 'raydium' || dex === 'meteora_dlmm')) {
      try {
        logger.warn(`${dex}.ws.zero_fee_warning`, {
          poolId: poolId.slice(0, 8) + '…',
          fee_bps: pool.fee_bps,
          hint: dex === 'raydium' ? 'Fee may be in ammConfig account' : 'Fee may be in parameters structure',
          cat: 'pools'
        });
      } catch (e) { logCatchError('pools.ws.validation', e); }
    }
  } else {
    // Fee is missing entirely
    if (dex === 'raydium' || dex === 'meteora_dlmm') {
      try {
        logger.debug(`${dex}.ws.missing_fee`, {
          poolId: poolId.slice(0, 8) + '…',
          cat: 'pools'
        });
      } catch (e) { logCatchError('pools.ws.validation', e); }
    }
  }
  
  // Validate tick spacing for CLMM
  if (pool.tick_spacing != null) {
    if (!Number.isFinite(pool.tick_spacing) || pool.tick_spacing <= 0) {
      reasons.push('invalid_tick_spacing');
      try { wsValidationStats[dex].invalidTick += 1; } catch (e) { logCatchError('pools.ws.validation', e); }
    }
  }
  
  // Validate sqrt_price_x64 for CLMM (except Meteora DLMM which uses bin-based pricing)
  // Meteora DLMM doesn't store sqrt_price_x64; it calculates price from activeId/binStep
  if (pool.sqrt_price_x64 != null && dex !== 'meteora_dlmm') {
    if (!Number.isFinite(pool.sqrt_price_x64) || pool.sqrt_price_x64 <= 0) {
      reasons.push('invalid_sqrt_price');
      try { wsValidationStats[dex].invalidPrice += 1; } catch (e) { logCatchError('pools.ws.validation', e); }
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
    } catch (e) { logCatchError('pools.ws.validation', e); }
  }
  
  return { valid, reasons };
}

/**
 * Price delta validation statistics
 */
const priceDeltaStats: Record<DexSource, { warnings: number; maxDelta: number }> = {
  raydium: { warnings: 0, maxDelta: 0 },
  'raydium-cpmm': { warnings: 0, maxDelta: 0 },
  orca: { warnings: 0, maxDelta: 0 },
  meteora_dlmm: { warnings: 0, maxDelta: 0 },
  meteora_damm_v1: { warnings: 0, maxDelta: 0 },
  meteora_damm_v2: { warnings: 0, maxDelta: 0 },
  pumpswap: { warnings: 0, maxDelta: 0 },
};

/**
 * Price delta threshold (50% change triggers warning)
 */
const PRICE_DELTA_WARN_THRESHOLD = 0.5;

/**
 * Validate price delta between updates
 * 
 * Logs a warning if price changes by more than 50% from previous value.
 * Does NOT reject the update - this is diagnostic only.
 * 
 * @param dex DEX source
 * @param poolId Pool ID
 * @param newPrice New price from update
 * @param prevPrice Previous price from cache
 * @returns Object with delta info and whether it was suspicious
 */
export function validatePriceDelta(
  dex: DexSource,
  poolId: string,
  newPrice: number | undefined,
  prevPrice: number | undefined
): { suspicious: boolean; deltaPercent: number | undefined } {
  // Skip if either price is missing or invalid
  if (!Number.isFinite(newPrice) || !Number.isFinite(prevPrice) || prevPrice === 0 || newPrice === 0) {
    return { suspicious: false, deltaPercent: undefined };
  }

  const deltaPercent = Math.abs(newPrice! - prevPrice!) / prevPrice!;
  const suspicious = deltaPercent > PRICE_DELTA_WARN_THRESHOLD;

  if (suspicious) {
    try {
      priceDeltaStats[dex].warnings += 1;
      if (deltaPercent > priceDeltaStats[dex].maxDelta) {
        priceDeltaStats[dex].maxDelta = deltaPercent;
      }

      // Warn level for large price changes (>50% delta)
      logger.warn('ws.update.large_price_change', {
        poolId: poolId.slice(0, 8) + '…',
        dex,
        prevPrice,
        newPrice,
        deltaPercent: (deltaPercent * 100).toFixed(2) + '%',
        threshold: (PRICE_DELTA_WARN_THRESHOLD * 100) + '%',
        totalWarnings: priceDeltaStats[dex].warnings,
        cat: 'pools'
      });
    } catch (e) { logCatchError('pools.ws.validation', e); }
  }

  return { suspicious, deltaPercent };
}

/**
 * Get price delta statistics for a DEX
 */
export function getPriceDeltaStats(dex: DexSource): { warnings: number; maxDelta: number } {
  return { ...priceDeltaStats[dex] };
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
  } catch (e) { logCatchError('pools.ws.validation', e); }
}

