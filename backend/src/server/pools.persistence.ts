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
  metbalCache, pumpswapCache 
} from './pools.cache.js';
import { emit } from './realtime.js';
import { executionCache } from '../execution/cache.js';

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
      raydium: raydiumCache.data || { amm: [], clmm: [] },
      orca: orcaCache.data || { amm: [], clmm: [] },
      meteora: meteoraCache.data || { amm: [], clmm: [] },
      meteoraBalanced: metbalCache.data || { amm: [], clmm: [] },
      pumpswap: pumpswapCache.data || { amm: [], clmm: [] },
    };

    const counts = {
      raydium: { amm: snapshot.raydium.amm?.length || 0, clmm: snapshot.raydium.clmm?.length || 0 },
      orca: { amm: snapshot.orca.amm?.length || 0, clmm: snapshot.orca.clmm?.length || 0 },
      meteora: { amm: snapshot.meteora.amm?.length || 0, clmm: snapshot.meteora.clmm?.length || 0 },
      meteoraBalanced: { amm: snapshot.meteoraBalanced.amm?.length || 0, clmm: 0 },
      pumpswap: { amm: snapshot.pumpswap.amm?.length || 0, clmm: 0 },
    };

    const total = Object.values(counts).reduce((sum, c) => sum + c.amm + c.clmm, 0);
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
      raydium: (snapshot.raydium?.amm?.length || 0) + (snapshot.raydium?.clmm?.length || 0),
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
  
  if (snapshot.raydium) {
    raydiumCache.data = snapshot.raydium;
    raydiumCache.ts = savedAtMs;
    // Populate execution cache for Raydium pools
    executionCachePopulated += populateExecutionCacheFromPools(snapshot.raydium, 'Raydium');
  }
  if (snapshot.orca) {
    orcaCache.data = snapshot.orca;
    orcaCache.ts = savedAtMs;
    // Populate execution cache for Orca pools
    executionCachePopulated += populateExecutionCacheFromPools(snapshot.orca, 'Orca');
  }
  if (snapshot.meteora) {
    meteoraCache.data = snapshot.meteora;
    meteoraCache.ts = savedAtMs;
    // Populate execution cache for Meteora pools
    executionCachePopulated += populateExecutionCacheFromPools(snapshot.meteora, 'Meteora');
  }
  if (snapshot.meteoraBalanced) {
    metbalCache.data = snapshot.meteoraBalanced;
    metbalCache.ts = savedAtMs;
    // Populate execution cache for Meteora Balanced pools
    executionCachePopulated += populateExecutionCacheFromPools(snapshot.meteoraBalanced, 'MeteoraBalanced');
  }
  if (snapshot.pumpswap) {
    pumpswapCache.data = snapshot.pumpswap;
    pumpswapCache.ts = savedAtMs;
    // Populate execution cache for Pumpswap pools
    executionCachePopulated += populateExecutionCacheFromPools(snapshot.pumpswap, 'Pumpswap');
  }
  
  const counts = {
    raydium: (snapshot.raydium?.amm?.length || 0) + (snapshot.raydium?.clmm?.length || 0),
    orca: (snapshot.orca?.amm?.length || 0) + (snapshot.orca?.clmm?.length || 0),
    meteora: (snapshot.meteora?.amm?.length || 0) + (snapshot.meteora?.clmm?.length || 0),
    meteoraBalanced: (snapshot.meteoraBalanced?.amm?.length || 0),
    pumpswap: (snapshot.pumpswap?.amm?.length || 0),
    total: 0,
    executionCachePopulated,
  };
  counts.total = counts.raydium + counts.orca + counts.meteora + counts.meteoraBalanced + counts.pumpswap;
  
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
function populateExecutionCacheFromPools(
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
        programId,
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
      
      // Raydium CLMM-specific
      if ((pool as any).observation_state) staticData.observation_state = (pool as any).observation_state;
      if ((pool as any).ex_bitmap) staticData.ex_bitmap = (pool as any).ex_bitmap;
      if ((pool as any).amm_config) staticData.amm_config = (pool as any).amm_config;
      
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
      
      executionCache.setStatic(pool.id, staticData);
      populated++;
      
      // Also populate hot cache with price/tick data if available
      const hotData: any = {};
      let hasHotData = false;
      
      if (pool.sqrt_price_x64 !== undefined) {
        hotData.sqrtPriceX64 = BigInt(String(pool.sqrt_price_x64));
        hasHotData = true;
      }
      if ((pool as any).tick_current !== undefined) {
        hotData.currentTickIndex = (pool as any).tick_current;
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
      logger.info('pools.persistence.auto_revalidate.start', { cat: 'pools' });
      const { revalidateAllPools } = await import('./pools.revalidate.js');
      const result = await revalidateAllPools({ limit: 50, concurrency: 10 });
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
    raydium: raydiumCache.data || { amm: [], clmm: [] },
    orca: orcaCache.data || { amm: [], clmm: [] },
    meteora: meteoraCache.data || { amm: [], clmm: [] },
    meteoraBalanced: metbalCache.data || { amm: [], clmm: [] },
    pumpswap: pumpswapCache.data || { amm: [], clmm: [] },
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
    raydium: (snapshot.raydium?.amm?.length || 0) + (snapshot.raydium?.clmm?.length || 0),
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
      },
      orca: {
        amm: mergePools(loadedSnapshots.map(s => s.orca?.amm || []), mode),
        clmm: mergePools(loadedSnapshots.map(s => s.orca?.clmm || []), mode),
      },
      meteora: {
        amm: mergePools(loadedSnapshots.map(s => s.meteora?.amm || []), mode),
        clmm: mergePools(loadedSnapshots.map(s => s.meteora?.clmm || []), mode),
      },
      meteoraBalanced: {
        amm: mergePools(loadedSnapshots.map(s => s.meteoraBalanced?.amm || []), mode),
        clmm: [],
      },
      pumpswap: {
        amm: mergePools(loadedSnapshots.map(s => s.pumpswap?.amm || []), mode),
        clmm: [],
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

