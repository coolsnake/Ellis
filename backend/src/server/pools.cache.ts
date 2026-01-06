import type { AmmPool, ClmmPool, PoolsPayload } from './pools/types.js';

export const raydiumCache: { data: PoolsPayload | null; ts: number; inflight?: Promise<PoolsPayload> } = { data: null, ts: 0 };
export const orcaCache: { data: PoolsPayload | null; ts: number; inflight?: Promise<PoolsPayload> } = { data: null, ts: 0 };
export const meteoraCache: { data: PoolsPayload | null; ts: number; inflight?: Promise<PoolsPayload> } = { data: null, ts: 0 };
export const metbalCache: { data: PoolsPayload | null; ts: number; inflight?: Promise<PoolsPayload> } = { data: null, ts: 0 };
export const pumpswapCache: { data: PoolsPayload | null; ts: number; inflight?: Promise<PoolsPayload> } = { data: null, ts: 0 };

export const vaultBalanceCache: Map<string, bigint> = new Map();

export type PoolCacheSource = 'raydium' | 'orca' | 'meteora' | 'pumpswap' | 'meteora_balanced';

export function findPoolInCache(poolId: string): { pool: AmmPool | ClmmPool; source: PoolCacheSource } | null {
  // Check Orca
  const orcaPools = orcaCache.data;
  if (orcaPools) {
    const orcaAmm = orcaPools.amm.find(p => p.id === poolId);
    if (orcaAmm) return { pool: orcaAmm, source: 'orca' };
    const orcaClmm = orcaPools.clmm.find(p => p.id === poolId);
    if (orcaClmm) return { pool: orcaClmm, source: 'orca' };
  }
  
  // Check Raydium
  const raydiumPools = raydiumCache.data;
  if (raydiumPools) {
    const rayAmm = raydiumPools.amm.find(p => p.id === poolId);
    if (rayAmm) return { pool: rayAmm, source: 'raydium' };
    const rayClmm = raydiumPools.clmm.find(p => p.id === poolId);
    if (rayClmm) return { pool: rayClmm, source: 'raydium' };
  }
  
  // Check Meteora DLMM
  const meteoraPools = meteoraCache.data;
  if (meteoraPools) {
    const metAmm = meteoraPools.amm.find(p => p.id === poolId);
    if (metAmm) return { pool: metAmm, source: 'meteora' };
    const metClmm = meteoraPools.clmm.find(p => p.id === poolId);
    if (metClmm) return { pool: metClmm, source: 'meteora' };
  }
  
  // Check Pumpswap
  const pumpswapPools = pumpswapCache.data;
  if (pumpswapPools) {
    const pumpAmm = pumpswapPools.amm.find(p => p.id === poolId);
    if (pumpAmm) return { pool: pumpAmm, source: 'pumpswap' };
  }
  
  // Check Meteora Balanced (DAMM)
  const metbalPools = metbalCache.data;
  if (metbalPools) {
    const metbalAmm = metbalPools.amm.find(p => p.id === poolId);
    if (metbalAmm) return { pool: metbalAmm, source: 'meteora_balanced' };
  }
  
  return null;
}

export function clearAllPoolCaches(): void {
  try { raydiumCache.data = undefined as any; raydiumCache.ts = 0; raydiumCache.inflight = undefined; } catch {}
  try { orcaCache.data = undefined as any; orcaCache.ts = 0; orcaCache.inflight = undefined; } catch {}
  try { meteoraCache.data = undefined as any; meteoraCache.ts = 0; meteoraCache.inflight = undefined; } catch {}
  try { metbalCache.data = undefined as any; metbalCache.ts = 0; metbalCache.inflight = undefined; } catch {}
  try { pumpswapCache.data = undefined as any; pumpswapCache.ts = 0; pumpswapCache.inflight = undefined; } catch {}
}

export function peekRaydiumPools(): PoolsPayload { return raydiumCache.data || { amm: [], clmm: [] }; }
export function peekOrcaPools(): PoolsPayload { return orcaCache.data || { amm: [], clmm: [] }; }
export function peekMeteoraPools(): PoolsPayload { return meteoraCache.data || { amm: [], clmm: [] }; }
export function peekMeteoraBalancedPools(): PoolsPayload { return metbalCache.data || { amm: [], clmm: [] }; }
export function peekPumpswapPools(): PoolsPayload { return pumpswapCache.data || { amm: [], clmm: [] }; }

/**
 * Update pool objects in cache with validated tick/activeId data and optionally price data.
 * This ensures snapshots save fresh data, not stale cached values.
 *
 * @param updates - Array of pool updates with fresh tick/activeId values and optional price data
 * @returns Number of pools updated
 */
export function updatePoolCacheFromValidation(
  updates: Array<{
    poolId: string;
    dex: 'orca' | 'raydium' | 'meteora';
    currentTick?: number;
    activeId?: number;
    tickSpacing?: number;
    binStep?: number;
    tickArrayLower?: string;
    tickArrayCenter?: string;
    tickArrayUpper?: string;
    binArrayLower?: string;
    binArrayUpper?: string;
    // Price-related fields for full state revalidation
    sqrtPriceX64?: string;
    liquidity?: string;
    price_a_per_b?: number;
  }>
): { updated: number; byDex: Record<string, number>; pricesUpdated: number } {
  let updated = 0;
  let pricesUpdated = 0;
  const byDex: Record<string, number> = { orca: 0, raydium: 0, meteora: 0 };

  for (const update of updates) {
    const { poolId, dex, currentTick, activeId, tickSpacing, binStep,
            tickArrayLower, tickArrayCenter, tickArrayUpper,
            binArrayLower, binArrayUpper,
            sqrtPriceX64, liquidity, price_a_per_b } = update;

    let cache: { data: PoolsPayload | null } | null = null;

    if (dex === 'orca') cache = orcaCache;
    else if (dex === 'raydium') cache = raydiumCache;
    else if (dex === 'meteora') cache = meteoraCache;

    if (!cache?.data?.clmm) continue;

    const pool = cache.data.clmm.find(p => p.id === poolId);
    if (!pool) continue;

    let poolUpdated = false;
    let priceUpdated = false;

    // Update tick/activeId
    if (dex === 'meteora' && activeId !== undefined) {
      (pool as any).active_id = activeId;
      poolUpdated = true;
    } else if ((dex === 'orca' || dex === 'raydium') && currentTick !== undefined) {
      (pool as any).tick_current = currentTick;
      (pool as any).tick_current_index = currentTick;
      poolUpdated = true;
    }

    // Update tick spacing / bin step
    if (tickSpacing !== undefined) {
      pool.tick_spacing = tickSpacing;
    }
    if (dex === 'meteora' && binStep !== undefined) {
      (pool as any).bin_step = binStep;
    }

    // Update tick arrays (Orca/Raydium) - ALWAYS update to clear stale data
    // Use null (not undefined) so values serialize to JSON and don't get lost on save/load
    if (dex === 'orca' || dex === 'raydium') {
      // Set to the validated value, or null to explicitly clear non-existent arrays
      (pool as any).tick_array_lower = tickArrayLower ?? null;
      (pool as any).tick_array_center = tickArrayCenter ?? null;
      (pool as any).tick_array_upper = tickArrayUpper ?? null;
      poolUpdated = true;
    }

    // Update bin arrays (Meteora) - ALWAYS update to clear stale data
    if (dex === 'meteora') {
      (pool as any).bin_array_lower = binArrayLower ?? null;
      (pool as any).bin_array_upper = binArrayUpper ?? null;
      poolUpdated = true;
    }

    // Update price-related fields (for full state revalidation)
    if (sqrtPriceX64 !== undefined) {
      (pool as any).sqrt_price_x64 = Number(sqrtPriceX64);
      (pool as any).sqrt_price_x64_raw = sqrtPriceX64;
      priceUpdated = true;
    }

    if (liquidity !== undefined) {
      (pool as any).liquidity = Number(liquidity);
      (pool as any).liquidity_raw = liquidity;
      priceUpdated = true;
    }

    if (price_a_per_b !== undefined && Number.isFinite(price_a_per_b) && price_a_per_b > 0) {
      pool.price_a_per_b = price_a_per_b;
      priceUpdated = true;
    }

    // Update timestamp
    if (poolUpdated || priceUpdated) {
      pool.updated_ms = Date.now();
      updated++;
      byDex[dex]++;
      if (priceUpdated) pricesUpdated++;
    }
  }

  return { updated, byDex, pricesUpdated };
}