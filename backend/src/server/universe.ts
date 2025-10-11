import { readJson } from '../utils/fs.js';
import { CONFIG } from '../utils/config.js';

export type PoolsPayload = { amm: Array<{ mint_a: string; mint_b: string }>; clmm: Array<{ mint_a: string; mint_b: string }> };

export type UniverseMode = 'intersection' | 'union' | 'jupiter' | 'watchlist';

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
  anchors?: Set<string>,
): Set<string> {
  const a = anchors || getAnchorSet();
  let set = new Set<string>();
  if (mode === 'intersection') {
    // Intersection for any of the 3 DEX: raydium, orca, meteora
    const meteoraMints: Set<string> = (arguments.length > 3 && arguments[3] instanceof Set) ? arguments[3] as Set<string> : new Set();

    // Get all unique token sets present (handle signature as (ray, orca, mode, meteora, anchors?))
    // Legacy callers won't pass meteora, so if 4th arg is not a Set use empty set

    // Do all pairwise intersections and take the union of those intersected sets
    for (const m of rayMints) {
      if (orcaMints.has(m) || meteoraMints.has(m)) set.add(m);
    }
    for (const m of orcaMints) {
      if (meteoraMints.has(m) && !set.has(m)) set.add(m);
    }
    // If all 3 are empty, set remains empty. If only 2 sets, intersect as usual.
  } else if (mode === 'union') {
    set = new Set<string>([...rayMints, ...orcaMints]);
  } else {
    // For jupiter/watchlist use external sources; caller should provide separately
    set = new Set<string>([...rayMints]);
  }
  for (const m of a) set.add(m);
  return set;
}

export async function getSourceTokenSet(source: 'raydium' | 'orca'): Promise<Set<string>> {
  try {
    const { peekRaydiumPools, peekOrcaPools } = await import('./pools.js');
    const pools = source === 'raydium' ? peekRaydiumPools() : peekOrcaPools();
    const set = new Set<string>();
    for (const p of (pools?.amm || [])) { if (p?.mint_a) set.add(p.mint_a); if (p?.mint_b) set.add(p.mint_b); }
    for (const p of (pools?.clmm || [])) { if (p?.mint_a) set.add(p.mint_a); if (p?.mint_b) set.add(p.mint_b); }
    return set;
  } catch { return new Set(); }
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
  const ray = await getSourceTokenSet('raydium');
  const orc = await getSourceTokenSet('orca');
  let set = computeTokenUniverseFromSets(ray, orc, selected, anchors);
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


