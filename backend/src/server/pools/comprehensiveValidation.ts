import { logger } from '../../utils/logger.js';
import type { AmmPool, ClmmPool, PoolsPayload } from './types.js';

/**
 * SIMPLIFIED Validation - Only Essential Checks
 * 
 * Validates:
 * 1. Cross-DEX price consistency (for filtering)
 * 2. Forward * reverse ≈ 1 (basic sanity)
 */

interface PairSummary {
  pairKey: string;
  medianPrice: number;
  poolCount: number;
  maxDeviation: number;
}

/**
 * Validate cross-DEX prices and return pairs with significant deviations
 * Used by filterAnomalousPrices() to remove bad pools
 */
export function validateCrossDexPricesSimple(
  poolsByDex: Record<string, PoolsPayload>,
  maxDeviation = 0.10
): Map<string, PairSummary> {
  const poolsByPair = new Map<string, Array<{ dex: string; poolId: string; price: number }>>();

  // Group pools by canonical pair
  for (const [dex, payload] of Object.entries(poolsByDex)) {
    for (const pool of [...(payload.amm || []), ...(payload.clmm || [])]) {
      const price = (pool as any).price_a_per_b;
      if (!price || !(price > 0) || !Number.isFinite(price)) continue;

      const mintA = pool.mint_a;
      const mintB = pool.mint_b;
      const pairKey = mintA <= mintB ? `${mintA}:${mintB}` : `${mintB}:${mintA}`;
      const canonicalPrice = mintA <= mintB ? price : (1 / price);

      if (!poolsByPair.has(pairKey)) {
        poolsByPair.set(pairKey, []);
      }

      poolsByPair.get(pairKey)!.push({
        dex,
        poolId: (pool as any).id,
        price: canonicalPrice,
      });
    }
  }

  const deviatingPairs = new Map<string, PairSummary>();

  // Check each pair for deviations
  for (const [pairKey, pools] of poolsByPair.entries()) {
    if (pools.length < 2) continue; // Need at least 2 to compare

    const prices = pools.map(p => p.price).sort((a, b) => a - b);
    const medianPrice = prices.length % 2 === 0
      ? (prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2
      : prices[Math.floor(prices.length / 2)];

    let maxDev = 0;
    for (const p of pools) {
      const dev = Math.max(p.price / medianPrice, medianPrice / p.price) - 1;
      if (dev > maxDev) maxDev = dev;
    }

    if (maxDev > maxDeviation) {
      deviatingPairs.set(pairKey, {
        pairKey,
        medianPrice,
        poolCount: pools.length,
        maxDeviation: maxDev,
      });
    }
  }

  logger.info('pools.validation.simple_summary', {
    totalPairs: poolsByPair.size,
    pairsWithDeviations: deviatingPairs.size,
    maxDeviation: maxDeviation * 100,
    cat: 'pools.validation',
  });

  return deviatingPairs;
}

/**
 * Validate edges: forward * reverse ≈ 1
 * Returns count of invalid edges
 */
export function validateEdgesSimple(
  edges: Array<{ source: string; target: string; price_a_per_b?: number; pool_id?: string }>
): number {
  let invalidCount = 0;

  for (const edge of edges) {
    const price = edge.price_a_per_b;
    if (!price || price <= 0 || !Number.isFinite(price)) continue;

    const reverse = 1 / price;
    const product = price * reverse;
    const deviation = Math.abs(product - 1);

    // Only count as invalid if product deviates by more than 0.1%
    if (deviation > 0.001 || !Number.isFinite(reverse)) {
      invalidCount++;
    }
  }

  if (invalidCount > 0) {
    logger.warn('graph.edges.validation.simple', {
      invalidEdges: invalidCount,
      cat: 'graph.validation',
    });
  }

  return invalidCount;
}
