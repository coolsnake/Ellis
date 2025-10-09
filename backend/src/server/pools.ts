import { logger } from '../utils/logger.js';
import { emit } from './realtime.js';
import { CONFIG } from '../utils/config.js';
import { readJson } from '../utils/fs.js';
// Defer web3 imports to runtime to prevent type issues in environments without types
// import { PublicKey } from '@solana/web3.js';
import type { AmmPool, ClmmPool, PoolsPayload } from './pools/types.js';
import { fetchRaydiumPoolsRaw as fetchRaydiumPoolsRawImpl, normalizeRaydiumPools as normalizeRaydiumPoolsImpl } from './pools/raydium.js';
import { fetchOrcaHttp as fetchOrcaHttpImpl, normalizeOrcaHttp as normalizeOrcaHttpImpl } from './pools/orca.js';
import { fetchMeteoraHttp as fetchMeteoraHttpImpl, normalizeMeteoraHttp as normalizeMeteoraHttpImpl } from './pools/meteora.js';
import { httpLogStart, httpLogResponse, httpLog429, httpLogNonOk } from './pools/httpLog.js';
import { fetchSaberRegistry as fetchSaberRegistryImpl, normalizeSaberRegistry as normalizeSaberRegistryImpl } from './pools/saber.js';
import { fetchMeteoraBalancedHttp as fetchMeteoraBalancedHttpImpl, normalizeMeteoraBalancedHttp as normalizeMeteoraBalancedHttpImpl } from './pools/meteoraBalanced.js';

const raydiumCache: { data: PoolsPayload | null; ts: number; inflight?: Promise<PoolsPayload> } = { data: null, ts: 0 };
const orcaCache: { data: PoolsPayload | null; ts: number; inflight?: Promise<PoolsPayload> } = { data: null, ts: 0 };
const meteoraCache: { data: PoolsPayload | null; ts: number; inflight?: Promise<PoolsPayload> } = { data: null, ts: 0 };
const saberCache: { data: PoolsPayload | null; ts: number; inflight?: Promise<PoolsPayload> } = { data: null, ts: 0 };
const metbalCache: { data: PoolsPayload | null; ts: number; inflight?: Promise<PoolsPayload> } = { data: null, ts: 0 };

// WS lifecycle flags: defer websocket subscriptions until graph signals readiness
let wsAllowed: boolean = false;
let wsSetupActive: boolean = false;
let targetedWsActive: boolean = false;

function toB58Any(v: any): string {
  try { if (v && typeof v.toBase58 === 'function') return String(v.toBase58()); } catch {}
  try { const s = v?.toString?.(); if (typeof s === 'string') { const m = /^PublicKey\(([^)]+)\)$/.exec(s); return m ? m[1] : s; } } catch {}
  return typeof v === 'string' ? v : '';
}

// Apply token mint blocklist across normalized pools
function applyTokenMintBlocklist<T extends { mint_a: string; mint_b: string }>(
  pools: { amm: T[]; clmm: T[] },
  blocklist: Set<string>
): { amm: T[]; clmm: T[] } {
  if (!blocklist || blocklist.size === 0) return pools;
  const allow = (p: T) => !blocklist.has(p.mint_a) && !blocklist.has(p.mint_b);
  return {
    amm: (pools.amm || []).filter(allow),
    clmm: (pools.clmm || []).filter(allow),
  };
}

// Simple in-memory metrics for pool fetches and results
const poolsMetrics: {
  raydium: {
    fetches: number; lastMs: number; lastAmm: number; lastClmm: number;
    filteredAmm: number; filteredClmm: number; universe: string; zeroOverlapSkips: number;
    scannedPoolAccs: number; updatedFromPoolAccs: number; scannedVaults: number; updatedFromVaults: number;
    ownerClmmCount: number; ownerAmmCount: number; http429: number; backoffMs: number; apiBatches: number; apiBatchSizeAvg: number;
  };
  orca: { fetches: number; lastMs: number; lastAmm: number; lastClmm: number };
  meteora: { fetches: number; lastMs: number; lastClmm: number };
  saber: { fetches: number; lastMs: number; lastAmm: number; http429?: number; backoffMs?: number };
  meteora_balanced: { fetches: number; lastMs: number; lastAmm: number };
} = {
  raydium: {
    fetches: 0, lastMs: 0, lastAmm: 0, lastClmm: 0,
    filteredAmm: 0, filteredClmm: 0, universe: '', zeroOverlapSkips: 0,
    scannedPoolAccs: 0, updatedFromPoolAccs: 0, scannedVaults: 0, updatedFromVaults: 0,
    ownerClmmCount: 0, ownerAmmCount: 0, http429: 0, backoffMs: 0, apiBatches: 0, apiBatchSizeAvg: 0,
  },
  orca: { fetches: 0, lastMs: 0, lastAmm: 0, lastClmm: 0 },
  meteora: { fetches: 0, lastMs: 0, lastClmm: 0 },
  saber: { fetches: 0, lastMs: 0, lastAmm: 0, http429: 0, backoffMs: 0 },
  meteora_balanced: { fetches: 0, lastMs: 0, lastAmm: 0 },
};

export function getPoolsMetrics(): any {
  return poolsMetrics;
}

// Raydium HTTP fetcher is implemented in ./pools/raydium.ts

 

 

 

// Compute normalized pool deltas (updated entries only) based on id and key fields
export function diffNormalizedPools(prev: PoolsPayload | null | undefined, next: PoolsPayload): { amm: AmmPool[]; clmm: ClmmPool[]; addedAmm: number; removedAmm: number; addedClmm: number; removedClmm: number } {
  const byId = <T extends { id: string }>(arr: T[] | undefined | null) => {
    const m = new Map<string, T>();
    for (const it of (arr || [])) { if (it && it.id) m.set(String(it.id), it); }
    return m;
  };
  const pA = byId(prev?.amm); const pC = byId(prev?.clmm);
  const nA = byId(next.amm); const nC = byId(next.clmm);
  const updatedAmm: AmmPool[] = [];
  const updatedClmm: ClmmPool[] = [];
  const eps = 1e-9;
  const changedAmm = (a?: AmmPool, b?: AmmPool): boolean => {
    if (!a || !b) return true;
    if (Math.abs((a.price_a_per_b || 0) - (b.price_a_per_b || 0)) > eps) return true;
    if (Math.abs((a.liquidity_base || 0) - (b.liquidity_base || 0)) > eps) return true;
    if ((a.tvl_usd || 0) !== (b.tvl_usd || 0)) return true;
    return false;
  };
  const changedClmm = (a?: ClmmPool, b?: ClmmPool): boolean => {
    if (!a || !b) return true;
    if (Math.abs((a.sqrt_price_x64 || 0) - (b.sqrt_price_x64 || 0)) > 0) return true;
    if (Math.abs((a.liquidity || 0) - (b.liquidity || 0)) > 0) return true;
    if ((a.tvl_usd || 0) !== (b.tvl_usd || 0)) return true;
    if (Math.abs((a.price_a_per_b || 0) - (b.price_a_per_b || 0)) > eps) return true;
    return false;
  };
  for (const [id, nx] of nA) { const pv = pA.get(id); if (!pv || changedAmm(pv, nx)) updatedAmm.push(nx); }
  for (const [id, nx] of nC) { const pv = pC.get(id); if (!pv || changedClmm(pv, nx)) updatedClmm.push(nx); }
  const addedAmm = Math.max(0, nA.size - pA.size);
  const addedClmm = Math.max(0, nC.size - pC.size);
  const removedAmm = Math.max(0, pA.size - nA.size);
  const removedClmm = Math.max(0, pC.size - nC.size);
  return { amm: updatedAmm, clmm: updatedClmm, addedAmm, removedAmm, addedClmm, removedClmm };
}

export async function normalizeRaydiumPools(raw: any): Promise<PoolsPayload> { return normalizeRaydiumPoolsImpl(raw); }

// Synchronous default normalizer for tests that import without awaiting.
// Mirrors core fields from normalizeRaydiumPools but avoids async imports and network calls.
export function defaultNormalizeRaydiumPools(raw: any): PoolsPayload {
  const now = Date.now();
  const amm: any[] = [];
  const clmm: any[] = [];
  const arr: any[] = Array.isArray(raw?.data?.data)
    ? raw.data.data
    : (Array.isArray(raw?.data) ? raw.data : (Array.isArray(raw) ? raw : []));
  const toMint = (v: any): string => {
    if (!v) return '';
    if (typeof v === 'string') return v;
    if ((v as any)?.address) return String((v as any).address);
    return '';
  };
  const toFeeBps = (v: any): number => {
    const n = Number(v);
    if (!Number.isFinite(n)) return 30;
    return n <= 1 ? Math.round(n * 10_000) : Math.round(n);
  };
  for (const it of (arr || [])) {
    if (!it) continue;
    const id = String(it?.id || it?.address || it?.pool_id || it?.ammId || '');
    const mintA = toMint(it?.mintA);
    const mintB = toMint(it?.mintB);
    if (!id || !mintA || !mintB) continue;
    const typeStr = String(it?.type || it?.poolType || '').toLowerCase();
    const pooltype = Array.isArray((it as any)?.pooltype) ? (it as any).pooltype : [];
    const isClmm = (
      typeStr.includes('concentrated') ||
      pooltype.map((s: any) => String(s).toLowerCase()).includes('clmm') ||
      typeof (it as any)?.tickSpacing === 'number' ||
      (typeof (it as any)?.sqrtPriceX64 !== 'undefined' || typeof (it as any)?.sqrtPrice !== 'undefined')
    );
    const fee_bps = toFeeBps((it as any)?.feeRate ?? (it as any)?.tradeFeeRate ?? (it as any)?.feeBps ?? (it as any)?.tradeFeeBps);
    let decA = Number((it?.mintA as any)?.decimals);
    let decB = Number((it?.mintB as any)?.decimals);
    const price = Number((it as any)?.price);
    const tvl = Number((it as any)?.tvl);
    const mintAmountA = Number((it as any)?.mintAmountA);
    const mintAmountB = Number((it as any)?.mintAmountB);
    if (isClmm) {
      const tick = Number((it as any)?.tickSpacing ?? (it as any)?.config?.tickSpacing ?? 0);
      const sqrt = Number((it as any)?.sqrtPriceX64 ?? (it as any)?.sqrtPrice ?? 0);
      const liquidity = Number((it as any)?.liquidity ?? 0);
      const tvl_usd = Number.isFinite(tvl) && tvl > 0 ? tvl : undefined;
      // Derive A per 1 B from sqrt if possible
      let price_from_sqrt = 0;
      if (sqrt > 0 && Number.isFinite(decA) && Number.isFinite(decB)) {
        const two64 = Math.pow(2, 64);
        const ratio = sqrt / two64;
        const cand = Math.pow(10, (decB as number) - (decA as number)) / (ratio * ratio);
        price_from_sqrt = Number.isFinite(cand) && cand > 0 ? cand : 0;
      }
      const px = price_from_sqrt > 0 ? price_from_sqrt : (Number(price) > 0 ? Number(price) : 0);
      clmm.push({ id, dex: 'Raydium', mint_a: mintA, mint_b: mintB, fee_bps, sqrt_price_x64: Number.isFinite(sqrt) ? sqrt : 0, liquidity: Number.isFinite(liquidity) ? liquidity : 0, tick_spacing: Number.isFinite(tick) ? tick : 0, updated_ms: now, price_a_per_b: px > 0 ? px : undefined, decimals_a: Number.isFinite(decA) ? decA : undefined, decimals_b: Number.isFinite(decB) ? decB : undefined, pool_kind: 'clmm', tvl_usd } as any);
    } else {
      const tvl_usd = Number.isFinite(tvl) && tvl > 0 ? tvl : undefined;
      // Treat mintAmountA/B as whole amounts (legacy API behavior in tests); fallback to reserveA/B
      const reserveA = Number((it as any)?.reserveA ?? NaN);
      const reserveB = Number((it as any)?.reserveB ?? NaN);
      const amount_a_whole = Number.isFinite(mintAmountA) ? mintAmountA : (Number.isFinite(reserveA) ? reserveA : undefined);
      const amount_b_whole = Number.isFinite(mintAmountB) ? mintAmountB : (Number.isFinite(reserveB) ? reserveB : undefined);
      // Legacy/alternate reserve fields used in tests (fallback when whole amounts missing)
      const reserveA0 = Number((it as any)?.reserveA ?? 0);
      const reserveB0 = Number((it as any)?.reserveB ?? 0);
      const price_res = (Number.isFinite(amount_a_whole as any) && Number.isFinite(amount_b_whole as any) && (amount_b_whole as number) > 0)
        ? ((amount_a_whole as number) / (amount_b_whole as number))
        : ((reserveB0 > 0) ? (reserveA0 / reserveB0) : 0);
      const price_res_decs = (Number.isFinite(decA) && Number.isFinite(decB) && Number.isFinite(mintAmountA) && Number.isFinite(mintAmountB) && (mintAmountB as number) > 0)
        ? ((mintAmountA as number) / Math.pow(10, decA as number)) / ((mintAmountB as number) / Math.pow(10, decB as number))
        : 0;
      const px = price_res_decs > 0 ? price_res_decs : (price_res > 0 ? price_res : (Number(price) > 0 ? Number(price) : 0));
      amm.push({ id, dex: 'Raydium', mint_a: mintA, mint_b: mintB, fee_bps, price_a_per_b: Number.isFinite(px) ? px : 0, updated_ms: now, pool_kind: 'amm', tvl_usd, amount_a_whole, amount_b_whole, decimals_a: Number.isFinite(decA) ? decA : undefined, decimals_b: Number.isFinite(decB) ? decB : undefined } as any);
    }
  }
  return { amm, clmm } as any;
}

let rayTimer: any | undefined;
let orcaTimer: any | undefined;
let meteoraTimer: any | undefined;
let wsUnsubscribe: (() => void) | undefined;
let healthTimer: any | undefined;
let lastWsEventMs: number = 0;
let wsHealthy: boolean = false;
let aggTimer: any | undefined;
const wsCounts: { raydium: number; orca: number; meteora?: number } = { raydium: 0, orca: 0, meteora: 0 };
let attachedOrcaPools: number = 0;
let attachedRaydiumPools: number = 0;
let attachedMeteoraPools: number = 0;

// When true, the next call to startRaydiumRefreshLoop will attach WS subscriptions
// without starting timers or triggering an extra initial HTTP warmup fetch.
let suppressInitialOnce: boolean = false;
export function startPoolWebsocketsOnlyOnce(): void {
  suppressInitialOnce = true;
  try { enablePoolWebsocketRefreshes(); } catch {}
  startRaydiumRefreshLoop();
}

export function getWsActivity(): { orca: { attached: number; events: number }; raydium: { attached: number; events: number }; meteora: { attached: number; events: number } } {
  return {
    orca: { attached: attachedOrcaPools, events: wsCounts.orca || 0 },
    raydium: { attached: attachedRaydiumPools, events: wsCounts.raydium || 0 },
    meteora: { attached: attachedMeteoraPools, events: (wsCounts.meteora || 0) as number },
  };
}

// Compute target counts for WS subscriptions based on current graph edges per source
export async function getWsTargets(): Promise<{ orca: { target: number }; raydium: { target: number }; meteora: { target: number } }> {
  try {
    const { getGraphSnapshot } = await import('./graph.js');
    const snap = await getGraphSnapshot(false);
    const ray = new Set<string>();
    const orc = new Set<string>();
    const met = new Set<string>();
    for (const e of (snap?.edges || [])) {
      const pid = String((e as any)?.pool_id || '');
      if (!pid) continue;
      const base = pid.replace(/-rev$/, '');
      const dex = String((e as any)?.dex || '');
      if (dex === 'Raydium') ray.add(base);
      else if (dex === 'Orca') orc.add(base);
      else if (dex === 'Meteora') met.add(base);
    }
    const out = { orca: { target: orc.size }, raydium: { target: ray.size }, meteora: { target: met.size } };
    try { (getWsTargets as any)._last = out; } catch {}
    return out;
  } catch {
    const out = { orca: { target: 0 }, raydium: { target: 0 }, meteora: { target: 0 } };
    try { (getWsTargets as any)._last = out; } catch {}
    return out;
  }
}

// Expose cache ages for observability (ms since last fetch)
export function getPoolCacheAges(): { raydium: number; orca: number; meteora: number; saber: number; meteora_balanced: number; ttl: { raydium: number; orca: number; meteora: number; saber: number; meteora_balanced: number } } {
  const now = Date.now();
  const rayTtl = Number((CONFIG as any)?.raydium?.cacheTtlMs || 300_000);
  const orcTtl = Number((CONFIG as any)?.orca?.cacheTtlMs || 300_000);
  const metTtl = Number(((CONFIG as any)?.meteora?.cacheTtlMs) || 300_000);
  const sabTtl = Number(((CONFIG as any)?.saber?.cacheTtlMs) || 300_000);
  const mblTtl = Number(((CONFIG as any)?.meteoraBalanced?.cacheTtlMs) || 300_000);
  const rayAge = raydiumCache.ts ? (now - raydiumCache.ts) : Number.POSITIVE_INFINITY;
  const orcAge = orcaCache.ts ? (now - orcaCache.ts) : Number.POSITIVE_INFINITY;
  const metAge = meteoraCache.ts ? (now - meteoraCache.ts) : Number.POSITIVE_INFINITY;
  const sabAge = saberCache.ts ? (now - saberCache.ts) : Number.POSITIVE_INFINITY;
  const mblAge = metbalCache.ts ? (now - metbalCache.ts) : Number.POSITIVE_INFINITY;
  return { raydium: rayAge, orca: orcAge, meteora: metAge, saber: sabAge, meteora_balanced: mblAge, ttl: { raydium: rayTtl, orca: orcTtl, meteora: metTtl, saber: sabTtl, meteora_balanced: mblTtl } };
}

// Retarget WS: unsubscribe and re-subscribe to current graph-derived targets
export async function retargetPoolWebsockets(): Promise<{ attached: { orca: number; raydium: number; meteora: number } }> {
  try { disablePoolWebsocketRefreshes(); } catch {}
  try { startPoolWebsocketsOnlyOnce(); } catch {}
  // Give subscriptions a brief moment to attach
  await new Promise((r) => setTimeout(r, 250));
  try {
    const st = getPoolWsStatus();
    if (!st.healthy) {
      try { emit('log', { level: 'warn', message: 'pools:ws unhealthy after retarget', timestamp: new Date().toISOString(), context: { cat: 'pools' } }); } catch {}
    }
  } catch {}
  return { attached: { orca: attachedOrcaPools, raydium: attachedRaydiumPools, meteora: attachedMeteoraPools } };
}

// Unified refresh orchestrator: fetch all sources and optionally (re)subscribe
export async function refreshAllSources(force = true, subscribe = true): Promise<{ raydium: PoolsPayload; orca: PoolsPayload; meteora: PoolsPayload; saber: PoolsPayload; meteora_balanced: PoolsPayload }> {
  try {
    // Warm baseline USD prices for currently seen source mint sets when universe is unavailable
    if (force) {
      const { bootstrapPricesForUniverse, bootstrapPricesForMints } = await import('./priceBootstrap.js');
      let cov = await bootstrapPricesForUniverse({ chunkSize: 400, maxRequests: 3, cat: 'pools.refresh' }).catch(() => null);
      if (cov && cov.total === 0) {
        try {
          const { getSourceTokenSet } = await import('./universe.js');
          const raySet = await getSourceTokenSet('raydium');
          const orcSet = await getSourceTokenSet('orca');
          const merged = new Set<string>([...raySet, ...orcSet]);
          cov = await bootstrapPricesForMints(Array.from(merged), { chunkSize: 400, maxRequests: 3, cat: 'pools.refresh.fallback' });
        } catch {}
      }
      if (cov) { try { logger.info('pools.refresh price coverage', { total: cov.total, priced: cov.priced, missing: cov.missing, cat: 'pools' }); } catch {} }
    }
  } catch {}
  const r = await getRaydiumPoolsNormalized(!!force).catch(() => ({ amm: [], clmm: [] }));
  const o = await getOrcaPoolsCached(!!force).catch(() => ({ amm: [], clmm: [] }));
  const m = await getMeteoraPoolsCached(!!force).catch(() => ({ amm: [], clmm: [] }));
  const s = await getSaberPoolsCached(!!force).catch(() => ({ amm: [], clmm: [] }));
  const mb = await getMeteoraBalancedPoolsCached(!!force).catch(() => ({ amm: [], clmm: [] }));
  // Pair diagnostics: log a single SOL-USDC pool per fetcher
  try {
    const SOL = 'So11111111111111111111111111111111111111112';
    const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const compute = (p: any): { forward: number | undefined; reverse: number | undefined } => {
      try {
        const a = String(p?.mint_a || '');
        const b = String(p?.mint_b || '');
        const px = Number(p?.price_a_per_b || 0);
        if (!a || !b) return { forward: undefined, reverse: undefined };
        if (!Number.isFinite(px) || px <= 0) return { forward: undefined, reverse: undefined };
        // forward = USDC per 1 SOL
        if (a === USDC && b === SOL) return { forward: px, reverse: 1 / px };
        if (a === SOL && b === USDC) return { forward: 1 / px, reverse: px };
        return { forward: undefined, reverse: undefined };
      } catch { return { forward: undefined, reverse: undefined }; }
    };
    const pickOne = (pools: PoolsPayload): any => {
      for (const p of (pools?.clmm || [])) {
        const a = String(p?.mint_a || ''), b = String(p?.mint_b || '');
        if ((a === SOL && b === USDC) || (a === USDC && b === SOL)) return p;
      }
      for (const p of (pools?.amm || [])) {
        const a = String(p?.mint_a || ''), b = String(p?.mint_b || '');
        if ((a === SOL && b === USDC) || (a === USDC && b === SOL)) return p;
      }
      return null;
    };
    const rayPick = pickOne(r);
    if (rayPick) {
      const { forward, reverse } = compute(rayPick);
      if (forward && reverse) {
        try { logger.info('pools.pair_sol_usdc', { source: 'raydium', id: rayPick.id, kind: rayPick.pool_kind || (rayPick.sqrt_price_x64 != null ? 'clmm' : 'amm'), forward_usdc_per_sol: forward, reverse_sol_per_usdc: reverse, cat: 'pools' }); } catch {}
        try { emit('log', { level: 'info', message: `pools:pair_sol_usdc source=raydium id=${rayPick.id} kind=${rayPick.pool_kind || (rayPick.sqrt_price_x64 != null ? 'clmm' : 'amm')} fwd=${forward} rev=${reverse}`, timestamp: new Date().toISOString(), context: { cat: 'pools' } }); } catch {}
      } else {
        try { logger.debug('pools.pair_sol_usdc.skip', { source: 'raydium', reason: 'invalid_price_or_orientation', id: rayPick.id, a: rayPick.mint_a, b: rayPick.mint_b, px: rayPick.price_a_per_b, cat: 'pools' }); } catch {}
        try { emit('log', { level: 'debug', message: `pools:pair_sol_usdc.skip source=raydium reason=invalid_price_or_orientation id=${rayPick.id} a=${rayPick.mint_a} b=${rayPick.mint_b} px=${rayPick.price_a_per_b}`, timestamp: new Date().toISOString(), context: { cat: 'pools' } }); } catch {}
      }
    } else {
      try { logger.debug('pools.pair_sol_usdc.skip', { source: 'raydium', reason: 'no_sol_usdc', cat: 'pools' }); } catch {}
      try { emit('log', { level: 'debug', message: 'pools:pair_sol_usdc.skip source=raydium reason=no_sol_usdc', timestamp: new Date().toISOString(), context: { cat: 'pools' } }); } catch {}
    }
    const orcPick = pickOne(o);
    if (orcPick) {
      const { forward, reverse } = compute(orcPick);
      if (forward && reverse) {
        try { logger.info('pools.pair_sol_usdc', { source: 'orca', id: orcPick.id, kind: orcPick.pool_kind || (orcPick.sqrt_price_x64 != null ? 'clmm' : 'amm'), forward_usdc_per_sol: forward, reverse_sol_per_usdc: reverse, cat: 'pools' }); } catch {}
        try { emit('log', { level: 'info', message: `pools:pair_sol_usdc source=orca id=${orcPick.id} kind=${orcPick.pool_kind || (orcPick.sqrt_price_x64 != null ? 'clmm' : 'amm')} fwd=${forward} rev=${reverse}`, timestamp: new Date().toISOString(), context: { cat: 'pools' } }); } catch {}
      } else {
        try { logger.debug('pools.pair_sol_usdc.skip', { source: 'orca', reason: 'invalid_price_or_orientation', id: orcPick.id, a: orcPick.mint_a, b: orcPick.mint_b, px: orcPick.price_a_per_b, cat: 'pools' }); } catch {}
        try { emit('log', { level: 'debug', message: `pools:pair_sol_usdc.skip source=orca reason=invalid_price_or_orientation id=${orcPick.id} a=${orcPick.mint_a} b=${orcPick.mint_b} px=${orcPick.price_a_per_b}`, timestamp: new Date().toISOString(), context: { cat: 'pools' } }); } catch {}
      }
    } else {
      try { logger.debug('pools.pair_sol_usdc.skip', { source: 'orca', reason: 'no_sol_usdc', cat: 'pools' }); } catch {}
      try { emit('log', { level: 'debug', message: 'pools:pair_sol_usdc.skip source=orca reason=no_sol_usdc', timestamp: new Date().toISOString(), context: { cat: 'pools' } }); } catch {}
    }
    const metPick = pickOne(m);
    if (metPick) {
      const { forward, reverse } = compute(metPick);
      if (forward && reverse) {
        try { logger.info('pools.pair_sol_usdc', { source: 'meteora', id: metPick.id, kind: metPick.pool_kind || (metPick.sqrt_price_x64 != null ? 'clmm' : 'amm'), forward_usdc_per_sol: forward, reverse_sol_per_usdc: reverse, cat: 'pools' }); } catch {}
        try { emit('log', { level: 'info', message: `pools:pair_sol_usdc source=meteora id=${metPick.id} kind=${metPick.pool_kind || (metPick.sqrt_price_x64 != null ? 'clmm' : 'amm')} fwd=${forward} rev=${reverse}`, timestamp: new Date().toISOString(), context: { cat: 'pools' } }); } catch {}
      } else {
        try { logger.debug('pools.pair_sol_usdc.skip', { source: 'meteora', reason: 'invalid_price_or_orientation', id: metPick.id, a: metPick.mint_a, b: metPick.mint_b, px: metPick.price_a_per_b, cat: 'pools' }); } catch {}
        try { emit('log', { level: 'debug', message: `pools:pair_sol_usdc.skip source=meteora reason=invalid_price_or_orientation id=${metPick.id} a=${metPick.mint_a} b=${metPick.mint_b} px=${metPick.price_a_per_b}`, timestamp: new Date().toISOString(), context: { cat: 'pools' } }); } catch {}
      }
    } else {
      try { logger.debug('pools.pair_sol_usdc.skip', { source: 'meteora', reason: 'no_sol_usdc', cat: 'pools' }); } catch {}
      try { emit('log', { level: 'debug', message: 'pools:pair_sol_usdc.skip source=meteora reason=no_sol_usdc', timestamp: new Date().toISOString(), context: { cat: 'pools' } }); } catch {}
    }
  } catch (e:any) {
    try { logger.warn('pools.pair_sol_usdc.failed', { error: String(e?.message || e), cat: 'pools' }); } catch {}
    try { emit('log', { level: 'warn', message: `pools:pair_sol_usdc.failed error=${String(e?.message || e)}`, timestamp: new Date().toISOString(), context: { cat: 'pools' } }); } catch {}
  }
  if (subscribe) {
    try {
      enablePoolWebsocketRefreshes();
      startRaydiumRefreshLoop();
    } catch {}
  }
  return { raydium: r, orca: o, meteora: m, saber: s, meteora_balanced: mb };
}

export function startRaydiumRefreshLoop(): void {
  // Clear existing timers if any, to allow dynamic TTL updates
  if (rayTimer) { clearInterval(rayTimer); rayTimer = undefined; }
  if (orcaTimer) { clearInterval(orcaTimer); orcaTimer = undefined; }
  if (meteoraTimer) { clearInterval(meteoraTimer); meteoraTimer = undefined; }
  try { if (wsUnsubscribe) { wsUnsubscribe(); wsUnsubscribe = undefined; } } catch {}
  if (healthTimer) { clearInterval(healthTimer); healthTimer = undefined; }
  if (aggTimer) { clearInterval(aggTimer); aggTimer = undefined; }

  // Use unified cadence unless explicitly overridden per source
  const unified = Math.max(1000, Number((CONFIG.system as any)?.poolsRefreshMs || 60_000));
  const rayPeriod = unified;
  const orcaPeriod = unified;
  const meteoraPeriod = unified;

  const wsEnabled = !!(CONFIG.system as any)?.enablePoolWs;
  // Defer any activity until graph is ready
  if (!wsAllowed) { logger.info('pools.init deferred until graph ready'); return; }
  // Auto-start timers/WS when allowed by config and graph readiness

    if (!wsEnabled && !suppressInitialOnce) {
    rayTimer = setInterval(() => {
      try {
        logger.info('pools.refresh timer raydium', { cat: 'pools' });
        emit('log', { level: 'debug', message: 'pools:refresh timer source=raydium', timestamp: new Date().toISOString(), context: { cat: 'pools' } });
      } catch {}
      getRaydiumPoolsNormalized(true).catch(() => {});
    }, rayPeriod);
    orcaTimer = setInterval(() => {
      try {
        logger.info('pools.refresh timer orca', { cat: 'pools' });
        emit('log', { level: 'debug', message: 'pools:refresh timer source=orca', timestamp: new Date().toISOString(), context: { cat: 'pools' } });
      } catch {}
      getOrcaPoolsCached(true).catch(() => {});
    }, orcaPeriod);
    meteoraTimer = setInterval(() => {
      try {
        logger.info('pools.refresh timer meteora', { cat: 'pools' });
        emit('log', { level: 'debug', message: 'pools:refresh timer source=meteora', timestamp: new Date().toISOString(), context: { cat: 'pools' } });
      } catch {}
      getMeteoraPoolsCached(true).catch(() => {});
    }, meteoraPeriod);
  }
    // Proceed to initial fetch and optional WS

  // Kick immediately once activated so data is available without waiting
  // Kick immediately once, but respect min-force gap for subsequent calls
  if (!suppressInitialOnce) {
    try { getRaydiumPoolsNormalized(true).catch(() => {}); } catch {}
    try { getOrcaPoolsCached(true).catch(() => {}); } catch {}
    try { getMeteoraPoolsCached(true).catch(() => {}); } catch {}
  }

  // Optional: subscribe to on-chain account changes to push updates into caches (auto-enabled)
  if (wsEnabled) {
    if (!wsAllowed) {
      logger.info('pools.ws deferred until graph ready');
      return;
    }
    try {
      const setup = async () => {
        let web3: any = null;
        try { const mod = ['@solana/web3.js'].join(''); web3 = await import(mod as any); } catch {}
        if (!web3) { logger.warn('pools.ws disabled: @solana/web3.js not available'); return; }
        const conn = new web3.Connection(CONFIG.rpcUrl, CONFIG.system.txCommitment as any);
        const rayAmm = new web3.PublicKey(String(CONFIG.raydium?.ammV4Program).trim());
        const rayClmm = new web3.PublicKey(String(CONFIG.raydium?.clmmProgram).trim());
        const orcaProg = new web3.PublicKey(String(CONFIG.orca?.programId || 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc').trim());
        const subs: number[] = [];
        // Debounce frequent program change bursts to at most one refresh per source per min gap
        const minGap = Number((CONFIG.system as any)?.poolRefreshMinGapMs || 3000);
        let lastRay = 0; let lastOrc = 0;
        let meteoraTargets = new Set<string>();
        try {
          const gmod: any = await import('./graph.js');
          const snap = await gmod.getGraphSnapshot(false);
          const mset = new Set<string>();
          for (const e of (snap?.edges || [])) {
            const pid = String((e as any)?.pool_id || '');
            if (!pid) continue;
            const base = pid.replace(/-rev$/, '');
            if ((e as any)?.dex === 'Meteora') mset.add(base);
          }
          meteoraTargets = mset;
        } catch {}

        const handle = async (pk: any, info: any) => {
          try {
            lastWsEventMs = Date.now();
            wsHealthy = true;
            // Lightweight classify: owner indicates which decoder to attempt
            const owner = toB58Any((info as any)?.owner);
            const ownerRayAmm = rayAmm.toBase58();
            const ownerRayClmm = rayClmm.toBase58();
            const ownerOrca = orcaProg.toBase58();
            const ownerMeteora = String((CONFIG as any)?.meteora?.programId || '').trim();
            const pk58 = toB58Any(pk);
            const isMeteoraTarget = meteoraTargets.has(pk58);
            try {
              const shortPk = pk ? `${toB58Any(pk).slice(0,6)}…` : '';
              const src = (owner === ownerRayAmm || owner === ownerRayClmm) ? 'raydium' : (owner === ownerOrca ? 'orca' : ((ownerMeteora && owner === ownerMeteora) || isMeteoraTarget ? 'meteora' : 'unknown'));
              logger.debug('pools.ws event', { source: src, account: shortPk, cat: 'pools' });
              // Emit raw event snapshot (truncated) for audit
              const raw = {
                owner,
                lamports: Number(info?.lamports ?? 0),
                dataLen: Number(info?.data?.length ?? 0),
              };
              emit('log', { level: 'debug', message: `pools:ws event source=${src} acct=${shortPk}`, timestamp: new Date().toISOString(), context: { cat: 'pools', raw, source: src } });
            } catch {}
            const now = Date.now();
            if (owner === ownerRayAmm || owner === ownerRayClmm) {
              try { wsCounts.raydium += 1; } catch {}
              const pk58 = toB58Any(pk);
              let updated = false;
              try {
                const rmod: any = await import('@raydium-io/raydium-sdk-v2').catch(() => null);
                if (!rmod || !info?.data) { throw new Error('raydium sdk missing'); }
                  // Try CLMM pool decode first
                  let state: any = null;
                  const clmmLayout = (rmod as any)?.Clmm?.PoolStateLayout || (rmod as any)?.CLMM?.POOL_STATE_LAYOUT || (rmod as any)?.PoolStateLayout;
                  if (clmmLayout && typeof clmmLayout.decode === 'function') {
                    try { state = clmmLayout.decode(info.data); } catch {}
                    if (state && (state as any).liquidity != null && ((state as any).mintA || (state as any).tokenMintA)) {
                      const mintA = ((state as any).mintA || (state as any).tokenMintA)?.toBase58?.() || '';
                      const mintB = ((state as any).mintB || (state as any).tokenMintB)?.toBase58?.() || '';
                      const sqrt = Number((state as any).sqrtPriceX64 ?? (state as any).sqrt_price_x64 ?? (state as any).sqrtPrice ?? 0);
                      // Approximate A per 1 B from sqrtPriceX64 (Q64.64): price = (sqrt / 2^64)^2
                      const pxFromSqrt = (() => {
                        try {
                          if (!Number.isFinite(sqrt) || sqrt <= 0) return 0;
                          const ratio = sqrt / Math.pow(2, 64);
                          const px = ratio * ratio;
                          return Number.isFinite(px) && px > 0 ? px : 0;
                        } catch { return 0; }
                      })();
                      const liq = Number((state as any).liquidity ?? 0);
                      const tick = Number((state as any).tickSpacing ?? (state as any).tick_spacing ?? 0);
                      const fee = Number((state as any).feeRate ?? (state as any).fee_rate ?? 0);
                      const item: ClmmPool = { id: pk58, dex: 'Raydium', mint_a: mintA, mint_b: mintB, fee_bps: fee, sqrt_price_x64: sqrt, liquidity: liq, tick_spacing: tick, updated_ms: Date.now(), pool_kind: 'clmm', liquidity_display: liq, price_a_per_b: pxFromSqrt } as any;
                      const prev = raydiumCache.data || { amm: [], clmm: [] };
                      const next: PoolsPayload = { amm: prev.amm.slice(), clmm: prev.clmm.slice() };
                      const idx = next.clmm.findIndex(p => p.id === item.id);
                      if (idx >= 0) next.clmm[idx] = { ...next.clmm[idx], ...item }; else next.clmm.push(item);
                      const d = diffNormalizedPools(prev, next);
                      raydiumCache.data = next; raydiumCache.ts = Date.now();
                      try { emit('pool-updates', { source: 'raydium', updatedAmm: d.amm.length, updatedClmm: d.clmm.length, sample: { amm: [], clmm: d.clmm.slice(0, 20) }, ts: Date.now() }); } catch {}
                  // Debounced graph rebuild on pool delta
                  try {
                    const gmod: any = await import('./graph.js');
                    const thresh = Math.max(0, Number((CONFIG.system as any)?.graphDeltaRebuildThreshold || 0));
                    const delta = d.clmm.length;
                    if (thresh === 0 || delta >= thresh) gmod.scheduleGraphRebuild(undefined, Math.max(50, Number((CONFIG.system as any)?.graphRebuildDebounceMs || 150)));
                  } catch {}
                      updated = true;
                    }
                  }
                  // Try AMM V4 decode
                  if (!updated) {
                    const ammLayout = (rmod as any)?.LiquidityStateLayoutV4 || (rmod as any)?.LIQUIDITY_STATE_LAYOUT_V4 || null;
                    if (ammLayout && typeof ammLayout.decode === 'function') {
                      try { state = ammLayout.decode(info.data); } catch { state = null; }
                      if (state) {
                        const mintA = (state.baseMint || state.mintA || state.mint_a)?.toBase58?.() || '';
                        const mintB = (state.quoteMint || state.mintB || state.mint_b)?.toBase58?.() || '';
                        // Reserves may be BN; best-effort convert to number
                        const rA = Number((state.baseReserve || state.reserveA || state.vaultA || 0).toString ? (state.baseReserve.toString()) : (state.baseReserve || 0));
                        const rB = Number((state.quoteReserve || state.reserveB || state.vaultB || 0).toString ? (state.quoteReserve.toString()) : (state.quoteReserve || 0));
                        const price = (rB > 0 && rA > 0) ? (rA / rB) : 0;
                        const liqBase = (rA > 0 && rB > 0) ? Math.min(rA, rB) : 0;
                        const item: AmmPool = { id: pk58, dex: 'Raydium', mint_a: mintA, mint_b: mintB, fee_bps: Number((state as any).tradeFeeRate || (state as any).feeRate || 0), price_a_per_b: price, liquidity_base: liqBase, updated_ms: Date.now(), pool_kind: 'amm', liquidity_display: liqBase } as any;
                        const prev = raydiumCache.data || { amm: [], clmm: [] };
                        const next: PoolsPayload = { amm: prev.amm.slice(), clmm: prev.clmm.slice() };
                        const idx = next.amm.findIndex(p => p.id === item.id);
                        if (idx >= 0) next.amm[idx] = { ...next.amm[idx], ...item }; else next.amm.push(item);
                        const d = diffNormalizedPools(prev, next);
                        raydiumCache.data = next; raydiumCache.ts = Date.now();
                        try { emit('pool-updates', { source: 'raydium', updatedAmm: d.amm.length, updatedClmm: d.clmm.length, sample: { amm: d.amm.slice(0, 20), clmm: [] }, ts: Date.now() }); } catch {}
                        // Debounced graph rebuild on pool delta
                        try {
                          const gmod: any = await import('./graph.js');
                          const thresh = Math.max(0, Number((CONFIG.system as any)?.graphDeltaRebuildThreshold || 0));
                          const delta = d.amm.length;
                          if (thresh === 0 || delta >= thresh) gmod.scheduleGraphRebuild(undefined, Math.max(50, Number((CONFIG.system as any)?.graphRebuildDebounceMs || 150)));
                        } catch {}
                        updated = true;
                    }
                  }
                }
              } catch (e:any) {
                try { logger.warn('raydium.ws.decode failed', { id: pk58.slice(0,6)+'…', error: String(e?.message || e) }); } catch {}
              }
              if (!updated) { try { logger.debug('pools.ws event (unparsed)', { source: 'raydium', id: pk58.slice(0,6)+'…' }); } catch {} }
              return;
            } else if (owner === ownerOrca) {
              try { wsCounts.orca += 1; } catch {}
              // Attempt to parse and upsert single Whirlpool from account data; fallback to full refresh on failure
              let ok = false;
              try {
                const pk58 = toB58Any(pk);
                const sdk = await import('@orca-so/whirlpools-sdk').catch(() => null);
                if (!sdk) { throw new Error('orca sdk missing'); }
                const { ParsableWhirlpool } = sdk as any;
                const parsed = ParsableWhirlpool.parse(pk, info);
                if (parsed) {
                  const id = pk58;
                  const mint_a = parsed.tokenMintA.toBase58();
                  const mint_b = parsed.tokenMintB.toBase58();
                  const sqrt_price_x64 = Number(parsed.sqrtPrice);
                  // Derive A per 1 B using sqrtPrice and decimals:
                  // price_B_per_A = (ratio^2) * 10^(decA - decB)
                  // price_A_per_B = 1 / price_B_per_A = 10^(decB - decA) / (ratio^2)
                  const pxFromSqrt = await (async () => {
                    try {
                      if (!Number.isFinite(sqrt_price_x64) || sqrt_price_x64 <= 0) return 0;
                      const ratio = sqrt_price_x64 / Math.pow(2, 64);
                      let decA: number | undefined; let decB: number | undefined;
                      try {
                        const tok = await import('../utils/tokens.js');
                        const a = await (tok as any).resolveMint(mint_a);
                        const b = await (tok as any).resolveMint(mint_b);
                        decA = Number(a?.decimals);
                        decB = Number(b?.decimals);
                      } catch {}
                      if (!Number.isFinite(decA as any) || !Number.isFinite(decB as any)) return 0;
                      const scale = Math.pow(10, (decB as number) - (decA as number));
                      const px = scale / (ratio * ratio);
                      return Number.isFinite(px) && px > 0 ? px : 0;
                    } catch { return 0; }
                  })();
                  const liquidity = Number(parsed.liquidity);
                  const tick_spacing = Number(parsed.tickSpacing);
                  const fee_bps = Number((parsed as any)?.feeRate ?? 0);
                  const clmmItem: ClmmPool = { id, dex: 'Orca', mint_a, mint_b, fee_bps, sqrt_price_x64, liquidity, tick_spacing, updated_ms: Date.now(), pool_kind: 'clmm', liquidity_display: liquidity, price_a_per_b: pxFromSqrt } as any;
                  const prev = orcaCache.data || { amm: [], clmm: [] };
                  const next: PoolsPayload = { amm: prev.amm.slice(), clmm: prev.clmm.slice() };
                  const idx = next.clmm.findIndex(p => p.id === id);
                  if (idx >= 0) { next.clmm[idx] = { ...next.clmm[idx], ...clmmItem }; } else { next.clmm.push(clmmItem); }
                  orcaCache.data = next; orcaCache.ts = Date.now();
                  const d = diffNormalizedPools(prev, next);
                  const sample = { amm: [], clmm: d.clmm.slice(0, 20) };
                  emit('pool-updates', { source: 'orca', updatedAmm: d.amm.length, updatedClmm: d.clmm.length, addedAmm: d.addedAmm, removedAmm: d.removedAmm, addedClmm: d.addedClmm, removedClmm: d.removedClmm, sample, ts: Date.now() });
                  try { logger.debug('pools.delta orca.ws', { id: pk58.slice(0,6)+'…', updatedClmm: d.clmm.length, cat: 'pools' }); } catch {}
                  // Graph rebuilds now orchestrated by refresh endpoint; avoid redundant triggers here
                  ok = true;
                }
              } catch (e:any) {
                try { logger.warn('orca.ws.parse failed', { error: String(e?.message || e) }); } catch {}
              }
              // Do not fallback to HTTP refresh when user subscribed; leave updates to manual refresh
            } else if ((ownerMeteora && owner === ownerMeteora) || isMeteoraTarget) {
              try { wsCounts.meteora = (wsCounts.meteora || 0) + 1; } catch {}
              // Without on-chain parsers, fall back to a debounced full refresh for Meteora
              const minGap = Number((CONFIG.system as any)?.poolRefreshMinGapMs || 3000);
              const last = (getMeteoraPoolsCached as any).__lastForceAt || 0;
              const nowMs = Date.now();
              if (nowMs - last >= minGap) {
                (getMeteoraPoolsCached as any).__lastForceAt = nowMs;
                getMeteoraPoolsCached(true).catch(() => {});
              }
              return;
            } else if (pk) {
              // Fallback: if account belongs to any known program, refresh both
              // Disabled while subscribed
            }
          } catch {}
        };
        // Subscribe to Orca Whirlpool POOL accounts only: prefer graph edge pool ids, else derive PDAs from watchlist
        try {
          const { PublicKey } = web3;
          const sdkAny: any = await import('@orca-so/whirlpools-sdk').catch(() => null);
          const PDAUtil = sdkAny?.PDAUtil;
          const programId = new PublicKey(String(CONFIG.orca?.programId));
          const configPk = new PublicKey(String(CONFIG.orca?.configPubkey));
          const wl = await readJson<any[]>(CONFIG.watchlistPath, []);
          // Build target set from current graph snapshot edges
          const edgePoolIds = new Set<string>();
          try {
            const gmod: any = await import('./graph.js');
            const snap = await gmod.getGraphSnapshot(false);
            for (const e of (snap?.edges || [])) {
              const pid = String((e as any)?.pool_id || '');
              if (pid) edgePoolIds.add(pid.replace(/-rev$/,''));
            }
          } catch {}
          const SOL = 'So11111111111111111111111111111111111111112';
          const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
          const tickSpacings = [8, 16, 32, 64, 128, 256];
          let uniq: string[] = [];
          if (edgePoolIds.size > 0) {
            uniq = Array.from(edgePoolIds);
            targetedWsActive = true;
            try { logger.info('pools.ws targets.orca from graph', { size: uniq.length }); } catch {}
          } else {
            // Fallback: derive from watchlist pairs (legacy behavior)
            const pairs: Array<[string, string]> = [];
            const watchMints: string[] = Array.from(new Set(wl.map((t: any) => (typeof t === 'string' ? t : t?.id)).filter(Boolean)));
            for (const m of watchMints.slice(0, 100)) { if (m !== USDC) pairs.push([m, USDC]); if (m !== SOL) pairs.push([m, SOL]); }
            pairs.push([SOL, USDC]);
            const poolAddrs: string[] = [];
            if (PDAUtil) {
              for (const [a, b] of pairs) {
                const [mintA, mintB] = String(a) < String(b) ? [a, b] : [b, a];
                for (const ts of tickSpacings) {
                  try {
                    const pda = PDAUtil.getWhirlpool(programId, configPk, new PublicKey(mintA), new PublicKey(mintB), ts);
                    poolAddrs.push(pda.publicKey.toBase58());
                  } catch {}
                }
              }
            }
            uniq = Array.from(new Set(poolAddrs));
          }
          let attached = 0;
          for (const addr of uniq) {
            try {
              const pk = new PublicKey(addr);
              const id = await conn.onAccountChange(pk, (info: any) => { handle(pk as any, info); });
              subs.push(id as any); attached++;
            } catch {}
          }
          attachedOrcaPools = attached;
          logger.info('pools.ws subscribe orca.pools', { attached, source: 'orca' });
          // Subscribe at program level only if we had no targeted addresses
          if (attached === 0) {
            try { logger.info('pools.ws subscribe orca(program)', { source: 'orca', cat: 'pools' }); } catch {}
            subs.push(conn.onProgramAccountChange(orcaProg, (ch) => handle(ch.accountId, ch.accountInfo)) as unknown as number);
          }
        } catch (e:any) {
          logger.warn('pools.ws orca address subscribe failed', { error: String(e?.message || e) });
          // Fallback to program-level subscription (may include non-pool accounts)
          try { logger.info('pools.ws subscribe orca(fallback)', { source: 'orca', cat: 'pools' }); } catch {}
          subs.push(conn.onProgramAccountChange(orcaProg, (ch) => handle(ch.accountId, ch.accountInfo)) as unknown as number);
        }
        // Raydium address-level subscriptions when we have known pool ids (from prior refresh)
        try {
          // Prefer graph edge pool ids if available
          const edgePoolIds = new Set<string>();
          try {
            const gmod: any = await import('./graph.js');
            const snap = await gmod.getGraphSnapshot(false);
            for (const e of (snap?.edges || [])) {
              const pid = String((e as any)?.pool_id || '');
              if (pid) edgePoolIds.add(pid.replace(/-rev$/,''));
            }
          } catch {}
          const rayKnown: string[] = [];
          try { for (const p of (raydiumCache.data?.amm || [])) if (p?.id) rayKnown.push(String(p.id)); } catch {}
          try { for (const p of (raydiumCache.data?.clmm || [])) if (p?.id) rayKnown.push(String(p.id)); } catch {}
          const base = edgePoolIds.size > 0 ? Array.from(edgePoolIds) : rayKnown;
          const uniqueRay = Array.from(new Set(base.filter(Boolean)));
          let attachedRay = 0;
          for (const addr of uniqueRay) {
            try {
              const pk = new web3.PublicKey(addr);
              const id = await conn.onAccountChange(pk, (info: any) => { handle(pk as any, info); });
              subs.push(id as any); attachedRay++;
            } catch {}
          }
          attachedRaydiumPools = attachedRay;
          logger.info('pools.ws subscribe raydium.pools', { attached: attachedRay });
          // Fallback to program-level if none attached
          if (attachedRay === 0) {
            try { logger.info('pools.ws subscribe raydium.amm(fallback)', { source: 'raydium', cat: 'pools' }); } catch {}
            subs.push(conn.onProgramAccountChange(rayAmm, (ch) => handle(ch.accountId, ch.accountInfo)) as unknown as number);
            try { logger.info('pools.ws subscribe raydium.clmm(fallback)', { source: 'raydium', cat: 'pools' }); } catch {}
            subs.push(conn.onProgramAccountChange(rayClmm, (ch) => handle(ch.accountId, ch.accountInfo)) as unknown as number);
          }
        } catch {}
        // Meteora targeted subscriptions from graph edges. If none yet, retry briefly for targets; fallback to program-level when configured.
        try {
          const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
          const attachMeteora = async (): Promise<number> => {
            let attached = 0;
            const edgeIds: string[] = Array.from(meteoraTargets);
            for (const addr of edgeIds) {
              try {
                const pk = new web3.PublicKey(addr);
                const id = await conn.onAccountChange(pk, (info: any) => { handle(pk as any, info); });
                subs.push(id as any); attached++;
              } catch {}
            }
            return attached;
          };
          // Try immediate targets; if none, make a couple of quick retries to allow first graph to include Meteora edges
          let attachedMet = await attachMeteora();
          if (attachedMet === 0) {
            const maxRetries = Math.max(1, Number(((CONFIG.system as any)?.meteoraWsRetryCount) || 2));
            const delayMs = Math.max(200, Number(((CONFIG.system as any)?.meteoraWsRetryDelayMs) || 600));
            for (let i = 0; i < maxRetries && attachedMet === 0; i++) {
              try {
                // Refresh targets from a fresh graph snapshot
                const gmod: any = await import('./graph.js');
                const snap = await gmod.getGraphSnapshot(true);
                const mset = new Set<string>();
                for (const e of (snap?.edges || [])) {
                  const pid = String((e as any)?.pool_id || '');
                  if (!pid) continue;
                  const base = pid.replace(/-rev$/, '');
                  if ((e as any)?.dex === 'Meteora') mset.add(base);
                }
                meteoraTargets = mset;
              } catch {}
              if (meteoraTargets.size > 0) attachedMet = await attachMeteora();
              if (attachedMet === 0) await sleep(delayMs);
            }
          }
          attachedMeteoraPools = attachedMet;
          if (attachedMet > 0) {
            try { logger.info('pools.ws subscribe meteora.pools', { attached: attachedMet, source: 'meteora' }); } catch {}
          } else {
            // Program-level fallback when configured
            const meteoraProg = String((CONFIG as any)?.meteora?.programId || '').trim();
            if (meteoraProg) {
              try { logger.info('pools.ws subscribe meteora(program)', { source: 'meteora', cat: 'pools' }); } catch {}
              subs.push(conn.onProgramAccountChange(new web3.PublicKey(meteoraProg), (ch: any) => handle(ch.accountId, ch.accountInfo)) as unknown as number);
              attachedMeteoraPools = 1;
            }
          }
        } catch (e:any) {
          logger.warn('pools.ws meteora subscribe failed', { error: String(e?.message || e) });
          attachedMeteoraPools = 0;
        }

        wsUnsubscribe = () => { try { for (const id of subs) conn.removeAccountChangeListener(id as any).catch(() => {}); } catch {} };
        logger.info('pools.ws subscriptions active');
        // Immediately emit a ws-activity snapshot so UI reflects attached counts without waiting for first aggregate tick
        try { emit('ws-activity', { healthy: wsHealthy, lastEventMs: lastWsEventMs, orca: { attached: attachedOrcaPools, events: 0 }, raydium: { attached: attachedRaydiumPools, events: 0 }, meteora: { attached: attachedMeteoraPools, events: 0 } }); } catch {}

        // Health monitor: if no WS events for timeoutMs, trigger periodic refresh as fallback
        const timeoutMs = Math.max(5000, Number((CONFIG.system as any)?.wsHealthTimeoutMs || 15000));
        if (healthTimer) { clearInterval(healthTimer); healthTimer = undefined; }
        healthTimer = setInterval(() => {
          try {
            const now = Date.now();
            const idle = now - (lastWsEventMs || 0);
            const healthy = wsHealthy && idle < timeoutMs * 2;
            if (!healthy) {
              // WS unhealthy: attempt auto-retarget with exponential backoff and reconnect hints
              try { logger.warn('pools.ws unhealthy', { idleMs: idle, timeoutMs }); } catch {}
              wsHealthy = false;
              (async () => {
                try {
                  const last = (reconcileNow as any)._last || 0;
                  const gap = Math.max(2000, Number((CONFIG.system as any)?.wsReconnectMinGapMs || 5000));
                  if (Date.now() - last > gap) {
                    await reconcileNow();
                  }
                } catch {}
              })();
            }
          } catch {}
        }, Math.max(2000, Math.floor((Number((CONFIG.system as any)?.wsHealthTimeoutMs || 15000)) / 3)));

        // Periodic aggregate logs for WS activity
        const aggPeriod = Math.max(5000, Number((CONFIG.system as any)?.wsAggLogPeriodMs || 15000));
        aggTimer = setInterval(() => {
          try {
            const snapshot = { raydium: wsCounts.raydium, orca: wsCounts.orca, meteora: wsCounts.meteora } as any;
            wsCounts.raydium = 0; wsCounts.orca = 0; wsCounts.meteora = 0;
            logger.info('pools.ws aggregate', { 
              events: snapshot, 
              healthy: wsHealthy, 
              lastEventMs: lastWsEventMs,
              counts: {
                raydium: { attached: attachedRaydiumPools, target: (typeof getWsTargets === 'function' ? (getWsTargets as any)._last?.raydium?.target : undefined) },
                orca: { attached: attachedOrcaPools, target: (typeof getWsTargets === 'function' ? (getWsTargets as any)._last?.orca?.target : undefined) },
                meteora: { attached: attachedMeteoraPools, target: (typeof getWsTargets === 'function' ? (getWsTargets as any)._last?.meteora?.target : undefined) }
              }
            });
            // Emit a dedicated ws-activity event for UI regardless of log filtering
            try { emit('ws-activity', { healthy: wsHealthy, lastEventMs: lastWsEventMs, orca: { attached: attachedOrcaPools, events: snapshot.orca || 0 }, raydium: { attached: attachedRaydiumPools, events: snapshot.raydium || 0 }, meteora: { attached: attachedMeteoraPools, events: snapshot.meteora || 0 } }); } catch {}
            try { emit('log', { level: 'debug', message: `pools:ws aggregate ray=${snapshot.raydium} orca=${snapshot.orca}`, timestamp: new Date().toISOString(), context: { cat: 'pools' } }); } catch {}
            // Reconcile targets vs attached (debounced): if attached << targets, trigger retarget
            (async () => {
              try {
                const tgt = await getWsTargets();
                const needRay = Math.max(0, (tgt.raydium.target || 0) - (attachedRaydiumPools || 0));
                const needOrc = Math.max(0, (tgt.orca.target || 0) - (attachedOrcaPools || 0));
                const needMet = Math.max(0, (tgt.meteora.target || 0) - (attachedMeteoraPools || 0));
                const sumNeed = needRay + needOrc + needMet;
                if (sumNeed > 0) {
                  const last = (reconcileNow as any)._last || 0;
                  if (Date.now() - last > 5000) { await reconcileNow(); }
                }
              } catch {}
            })();
          } catch {}
        }, aggPeriod);
      };
      setup().catch((e: any) => logger.warn('pools.ws setup failed', { error: String(e?.message || e) }));
    } catch (e: any) {
      logger.warn('pools.ws unavailable', { error: String(e?.message || e) });
    }
  }
  // Reset the one-shot suppression flag
  suppressInitialOnce = false;
}

async function reconcileNow(): Promise<void> {
  try {
    (reconcileNow as any)._last = Date.now();
    await retargetPoolWebsockets();
  } catch {}
}

// Stop all pool activity: timers and websocket subscriptions
export function stopPoolRefreshLoop(): void {
  try { if (rayTimer) { clearInterval(rayTimer); rayTimer = undefined; } } catch {}
  try { if (orcaTimer) { clearInterval(orcaTimer); orcaTimer = undefined; } } catch {}
  try { if (aggTimer) { clearInterval(aggTimer); aggTimer = undefined; } } catch {}
  try { if (meteoraTimer) { clearInterval(meteoraTimer); meteoraTimer = undefined; } } catch {}
  try { if (healthTimer) { clearInterval(healthTimer); healthTimer = undefined; } } catch {}
  try { if (wsUnsubscribe) { wsUnsubscribe(); wsUnsubscribe = undefined; } } catch {}
  wsHealthy = false; lastWsEventMs = 0;
  try { logger.info('pools.stop all timers and ws unsubscribed'); } catch {}
}

// Allow external trigger (from graph start) to enable websocket-based refreshes
export function enablePoolWebsocketRefreshes(): void {
  if (wsAllowed) return;
  wsAllowed = true;
  try {
    // Only mark allowed; actual start is controlled by subscribe/unsubscribe routes
    logger.info('pools.ws allowed');
  } catch {}
}

export function disablePoolWebsocketRefreshes(): void {
  try {
    if (wsUnsubscribe) { wsUnsubscribe(); wsUnsubscribe = undefined; }
    if (healthTimer) { clearInterval(healthTimer); healthTimer = undefined; }
    wsHealthy = false; lastWsEventMs = 0;
    logger.info('pools.ws unsubscribed');
  } catch {}
}

export function getPoolWsStatus(): { enabled: boolean; healthy: boolean; lastEventMs: number } {
  const enabled = !!((CONFIG.system as any)?.enablePoolWs) && wsAllowed;
  return { enabled, healthy: !!wsHealthy, lastEventMs: lastWsEventMs || 0 };
}

// Clear all in-memory normalized caches to force a fresh rebuild next boot
export function clearAllPoolCaches(): void {
  try { raydiumCache.data = undefined as any; raydiumCache.ts = 0; raydiumCache.inflight = undefined; } catch {}
  try { orcaCache.data = undefined as any; orcaCache.ts = 0; orcaCache.inflight = undefined; } catch {}
  try { meteoraCache.data = undefined as any; meteoraCache.ts = 0; meteoraCache.inflight = undefined; } catch {}
  try { enrichMemo.clear(); } catch {}
  try { logger.info('pools.caches cleared'); } catch {}
}

// Simple memo cache for per-pool enrichment results across cycles
const enrichMemo: Map<string, { mint_a?: string; mint_b?: string; decimals_a?: number; decimals_b?: number; ts: number }> = new Map();

// Non-fetching peek helpers so the graph can rebuild from current caches only
export function peekRaydiumPools(): PoolsPayload { return raydiumCache.data || { amm: [], clmm: [] }; }
export function peekOrcaPools(): PoolsPayload { return orcaCache.data || { amm: [], clmm: [] }; }
export function peekMeteoraPools(): PoolsPayload { return meteoraCache.data || { amm: [], clmm: [] }; }
export function peekSaberPools(): PoolsPayload { return saberCache.data || { amm: [], clmm: [] }; }
export function peekMeteoraBalancedPools(): PoolsPayload { return metbalCache.data || { amm: [], clmm: [] }; }

export async function getSaberPoolsCached(force = false): Promise<PoolsPayload> {
  const ttlMs = Number(((CONFIG as any)?.saber?.cacheTtlMs) || 300_000);
  const minForceGap = Math.max(1000, Number((CONFIG.system as any)?.poolRefreshMinGapMs || 3000));
  (getSaberPoolsCached as any).__lastForceAt = (getSaberPoolsCached as any).__lastForceAt || 0;
  const now = Date.now();
  if (!force) {
    if (saberCache.data && now - saberCache.ts < ttlMs) return saberCache.data;
    return saberCache.data || { amm: [], clmm: [] };
  }
  if (force) {
    const last = (getSaberPoolsCached as any).__lastForceAt as number;
    if (now - last < minForceGap && saberCache.data) return saberCache.data as any;
    (getSaberPoolsCached as any).__lastForceAt = now;
  }
  if (saberCache.inflight) return saberCache.inflight;
  saberCache.inflight = (async () => {
    try {
      const t0 = Date.now();
      const raw = await fetchSaberRegistryImpl();
      const norm = await normalizeSaberRegistryImpl(raw);
      const prev = saberCache.data;
      saberCache.data = norm; saberCache.ts = Date.now();
      poolsMetrics.saber.fetches = (poolsMetrics.saber.fetches || 0) + 1;
      poolsMetrics.saber.lastMs = Date.now() - t0;
      poolsMetrics.saber.lastAmm = (norm.amm || []).length;
      try {
        const d = diffNormalizedPools(prev || { amm: [], clmm: [] }, norm);
        emit('pools-update', { source: 'saber', amm: (norm.amm || []).length, clmm: 0, ts: Date.now() });
        emit('pool-updates', { source: 'saber', updatedAmm: d.amm.length, updatedClmm: d.clmm.length, addedAmm: d.addedAmm, removedAmm: d.removedAmm, addedClmm: d.addedClmm, removedClmm: d.removedClmm, sample: { amm: d.amm.slice(0, 50), clmm: [] }, ts: Date.now() });
      } catch {}
      return norm;
    } finally {
      saberCache.inflight = undefined;
    }
  })();
  return saberCache.inflight;
}

export async function getMeteoraBalancedPoolsCached(force = false): Promise<PoolsPayload> {
  const ttlMs = Number(((CONFIG as any)?.meteoraBalanced?.cacheTtlMs) || 300_000);
  const minForceGap = Math.max(1000, Number((CONFIG.system as any)?.poolRefreshMinGapMs || 3000));
  (getMeteoraBalancedPoolsCached as any).__lastForceAt = (getMeteoraBalancedPoolsCached as any).__lastForceAt || 0;
  const now = Date.now();
  if (!force) {
    if (metbalCache.data && now - metbalCache.ts < ttlMs) return metbalCache.data;
    return metbalCache.data || { amm: [], clmm: [] };
  }
  if (force) {
    const last = (getMeteoraBalancedPoolsCached as any).__lastForceAt as number;
    if (now - last < minForceGap && metbalCache.data) return metbalCache.data as any;
    (getMeteoraBalancedPoolsCached as any).__lastForceAt = now;
  }
  if (metbalCache.inflight) return metbalCache.inflight;
  metbalCache.inflight = (async () => {
    try {
      const t0 = Date.now();
      const raw = await fetchMeteoraBalancedHttpImpl();
      const norm = await normalizeMeteoraBalancedHttpImpl(raw);
      const prev = metbalCache.data;
      metbalCache.data = norm; metbalCache.ts = Date.now();
      poolsMetrics.meteora_balanced.fetches = (poolsMetrics.meteora_balanced.fetches || 0) + 1;
      poolsMetrics.meteora_balanced.lastMs = Date.now() - t0;
      poolsMetrics.meteora_balanced.lastAmm = (norm.amm || []).length;
      try {
        const d = diffNormalizedPools(prev || { amm: [], clmm: [] }, norm);
        emit('pools-update', { source: 'meteora_balanced', amm: (norm.amm || []).length, clmm: 0, ts: Date.now() });
        emit('pool-updates', { source: 'meteora_balanced', updatedAmm: d.amm.length, updatedClmm: d.clmm.length, addedAmm: d.addedAmm, removedAmm: d.removedAmm, addedClmm: d.addedClmm, removedClmm: d.removedClmm, sample: { amm: d.amm.slice(0, 50), clmm: [] }, ts: Date.now() });
      } catch {}
      return norm;
    } finally {
      metbalCache.inflight = undefined;
    }
  })();
  return metbalCache.inflight;
}

export async function getRaydiumPoolsNormalized(force = false): Promise<PoolsPayload> {
  const ttlMs = Number(CONFIG.raydium?.cacheTtlMs || 300_000);
  const minForceGap = Math.max(1000, Number((CONFIG.system as any)?.poolRefreshMinGapMs || 3000));
  (getRaydiumPoolsNormalized as any).__lastForceAt = (getRaydiumPoolsNormalized as any).__lastForceAt || 0;
  const now = Date.now();
  // In non-forced mode, never initiate a fetch. Only return cached data (even if stale) or empty.
  if (!force) {
    if (raydiumCache.data && now - raydiumCache.ts < ttlMs) return raydiumCache.data;
    return raydiumCache.data || { amm: [], clmm: [] };
  }
  if (force) {
    const last = (getRaydiumPoolsNormalized as any).__lastForceAt as number;
    if (now - last < minForceGap && raydiumCache.data) return raydiumCache.data;
    (getRaydiumPoolsNormalized as any).__lastForceAt = now;
  }
  if (raydiumCache.inflight) return raydiumCache.inflight;

  raydiumCache.inflight = (async () => {
    try {
      const t0 = Date.now();
      const mode = 'api';
      logger.info('raydium.fetch start', {
        mode,
        ttlMs,
        concurrency: Number(CONFIG.raydium?.sdkConcurrency || 8),
        uniMode: (CONFIG.system as any)?.tokenUniverseMode || 'jupiter',
        anchorBridging: !!((CONFIG.system as any)?.enableAnchorBridging),
        includeAnchors: (CONFIG.system as any)?.includeAnchorsInUniverse !== false,
        canonicalizePairs: (CONFIG.system as any)?.canonicalizePairs || 'none',
        cat: 'raydium'
      });
        try { emit('log', { level: 'info', message: `arb:pools raydium.fetch start mode=${mode}`, timestamp: new Date().toISOString(), context: { cat: 'arb' } }); } catch {}

      const raw: any = await fetchRaydiumPoolsRawImpl();
      let norm = await normalizeRaydiumPoolsImpl(raw);
      // Apply universe filtering early so caches are consistent across sources
      try {
        const { computeTokenUniverse, filterPoolsByUniverse } = await import('./universe.js');
        const mode: any = (CONFIG.system as any)?.tokenUniverseMode || 'jupiter';
        const uni = await computeTokenUniverse(mode);
        const beforeAmm = norm.amm.length, beforeClmm = norm.clmm.length;
        const scoped = filterPoolsByUniverse(norm as any, uni, !!((CONFIG.system as any)?.enableAnchorBridging));
        if (scoped.amm.length !== beforeAmm || scoped.clmm.length !== beforeClmm) {
          poolsMetrics.raydium.filteredAmm += (beforeAmm - scoped.amm.length);
          poolsMetrics.raydium.filteredClmm += (beforeClmm - scoped.clmm.length);
          poolsMetrics.raydium.universe = String(mode);
          try { logger.info('raydium.universe.filter', { mode, beforeAmm, beforeClmm, afterAmm: scoped.amm.length, afterClmm: scoped.clmm.length }); } catch {}
        }
        norm = scoped as any;
      } catch {}

      // Apply token blocklist (exclude pools containing any blocked mint)
      try {
        const blist = new Set<string>(Array.isArray((CONFIG.system as any)?.tokenBlocklistMints) ? (CONFIG.system as any).tokenBlocklistMints : []);
        if (blist.size > 0) {
          const beforeAmm = norm.amm.length, beforeClmm = norm.clmm.length;
          const filtered = applyTokenMintBlocklist(norm as any, blist);
          if (filtered.amm.length !== beforeAmm || filtered.clmm.length !== beforeClmm) {
            try { logger.info('raydium.blocklist.filter', { beforeAmm, beforeClmm, afterAmm: filtered.amm.length, afterClmm: filtered.clmm.length }); } catch {}
          }
          norm = filtered as any;
        }
      } catch {}

      // Optional: TVL-based filtering to drop dust pools (config-driven)
      try {
        const globalAmm = Number(((CONFIG.system as any)?.minAmmLiqBase) ?? 0);
        const globalClmm = Number(((CONFIG.system as any)?.minClmmLiquidity) ?? 0);
        const minAmmUsd = Math.max(globalAmm, Number((CONFIG.raydium as any)?.minAmmLiqBase || 0));
        const minClmmUsd = Math.max(globalClmm, Number((CONFIG.raydium as any)?.minClmmLiquidity || 0));
        if (minAmmUsd > 0 || minClmmUsd > 0) {
          const beforeAmm = norm.amm.length, beforeClmm = norm.clmm.length;
          const amm = minAmmUsd > 0 ? norm.amm.filter(p => Number((p as any).tvl_usd || 0) >= minAmmUsd) : norm.amm;
          const clmm = minClmmUsd > 0 ? norm.clmm.filter(p => Number((p as any).tvl_usd || 0) >= minClmmUsd) : norm.clmm;
          if (amm.length !== beforeAmm || clmm.length !== beforeClmm) { logger.info('raydium.filter tvl', { minAmmUsd, minClmmUsd, beforeAmm, beforeClmm, afterAmm: amm.length, afterClmm: clmm.length }); }
          norm = { amm, clmm } as any;
        }
      } catch {}

      poolsMetrics.raydium.fetches += 1;
      poolsMetrics.raydium.lastMs = Date.now() - t0;
      poolsMetrics.raydium.lastAmm = norm.amm.length;
      poolsMetrics.raydium.lastClmm = norm.clmm.length;
      logger.info('raydium.fetch normalized', { amm: norm.amm.length, clmm: norm.clmm.length, ms: poolsMetrics.raydium.lastMs, cat: 'raydium', canon: (CONFIG.system as any)?.canonicalizePairs || 'none' });
      try { emit('log', { level: 'info', message: `arb:pools raydium.fetch ok amm=${norm.amm.length} clmm=${norm.clmm.length}`, timestamp: new Date().toISOString(), context: { cat: 'arb' } }); } catch {}

      const prev = raydiumCache.data;
      raydiumCache.data = norm;
      raydiumCache.ts = Date.now();

      // Emit socket event when normalized cache changes
      try {
        const prevAmm = prev?.amm?.length || 0;
        const prevClmm = prev?.clmm?.length || 0;
        const nextAmm = norm.amm.length;
        const nextClmm = norm.clmm.length;
        const changed = !prev || prevAmm !== nextAmm || prevClmm !== nextClmm;
        if (changed) {
          emit('pools-update', { source: 'raydium', amm: nextAmm, clmm: nextClmm, ts: Date.now() });
          emit('log', { level: 'info', message: `pools:update source=raydium amm=${nextAmm} clmm=${nextClmm}`, timestamp: new Date().toISOString(), context: { cat: 'pools' } });
        }
      } catch {}
      // Emit fine-grained pool-updates (deltas) for downstream debounced graph rebuild
      try {
        const d = diffNormalizedPools(prev || { amm: [], clmm: [] }, norm);
        const sample = { amm: d.amm.slice(0, 100), clmm: d.clmm.slice(0, 100) };
        emit('pool-updates', { source: 'raydium', updatedAmm: d.amm.length, updatedClmm: d.clmm.length, addedAmm: d.addedAmm, removedAmm: d.removedAmm, addedClmm: d.addedClmm, removedClmm: d.removedClmm, sample, ts: Date.now(), canon: (CONFIG.system as any)?.canonicalizePairs || 'none' });
        // Debounced graph rebuild on pool delta
        try {
          const gmod: any = await import('./graph.js');
          const thresh = Math.max(0, Number((CONFIG.system as any)?.graphDeltaRebuildThreshold || 0));
          const delta = d.amm.length + d.clmm.length + d.addedAmm + d.addedClmm + d.removedAmm + d.removedClmm;
          if (thresh === 0 || delta >= thresh) gmod.scheduleGraphRebuild(undefined, Math.max(50, Number((CONFIG.system as any)?.graphRebuildDebounceMs || 150)));
        } catch {}
        try { logger.info('pools.delta raydium', { updatedAmm: d.amm.length, updatedClmm: d.clmm.length, addedAmm: d.addedAmm, removedAmm: d.removedAmm, addedClmm: d.addedClmm, removedClmm: d.removedClmm, cat: 'pools' }); } catch {}
      } catch {}
      // Graph rebuilds now orchestrated by refresh endpoint; avoid redundant triggers here

      return norm;
    } finally {
      raydiumCache.inflight = undefined;
    }
  })();

  return raydiumCache.inflight;
}

export async function getOrcaPoolsCached(force = false): Promise<PoolsPayload> {
  const ttlMs = CONFIG.orca?.cacheTtlMs ?? 300_000; // 5 minutes default
  const minForceGap = Math.max(1000, Number((CONFIG.system as any)?.poolRefreshMinGapMs || 3000));
  (getOrcaPoolsCached as any).__lastForceAt = (getOrcaPoolsCached as any).__lastForceAt || 0;
  const now = Date.now();
  // In non-forced mode, never initiate a fetch. Only return cached data (even if stale) or empty.
  if (!force) {
    if (orcaCache.data && now - orcaCache.ts < ttlMs) return orcaCache.data;
    return orcaCache.data || { amm: [], clmm: [] };
  }
  // Debounce forced refreshes
  if (force) {
    const last = (getOrcaPoolsCached as any).__lastForceAt as number;
    if (now - last < minForceGap && orcaCache.data) return orcaCache.data as any;
    (getOrcaPoolsCached as any).__lastForceAt = now;
  }
  if (orcaCache.inflight) return orcaCache.inflight;
  orcaCache.inflight = (async () => {
    try {
      const t0 = Date.now();
      const data = await getOrcaPoolsNormalized();
      const prev = orcaCache.data;
      orcaCache.data = data;
      orcaCache.ts = Date.now();
      poolsMetrics.orca.fetches += 1;
      poolsMetrics.orca.lastMs = Date.now() - t0;
      poolsMetrics.orca.lastAmm = (data.amm || []).length;
      poolsMetrics.orca.lastClmm = (data.clmm || []).length;
      // Emit socket event when normalized cache changes
      try {
        const prevAmm = prev?.amm?.length || 0;
        const prevClmm = prev?.clmm?.length || 0;
        const nextAmm = (data.amm || []).length;
        const nextClmm = (data.clmm || []).length;
        const changed = !prev || prevAmm !== nextAmm || prevClmm !== nextClmm;
        if (changed) {
          emit('pools-update', { source: 'orca', amm: nextAmm, clmm: nextClmm, ts: Date.now() });
          emit('log', { level: 'info', message: `pools:update source=orca amm=${nextAmm} clmm=${nextClmm}`, timestamp: new Date().toISOString(), context: { cat: 'pools' } });
        }
      } catch {}
      // Emit fine-grained pool-updates (deltas) for downstream debounced graph rebuild
      try {
        const d = diffNormalizedPools(prev || { amm: [], clmm: [] }, data);
        const sample = { amm: d.amm.slice(0, 100), clmm: d.clmm.slice(0, 100) };
        emit('pool-updates', { source: 'orca', updatedAmm: d.amm.length, updatedClmm: d.clmm.length, addedAmm: d.addedAmm, removedAmm: d.removedAmm, addedClmm: d.addedClmm, removedClmm: d.removedClmm, sample, ts: Date.now(), canon: (CONFIG.system as any)?.canonicalizePairs || 'none' });
        try { logger.debug('pools.delta orca', { updatedAmm: d.amm.length, updatedClmm: d.clmm.length, addedAmm: d.addedAmm, removedAmm: d.removedAmm, addedClmm: d.addedClmm, removedClmm: d.removedClmm, cat: 'pools' }); } catch {}
        // Debounced graph rebuild on pool delta
        try {
          const gmod: any = await import('./graph.js');
          const thresh = Math.max(0, Number((CONFIG.system as any)?.graphDeltaRebuildThreshold || 0));
          const delta = d.amm.length + d.clmm.length + d.addedAmm + d.addedClmm + d.removedAmm + d.removedClmm;
          if (thresh === 0 || delta >= thresh) gmod.scheduleGraphRebuild(undefined, Math.max(50, Number((CONFIG.system as any)?.graphRebuildDebounceMs || 150)));
        } catch {}
      } catch {}
      // Graph rebuilds now orchestrated by refresh endpoint; avoid redundant triggers here
      return data;
    } finally {
      orcaCache.inflight = undefined;
    }
  })();
  return orcaCache.inflight;
}

export async function getOrcaPoolsNormalized(): Promise<PoolsPayload> {
  logger.info('orca.fetch start', {
    mode: 'http',
    uniMode: (CONFIG.system as any)?.tokenUniverseMode || 'jupiter',
    anchorBridging: !!((CONFIG.system as any)?.enableAnchorBridging),
    includeAnchors: (CONFIG.system as any)?.includeAnchorsInUniverse !== false,
    canonicalizePairs: (CONFIG.system as any)?.canonicalizePairs || 'none',
  });
  // Try configured mode, then fallbacks to maximize robustness
  const tried: string[] = [];
    try {
    const raw = await fetchOrcaHttpImpl();
    let norm = await normalizeOrcaHttpImpl(raw);
        // Apply token blocklist (exclude pools containing any blocked mint)
        try {
          const blist = new Set<string>(Array.isArray((CONFIG.system as any)?.tokenBlocklistMints) ? (CONFIG.system as any).tokenBlocklistMints : []);
          if (blist.size > 0) {
            const beforeAmm = (norm.amm || []).length, beforeClmm = (norm.clmm || []).length;
            const filtered = applyTokenMintBlocklist(norm as any, blist);
            if (filtered.amm.length !== beforeAmm || filtered.clmm.length !== beforeClmm) {
              try { logger.info('orca.blocklist.filter', { beforeAmm, beforeClmm, afterAmm: filtered.amm.length, afterClmm: filtered.clmm.length }); } catch {}
            }
            norm = filtered as any;
          }
        } catch {}
        // Apply universe filtering early so caches are consistent across sources
        try {
          const uniModeAny: any = (CONFIG.system as any)?.tokenUniverseMode || 'jupiter';
          const isTest = String(((globalThis as any)?.process?.env?.NODE_ENV) || '') === 'test';
          const isVitest = !!((globalThis as any)?.vi || (globalThis as any)?.vitest || (String(((globalThis as any)?.process?.env?.VITEST) || '') === 'true'));
          const skipUniverse = isTest || isVitest || String(uniModeAny) === 'none';
          if (!skipUniverse) {
            const { computeTokenUniverse, filterPoolsByUniverse } = await import('./universe.js');
            const uni = await computeTokenUniverse(uniModeAny);
            const beforeAmm = norm.amm.length, beforeClmm = norm.clmm.length;
            const scoped = filterPoolsByUniverse(norm as any, uni, !!((CONFIG.system as any)?.enableAnchorBridging));
            if (scoped.amm.length !== beforeAmm || scoped.clmm.length !== beforeClmm) {
              poolsMetrics.orca.lastAmm = scoped.amm.length;
              poolsMetrics.orca.lastClmm = scoped.clmm.length;
              try { logger.info('orca.universe.filter', { mode: uniModeAny, beforeAmm, beforeClmm, afterAmm: scoped.amm.length, afterClmm: scoped.clmm.length }); } catch {}
            }
            norm = scoped as any;
          } else {
            try { logger.info('orca.universe.filter skip', { reason: isTest ? 'test' : 'mode:none' }); } catch {}
          }
        } catch {}
        // Defer TVL filtering to graph-level to avoid early pruning across sources
  logger.info('orca.http normalized', { clmm: norm.clmm.length, canon: (CONFIG.system as any)?.canonicalizePairs || 'none' });
        return norm;
    } catch (e: any) {
    tried.push(`http:${String(e?.message || e)}`);
    logger.warn('orca.http failed', { tried });
  return { amm: [], clmm: [] };
  }
}

export async function getMeteoraPoolsCached(force = false): Promise<PoolsPayload> {
  const ttlMs = Number(((CONFIG as any)?.meteora?.cacheTtlMs) || 300_000);
  const minForceGap = Math.max(1000, Number((CONFIG.system as any)?.poolRefreshMinGapMs || 3000));
  (getMeteoraPoolsCached as any).__lastForceAt = (getMeteoraPoolsCached as any).__lastForceAt || 0;
  const now = Date.now();
  if (!force) {
    if (meteoraCache.data && now - meteoraCache.ts < ttlMs) return meteoraCache.data;
    return meteoraCache.data || { amm: [], clmm: [] };
  }
  if (force) {
    const last = (getMeteoraPoolsCached as any).__lastForceAt as number;
    if (now - last < minForceGap && meteoraCache.data) return meteoraCache.data as any;
    (getMeteoraPoolsCached as any).__lastForceAt = now;
  }
  if (meteoraCache.inflight) return meteoraCache.inflight;
  meteoraCache.inflight = (async () => {
    try {
      const mode = 'http';
      try { logger.info('meteora.fetch start', { mode, ttlMs, uniMode: (CONFIG.system as any)?.tokenUniverseMode || 'jupiter', anchorBridging: !!((CONFIG.system as any)?.enableAnchorBridging), includeAnchors: (CONFIG.system as any)?.includeAnchorsInUniverse !== false, canonicalizePairs: (CONFIG.system as any)?.canonicalizePairs || 'none', cat: 'meteora' }); } catch {}
      try { emit('log', { level: 'info', message: `arb:pools meteora.fetch start mode=${mode}`, timestamp: new Date().toISOString(), context: { cat: 'arb' } }); } catch {}
      const t0 = Date.now();
      const raw = await fetchMeteoraHttpImpl();
      let norm = await normalizeMeteoraHttpImpl(raw);
      // Apply token blocklist (exclude pools containing any blocked mint)
      try {
        const blist = new Set<string>(Array.isArray((CONFIG.system as any)?.tokenBlocklistMints) ? (CONFIG.system as any).tokenBlocklistMints : []);
        if (blist.size > 0) {
          const beforeClmm = (norm.clmm || []).length;
          const filtered = applyTokenMintBlocklist(norm as any, blist);
          if ((filtered.clmm || []).length !== beforeClmm) {
            try { logger.info('meteora.blocklist.filter', { beforeClmm, afterClmm: filtered.clmm.length }); } catch {}
          }
          norm = filtered as any;
        }
      } catch {}
      // Optionally apply universe filtering early (disabled by default for Meteora)
      try {
        const prefilter = !!((CONFIG as any)?.meteora?.universePrefilter);
        if (prefilter) {
          const { computeTokenUniverse, filterPoolsByUniverse } = await import('./universe.js');
          const mode: any = (CONFIG.system as any)?.tokenUniverseMode || 'jupiter';
          const uni = await computeTokenUniverse(mode);
          const beforeClmm = norm.clmm.length;
          const scoped = filterPoolsByUniverse(norm as any, uni, !!((CONFIG.system as any)?.enableAnchorBridging));
          if (scoped.clmm.length !== beforeClmm) { try { logger.info('meteora.universe.filter', { mode, beforeClmm, afterClmm: scoped.clmm.length }); } catch {} }
          norm = { amm: [], clmm: scoped.clmm } as any;
        }
      } catch {}
       // TVL filter (apply global thresholds on top of per-source)
      // Defer TVL filtering to graph-level to avoid early pruning across sources
      const prev = meteoraCache.data;
      meteoraCache.data = norm; meteoraCache.ts = Date.now();
      poolsMetrics.meteora.fetches += 1;
      poolsMetrics.meteora.lastMs = Date.now() - t0;
      poolsMetrics.meteora.lastClmm = norm.clmm.length;
      try { logger.info('meteora.fetch normalized', { clmm: norm.clmm.length, ms: poolsMetrics.meteora.lastMs, cat: 'meteora' }); } catch {}
      try { emit('log', { level: 'info', message: `arb:pools meteora.fetch ok clmm=${norm.clmm.length}`, timestamp: new Date().toISOString(), context: { cat: 'arb' } }); } catch {}
      try {
        const d = diffNormalizedPools(prev || { amm: [], clmm: [] }, norm);
        const sample = { amm: [], clmm: d.clmm.slice(0, 100) };
        emit('pools-update', { source: 'meteora', amm: 0, clmm: norm.clmm.length, ts: Date.now() });
        emit('pool-updates', { source: 'meteora', updatedAmm: d.amm.length, updatedClmm: d.clmm.length, addedAmm: d.addedAmm, removedAmm: d.removedAmm, addedClmm: d.addedClmm, removedClmm: d.removedClmm, sample, ts: Date.now() });
      } catch {}
      // Graph rebuilds now orchestrated by refresh endpoint; avoid redundant triggers here
      return meteoraCache.data!;
    } finally {
      meteoraCache.inflight = undefined;
    }
  })();
  return meteoraCache.inflight;
}

// Orca HTTP fetcher provided in ./pools/orca.ts

// Orca normalization and fetch helpers are provided in ./pools/orca.ts
 


