import { readJson, writeJson } from './fs.js';
import { CONFIG } from './config.js';
import { searchTokens } from '../jupiter/tokenApi.js';
import { Connection, PublicKey } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';

export type TokenMap = Record<string, { mint: string; decimals: number }>;
export type JupToken = { address: string; name: string; symbol: string; decimals: number; usdPrice?: number };

export async function loadTokenMap(): Promise<TokenMap> {
  return readJson<TokenMap>(CONFIG.tokensPath, {
    SOL: { mint: 'So11111111111111111111111111111111111111112', decimals: 9 },
    USDC: { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 },
  });
}

const resolveCache: Record<string, { mint: string; decimals: number }> = {};

export async function resolveMint(symbolOrMint: string): Promise<{ mint: string; decimals: number }> {
  const input = symbolOrMint || '';
  const upper = input.toUpperCase();
  if (resolveCache[upper]) return resolveCache[upper];
  const map = await loadTokenMap();
  if (map[upper]) {
    resolveCache[upper] = map[upper];
    return map[upper];
  }
  
  // Hard-coded SOL mint address check (most common case)
  const SOL_MINT = 'So11111111111111111111111111111111111111112';
  if (input === SOL_MINT || upper === 'SOL') {
    const sol = { mint: SOL_MINT, decimals: 9 };
    resolveCache[upper] = sol;
    resolveCache[SOL_MINT] = sol;
    return sol;
  }
  
  // If looks like a mint (base58-ish and long), validate it's actually a mint before resolving
  if (input.length > 30) {
    // Try to fetch decimals on-chain for accurate handling
    try {
      const conn = new Connection(CONFIG.rpcUrl, { commitment: 'confirmed', disableRetryOnRateLimit: true } as any);
      const mintPk = new PublicKey(input);
      
      // First check if account exists and is owned by Token Program
      // This prevents trying to resolve non-mint accounts (like pool addresses, vault addresses, etc.)
      const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
      const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
      
      const accountInfo = await conn.getAccountInfo(mintPk, 'confirmed').catch(() => null);
      if (accountInfo) {
        const owner = accountInfo.owner.toBase58();
        const isTokenProgram = owner === TOKEN_PROGRAM_ID.toBase58() || owner === TOKEN_2022_PROGRAM_ID.toBase58();
        
        // Only try to get mint info if account is owned by Token Program
        if (isTokenProgram) {
          const mintInfo = await getMint(conn, mintPk);
          const decimals = Number(mintInfo.decimals ?? 6);
          const out = { mint: input, decimals };
          resolveCache[upper] = out;
          return out;
        } else {
          // Account exists but is not a mint - don't try to resolve it
          // This is likely a pool address, vault address, or other account type
          // Don't log warning - this is expected for non-mint addresses
          // Continue to Token API search in case it's actually a symbol
        }
      } else {
        // Account doesn't exist - continue to Token API search
      }
    } catch (e: any) {
      // Network error or other issue - try to check if it matches SOL mint
      if (input === SOL_MINT) {
        const sol = { mint: SOL_MINT, decimals: 9 };
        resolveCache[upper] = sol;
        resolveCache[SOL_MINT] = sol;
        return sol;
      }
      // For other errors, continue to Token API search
    }
  }
  // Try Token API V2 search (for symbols or if mint resolution failed)
  const results = await searchTokens(input).catch(() => []);
  const first = results[0];
  if (first?.id) {
    // persist mapping for future lookups (merge to preserve existing fields like usdc/sol)
    const current = await loadTokenMap();
    const prev = current[upper] || {} as any;
    current[upper] = { ...prev, mint: first.id, decimals: first.decimals ?? 6 } as any;
    await writeJson(CONFIG.tokensPath, current);
    // Opportunistic price bootstrap for the newly discovered token
    try {
      const { fetchPricesByMints } = await import('../jupiter/jupiter.js');
      const { setPrices } = await import('../server/priceStore.js');
      const fresh = await fetchPricesByMints([first.id], { catOverride: 'token-resolve' });
      setPrices(fresh);
    } catch {}
    resolveCache[upper] = current[upper];
    return current[upper];
  }
  throw new Error(`Unknown token: ${symbolOrMint}`);
}

// Jupiter token list support (separate from local tokens.json)
// Use v2 verified tag endpoint; attempt pagination when available.
const JUP_TOKENS_URL_V2 = 'https://lite-api.jup.ag/tokens/v2/tag?query=verified';

export async function fetchAndCacheJupiterTokens(): Promise<JupToken[]> {
  const out: JupToken[] = [];
  try {
    let cursor: string | null = null;
    for (let page = 0; page < 20; page++) {
      const url = new URL(JUP_TOKENS_URL_V2);
      url.searchParams.set('query', 'verified');
      url.searchParams.set('limit', '500');
      if (cursor) url.searchParams.set('cursor', cursor);
      const res = await fetch(url.toString(), { headers: { accept: 'application/json' } as any } as any);
      if (!res.ok) throw new Error(`jup tokens http ${res.status}`);
      const data: any = await res.json();
      const arr: any[] = Array.isArray(data)
        ? data
        : (Array.isArray((data as any)?.data) ? (data as any).data : (Array.isArray((data as any)?.tokens) ? (data as any).tokens : []));
      for (const t of (arr || [])) {
        const address = String(t?.address || t?.id || '');
        if (!address) continue;
        out.push({ address, name: String(t?.name || ''), symbol: String(t?.symbol || ''), decimals: Number(t?.decimals ?? 0), usdPrice: (typeof t?.usdPrice === 'number') ? t.usdPrice : undefined });
      }
      const next: string | undefined = (data && typeof data === 'object') ? ((data as any)?.cursor || (data as any)?.nextCursor) : undefined;
      cursor = next && String(next).length ? String(next) : null;
      if (!cursor) break;
      // Guard: if endpoint returned a plain array, do single page
      if (Array.isArray(data)) break;
    }
    await writeJson(CONFIG.jupTokensPath, out);
    return out;
  } catch (e: any) {
    const cached = await readJson<JupToken[]>(CONFIG.jupTokensPath, []);
    return cached;
  }
}

export async function loadJupiterTokenMap(): Promise<Record<string, { symbol: string; decimals: number; usdPrice?: number }>> {
  const cached = await readJson<JupToken[]>(CONFIG.jupTokensPath, []);
  const map: Record<string, { symbol: string; decimals: number; usdPrice?: number }> = {};
  for (const t of (cached || [])) {
    if (!t?.address) continue;
    map[t.address] = { symbol: t.symbol || t.name || t.address.slice(0, 4), decimals: Number(t.decimals ?? 0), usdPrice: (typeof (t as any)?.usdPrice === 'number') ? (t as any).usdPrice : undefined };
  }
  return map;
}

export async function resolveMintViaJupiter(mint: string): Promise<{ symbol: string; decimals: number } | null> {
  try {
    const url = `https://tokens.jup.ag/token/${mint}`;
    const res = await fetch(url, { headers: { accept: 'application/json' } as any } as any);
    if (!res.ok) throw new Error(`jup token http ${res.status}`);
    const t: any = await res.json();
    if (t?.address) {
      const out = { symbol: String(t.symbol || t.name || ''), decimals: Number(t.decimals ?? 0) };
      // Update cache file
      try {
        const cur = await readJson<JupToken[]>(CONFIG.jupTokensPath, []);
        const idx = cur.findIndex(x => x.address === mint);
        if (idx >= 0) cur[idx] = { address: mint, name: String(t.name || ''), symbol: out.symbol, decimals: out.decimals };
        else cur.push({ address: mint, name: String(t.name || ''), symbol: out.symbol, decimals: out.decimals });
        await writeJson(CONFIG.jupTokensPath, cur);
      } catch {}
      return out;
    }
  } catch {}
  return null;
}

/**
 * Enrich missing token decimals via RPC batch query
 * Returns a map of mint -> decimals for tokens that were successfully fetched
 * 
 * This function is designed to be called from normalizers during pool fetching
 * to ensure decimals are available before price calculations
 */
export async function enrichMissingDecimals(
  mints: string[],
  jupiterMap: Record<string, { decimals: number }>,
  options?: { logger?: any; batchSize?: number }
): Promise<Map<string, number>> {
  const logger = options?.logger;
  const batchSize = options?.batchSize ?? 100;
  const result = new Map<string, number>();
  
  // Filter to only mints not in Jupiter map and not already in cache
  const missingMints = mints.filter(m => {
    if (!m || m.length < 32) return false;
    if (jupiterMap[m]) return false;
    if (resolveCache[m]) {
      result.set(m, resolveCache[m].decimals);
      return false;
    }
    return true;
  });
  
  if (missingMints.length === 0) return result;
  
  try {
    if (logger) {
      logger.info('token.enrich.start', {
        total: mints.length,
        missing: missingMints.length,
        cat: 'tokens'
      });
    }
    
    const conn = new Connection(CONFIG.rpcUrl, { commitment: 'confirmed', disableRetryOnRateLimit: true } as any);
    const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
    
    // Process in batches to avoid overwhelming RPC
    for (let i = 0; i < missingMints.length; i += batchSize) {
      const batch = missingMints.slice(i, i + batchSize);
      const pubkeys = batch.map(m => {
        try {
          return new PublicKey(m);
        } catch {
          return null;
        }
      }).filter(Boolean) as PublicKey[];
      
      if (pubkeys.length === 0) continue;
      
      try {
        // Batch fetch account infos
        const accountInfos = await conn.getMultipleAccountsInfo(pubkeys, 'confirmed');
        
        for (let j = 0; j < accountInfos.length; j++) {
          const accountInfo = accountInfos[j];
          const mint = batch[j];
          if (!accountInfo || !mint) continue;
          
          try {
            const owner = accountInfo.owner.toBase58();
            const isTokenProgram = owner === TOKEN_PROGRAM_ID.toBase58() || owner === TOKEN_2022_PROGRAM_ID.toBase58();
            
            if (isTokenProgram) {
              // Parse mint account data directly to get decimals
              // Mint layout: first byte is option (1), then decimals at offset 44
              const data = accountInfo.data;
              if (data.length >= 82) {
                const decimals = data[44]; // Decimals is a u8 at offset 44
                if (decimals <= 18) { // Sanity check
                  result.set(mint, decimals);
                  resolveCache[mint] = { mint, decimals };
                  
                  if (logger) {
                    logger.debug('token.enrich.found', {
                      mint,
                      decimals,
                      cat: 'tokens'
                    });
                  }
                }
              }
            } else {
              if (logger) {
                logger.debug('token.enrich.not_mint', {
                  mint,
                  owner,
                  cat: 'tokens'
                });
              }
            }
          } catch (err: any) {
            if (logger) {
              logger.warn('token.enrich.parse_error', {
                mint,
                error: err.message,
                cat: 'tokens'
              });
            }
          }
        }
      } catch (err: any) {
        if (logger) {
          logger.warn('token.enrich.batch_error', {
            batchStart: i,
            batchSize: batch.length,
            error: err.message,
            cat: 'tokens'
          });
        }
      }
    }
    
    if (logger) {
      logger.info('token.enrich.complete', {
        requested: missingMints.length,
        enriched: result.size,
        cat: 'tokens'
      });
    }
    
    // Auto-persist enriched decimals to Jupiter token map cache
    if (result.size > 0) {
      try {
        const jupTokens = await readJson<JupToken[]>(CONFIG.jupTokensPath, []);
        let updated = 0;
        
        for (const [mint, decimals] of result.entries()) {
          const existing = jupTokens.find(t => t.address === mint);
          if (existing) {
            if (existing.decimals !== decimals) {
              existing.decimals = decimals;
              updated++;
            }
          } else {
            jupTokens.push({
              address: mint,
              name: '',
              symbol: mint.slice(0, 4),
              decimals
            });
            updated++;
          }
        }
        
        if (updated > 0) {
          await writeJson(CONFIG.jupTokensPath, jupTokens);
          if (logger) {
            logger.info('token.enrich.persisted', {
              enriched: result.size,
              updated,
              cat: 'tokens'
            });
          }
        }
      } catch (err: any) {
        if (logger) {
          logger.warn('token.enrich.persist_failed', {
            error: err.message,
            cat: 'tokens'
          });
        }
      }
    }
  } catch (err: any) {
    if (logger) {
      logger.error('token.enrich.error', {
        error: err.message,
        cat: 'tokens'
      });
    }
  }
  
  return result;
}

/**
 * Helper function for normalizers: enrich decimals for mints found in pools
 * This should be called at the start of each normalizer before price calculations
 */
export async function enrichPoolTokenDecimals(
  pools: any[],
  options?: { logger?: any }
): Promise<void> {
  const mints = new Set<string>();
  for (const pool of pools) {
    if (pool.mint_a || pool.base_mint) mints.add(pool.mint_a || pool.base_mint);
    if (pool.mint_b || pool.quote_mint) mints.add(pool.mint_b || pool.quote_mint);
  }
  
  if (mints.size === 0) return;
  
  const jupMap = await loadJupiterTokenMap();
  await enrichMissingDecimals(Array.from(mints), jupMap, options);
}


