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
            logger.warn('pools.crossdex.price.mismatch', {
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

