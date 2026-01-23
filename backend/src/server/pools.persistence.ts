/**
 * Pool Persistence Module
 * 
 * Provides long-term persistence of filtered pool data to disk.
 * Enables fast startup by loading cached pools instead of fetching from APIs.
 * 
 * Key features:
 * - Save filtered pools on shutdown (not deleted)
 * - Load pools on startup for immediate graph usability
 * - On-demand revalidation of tick/bin arrays via SDK
 * - Manual subscription control (user triggers via retarget)
 * - Named snapshots for different pool configurations
 * - Merge multiple snapshots together
 */

import { CONFIG } from '../utils/config.js';
import { readJson, writeJson, joinPath, ensureDir, fileExists, listDir, deleteFile } from '../utils/fs.js';
import { logger } from '../utils/logger.js';
import type { PoolsPayload, ClmmPool } from './pools/types.js';
import { 
  raydiumCache, orcaCache, meteoraCache, 
  metbalCache, pumpswapCache, cpmmCache 
} from './pools.cache.js';
import { emit } from './realtime.js';
import { executionCache } from '../execution/cache.js';
import { bulkActivatePoolIds, isLazyActivationEnabled } from './pools.activation.js';

export interface PoolsSnapshot {
  version: number;
  name?: string;
  description?: string;
  savedAt: string;
  savedAtMs: number;
  raydium: PoolsPayload;
  orca: PoolsPayload;
  meteora: PoolsPayload;
  meteoraBalanced: PoolsPayload;
  pumpswap: PoolsPayload;
  // Track which pools have been validated (for future use)
  validated?: {
    orca: string[];    // Pool IDs with validated tick arrays
    raydium: string[];
    meteora: string[]; // Pool IDs with validated bin arrays
    lastValidatedAt?: number;
  };
}

export interface SnapshotInfo {
  name: string;
  description?: string;
  savedAt: string;
  ageHours: number;
  poolCount: {
    total: number;
    raydium: number;
    orca: number;
    meteora: number;
    meteoraBalanced: number;
    pumpswap: number;
  };
  isActive: boolean;
}

export interface SnapshotMeta {
  activeSnapshot: string;
  lastUpdated: string;
}

/**
 * Options for filtering a snapshot by TVL thresholds and min pools per pair
 */
export interface SnapshotFilterOptions {
  minAmmTvl?: number;        // Minimum TVL for AMM pools (in USD)
  minClmmTvl?: number;       // Minimum TVL for CLMM pools (in USD)
  minCpmmTvl?: number;       // Minimum TVL for CPMM pools (in USD)
  minPoolsPerPair?: number;  // Minimum pools per token pair (across all DEXes)
}

const SNAPSHOT_FILE = 'filtered-pools-snapshot.json';
const SNAPSHOTS_DIR = 'pool-snapshots';
const SNAPSHOT_META_FILE = 'snapshot-meta.json';
const DEFAULT_SNAPSHOT_NAME = 'default';
const SNAPSHOT_VERSION = 2;

/**
 * Get persistence configuration
 */
function getPersistenceConfig(): { 
  enabled: boolean; 
  loadOnStartup: boolean; 
  autoStartSubscriptions: boolean;
  revalidateOnLoad: boolean;
} {
  const cfg = (CONFIG.system as any)?.poolPersistence;
  return {
    enabled: cfg?.enabled === true,
    loadOnStartup: cfg?.loadOnStartup !== false, // Default: true
    autoStartSubscriptions: cfg?.autoStartSubscriptions === true, // Default: false
    revalidateOnLoad: cfg?.revalidateOnLoad === true, // Default: false
  };
}

/**
 * Check if pool persistence is enabled
 */
export function isPersistenceEnabled(): boolean {
  return getPersistenceConfig().enabled;
}

/**
 * Check if subscriptions should auto-start (default: false for manual control)
 */
export function shouldAutoStartSubscriptions(): boolean {
  const cfg = getPersistenceConfig();
  // If persistence is disabled, use normal behavior (auto-start)
  if (!cfg.enabled) return true;
  // If persistence is enabled, respect the autoStartSubscriptions setting
  return cfg.autoStartSubscriptions;
}

/**
 * Save current pool caches to disk snapshot
 * Called on shutdown to persist filtered pools
 */
export async function savePoolsSnapshot(): Promise<boolean> {
  const cfg = getPersistenceConfig();
  if (!cfg.enabled) {
    logger.debug('pools.persistence.disabled', { cat: 'pools' });
    return false;
  }

  try {
    // Ensure cache directory exists
    await ensureDir(CONFIG.cacheDir);
    
    const snapshot: PoolsSnapshot = {
      version: SNAPSHOT_VERSION,
      savedAt: new Date().toISOString(),
      savedAtMs: Date.now(),
      raydium: raydiumCache.data || { amm: [], clmm: [], cpmm: [] },
      orca: orcaCache.data || { amm: [], clmm: [], cpmm: [] },
      meteora: meteoraCache.data || { amm: [], clmm: [], cpmm: [] },
      meteoraBalanced: metbalCache.data || { amm: [], clmm: [], cpmm: [] },
      pumpswap: pumpswapCache.data || { amm: [], clmm: [], cpmm: [] },
    };

    const counts = {
      raydium: { amm: snapshot.raydium.amm?.length || 0, clmm: snapshot.raydium.clmm?.length || 0, cpmm: snapshot.raydium.cpmm?.length || 0 },
      orca: { amm: snapshot.orca.amm?.length || 0, clmm: snapshot.orca.clmm?.length || 0, cpmm: 0 },
      meteora: { amm: snapshot.meteora.amm?.length || 0, clmm: snapshot.meteora.clmm?.length || 0, cpmm: 0 },
      meteoraBalanced: { amm: snapshot.meteoraBalanced.amm?.length || 0, clmm: 0, cpmm: 0 },
      pumpswap: { amm: snapshot.pumpswap.amm?.length || 0, clmm: 0, cpmm: 0 },
    };

    const total = Object.values(counts).reduce((sum, c) => sum + c.amm + c.clmm + (c.cpmm || 0), 0);
    if (total === 0) {
      logger.info('pools.persistence.skip', { reason: 'no pools to save', cat: 'pools' });
      return false;
    }

    const filePath = joinPath(CONFIG.cacheDir, SNAPSHOT_FILE);
    await writeJson(filePath, snapshot);
    
    logger.info('pools.persistence.saved', { 
      counts, 
      total, 
      path: filePath,
      cat: 'pools' 
    });
    
    try {
      emit('log', { 
        level: 'info', 
        message: `pools:persistence saved ${total} pools`, 
        timestamp: new Date().toISOString(), 
        context: { cat: 'pools', counts } 
      });
    } catch {}
    
    return true;
  } catch (err: any) {
    logger.error('pools.persistence.save.failed', { error: err.message, cat: 'pools' });
    return false;
  }
}

/**
 * Load pool snapshot from disk
 * Returns null if not found, invalid, or persistence disabled
 */
export async function loadPoolsSnapshot(): Promise<PoolsSnapshot | null> {
  const cfg = getPersistenceConfig();
  if (!cfg.enabled || !cfg.loadOnStartup) {
    return null;
  }

  try {
    const filePath = joinPath(CONFIG.cacheDir, SNAPSHOT_FILE);
    const snapshot = await readJson<PoolsSnapshot>(filePath, null as any);
    
    if (!snapshot) {
      logger.info('pools.persistence.not_found', { path: filePath, cat: 'pools' });
      return null;
    }
    
    // Allow version 1 and 2 for backward compatibility
    if (snapshot.version < 1 || snapshot.version > SNAPSHOT_VERSION) {
      logger.info('pools.persistence.version_mismatch', { 
        found: snapshot.version, 
        expected: SNAPSHOT_VERSION,
        cat: 'pools'
      });
      return null;
    }

    const ageMs = Date.now() - (snapshot.savedAtMs || 0);
    const ageHours = Math.round(ageMs / 3600000 * 10) / 10;
    
    const counts = {
      raydium: (snapshot.raydium?.amm?.length || 0) + (snapshot.raydium?.clmm?.length || 0) + (snapshot.raydium?.cpmm?.length || 0),
      orca: (snapshot.orca?.amm?.length || 0) + (snapshot.orca?.clmm?.length || 0),
      meteora: (snapshot.meteora?.amm?.length || 0) + (snapshot.meteora?.clmm?.length || 0),
      meteoraBalanced: (snapshot.meteoraBalanced?.amm?.length || 0),
      pumpswap: (snapshot.pumpswap?.amm?.length || 0),
    };
    
    logger.info('pools.persistence.loaded', {
      savedAt: snapshot.savedAt,
      ageHours,
      counts,
      cat: 'pools'
    });

    return snapshot;
  } catch (err: any) {
    logger.warn('pools.persistence.load.failed', { error: err.message, cat: 'pools' });
    return null;
  }
}

/**
 * Hydrate pool caches from loaded snapshot
 * Makes pools immediately available for graph building
 * Also populates the execution cache with pool metadata
 */
export function hydratePoolCaches(snapshot: PoolsSnapshot): {
  total: number;
  raydium: number;
  orca: number;
  meteora: number;
  meteoraBalanced: number;
  pumpswap: number;
  executionCachePopulated: number;
} {
  const now = Date.now();
  const savedAtMs = snapshot.savedAtMs || now;
  let executionCachePopulated = 0;
  
  // CRITICAL: Clear execution cache before populating from snapshot
  // This prevents stale data from previous runs persisting
  try {
    executionCache.clear();
    logger.debug('pools.hydrate.execution_cache_cleared', { cat: 'pools' });
  } catch (e) {
    logger.warn('pools.hydrate.execution_cache_clear_failed', { error: String(e), cat: 'pools' });
  }
  
  // Helper to ensure pools have the dex field set (for backward compatibility with older snapshots)
  // Also ensures _pipelineProcessed is set to avoid graph builder warnings
  const ensureDexField = (pools: PoolsPayload, defaultDex: string): PoolsPayload => {
    const setDex = (arr: any[], dex: string) => arr.map(p => ({ 
      ...p, 
      dex: p.dex || dex,
      _pipelineProcessed: p._pipelineProcessed ?? true // Assume snapshot pools were processed
    }));
    return {
      amm: setDex(pools.amm || [], defaultDex),
      clmm: setDex(pools.clmm || [], defaultDex),
      cpmm: setDex((pools as any).cpmm || [], defaultDex),
    };
  };

  if (snapshot.raydium) {
    raydiumCache.data = ensureDexField(snapshot.raydium, 'Raydium');
    raydiumCache.ts = savedAtMs;
    // Populate execution cache for Raydium pools
    executionCachePopulated += populateExecutionCacheFromPools(raydiumCache.data, 'Raydium');
    
    // CRITICAL: Also populate the separate cpmmCache for WebSocket subscription lookup
    // The WebSocket setup code looks at cpmmCache.data?.cpmm to find CPMM pools
    const cpmmPools = (snapshot.raydium as any).cpmm || [];
    if (cpmmPools.length > 0) {
      cpmmCache.data = { cpmm: cpmmPools.map((p: any) => ({ ...p, dex: p.dex || 'Raydium' })) };
      cpmmCache.ts = savedAtMs;
      logger.info('pools.hydrate.cpmm_cache_populated', { 
        count: cpmmPools.length, 
        cat: 'pools' 
      });
    }
  }
  if (snapshot.orca) {
    orcaCache.data = ensureDexField(snapshot.orca, 'Orca');
    orcaCache.ts = savedAtMs;
    // Populate execution cache for Orca pools
    executionCachePopulated += populateExecutionCacheFromPools(orcaCache.data, 'Orca');
  }
  if (snapshot.meteora) {
    meteoraCache.data = ensureDexField(snapshot.meteora, 'Meteora');
    meteoraCache.ts = savedAtMs;
    // Populate execution cache for Meteora pools
    executionCachePopulated += populateExecutionCacheFromPools(meteoraCache.data, 'Meteora');
  }
  if (snapshot.meteoraBalanced) {
    // MeteoraBalanced pools may have version-specific dex (MeteoraBalanced_v1 or MeteoraBalanced_v2)
    // Only set default if dex is completely missing
    const setMblDex = (arr: any[]) => arr.map(p => ({ 
      ...p, 
      dex: p.dex || (p.pool_version === 1 ? 'MeteoraBalanced_v1' : 'MeteoraBalanced_v2'),
      _pipelineProcessed: p._pipelineProcessed ?? true // Assume snapshot pools were processed
    }));
    metbalCache.data = {
      amm: setMblDex(snapshot.meteoraBalanced.amm || []),
      clmm: [],
      cpmm: [],
    };
    metbalCache.ts = savedAtMs;
    // Populate execution cache for Meteora Balanced pools
    executionCachePopulated += populateExecutionCacheFromPools(metbalCache.data, 'MeteoraBalanced');
  }
  if (snapshot.pumpswap) {
    pumpswapCache.data = ensureDexField(snapshot.pumpswap, 'Pumpswap');
    pumpswapCache.ts = savedAtMs;
    // Populate execution cache for Pumpswap pools
    executionCachePopulated += populateExecutionCacheFromPools(pumpswapCache.data, 'Pumpswap');
  }
  
  const counts = {
    raydium: (snapshot.raydium?.amm?.length || 0) + (snapshot.raydium?.clmm?.length || 0) + ((snapshot.raydium as any)?.cpmm?.length || 0),
    orca: (snapshot.orca?.amm?.length || 0) + (snapshot.orca?.clmm?.length || 0),
    meteora: (snapshot.meteora?.amm?.length || 0) + (snapshot.meteora?.clmm?.length || 0),
    meteoraBalanced: (snapshot.meteoraBalanced?.amm?.length || 0),
    pumpswap: (snapshot.pumpswap?.amm?.length || 0),
    total: 0,
    executionCachePopulated,
  };
  counts.total = counts.raydium + counts.orca + counts.meteora + counts.meteoraBalanced + counts.pumpswap;
  
  // Bulk-activate all pool IDs when lazy activation is enabled
  // This ensures pools loaded from snapshots are visible in the graph
  if (isLazyActivationEnabled()) {
    const allPoolIds: string[] = [];
    
    // Collect all pool IDs from snapshot
    if (snapshot.raydium) {
      allPoolIds.push(...(snapshot.raydium.amm || []).map(p => p.id));
      allPoolIds.push(...(snapshot.raydium.clmm || []).map(p => p.id));
      allPoolIds.push(...((snapshot.raydium as any).cpmm || []).map((p: any) => p.id));
    }
    if (snapshot.orca) {
      allPoolIds.push(...(snapshot.orca.amm || []).map(p => p.id));
      allPoolIds.push(...(snapshot.orca.clmm || []).map(p => p.id));
    }
    if (snapshot.meteora) {
      allPoolIds.push(...(snapshot.meteora.amm || []).map(p => p.id));
      allPoolIds.push(...(snapshot.meteora.clmm || []).map(p => p.id));
    }
    if (snapshot.meteoraBalanced) {
      allPoolIds.push(...(snapshot.meteoraBalanced.amm || []).map(p => p.id));
    }
    if (snapshot.pumpswap) {
      allPoolIds.push(...(snapshot.pumpswap.amm || []).map(p => p.id));
    }
    
    const activatedCount = bulkActivatePoolIds(allPoolIds);
    logger.info('pools.hydrate.bulk_activated', { 
      activatedCount, 
      totalPools: allPoolIds.length,
      lazyModeEnabled: true,
      cat: 'pools' 
    });
  }
  
  logger.info('pools.caches.hydrated', { counts, cat: 'pools' });
  
  try {
    emit('log', { 
      level: 'info', 
      message: `pools:caches hydrated ${counts.total} pools from snapshot (${executionCachePopulated} in execution cache)`, 
      timestamp: new Date().toISOString(), 
      context: { cat: 'pools', counts } 
    });
  } catch {}
  
  return counts;
}

/**
 * Populate execution cache from pool data
 * Extracts execution-critical fields from pool objects and stores in execution cache
 */
export function populateExecutionCacheFromPools(
  pools: PoolsPayload,
  dex: 'Raydium' | 'Orca' | 'Meteora' | 'MeteoraBalanced' | 'Pumpswap'
): number {
  let populated = 0;
  
  // Program IDs by DEX
  const programIds: Record<string, string> = {
    'Raydium': 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
    'Orca': 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
    'Meteora': 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
    'MeteoraBalanced': 'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB',
    'Pumpswap': '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  };
  
  const programId = programIds[dex];
  
  // Process AMM pools
  for (const pool of pools.amm || []) {
    try {
      const existing = executionCache.getStatic(pool.id) || {} as any;
      const staticData: any = {
        ...existing,
        // Use pool-level programId if available (e.g., Meteora Balanced v1 vs v2)
        programId: (pool as any).programId || programId,
        dex,
        pool_kind: 'amm',
        mint_a: pool.mint_a,
        mint_b: pool.mint_b,
        decimals_a: pool.decimals_a,
        decimals_b: pool.decimals_b,
      };
      
      // Store vault/account references
      if (pool.account_a) staticData.account_a = pool.account_a;
      if (pool.account_b) staticData.account_b = pool.account_b;
      if ((pool as any).native_account_a) staticData.native_account_a = (pool as any).native_account_a;
      if ((pool as any).native_account_b) staticData.native_account_b = (pool as any).native_account_b;
      if ((pool as any).native_mint_a) staticData.native_mint_a = (pool as any).native_mint_a;
      if ((pool as any).native_mint_b) staticData.native_mint_b = (pool as any).native_mint_b;
      
      executionCache.setStatic(pool.id, staticData);
      populated++;
    } catch {}
  }
  
  // Process CLMM pools
  for (const pool of pools.clmm || []) {
    try {
      const existing = executionCache.getStatic(pool.id) || {} as any;
      const staticData: any = {
        ...existing,
        programId,
        dex,
        pool_kind: 'clmm',
        mint_a: pool.mint_a,
        mint_b: pool.mint_b,
        decimals_a: pool.decimals_a,
        decimals_b: pool.decimals_b,
      };
      
      // Store CLMM-specific fields
      if (pool.tick_spacing) staticData.tick_spacing = pool.tick_spacing;
      if ((pool as any).bin_step) staticData.binStep = (pool as any).bin_step;
      if (pool.account_a) staticData.account_a = pool.account_a;
      if (pool.account_b) staticData.account_b = pool.account_b;
      if ((pool as any).native_account_a) staticData.native_account_a = (pool as any).native_account_a;
      if ((pool as any).native_account_b) staticData.native_account_b = (pool as any).native_account_b;
      if ((pool as any).native_mint_a) staticData.native_mint_a = (pool as any).native_mint_a;
      if ((pool as any).native_mint_b) staticData.native_mint_b = (pool as any).native_mint_b;
      // CRITICAL: Store was_swapped flag for direction fallback when native_mint_a is missing
      if ((pool as any).was_swapped !== undefined) staticData.was_swapped = (pool as any).was_swapped;
      
      // Raydium CLMM-specific
      if ((pool as any).observation_state) staticData.observation_state = (pool as any).observation_state;
      if ((pool as any).ex_bitmap) staticData.ex_bitmap = (pool as any).ex_bitmap;
      if ((pool as any).amm_config) staticData.amm_config = (pool as any).amm_config;
      
      // Tick arrays (Raydium CLMM and Orca Whirlpool) - CRITICAL for swap execution
      // These should be validated arrays from pool fetch or websocket updates
      // Note: null means "explicitly cleared/non-existent", undefined means "unknown"
      const poolTickArrayLower = (pool as any).tick_array_lower ?? (pool as any).tickArrayLower;
      const poolTickArrayCenter = (pool as any).tick_array_center ?? (pool as any).tickArrayCenter;
      const poolTickArrayUpper = (pool as any).tick_array_upper ?? (pool as any).tickArrayUpper;
      
      // Only set if we have a real value (not null = explicitly cleared)
      if (poolTickArrayLower && poolTickArrayLower !== null) {
        staticData.tickArrayLower = poolTickArrayLower;
      }
      if (poolTickArrayCenter && poolTickArrayCenter !== null) {
        staticData.tickArrayCenter = poolTickArrayCenter;
      }
      if (poolTickArrayUpper && poolTickArrayUpper !== null) {
        staticData.tickArrayUpper = poolTickArrayUpper;
      }
      
      // Orca Whirlpool-specific
      if ((pool as any).oracle) staticData.oracle = (pool as any).oracle;
      if ((pool as any).token_vault_a) staticData.token_vault_a = (pool as any).token_vault_a;
      if ((pool as any).token_vault_b) staticData.token_vault_b = (pool as any).token_vault_b;
      
      // Meteora DLMM-specific
      if ((pool as any).bin_array_bitmap_extension) {
        staticData.bin_array_bitmap_extension = (pool as any).bin_array_bitmap_extension;
      }
      if ((pool as any).token_program_a) staticData.token_program_a = (pool as any).token_program_a;
      if ((pool as any).token_program_b) staticData.token_program_b = (pool as any).token_program_b;
      
      // Meteora bin arrays - only set if not null (null = explicitly cleared)
      const poolBinArrayLower = (pool as any).bin_array_lower;
      const poolBinArrayUpper = (pool as any).bin_array_upper;
      if (poolBinArrayLower && poolBinArrayLower !== null) {
        staticData.bin_array_lower = poolBinArrayLower;
      }
      if (poolBinArrayUpper && poolBinArrayUpper !== null) {
        staticData.bin_array_upper = poolBinArrayUpper;
      }
      
      executionCache.setStatic(pool.id, staticData);
      populated++;
      
      // DIAGNOSTIC: Log warning for Orca pools missing native_mint_a (potential InvalidTickArraySequence source)
      if (dex === 'Orca' && !staticData.native_mint_a) {
        logger.warn('pools.persistence.orca.missing_native_mint', {
          cat: 'pools',
          poolId: pool.id?.slice(0, 12) + '...',
          hasWasSwapped: staticData.was_swapped !== undefined,
          hasMintA: !!staticData.mint_a,
          hasMintB: !!staticData.mint_b,
          hint: 'Pool loaded from snapshot without native_mint_a - may cause InvalidTickArraySequence errors',
        });
      }
      
      // Also populate hot cache with price/tick data if available
      const hotData: any = {};
      let hasHotData = false;
      
      if (pool.sqrt_price_x64 !== undefined) {
        hotData.sqrtPriceX64 = BigInt(String(pool.sqrt_price_x64));
        hasHotData = true;
      }
      // Support both field names: tick_current_index (current) and tick_current (legacy)
      const tickCurrentIndex = (pool as any).tick_current_index ?? (pool as any).native_tick_current_index ?? (pool as any).tick_current;
      if (tickCurrentIndex !== undefined) {
        hotData.currentTickIndex = Number(tickCurrentIndex);
        hasHotData = true;
      }
      if ((pool as any).active_id !== undefined) {
        hotData.activeId = (pool as any).active_id;
        hasHotData = true;
      }
      if (pool.tick_spacing) {
        hotData.tickSpacing = pool.tick_spacing;
        hasHotData = true;
      }
      if ((pool as any).bin_step) {
        hotData.binStep = (pool as any).bin_step;
        hasHotData = true;
      }
      if (pool.liquidity !== undefined) {
        hotData.liquidity = BigInt(String(pool.liquidity));
        hasHotData = true;
      }
      if (pool.fee_bps !== undefined) {
        hotData.feeRate = pool.fee_bps;
        hasHotData = true;
      }
      
      // Tick arrays for hot cache - CRITICAL for swap execution
      // Check multiple possible field names from different sources
      // Note: null means "explicitly cleared/non-existent", don't include in cache
      const tickArrayLower = (pool as any).tick_array_lower ?? (pool as any).tickArrayLower;
      const tickArrayCenter = (pool as any).tick_array_center ?? (pool as any).tickArrayCenter;
      const tickArrayUpper = (pool as any).tick_array_upper ?? (pool as any).tickArrayUpper;
      
      // Only set tick arrays if center exists and is not null (explicitly cleared)
      if (tickArrayCenter && tickArrayCenter !== null) {
        // Store in format expected by resolvers: { center: string, lower: string[], upper: string[] }
        hotData.tickArrays = {
          center: tickArrayCenter,
          // Only include lower/upper if they exist and are not null
          lower: (tickArrayLower && tickArrayLower !== null) ? [tickArrayLower] : undefined,
          upper: (tickArrayUpper && tickArrayUpper !== null) ? [tickArrayUpper] : undefined,
        };
        hasHotData = true;
      }
      
      // Meteora bin arrays for hot cache
      // Note: null means "explicitly cleared/non-existent", don't include in cache
      const binArrayLower = (pool as any).bin_array_lower;
      const binArrayUpper = (pool as any).bin_array_upper;
      if ((binArrayLower && binArrayLower !== null) || (binArrayUpper && binArrayUpper !== null)) {
        hotData.binArrays = {
          lower: (binArrayLower && binArrayLower !== null) ? binArrayLower : undefined,
          upper: (binArrayUpper && binArrayUpper !== null) ? binArrayUpper : undefined,
        };
        hasHotData = true;
      }
      
      if (hasHotData) {
        const existingHot = executionCache.getHot(pool.id) || {};
        executionCache.setHot(pool.id, { ...existingHot, ...hotData });
      }
    } catch {}
  }
  
  // Process CPMM pools (Raydium CPMM)
  for (const pool of pools.cpmm || []) {
    try {
      const existing = executionCache.getStatic(pool.id) || {} as any;
      const cpmmProgramId = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';
      const staticData: any = {
        ...existing,
        programId: (pool as any).programId || cpmmProgramId,
        dex,
        pool_kind: 'cpmm',
        mint_a: pool.mint_a,
        mint_b: pool.mint_b,
        decimals_a: pool.decimals_a,
        decimals_b: pool.decimals_b,
      };
      
      // Store vault/account references
      if (pool.account_a) staticData.account_a = pool.account_a;
      if (pool.account_b) staticData.account_b = pool.account_b;
      if ((pool as any).vault_a) staticData.vault_a = (pool as any).vault_a;
      if ((pool as any).vault_b) staticData.vault_b = (pool as any).vault_b;
      if ((pool as any).amm_config) staticData.amm_config = (pool as any).amm_config;
      // CPMM pools use observation_key (not observation_state like CLMM)
      if ((pool as any).observation_key) staticData.observation_key = (pool as any).observation_key;
      if ((pool as any).native_account_a) staticData.native_account_a = (pool as any).native_account_a;
      if ((pool as any).native_account_b) staticData.native_account_b = (pool as any).native_account_b;
      
      executionCache.setStatic(pool.id, staticData);
      populated++;
      
      // Populate hot cache with price data if available
      const hotData: any = {};
      let hasHotData = false;
      
      if ((pool as any).reserve_a !== undefined) {
        hotData.reserve_a = BigInt(String((pool as any).reserve_a));
        hasHotData = true;
      }
      if ((pool as any).reserve_b !== undefined) {
        hotData.reserve_b = BigInt(String((pool as any).reserve_b));
        hasHotData = true;
      }
      if (pool.fee_bps !== undefined) {
        hotData.feeRate = pool.fee_bps;
        hasHotData = true;
      }
      if ((pool as any).protocol_fee_bps !== undefined) {
        hotData.protocolFeeRate = (pool as any).protocol_fee_bps;
        hasHotData = true;
      }
      
      if (hasHotData) {
        const existingHot = executionCache.getHot(pool.id) || {};
        executionCache.setHot(pool.id, { ...existingHot, ...hotData });
      }
    } catch {}
  }
  
  return populated;
}

/**
 * Initialize pools from persisted snapshot on startup
 * Returns true if pools were loaded and graph was built, false if fresh fetch needed
 */
export async function initializeFromSnapshot(): Promise<boolean> {
  const cfg = getPersistenceConfig();
  if (!cfg.enabled) {
    logger.debug('pools.persistence.init.disabled', { cat: 'pools' });
    return false;
  }
  
  const snapshot = await loadPoolsSnapshot();
  if (!snapshot) {
    logger.info('pools.persistence.init.no_snapshot', { cat: 'pools' });
    return false;
  }
  
  const counts = hydratePoolCaches(snapshot);
  
  if (counts.total === 0) {
    logger.info('pools.persistence.init.empty_snapshot', { cat: 'pools' });
    return false;
  }
  
  // Trigger initial graph build with loaded pools
  try {
    const { rebuildGraphNow } = await import('./graph.js');
    await rebuildGraphNow(undefined, { pushToArb: false });
    logger.info('pools.persistence.graph_built', { poolCount: counts.total, source: 'persistence_load', cat: 'pools' });
    
    try {
      emit('log', {
        level: 'info',
        message: `pools:persistence graph built with ${counts.total} pools - use retarget to start subscriptions`,
        timestamp: new Date().toISOString(),
        context: { cat: 'pools' }
      });
    } catch {}
  } catch (err: any) {
    logger.warn('pools.persistence.graph_build_failed', { error: err.message, cat: 'pools' });
    // Still return true - caches are hydrated, graph may work later
  }
  
  // Optional: auto-revalidate on load
  if (cfg.revalidateOnLoad) {
    try {
      logger.info('pools.persistence.auto_revalidate.start', { 
        cat: 'pools',
        validateAll: true,
        poolsInSnapshot: counts.total,
        clmmPools: {
          raydium: snapshot.raydium?.clmm?.length || 0,
          orca: snapshot.orca?.clmm?.length || 0,
          meteora: snapshot.meteora?.clmm?.length || 0,
        }
      });
      const { revalidateAllPools } = await import('./pools.revalidate.js');
      // Validate ALL pools in cache, not just a subset
      const result = await revalidateAllPools({ validateAll: true, concurrency: 10 });
      logger.info('pools.persistence.auto_revalidate.done', { 
        healthPercent: result.healthPercent,
        refreshed: result.refreshed,
        cat: 'pools'
      });
    } catch (err: any) {
      logger.warn('pools.persistence.auto_revalidate.failed', { error: err.message, cat: 'pools' });
    }
  }
  
  return true;
}

/**
 * Get the snapshot file path
 */
export function getSnapshotFilePath(): string {
  return joinPath(CONFIG.cacheDir, SNAPSHOT_FILE);
}

/**
 * Get the snapshot filename (for use in cache cleanup exclusions)
 */
export function getSnapshotFileName(): string {
  return SNAPSHOT_FILE;
}

/**
 * Check if a snapshot file exists
 */
export async function snapshotExists(): Promise<boolean> {
  try {
    const snapshot = await readJson(getSnapshotFilePath(), null as any);
    return snapshot !== null;
  } catch {
    return false;
  }
}

// ============================================================================
// NAMED SNAPSHOTS - Save, load, and manage multiple pool configurations
// ============================================================================

/**
 * Get the snapshots directory path
 */
function getSnapshotsDir(): string {
  return joinPath(CONFIG.cacheDir, SNAPSHOTS_DIR);
}

/**
 * Get the snapshot meta file path
 */
function getSnapshotMetaPath(): string {
  return joinPath(CONFIG.cacheDir, SNAPSHOT_META_FILE);
}

/**
 * Sanitize snapshot name for use as filename
 */
function sanitizeSnapshotName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50) || 'unnamed';
}

/**
 * Get the file path for a named snapshot
 */
function getNamedSnapshotPath(name: string): string {
  const sanitized = sanitizeSnapshotName(name);
  return joinPath(getSnapshotsDir(), `${sanitized}.json`);
}

/**
 * Load the snapshot metadata (tracks active snapshot)
 */
async function loadSnapshotMeta(): Promise<SnapshotMeta> {
  try {
    const meta = await readJson<SnapshotMeta>(getSnapshotMetaPath(), null as any);
    return meta || { activeSnapshot: DEFAULT_SNAPSHOT_NAME, lastUpdated: new Date().toISOString() };
  } catch {
    return { activeSnapshot: DEFAULT_SNAPSHOT_NAME, lastUpdated: new Date().toISOString() };
  }
}

/**
 * Save the snapshot metadata
 */
async function saveSnapshotMeta(meta: SnapshotMeta): Promise<void> {
  try {
    await ensureDir(CONFIG.cacheDir);
    await writeJson(getSnapshotMetaPath(), meta);
  } catch (err: any) {
    logger.warn('pools.snapshot.meta.save.failed', { error: err.message, cat: 'pools' });
  }
}

/**
 * Get the name of the currently active snapshot
 */
export async function getActiveSnapshotName(): Promise<string> {
  const meta = await loadSnapshotMeta();
  return meta.activeSnapshot;
}

/**
 * Build current pools into a snapshot object
 */
function buildCurrentSnapshot(name?: string, description?: string): PoolsSnapshot {
  return {
    version: SNAPSHOT_VERSION,
    name,
    description,
    savedAt: new Date().toISOString(),
    savedAtMs: Date.now(),
    raydium: raydiumCache.data || { amm: [], clmm: [], cpmm: [] },
    orca: orcaCache.data || { amm: [], clmm: [], cpmm: [] },
    meteora: meteoraCache.data || { amm: [], clmm: [], cpmm: [] },
    meteoraBalanced: metbalCache.data || { amm: [], clmm: [], cpmm: [] },
    pumpswap: pumpswapCache.data || { amm: [], clmm: [], cpmm: [] },
  };
}

/**
 * Count pools in a snapshot
 */
function countSnapshotPools(snapshot: PoolsSnapshot): {
  total: number;
  raydium: number;
  orca: number;
  meteora: number;
  meteoraBalanced: number;
  pumpswap: number;
} {
  const counts = {
    raydium: (snapshot.raydium?.amm?.length || 0) + (snapshot.raydium?.clmm?.length || 0) + (snapshot.raydium?.cpmm?.length || 0),
    orca: (snapshot.orca?.amm?.length || 0) + (snapshot.orca?.clmm?.length || 0),
    meteora: (snapshot.meteora?.amm?.length || 0) + (snapshot.meteora?.clmm?.length || 0),
    meteoraBalanced: (snapshot.meteoraBalanced?.amm?.length || 0),
    pumpswap: (snapshot.pumpswap?.amm?.length || 0),
    total: 0,
  };
  counts.total = counts.raydium + counts.orca + counts.meteora + counts.meteoraBalanced + counts.pumpswap;
  return counts;
}

/**
 * Extract TVL value from a pool object (unified logic for all pool types)
 */
function getPoolTvl(pool: any, poolKind: 'amm' | 'clmm' | 'cpmm'): number {
  // Prefer tvl_usd when available
  const tvl = Number(pool?.tvl_usd ?? 0);
  if (Number.isFinite(tvl) && tvl > 0) return tvl;
  
  // Fall back to liquidity_display
  const disp = Number(pool?.liquidity_display ?? 0);
  if (Number.isFinite(disp) && disp > 0) return disp;
  
  // Pool-kind specific fallbacks
  if (poolKind === 'amm' || poolKind === 'cpmm') {
    const base = Number(pool?.liquidity_base ?? 0);
    if (Number.isFinite(base) && base > 0) return base;
  } else {
    // CLMM fallback chain
    const liq = Number(pool?.liquidity ?? 0);
    if (Number.isFinite(liq) && liq > 0) return liq;
    const raw = Number(pool?.pool_liquidity_raw ?? 0);
    if (Number.isFinite(raw) && raw > 0) return raw;
  }
  
  return 0;
}

/**
 * Filter a PoolsPayload by TVL thresholds
 */
function filterPoolsPayloadByTvl(
  pools: PoolsPayload,
  options: SnapshotFilterOptions
): PoolsPayload {
  const { minAmmTvl = 0, minClmmTvl = 0, minCpmmTvl = 0 } = options;
  
  return {
    amm: minAmmTvl > 0
      ? pools.amm.filter(p => getPoolTvl(p, 'amm') >= minAmmTvl)
      : pools.amm,
    clmm: minClmmTvl > 0
      ? pools.clmm.filter(p => getPoolTvl(p, 'clmm') >= minClmmTvl)
      : pools.clmm,
    cpmm: minCpmmTvl > 0
      ? (pools.cpmm || []).filter(p => getPoolTvl(p, 'cpmm') >= minCpmmTvl)
      : (pools.cpmm || []),
  };
}

/**
 * Create canonical pair key from two mints (sorted alphabetically)
 */
function canonicalPairKey(mintA: string, mintB: string): string {
  const a = String(mintA || '');
  const b = String(mintB || '');
  return a <= b ? `${a}-${b}` : `${b}-${a}`;
}

/**
 * Apply minPoolsPerPair filter across an entire snapshot
 * This counts pools across ALL DEXes and only keeps pairs with >= minPools total pools
 */
function filterSnapshotByMinPools(snapshot: PoolsSnapshot, minPools: number): PoolsSnapshot {
  if (minPools <= 1) return snapshot;
  
  // Count pools per pair across all DEXes
  const poolCounts = new Map<string, number>();
  
  const countPools = (arr: any[]) => {
    for (const p of (arr || [])) {
      if (!p?.mint_a || !p?.mint_b) continue;
      const pairKey = canonicalPairKey(p.mint_a, p.mint_b);
      poolCounts.set(pairKey, (poolCounts.get(pairKey) || 0) + 1);
    }
  };
  
  // Count across all DEXes
  countPools(snapshot.raydium?.amm);
  countPools(snapshot.raydium?.clmm);
  countPools(snapshot.raydium?.cpmm);
  countPools(snapshot.orca?.amm);
  countPools(snapshot.orca?.clmm);
  countPools(snapshot.meteora?.amm);
  countPools(snapshot.meteora?.clmm);
  countPools(snapshot.meteoraBalanced?.amm);
  countPools(snapshot.pumpswap?.amm);
  
  // Build set of allowed pairs
  const allowedPairs = new Set<string>();
  for (const [pairKey, count] of poolCounts.entries()) {
    if (count >= minPools) {
      allowedPairs.add(pairKey);
    }
  }
  
  // Filter function
  const filterByPair = <T extends { mint_a: string; mint_b: string }>(arr: T[]): T[] =>
    (arr || []).filter(p => allowedPairs.has(canonicalPairKey(p.mint_a, p.mint_b)));
  
  return {
    ...snapshot,
    raydium: {
      amm: filterByPair(snapshot.raydium?.amm || []),
      clmm: filterByPair(snapshot.raydium?.clmm || []),
      cpmm: filterByPair(snapshot.raydium?.cpmm || []),
    },
    orca: {
      amm: filterByPair(snapshot.orca?.amm || []),
      clmm: filterByPair(snapshot.orca?.clmm || []),
      cpmm: [],
    },
    meteora: {
      amm: filterByPair(snapshot.meteora?.amm || []),
      clmm: filterByPair(snapshot.meteora?.clmm || []),
      cpmm: [],
    },
    meteoraBalanced: {
      amm: filterByPair(snapshot.meteoraBalanced?.amm || []),
      clmm: [],
      cpmm: [],
    },
    pumpswap: {
      amm: filterByPair(snapshot.pumpswap?.amm || []),
      clmm: [],
      cpmm: [],
    },
  };
}

/**
 * Filter a snapshot by TVL thresholds, min pools per pair, and optionally save to a new snapshot
 */
export async function filterSnapshot(
  sourceName: string,
  options: SnapshotFilterOptions & {
    saveTo?: string;         // If provided, save filtered result as new snapshot
    buildGraph?: boolean;    // If true, build graph after filtering (default: true)
    setActive?: boolean;     // If true, set as active snapshot (default: true)
  }
): Promise<{ 
  success: boolean; 
  poolCount: number; 
  beforeCount: number;
  filteredOut: number;
  savedAs?: string;
  error?: string;
}> {
  const sanitizedName = sanitizeSnapshotName(sourceName);
  
  try {
    // Load source snapshot
    const filePath = getNamedSnapshotPath(sanitizedName);
    const snapshot = await readJson<PoolsSnapshot>(filePath, null as any);
    
    if (!snapshot) {
      return { success: false, poolCount: 0, beforeCount: 0, filteredOut: 0, error: 'Snapshot not found' };
    }
    
    const beforeCounts = countSnapshotPools(snapshot);
    
    // Step 1: Apply TVL filtering first
    let filteredSnapshot: PoolsSnapshot = {
      ...snapshot,
      name: options.saveTo ? sanitizeSnapshotName(options.saveTo) : snapshot.name,
      description: options.saveTo 
        ? `Filtered from "${sanitizedName}" (minAmm=${options.minAmmTvl || 0}, minClmm=${options.minClmmTvl || 0}, minCpmm=${options.minCpmmTvl || 0}, minPools=${options.minPoolsPerPair || 1})`
        : snapshot.description,
      savedAt: new Date().toISOString(),
      savedAtMs: Date.now(),
      raydium: filterPoolsPayloadByTvl(snapshot.raydium || { amm: [], clmm: [], cpmm: [] }, options),
      orca: filterPoolsPayloadByTvl(snapshot.orca || { amm: [], clmm: [], cpmm: [] }, options),
      meteora: filterPoolsPayloadByTvl(snapshot.meteora || { amm: [], clmm: [], cpmm: [] }, options),
      meteoraBalanced: filterPoolsPayloadByTvl(snapshot.meteoraBalanced || { amm: [], clmm: [], cpmm: [] }, options),
      pumpswap: filterPoolsPayloadByTvl(snapshot.pumpswap || { amm: [], clmm: [], cpmm: [] }, options),
    };
    
    // Step 2: Apply minPoolsPerPair filter (across all DEXes)
    const minPools = options.minPoolsPerPair || 1;
    if (minPools > 1) {
      filteredSnapshot = filterSnapshotByMinPools(filteredSnapshot, minPools);
    }
    
    const afterCounts = countSnapshotPools(filteredSnapshot);
    const filteredOut = beforeCounts.total - afterCounts.total;
    
    // Hydrate caches with filtered data
    hydratePoolCaches(filteredSnapshot);
    
    let savedAs: string | undefined;
    
    // Save if requested
    if (options.saveTo) {
      savedAs = sanitizeSnapshotName(options.saveTo);
      const savePath = getNamedSnapshotPath(savedAs);
      await ensureDir(getSnapshotsDir());
      await writeJson(savePath, filteredSnapshot);
      
      if (options.setActive !== false) {
        await saveSnapshotMeta({
          activeSnapshot: savedAs,
          lastUpdated: new Date().toISOString(),
        });
      }
    } else if (options.setActive !== false) {
      // Update active snapshot to source if not saving to new
      await saveSnapshotMeta({
        activeSnapshot: sanitizedName,
        lastUpdated: new Date().toISOString(),
      });
    }
    
    // Build graph if requested
    if (options.buildGraph !== false) {
      try {
        const { rebuildGraphNow } = await import('./graph.js');
        await rebuildGraphNow(undefined, { pushToArb: false });
      } catch (err: any) {
        logger.warn('pools.snapshot.filter.graph_build.failed', { error: err.message, cat: 'pools' });
      }
    }
    
    logger.info('pools.snapshot.filtered', {
      source: sanitizedName,
      saveTo: options.saveTo,
      savedAs,
      before: beforeCounts.total,
      after: afterCounts.total,
      filteredOut,
      options: { minAmmTvl: options.minAmmTvl, minClmmTvl: options.minClmmTvl, minCpmmTvl: options.minCpmmTvl, minPoolsPerPair: options.minPoolsPerPair },
      cat: 'pools'
    });
    
    try {
      emit('log', {
        level: 'info',
        message: `pools:snapshot filtered "${sanitizedName}" → ${afterCounts.total} pools (removed ${filteredOut})`,
        timestamp: new Date().toISOString(),
        context: { cat: 'pools' }
      });
    } catch {}
    
    return { 
      success: true, 
      poolCount: afterCounts.total, 
      beforeCount: beforeCounts.total,
      filteredOut,
      savedAs,
    };
  } catch (err: any) {
    logger.error('pools.snapshot.filter.failed', { source: sanitizedName, error: err.message, cat: 'pools' });
    return { success: false, poolCount: 0, beforeCount: 0, filteredOut: 0, error: err.message };
  }
}

/**
 * Save current pools as a named snapshot
 */
export async function saveNamedSnapshot(
  name: string,
  options?: { description?: string; setActive?: boolean }
): Promise<{ success: boolean; name: string; poolCount: number; error?: string }> {
  const sanitizedName = sanitizeSnapshotName(name);
  
  try {
    await ensureDir(getSnapshotsDir());
    
    const snapshot = buildCurrentSnapshot(sanitizedName, options?.description);
    const counts = countSnapshotPools(snapshot);
    
    if (counts.total === 0) {
      return { success: false, name: sanitizedName, poolCount: 0, error: 'No pools to save' };
    }
    
    const filePath = getNamedSnapshotPath(sanitizedName);
    await writeJson(filePath, snapshot);
    
    // Update active snapshot if requested
    if (options?.setActive !== false) {
      await saveSnapshotMeta({
        activeSnapshot: sanitizedName,
        lastUpdated: new Date().toISOString(),
      });
    }
    
    logger.info('pools.snapshot.saved', {
      name: sanitizedName,
      poolCount: counts.total,
      counts,
      cat: 'pools'
    });
    
    try {
      emit('log', {
        level: 'info',
        message: `pools:snapshot "${sanitizedName}" saved with ${counts.total} pools`,
        timestamp: new Date().toISOString(),
        context: { cat: 'pools' }
      });
    } catch {}
    
    return { success: true, name: sanitizedName, poolCount: counts.total };
  } catch (err: any) {
    logger.error('pools.snapshot.save.failed', { name: sanitizedName, error: err.message, cat: 'pools' });
    return { success: false, name: sanitizedName, poolCount: 0, error: err.message };
  }
}

/**
 * Load a named snapshot
 */
export async function loadNamedSnapshot(
  name: string,
  options?: { buildGraph?: boolean; setActive?: boolean }
): Promise<{ success: boolean; name: string; poolCount: number; error?: string }> {
  const sanitizedName = sanitizeSnapshotName(name);
  
  try {
    const filePath = getNamedSnapshotPath(sanitizedName);
    const snapshot = await readJson<PoolsSnapshot>(filePath, null as any);
    
    if (!snapshot) {
      return { success: false, name: sanitizedName, poolCount: 0, error: 'Snapshot not found' };
    }
    
    // Hydrate caches
    const counts = hydratePoolCaches(snapshot);
    
    // Update active snapshot
    if (options?.setActive !== false) {
      await saveSnapshotMeta({
        activeSnapshot: sanitizedName,
        lastUpdated: new Date().toISOString(),
      });
    }
    
    // Build graph if requested
    if (options?.buildGraph !== false) {
      try {
        const { rebuildGraphNow } = await import('./graph.js');
        await rebuildGraphNow(undefined, { pushToArb: false });
      } catch (err: any) {
        logger.warn('pools.snapshot.graph_build.failed', { error: err.message, cat: 'pools' });
      }
    }
    
    logger.info('pools.snapshot.loaded', {
      name: sanitizedName,
      poolCount: counts.total,
      counts,
      cat: 'pools'
    });
    
    try {
      emit('log', {
        level: 'info',
        message: `pools:snapshot "${sanitizedName}" loaded with ${counts.total} pools`,
        timestamp: new Date().toISOString(),
        context: { cat: 'pools' }
      });
    } catch {}
    
    return { success: true, name: sanitizedName, poolCount: counts.total };
  } catch (err: any) {
    logger.error('pools.snapshot.load.failed', { name: sanitizedName, error: err.message, cat: 'pools' });
    return { success: false, name: sanitizedName, poolCount: 0, error: err.message };
  }
}

/**
 * List all available snapshots
 */
export async function listSnapshots(): Promise<SnapshotInfo[]> {
  const snapshots: SnapshotInfo[] = [];
  const activeName = await getActiveSnapshotName();
  
  try {
    await ensureDir(getSnapshotsDir());
    const files = await listDir(getSnapshotsDir());
    const jsonFiles = files.filter(f => f.endsWith('.json'));
    
    for (const file of jsonFiles) {
      try {
        const filePath = joinPath(getSnapshotsDir(), file);
        const snapshot = await readJson<PoolsSnapshot>(filePath, null as any);
        
        if (snapshot) {
          const name = file.replace('.json', '');
          const counts = countSnapshotPools(snapshot);
          const ageMs = Date.now() - (snapshot.savedAtMs || 0);
          
          snapshots.push({
            name,
            description: snapshot.description,
            savedAt: snapshot.savedAt,
            ageHours: Math.round(ageMs / 3600000 * 10) / 10,
            poolCount: counts,
            isActive: name === activeName,
          });
        }
      } catch {}
    }
    
    // Sort by most recently saved
    snapshots.sort((a, b) => new Date(b.savedAt).getTime() - new Date(a.savedAt).getTime());
  } catch (err: any) {
    logger.warn('pools.snapshots.list.failed', { error: err.message, cat: 'pools' });
  }
  
  return snapshots;
}

/**
 * Delete a named snapshot
 */
export async function deleteNamedSnapshot(name: string): Promise<{ success: boolean; error?: string }> {
  const sanitizedName = sanitizeSnapshotName(name);
  
  // Prevent deleting the active snapshot
  const activeName = await getActiveSnapshotName();
  if (sanitizedName === activeName) {
    return { success: false, error: 'Cannot delete the active snapshot' };
  }
  
  try {
    const filePath = getNamedSnapshotPath(sanitizedName);
    await deleteFile(filePath);
    
    logger.info('pools.snapshot.deleted', { name: sanitizedName, cat: 'pools' });
    
    return { success: true };
  } catch (err: any) {
    logger.error('pools.snapshot.delete.failed', { name: sanitizedName, error: err.message, cat: 'pools' });
    return { success: false, error: err.message };
  }
}

/**
 * Merge multiple snapshots together
 * Mode: 'union' combines all pools, 'intersection' keeps only common pools
 */
export async function mergeSnapshots(
  names: string[],
  options?: { 
    mode?: 'union' | 'intersection';
    buildGraph?: boolean;
    saveTo?: string;
  }
): Promise<{ success: boolean; poolCount: number; error?: string }> {
  const mode = options?.mode || 'union';
  
  if (names.length === 0) {
    return { success: false, poolCount: 0, error: 'No snapshots specified' };
  }
  
  try {
    // Load all snapshots
    const loadedSnapshots: PoolsSnapshot[] = [];
    for (const name of names) {
      const sanitizedName = sanitizeSnapshotName(name);
      const filePath = getNamedSnapshotPath(sanitizedName);
      const snapshot = await readJson<PoolsSnapshot>(filePath, null as any);
      if (snapshot) {
        loadedSnapshots.push(snapshot);
      } else {
        logger.warn('pools.snapshot.merge.missing', { name: sanitizedName, cat: 'pools' });
      }
    }
    
    if (loadedSnapshots.length === 0) {
      return { success: false, poolCount: 0, error: 'No valid snapshots found' };
    }
    
    // Merge function for pool arrays
    const mergePools = <T extends { id: string }>(arrays: T[][], mode: 'union' | 'intersection'): T[] => {
      if (arrays.length === 0) return [];
      if (arrays.length === 1) return arrays[0] || [];
      
      if (mode === 'union') {
        // Combine all, deduplicate by ID
        const poolMap = new Map<string, T>();
        for (const arr of arrays) {
          for (const pool of (arr || [])) {
            if (pool?.id && !poolMap.has(pool.id)) {
              poolMap.set(pool.id, pool);
            }
          }
        }
        return Array.from(poolMap.values());
      } else {
        // Intersection: keep only pools present in all snapshots
        const firstIds = new Set((arrays[0] || []).map(p => p?.id).filter(Boolean));
        for (let i = 1; i < arrays.length; i++) {
          const currentIds = new Set((arrays[i] || []).map(p => p?.id).filter(Boolean));
          for (const id of firstIds) {
            if (!currentIds.has(id)) {
              firstIds.delete(id);
            }
          }
        }
        // Return pools from first snapshot that are in intersection
        return (arrays[0] || []).filter(p => p?.id && firstIds.has(p.id));
      }
    };
    
    // Merge each DEX's pools
    const mergedSnapshot: PoolsSnapshot = {
      version: SNAPSHOT_VERSION,
      name: options?.saveTo ? sanitizeSnapshotName(options.saveTo) : undefined,
      description: `Merged from: ${names.join(', ')} (${mode})`,
      savedAt: new Date().toISOString(),
      savedAtMs: Date.now(),
      raydium: {
        amm: mergePools(loadedSnapshots.map(s => s.raydium?.amm || []), mode),
        clmm: mergePools(loadedSnapshots.map(s => s.raydium?.clmm || []), mode),
        cpmm: mergePools(loadedSnapshots.map(s => (s.raydium as any)?.cpmm || []), mode),
      },
      orca: {
        amm: mergePools(loadedSnapshots.map(s => s.orca?.amm || []), mode),
        clmm: mergePools(loadedSnapshots.map(s => s.orca?.clmm || []), mode),
        cpmm: [],
      },
      meteora: {
        amm: mergePools(loadedSnapshots.map(s => s.meteora?.amm || []), mode),
        clmm: mergePools(loadedSnapshots.map(s => s.meteora?.clmm || []), mode),
        cpmm: [],
      },
      meteoraBalanced: {
        amm: mergePools(loadedSnapshots.map(s => s.meteoraBalanced?.amm || []), mode),
        clmm: [],
        cpmm: [],
      },
      pumpswap: {
        amm: mergePools(loadedSnapshots.map(s => s.pumpswap?.amm || []), mode),
        clmm: [],
        cpmm: [],
      },
    };
    
    // Hydrate caches with merged data
    const counts = hydratePoolCaches(mergedSnapshot);
    
    // Save merged snapshot if name provided
    if (options?.saveTo) {
      const saveName = sanitizeSnapshotName(options.saveTo);
      const filePath = getNamedSnapshotPath(saveName);
      await ensureDir(getSnapshotsDir());
      await writeJson(filePath, mergedSnapshot);
      
      // Update active snapshot
      await saveSnapshotMeta({
        activeSnapshot: saveName,
        lastUpdated: new Date().toISOString(),
      });
      
      logger.info('pools.snapshot.merged.saved', {
        name: saveName,
        sources: names,
        mode,
        poolCount: counts.total,
        cat: 'pools'
      });
    }
    
    // Build graph if requested
    if (options?.buildGraph !== false) {
      try {
        const { rebuildGraphNow } = await import('./graph.js');
        await rebuildGraphNow(undefined, { pushToArb: false });
      } catch (err: any) {
        logger.warn('pools.snapshot.merge.graph_build.failed', { error: err.message, cat: 'pools' });
      }
    }
    
    logger.info('pools.snapshot.merged', {
      sources: names,
      mode,
      poolCount: counts.total,
      counts,
      cat: 'pools'
    });
    
    try {
      emit('log', {
        level: 'info',
        message: `pools:merged ${names.length} snapshots (${mode}) = ${counts.total} pools`,
        timestamp: new Date().toISOString(),
        context: { cat: 'pools' }
      });
    } catch {}
    
    return { success: true, poolCount: counts.total };
  } catch (err: any) {
    logger.error('pools.snapshot.merge.failed', { names, error: err.message, cat: 'pools' });
    return { success: false, poolCount: 0, error: err.message };
  }
}

/**
 * Save current pools as default (called on shutdown)
 * This is the standard save that happens automatically
 */
export async function saveDefaultSnapshot(): Promise<boolean> {
  const result = await saveNamedSnapshot(DEFAULT_SNAPSHOT_NAME, {
    description: 'Auto-saved on shutdown',
    setActive: true,
  });
  return result.success;
}

/**
 * Load the default snapshot on startup
 */
export async function loadDefaultSnapshot(): Promise<boolean> {
  const result = await loadNamedSnapshot(DEFAULT_SNAPSHOT_NAME, {
    buildGraph: true,
    setActive: true,
  });
  return result.success;
}

// ============================================================================
// RAW NORMALIZED POOLS (per-DEX files) - Save/load pools before filtering
// ============================================================================

type DexName = 'raydium' | 'orca' | 'meteora' | 'meteoraBalanced' | 'pumpswap';

const RAW_NORMALIZED_VERSION = 1;

/**
 * Get the file path for a DEX's raw normalized pools
 */
function getRawNormalizedPath(dex: DexName): string {
  return joinPath(CONFIG.cacheDir, `raw-normalized-${dex}.json`);
}

interface RawNormalizedDexSnapshot {
  version: number;
  dex: DexName;
  savedAt: string;
  savedAtMs: number;
  pools: PoolsPayload;
}

/**
 * Save raw normalized pools for a specific DEX (before filtering)
 * Call this right after normalization but before any filters are applied
 */
export async function saveRawNormalizedPools(
  dex: DexName,
  pools: PoolsPayload
): Promise<boolean> {
  try {
    await ensureDir(CONFIG.cacheDir);
    
    const snapshot: RawNormalizedDexSnapshot = {
      version: RAW_NORMALIZED_VERSION,
      dex,
      savedAt: new Date().toISOString(),
      savedAtMs: Date.now(),
      pools,
    };
    
    const filePath = getRawNormalizedPath(dex);
    await writeJson(filePath, snapshot);
    
    const counts = {
      amm: pools.amm?.length || 0,
      clmm: pools.clmm?.length || 0,
      total: (pools.amm?.length || 0) + (pools.clmm?.length || 0),
    };
    
    logger.debug('pools.raw_normalized.saved', {
      dex,
      counts,
      path: filePath,
      cat: 'pools'
    });
    
    return true;
  } catch (err: any) {
    logger.warn('pools.raw_normalized.save.failed', {
      dex,
      error: err.message,
      cat: 'pools'
    });
    return false;
  }
}

/**
 * Load raw normalized pools for a specific DEX
 * Returns null if not found or invalid
 */
export async function loadRawNormalizedPools(dex: DexName): Promise<PoolsPayload | null> {
  try {
    const filePath = getRawNormalizedPath(dex);
    const snapshot = await readJson<RawNormalizedDexSnapshot>(filePath, null as any);
    
    if (!snapshot) {
      logger.debug('pools.raw_normalized.not_found', { dex, path: filePath, cat: 'pools' });
      return null;
    }
    
    // Validate version
    if (snapshot.version !== RAW_NORMALIZED_VERSION) {
      logger.warn('pools.raw_normalized.version_mismatch', {
        dex,
        found: snapshot.version,
        expected: RAW_NORMALIZED_VERSION,
        cat: 'pools'
      });
      return null;
    }
    
    const ageMs = Date.now() - (snapshot.savedAtMs || 0);
    const ageHours = Math.round(ageMs / 3600000 * 10) / 10;
    
    const counts = {
      amm: snapshot.pools?.amm?.length || 0,
      clmm: snapshot.pools?.clmm?.length || 0,
      total: (snapshot.pools?.amm?.length || 0) + (snapshot.pools?.clmm?.length || 0),
    };
    
    logger.info('pools.raw_normalized.loaded', {
      dex,
      savedAt: snapshot.savedAt,
      ageHours,
      counts,
      cat: 'pools'
    });
    
    return snapshot.pools || { amm: [], clmm: [], cpmm: [] };
  } catch (err: any) {
    logger.warn('pools.raw_normalized.load.failed', { dex, error: err.message, cat: 'pools' });
    return null;
  }
}

/**
 * Load raw normalized pools for all DEXes
 * Returns a combined snapshot object
 */
export async function loadAllRawNormalizedPools(): Promise<PoolsSnapshot | null> {
  const dexes: DexName[] = ['raydium', 'orca', 'meteora', 'meteoraBalanced', 'pumpswap'];
  
  const result: PoolsSnapshot = {
    version: SNAPSHOT_VERSION,
    savedAt: new Date().toISOString(),
    savedAtMs: Date.now(),
    raydium: { amm: [], clmm: [], cpmm: [] },
    orca: { amm: [], clmm: [], cpmm: [] },
    meteora: { amm: [], clmm: [], cpmm: [] },
    meteoraBalanced: { amm: [], clmm: [], cpmm: [] },
    pumpswap: { amm: [], clmm: [], cpmm: [] },
  };
  
  let foundAny = false;
  let oldestMs = Date.now();
  
  for (const dex of dexes) {
    const pools = await loadRawNormalizedPools(dex);
    if (pools) {
      result[dex] = pools;
      foundAny = true;
      
      // Track oldest snapshot time
      try {
        const filePath = getRawNormalizedPath(dex);
        const snapshot = await readJson<RawNormalizedDexSnapshot>(filePath, null as any);
        if (snapshot?.savedAtMs && snapshot.savedAtMs < oldestMs) {
          oldestMs = snapshot.savedAtMs;
          result.savedAt = snapshot.savedAt;
          result.savedAtMs = snapshot.savedAtMs;
        }
      } catch {}
    }
  }
  
  if (!foundAny) {
    logger.debug('pools.raw_normalized.load_all.none_found', { cat: 'pools' });
    return null;
  }
  
  const counts = {
    raydium: (result.raydium?.amm?.length || 0) + (result.raydium?.clmm?.length || 0),
    orca: (result.orca?.amm?.length || 0) + (result.orca?.clmm?.length || 0),
    meteora: (result.meteora?.amm?.length || 0) + (result.meteora?.clmm?.length || 0),
    meteoraBalanced: (result.meteoraBalanced?.amm?.length || 0),
    pumpswap: (result.pumpswap?.amm?.length || 0),
  };
  
  logger.info('pools.raw_normalized.load_all.complete', {
    counts,
    total: Object.values(counts).reduce((a, b) => a + b, 0),
    cat: 'pools'
  });
  
  return result;
}

/**
 * Check if raw normalized pools exist for a DEX
 */
export async function rawNormalizedPoolsExist(dex: DexName): Promise<boolean> {
  try {
    const filePath = getRawNormalizedPath(dex);
    return await fileExists(filePath);
  } catch {
    return false;
  }
}

/**
 * Get info about raw normalized pool snapshots
 */
export async function getRawNormalizedInfo(): Promise<{
  dex: DexName;
  exists: boolean;
  savedAt?: string;
  ageHours?: number;
  counts?: { amm: number; clmm: number; total: number };
}[]> {
  const dexes: DexName[] = ['raydium', 'orca', 'meteora', 'meteoraBalanced', 'pumpswap'];
  const results: {
    dex: DexName;
    exists: boolean;
    savedAt?: string;
    ageHours?: number;
    counts?: { amm: number; clmm: number; total: number };
  }[] = [];
  
  for (const dex of dexes) {
    try {
      const filePath = getRawNormalizedPath(dex);
      const snapshot = await readJson<RawNormalizedDexSnapshot>(filePath, null as any);
      
      if (snapshot?.pools) {
        const ageMs = Date.now() - (snapshot.savedAtMs || 0);
        results.push({
          dex,
          exists: true,
          savedAt: snapshot.savedAt,
          ageHours: Math.round(ageMs / 3600000 * 10) / 10,
          counts: {
            amm: snapshot.pools.amm?.length || 0,
            clmm: snapshot.pools.clmm?.length || 0,
            total: (snapshot.pools.amm?.length || 0) + (snapshot.pools.clmm?.length || 0),
          },
        });
      } else {
        results.push({ dex, exists: false });
      }
    } catch {
      results.push({ dex, exists: false });
    }
  }
  
  return results;
}

