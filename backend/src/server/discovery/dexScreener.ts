/**
 * DexScreener API Client
 * 
 * Fetches pool information from DexScreener and maps it to internal types.
 * Rate limited to stay under DexScreener's 300 requests/minute limit.
 */

import { logger } from '../../utils/logger.js';
import { CONFIG } from '../../utils/config.js';
import type { 
  DexScreenerPool, 
  InternalPoolMapping, 
  DiscoveredPool,
  InternalDex,
  PoolKind,
  PoolVariant 
} from './types.js';

// ============================================================================
// Constants
// ============================================================================

const DEXSCREENER_BASE_URL = 'https://api.dexscreener.com';
const CHAIN_ID = 'solana';

/**
 * Default delay between requests (ms) to stay under rate limits.
 * DexScreener allows 300 requests/minute = 5 requests/second = 200ms between requests
 */
const DEFAULT_DELAY_MS = 200;

// ============================================================================
// DexScreener to Internal Mapping
// ============================================================================

/**
 * Map a DexScreener dexId + labels to internal pool type.
 * 
 * Based on observed DexScreener response patterns:
 * - raydium + ["CLMM"] → Raydium CLMM
 * - raydium + ["CPMM"] → Raydium CPMM
 * - raydium + (no label) → Raydium AMM v4
 * - orca + any → Orca Whirlpool (CLMM)
 * - meteora + ["DLMM"] → Meteora DLMM
 * - meteora + ["DYN"] → Meteora DAMM v1
 * - meteora + ["DYN2"] → Meteora DAMM v2
 * - pumpswap + any → PumpSwap AMM
 * 
 * @param pool DexScreener pool response
 * @returns Internal mapping or null if unsupported
 */
export function mapDexScreenerToInternal(pool: DexScreenerPool): InternalPoolMapping | null {
  const labels = (pool.labels || []).map(l => l.toUpperCase());
  const dexId = pool.dexId?.toLowerCase() || '';
  
  switch (dexId) {
    case 'raydium':
      if (labels.includes('CLMM')) {
        return { dex: 'raydium', poolKind: 'clmm' };
      } else if (labels.includes('CPMM')) {
        return { dex: 'raydium', poolKind: 'cpmm' };
      } else {
        // No CLMM/CPMM label = AMM v4
        return { dex: 'raydium', poolKind: 'amm' };
      }
      
    case 'orca':
      // All Orca pools are Whirlpool CLMM (labels: ["wp"])
      return { dex: 'orca', poolKind: 'clmm' };
      
    case 'meteora':
      if (labels.includes('DLMM')) {
        return { dex: 'meteora', poolKind: 'clmm' };
      } else if (labels.includes('DYN2')) {
        // DAMM v2 (CP-AMM)
        return { dex: 'meteora_balanced', poolKind: 'amm', variant: 'v2' };
      } else if (labels.includes('DYN')) {
        // DAMM v1
        return { dex: 'meteora_balanced', poolKind: 'amm', variant: 'v1' };
      }
      // Unknown Meteora variant - log and skip
      logger.debug('dexscreener.unknown_meteora_variant', { 
        pairAddress: pool.pairAddress, 
        labels: pool.labels,
        cat: 'discovery' 
      });
      return null;
      
    case 'pumpswap':
      return { dex: 'pumpswap', poolKind: 'amm' };
      
    default:
      // Unsupported DEX (e.g., phoenix, lifinity, etc.)
      return null;
  }
}

/**
 * Get display name for an internal DEX + pool kind combination
 */
export function getPoolTypeName(mapping: InternalPoolMapping): string {
  const { dex, poolKind, variant } = mapping;
  
  switch (dex) {
    case 'raydium':
      return `Raydium ${poolKind.toUpperCase()}`;
    case 'orca':
      return 'Orca Whirlpool';
    case 'meteora':
      return 'Meteora DLMM';
    case 'meteora_balanced':
      return `Meteora DAMM ${variant || 'v1'}`;
    case 'pumpswap':
      return 'PumpSwap';
    default:
      return `${dex} ${poolKind}`;
  }
}

// ============================================================================
// Filtering Functions
// ============================================================================

/**
 * Filter pools by supported DEX IDs
 */
export function filterBySupportedDex(
  pools: DexScreenerPool[], 
  supportedDexIds?: string[]
): DexScreenerPool[] {
  const supported = new Set(
    (supportedDexIds || getDefaultSupportedDexIds()).map(d => d.toLowerCase())
  );
  return pools.filter(p => supported.has(p.dexId?.toLowerCase() || ''));
}

/**
 * Filter pools by minimum liquidity
 */
export function filterByMinLiquidity(
  pools: DexScreenerPool[], 
  minUsd: number
): DexScreenerPool[] {
  return pools.filter(p => {
    const liq = p.liquidity?.usd;
    return typeof liq === 'number' && liq >= minUsd;
  });
}

/**
 * Filter out pools that are already tracked
 */
export function filterOutTracked(
  pools: DexScreenerPool[], 
  trackedPools: Set<string>
): DexScreenerPool[] {
  return pools.filter(p => !trackedPools.has(p.pairAddress));
}

/**
 * Get default supported DEX IDs
 */
export function getDefaultSupportedDexIds(): string[] {
  const configSupported = (CONFIG as any)?.discovery?.supportedDexIds;
  if (Array.isArray(configSupported) && configSupported.length > 0) {
    return configSupported;
  }
  return ['raydium', 'orca', 'meteora', 'pumpswap'];
}

// ============================================================================
// API Client
// ============================================================================

let lastRequestTime = 0;

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Rate-limited delay before making a request
 */
async function rateLimitDelay(): Promise<void> {
  const delayMs = (CONFIG as any)?.discovery?.dexScreenerDelayMs || DEFAULT_DELAY_MS;
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  
  if (elapsed < delayMs) {
    await sleep(delayMs - elapsed);
  }
  
  lastRequestTime = Date.now();
}

/**
 * Fetch all pools for a token from DexScreener
 * 
 * @param mint Token mint address
 * @returns Array of DexScreener pools
 */
export async function fetchDexScreenerPools(mint: string): Promise<DexScreenerPool[]> {
  await rateLimitDelay();
  
  const url = `${DEXSCREENER_BASE_URL}/token-pairs/v1/${CHAIN_ID}/${mint}`;
  
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/json' }
    });
    
    if (!res.ok) {
      if (res.status === 429) {
        logger.warn('dexscreener.rate_limited', { mint: mint.slice(0, 8), cat: 'discovery' });
        // Wait longer before next request
        lastRequestTime = Date.now() + 5000;
        return [];
      }
      throw new Error(`DexScreener HTTP ${res.status}`);
    }
    
    const data = await res.json();
    
    // Response is an array of pools
    if (Array.isArray(data)) {
      return data as DexScreenerPool[];
    }
    
    // Fallback for wrapped response
    if (data?.pairs && Array.isArray(data.pairs)) {
      return data.pairs as DexScreenerPool[];
    }
    
    logger.debug('dexscreener.unexpected_response', { 
      mint: mint.slice(0, 8), 
      hasData: !!data,
      cat: 'discovery' 
    });
    return [];
    
  } catch (err: any) {
    logger.warn('dexscreener.fetch_error', { 
      mint: mint.slice(0, 8), 
      error: String(err?.message || err),
      cat: 'discovery' 
    });
    return [];
  }
}

/**
 * Fetch pools for multiple tokens with rate limiting
 * 
 * @param mints Array of token mint addresses
 * @param options Configuration options
 * @returns Map of mint → pools
 */
export async function fetchDexScreenerPoolsBatch(
  mints: string[],
  options?: {
    batchSize?: number;
    onProgress?: (completed: number, total: number) => void;
  }
): Promise<Map<string, DexScreenerPool[]>> {
  const results = new Map<string, DexScreenerPool[]>();
  const batchSize = options?.batchSize || 10;
  
  for (let i = 0; i < mints.length; i += batchSize) {
    const batch = mints.slice(i, i + batchSize);
    
    const batchResults = await Promise.all(
      batch.map(async (mint) => {
        const pools = await fetchDexScreenerPools(mint);
        return { mint, pools };
      })
    );
    
    for (const { mint, pools } of batchResults) {
      results.set(mint, pools);
    }
    
    if (options?.onProgress) {
      options.onProgress(Math.min(i + batchSize, mints.length), mints.length);
    }
  }
  
  return results;
}

// ============================================================================
// Discovery Pipeline Helpers
// ============================================================================

/**
 * Process pools from DexScreener and attach internal mappings
 * 
 * @param pools Raw DexScreener pools
 * @returns Pools with valid internal mappings
 */
export function mapAndFilterPools(pools: DexScreenerPool[]): DiscoveredPool[] {
  const result: DiscoveredPool[] = [];
  
  for (const pool of pools) {
    const mapping = mapDexScreenerToInternal(pool);
    if (mapping) {
      result.push({ ...pool, mapping });
    }
  }
  
  return result;
}

/**
 * Group discovered pools by DEX
 */
export function groupPoolsByDex(pools: DiscoveredPool[]): Map<InternalDex, DiscoveredPool[]> {
  const groups = new Map<InternalDex, DiscoveredPool[]>();
  
  for (const pool of pools) {
    const dex = pool.mapping.dex;
    const existing = groups.get(dex) || [];
    existing.push(pool);
    groups.set(dex, existing);
  }
  
  return groups;
}

/**
 * Group discovered pools by DEX and pool kind
 */
export function groupPoolsByDexAndKind(
  pools: DiscoveredPool[]
): Map<string, DiscoveredPool[]> {
  const groups = new Map<string, DiscoveredPool[]>();
  
  for (const pool of pools) {
    const key = `${pool.mapping.dex}:${pool.mapping.poolKind}${pool.mapping.variant ? `:${pool.mapping.variant}` : ''}`;
    const existing = groups.get(key) || [];
    existing.push(pool);
    groups.set(key, existing);
  }
  
  return groups;
}

/**
 * Extract pool addresses from discovered pools
 */
export function extractPoolAddresses(pools: DiscoveredPool[]): string[] {
  return pools.map(p => p.pairAddress);
}

/**
 * Get discovery statistics for a set of pools
 */
export function getDiscoveryStats(pools: DiscoveredPool[]): Record<string, number> {
  const stats: Record<string, number> = {};
  
  for (const pool of pools) {
    const key = getPoolTypeName(pool.mapping);
    stats[key] = (stats[key] || 0) + 1;
  }
  
  return stats;
}
