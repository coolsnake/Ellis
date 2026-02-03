/**
 * Token Discovery Orchestrator
 * 
 * Main orchestrator for the token discovery system. Fetches top traded tokens
 * from Jupiter, discovers their pools via DexScreener, enriches pool data,
 * and integrates new pools into the graph.
 */

import { logger } from '../../utils/logger.js';
import { CONFIG } from '../../utils/config.js';
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
  
  logger.info('discovery.jupiter.fetch_start', { 
    category: cfg.jupiterCategory,
    interval: cfg.jupiterInterval,
    limit: cfg.jupiterLimit,
    hasApiKey: !!cfg.jupiterApiKey,
    cat: 'discovery' 
  });
  
  const startTime = Date.now();
  
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
    
    const durationMs = Date.now() - startTime;
    logger.info('discovery.jupiter.fetch_complete', { 
      count: tokens.length,
      category: cfg.jupiterCategory,
      interval: cfg.jupiterInterval,
      durationMs,
      cat: 'discovery' 
    });
    
    return tokens;
    
  } catch (err: any) {
    const durationMs = Date.now() - startTime;
    logger.error('discovery.jupiter.fetch_error', { 
      error: String(err?.message || err),
      durationMs,
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
    const { raydiumCache, orcaCache, meteoraCache, cpmmCache, pumpswapCache } = await import('../pools.cache.js');
    
    // Add Raydium AMM and CLMM pools to raydiumCache
    const raydiumPools = enrichmentResult.pools.raydium;
    if (raydiumPools.amm.length > 0 || raydiumPools.clmm.length > 0) {
      const currentRaydium = raydiumCache.data || { amm: [], clmm: [], cpmm: [] };
      
      // Deduplicate by pool ID
      const existingAmmIds = new Set(currentRaydium.amm.map((p: any) => p.id));
      const existingClmmIds = new Set(currentRaydium.clmm.map((p: any) => p.id));
      
      const newAmm = raydiumPools.amm.filter((p: any) => p.id && !existingAmmIds.has(p.id));
      const newClmm = raydiumPools.clmm.filter((p: any) => p.id && !existingClmmIds.has(p.id));
      
      // Pools are already canonicalized by normalizers
      raydiumCache.data = {
        amm: [...currentRaydium.amm, ...newAmm],
        clmm: [...currentRaydium.clmm, ...newClmm],
        cpmm: currentRaydium.cpmm || [], // Keep existing cpmm reference (but don't add new ones here)
      };
      raydiumCache.ts = Date.now();
      
      addedCount += newAmm.length + newClmm.length;
      
      if (newAmm.length > 0 || newClmm.length > 0) {
        logger.info('discovery.integrate.raydium', { 
          amm: newAmm.length,
          clmm: newClmm.length,
          cat: 'discovery' 
        });
      }
    }
    
    // Add Raydium CPMM pools to cpmmCache (separate cache!)
    if (raydiumPools.cpmm.length > 0) {
      const currentCpmm = cpmmCache.data || { cpmm: [] };
      
      const existingCpmmIds = new Set(currentCpmm.cpmm.map((p: any) => p.id));
      const newCpmm = raydiumPools.cpmm.filter((p: any) => p.id && !existingCpmmIds.has(p.id));
      
      cpmmCache.data = {
        cpmm: [...currentCpmm.cpmm, ...newCpmm],
      };
      cpmmCache.ts = Date.now();
      
      addedCount += newCpmm.length;
      
      if (newCpmm.length > 0) {
        logger.info('discovery.integrate.raydium_cpmm', { 
          cpmm: newCpmm.length,
          cat: 'discovery' 
        });
      }
    }
    
    // Add Orca pools
    const orcaPools = enrichmentResult.pools.orca;
    if (orcaPools.clmm.length > 0) {
      const currentOrca = orcaCache.data || { amm: [], clmm: [], cpmm: [] };
      
      const existingIds = new Set(currentOrca.clmm.map((p: any) => p.id));
      const newClmm = orcaPools.clmm.filter((p: any) => p.id && !existingIds.has(p.id));
      
      // Pools are already canonicalized by normalizers
      orcaCache.data = {
        amm: currentOrca.amm || [],
        clmm: [...currentOrca.clmm, ...newClmm],
        cpmm: (currentOrca as any).cpmm || [],
      };
      orcaCache.ts = Date.now();
      
      addedCount += newClmm.length;
      
      if (newClmm.length > 0) {
        logger.info('discovery.integrate.orca', { 
          clmm: newClmm.length,
          cat: 'discovery' 
        });
      }
    }
    
    // Add Meteora pools
    const meteoraPools = enrichmentResult.pools.meteora;
    if (meteoraPools.clmm.length > 0) {
      const currentMeteora = meteoraCache.data || { amm: [], clmm: [], cpmm: [] };
      
      const existingIds = new Set(currentMeteora.clmm.map((p: any) => p.id));
      const newClmm = meteoraPools.clmm.filter((p: any) => p.id && !existingIds.has(p.id));
      
      // Pools are already canonicalized by normalizers
      meteoraCache.data = {
        amm: currentMeteora.amm || [],
        clmm: [...currentMeteora.clmm, ...newClmm],
        cpmm: (currentMeteora as any).cpmm || [],
      };
      meteoraCache.ts = Date.now();
      
      addedCount += newClmm.length;
      
      if (newClmm.length > 0) {
        logger.info('discovery.integrate.meteora', { 
          clmm: newClmm.length,
          cat: 'discovery' 
        });
      }
    }
    
    // Add PumpSwap pools to pumpswapCache
    const pumpswapPools = enrichmentResult.pools.pumpswap;
    if (pumpswapPools && pumpswapPools.amm.length > 0) {
      const currentPumpswap = pumpswapCache.data || { amm: [], clmm: [], cpmm: [] };
      
      const existingIds = new Set((currentPumpswap.amm || []).map((p: any) => p.id));
      const newAmm = pumpswapPools.amm.filter((p: any) => p.id && !existingIds.has(p.id));
      
      // Pools are already canonicalized by normalizers
      pumpswapCache.data = {
        amm: [...(currentPumpswap.amm || []), ...newAmm],
        clmm: currentPumpswap.clmm || [],
        cpmm: currentPumpswap.cpmm || [],
      };
      pumpswapCache.ts = Date.now();
      
      addedCount += newAmm.length;
      
      if (newAmm.length > 0) {
        logger.info('discovery.integrate.pumpswap', { 
          amm: newAmm.length,
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
    scheduleGraphRebuild(undefined, 200);
    
    logger.info('discovery.graph.rebuild_scheduled', { cat: 'discovery' });
  } catch (err: any) {
    logger.error('discovery.graph.rebuild_error', { 
      error: String(err?.message || err),
      cat: 'discovery' 
    });
  }
}

/**
 * Subscribe to newly discovered pools incrementally (without full retarget)
 * 
 * @param enrichmentResult The enriched pools to subscribe to
 */
async function subscribeToNewPools(enrichmentResult: any): Promise<void> {
  try {
    const { subscribeToDiscoveredPools } = await import('../pools.websockets.js');
    
    // Collect pool IDs by DEX from enrichment result
    const poolsByDex: {
      raydium?: { amm?: string[]; clmm?: string[]; cpmm?: string[] };
      orca?: { clmm?: string[] };
      meteora?: { clmm?: string[] };
      pumpswap?: { amm?: string[] };
    } = {};
    
    // Raydium pools
    const rayPools = enrichmentResult.pools.raydium;
    if (rayPools.amm.length > 0 || rayPools.clmm.length > 0 || rayPools.cpmm.length > 0) {
      poolsByDex.raydium = {
        amm: rayPools.amm.map((p: any) => p.id).filter(Boolean),
        clmm: rayPools.clmm.map((p: any) => p.id).filter(Boolean),
        cpmm: rayPools.cpmm.map((p: any) => p.id).filter(Boolean),
      };
    }
    
    // Orca pools
    const orcaPools = enrichmentResult.pools.orca;
    if (orcaPools.clmm.length > 0) {
      poolsByDex.orca = {
        clmm: orcaPools.clmm.map((p: any) => p.id).filter(Boolean),
      };
    }
    
    // Meteora pools
    const meteoraPools = enrichmentResult.pools.meteora;
    if (meteoraPools.clmm.length > 0) {
      poolsByDex.meteora = {
        clmm: meteoraPools.clmm.map((p: any) => p.id).filter(Boolean),
      };
    }
    
    // PumpSwap pools (not yet supported in enrichment, but ready for future)
    const pumpswapPools = enrichmentResult.pools.pumpswap;
    if (pumpswapPools.amm.length > 0) {
      poolsByDex.pumpswap = {
        amm: pumpswapPools.amm.map((p: any) => p.id).filter(Boolean),
      };
    }
    
    // Check if there are any pools to subscribe to
    const totalPools = 
      (poolsByDex.raydium?.amm?.length || 0) +
      (poolsByDex.raydium?.clmm?.length || 0) +
      (poolsByDex.raydium?.cpmm?.length || 0) +
      (poolsByDex.orca?.clmm?.length || 0) +
      (poolsByDex.meteora?.clmm?.length || 0) +
      (poolsByDex.pumpswap?.amm?.length || 0);
    
    if (totalPools === 0) {
      logger.debug('discovery.subscribe.no_pools', { cat: 'discovery' });
      return;
    }
    
    // Subscribe incrementally (no full retarget needed)
    const result = await subscribeToDiscoveredPools(poolsByDex);
    
    logger.info('discovery.subscribe.complete', { 
      subscribed: result.subscribed,
      errors: result.errors.length,
      cat: 'discovery' 
    });
    
  } catch (err: any) {
    logger.error('discovery.subscribe.error', { 
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
    
    logger.info('discovery.dexscreener.start', { 
      tokensToFetch: tokensToCheck.length,
      minLiquidityUsd: minLiq,
      maxPoolsPerToken,
      cat: 'discovery' 
    });
    
    const dexScreenerStart = Date.now();
    let processedTokens = 0;
    
    for (const token of tokensToCheck) {
      try {
        processedTokens++;
        
        // Log progress every 10 tokens
        if (processedTokens % 10 === 0 || processedTokens === tokensToCheck.length) {
          logger.info('discovery.dexscreener.progress', { 
            processed: processedTokens,
            total: tokensToCheck.length,
            poolsFound: result.poolsDiscovered,
            cat: 'discovery' 
          });
        }
        
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
    
    const dexScreenerDuration = Date.now() - dexScreenerStart;
    logger.info('discovery.dexscreener.complete', { 
      tokensProcessed: processedTokens,
      poolsDiscovered: result.poolsDiscovered,
      poolsFiltered: result.poolsFiltered,
      durationMs: dexScreenerDuration,
      byDex: result.byDex,
      cat: 'discovery' 
    });
    
    if (allDiscoveredPools.length === 0) {
      logger.info('discovery.cycle.no_new_pools', { cat: 'discovery' });
      result.durationMs = Date.now() - startTime;
      return result;
    }
    
    // Step 5-7: Enrich pools (includes normalization)
    logger.info('discovery.enrichment.start', { 
      poolsToEnrich: allDiscoveredPools.length,
      byDex: Object.fromEntries(
        Object.entries(result.byDex).map(([k, v]) => [k, v.discovered])
      ),
      cat: 'discovery' 
    });
    
    const enrichmentStart = Date.now();
    const enrichmentResult = await enrichDiscoveredPools(allDiscoveredPools);
    result.poolsEnriched = getEnrichedPoolCount(enrichmentResult);
    result.errors.push(...enrichmentResult.errors);
    
    const enrichmentDuration = Date.now() - enrichmentStart;
    logger.info('discovery.enrichment.complete', { 
      poolsEnriched: result.poolsEnriched,
      failed: enrichmentResult.failed.length,
      durationMs: enrichmentDuration,
      byDex: {
        raydium_amm: enrichmentResult.pools.raydium.amm.length,
        raydium_clmm: enrichmentResult.pools.raydium.clmm.length,
        raydium_cpmm: enrichmentResult.pools.raydium.cpmm.length,
        orca: enrichmentResult.pools.orca.clmm.length,
        meteora: enrichmentResult.pools.meteora.clmm.length,
      },
      cat: 'discovery' 
    });
    
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
        // Rebuild graph with new pools
        await triggerGraphRebuild();
        
        // Subscribe to new pools incrementally (no full retarget needed)
        // This runs in background to not block the discovery cycle
        subscribeToNewPools(enrichmentResult).catch(err => {
          logger.warn('discovery.cycle.subscribe_background_error', { 
            error: String(err?.message || err),
            cat: 'discovery' 
          });
        });
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

// ============================================================================
// Full Universe Discovery
// ============================================================================

/**
 * Run a full universe discovery cycle.
 * This fetches pools for ALL tokens in the token universe + Jupiter top 100.
 * Much slower than regular discovery but finds all possible pools.
 * 
 * @param options Discovery options
 * @returns Discovery result
 */
export async function runFullUniverseDiscoveryCycle(options?: {
  minLiquidityUsd?: number;
  maxPoolsPerToken?: number;
  dryRun?: boolean;
  batchSize?: number;
  batchDelayMs?: number;
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
    logger.info('discovery.full_universe.start', { 
      minLiquidity: options?.minLiquidityUsd || cfg.minLiquidityUsd,
      maxPoolsPerToken: options?.maxPoolsPerToken || cfg.maxPoolsPerToken,
      dryRun: options?.dryRun,
      cat: 'discovery' 
    });
    
    // Step 1: Get token universe
    const { computeTokenUniverse } = await import('../universe.js');
    const { CONFIG } = await import('../../utils/config.js');
    const universeMode = (CONFIG.system as any)?.tokenUniverseMode;
    const universeTokens = await computeTokenUniverse(universeMode);
    
    logger.info('discovery.full_universe.universe_loaded', { 
      universeSize: universeTokens.size,
      mode: universeMode,
      cat: 'discovery' 
    });
    
    // Step 2: Fetch Jupiter top 100 and merge
    const jupiterTokens = await fetchJupiterTopTokens();
    const allTokens = new Set(universeTokens);
    for (const jt of jupiterTokens) {
      if (jt.id) allTokens.add(jt.id);
    }
    
    logger.info('discovery.full_universe.tokens_merged', { 
      universeSize: universeTokens.size,
      jupiterSize: jupiterTokens.length,
      totalUnique: allTokens.size,
      cat: 'discovery' 
    });
    
    result.tokensChecked = allTokens.size;
    
    // Step 3: Get already tracked pool IDs (for filtering)
    const trackedPoolIds = await getTrackedPoolIds();
    
    // Step 4: Fetch DexScreener pools in batches
    const allDiscoveredPools: DiscoveredPool[] = [];
    const minLiq = options?.minLiquidityUsd ?? cfg.minLiquidityUsd;
    const maxPoolsPerToken = options?.maxPoolsPerToken ?? cfg.maxPoolsPerToken;
    const batchSize = options?.batchSize ?? 20; // Process 20 tokens at a time
    const batchDelayMs = options?.batchDelayMs ?? 2000; // 2s between batches to avoid rate limits
    
    const tokenArray = Array.from(allTokens);
    const totalBatches = Math.ceil(tokenArray.length / batchSize);
    
    logger.info('discovery.full_universe.dexscreener_start', { 
      totalTokens: tokenArray.length,
      batches: totalBatches,
      batchSize,
      batchDelayMs,
      cat: 'discovery' 
    });
    
    for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
      const batchStart = batchIdx * batchSize;
      const batchTokens = tokenArray.slice(batchStart, batchStart + batchSize);
      
      // Log progress every 10 batches
      if (batchIdx % 10 === 0 || batchIdx === totalBatches - 1) {
        logger.info('discovery.full_universe.batch_progress', { 
          batch: batchIdx + 1,
          totalBatches,
          tokensProcessed: batchStart,
          poolsFound: result.poolsDiscovered,
          cat: 'discovery' 
        });
      }
      
      // Process each token in the batch
      for (const mint of batchTokens) {
        try {
          const rawPools = await fetchDexScreenerPools(mint);
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
          
          // Track per-DEX stats
          for (const pool of mapped) {
            const dexKey = pool.mapping.dex;
            result.byDex[dexKey] = result.byDex[dexKey] || { discovered: 0, enriched: 0, added: 0 };
            result.byDex[dexKey].discovered++;
          }
          
        } catch (err: any) {
          // Don't fail the whole batch on single token error
          result.errors.push(`Token ${mint.slice(0, 8)}: ${err?.message || err}`);
        }
      }
      
      // Delay between batches to avoid rate limits
      if (batchIdx < totalBatches - 1 && batchDelayMs > 0) {
        await new Promise(r => setTimeout(r, batchDelayMs));
      }
    }
    
    logger.info('discovery.full_universe.dexscreener_complete', { 
      tokensProcessed: tokenArray.length,
      poolsDiscovered: result.poolsDiscovered,
      poolsFiltered: result.poolsFiltered,
      byDex: result.byDex,
      cat: 'discovery' 
    });
    
    result.newTokensFound = allDiscoveredPools.length; // In full universe mode, this represents new pools
    
    if (allDiscoveredPools.length === 0) {
      logger.info('discovery.full_universe.no_new_pools', { cat: 'discovery' });
      result.durationMs = Date.now() - startTime;
      return result;
    }
    
    // Step 5: Enrich pools
    logger.info('discovery.full_universe.enrichment_start', { 
      poolsToEnrich: allDiscoveredPools.length,
      cat: 'discovery' 
    });
    
    const enrichmentResult = await enrichDiscoveredPools(allDiscoveredPools);
    result.poolsEnriched = getEnrichedPoolCount(enrichmentResult);
    result.errors.push(...enrichmentResult.errors);
    
    // Update per-DEX enriched counts
    for (const dex of Object.keys(result.byDex)) {
      const enrichedCount = 
        (dex === 'raydium' ? enrichmentResult.pools.raydium.amm.length + enrichmentResult.pools.raydium.clmm.length + enrichmentResult.pools.raydium.cpmm.length : 0) +
        (dex === 'orca' ? enrichmentResult.pools.orca.clmm.length : 0) +
        (dex === 'meteora' ? enrichmentResult.pools.meteora.clmm.length : 0) +
        (dex === 'pumpswap' ? enrichmentResult.pools.pumpswap.amm.length : 0);
      result.byDex[dex].enriched = enrichedCount;
    }
    
    // Step 6: Integrate into caches and trigger graph rebuild
    if (!options?.dryRun && result.poolsEnriched > 0) {
      result.poolsAdded = await integratePoolsIntoCaches(enrichmentResult);
      
      // Update per-DEX added counts
      for (const dex of Object.keys(result.byDex)) {
        result.byDex[dex].added = result.byDex[dex].enriched;
      }
      
      if (result.poolsAdded > 0) {
        await triggerGraphRebuild();
        
        // Subscribe to new pools
        subscribeToNewPools(enrichmentResult).catch(err => {
          logger.warn('discovery.full_universe.subscribe_error', { 
            error: String(err?.message || err),
            cat: 'discovery' 
          });
        });
      }
    }
    
  } catch (err: any) {
    result.errors.push(`Full universe error: ${err?.message || err}`);
    logger.error('discovery.full_universe.error', { 
      error: String(err?.message || err),
      cat: 'discovery' 
    });
  }
  
  result.durationMs = Date.now() - startTime;
  
  logger.info('discovery.full_universe.complete', { 
    tokensChecked: result.tokensChecked,
    poolsDiscovered: result.poolsDiscovered,
    poolsEnriched: result.poolsEnriched,
    poolsAdded: result.poolsAdded,
    errors: result.errors.length,
    durationMs: result.durationMs,
    cat: 'discovery' 
  });
  
  return result;
}
