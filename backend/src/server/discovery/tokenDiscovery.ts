/**
 * Token Discovery Orchestrator
 * 
 * Main orchestrator for the token discovery system. Fetches top traded tokens
 * from Jupiter, discovers their pools via DexScreener, enriches pool data,
 * and integrates new pools into the graph.
 */

import { logger } from '../../utils/logger.js';
import { CONFIG } from '../../utils/config.js';
import { canonicalizePools } from '../pools/canonical.js';
import type { 
  DiscoveryResult, 
  DiscoveredPool,
  JupiterTopToken,
  DiscoveryConfig 
} from './types.js';
import {
  fetchDexScreenerPools,
  mapAndFilterPools,
  filterBySupportedDex,
  filterByMinLiquidity,
  filterOutTracked,
  getDefaultSupportedDexIds,
  getDiscoveryStats,
} from './dexScreener.js';
import { enrichDiscoveredPools, getEnrichedPoolCount } from './enrichment.js';

// ============================================================================
// Jupiter Token Fetching
// ============================================================================

/**
 * Fetch top traded tokens from Jupiter API
 */
export async function fetchJupiterTopTokens(): Promise<JupiterTopToken[]> {
  const cfg = getDiscoveryConfig();
  
  const baseUrl = 'https://api.jup.ag/tokens/v2';
  const url = `${baseUrl}/${cfg.jupiterCategory}/${cfg.jupiterInterval}?limit=${cfg.jupiterLimit}`;
  
  const headers: Record<string, string> = { accept: 'application/json' };
  if (cfg.jupiterApiKey) {
    headers['x-api-key'] = cfg.jupiterApiKey;
  }
  
  try {
    const res = await fetch(url, { headers });
    
    if (!res.ok) {
      throw new Error(`Jupiter API HTTP ${res.status}`);
    }
    
    const data = await res.json();
    
    // Handle different response formats
    const tokens: JupiterTopToken[] = Array.isArray(data) 
      ? data 
      : (data?.value || data?.data || data?.tokens || []);
    
    logger.info('discovery.jupiter.fetched', { 
      count: tokens.length,
      category: cfg.jupiterCategory,
      interval: cfg.jupiterInterval,
      cat: 'discovery' 
    });
    
    return tokens;
    
  } catch (err: any) {
    logger.error('discovery.jupiter.error', { 
      error: String(err?.message || err),
      cat: 'discovery' 
    });
    return [];
  }
}

// ============================================================================
// Graph Integration
// ============================================================================

/**
 * Get currently tracked mints from the graph
 */
export async function getTrackedMints(): Promise<Set<string>> {
  try {
    const { getGraphSnapshot } = await import('../graph.js');
    const snapshot = await getGraphSnapshot(false);
    
    if (!snapshot?.edges) {
      return new Set();
    }
    
    const mints = new Set<string>();
    for (const edge of snapshot.edges) {
      if (edge.source) mints.add(edge.source);
      if (edge.target) mints.add(edge.target);
    }
    
    return mints;
  } catch (err) {
    logger.warn('discovery.tracked_mints.error', { 
      error: String(err),
      cat: 'discovery' 
    });
    return new Set();
  }
}

/**
 * Get currently tracked pool IDs from the graph
 */
export async function getTrackedPoolIds(): Promise<Set<string>> {
  try {
    const { getGraphSnapshot } = await import('../graph.js');
    const snapshot = await getGraphSnapshot(false);
    
    if (!snapshot?.edges) {
      return new Set();
    }
    
    const poolIds = new Set<string>();
    for (const edge of snapshot.edges) {
      if (edge.pool_id) {
        // Remove any suffix (e.g., #rev)
        const baseId = String(edge.pool_id).replace(/[#-]rev$/, '');
        poolIds.add(baseId);
      }
    }
    
    return poolIds;
  } catch (err) {
    logger.warn('discovery.tracked_pools.error', { 
      error: String(err),
      cat: 'discovery' 
    });
    return new Set();
  }
}

/**
 * Integrate enriched pools into the pool caches
 */
async function integratePoolsIntoCaches(enrichmentResult: any): Promise<number> {
  let addedCount = 0;
  
  try {
    const poolsModule = await import('../pools.js');
    const { raydiumCache, orcaCache, meteoraCache } = await import('../pools.cache.js');
    
    // Add Raydium pools
    const raydiumPools = enrichmentResult.pools.raydium;
    if (raydiumPools.amm.length > 0 || raydiumPools.clmm.length > 0 || raydiumPools.cpmm.length > 0) {
      const currentRaydium = raydiumCache.data || { amm: [], clmm: [], cpmm: [] };
      
      // Deduplicate by pool ID
      const existingIds = new Set([
        ...currentRaydium.amm.map((p: any) => p.id),
        ...currentRaydium.clmm.map((p: any) => p.id),
        ...(currentRaydium.cpmm || []).map((p: any) => p.id),
      ]);
      
      const newAmm = raydiumPools.amm.filter((p: any) => p.id && !existingIds.has(p.id));
      const newClmm = raydiumPools.clmm.filter((p: any) => p.id && !existingIds.has(p.id));
      const newCpmm = raydiumPools.cpmm.filter((p: any) => p.id && !existingIds.has(p.id));
      
      // Canonicalize new pools
      const canonAmm = canonicalizePools(newAmm);
      const canonClmm = canonicalizePools(newClmm);
      const canonCpmm = canonicalizePools(newCpmm);
      
      raydiumCache.data = {
        amm: [...currentRaydium.amm, ...canonAmm],
        clmm: [...currentRaydium.clmm, ...canonClmm],
        cpmm: [...(currentRaydium.cpmm || []), ...canonCpmm],
      };
      raydiumCache.ts = Date.now();
      
      addedCount += canonAmm.length + canonClmm.length + canonCpmm.length;
      
      if (canonAmm.length > 0 || canonClmm.length > 0 || canonCpmm.length > 0) {
        logger.info('discovery.integrate.raydium', { 
          amm: canonAmm.length,
          clmm: canonClmm.length,
          cpmm: canonCpmm.length,
          cat: 'discovery' 
        });
      }
    }
    
    // Add Orca pools
    const orcaPools = enrichmentResult.pools.orca;
    if (orcaPools.clmm.length > 0) {
      const currentOrca = orcaCache.data || { amm: [], clmm: [] };
      
      const existingIds = new Set(currentOrca.clmm.map((p: any) => p.id));
      const newClmm = orcaPools.clmm.filter((p: any) => p.id && !existingIds.has(p.id));
      
      const canonClmm = canonicalizePools(newClmm);
      
      orcaCache.data = {
        amm: currentOrca.amm || [],
        clmm: [...currentOrca.clmm, ...canonClmm],
      };
      orcaCache.ts = Date.now();
      
      addedCount += canonClmm.length;
      
      if (canonClmm.length > 0) {
        logger.info('discovery.integrate.orca', { 
          clmm: canonClmm.length,
          cat: 'discovery' 
        });
      }
    }
    
    // Add Meteora pools
    const meteoraPools = enrichmentResult.pools.meteora;
    if (meteoraPools.clmm.length > 0) {
      const currentMeteora = meteoraCache.data || { amm: [], clmm: [] };
      
      const existingIds = new Set(currentMeteora.clmm.map((p: any) => p.id));
      const newClmm = meteoraPools.clmm.filter((p: any) => p.id && !existingIds.has(p.id));
      
      const canonClmm = canonicalizePools(newClmm);
      
      meteoraCache.data = {
        amm: currentMeteora.amm || [],
        clmm: [...currentMeteora.clmm, ...canonClmm],
      };
      meteoraCache.ts = Date.now();
      
      addedCount += canonClmm.length;
      
      if (canonClmm.length > 0) {
        logger.info('discovery.integrate.meteora', { 
          clmm: canonClmm.length,
          cat: 'discovery' 
        });
      }
    }
    
  } catch (err: any) {
    logger.error('discovery.integrate.error', { 
      error: String(err?.message || err),
      cat: 'discovery' 
    });
  }
  
  return addedCount;
}

/**
 * Trigger an incremental graph rebuild
 */
async function triggerGraphRebuild(): Promise<void> {
  try {
    const { scheduleGraphRebuild } = await import('../graph.js');
    scheduleGraphRebuild('discovery');
    
    logger.info('discovery.graph.rebuild_scheduled', { cat: 'discovery' });
  } catch (err: any) {
    logger.error('discovery.graph.rebuild_error', { 
      error: String(err?.message || err),
      cat: 'discovery' 
    });
  }
}

// ============================================================================
// Configuration
// ============================================================================

/**
 * Get discovery configuration from CONFIG
 */
export function getDiscoveryConfig(): DiscoveryConfig {
  const disc = (CONFIG as any)?.discovery || {};
  const jupTop = (CONFIG as any)?.system?.jupiterTopTokens || {};
  
  return {
    enabled: disc.enabled ?? false,
    intervalMs: Number(disc.intervalMs || 300_000),
    
    // Jupiter settings - prefer discovery config, fallback to jupiterTopTokens
    jupiterApiKey: String(disc.jupiterApiKey || jupTop.apiKey || ''),
    jupiterCategory: disc.jupiterCategory || jupTop.category || 'toptraded',
    jupiterInterval: disc.jupiterInterval || jupTop.interval || '5m',
    jupiterLimit: Number(disc.jupiterLimit || jupTop.limit || 100),
    
    // DexScreener settings
    dexScreenerDelayMs: Number(disc.dexScreenerDelayMs || 200),
    dexScreenerBatchSize: Number(disc.dexScreenerBatchSize || 10),
    
    // Filters
    minLiquidityUsd: Number(disc.minLiquidityUsd || 1000),
    maxPoolsPerToken: Number(disc.maxPoolsPerToken || 20),
    
    // Supported DEXes
    supportedDexIds: disc.supportedDexIds || getDefaultSupportedDexIds(),
  };
}

// ============================================================================
// Deduplication
// ============================================================================

/**
 * Deduplicate tokens against already tracked mints
 */
export function deduplicateTokens(
  jupiterTokens: JupiterTopToken[],
  trackedMints: Set<string>
): JupiterTopToken[] {
  return jupiterTokens.filter(t => {
    const id = t.id;
    return id && !trackedMints.has(id);
  });
}

// ============================================================================
// Main Discovery Cycle
// ============================================================================

/**
 * Run a single discovery cycle.
 * 
 * Algorithm:
 * 1. Fetch Jupiter top traded tokens (5m interval)
 * 2. Get currently tracked mints from graph
 * 3. Deduplicate: newMints = jupiterMints - trackedMints
 * 4. For each new mint (batched, rate-limited):
 *    - Fetch DexScreener pools
 *    - Filter by supported DEX and min liquidity
 *    - Filter out already-tracked pool addresses
 * 5. Group pools by DEX
 * 6. Enrich via DEX-specific functions
 * 7. Canonicalize pools
 * 8. Merge into pool caches
 * 9. Trigger incremental graph update
 * 10. Return statistics
 * 
 * @param options Override options for this cycle
 */
export async function runDiscoveryCycle(options?: {
  maxTokens?: number;
  maxPoolsPerToken?: number;
  minLiquidityUsd?: number;
  dryRun?: boolean;
}): Promise<DiscoveryResult> {
  const startTime = Date.now();
  const cfg = getDiscoveryConfig();
  
  const result: DiscoveryResult = {
    tokensChecked: 0,
    newTokensFound: 0,
    poolsDiscovered: 0,
    poolsFiltered: 0,
    poolsEnriched: 0,
    poolsAdded: 0,
    errors: [],
    byDex: {},
    timestamp: startTime,
    durationMs: 0,
  };
  
  try {
    logger.info('discovery.cycle.start', { 
      maxTokens: options?.maxTokens,
      minLiquidity: options?.minLiquidityUsd || cfg.minLiquidityUsd,
      dryRun: options?.dryRun,
      cat: 'discovery' 
    });
    
    // Step 1: Fetch Jupiter top tokens
    const jupiterTokens = await fetchJupiterTopTokens();
    if (jupiterTokens.length === 0) {
      result.errors.push('No tokens returned from Jupiter API');
      result.durationMs = Date.now() - startTime;
      return result;
    }
    
    // Step 2: Get tracked mints and pool IDs
    const [trackedMints, trackedPoolIds] = await Promise.all([
      getTrackedMints(),
      getTrackedPoolIds(),
    ]);
    
    // Step 3: Deduplicate tokens
    let tokensToCheck = deduplicateTokens(jupiterTokens, trackedMints);
    result.newTokensFound = tokensToCheck.length;
    
    // Apply maxTokens limit if specified
    if (options?.maxTokens && options.maxTokens > 0) {
      tokensToCheck = tokensToCheck.slice(0, options.maxTokens);
    }
    result.tokensChecked = tokensToCheck.length;
    
    logger.info('discovery.cycle.tokens', { 
      jupiterTotal: jupiterTokens.length,
      trackedMints: trackedMints.size,
      newTokens: result.newTokensFound,
      checking: result.tokensChecked,
      cat: 'discovery' 
    });
    
    if (tokensToCheck.length === 0) {
      logger.info('discovery.cycle.no_new_tokens', { cat: 'discovery' });
      result.durationMs = Date.now() - startTime;
      return result;
    }
    
    // Step 4: Fetch DexScreener pools for each token
    const allDiscoveredPools: DiscoveredPool[] = [];
    const minLiq = options?.minLiquidityUsd ?? cfg.minLiquidityUsd;
    const maxPoolsPerToken = options?.maxPoolsPerToken ?? cfg.maxPoolsPerToken;
    
    for (const token of tokensToCheck) {
      try {
        // Fetch pools from DexScreener
        const rawPools = await fetchDexScreenerPools(token.id);
        result.poolsDiscovered += rawPools.length;
        
        // Filter by supported DEX
        let filtered = filterBySupportedDex(rawPools, cfg.supportedDexIds);
        
        // Filter by min liquidity
        filtered = filterByMinLiquidity(filtered, minLiq);
        
        // Filter out already tracked pools
        filtered = filterOutTracked(filtered, trackedPoolIds);
        
        // Apply max pools per token limit
        if (maxPoolsPerToken > 0) {
          filtered = filtered.slice(0, maxPoolsPerToken);
        }
        
        // Map to internal types
        const mapped = mapAndFilterPools(filtered);
        result.poolsFiltered += mapped.length;
        
        allDiscoveredPools.push(...mapped);
        
        // Track per-token stats
        for (const pool of mapped) {
          const dexKey = pool.mapping.dex;
          result.byDex[dexKey] = result.byDex[dexKey] || { discovered: 0, enriched: 0, added: 0 };
          result.byDex[dexKey].discovered++;
        }
        
      } catch (err: any) {
        result.errors.push(`Token ${token.id.slice(0, 8)}: ${err?.message || err}`);
      }
    }
    
    logger.info('discovery.cycle.dexscreener', { 
      poolsDiscovered: result.poolsDiscovered,
      poolsFiltered: result.poolsFiltered,
      cat: 'discovery' 
    });
    
    if (allDiscoveredPools.length === 0) {
      logger.info('discovery.cycle.no_new_pools', { cat: 'discovery' });
      result.durationMs = Date.now() - startTime;
      return result;
    }
    
    // Step 5-7: Enrich pools (includes normalization)
    const enrichmentResult = await enrichDiscoveredPools(allDiscoveredPools);
    result.poolsEnriched = getEnrichedPoolCount(enrichmentResult);
    result.errors.push(...enrichmentResult.errors);
    
    // Update per-DEX enriched counts
    for (const dex of Object.keys(result.byDex)) {
      const enrichedCount = 
        (dex === 'raydium' ? enrichmentResult.pools.raydium.amm.length + enrichmentResult.pools.raydium.clmm.length + enrichmentResult.pools.raydium.cpmm.length : 0) +
        (dex === 'orca' ? enrichmentResult.pools.orca.clmm.length : 0) +
        (dex === 'meteora' ? enrichmentResult.pools.meteora.clmm.length : 0);
      result.byDex[dex].enriched = enrichedCount;
    }
    
    // Step 8-9: Integrate into caches and trigger graph rebuild
    if (!options?.dryRun && result.poolsEnriched > 0) {
      result.poolsAdded = await integratePoolsIntoCaches(enrichmentResult);
      
      // Update per-DEX added counts
      for (const dex of Object.keys(result.byDex)) {
        // Approximation: added ≈ enriched for now
        result.byDex[dex].added = result.byDex[dex].enriched;
      }
      
      if (result.poolsAdded > 0) {
        await triggerGraphRebuild();
      }
    }
    
  } catch (err: any) {
    result.errors.push(`Cycle error: ${err?.message || err}`);
    logger.error('discovery.cycle.error', { 
      error: String(err?.message || err),
      cat: 'discovery' 
    });
  }
  
  result.durationMs = Date.now() - startTime;
  
  logger.info('discovery.cycle.complete', { 
    tokensChecked: result.tokensChecked,
    newTokensFound: result.newTokensFound,
    poolsDiscovered: result.poolsDiscovered,
    poolsEnriched: result.poolsEnriched,
    poolsAdded: result.poolsAdded,
    errors: result.errors.length,
    durationMs: result.durationMs,
    cat: 'discovery' 
  });
  
  return result;
}
