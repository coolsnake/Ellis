import { logger } from '../../utils/logger.js';
import { loadJupiterTokenMap } from '../../utils/tokens.js';
import { Connection, PublicKey } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';
import { CONFIG } from '../../utils/config.js';
import { logCatchError } from '../../utils/errorHandler.js';

// Anchor decimals: highest-priority source of truth for well-known tokens
const ANCHOR_DECIMALS = new Map<string, number>([
  ['So11111111111111111111111111111111111111112', 9],  // SOL
  ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 6], // USDC
  ['Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', 6], // USDT
  ['USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB', 6],  // USD1
]);

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
                resolveCache.set(mint, decimals); // CACHE FOR FUTURE USE
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

