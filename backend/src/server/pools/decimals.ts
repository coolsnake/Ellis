import { logger } from '../../utils/logger.js';
import { loadJupiterTokenMap } from '../../utils/tokens.js';
import { Connection, PublicKey } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';
import { CONFIG } from '../../utils/config.js';
import { logCatchError } from '../../utils/errorHandler.js';
import { readJson, writeJson, joinPath } from '../../utils/fs.js';

// Anchor decimals: highest-priority source of truth for well-known tokens
const ANCHOR_DECIMALS = new Map<string, number>([
  ['So11111111111111111111111111111111111111112', 9],  // SOL
  ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 6], // USDC
  ['Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', 6], // USDT
  ['USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB', 6],  // USD1
]);

// RPC decimal resolution metrics
interface DecimalResolutionMetrics {
  rpcCalls: number;
  rpcSuccesses: number;
  rpcFailures: number;
  cacheHits: number;
  anchorHits: number;
  jupiterHits: number;
  fallbacksUsed: number;
  lastRpcCallMs: number;
}

const resolutionMetrics: DecimalResolutionMetrics = {
  rpcCalls: 0,
  rpcSuccesses: 0,
  rpcFailures: 0,
  cacheHits: 0,
  anchorHits: 0,
  jupiterHits: 0,
  fallbacksUsed: 0,
  lastRpcCallMs: 0,
};

// Pending RPC resolution promises to deduplicate concurrent requests
const pendingRpcResolutions = new Map<string, Promise<number | undefined>>();

// Connection singleton for decimal resolution (avoids creating new connections)
let decimalsConnection: Connection | null = null;

function getDecimalsConnection(): Connection {
  if (!decimalsConnection) {
    decimalsConnection = new Connection(CONFIG.rpcUrl, { 
      commitment: 'confirmed', 
      disableRetryOnRateLimit: true 
    } as any);
  }
  return decimalsConnection;
}

/**
 * Known decimals for common tokens - used for validation
 * These are tokens where we KNOW the correct decimals and can detect misresolution
 */
const KNOWN_TOKEN_DECIMALS: Record<string, { name: string; decimals: number }> = {
  // Native SOL
  'So11111111111111111111111111111111111111112': { name: 'SOL', decimals: 9 },
  // Stablecoins
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': { name: 'USDC', decimals: 6 },
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': { name: 'USDT', decimals: 6 },
  'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB': { name: 'USD1', decimals: 6 },
  'USDhvdLPwTSgFdHu6wuf6rmEZJsKFRHznBggvjKfDLJ': { name: 'USDY', decimals: 6 },
  'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm': { name: 'WIF', decimals: 6 },
  // Common tokens
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So': { name: 'mSOL', decimals: 9 },
  'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1': { name: 'bSOL', decimals: 9 },
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn': { name: 'JitoSOL', decimals: 9 },
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263': { name: 'BONK', decimals: 5 },
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN': { name: 'JUP', decimals: 6 },
  '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs': { name: 'ETH (Wormhole)', decimals: 8 },
  '7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj': { name: 'stSOL', decimals: 9 },
  'rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof': { name: 'RNDR', decimals: 8 },
  '85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ': { name: 'W', decimals: 6 },
};

// Track decimal validation mismatches
let decimalValidationMismatches = 0;

// In-memory cache for resolved decimals
const resolveCache = new Map<string, number>();

// Jupiter map cache (refreshed periodically)
let jupMapCache: Record<string, { decimals: number }> | null = null;
let jupMapCacheTime = 0;
const JUP_MAP_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ============================================
// SYNCHRONOUS DECIMALS LOOKUP
// ============================================
// Fast sync lookup for quoting - no async/await overhead
// Uses: 1) Anchor decimals 2) Known tokens 3) Resolve cache

/**
 * Get decimals for a mint from cache (synchronous)
 * This is the primary entry point for quoting functions.
 * Returns undefined if not in cache - caller should fall back to other sources.
 * 
 * Priority:
 * 1. ANCHOR_DECIMALS (hardcoded, always correct)
 * 2. KNOWN_TOKEN_DECIMALS (well-known tokens)
 * 3. resolveCache (previously resolved via RPC/Jupiter)
 */
export function getDecimalsFromCache(mint: string): number | undefined {
  if (!mint || mint.length < 32) return undefined;
  
  // 1. Anchor decimals (highest priority, always correct)
  if (ANCHOR_DECIMALS.has(mint)) {
    return ANCHOR_DECIMALS.get(mint);
  }
  
  // 2. Known token decimals
  const known = KNOWN_TOKEN_DECIMALS[mint];
  if (known) {
    return known.decimals;
  }
  
  // 3. In-memory cache (from previous RPC/Jupiter resolution)
  if (resolveCache.has(mint)) {
    return resolveCache.get(mint);
  }
  
  return undefined;
}

// ============================================
// PERSISTENT DECIMALS STORE
// ============================================
// Persists RPC-resolved decimals to disk so they survive restarts
// This prevents repeated RPC calls for the same mints

interface PersistedDecimalsStore {
  version: number;
  updatedAt: number;
  decimals: Record<string, { value: number; resolvedAt: number; source: 'rpc' | 'jupiter' }>;
}

const DECIMALS_STORE_VERSION = 1;
const DECIMALS_STORE_PATH = joinPath(CONFIG.cacheDir || 'cache', 'mint-decimals.json');

// Debounce state for persisting decimals
let persistTimer: NodeJS.Timeout | null = null;
let pendingPersistCount = 0;
const PERSIST_DEBOUNCE_MS = 5000; // Wait 5s of inactivity before writing
const PERSIST_MAX_PENDING = 50; // Force write after 50 new entries

// Track whether we've loaded persisted data
let persistedDataLoaded = false;

/**
 * Load persisted decimals from disk into the in-memory cache
 * Called on module initialization
 */
export async function loadPersistedDecimals(): Promise<number> {
  if (persistedDataLoaded) {
    return resolveCache.size;
  }

  try {
    const store = await readJson<PersistedDecimalsStore>(DECIMALS_STORE_PATH, {
      version: DECIMALS_STORE_VERSION,
      updatedAt: 0,
      decimals: {},
    });

    // Version check - clear if incompatible
    if (store.version !== DECIMALS_STORE_VERSION) {
      logger.info('decimals.persist.version_mismatch', {
        stored: store.version,
        current: DECIMALS_STORE_VERSION,
        action: 'clearing_store',
        cat: 'decimals'
      });
      persistedDataLoaded = true;
      return 0;
    }

    let loadedCount = 0;
    let skippedCount = 0;

    for (const [mint, entry] of Object.entries(store.decimals)) {
      // Validate entry
      if (!mint || mint.length < 32) {
        skippedCount++;
        continue;
      }
      if (typeof entry?.value !== 'number' || entry.value < 0 || entry.value > 18) {
        skippedCount++;
        continue;
      }

      // Don't overwrite anchor decimals
      if (ANCHOR_DECIMALS.has(mint)) {
        continue;
      }

      // Don't overwrite existing cache entries (in case of race)
      if (!resolveCache.has(mint)) {
        resolveCache.set(mint, entry.value);
        loadedCount++;
      }
    }

    persistedDataLoaded = true;

    logger.info('decimals.persist.loaded', {
      loaded: loadedCount,
      skipped: skippedCount,
      storeAge: Date.now() - store.updatedAt,
      path: DECIMALS_STORE_PATH,
      cat: 'decimals'
    });

    return loadedCount;
  } catch (e: any) {
    // File might not exist on first run - that's OK
    if (e?.code !== 'ENOENT') {
      logger.warn('decimals.persist.load_error', {
        error: String(e?.message || e),
        path: DECIMALS_STORE_PATH,
        cat: 'decimals'
      });
    }
    persistedDataLoaded = true;
    return 0;
  }
}

/**
 * Persist a single decimal resolution to disk (debounced)
 */
function schedulePersist(mint: string, decimals: number, source: 'rpc' | 'jupiter'): void {
  pendingPersistCount++;

  // Clear existing timer
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }

  // Force write if we have many pending
  if (pendingPersistCount >= PERSIST_MAX_PENDING) {
    void persistDecimalsNow();
    return;
  }

  // Schedule debounced write
  persistTimer = setTimeout(() => {
    void persistDecimalsNow();
  }, PERSIST_DEBOUNCE_MS);
}

/**
 * Persist all cached decimals to disk immediately
 */
async function persistDecimalsNow(): Promise<void> {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }

  const countToPersist = pendingPersistCount;
  pendingPersistCount = 0;

  try {
    // Build store from cache (excluding anchors)
    const decimals: Record<string, { value: number; resolvedAt: number; source: 'rpc' | 'jupiter' }> = {};
    const now = Date.now();

    for (const [mint, value] of resolveCache.entries()) {
      // Skip anchors - they're hardcoded
      if (ANCHOR_DECIMALS.has(mint)) continue;

      decimals[mint] = {
        value,
        resolvedAt: now,
        source: 'rpc', // Default to RPC since we don't track source in cache
      };
    }

    const store: PersistedDecimalsStore = {
      version: DECIMALS_STORE_VERSION,
      updatedAt: now,
      decimals,
    };

    await writeJson(DECIMALS_STORE_PATH, store);

    logger.debug('decimals.persist.saved', {
      entries: Object.keys(decimals).length,
      pending: countToPersist,
      path: DECIMALS_STORE_PATH,
      cat: 'decimals'
    });
  } catch (e: any) {
    logger.warn('decimals.persist.save_error', {
      error: String(e?.message || e),
      path: DECIMALS_STORE_PATH,
      cat: 'decimals'
    });
  }
}

/**
 * Force persist decimals (call on graceful shutdown)
 */
export async function flushPersistedDecimals(): Promise<void> {
  if (pendingPersistCount > 0 || resolveCache.size > ANCHOR_DECIMALS.size) {
    await persistDecimalsNow();
  }
}

/**
 * Get persistence stats
 */
export function getDecimalsPersistenceStats(): {
  loaded: boolean;
  cacheSize: number;
  pendingPersist: number;
  storePath: string;
} {
  return {
    loaded: persistedDataLoaded,
    cacheSize: resolveCache.size,
    pendingPersist: pendingPersistCount,
    storePath: DECIMALS_STORE_PATH,
  };
}

/**
 * Get Jupiter token map with caching
 */
async function getJupiterMap(): Promise<Record<string, { decimals: number }>> {
  const now = Date.now();
  if (jupMapCache && (now - jupMapCacheTime) < JUP_MAP_TTL_MS) {
    return jupMapCache;
  }
  
  try {
    jupMapCache = await loadJupiterTokenMap();
    jupMapCacheTime = now;
    return jupMapCache;
  } catch (e) {
    if (jupMapCache) return jupMapCache; // Return stale cache on error
    return {};
  }
}

/**
 * Resolve decimals for a single mint with priority chain:
 * 1. Anchor decimals (SOL, USDC, etc.)
 * 2. In-memory cache
 * 3. Jupiter token map
 * 4. RPC fetch (last resort)
 */
export async function resolveDecimals(mint: string): Promise<number | undefined> {
  if (!mint || mint.length < 32) return undefined;
  
  // 1. Check anchors (highest priority)
  if (ANCHOR_DECIMALS.has(mint)) {
    return ANCHOR_DECIMALS.get(mint);
  }
  
  // 2. Check in-memory cache
  if (resolveCache.has(mint)) {
    return resolveCache.get(mint);
  }
  
  // 3. Check Jupiter map
  const jupMap = await getJupiterMap();
  const jupDecimals = jupMap[mint]?.decimals;
  if (jupDecimals != null && Number.isFinite(jupDecimals)) {
    resolveCache.set(mint, jupDecimals);
    return jupDecimals;
  }
  
  // 4. Fetch from RPC (last resort)
  try {
    const conn = new Connection(CONFIG.rpcUrl, { commitment: 'confirmed', disableRetryOnRateLimit: true } as any);
    const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
    
    const mintPk = new PublicKey(mint);
    const accountInfo = await conn.getAccountInfo(mintPk, 'confirmed');
    
    if (!accountInfo) return undefined;
    
    const owner = accountInfo.owner.toBase58();
    const isTokenProgram = 
      owner === TOKEN_PROGRAM_ID.toBase58() || 
      owner === TOKEN_2022_PROGRAM_ID.toBase58();
    
    if (!isTokenProgram) return undefined;
    
    const mintInfo = await getMint(conn, mintPk);
    const decimals = Number(mintInfo.decimals);
    
    if (Number.isFinite(decimals) && decimals >= 0 && decimals <= 18) {
      resolveCache.set(mint, decimals);
      return decimals;
    }
  } catch (e: any) {
    try {
      logger.debug('decimals.resolve.rpc.failed', {
        mint,
        error: String(e?.message || e),
        cat: 'decimals'
      });
    } catch (e) { logCatchError('pools.decimals', e); }
  }
  
  return undefined;
}

/**
 * Batch resolve decimals for multiple mints efficiently
 * 
 * Mode 1 (normalizeMode=false): Anchors → Cache → Jupiter → RPC (performance)
 * Mode 2 (normalizeMode=true): Anchors → RPC → Jupiter (validation priority)
 */
export async function resolveManyDecimals(
  mints: string[],
  options?: { 
    logger?: any; 
    batchSize?: number;
    normalizeMode?: boolean; // NEW: Set true during pool normalization
    tokenPrograms?: Map<string, 'spl-token' | 'token-2022'>; // Optional: collect token program IDs
  }
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  const log = options?.logger || logger;
  const batchSize = options?.batchSize ?? 100;
  const normalizeMode = options?.normalizeMode ?? false; // Default: performance mode
  const tokenPrograms = options?.tokenPrograms; // Optional token program collection
  
  // PHASE 1: Check anchors (ALWAYS trust these)
  const needsLookup = new Set<string>();
  for (const mint of mints) {
    if (!mint || mint.length < 32) continue;
    
    // Check anchors
    if (ANCHOR_DECIMALS.has(mint)) {
      result.set(mint, ANCHOR_DECIMALS.get(mint)!);
      continue;
    }
    
    // In normalize mode: Skip cache, go straight to RPC validation
    // In performance mode: Use cache if available
    if (!normalizeMode && resolveCache.has(mint)) {
      result.set(mint, resolveCache.get(mint)!);
      continue;
    }
    
    needsLookup.add(mint);
  }
  
  if (needsLookup.size === 0) return result;
  
  // PHASE 2: RPC Validation
  // In normalize mode: Do RPC FIRST (before Jupiter)
  // In performance mode: Do RPC LAST (after Jupiter)
  let needsJupiter = needsLookup;
  
  if (normalizeMode) {
    // NORMALIZE MODE: RPC FIRST to establish truth
    try {
      log.info('decimals.normalize.rpc_validate.start', {
        total: mints.length,
        needsValidation: needsLookup.size,
        mode: 'validation',
        cat: 'decimals'
      });
    } catch (e) { logCatchError('pools.decimals', e); }
    
    const conn = new Connection(CONFIG.rpcUrl, { commitment: 'confirmed', disableRetryOnRateLimit: true } as any);
    const TOKEN_PROGRAM_ID_STR = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
    const TOKEN_2022_PROGRAM_ID_STR = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
    
    const mintsToFetch = Array.from(needsLookup);
    let rpcValidated = 0;
    let rpcFailed = 0;
    
    for (let i = 0; i < mintsToFetch.length; i += batchSize) {
      const batch = mintsToFetch.slice(i, i + batchSize);
      const pubkeys = batch.map(m => {
        try {
          return new PublicKey(m);
        } catch {
          return null;
        }
      }).filter(Boolean) as PublicKey[];
      
      if (pubkeys.length === 0) continue;
      
      try {
        const accountInfos = await conn.getMultipleAccountsInfo(pubkeys, 'confirmed');
        
        for (let j = 0; j < accountInfos.length; j++) {
          const accountInfo = accountInfos[j];
          const mint = batch[j];
          if (!accountInfo || !mint) {
            rpcFailed++;
            continue;
          }
          
          try {
            const owner = accountInfo.owner.toBase58();
            const isTokenProgram = owner === TOKEN_PROGRAM_ID_STR || owner === TOKEN_2022_PROGRAM_ID_STR;
            
            if (isTokenProgram && accountInfo.data.length >= 45) {
              // Decimals is u8 at offset 44
              const decimals = accountInfo.data[44];
              if (decimals <= 18) {
                result.set(mint, decimals);
                resolveCache.set(mint, decimals);
                schedulePersist(mint, decimals, 'rpc');
                rpcValidated++;
                // Remove from Jupiter lookup queue
                needsJupiter.delete(mint);

                // Store token program type if map provided
                if (tokenPrograms) {
                  const program = owner === TOKEN_2022_PROGRAM_ID_STR ? 'token-2022' : 'spl-token';
                  tokenPrograms.set(mint, program);
                }
              } else {
                rpcFailed++;
              }
            } else {
              rpcFailed++;
            }
          } catch {
            rpcFailed++;
          }
        }
      } catch (e: any) {
        rpcFailed += batch.length;
        try {
          log.warn('decimals.normalize.rpc.batch_error', {
            batchIndex: i / batchSize,
            batchSize: batch.length,
            error: String(e?.message || e),
            cat: 'decimals'
          });
        } catch (e) { logCatchError('pools.decimals', e); }
      }
    }
    
    try {
      log.info('decimals.normalize.rpc_validate.complete', {
        total: mints.length,
        validated: rpcValidated,
        failed: rpcFailed,
        needsJupiterFallback: needsJupiter.size,
        cat: 'decimals'
      });
    } catch (e) { logCatchError('pools.decimals', e); }
  } else {
    // PERFORMANCE MODE: Check Jupiter before RPC
    const jupMap = await getJupiterMap();
    const needsRpc = new Set<string>();
    
    for (const mint of needsLookup) {
      const jupDecimals = jupMap[mint]?.decimals;
      if (jupDecimals != null && Number.isFinite(jupDecimals)) {
        result.set(mint, jupDecimals);
        resolveCache.set(mint, jupDecimals);
      } else {
        needsRpc.add(mint);
      }
    }
    
    needsJupiter = needsRpc;
  }
  
  // PHASE 3: Jupiter fallback (for normalize mode RPC failures OR performance mode)
  if (needsJupiter.size > 0) {
    const jupMap = await getJupiterMap();
    
    for (const mint of needsJupiter) {
      const jupDecimals = jupMap[mint]?.decimals;
      if (jupDecimals != null && Number.isFinite(jupDecimals)) {
        result.set(mint, jupDecimals);
        resolveCache.set(mint, jupDecimals);
      }
    }
  }
  
  // PHASE 4: RPC fallback (performance mode only, for mints not in Jupiter)
  if (!normalizeMode && needsJupiter.size > 0) {
    const stillMissing = Array.from(needsJupiter).filter(m => !result.has(m));
    
    if (stillMissing.length > 0) {
      try {
        log.info('decimals.batch.rpc.start', {
          total: mints.length,
          needsRpc: stillMissing.length,
          cat: 'decimals'
        });
      } catch (e) { logCatchError('pools.decimals', e); }
      
      // Same RPC logic as above but for remaining mints
      const conn = new Connection(CONFIG.rpcUrl, { commitment: 'confirmed', disableRetryOnRateLimit: true } as any);
      const TOKEN_PROGRAM_ID_STR = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
      const TOKEN_2022_PROGRAM_ID_STR = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
      
      for (let i = 0; i < stillMissing.length; i += batchSize) {
        const batch = stillMissing.slice(i, i + batchSize);
        const pubkeys = batch.map(m => {
          try {
            return new PublicKey(m);
          } catch {
            return null;
          }
        }).filter(Boolean) as PublicKey[];
        
        if (pubkeys.length === 0) continue;
        
        try {
          const accountInfos = await conn.getMultipleAccountsInfo(pubkeys, 'confirmed');
          
          for (let j = 0; j < accountInfos.length; j++) {
            const accountInfo = accountInfos[j];
            const mint = batch[j];
            if (!accountInfo || !mint) continue;
            
            try {
              const owner = accountInfo.owner.toBase58();
              const isTokenProgram = owner === TOKEN_PROGRAM_ID_STR || owner === TOKEN_2022_PROGRAM_ID_STR;
              
              if (isTokenProgram && accountInfo.data.length >= 45) {
                const decimals = accountInfo.data[44];
                if (decimals <= 18) {
                  result.set(mint, decimals);
                  resolveCache.set(mint, decimals);
                  schedulePersist(mint, decimals, 'rpc');

                  // Store token program type if map provided
                  if (tokenPrograms) {
                    const program = owner === TOKEN_2022_PROGRAM_ID_STR ? 'token-2022' : 'spl-token';
                    tokenPrograms.set(mint, program);
                  }
                }
              }
            } catch (e) { logCatchError('pools.decimals', e); }
          }
        } catch (e: any) {
          try {
            log.warn('decimals.batch.rpc.error', {
              batchIndex: i / batchSize,
              error: String(e?.message || e),
              cat: 'decimals'
            });
          } catch (e) { logCatchError('pools.decimals', e); }
        }
      }
    }
  }
  
  // Summary logging
  try {
    const fromAnchors = mints.filter(m => ANCHOR_DECIMALS.has(m)).length;
    const fromCache = mints.filter(m => !ANCHOR_DECIMALS.has(m) && !normalizeMode && resolveCache.has(m)).length;
    
    log.info('decimals.resolution.summary', {
      total: mints.length,
      resolved: result.size,
      mode: normalizeMode ? 'normalize' : 'performance',
      sources: {
        anchors: fromAnchors,
        cache: fromCache,
        validated: result.size - fromAnchors - fromCache,
      },
      cat: 'decimals'
    });
  } catch (e) { logCatchError('pools.decimals', e); }
  
  return result;
}

/**
 * Clear the in-memory cache (useful for testing)
 */
export function clearDecimalsCache(): void {
  resolveCache.clear();
  jupMapCache = null;
  jupMapCacheTime = 0;
}

/**
 * Get cache statistics
 */
export function getDecimalsCacheStats(): { cacheSize: number; anchorSize: number; jupMapAge: number } {
  return {
    cacheSize: resolveCache.size,
    anchorSize: ANCHOR_DECIMALS.size,
    jupMapAge: jupMapCache ? Date.now() - jupMapCacheTime : -1,
  };
}

/**
 * Validate that resolved decimals match known values for common tokens
 * 
 * Logs an error if a mismatch is detected between resolved decimals and known values.
 * This helps catch decimal misresolution bugs that could cause price calculation errors.
 * 
 * @param mint Token mint address
 * @param resolvedDecimals The decimals value that was resolved
 * @param poolId Optional pool ID for debugging context
 * @param dex Optional DEX name for debugging context
 * @returns true if valid (or unknown token), false if mismatch detected
 */
export function validateDecimalsForMint(
  mint: string,
  resolvedDecimals: number,
  poolId?: string,
  dex?: string
): boolean {
  const known = KNOWN_TOKEN_DECIMALS[mint];
  
  // If not a known token, skip validation
  if (!known) {
    return true;
  }
  
  // Check for mismatch
  if (known.decimals !== resolvedDecimals) {
    decimalValidationMismatches += 1;
    
    try {
      logger.error('decimals.validation.mismatch', {
        mint: mint.slice(0, 16) + '…',
        tokenName: known.name,
        expectedDecimals: known.decimals,
        resolvedDecimals,
        poolId: poolId ? poolId.slice(0, 8) + '…' : undefined,
        dex,
        totalMismatches: decimalValidationMismatches,
        warning: 'This may cause severe price calculation errors',
        cat: 'decimals'
      });
    } catch (e) { logCatchError('pools.decimals', e); }
    
    return false;
  }
  
  return true;
}

/**
 * Get decimal validation statistics
 */
export function getDecimalValidationStats(): { mismatches: number; knownTokens: number } {
  return {
    mismatches: decimalValidationMismatches,
    knownTokens: Object.keys(KNOWN_TOKEN_DECIMALS).length,
  };
}

/**
 * Get decimal resolution metrics
 */
export function getDecimalResolutionMetrics(): DecimalResolutionMetrics {
  return { ...resolutionMetrics };
}

/**
 * Reset decimal resolution metrics (useful for monitoring windows)
 */
export function resetDecimalResolutionMetrics(): void {
  resolutionMetrics.rpcCalls = 0;
  resolutionMetrics.rpcSuccesses = 0;
  resolutionMetrics.rpcFailures = 0;
  resolutionMetrics.cacheHits = 0;
  resolutionMetrics.anchorHits = 0;
  resolutionMetrics.jupiterHits = 0;
  resolutionMetrics.fallbacksUsed = 0;
}

/**
 * Resolve decimals directly from RPC (bypasses cache, always fetches fresh)
 * 
 * This is the authoritative source of truth for decimals.
 * Use this when you need guaranteed accurate decimals and can tolerate RPC latency.
 * 
 * @param mint Token mint address
 * @returns Decimals value or undefined if resolution fails
 */
export async function resolveDecimalsFromRpc(mint: string): Promise<number | undefined> {
  if (!mint || mint.length < 32) return undefined;
  
  // Check anchors first (these are hardcoded and authoritative)
  if (ANCHOR_DECIMALS.has(mint)) {
    resolutionMetrics.anchorHits++;
    return ANCHOR_DECIMALS.get(mint);
  }
  
  // Check if there's already a pending RPC request for this mint
  const pending = pendingRpcResolutions.get(mint);
  if (pending) {
    return pending;
  }
  
  // Create the RPC resolution promise
  const resolutionPromise = (async (): Promise<number | undefined> => {
    resolutionMetrics.rpcCalls++;
    resolutionMetrics.lastRpcCallMs = Date.now();
    
    try {
      const conn = getDecimalsConnection();
      const TOKEN_PROGRAM_ID_STR = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
      const TOKEN_2022_PROGRAM_ID_STR = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
      
      const mintPk = new PublicKey(mint);
      const accountInfo = await conn.getAccountInfo(mintPk, 'confirmed');
      
      if (!accountInfo) {
        resolutionMetrics.rpcFailures++;
        logger.warn('decimals.rpc.account_not_found', {
          mint: mint.slice(0, 12) + '…',
          cat: 'decimals'
        });
        return undefined;
      }
      
      const owner = accountInfo.owner.toBase58();
      const isTokenProgram = owner === TOKEN_PROGRAM_ID_STR || owner === TOKEN_2022_PROGRAM_ID_STR;
      
      if (!isTokenProgram) {
        resolutionMetrics.rpcFailures++;
        logger.warn('decimals.rpc.not_token_account', {
          mint: mint.slice(0, 12) + '…',
          owner: owner.slice(0, 12) + '…',
          cat: 'decimals'
        });
        return undefined;
      }
      
      if (accountInfo.data.length < 45) {
        resolutionMetrics.rpcFailures++;
        logger.warn('decimals.rpc.invalid_data_length', {
          mint: mint.slice(0, 12) + '…',
          dataLength: accountInfo.data.length,
          cat: 'decimals'
        });
        return undefined;
      }
      
      // Decimals is u8 at offset 44 in the mint account structure
      const decimals = accountInfo.data[44];
      
      if (decimals > 18) {
        resolutionMetrics.rpcFailures++;
        logger.warn('decimals.rpc.invalid_decimals', {
          mint: mint.slice(0, 12) + '…',
          decimals,
          cat: 'decimals'
        });
        return undefined;
      }
      
      // Success - cache the result and schedule persistence
      resolveCache.set(mint, decimals);
      resolutionMetrics.rpcSuccesses++;
      schedulePersist(mint, decimals, 'rpc');

      logger.debug('decimals.rpc.resolved', {
        mint: mint.slice(0, 12) + '…',
        decimals,
        cat: 'decimals'
      });
      
      return decimals;
    } catch (e: any) {
      resolutionMetrics.rpcFailures++;
      logger.warn('decimals.rpc.error', {
        mint: mint.slice(0, 12) + '…',
        error: String(e?.message || e),
        cat: 'decimals'
      });
      return undefined;
    }
  })();
  
  // Store the pending promise
  pendingRpcResolutions.set(mint, resolutionPromise);
  
  try {
    const result = await resolutionPromise;
    return result;
  } finally {
    // Clean up pending promise after resolution
    pendingRpcResolutions.delete(mint);
  }
}

/**
 * Batch resolve decimals from RPC for multiple mints
 * 
 * Uses getMultipleAccountsInfo for efficiency.
 * This is the authoritative batch resolution method.
 * 
 * @param mints Array of mint addresses
 * @param options Optional configuration
 * @returns Map of mint -> decimals for successfully resolved mints
 */
export async function resolveDecimalsFromRpcBatch(
  mints: string[],
  options?: {
    batchSize?: number;
    tokenPrograms?: Map<string, 'spl-token' | 'token-2022'>;
  }
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (!mints.length) return result;
  
  const batchSize = options?.batchSize ?? 100;
  const tokenPrograms = options?.tokenPrograms;
  
  const TOKEN_PROGRAM_ID_STR = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  const TOKEN_2022_PROGRAM_ID_STR = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
  
  // First pass: check anchors
  const needsRpc: string[] = [];
  for (const mint of mints) {
    if (!mint || mint.length < 32) continue;
    
    if (ANCHOR_DECIMALS.has(mint)) {
      result.set(mint, ANCHOR_DECIMALS.get(mint)!);
      resolutionMetrics.anchorHits++;
    } else {
      needsRpc.push(mint);
    }
  }
  
  if (needsRpc.length === 0) return result;
  
  const conn = getDecimalsConnection();
  let rpcSuccessCount = 0;
  let rpcFailCount = 0;
  
  logger.info('decimals.rpc_batch.start', {
    total: mints.length,
    needsRpc: needsRpc.length,
    batchSize,
    cat: 'decimals'
  });
  
  for (let i = 0; i < needsRpc.length; i += batchSize) {
    const batch = needsRpc.slice(i, i + batchSize);
    const pubkeys: PublicKey[] = [];
    const validMints: string[] = [];
    
    for (const mint of batch) {
      try {
        pubkeys.push(new PublicKey(mint));
        validMints.push(mint);
      } catch {
        // Invalid pubkey, skip
      }
    }
    
    if (pubkeys.length === 0) continue;
    
    resolutionMetrics.rpcCalls++;
    resolutionMetrics.lastRpcCallMs = Date.now();
    
    try {
      const accountInfos = await conn.getMultipleAccountsInfo(pubkeys, 'confirmed');
      
      for (let j = 0; j < accountInfos.length; j++) {
        const accountInfo = accountInfos[j];
        const mint = validMints[j];
        
        if (!accountInfo || accountInfo.data.length < 45) {
          rpcFailCount++;
          continue;
        }
        
        const owner = accountInfo.owner.toBase58();
        const isTokenProgram = owner === TOKEN_PROGRAM_ID_STR || owner === TOKEN_2022_PROGRAM_ID_STR;
        
        if (!isTokenProgram) {
          rpcFailCount++;
          continue;
        }
        
        const decimals = accountInfo.data[44];
        if (decimals > 18) {
          rpcFailCount++;
          continue;
        }
        
        result.set(mint, decimals);
        resolveCache.set(mint, decimals);
        schedulePersist(mint, decimals, 'rpc');
        rpcSuccessCount++;

        if (tokenPrograms) {
          const program = owner === TOKEN_2022_PROGRAM_ID_STR ? 'token-2022' : 'spl-token';
          tokenPrograms.set(mint, program);
        }
      }
    } catch (e: any) {
      rpcFailCount += batch.length;
      logger.warn('decimals.rpc_batch.error', {
        batchIndex: Math.floor(i / batchSize),
        batchSize: batch.length,
        error: String(e?.message || e),
        cat: 'decimals'
      });
    }
  }
  
  resolutionMetrics.rpcSuccesses += rpcSuccessCount;
  resolutionMetrics.rpcFailures += rpcFailCount;
  
  logger.info('decimals.rpc_batch.complete', {
    total: mints.length,
    resolved: result.size,
    rpcSuccess: rpcSuccessCount,
    rpcFail: rpcFailCount,
    cat: 'decimals'
  });
  
  return result;
}

/**
 * Guaranteed decimal resolution for WebSocket decoders
 * 
 * This function ALWAYS returns a decimals value, using this priority:
 * 1. Anchor decimals (hardcoded for SOL, USDC, etc.)
 * 2. In-memory cache (previously resolved)
 * 3. Direct RPC fetch (authoritative)
 * 4. Jupiter token map (fallback)
 * 5. Default based on mint characteristics (last resort)
 * 
 * This function should be used by WebSocket decoders to avoid
 * falling back to arbitrary defaults that cause 1000x price errors.
 * 
 * @param mint Token mint address
 * @param poolId Pool ID for logging context
 * @param dex DEX name for logging context
 * @returns Always returns a decimals value (never undefined)
 */
export async function resolveDecimalsGuaranteed(
  mint: string,
  poolId?: string,
  dex?: string
): Promise<{ decimals: number; source: 'anchor' | 'cache' | 'rpc' | 'jupiter' | 'default'; validated: boolean }> {
  if (!mint || mint.length < 32) {
    return { decimals: 9, source: 'default', validated: false };
  }
  
  // 1. Anchor decimals (highest priority, always correct)
  if (ANCHOR_DECIMALS.has(mint)) {
    resolutionMetrics.anchorHits++;
    return { decimals: ANCHOR_DECIMALS.get(mint)!, source: 'anchor', validated: true };
  }
  
  // 2. In-memory cache (previously validated)
  if (resolveCache.has(mint)) {
    resolutionMetrics.cacheHits++;
    const cached = resolveCache.get(mint)!;
    // Validate cached value against known tokens
    const known = KNOWN_TOKEN_DECIMALS[mint];
    if (known && known.decimals !== cached) {
      // Cache is wrong for a known token - clear and re-resolve
      resolveCache.delete(mint);
      logger.warn('decimals.cache.mismatch_cleared', {
        mint: mint.slice(0, 12) + '…',
        cached,
        expected: known.decimals,
        tokenName: known.name,
        cat: 'decimals'
      });
    } else {
      return { decimals: cached, source: 'cache', validated: true };
    }
  }
  
  // 3. Direct RPC fetch (authoritative source of truth)
  const rpcDecimals = await resolveDecimalsFromRpc(mint);
  if (rpcDecimals !== undefined) {
    // Validate against known tokens
    const valid = validateDecimalsForMint(mint, rpcDecimals, poolId, dex);
    return { decimals: rpcDecimals, source: 'rpc', validated: valid };
  }
  
  // 4. Jupiter token map (fallback for tokens not found on-chain)
  try {
    const jupMap = await getJupiterMap();
    const jupDecimals = jupMap[mint]?.decimals;
    if (jupDecimals != null && Number.isFinite(jupDecimals) && jupDecimals >= 0 && jupDecimals <= 18) {
      resolveCache.set(mint, jupDecimals);
      schedulePersist(mint, jupDecimals, 'jupiter');
      resolutionMetrics.jupiterHits++;
      const valid = validateDecimalsForMint(mint, jupDecimals, poolId, dex);
      return { decimals: jupDecimals, source: 'jupiter', validated: valid };
    }
  } catch (e) {
    logCatchError('decimals.jupiter_fallback', e);
  }
  
  // 5. Last resort: smart default based on known token patterns
  // This is better than arbitrary 9/6 defaults
  resolutionMetrics.fallbacksUsed++;
  
  // Check if this is a known token that we should have resolved
  const known = KNOWN_TOKEN_DECIMALS[mint];
  if (known) {
    logger.error('decimals.guaranteed.known_token_fallback', {
      mint: mint.slice(0, 12) + '…',
      tokenName: known.name,
      expectedDecimals: known.decimals,
      poolId: poolId?.slice(0, 8) + '…',
      dex,
      warning: 'Using known decimals after all resolution failed - investigate RPC connectivity',
      cat: 'decimals'
    });
    return { decimals: known.decimals, source: 'default', validated: true };
  }
  
  // Truly unknown token - use 9 as default (most common for Solana tokens)
  logger.warn('decimals.guaranteed.unknown_fallback', {
    mint: mint.slice(0, 12) + '…',
    poolId: poolId?.slice(0, 8) + '…',
    dex,
    defaultDecimals: 9,
    warning: 'All decimal resolution methods failed - using default 9',
    cat: 'decimals'
  });
  
  return { decimals: 9, source: 'default', validated: false };
}

/**
 * Batch guaranteed decimal resolution
 * 
 * Efficiently resolves decimals for multiple mints with guaranteed results.
 * Uses batch RPC calls for efficiency.
 * 
 * @param mints Array of mint addresses
 * @param context Optional context for logging
 * @returns Map of mint -> resolution result
 */
export async function resolveDecimalsGuaranteedBatch(
  mints: string[],
  context?: { poolIds?: Map<string, string>; dex?: string }
): Promise<Map<string, { decimals: number; source: 'anchor' | 'cache' | 'rpc' | 'jupiter' | 'default'; validated: boolean }>> {
  const result = new Map<string, { decimals: number; source: 'anchor' | 'cache' | 'rpc' | 'jupiter' | 'default'; validated: boolean }>();
  
  if (!mints.length) return result;
  
  const needsRpc: string[] = [];
  
  // Pass 1: Check anchors and cache
  for (const mint of mints) {
    if (!mint || mint.length < 32) {
      result.set(mint, { decimals: 9, source: 'default', validated: false });
      continue;
    }
    
    if (ANCHOR_DECIMALS.has(mint)) {
      resolutionMetrics.anchorHits++;
      result.set(mint, { decimals: ANCHOR_DECIMALS.get(mint)!, source: 'anchor', validated: true });
      continue;
    }
    
    if (resolveCache.has(mint)) {
      resolutionMetrics.cacheHits++;
      const cached = resolveCache.get(mint)!;
      result.set(mint, { decimals: cached, source: 'cache', validated: true });
      continue;
    }
    
    needsRpc.push(mint);
  }
  
  if (needsRpc.length === 0) return result;
  
  // Pass 2: Batch RPC resolution
  const rpcResults = await resolveDecimalsFromRpcBatch(needsRpc);
  
  for (const mint of needsRpc) {
    if (rpcResults.has(mint)) {
      const decimals = rpcResults.get(mint)!;
      const poolId = context?.poolIds?.get(mint);
      const valid = validateDecimalsForMint(mint, decimals, poolId, context?.dex);
      result.set(mint, { decimals, source: 'rpc', validated: valid });
    }
  }
  
  // Pass 3: Jupiter fallback for remaining
  const needsJupiter = needsRpc.filter(m => !rpcResults.has(m));

  if (needsJupiter.length > 0) {
    try {
      const jupMap = await getJupiterMap();
      for (const mint of needsJupiter) {
        const jupDecimals = jupMap[mint]?.decimals;
        if (jupDecimals != null && Number.isFinite(jupDecimals) && jupDecimals >= 0 && jupDecimals <= 18) {
          resolveCache.set(mint, jupDecimals);
          schedulePersist(mint, jupDecimals, 'jupiter');
          resolutionMetrics.jupiterHits++;
          const poolId = context?.poolIds?.get(mint);
          const valid = validateDecimalsForMint(mint, jupDecimals, poolId, context?.dex);
          result.set(mint, { decimals: jupDecimals, source: 'jupiter', validated: valid });
        }
      }
    } catch (e) {
      logCatchError('decimals.batch.jupiter_fallback', e);
    }
  }
  
  // Pass 4: Defaults for truly unresolved
  for (const mint of mints) {
    if (!result.has(mint)) {
      resolutionMetrics.fallbacksUsed++;
      
      // Check known tokens
      const known = KNOWN_TOKEN_DECIMALS[mint];
      if (known) {
        result.set(mint, { decimals: known.decimals, source: 'default', validated: true });
      } else {
        result.set(mint, { decimals: 9, source: 'default', validated: false });
      }
    }
  }
  
  return result;
}
