import { readJson } from '../utils/fs.js';
import { CONFIG } from '../utils/config.js';
import { jupiterLimiter } from '../jupiter/rateLimiter.js';

export type PoolsPayload = { amm: Array<{ mint_a: string; mint_b: string }>; clmm: Array<{ mint_a: string; mint_b: string }> };

export type UniverseMode = 'intersection' | 'union' | 'jupiter' | 'jupiterTop' | 'watchlist' | 'minpools' | 'mergedTokens';

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const JUPITER_CATEGORY_BASE = 'https://api.jup.ag/tokens/v2';

type JupiterCategory = 'toporganicscore' | 'toptraded' | 'toptrending';
type JupiterInterval = '5m' | '1h' | '6h' | '24h';
type JupiterTopTokenOptions = { category: JupiterCategory; interval: JupiterInterval; limit: number; cacheTtlMs: number; apiKey?: string };
type JupiterTopCache = { key: string; ts: number; data: Set<string> };

let jupiterTopCache: JupiterTopCache | null = null;

export function normalizeMints(arr: Array<string | undefined | null>): string[] {
  const out: string[] = [];
  for (const v of arr) { const s = String(v || ''); if (s) out.push(s); }
  return Array.from(new Set(out));
}

export async function getJupiterTokenSet(): Promise<Set<string>> {
  try {
    const { loadJupiterTokenMap } = await import('../utils/tokens.js');
    const map = await loadJupiterTokenMap();
    return new Set(Object.keys(map || {}));
  } catch {
    return new Set();
  }
}

export async function getMergedTokenSet(): Promise<Set<string>> {
  try {
    const tokens = await readJson<Array<{ address: string }>>(CONFIG.mergedTokensPath, []);
    const set = new Set<string>();
    for (const t of (tokens || [])) {
      if (t?.address) set.add(t.address);
    }
    return set;
  } catch {
    return new Set();
  }
}

function resolveJupiterTopOptions(): JupiterTopTokenOptions {
  const raw = ((CONFIG.system as any)?.jupiterTopTokens || {}) as Partial<JupiterTopTokenOptions & { category: string; interval: string }>;
  const categories: JupiterCategory[] = ['toporganicscore', 'toptraded', 'toptrending'];
  const intervals: JupiterInterval[] = ['5m', '1h', '6h', '24h'];
  const rawCategory = String(raw.category || 'toptraded').toLowerCase();
  const category = (categories as readonly string[]).includes(rawCategory) ? (rawCategory as JupiterCategory) : 'toptraded';
  const rawInterval = String(raw.interval || '5m').toLowerCase();
  const interval = (intervals as readonly string[]).includes(rawInterval) ? (rawInterval as JupiterInterval) : '5m';
  let limit = Number.isFinite(raw.limit) ? Number(raw.limit) : 100;
  limit = Math.max(1, Math.min(100, Math.floor(limit)));
  const cacheTtlMs = Math.max(30_000, Number(raw.cacheTtlMs ?? 60_000));
  const apiKey = typeof raw.apiKey === 'string' ? raw.apiKey : '';
  return { category, interval, limit, cacheTtlMs, apiKey };
}

export async function getJupiterTopTokenSet(): Promise<Set<string>> {
  const opts = resolveJupiterTopOptions();
  const key = `${opts.category}:${opts.interval}:${opts.limit}`;
  const now = Date.now();
  if (jupiterTopCache && jupiterTopCache.key === key && now - jupiterTopCache.ts < opts.cacheTtlMs) {
    return new Set(jupiterTopCache.data);
  }
  try {
    const url = `${JUPITER_CATEGORY_BASE}/${opts.category}/${opts.interval}?limit=${opts.limit}`;
    await jupiterLimiter.acquire(false);
    // Build headers with x-api-key if configured
    const headers: Record<string, string> = { accept: 'application/json' };
    if (opts.apiKey) {
      headers['x-api-key'] = opts.apiKey;
    }
    const res = await fetch(url, { headers } as any);
    if (!res.ok) throw new Error(`jupiter category http ${res.status}`);
    const payload: any = await res.json();
    const arr: any[] = Array.isArray(payload)
      ? payload
      : (Array.isArray(payload?.value) ? payload.value : (Array.isArray(payload?.data) ? payload.data : []));
    const set = new Set<string>();
    for (const token of arr) {
      const id = typeof token?.id === 'string' ? token.id : (typeof token?.mint === 'string' ? token.mint : '');
      if (id) set.add(id);
    }
    if (set.size === 0) throw new Error('empty top token response');
    jupiterTopCache = { key, ts: now, data: set };
    return new Set(set);
  } catch (err: any) {
    try {
      const { logger } = await import('../utils/logger.js');
      logger.warn('universe.jupiter_top.fetch_failed', { error: String(err?.message || err), cat: 'universe' });
    } catch {}
    if (jupiterTopCache && jupiterTopCache.key === key) return new Set(jupiterTopCache.data);
    return new Set();
  }
}

export async function getWatchlistTokenSet(): Promise<Set<string>> {
  try {
    const wl = await readJson<any[]>(CONFIG.watchlistPath, []);
    const vals = wl.map((t: any) => (typeof t === 'string' ? t : String(t?.id || ''))).filter(Boolean);
    return new Set(vals);
  } catch { return new Set(); }
}

export function getAnchorSet(): Set<string> {
  const sysAnchors = (CONFIG.system as any)?.anchorMints as string[] | undefined;
  const rayAnchors = (CONFIG.raydium as any)?.anchorMints as string[] | undefined;
  // Respect explicit empty lists: if provided, do not fallback to defaults
  if (Array.isArray(sysAnchors)) return new Set(sysAnchors.map(String));
  if (Array.isArray(rayAnchors)) return new Set(rayAnchors.map(String));
  return new Set([SOL, USDC]);
}

export function computeTokenUniverseFromSets(
  rayMints: Set<string>,
  orcaMints: Set<string>,
  mode: UniverseMode,
  meteoraMints?: Set<string>,
  meteoraBalancedMints?: Set<string>,
  pumpswapMints?: Set<string>,
  anchors?: Set<string>,
): Set<string> {
  const a = anchors || getAnchorSet();
  const met = meteoraMints || new Set<string>();
  const metBal = meteoraBalancedMints || new Set<string>();
  const pump = pumpswapMints || new Set<string>();
  
  let set = new Set<string>();
  if (mode === 'intersection') {
    // Token must appear in at least 2 of the 5 DEX sources
    const allMints = new Map<string, number>();
    
    // Count occurrences across all DEX sources
    for (const m of rayMints) allMints.set(m, (allMints.get(m) || 0) + 1);
    for (const m of orcaMints) allMints.set(m, (allMints.get(m) || 0) + 1);
    for (const m of met) allMints.set(m, (allMints.get(m) || 0) + 1);
    for (const m of metBal) allMints.set(m, (allMints.get(m) || 0) + 1);
    for (const m of pump) allMints.set(m, (allMints.get(m) || 0) + 1);
    
    // Include tokens that appear in 2+ sources
    for (const [mint, count] of allMints.entries()) {
      if (count >= 2) set.add(mint);
    }
  } else if (mode === 'union') {
    // Union: all tokens from all DEX sources
    set = new Set<string>([...rayMints, ...orcaMints, ...met, ...metBal, ...pump]);
  } else {
    // For jupiter/watchlist use external sources; caller should provide separately
    set = new Set<string>([...rayMints]);
  }
  
  // Always include anchor tokens
  for (const m of a) set.add(m);
  return set;
}

export async function getSourceTokenSet(source: 'raydium' | 'orca' | 'meteora' | 'meteoraBalanced' | 'pumpswap'): Promise<Set<string>> {
  try {
    const { peekRaydiumPools, peekOrcaPools, peekMeteoraPools, peekMeteoraBalancedPools, peekPumpswapPools } = await import('./pools.js');
    const pools = source === 'raydium' ? peekRaydiumPools() 
      : source === 'orca' ? peekOrcaPools() 
      : source === 'meteora' ? peekMeteoraPools()
      : source === 'meteoraBalanced' ? peekMeteoraBalancedPools()
      : peekPumpswapPools();
    const set = new Set<string>();
    for (const p of (pools?.amm || [])) { if (p?.mint_a) set.add(p.mint_a); if (p?.mint_b) set.add(p.mint_b); }
    for (const p of (pools?.clmm || [])) { if (p?.mint_a) set.add(p.mint_a); if (p?.mint_b) set.add(p.mint_b); }
    return set;
  } catch { return new Set(); }
}

/**
 * Compute token universe based on minimum pool count per pair.
 * This mode includes a token if there are at least `minPoolsPerPair` pools
 * for any pair involving that token, regardless of which DEX(es) those pools are on.
 */
export async function computeTokenUniverseByMinPools(anchors?: Set<string>, includeAnchors = true): Promise<Set<string>> {
  try {
    const { peekRaydiumPools, peekOrcaPools, peekMeteoraPools, peekMeteoraBalancedPools, peekPumpswapPools } = await import('./pools.js');
    
    const r = peekRaydiumPools();
    const o = peekOrcaPools();
    const m = peekMeteoraPools();
    const mb = peekMeteoraBalancedPools();
    const pump = peekPumpswapPools();
    
    const minPools = Math.max(1, Number(((CONFIG.system as any)?.minPoolsPerPair) || 1));
    
    const canonicalPairKey = (mintA: string, mintB: string): string => {
      const a = String(mintA || '');
      const b = String(mintB || '');
      return a <= b ? `${a}-${b}` : `${b}-${a}`;
    };
    
    // Count total pools per pair across all DEXes
    const poolCounts = new Map<string, number>();
    const pairMints = new Map<string, Set<string>>(); // Track which mints are in each pair
    
    const countPools = (arr: any[]) => {
      for (const p of (arr || [])) {
        if (!p?.mint_a || !p?.mint_b) continue;
        const pairKey = canonicalPairKey(p.mint_a, p.mint_b);
        poolCounts.set(pairKey, (poolCounts.get(pairKey) || 0) + 1);
        
        // Track mints in this pair
        if (!pairMints.has(pairKey)) {
          pairMints.set(pairKey, new Set());
        }
        pairMints.get(pairKey)!.add(p.mint_a);
        pairMints.get(pairKey)!.add(p.mint_b);
      }
    };
    
    countPools(r.amm);
    countPools(r.clmm);
    countPools(o.amm);
    countPools(o.clmm);
    countPools(m.amm);
    countPools(m.clmm);
    countPools(mb.amm);
    countPools(pump.amm);
    
    // Collect all tokens from pairs that have at least minPools pools
    const tokenSet = new Set<string>();
    for (const [pairKey, count] of poolCounts.entries()) {
      if (count >= minPools) {
        const mints = pairMints.get(pairKey);
        if (mints) {
          for (const mint of mints) {
            tokenSet.add(mint);
          }
        }
      }
    }
    
    // Add anchors if requested
    if (includeAnchors) {
      const a = anchors || getAnchorSet();
      for (const m of a) tokenSet.add(m);
    }
    
    return tokenSet;
  } catch (e) {
    // If something goes wrong, return empty set
    // The calling code should handle empty universe appropriately based on mode
    return new Set<string>();
  }
}

export async function computeTokenUniverse(mode?: UniverseMode): Promise<Set<string>> {
  const selected = (mode || (CONFIG.system as any)?.tokenUniverseMode || 'union') as UniverseMode;
  const anchors = getAnchorSet();
  const includeAnchors = (CONFIG.system as any)?.includeAnchorsInUniverse !== false;
  
  // Log the selected mode for debugging
  try {
    const { logger } = await import('../utils/logger.js');
    logger.debug('universe.compute.mode', { 
      selected, 
      providedMode: mode, 
      configMode: (CONFIG.system as any)?.tokenUniverseMode, 
      cat: 'universe' 
    });
  } catch {}
  
  if (selected === 'jupiter') {
    const s = await getJupiterTokenSet(); if (includeAnchors) { for (const m of anchors) s.add(m); } return s;
  }
  if (selected === 'mergedTokens') {
    const s = await getMergedTokenSet();
    if (s.size === 0) {
      try {
        const { logger } = await import('../utils/logger.js');
        logger.warn('universe.merged_tokens.empty_fallback_to_jupiter', { cat: 'universe' });
      } catch {}
      const fallback = await getJupiterTokenSet();
      if (includeAnchors) { for (const m of anchors) fallback.add(m); }
      return fallback;
    }
    if (includeAnchors) { for (const m of anchors) s.add(m); }
    return s;
  }
  if (selected === 'jupiterTop') {
    const s = await getJupiterTopTokenSet();
    if (s.size === 0) {
      try {
        const { logger } = await import('../utils/logger.js');
        logger.warn('universe.jupiter_top.empty_fallback_to_jupiter', { category: (CONFIG.system as any)?.jupiterTopTokens?.category, interval: (CONFIG.system as any)?.jupiterTopTokens?.interval, cat: 'universe' });
      } catch {}
      const fallback = await getJupiterTokenSet();
      if (includeAnchors) { for (const m of anchors) fallback.add(m); }
      return fallback;
    }
    if (includeAnchors) { for (const m of anchors) s.add(m); }
    return s;
  }
  if (selected === 'watchlist') {
    const s = await getWatchlistTokenSet(); if (includeAnchors) { for (const m of anchors) s.add(m); } return s;
  }
  
  // Collect tokens from all DEX sources
  const ray = await getSourceTokenSet('raydium');
  const orc = await getSourceTokenSet('orca');
  const met = await getSourceTokenSet('meteora');
  const metBal = await getSourceTokenSet('meteoraBalanced');
  const pump = await getSourceTokenSet('pumpswap');
  
  // Special mode: filter by minimum pool count per pair (not by DEX diversity)
  if (selected === 'minpools') {
    const set = await computeTokenUniverseByMinPools(anchors, includeAnchors);
    if (set.size === 0) {
      // CRITICAL: Only fallback to Jupiter in minpools mode, not in union/intersection
      // This is appropriate because minpools is a quality filter that might legitimately be empty
      try {
        const { logger } = await import('../utils/logger.js');
        logger.warn('universe.minpools.empty_fallback_to_jupiter', { 
          mode: selected, 
          reason: 'minpools_filter_produced_no_tokens',
          cat: 'universe' 
        });
      } catch {}
      const fallback = await getJupiterTokenSet();
      if (includeAnchors) { for (const m of anchors) fallback.add(m); }
      return fallback;
    }
    return set;
  }
  
  let set = computeTokenUniverseFromSets(ray, orc, selected, met, metBal, pump, anchors);
  
  // IMPORTANT: Don't fallback to Jupiter for union/intersection modes
  // If the universe is empty in these modes, it means there are no pools fetched yet
  // Falling back to Jupiter would incorrectly filter out new tokens not on the Jupiter list
  if (set.size === 0) {
    try {
      const { logger } = await import('../utils/logger.js');
      logger.warn('universe.compute.empty_universe', { 
        mode: selected, 
        raydiumTokens: ray.size,
        orcaTokens: orc.size,
        meteoraTokens: met.size,
        meteoraBalancedTokens: metBal.size,
        pumpswapTokens: pump.size,
        reason: 'no_pools_fetched_yet_or_all_filtered',
        cat: 'universe' 
      });
    } catch {}
    // Return empty set instead of falling back to Jupiter
    // This ensures we don't accidentally filter out new tokens
    if (includeAnchors) { for (const m of anchors) set.add(m); }
  } else {
    if (includeAnchors) { for (const m of anchors) set.add(m); }
  }
  
  return set;
}

export function filterPoolsByUniverse<T extends { mint_a: string; mint_b: string }>(
  pools: { amm: T[]; clmm: T[]; cpmm?: T[] },
  tokenSet: Set<string>,
  enableAnchorBridging = true,
  anchors?: Set<string>,
): { amm: T[]; clmm: T[]; cpmm: T[] } {
  const a = anchors || getAnchorSet();
  const allow = (x: T): boolean => {
    const inSetA = tokenSet.has(x.mint_a);
    const inSetB = tokenSet.has(x.mint_b);
    if (inSetA && inSetB) return true;
    if (!enableAnchorBridging) return false;
    return a.has(x.mint_a) || a.has(x.mint_b);
  };
  return {
    amm: (pools.amm || []).filter(allow),
    clmm: (pools.clmm || []).filter(allow),
    cpmm: (pools.cpmm || []).filter(allow),
  };
}


