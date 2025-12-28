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
 */

import { CONFIG } from '../utils/config.js';
import { readJson, writeJson, joinPath, ensureDir } from '../utils/fs.js';
import { logger } from '../utils/logger.js';
import type { PoolsPayload } from './pools/types.js';
import { 
  raydiumCache, orcaCache, meteoraCache, 
  metbalCache, pumpswapCache 
} from './pools.cache.js';
import { emit } from './realtime.js';

export interface PoolsSnapshot {
  version: number;
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

const SNAPSHOT_FILE = 'filtered-pools-snapshot.json';
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
 */
export function hydratePoolCaches(snapshot: PoolsSnapshot): {
  total: number;
  raydium: number;
  orca: number;
  meteora: number;
  meteoraBalanced: number;
  pumpswap: number;
} {
  const now = Date.now();
  const savedAtMs = snapshot.savedAtMs || now;
  
  if (snapshot.raydium) {
    raydiumCache.data = snapshot.raydium;
    raydiumCache.ts = savedAtMs;
  }
  if (snapshot.orca) {
    orcaCache.data = snapshot.orca;
    orcaCache.ts = savedAtMs;
  }
  if (snapshot.meteora) {
    meteoraCache.data = snapshot.meteora;
    meteoraCache.ts = savedAtMs;
  }
  if (snapshot.meteoraBalanced) {
    metbalCache.data = snapshot.meteoraBalanced;
    metbalCache.ts = savedAtMs;
  }
  if (snapshot.pumpswap) {
    pumpswapCache.data = snapshot.pumpswap;
    pumpswapCache.ts = savedAtMs;
  }
  
  const counts = {
    raydium: (snapshot.raydium?.amm?.length || 0) + (snapshot.raydium?.clmm?.length || 0),
    orca: (snapshot.orca?.amm?.length || 0) + (snapshot.orca?.clmm?.length || 0),
    meteora: (snapshot.meteora?.amm?.length || 0) + (snapshot.meteora?.clmm?.length || 0),
    meteoraBalanced: (snapshot.meteoraBalanced?.amm?.length || 0),
    pumpswap: (snapshot.pumpswap?.amm?.length || 0),
    total: 0,
  };
  counts.total = counts.raydium + counts.orca + counts.meteora + counts.meteoraBalanced + counts.pumpswap;
  
  logger.info('pools.caches.hydrated', { counts, cat: 'pools' });
  
  try {
    emit('log', { 
      level: 'info', 
      message: `pools:caches hydrated ${counts.total} pools from snapshot`, 
      timestamp: new Date().toISOString(), 
      context: { cat: 'pools', counts } 
    });
  } catch {}
  
  return counts;
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
    await rebuildGraphNow(undefined, { source: 'persistence_load' });
    logger.info('pools.persistence.graph_built', { poolCount: counts.total, cat: 'pools' });
    
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

