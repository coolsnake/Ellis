/**
 * Pool Enrichment Module
 * 
 * Enriches discovered pools from DexScreener by fetching full pool data
 * from DEX-specific sources (Shyft GraphQL).
 */

import { logger } from '../../utils/logger.js';
import { CONFIG } from '../../utils/config.js';
import type { 
  DiscoveredPool, 
  EnrichmentOptions, 
  EnrichmentResult,
  InternalDex,
  PoolKind 
} from './types.js';
import { groupPoolsByDexAndKind, extractPoolAddresses } from './dexScreener.js';

// ============================================================================
// Import Enrichment Functions
// ============================================================================

// Raydium
import { 
  fetchRaydiumPoolsByAddress,
  fetchRaydiumClmmPoolsByAddress,
  normalizeRaydiumGraphQL 
} from '../pools/raydiumGraphQL.js';
import { 
  fetchRaydiumCpmmPoolsByAddress,
  normalizeRaydiumCpmmGraphQL 
} from '../pools/raydiumCpmmGraphQL.js';

// Orca
import { 
  fetchOrcaPoolsByAddress,
  normalizeOrcaGraphQL 
} from '../pools/orcaGraphQL.js';

// Meteora
import { 
  fetchMeteoraPoolsByAddress,
  normalizeMeteoraGraphQL 
} from '../pools/meteoraGraphQL.js';

// PumpSwap
import { 
  fetchPumpswapPoolsByAddress,
  normalizePumpswapPools 
} from '../pools/pumpswap.js';

// ============================================================================
// Default Options
// ============================================================================

const DEFAULT_OPTIONS: Required<EnrichmentOptions> = {
  retries: 2,
  backoffMs: 500,
  batchSize: 50,
  delayMs: 200,
};

// ============================================================================
// Enrichment Functions by DEX
// ============================================================================

/**
 * Enrich Raydium AMM pools
 */
async function enrichRaydiumAmm(
  poolIds: string[],
  opts: Required<EnrichmentOptions>
): Promise<{ pools: any[]; failed: string[] }> {
  if (poolIds.length === 0) return { pools: [], failed: [] };
  
  try {
    logger.info('discovery.enrich.raydium_amm.start', { 
      count: poolIds.length, 
      cat: 'discovery' 
    });
    
    const poolMap = await fetchRaydiumPoolsByAddress(poolIds, {
      retries: opts.retries,
      backoffMs: opts.backoffMs,
      batchSize: opts.batchSize,
      delayMs: opts.delayMs,
    });
    
    const pools = Array.from(poolMap.values());
    const found = new Set(poolMap.keys());
    const failed = poolIds.filter(id => !found.has(id));
    
    logger.info('discovery.enrich.raydium_amm.complete', { 
      requested: poolIds.length,
      found: pools.length,
      failed: failed.length,
      cat: 'discovery' 
    });
    
    return { pools, failed };
  } catch (err: any) {
    logger.error('discovery.enrich.raydium_amm.error', { 
      error: String(err?.message || err),
      cat: 'discovery' 
    });
    return { pools: [], failed: poolIds };
  }
}

/**
 * Enrich Raydium CLMM pools
 */
async function enrichRaydiumClmm(
  poolIds: string[],
  opts: Required<EnrichmentOptions>
): Promise<{ pools: any[]; failed: string[] }> {
  if (poolIds.length === 0) return { pools: [], failed: [] };
  
  try {
    logger.info('discovery.enrich.raydium_clmm.start', { 
      count: poolIds.length, 
      cat: 'discovery' 
    });
    
    const poolMap = await fetchRaydiumClmmPoolsByAddress(poolIds, {
      retries: opts.retries,
      backoffMs: opts.backoffMs,
      batchSize: opts.batchSize,
      delayMs: opts.delayMs,
    });
    
    const pools = Array.from(poolMap.values());
    const found = new Set(poolMap.keys());
    const failed = poolIds.filter(id => !found.has(id));
    
    logger.info('discovery.enrich.raydium_clmm.complete', { 
      requested: poolIds.length,
      found: pools.length,
      failed: failed.length,
      cat: 'discovery' 
    });
    
    return { pools, failed };
  } catch (err: any) {
    logger.error('discovery.enrich.raydium_clmm.error', { 
      error: String(err?.message || err),
      cat: 'discovery' 
    });
    return { pools: [], failed: poolIds };
  }
}

/**
 * Enrich Raydium CPMM pools
 */
async function enrichRaydiumCpmm(
  poolIds: string[],
  opts: Required<EnrichmentOptions>
): Promise<{ pools: any[]; failed: string[] }> {
  if (poolIds.length === 0) return { pools: [], failed: [] };
  
  try {
    logger.info('discovery.enrich.raydium_cpmm.start', { 
      count: poolIds.length, 
      cat: 'discovery' 
    });
    
    const poolMap = await fetchRaydiumCpmmPoolsByAddress(poolIds, {
      retries: opts.retries,
      backoffMs: opts.backoffMs,
      batchSize: opts.batchSize,
      delayMs: opts.delayMs,
    });
    
    const pools = Array.from(poolMap.values());
    const found = new Set(poolMap.keys());
    const failed = poolIds.filter(id => !found.has(id));
    
    logger.info('discovery.enrich.raydium_cpmm.complete', { 
      requested: poolIds.length,
      found: pools.length,
      failed: failed.length,
      cat: 'discovery' 
    });
    
    return { pools, failed };
  } catch (err: any) {
    logger.error('discovery.enrich.raydium_cpmm.error', { 
      error: String(err?.message || err),
      cat: 'discovery' 
    });
    return { pools: [], failed: poolIds };
  }
}

/**
 * Enrich Orca Whirlpool pools
 */
async function enrichOrca(
  poolIds: string[],
  opts: Required<EnrichmentOptions>
): Promise<{ pools: any[]; failed: string[] }> {
  if (poolIds.length === 0) return { pools: [], failed: [] };
  
  try {
    logger.info('discovery.enrich.orca.start', { 
      count: poolIds.length, 
      cat: 'discovery' 
    });
    
    const poolMap = await fetchOrcaPoolsByAddress(poolIds, {
      retries: opts.retries,
      backoffMs: opts.backoffMs,
      batchSize: Math.min(opts.batchSize, 40), // Orca has stricter batch limit
      delayMs: opts.delayMs,
    });
    
    const pools = Array.from(poolMap.values());
    const found = new Set(poolMap.keys());
    const failed = poolIds.filter(id => !found.has(id));
    
    logger.info('discovery.enrich.orca.complete', { 
      requested: poolIds.length,
      found: pools.length,
      failed: failed.length,
      cat: 'discovery' 
    });
    
    return { pools, failed };
  } catch (err: any) {
    logger.error('discovery.enrich.orca.error', { 
      error: String(err?.message || err),
      cat: 'discovery' 
    });
    return { pools: [], failed: poolIds };
  }
}

/**
 * Enrich Meteora DLMM pools
 */
async function enrichMeteoraDlmm(
  poolIds: string[],
  opts: Required<EnrichmentOptions>
): Promise<{ pools: any[]; failed: string[] }> {
  if (poolIds.length === 0) return { pools: [], failed: [] };
  
  try {
    logger.info('discovery.enrich.meteora_dlmm.start', { 
      count: poolIds.length, 
      cat: 'discovery' 
    });
    
    const poolMap = await fetchMeteoraPoolsByAddress(poolIds, {
      retries: opts.retries,
      backoffMs: opts.backoffMs,
      batchSize: Math.min(opts.batchSize, 40), // Meteora has stricter batch limit
      delayMs: opts.delayMs,
    });
    
    const pools = Array.from(poolMap.values());
    const found = new Set(poolMap.keys());
    const failed = poolIds.filter(id => !found.has(id));
    
    logger.info('discovery.enrich.meteora_dlmm.complete', { 
      requested: poolIds.length,
      found: pools.length,
      failed: failed.length,
      cat: 'discovery' 
    });
    
    return { pools, failed };
  } catch (err: any) {
    logger.error('discovery.enrich.meteora_dlmm.error', { 
      error: String(err?.message || err),
      cat: 'discovery' 
    });
    return { pools: [], failed: poolIds };
  }
}

/**
 * Enrich PumpSwap AMM pools
 */
async function enrichPumpswap(
  poolIds: string[],
  opts: Required<EnrichmentOptions>
): Promise<{ pools: any[]; failed: string[] }> {
  if (poolIds.length === 0) return { pools: [], failed: [] };
  
  try {
    logger.info('discovery.enrich.pumpswap.start', { 
      count: poolIds.length, 
      cat: 'discovery' 
    });
    
    const poolMap = await fetchPumpswapPoolsByAddress(poolIds, {
      retries: opts.retries,
      backoffMs: opts.backoffMs,
      batchSize: Math.min(opts.batchSize, 50), // Shyft limit
      delayMs: opts.delayMs,
    });
    
    const pools = Array.from(poolMap.values());
    const found = new Set(poolMap.keys());
    const failed = poolIds.filter(id => !found.has(id));
    
    logger.info('discovery.enrich.pumpswap.complete', { 
      requested: poolIds.length,
      found: pools.length,
      failed: failed.length,
      cat: 'discovery' 
    });
    
    return { pools, failed };
  } catch (err: any) {
    logger.error('discovery.enrich.pumpswap.error', { 
      error: String(err?.message || err),
      cat: 'discovery' 
    });
    return { pools: [], failed: poolIds };
  }
}

// ============================================================================
// Main Enrichment Orchestrator
// ============================================================================

/**
 * Enrich discovered pools by fetching full data from DEX sources.
 * 
 * Supports: Raydium (AMM/CLMM/CPMM), Orca, Meteora DLMM, PumpSwap.
 * Meteora Balanced (DAMM) is not yet supported for enrichment.
 * 
 * @param discoveredPools Pools discovered from DexScreener with mappings
 * @param options Enrichment options
 * @returns Enriched pools organized by DEX
 */
export async function enrichDiscoveredPools(
  discoveredPools: DiscoveredPool[],
  options?: EnrichmentOptions
): Promise<EnrichmentResult> {
  const opts: Required<EnrichmentOptions> = { ...DEFAULT_OPTIONS, ...options };
  
  const result: EnrichmentResult = {
    pools: {
      raydium: { amm: [], clmm: [], cpmm: [] },
      orca: { clmm: [] },
      meteora: { clmm: [] },
      meteora_balanced: { amm: [] },
      pumpswap: { amm: [] },
    },
    failed: [],
    errors: [],
  };
  
  // Group pools by DEX and kind
  const grouped = groupPoolsByDexAndKind(discoveredPools);
  
  logger.info('discovery.enrich.start', { 
    totalPools: discoveredPools.length,
    groups: Object.fromEntries(
      Array.from(grouped.entries()).map(([k, v]) => [k, v.length])
    ),
    cat: 'discovery' 
  });
  
  // Process each group
  for (const [key, pools] of grouped) {
    const poolIds = extractPoolAddresses(pools);
    
    try {
      if (key === 'raydium:amm') {
        const { pools: enriched, failed } = await enrichRaydiumAmm(poolIds, opts);
        const normalized = await normalizeRaydiumGraphQL(enriched);
        result.pools.raydium.amm.push(...(normalized.amm || []));
        result.failed.push(...failed);
        
      } else if (key === 'raydium:clmm') {
        const { pools: enriched, failed } = await enrichRaydiumClmm(poolIds, opts);
        const normalized = await normalizeRaydiumGraphQL(enriched);
        result.pools.raydium.clmm.push(...(normalized.clmm || []));
        result.failed.push(...failed);
        
      } else if (key === 'raydium:cpmm') {
        const { pools: enriched, failed } = await enrichRaydiumCpmm(poolIds, opts);
        const normalized = await normalizeRaydiumCpmmGraphQL(enriched);
        result.pools.raydium.cpmm.push(...(normalized.cpmm || []));
        result.failed.push(...failed);
        
      } else if (key === 'orca:clmm') {
        const { pools: enriched, failed } = await enrichOrca(poolIds, opts);
        const normalized = await normalizeOrcaGraphQL(enriched);
        result.pools.orca.clmm.push(...(normalized.clmm || []));
        result.failed.push(...failed);
        
      } else if (key === 'meteora:clmm') {
        const { pools: enriched, failed } = await enrichMeteoraDlmm(poolIds, opts);
        const normalized = await normalizeMeteoraGraphQL(enriched);
        result.pools.meteora.clmm.push(...(normalized.clmm || []));
        result.failed.push(...failed);
        
      } else if (key.startsWith('meteora_balanced:')) {
        // Meteora Balanced not yet supported - skip but don't fail
        logger.debug('discovery.enrich.skip_meteora_balanced', { 
          count: poolIds.length,
          key,
          reason: 'not_yet_supported',
          cat: 'discovery' 
        });
        
      } else if (key === 'pumpswap:amm') {
        const { pools: enriched, failed } = await enrichPumpswap(poolIds, opts);
        const normalized = await normalizePumpswapPools(enriched);
        result.pools.pumpswap.amm.push(...(normalized.amm || []));
        result.failed.push(...failed);
        
      } else {
        logger.warn('discovery.enrich.unknown_group', { key, count: poolIds.length, cat: 'discovery' });
      }
      
    } catch (err: any) {
      const errorMsg = `Error enriching ${key}: ${err?.message || err}`;
      result.errors.push(errorMsg);
      result.failed.push(...poolIds);
      logger.error('discovery.enrich.group_error', { 
        key, 
        error: errorMsg,
        cat: 'discovery' 
      });
    }
  }
  
  // Summary
  const totalEnriched = 
    result.pools.raydium.amm.length +
    result.pools.raydium.clmm.length +
    result.pools.raydium.cpmm.length +
    result.pools.orca.clmm.length +
    result.pools.meteora.clmm.length +
    result.pools.pumpswap.amm.length;
    
  logger.info('discovery.enrich.complete', { 
    totalPools: discoveredPools.length,
    totalEnriched,
    totalFailed: result.failed.length,
    byDex: {
      raydium_amm: result.pools.raydium.amm.length,
      raydium_clmm: result.pools.raydium.clmm.length,
      raydium_cpmm: result.pools.raydium.cpmm.length,
      orca: result.pools.orca.clmm.length,
      meteora: result.pools.meteora.clmm.length,
      pumpswap: result.pools.pumpswap.amm.length,
    },
    errors: result.errors.length,
    cat: 'discovery' 
  });
  
  return result;
}

/**
 * Get count of enriched pools from result
 */
export function getEnrichedPoolCount(result: EnrichmentResult): number {
  return (
    result.pools.raydium.amm.length +
    result.pools.raydium.clmm.length +
    result.pools.raydium.cpmm.length +
    result.pools.orca.clmm.length +
    result.pools.meteora.clmm.length +
    result.pools.meteora_balanced.amm.length +
    result.pools.pumpswap.amm.length
  );
}
