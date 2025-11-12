import { readJson } from '../utils/fs.js';
import { CONFIG } from '../utils/config.js';

export type PoolsPayload = { amm: Array<{ mint_a: string; mint_b: string }>; clmm: Array<{ mint_a: string; mint_b: string }> };

export type UniverseMode = 'intersection' | 'union' | 'jupiter' | 'watchlist' | 'minpools';

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

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
    // If something goes wrong, return empty set (will trigger fallback to Jupiter)
    return new Set<string>();
  }
}

export async function computeTokenUniverse(mode?: UniverseMode): Promise<Set<string>> {
  const selected = (mode || (CONFIG.system as any)?.tokenUniverseMode || 'jupiter') as UniverseMode;
  const anchors = getAnchorSet();
  const includeAnchors = (CONFIG.system as any)?.includeAnchorsInUniverse !== false;
  if (selected === 'jupiter') {
    const s = await getJupiterTokenSet(); if (includeAnchors) { for (const m of anchors) s.add(m); } return s;
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
      const fallback = await getJupiterTokenSet();
      if (includeAnchors) { for (const m of anchors) fallback.add(m); }
      return fallback;
    }
    return set;
  }
  
  let set = computeTokenUniverseFromSets(ray, orc, selected, met, metBal, pump, anchors);
  
  // Fallback: if empty, use Jupiter set to avoid emptying graph/routes
  if (set.size === 0) set = await getJupiterTokenSet();
  if (includeAnchors) { for (const m of anchors) set.add(m); }
  return set;
}

export function filterPoolsByUniverse<T extends { mint_a: string; mint_b: string }>(
  pools: { amm: T[]; clmm: T[] },
  tokenSet: Set<string>,
  enableAnchorBridging = true,
  anchors?: Set<string>,
): { amm: T[]; clmm: T[] } {
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
  };
}


