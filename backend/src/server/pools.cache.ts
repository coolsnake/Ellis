import type { AmmPool, ClmmPool, PoolsPayload } from './pools/types.js';

export const raydiumCache: { data: PoolsPayload | null; ts: number; inflight?: Promise<PoolsPayload> } = { data: null, ts: 0 };
export const orcaCache: { data: PoolsPayload | null; ts: number; inflight?: Promise<PoolsPayload> } = { data: null, ts: 0 };
export const meteoraCache: { data: PoolsPayload | null; ts: number; inflight?: Promise<PoolsPayload> } = { data: null, ts: 0 };
export const metbalCache: { data: PoolsPayload | null; ts: number; inflight?: Promise<PoolsPayload> } = { data: null, ts: 0 };
export const pumpswapCache: { data: PoolsPayload | null; ts: number; inflight?: Promise<PoolsPayload> } = { data: null, ts: 0 };

export const vaultBalanceCache: Map<string, bigint> = new Map();

export function findPoolInCache(poolId: string): { pool: AmmPool | ClmmPool; source: 'raydium' | 'orca' | 'meteora' } | null {
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
  
  // Check Meteora
  const meteoraPools = meteoraCache.data;
  if (meteoraPools) {
    const metAmm = meteoraPools.amm.find(p => p.id === poolId);
    if (metAmm) return { pool: metAmm, source: 'meteora' };
    const metClmm = meteoraPools.clmm.find(p => p.id === poolId);
    if (metClmm) return { pool: metClmm, source: 'meteora' };
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
