import { CONFIG } from '../../utils/config.js';
import { logger } from '../../utils/logger.js';
import { logCatchError } from '../../utils/errorHandler.js';

/**
 * Quote hierarchy: determines which token should be on the B (quote) side
 * Higher priority = should be quote (on B side)
 */
const DEFAULT_SOL_MINTS = [
  'So11111111111111111111111111111111111111112', // Native SOL / wrapped SOL
];

const DEFAULT_STABLE_MINTS = [
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB',  // USD1
];

const DEFAULT_QUOTE_PRIORITY = DEFAULT_STABLE_MINTS;

let quotePriorityCache: Map<string, number> | null = null;
let solMintSetCache: Set<string> | null = null;
let stableMintSetCache: Set<string> | null = null;

function normalizeMintList(value: unknown, fallback: string[]): string[] {
  if (Array.isArray(value)) {
    return value.map((m) => String(m));
  }
  // Handle comma-separated string from config/env
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.split(',').map(m => m.trim()).filter(m => m.length > 0);
  }
  return fallback;
}

function mergeMintLists(preferred: string[], defaults: string[]): string[] {
  const seen = new Set<string>(preferred);
  const out = [...preferred];
  for (const mint of defaults) {
    if (!seen.has(mint)) {
      out.push(mint);
      seen.add(mint);
    }
  }
  return out;
}

export function getSolMintSet(): Set<string> {
  if (solMintSetCache) return solMintSetCache;
  try {
    const sys = (CONFIG as any)?.system || {};
    const configured = normalizeMintList(sys.solMints, DEFAULT_SOL_MINTS);
    const merged = mergeMintLists(configured, DEFAULT_SOL_MINTS);
    solMintSetCache = new Set(merged);
    return solMintSetCache;
  } catch {
    solMintSetCache = new Set(DEFAULT_SOL_MINTS);
    return solMintSetCache;
  }
}

export function getStableMintSet(): Set<string> {
  if (stableMintSetCache) return stableMintSetCache;
  try {
    const sys = (CONFIG as any)?.system || {};
    const configured = normalizeMintList(sys.stableMints, DEFAULT_STABLE_MINTS);
    const merged = mergeMintLists(configured, DEFAULT_STABLE_MINTS);
    stableMintSetCache = new Set(merged);
    return stableMintSetCache;
  } catch {
    stableMintSetCache = new Set(DEFAULT_STABLE_MINTS);
    return stableMintSetCache;
  }
}

/**
 * Get quote priority map from config or defaults
 */
function getQuotePriorityMap(): Map<string, number> {
  if (quotePriorityCache) return quotePriorityCache;
  
  try {
    const sys = (CONFIG as any)?.system || {};
    const configured = normalizeMintList(sys.quoteHierarchy, DEFAULT_QUOTE_PRIORITY);
    const prioritized = mergeMintLists(configured, DEFAULT_QUOTE_PRIORITY);
    quotePriorityCache = new Map(
      prioritized.map((mint, index) => [String(mint), index])
    );
    
    return quotePriorityCache;
  } catch {
    quotePriorityCache = new Map(
      DEFAULT_QUOTE_PRIORITY.map((mint, index) => [mint, index])
    );
    return quotePriorityCache;
  }
}

/**
 * Determine canonical orientation for a mint pair
 * Returns 'keep' if current orientation is canonical, 'swap' if should be swapped
 */
export function canonicalOrientation(mintA: string, mintB: string): 'keep' | 'swap' {
  const solMints = getSolMintSet();
  const stableMints = getStableMintSet();

  const aStable = stableMints.has(mintA);
  const bStable = stableMints.has(mintB);
  if (aStable !== bStable) {
    // Put stablecoins on B/quote side
    return aStable ? 'swap' : 'keep';
  }

  const aSol = solMints.has(mintA);
  const bSol = solMints.has(mintB);
  if (aSol !== bSol) {
    // Keep SOL (or wSOL) on the A/base side
    return aSol ? 'keep' : 'swap';
  }

  const quotePriority = getQuotePriorityMap();
  const rankA = quotePriority.get(mintA) ?? Number.POSITIVE_INFINITY;
  const rankB = quotePriority.get(mintB) ?? Number.POSITIVE_INFINITY;
  
  if (Number.isFinite(rankA) && Number.isFinite(rankB)) {
    return rankA < rankB ? 'swap' : 'keep';
  }
  if (Number.isFinite(rankA)) {
    return 'swap';
  }
  if (Number.isFinite(rankB)) {
    return 'keep';
  }
  return mintA <= mintB ? 'keep' : 'swap';
}

/**
 * Swap all A/B fields in a pool object
 */
export function swapPoolFields<T extends Record<string, any>>(obj: T): T {
  const out: any = { ...obj };
  
  // Swap mints
  const aMint = out.mint_a;
  const bMint = out.mint_b;
  out.mint_a = bMint;
  out.mint_b = aMint;

  // Invert price (A per B becomes B per A, so invert)
  if (typeof out.price_a_per_b === 'number' && out.price_a_per_b > 0) {
    out.price_a_per_b = 1 / out.price_a_per_b;
  }
  
  // Swap any keys that end with _a/_b
  const keys = Object.keys(out);
  const touched = new Set<string>();
  
  for (const k of keys) {
    if (touched.has(k)) continue;
    if (k === 'mint_a' || k === 'mint_b') continue;
    
    // CRITICAL FIX: Don't swap native_ fields - they preserve original on-chain orientation
    // native_mint_a/b, native_decimals_a/b, native_account_a/b must stay in native order
    // so websocket updates can correctly match native reserves with native decimals
    if (k.startsWith('native_')) continue;
    
    let kb: string | null = null;
    if (k.includes('_a_')) {
      kb = k.replace('_a_', '_b_');
    } else if (k.endsWith('_a')) {
      kb = k.slice(0, -2) + '_b';
    }
    
    if (kb && (kb in out) && kb !== 'mint_b' && !touched.has(kb)) {
      const tmp = out[k];
      out[k] = out[kb];
      out[kb] = tmp;
      touched.add(k);
      touched.add(kb);
    }
  }
  
  // Special alias pairs (for backwards compatibility)
  const aliasPairs: Array<[string, string]> = [
    ['source_account', 'target_account']
  ];
  
  for (const [ka, kb] of aliasPairs) {
    if (ka in out && kb in out) {
      const tmp = out[ka];
      out[ka] = out[kb];
      out[kb] = tmp;
    }
  }
  
  // PRESERVE orientation-independent fields (don't swap these)
  // - Raydium AMM Serum market fields (market_id, market_bids, etc.)
  // - Pool metadata (lp_mint, pool program IDs, etc.)
  // These are already correct and don't depend on mint_a/mint_b orientation
  
  return out as T;
}

/**
 * Canonicalize an array of pools
 */
export function canonicalizePools<T extends { mint_a: string; mint_b: string }>(
  pools: T[]
): T[] {
  return pools.map(pool => {
    const orientation = canonicalOrientation(pool.mint_a, pool.mint_b);
    if (orientation === 'keep') return pool;
    
    const swapped = swapPoolFields(pool);
    
    // DIAGNOSTIC: Log price inversions for debugging magnitude issues
    const origPrice = (pool as any).price_a_per_b;
    const newPrice = (swapped as any).price_a_per_b;
    
    if (typeof origPrice === 'number' && typeof newPrice === 'number' && 
        origPrice > 0 && newPrice > 0) {
      const expectedInverse = 1 / origPrice;
      const priceDeviation = Math.abs(newPrice - expectedInverse) / expectedInverse;
      
      // Log if deviation is significant or if price magnitude is suspiciously large
      if (priceDeviation > 0.01 || newPrice > 100000 || origPrice > 100000) {
        try {
          logger.info('canonical.swap.price_check', {
            dex: (pool as any).dex,
            pool_id: ((pool as any).id || '').slice(0, 12),
            orig_mint_a: (pool as any).mint_a?.slice(0, 8),
            orig_mint_b: (pool as any).mint_b?.slice(0, 8),
            new_mint_a: (swapped as any).mint_a?.slice(0, 8),
            new_mint_b: (swapped as any).mint_b?.slice(0, 8),
            orig_price: origPrice,
            new_price: newPrice,
            expected_inverse: expectedInverse,
            deviation_pct: (priceDeviation * 100).toFixed(4),
            orig_decimals_a: (pool as any).decimals_a,
            orig_decimals_b: (pool as any).decimals_b,
            new_decimals_a: (swapped as any).decimals_a,
            new_decimals_b: (swapped as any).decimals_b,
            cat: 'canonical'
          });
        } catch (e) { logCatchError('pools.canonical', e); }
      }
    }
    
    return swapped;
  });
}

/**
 * Clear cache (useful for testing with different configs)
 */
export function clearCanonicalCache(): void {
  quotePriorityCache = null;
  solMintSetCache = null;
  stableMintSetCache = null;
}

