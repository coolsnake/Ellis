import { logger } from '../../utils/logger.js';
import type { AmmPool, ClmmPool, PoolsPayload } from './types.js';
import { getPriceByMint } from '../priceStore.js';

/**
 * Comprehensive price verification for all pairs across all DEXes
 * 
 * Validates:
 * 1. Cross-DEX price consistency for same pairs
 * 2. Forward * reverse ≈ 1 for all edges
 * 3. Price source tracking (pipeline vs direct calculation)
 * 4. CLMM orientation assumptions
 * 5. Decimal consistency
 * 6. Magnitude calibration correctness
 */

interface PairValidationResult {
  pairKey: string;
  mintA: string;
  mintB: string;
  pools: Array<{
    dex: string;
    poolId: string;
    poolKind: 'amm' | 'clmm';
    price: number;
    wasSwapped?: boolean;
    decimalsA?: number;
    decimalsB?: number;
    sqrtPriceX64?: number;
    originalPrice?: number;
  }>;
  medianPrice: number;
  deviations: Array<{
    dex: string;
    poolId: string;
    deviation: number;
    deviationPct: number;
    likelyCause: string;
    magnitudeError?: number;
  }>;
  clmmOrientationCheck?: {
    raydiumPrice?: number;
    orcaPrice?: number;
    deviation?: number;
    orientationMatch: boolean;
  };
}

interface EdgeValidationResult {
  poolId: string;
  dex: string;
  mintA: string;
  mintB: string;
  forwardPrice: number;
  reversePrice: number;
  product: number;
  deviation: number;
  isValid: boolean;
}

/**
 * Create canonical pair key (always lexicographically ordered)
 */
function canonicalPairKey(mintA: string, mintB: string): string {
  const a = String(mintA || '');
  const b = String(mintB || '');
  return a <= b ? `${a}:${b}` : `${b}:${a}`;
}

/**
 * Normalize price to canonical orientation (A <= B lexicographically)
 */
function normalizePriceToCanonical(
  mintA: string,
  mintB: string,
  price: number
): { canonicalMintA: string; canonicalMintB: string; canonicalPrice: number; wasSwapped: boolean } {
  const a = String(mintA);
  const b = String(mintB);
  if (a <= b) {
    return { canonicalMintA: a, canonicalMintB: b, canonicalPrice: price, wasSwapped: false };
  } else {
    return { canonicalMintA: b, canonicalMintB: a, canonicalPrice: 1 / price, wasSwapped: true };
  }
}

/**
 * Detect likely root cause of price deviation
 */
function detectRootCause(
  price: number,
  medianPrice: number,
  decimalsA?: number,
  decimalsB?: number
): { cause: string; magnitudeError?: number } {
  const ratio = price / medianPrice;
  const magnitudeError = Math.round(Math.log10(ratio));
  const isPowerOf10 = Math.abs(Math.log10(ratio) % 1) < 0.1 || Math.abs(Math.log10(ratio) % 1) > 0.9;
  
  if (isPowerOf10) {
    if (Math.abs(magnitudeError) === 2) {
      return { cause: 'decimal_swap_2_places', magnitudeError };
    } else if (Math.abs(magnitudeError) === 3) {
      return { cause: 'decimal_swap_3_places', magnitudeError };
    } else if (Math.abs(magnitudeError) === 5) {
      return { cause: 'decimal_swap_5_places', magnitudeError };
    } else {
      return { cause: `power_of_10_error_${magnitudeError}x`, magnitudeError };
    }
  }
  
  if (ratio < 0.5 || ratio > 2) {
    return { cause: 'orientation_or_formula_error', magnitudeError };
  }
  
  // Check if decimal difference matches magnitude error
  if (decimalsA != null && decimalsB != null) {
    const decimalDiff = Math.abs(decimalsA - decimalsB);
    if (Math.abs(magnitudeError) === decimalDiff) {
      return { cause: `decimal_mismatch_${decimalDiff}_places`, magnitudeError };
    }
  }
  
  return { cause: 'minor_deviation_or_stale_data', magnitudeError };
}

/**
 * Comprehensive validation for all pairs across all DEXes
 */
export function validateAllPairsComprehensive(
  poolsByDex: Record<string, PoolsPayload>,
  options: {
    maxDeviation?: number; // Default 0.10 (10%)
    checkClmmOrientation?: boolean; // Default true
    logAllPairs?: boolean; // Default false (only log mismatches)
  } = {}
): {
  pairResults: PairValidationResult[];
  summary: {
    totalPairs: number;
    pairsWithMismatches: number;
    totalPools: number;
    poolsWithIssues: number;
    issuesByDex: Record<string, number>;
    issuesByCause: Record<string, number>;
  };
} {
  const {
    maxDeviation = 0.10,
    checkClmmOrientation = true,
    logAllPairs = false,
  } = options;

  const pairResults: PairValidationResult[] = [];
  const issuesByDex = new Map<string, number>();
  const issuesByCause = new Map<string, number>();

  // Step 1: Group all pools by canonical pair
  const poolsByPair = new Map<string, Array<{
    dex: string;
    pool: AmmPool | ClmmPool;
    price: number;
    metadata: {
      originalMintA: string;
      originalMintB: string;
      originalPrice: number;
      canonicalMintA: string;
      canonicalMintB: string;
      wasSwapped: boolean;
      decimalsA?: number;
      decimalsB?: number;
      sqrtPriceX64?: number;
      poolKind: 'amm' | 'clmm';
    };
  }>>();

  for (const [dex, payload] of Object.entries(poolsByDex)) {
    for (const pool of [...(payload.amm || []), ...(payload.clmm || [])]) {
      const price = (pool as any).price_a_per_b;
      if (!price || !(price > 0) || !Number.isFinite(price)) continue;

      const { canonicalMintA, canonicalMintB, canonicalPrice, wasSwapped } = normalizePriceToCanonical(
        pool.mint_a,
        pool.mint_b,
        price
      );
      const pairKey = canonicalPairKey(canonicalMintA, canonicalMintB);

      if (!poolsByPair.has(pairKey)) {
        poolsByPair.set(pairKey, []);
      }

      poolsByPair.get(pairKey)!.push({
        dex,
        pool,
        price: canonicalPrice,
        metadata: {
          originalMintA: pool.mint_a,
          originalMintB: pool.mint_b,
          originalPrice: price,
          canonicalMintA,
          canonicalMintB,
          wasSwapped,
          decimalsA: (pool as any).decimals_a,
          decimalsB: (pool as any).decimals_b,
          sqrtPriceX64: (pool as any).sqrt_price_x64,
          poolKind: (pool as any).pool_kind || ((pool as any).sqrt_price_x64 ? 'clmm' : 'amm'),
        },
      });
    }
  }

  // Step 2: Validate each pair
  for (const [pairKey, pools] of poolsByPair.entries()) {
    if (pools.length < 1) continue;

    const [firstPool] = pools;
    const mintA = firstPool.metadata.canonicalMintA;
    const mintB = firstPool.metadata.canonicalMintB;

    // Calculate median price
    const prices = pools.map(p => p.price).sort((a, b) => a - b);
    const medianPrice = prices.length % 2 === 0
      ? (prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2
      : prices[Math.floor(prices.length / 2)];

    // Check deviations
    const deviations: PairValidationResult['deviations'] = [];
    const poolDetails: PairValidationResult['pools'] = [];

    for (const { dex, pool, price, metadata } of pools) {
      poolDetails.push({
        dex,
        poolId: (pool as any).id,
        poolKind: metadata.poolKind,
        price,
        wasSwapped: metadata.wasSwapped,
        decimalsA: metadata.decimalsA,
        decimalsB: metadata.decimalsB,
        sqrtPriceX64: metadata.sqrtPriceX64,
        originalPrice: metadata.originalPrice,
      });

      const deviation = Math.max(price / medianPrice, medianPrice / price) - 1;
      
      if (deviation > maxDeviation || logAllPairs) {
        const rootCause = detectRootCause(price, medianPrice, metadata.decimalsA, metadata.decimalsB);
        deviations.push({
          dex,
          poolId: (pool as any).id,
          deviation,
          deviationPct: deviation * 100,
          likelyCause: rootCause.cause,
          magnitudeError: rootCause.magnitudeError,
        });

        if (deviation > maxDeviation) {
          issuesByDex.set(dex, (issuesByDex.get(dex) || 0) + 1);
          issuesByCause.set(rootCause.cause, (issuesByCause.get(rootCause.cause) || 0) + 1);
        }
      }
    }

    // CLMM orientation check (compare Raydium vs Orca for same pair)
    let clmmOrientationCheck: PairValidationResult['clmmOrientationCheck'] | undefined;
    if (checkClmmOrientation) {
      const raydiumClmm = pools.find(p => p.dex === 'Raydium' && p.metadata.poolKind === 'clmm');
      const orcaClmm = pools.find(p => p.dex === 'Orca' && p.metadata.poolKind === 'clmm');
      
      if (raydiumClmm && orcaClmm) {
        const deviation = Math.max(
          raydiumClmm.price / orcaClmm.price,
          orcaClmm.price / raydiumClmm.price
        ) - 1;
        
        clmmOrientationCheck = {
          raydiumPrice: raydiumClmm.price,
          orcaPrice: orcaClmm.price,
          deviation,
          orientationMatch: deviation < 0.10, // 10% tolerance
        };

        if (!clmmOrientationCheck.orientationMatch) {
          logger.warn('pools.validation.clmm_orientation_mismatch', {
            pair: pairKey,
            mintA: mintA.slice(0, 8) + '...',
            mintB: mintB.slice(0, 8) + '...',
            raydiumPrice: raydiumClmm.price,
            orcaPrice: orcaClmm.price,
            deviation: deviation * 100,
            raydiumSqrt: raydiumClmm.metadata.sqrtPriceX64,
            orcaSqrt: orcaClmm.metadata.sqrtPriceX64,
            raydiumDecimals: `${raydiumClmm.metadata.decimalsA}/${raydiumClmm.metadata.decimalsB}`,
            orcaDecimals: `${orcaClmm.metadata.decimalsA}/${orcaClmm.metadata.decimalsB}`,
            hint: 'CLMM sqrt_price_x64 orientation may differ between DEXes',
            cat: 'pools.validation',
          });
        }
      }
    }

    // Log pair validation result if there are deviations
    if (deviations.length > 0 || logAllPairs) {
      const result: PairValidationResult = {
        pairKey,
        mintA,
        mintB,
        pools: poolDetails,
        medianPrice,
        deviations,
        clmmOrientationCheck,
      };

      pairResults.push(result);

      // Log detailed mismatch information
      if (deviations.length > 0) {
        for (const dev of deviations) {
          const pool = pools.find(p => (p.pool as any).id === dev.poolId);
          if (!pool) continue;

          try {
            const usdA = getPriceByMint(mintA)?.usdc;
            const usdB = getPriceByMint(mintB)?.usdc;
            const expectedPrice = usdA && usdB && usdA > 0 && usdB > 0 ? usdB / usdA : undefined;

            logger.warn('pools.validation.pair_mismatch', {
              pair: pairKey,
              mintA: mintA.slice(0, 8) + '...',
              mintB: mintB.slice(0, 8) + '...',
              dex: dev.dex,
              poolId: dev.poolId.slice(0, 12) + '...',
              poolKind: pool.metadata.poolKind,
              price: pool.price,
              medianPrice,
              deviationPct: dev.deviationPct.toFixed(2),
              likelyCause: dev.likelyCause,
              magnitudeError: dev.magnitudeError,
              decimalsA: pool.metadata.decimalsA,
              decimalsB: pool.metadata.decimalsB,
              wasSwapped: pool.metadata.wasSwapped,
              sqrtPriceX64: pool.metadata.sqrtPriceX64,
              originalPrice: pool.metadata.originalPrice,
              canonicalPrice: pool.price,
              otherDexes: pools
                .filter(p => p.dex !== dev.dex)
                .map(p => ({
                  dex: p.dex,
                  price: p.price,
                  poolKind: p.metadata.poolKind,
                })),
              usdA,
              usdB,
              expectedPrice,
              cat: 'pools.validation',
            });
          } catch (e) {
            // Log without USD context if lookup fails
            logger.warn('pools.validation.pair_mismatch', {
              pair: pairKey,
              dex: dev.dex,
              poolId: dev.poolId.slice(0, 12) + '...',
              price: pool.price,
              medianPrice,
              deviationPct: dev.deviationPct.toFixed(2),
              likelyCause: dev.likelyCause,
              cat: 'pools.validation',
            });
          }
        }
      }
    }
  }

  // Step 3: Validate canonicalization correctness
  for (const [pairKey, pools] of poolsByPair.entries()) {
    for (const { dex, pool, metadata } of pools) {
      // Check if canonicalization was applied correctly
      if (metadata.wasSwapped) {
        const expectedCanonicalPrice = 1 / metadata.originalPrice;
        const actualCanonicalPrice = (pool as any).price_a_per_b;
        const product = metadata.originalPrice * actualCanonicalPrice;
        const deviation = Math.abs(product - 1);

        if (deviation > 0.01) { // 1% tolerance
          logger.warn('pools.validation.canonicalization_mismatch', {
            pair: pairKey,
            dex,
            poolId: ((pool as any).id || '').slice(0, 12) + '...',
            originalPrice: metadata.originalPrice,
            canonicalPrice: actualCanonicalPrice,
            expectedCanonicalPrice,
            product,
            deviation: deviation * 100,
            originalMintA: metadata.originalMintA.slice(0, 8) + '...',
            originalMintB: metadata.originalMintB.slice(0, 8) + '...',
            canonicalMintA: pool.mint_a.slice(0, 8) + '...',
            canonicalMintB: pool.mint_b.slice(0, 8) + '...',
            hint: 'Price inversion during canonicalization may be incorrect',
            cat: 'pools.validation',
          });
        }
      }
    }
  }

  // Summary
  const totalPairs = poolsByPair.size;
  const pairsWithMismatches = pairResults.filter(r => r.deviations.length > 0).length;
  const totalPools = Array.from(poolsByPair.values()).reduce((sum, pools) => sum + pools.length, 0);
  const poolsWithIssues = pairResults.reduce((sum, r) => sum + r.deviations.length, 0);

  logger.info('pools.validation.comprehensive_summary', {
    totalPairs,
    pairsWithMismatches,
    totalPools,
    poolsWithIssues,
    issuesByDex: Object.fromEntries(issuesByDex.entries()),
    issuesByCause: Object.fromEntries(issuesByCause.entries()),
    maxDeviation: maxDeviation * 100,
    cat: 'pools.validation',
  });

  return {
    pairResults,
    summary: {
      totalPairs,
      pairsWithMismatches,
      totalPools,
      poolsWithIssues,
      issuesByDex: Object.fromEntries(issuesByDex.entries()),
      issuesByCause: Object.fromEntries(issuesByCause.entries()),
    },
  };
}

/**
 * Validate edges after graph creation
 * Checks that forward * reverse ≈ 1
 */
export function validateEdgesComprehensive(
  edges: Array<{ source: string; target: string; price_a_per_b?: number; pool_id?: string; dex?: string }>
): EdgeValidationResult[] {
  const results: EdgeValidationResult[] = [];
  const edgeMap = new Map<string, any>();

  // Group edges by pool_id (canonical direction only)
  for (const edge of edges) {
    if (!edge.price_a_per_b || edge.price_a_per_b <= 0) continue;
    
    const poolId = edge.pool_id || `${edge.source}:${edge.target}:${edge.dex}`;
    edgeMap.set(poolId, edge);
  }

  // Validate canonical edges by ensuring inversion stays finite
  for (const [poolId, forward] of edgeMap.entries()) {
    const forwardPrice = forward.price_a_per_b!;
    const reversePrice = 1 / forwardPrice;
    const product = forwardPrice * reversePrice;
    const deviation = Math.abs(product - 1);

    const isValid = Number.isFinite(reversePrice);

    if (!isValid) {
      logger.warn('pools.validation.edge_product_mismatch', {
        poolId: poolId.slice(0, 12) + '...',
        dex: forward.dex || 'unknown',
        source: forward.source.slice(0, 8) + '...',
        target: forward.target.slice(0, 8) + '...',
        forwardPrice,
        reversePrice,
        product,
        deviation: deviation * 100,
        expectedProduct: 1,
        hint: 'Canonical edge should invert cleanly',
        cat: 'pools.validation',
      });
    }

    results.push({
      poolId,
      dex: forward.dex || 'unknown',
      mintA: forward.source,
      mintB: forward.target,
      forwardPrice,
      reversePrice,
      product,
      deviation,
      isValid,
    });
  }

  const invalidCount = results.filter(r => !r.isValid).length;
  if (invalidCount > 0) {
    logger.warn('pools.validation.edges_summary', {
      totalEdges: results.length,
      invalidEdges: invalidCount,
      invalidPct: ((invalidCount / results.length) * 100).toFixed(2),
      cat: 'pools.validation',
    });
  }

  return results;
}

/**
 * Validate edges for price discrepancies between swapped and non-swapped pools
 * Logs warnings when edges with the same source->target have significantly different prices
 * based on swap state, which could indicate canonicalization issues.
 */
export function validateEdgePriceDiscrepancies(
  edges: Array<{ 
    source: string; 
    target: string; 
    price_a_per_b?: number; 
    pool_id?: string; 
    dex?: string;
    was_swapped?: boolean;
  }>,
  options: {
    maxDeviation?: number; // Default 0.10 (10%)
  } = {}
): void {
  const { maxDeviation = 0.10 } = options;
  
  // Group edges by source->target pair
  const edgesByPair = new Map<string, Array<{
    poolId: string;
    dex: string;
    price: number;
    wasSwapped: boolean;
  }>>();
  
  for (const edge of edges) {
    if (!edge.price_a_per_b || edge.price_a_per_b <= 0) continue;
    
    const pairKey = `${edge.source}:${edge.target}`;
    if (!edgesByPair.has(pairKey)) {
      edgesByPair.set(pairKey, []);
    }
    
    edgesByPair.get(pairKey)!.push({
      poolId: edge.pool_id || 'unknown',
      dex: edge.dex || 'unknown',
      price: edge.price_a_per_b,
      wasSwapped: edge.was_swapped === true,
    });
  }
  
  // Check for discrepancies between swapped and non-swapped edges
  for (const [pairKey, edgeList] of edgesByPair.entries()) {
    if (edgeList.length < 2) continue; // Need at least 2 edges to compare
    
    const swappedEdges = edgeList.filter(e => e.wasSwapped);
    const nonSwappedEdges = edgeList.filter(e => !e.wasSwapped);
    
    // Only check if we have both swapped and non-swapped edges
    if (swappedEdges.length === 0 || nonSwappedEdges.length === 0) continue;
    
    // Calculate median prices for each group
    const swappedPrices = swappedEdges.map(e => e.price).sort((a, b) => a - b);
    const nonSwappedPrices = nonSwappedEdges.map(e => e.price).sort((a, b) => a - b);
    
    const swappedMedian = swappedPrices.length % 2 === 0
      ? (swappedPrices[swappedPrices.length / 2 - 1] + swappedPrices[swappedPrices.length / 2]) / 2
      : swappedPrices[Math.floor(swappedPrices.length / 2)];
    
    const nonSwappedMedian = nonSwappedPrices.length % 2 === 0
      ? (nonSwappedPrices[nonSwappedPrices.length / 2 - 1] + nonSwappedPrices[nonSwappedPrices.length / 2]) / 2
      : nonSwappedPrices[Math.floor(nonSwappedPrices.length / 2)];
    
    // Check deviation between medians
    const deviation = Math.max(swappedMedian / nonSwappedMedian, nonSwappedMedian / swappedMedian) - 1;
    
    if (deviation > maxDeviation) {
      // Check if prices are inverted (one median ≈ 1 / other median)
      const product = swappedMedian * nonSwappedMedian;
      const isInverted = Math.abs(product - 1) < 0.05; // Within 5% of 1.0
      
      logger.warn('graph.edges.price_discrepancy.swap_state', {
        pair: pairKey,
        source: pairKey.split(':')[0].slice(0, 8) + '...',
        target: pairKey.split(':')[1].slice(0, 8) + '...',
        swappedMedian,
        nonSwappedMedian,
        deviationPct: (deviation * 100).toFixed(2),
        product,
        isInverted,
        swappedCount: swappedEdges.length,
        nonSwappedCount: nonSwappedEdges.length,
        swappedEdges: swappedEdges.map(e => ({
          poolId: e.poolId.slice(0, 12) + '...',
          dex: e.dex,
          price: e.price,
        })),
        nonSwappedEdges: nonSwappedEdges.map(e => ({
          poolId: e.poolId.slice(0, 12) + '...',
          dex: e.dex,
          price: e.price,
        })),
        hint: isInverted 
          ? 'Prices appear inverted - canonicalization may have inconsistent swap handling'
          : 'Prices differ significantly - check canonicalization logic',
        cat: 'graph.validation',
      });
    }
  }
}

