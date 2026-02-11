import type {
  AmmPool,
  ClmmPool,
  CpmmPool,
  PoolsPayload,
} from "./pools/types.js";

export const raydiumCache: {
  data: PoolsPayload | null;
  ts: number;
  inflight?: Promise<PoolsPayload>;
} = { data: null, ts: 0 };
export const orcaCache: {
  data: PoolsPayload | null;
  ts: number;
  inflight?: Promise<PoolsPayload>;
} = { data: null, ts: 0 };
export const meteoraCache: {
  data: PoolsPayload | null;
  ts: number;
  inflight?: Promise<PoolsPayload>;
} = { data: null, ts: 0 };
export const metbalCache: {
  data: PoolsPayload | null;
  ts: number;
  inflight?: Promise<PoolsPayload>;
} = { data: null, ts: 0 };
export const pumpswapCache: {
  data: PoolsPayload | null;
  ts: number;
  inflight?: Promise<PoolsPayload>;
} = { data: null, ts: 0 };
export const cpmmCache: {
  data: { cpmm: CpmmPool[] } | null;
  ts: number;
  inflight?: Promise<{ cpmm: CpmmPool[] }>;
} = { data: null, ts: 0 };

export const vaultBalanceCache: Map<string, bigint> = new Map();

export type PoolCacheSource =
  | "raydium"
  | "raydium-cpmm"
  | "orca"
  | "meteora"
  | "pumpswap"
  | "meteora_balanced";

/** O(1) pool lookup index — self-heals on cache miss, rebuilt on HTTP refresh */
const poolIndex = new Map<
  string,
  { pool: AmmPool | ClmmPool | CpmmPool; source: PoolCacheSource }
>();

export function findPoolInCache(
  poolId: string
): { pool: AmmPool | ClmmPool; source: PoolCacheSource } | null {
  // Fast path: O(1) index lookup
  const indexed = poolIndex.get(poolId);
  if (indexed)
    return indexed as { pool: AmmPool | ClmmPool; source: PoolCacheSource };

  // Slow path: linear scan with self-healing index population
  const orcaPools = orcaCache.data;
  if (orcaPools) {
    const orcaAmm = orcaPools.amm.find((p) => p.id === poolId);
    if (orcaAmm) {
      poolIndex.set(poolId, { pool: orcaAmm, source: "orca" });
      return { pool: orcaAmm, source: "orca" };
    }
    const orcaClmm = orcaPools.clmm.find((p) => p.id === poolId);
    if (orcaClmm) {
      poolIndex.set(poolId, { pool: orcaClmm, source: "orca" });
      return { pool: orcaClmm, source: "orca" };
    }
  }

  const raydiumPools = raydiumCache.data;
  if (raydiumPools) {
    const rayAmm = raydiumPools.amm.find((p) => p.id === poolId);
    if (rayAmm) {
      poolIndex.set(poolId, { pool: rayAmm, source: "raydium" });
      return { pool: rayAmm, source: "raydium" };
    }
    const rayClmm = raydiumPools.clmm.find((p) => p.id === poolId);
    if (rayClmm) {
      poolIndex.set(poolId, { pool: rayClmm, source: "raydium" });
      return { pool: rayClmm, source: "raydium" };
    }
  }

  const meteoraPools = meteoraCache.data;
  if (meteoraPools) {
    const metAmm = meteoraPools.amm.find((p) => p.id === poolId);
    if (metAmm) {
      poolIndex.set(poolId, { pool: metAmm, source: "meteora" });
      return { pool: metAmm, source: "meteora" };
    }
    const metClmm = meteoraPools.clmm.find((p) => p.id === poolId);
    if (metClmm) {
      poolIndex.set(poolId, { pool: metClmm, source: "meteora" });
      return { pool: metClmm, source: "meteora" };
    }
  }

  const pumpswapPools = pumpswapCache.data;
  if (pumpswapPools) {
    const pumpAmm = pumpswapPools.amm.find((p) => p.id === poolId);
    if (pumpAmm) {
      poolIndex.set(poolId, { pool: pumpAmm, source: "pumpswap" });
      return { pool: pumpAmm, source: "pumpswap" };
    }
  }

  const metbalPools = metbalCache.data;
  if (metbalPools) {
    const metbalAmm = metbalPools.amm.find((p) => p.id === poolId);
    if (metbalAmm) {
      poolIndex.set(poolId, { pool: metbalAmm, source: "meteora_balanced" });
      return { pool: metbalAmm, source: "meteora_balanced" };
    }
  }

  const cpmmPools = cpmmCache.data;
  if (cpmmPools) {
    const cpmmPool = cpmmPools.cpmm.find((p) => p.id === poolId);
    if (cpmmPool) {
      poolIndex.set(poolId, {
        pool: cpmmPool as unknown as AmmPool,
        source: "raydium-cpmm",
      });
      return { pool: cpmmPool as unknown as AmmPool, source: "raydium-cpmm" };
    }
  }

  return null;
}

/**
 * Rebuild the pool index from all caches.
 * Call after HTTP pool refreshes that replace entire cache arrays.
 */
export function rebuildPoolIndex(): void {
  poolIndex.clear();
  const sources: Array<[PoolCacheSource, { data: PoolsPayload | null }]> = [
    ["orca", orcaCache],
    ["raydium", raydiumCache],
    ["meteora", meteoraCache],
    ["pumpswap", pumpswapCache],
    ["meteora_balanced", metbalCache],
  ];
  for (const [source, cache] of sources) {
    if (!cache.data) continue;
    for (const p of cache.data.amm || [])
      if (p.id) poolIndex.set(p.id, { pool: p, source });
    for (const p of cache.data.clmm || [])
      if (p.id) poolIndex.set(p.id, { pool: p, source });
    for (const p of (cache.data as any).cpmm || [])
      if (p.id) poolIndex.set(p.id, { pool: p, source });
  }
  if (cpmmCache.data) {
    for (const p of cpmmCache.data.cpmm || [])
      if (p.id)
        poolIndex.set(p.id, {
          pool: p as unknown as AmmPool,
          source: "raydium-cpmm",
        });
  }
}

export function clearAllPoolCaches(): void {
  poolIndex.clear();
  try {
    raydiumCache.data = undefined as any;
    raydiumCache.ts = 0;
    raydiumCache.inflight = undefined;
  } catch {}
  try {
    orcaCache.data = undefined as any;
    orcaCache.ts = 0;
    orcaCache.inflight = undefined;
  } catch {}
  try {
    meteoraCache.data = undefined as any;
    meteoraCache.ts = 0;
    meteoraCache.inflight = undefined;
  } catch {}
  try {
    metbalCache.data = undefined as any;
    metbalCache.ts = 0;
    metbalCache.inflight = undefined;
  } catch {}
  try {
    pumpswapCache.data = undefined as any;
    pumpswapCache.ts = 0;
    pumpswapCache.inflight = undefined;
  } catch {}
  try {
    cpmmCache.data = undefined as any;
    cpmmCache.ts = 0;
    cpmmCache.inflight = undefined;
  } catch {}
}

export function peekRaydiumPools(): PoolsPayload {
  return raydiumCache.data || { amm: [], clmm: [], cpmm: [] };
}
export function peekOrcaPools(): PoolsPayload {
  return orcaCache.data || { amm: [], clmm: [], cpmm: [] };
}
export function peekMeteoraPools(): PoolsPayload {
  return meteoraCache.data || { amm: [], clmm: [], cpmm: [] };
}
export function peekMeteoraBalancedPools(): PoolsPayload {
  return metbalCache.data || { amm: [], clmm: [], cpmm: [] };
}
export function peekPumpswapPools(): PoolsPayload {
  return pumpswapCache.data || { amm: [], clmm: [], cpmm: [] };
}
export function peekCpmmPools(): { cpmm: CpmmPool[] } {
  return cpmmCache.data || { cpmm: [] };
}

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
    dex: "orca" | "raydium" | "meteora";
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
    const {
      poolId,
      dex,
      currentTick,
      activeId,
      tickSpacing,
      binStep,
      tickArrayLower,
      tickArrayCenter,
      tickArrayUpper,
      binArrayLower,
      binArrayUpper,
      sqrtPriceX64,
      liquidity,
      price_a_per_b,
    } = update;

    let cache: { data: PoolsPayload | null } | null = null;

    if (dex === "orca") cache = orcaCache;
    else if (dex === "raydium") cache = raydiumCache;
    else if (dex === "meteora") cache = meteoraCache;

    if (!cache?.data?.clmm) continue;

    const pool = cache.data.clmm.find((p) => p.id === poolId);
    if (!pool) continue;

    let poolUpdated = false;
    let priceUpdated = false;

    // Update tick/activeId
    if (dex === "meteora" && activeId !== undefined) {
      (pool as any).active_id = activeId;
      poolUpdated = true;
    } else if (
      (dex === "orca" || dex === "raydium") &&
      currentTick !== undefined
    ) {
      (pool as any).tick_current = currentTick;
      (pool as any).tick_current_index = currentTick;
      poolUpdated = true;
    }

    // Update tick spacing / bin step
    if (tickSpacing !== undefined) {
      pool.tick_spacing = tickSpacing;
    }
    if (dex === "meteora" && binStep !== undefined) {
      (pool as any).bin_step = binStep;
    }

    // Update tick arrays (Orca/Raydium) - ALWAYS update to clear stale data
    // Use null (not undefined) so values serialize to JSON and don't get lost on save/load
    if (dex === "orca" || dex === "raydium") {
      // Set to the validated value, or null to explicitly clear non-existent arrays
      (pool as any).tick_array_lower = tickArrayLower ?? null;
      (pool as any).tick_array_center = tickArrayCenter ?? null;
      (pool as any).tick_array_upper = tickArrayUpper ?? null;
      poolUpdated = true;
    }

    // Update bin arrays (Meteora) - ALWAYS update to clear stale data
    if (dex === "meteora") {
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

    if (
      price_a_per_b !== undefined &&
      Number.isFinite(price_a_per_b) &&
      price_a_per_b > 0
    ) {
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
