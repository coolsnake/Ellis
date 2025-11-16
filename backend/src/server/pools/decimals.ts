import { logger } from '../../utils/logger.js';
import { loadJupiterTokenMap } from '../../utils/tokens.js';
import { Connection, PublicKey } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';
import { CONFIG } from '../../utils/config.js';

// Anchor decimals: highest-priority source of truth for well-known tokens
const ANCHOR_DECIMALS = new Map<string, number>([
  ['So11111111111111111111111111111111111111112', 9],  // SOL
  ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 6], // USDC
  ['Es9vMFrzaCERfCkS7fGXx9bK6A7bP4J1yDrJZGB48JpN', 6], // USDT
  ['USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB', 6],  // USD1
]);

// In-memory cache for resolved decimals
const resolveCache = new Map<string, number>();

// Jupiter map cache (refreshed periodically)
let jupMapCache: Record<string, { decimals: number }> | null = null;
let jupMapCacheTime = 0;
const JUP_MAP_TTL_MS = 5 * 60 * 1000; // 5 minutes

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
    } catch {}
  }
  
  return undefined;
}

/**
 * Batch resolve decimals for multiple mints efficiently
 */
export async function resolveManyDecimals(
  mints: string[],
  options?: { logger?: any; batchSize?: number }
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  const log = options?.logger || logger;
  const batchSize = options?.batchSize ?? 100;
  
  // First pass: Check anchors and cache
  const needsLookup = new Set<string>();
  for (const mint of mints) {
    if (!mint || mint.length < 32) continue;
    
    // Check anchors
    if (ANCHOR_DECIMALS.has(mint)) {
      result.set(mint, ANCHOR_DECIMALS.get(mint)!);
      continue;
    }
    
    // Check cache
    if (resolveCache.has(mint)) {
      result.set(mint, resolveCache.get(mint)!);
      continue;
    }
    
    needsLookup.add(mint);
  }
  
  if (needsLookup.size === 0) return result;
  
  // Second pass: Check Jupiter map
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
  
  if (needsRpc.size === 0) return result;
  
  try {
    log.info('decimals.batch.rpc.start', {
      total: mints.length,
      needsRpc: needsRpc.size,
      cat: 'decimals'
    });
  } catch {}
  
  // Third pass: Batch RPC fetch for remaining
  const conn = new Connection(CONFIG.rpcUrl, { commitment: 'confirmed', disableRetryOnRateLimit: true } as any);
  const TOKEN_PROGRAM_ID_STR = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  const TOKEN_2022_PROGRAM_ID_STR = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
  
  const mintsToFetch = Array.from(needsRpc);
  
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
        if (!accountInfo || !mint) continue;
        
        try {
          const owner = accountInfo.owner.toBase58();
          const isTokenProgram = owner === TOKEN_PROGRAM_ID_STR || owner === TOKEN_2022_PROGRAM_ID_STR;
          
          if (isTokenProgram && accountInfo.data.length >= 45) {
            // Decimals is u8 at offset 44
            const decimals = accountInfo.data[44];
            if (decimals <= 18) {
              result.set(mint, decimals);
              resolveCache.set(mint, decimals);
            }
          }
        } catch {}
      }
    } catch (e: any) {
      try {
        log.warn('decimals.batch.rpc.error', {
          batchIndex: i / batchSize,
          error: String(e?.message || e),
          cat: 'decimals'
        });
      } catch {}
    }
  }
  
  try {
    log.info('decimals.batch.rpc.complete', {
      total: mints.length,
      resolved: result.size,
      cat: 'decimals'
    });
  } catch {}
  
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

