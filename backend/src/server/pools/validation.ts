import { logger } from '../../utils/logger.js';
import type { AmmPool, ClmmPool, PoolsPayload } from './types.js';

/**
 * Cross-DEX validation: Compare prices for pools with the same mint pair across different DEXes.
 * Logs discrepancies that exceed the threshold to help identify normalization issues.
 */
export function validateCrossDexPrices(
  poolsByDex: Record<string, PoolsPayload>,
  maxDeviation = 0.05 // 5% deviation threshold
): void {
  try {
    // Build map of (mint_a, mint_b) -> pools from all DEXes
    const poolsByPair = new Map<string, Array<{ dex: string; pool: AmmPool | ClmmPool; price: number }>>();
    
    for (const [dex, payload] of Object.entries(poolsByDex)) {
      for (const pool of [...(payload.amm || []), ...(payload.clmm || [])]) {
        const price = (pool as any).price_a_per_b;
        if (!price || !(price > 0)) continue;
        
        // Normalize pair key: always use lexicographically smaller mint first
        const a = String(pool.mint_a);
        const b = String(pool.mint_b);
        const key = a <= b ? `${a}:${b}` : `${b}:${a}`;
        
        // Adjust price if pair was swapped
        const adjustedPrice = a <= b ? price : (1 / price);
        
        if (!poolsByPair.has(key)) {
          poolsByPair.set(key, []);
        }
        poolsByPair.get(key)!.push({ dex, pool, price: adjustedPrice });
      }
    }
    
    // Check pairs that appear in multiple DEXes
    for (const [pairKey, pools] of poolsByPair.entries()) {
      if (pools.length < 2) continue; // Need at least 2 pools from different DEXes
      
      const dexes = new Set(pools.map(p => p.dex));
      if (dexes.size < 2) continue; // Need different DEXes
      
      // Calculate median price as reference
      const prices = pools.map(p => p.price).sort((a, b) => a - b);
      const median = prices.length % 2 === 0
        ? (prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2
        : prices[Math.floor(prices.length / 2)];
      
      // Check deviations
      for (const { dex, pool, price } of pools) {
        const deviation = Math.max(price / median, median / price) - 1;
        if (deviation > maxDeviation) {
          try {
            logger.debug('pools.crossdex.price.mismatch', {
              pair: pairKey,
              dex,
              pool_id: (pool as any).id,
              price,
              median,
              deviation: deviation * 100,
              other_dexes: pools.filter(p => p.dex !== dex).map(p => ({ dex: p.dex, price: p.price })),
              cat: 'pools.validation'
            });
          } catch {}
        }
      }
    }
  } catch (e: any) {
    try {
      logger.warn('pools.crossdex.validation.failed', { error: String(e?.message || e), cat: 'pools.validation' });
    } catch {}
  }
}

/**
 * Filter out pools with anomalous prices that deviate significantly from cross-DEX consensus.
 * This prevents decimal/orientation bugs from contaminating the graph.
 */
export function filterAnomalousPrices(
  poolsByDex: Record<string, PoolsPayload>,
  maxDeviation = 0.10 // 10% deviation threshold (configurable)
): Record<string, PoolsPayload> {
  try {
    // Build map of (mint_a, mint_b) -> pools from all DEXes
    const poolsByPair = new Map<string, Array<{ dex: string; pool: AmmPool | ClmmPool; price: number }>>();
    
    for (const [dex, payload] of Object.entries(poolsByDex)) {
      for (const pool of [...(payload.amm || []), ...(payload.clmm || [])]) {
        const price = (pool as any).price_a_per_b;
        if (!price || !(price > 0)) continue;
        
        const a = String(pool.mint_a);
        const b = String(pool.mint_b);
        const key = a <= b ? `${a}:${b}` : `${b}:${a}`;
        const adjustedPrice = a <= b ? price : (1 / price);
        
        if (!poolsByPair.has(key)) {
          poolsByPair.set(key, []);
        }
        poolsByPair.get(key)!.push({ dex, pool, price: adjustedPrice });
      }
    }
    
    // Build set of pool IDs to exclude
    const excludePoolIds = new Set<string>();
    let totalExcluded = 0;
    const exclusionsByDex = new Map<string, number>();
    const anomalyDetails: any[] = []; // Collect detailed anomaly info
    
    for (const [pairKey, pools] of poolsByPair.entries()) {
      if (pools.length < 2) continue;
      
      const dexes = new Set(pools.map(p => p.dex));
      if (dexes.size < 2) continue;
      
      // Calculate median price as reference
      const prices = pools.map(p => p.price).sort((a, b) => a - b);
      const median = prices.length % 2 === 0
        ? (prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2
        : prices[Math.floor(prices.length / 2)];
      
      // Mark pools that deviate significantly
      for (const { dex, pool, price } of pools) {
        const deviation = Math.max(price / median, median / price) - 1;
        if (deviation > maxDeviation) {
          const poolId = (pool as any).id;
          excludePoolIds.add(poolId);
          totalExcluded++;
          exclusionsByDex.set(dex, (exclusionsByDex.get(dex) || 0) + 1);
          
          // Calculate likely root cause indicators
          const priceRatio = price / median;
          const isPowerOf10 = Math.abs(Math.log10(priceRatio) % 1) < 0.1 || Math.abs(Math.log10(priceRatio) % 1) > 0.9;
          const magnitudeError = Math.round(Math.log10(priceRatio));
          
          // Detect common decimal error patterns
          let likelyRootCause = 'unknown';
          if (Math.abs(magnitudeError) === 2) {
            likelyRootCause = 'decimal_swap_2_places';
          } else if (Math.abs(magnitudeError) === 3) {
            likelyRootCause = 'decimal_swap_3_places';
          } else if (Math.abs(magnitudeError) === 5) {
            likelyRootCause = 'decimal_swap_5_places';
          } else if (isPowerOf10) {
            likelyRootCause = `power_of_10_error_${magnitudeError}x`;
          } else if (priceRatio < 0.5 || priceRatio > 2) {
            likelyRootCause = 'orientation_or_formula_error';
          } else {
            likelyRootCause = 'minor_deviation_or_stale_data';
          }
          
          const anomaly = {
            pair: pairKey,
            dex,
            pool_id: poolId,
            pool_type: (pool as any).pool_kind || 'unknown',
            price,
            median,
            deviation_pct: deviation * 100,
            price_ratio: priceRatio,
            magnitude_error: magnitudeError,
            likely_root_cause: likelyRootCause,
            threshold_pct: maxDeviation * 100,
            decimals_a: (pool as any).decimals_a,
            decimals_b: (pool as any).decimals_b,
            mint_a: pool.mint_a?.slice(0, 8) + '...',
            mint_b: pool.mint_b?.slice(0, 8) + '...',
            other_dexes: pools
              .filter(p => p.dex !== dex)
              .map(p => ({ 
                dex: p.dex, 
                price: p.price,
                decimals_a: (p.pool as any).decimals_a,
                decimals_b: (p.pool as any).decimals_b,
              })),
          };
          
          anomalyDetails.push(anomaly);
          
          try {
            logger.warn('pools.crossdex.price.anomaly.excluded', {
              ...anomaly,
              cat: 'pools.validation'
            });
          } catch {}
        }
      }
    }
    
    // Filter out anomalous pools
    const filtered: Record<string, PoolsPayload> = {};
    for (const [dex, payload] of Object.entries(poolsByDex)) {
      const filterFn = (pool: AmmPool | ClmmPool) => !excludePoolIds.has((pool as any).id);
      filtered[dex] = {
        amm: (payload.amm || []).filter(filterFn),
        clmm: (payload.clmm || []).filter(filterFn)
      };
    }
    
    // Enhanced summary logging with root cause analysis
    if (totalExcluded > 0) {
      // Group by likely root cause
      const byRootCause = new Map<string, number>();
      for (const anomaly of anomalyDetails) {
        const cause = anomaly.likely_root_cause;
        byRootCause.set(cause, (byRootCause.get(cause) || 0) + 1);
      }
      
      // Find the most severe anomalies (top 5)
      const topAnomalies = anomalyDetails
        .sort((a, b) => b.deviation_pct - a.deviation_pct)
        .slice(0, 5)
        .map(a => ({
          dex: a.dex,
          pair: a.pair,
          deviation_pct: Math.round(a.deviation_pct),
          likely_cause: a.likely_root_cause,
          pool_id: a.pool_id.slice(0, 12) + '...',
        }));
      
      try {
        logger.warn('pools.crossdex.price.anomalies.filtered', {
          total_excluded: totalExcluded,
          by_dex: Object.fromEntries(exclusionsByDex.entries()),
          by_root_cause: Object.fromEntries(byRootCause.entries()),
          threshold_pct: maxDeviation * 100,
          top_anomalies: topAnomalies,
          action: 'filtered_from_graph',
          recommendation: 'Check normalizers for DEXes with high exclusion counts',
          cat: 'pools.validation'
        });
      } catch {}
      
      // Additional detailed log for deep analysis (debug level)
      try {
        logger.debug('pools.crossdex.anomalies.full_details', {
          anomalies: anomalyDetails,
          cat: 'pools.validation'
        });
      } catch {}
    }
    
    return filtered;
  } catch (e: any) {
    try {
      logger.warn('pools.crossdex.filter.failed', { error: String(e?.message || e), cat: 'pools.validation' });
    } catch {}
    return poolsByDex; // Return unfiltered on error
  }
}

/**
 * Verify canonicalization application: Ensures price inversion happens correctly when mints are swapped.
 * This checks that swapABFields correctly inverts price_a_per_b.
 */
export function verifyCanonicalization<T extends { mint_a: string; mint_b: string; price_a_per_b?: number }>(
  pools: T[],
  swapABFields: (p: T) => T
): { valid: boolean; errors: Array<{ pool: T; originalPrice: number; swappedPrice: number; expectedPrice: number }> } {
  const errors: Array<{ pool: T; originalPrice: number; swappedPrice: number; expectedPrice: number }> = [];
  
  for (const pool of pools) {
    const price = (pool as any).price_a_per_b;
    if (!price || !(price > 0)) continue;
    
    try {
      const swapped = swapABFields({ ...pool });
      const swappedPrice = (swapped as any).price_a_per_b;
      const expectedPrice = 1 / price;
      
      // Check if price was inverted correctly (allow small floating point errors)
      const tolerance = 1e-9;
      if (!swappedPrice || Math.abs(swappedPrice - expectedPrice) > tolerance) {
        errors.push({
          pool,
          originalPrice: price,
          swappedPrice: swappedPrice || 0,
          expectedPrice
        });
      }
    } catch (e: any) {
      errors.push({
        pool,
        originalPrice: price,
        swappedPrice: 0,
        expectedPrice: 1 / price
      });
    }
  }
  
  return {
    valid: errors.length === 0,
    errors
  };
}

