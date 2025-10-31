import { logger } from '../utils/logger.js';
import { emit } from './realtime.js';
import { CONFIG } from '../utils/config.js';
import { readJson } from '../utils/fs.js';
import { enablePriceFeed, isPriceFeedEnabled } from './feedRegistry.js';
// Defer web3 imports to runtime to prevent type issues in environments without types
// import { PublicKey } from '@solana/web3.js';
import type { AmmPool, ClmmPool, PoolsPayload } from './pools/types.js';
import { fetchRaydiumPoolsRaw as fetchRaydiumPoolsRawImpl, normalizeRaydiumPools as normalizeRaydiumPoolsImpl } from './pools/raydium.js';
import { fetchOrcaHttp as fetchOrcaHttpImpl, normalizeOrcaHttp as normalizeOrcaHttpImpl } from './pools/orca.js';
import { fetchMeteoraHttp as fetchMeteoraHttpImpl, normalizeMeteoraHttp as normalizeMeteoraHttpImpl } from './pools/meteora.js';
import { validateCrossDexPrices, verifyCanonicalization } from './pools/validation.js';
import { httpLogStart, httpLogResponse, httpLog429, httpLogNonOk } from './pools/httpLog.js';
import { fetchMeteoraBalancedHttp as fetchMeteoraBalancedHttpImpl, normalizeMeteoraBalancedHttp as normalizeMeteoraBalancedHttpImpl, fetchMeteoraBalancedAll as fetchMeteoraBalancedAllImpl } from './pools/meteoraBalanced.js';

const raydiumCache: { data: PoolsPayload | null; ts: number; inflight?: Promise<PoolsPayload> } = { data: null, ts: 0 };
const orcaCache: { data: PoolsPayload | null; ts: number; inflight?: Promise<PoolsPayload> } = { data: null, ts: 0 };
const meteoraCache: { data: PoolsPayload | null; ts: number; inflight?: Promise<PoolsPayload> } = { data: null, ts: 0 };
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
// Track current Connection instance and any pending close so new setups wait for a clean state
let wsConn: any | undefined;
let wsClosePromise: Promise<void> | null = null;
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
export function getPoolCacheAges(): { raydium: number; orca: number; meteora: number; meteora_balanced: number; ttl: { raydium: number; orca: number; meteora: number; meteora_balanced: number } } {
  const now = Date.now();
  const rayTtl = Number((CONFIG as any)?.raydium?.cacheTtlMs || 300_000);
  const orcTtl = Number((CONFIG as any)?.orca?.cacheTtlMs || 300_000);
  const metTtl = Number(((CONFIG as any)?.meteora?.cacheTtlMs) || 300_000);
  const mblTtl = Number(((CONFIG as any)?.meteoraBalanced?.cacheTtlMs) || 300_000);
  const rayAge = raydiumCache.ts ? (now - raydiumCache.ts) : Number.POSITIVE_INFINITY;
  const orcAge = orcaCache.ts ? (now - orcaCache.ts) : Number.POSITIVE_INFINITY;
  const metAge = meteoraCache.ts ? (now - meteoraCache.ts) : Number.POSITIVE_INFINITY;
  const mblAge = metbalCache.ts ? (now - metbalCache.ts) : Number.POSITIVE_INFINITY;
  return { raydium: rayAge, orca: orcAge, meteora: metAge, meteora_balanced: mblAge, ttl: { raydium: rayTtl, orca: orcTtl, meteora: metTtl, meteora_balanced: mblTtl } };
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
export async function refreshAllSources(force = true, subscribe = true): Promise<{ raydium: PoolsPayload; orca: PoolsPayload; meteora: PoolsPayload; meteora_balanced: PoolsPayload }> {
  try {
    // Deep bootstrap phase: optionally pause feed/API, fetch Jup tokens, then hydrate prices
    if (force) {
      let shouldResumeFeed = false;
      const pauseFeed = ((CONFIG.system as any)?.pausePriceFeedDuringBootstrap !== false);
      if (pauseFeed) {
        try { emit('log', { level: 'info', message: 'pools:bootstrap api.pause', timestamp: new Date().toISOString(), context: { cat: 'pools' } }); } catch {}
        try { logger.info('pools:bootstrap api.pause', { cat: 'pools' }); } catch {}
        try {
          const reg: any = await import('./feedRegistry.js');
          shouldResumeFeed = reg.isPriceFeedEnabled?.() === true;
          reg.enablePriceFeed?.(false);
        } catch {}
        try { (await import('../jupiter/rateLimiter.js')).apiStop(); } catch {}
      }

      // Removed auto verified token refresh in refresh flow; use manual endpoint

      // Removed auto bootstrap on refresh; use manual endpoint

      // Resume Jupiter API before source fetches so downstream calls are allowed
      if (pauseFeed) {
        try { (await import('../jupiter/rateLimiter.js')).apiStart(); } catch {}
        try { emit('log', { level: 'info', message: 'pools:bootstrap api.resume', timestamp: new Date().toISOString(), context: { cat: 'pools' } }); } catch {}
        try { logger.info('pools:bootstrap api.resume', { cat: 'pools' }); } catch {}
        // Stash the intent to resume the feed at the end of refresh
        (refreshAllSources as any).__resumeFeed = shouldResumeFeed;
        // Opportunistically resume immediately if it was previously enabled
        try {
          if (shouldResumeFeed === true) {
            const reg: any = await import('./feedRegistry.js');
            reg.enablePriceFeed?.(true);
          }
        } catch {}
      }
    }
  } catch {}
  const r = await getRaydiumPoolsNormalized(!!force).catch(() => ({ amm: [], clmm: [] }));
  const o = await getOrcaPoolsCached(!!force).catch(() => ({ amm: [], clmm: [] }));
  const m = await getMeteoraPoolsCached(!!force).catch(() => ({ amm: [], clmm: [] }));
  const mb = await getMeteoraBalancedPoolsCached(!!force).catch(() => ({ amm: [], clmm: [] }));

  // Post-fetch bootstrap: if pricing coverage is low, hydrate prices for all fetched mints and rebuild graph
  try {
    if (force) {
      const { getAllPrices } = await import('./priceStore.js');
      const mintSet = new Set<string>();
      const addFrom = (pp: PoolsPayload) => {
        try { for (const p of (pp?.amm || [])) { if (p?.mint_a) mintSet.add(String(p.mint_a)); if (p?.mint_b) mintSet.add(String(p.mint_b)); } } catch {}
        try { for (const p of (pp?.clmm || [])) { if (p?.mint_a) mintSet.add(String(p.mint_a)); if (p?.mint_b) mintSet.add(String(p.mint_b)); } } catch {}
      };
      addFrom(r); addFrom(o); addFrom(m); addFrom(mb);
      if (mintSet.size > 0) {
        const pricedMap = getAllPrices() || {};
        let pricedCount = 0;
        for (const x of mintSet) { if (typeof (pricedMap as any)[x]?.usdc === 'number') pricedCount++; }
        const coverage = pricedCount / Math.max(1, mintSet.size);
        const minPriced = Math.max(50, Number((CONFIG.system as any)?.minMintPriceBootstrap || 120));
        const minCoverage = Math.max(0.05, Math.min(0.9, Number((CONFIG.system as any)?.minMintPriceCoverage || 0.4)));
        // Removed post-refresh mass bootstrap; only report coverage metrics

        // Secondary pass: price any fetched mints outside the Jupiter token list
        // Removed secondary pass for outside-Jupiter mints
      }
    }
  } catch {}
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
        try { logger.debug('pools.pair_sol_usdc', { source: 'raydium', id: rayPick.id, kind: rayPick.pool_kind || (rayPick.sqrt_price_x64 != null ? 'clmm' : 'amm'), forward_usdc_per_sol: forward, reverse_sol_per_usdc: reverse, cat: 'pools' }); } catch {}
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
        try { logger.debug('pools.pair_sol_usdc', { source: 'orca', id: orcPick.id, kind: orcPick.pool_kind || (orcPick.sqrt_price_x64 != null ? 'clmm' : 'amm'), forward_usdc_per_sol: forward, reverse_sol_per_usdc: reverse, cat: 'pools' }); } catch {}
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
        try { logger.debug('pools.pair_sol_usdc', { source: 'meteora', id: metPick.id, kind: metPick.pool_kind || (metPick.sqrt_price_x64 != null ? 'clmm' : 'amm'), forward_usdc_per_sol: forward, reverse_sol_per_usdc: reverse, cat: 'pools' }); } catch {}
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
  // Resume watchlist price feed based on prior state or watchlist
  try {
    if (force) {
      const reg: any = await import('./feedRegistry.js');
      const wantResume = (refreshAllSources as any).__resumeFeed === true || reg.isPriceFeedEnabled?.() === true;
      delete (refreshAllSources as any).__resumeFeed;
      const fsmod: any = await import('../utils/fs.js');
      const wl = await fsmod.readJson(CONFIG.watchlistPath, [] as any[]);
      const shouldEnable = wantResume || (Array.isArray(wl) && wl.length > 0);
      reg.enablePriceFeed?.(shouldEnable);
      try { emit('log', { level: 'info', message: `pools:bootstrap feed.resume enabled=${shouldEnable}`, timestamp: new Date().toISOString(), context: { cat: 'pools' } }); } catch {}
      try { logger.info(`pools:bootstrap feed.resume enabled=${shouldEnable}`, { cat: 'pools' }); } catch {}
    }
  } catch {}
  if (subscribe) {
    try {
      enablePoolWebsocketRefreshes();
      startRaydiumRefreshLoop();
    } catch {}
  }
  // One-shot consolidated graph push after initial forced refresh completes (guarded)
  try {
    (refreshAllSources as any).__didInitialGraphPush = (refreshAllSources as any).__didInitialGraphPush || false;
    if (force && !(refreshAllSources as any).__didInitialGraphPush) {
      const gmod: any = await import('./graph.js');
      try { await gmod.rebuildGraphNow(); } catch {}
      // Ensure websocket-based pool refreshes are enabled immediately after first graph build
      try { const pools = await import('./pools.js'); (pools as any).enablePoolWebsocketRefreshes?.(); } catch {}
      (refreshAllSources as any).__didInitialGraphPush = true;
    }
  } catch {}
  return { raydium: r, orca: o, meteora: m, meteora_balanced: mb };
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
        if (wsSetupActive) { try { logger.debug('pools.ws setup already active'); } catch {} return; }
        wsSetupActive = true;
        let web3: any = null;
        try { const mod = ['@solana/web3.js'].join(''); web3 = await import(mod as any); } catch {}
        if (!web3) { logger.warn('pools.ws disabled: @solana/web3.js not available'); return; }
        // If a previous unsubscribe initiated a websocket close, wait for it to finish before creating a new Connection
        try { if (wsClosePromise) { await wsClosePromise.catch(() => {}); } } catch {}
        wsClosePromise = null;
        const conn = new web3.Connection(CONFIG.rpcUrl, CONFIG.system.txCommitment as any);
        // Record connection so we can actively close its underlying WS on unsubscribe
        wsConn = conn;
        const rayAmm = new web3.PublicKey(String(CONFIG.raydium?.ammV4Program).trim());
        const rayClmm = new web3.PublicKey(String(CONFIG.raydium?.clmmProgram).trim());
        const orcaProg = new web3.PublicKey(String(CONFIG.orca?.programId || 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc').trim());
        const subs: Array<{ kind: 'account' | 'program'; id: number }> = [];
        // Track explicit targets so we can classify events for SPL Token vault accounts (e.g., Raydium AMM vaults)
        const targetedSourceByAccount: Map<string, 'raydium' | 'orca' | 'meteora'> = new Map();
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
              const mapped = targetedSourceByAccount.get(pk58);
              const src = mapped || ((owner === ownerRayAmm || owner === ownerRayClmm) ? 'raydium' : (owner === ownerOrca ? 'orca' : ((ownerMeteora && owner === ownerMeteora) || isMeteoraTarget ? 'meteora' : 'unknown')));
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
                      // Derive A per 1 B using sqrtPrice and decimals:
                      // price_B_per_A = (ratio^2) * 10^(decA - decB)
                      // price_A_per_B = 1 / price_B_per_A
                      const price_a_per_b = await (async () => {
                        try {
                          if (!Number.isFinite(sqrt) || sqrt <= 0) return undefined;
                          let decA: number | undefined; let decB: number | undefined;
                          try {
                            const tok = await import('../utils/tokens.js');
                            const a = await (tok as any).resolveMint(mintA);
                            const b = await (tok as any).resolveMint(mintB);
                            decA = Number(a?.decimals);
                            decB = Number(b?.decimals);
                          } catch {}
                          if (!Number.isFinite(decA as any) || !Number.isFinite(decB as any)) return undefined;
                          const ratio = sqrt / Math.pow(2, 64);
                          const priceBperA = (ratio * ratio) * Math.pow(10, (decA as number) - (decB as number));
                          const aPerB = priceBperA > 0 ? (1 / priceBperA) : 0;
                          return (aPerB > 0 && Number.isFinite(aPerB)) ? aPerB : undefined;
                        } catch { return undefined; }
                      })();
                      const liq = Number((state as any).liquidity ?? 0);
                      const tick = Number((state as any).tickSpacing ?? (state as any).tick_spacing ?? 0);
                      const fee = Number((state as any).feeRate ?? (state as any).fee_rate ?? 0);
                      const item: ClmmPool = { id: pk58, dex: 'Raydium', mint_a: mintA, mint_b: mintB, fee_bps: fee, sqrt_price_x64: sqrt, liquidity: liq, tick_spacing: tick, updated_ms: Date.now(), pool_kind: 'clmm', liquidity_display: liq, price_a_per_b } as any;
                      const prev = raydiumCache.data || { amm: [], clmm: [] };
                      const next: PoolsPayload = { amm: prev.amm.slice(), clmm: prev.clmm.slice() };
                      const idx = next.clmm.findIndex(p => p.id === item.id);
                      if (idx >= 0) next.clmm[idx] = { ...next.clmm[idx], ...item }; else next.clmm.push(item);
                      const d = diffNormalizedPools(prev, next);
                      raydiumCache.data = next; raydiumCache.ts = Date.now();
                      try { emit('pool-updates', { source: 'raydium', updatedAmm: d.amm.length, updatedClmm: d.clmm.length, sample: { amm: [], clmm: d.clmm.slice(0, 20) }, ts: Date.now() }); } catch {}
                  // Prefer incremental graph apply when enabled; fallback to rebuild
                  try {
                    const inc = !!((CONFIG.system as any)?.graphIncrementalMode);
                    const gmod: any = await import('./graph.js');
                    const hasDelta = (d.amm.length || d.clmm.length || d.addedAmm || d.removedAmm || d.addedClmm || d.removedClmm);
                    if (inc && hasDelta) {
                      await scheduleDexApply('raydium', prev as any);
                    } else {
                      const thresh = Math.max(0, Number((CONFIG.system as any)?.graphDeltaRebuildThreshold || 0));
                      const delta = d.clmm.length;
                      if (thresh === 0 || delta >= thresh) gmod.scheduleGraphRebuild(undefined, Math.max(50, Number((CONFIG.system as any)?.graphRebuildDebounceMs || 150)));
                    }
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
                        let price_a_per_b: number | undefined;
                        try {
                          let decA: number | undefined; let decB: number | undefined;
                          try {
                            const tok = await import('../utils/tokens.js');
                            const a = await (tok as any).resolveMint(mintA);
                            const b = await (tok as any).resolveMint(mintB);
                            decA = Number(a?.decimals);
                            decB = Number(b?.decimals);
                          } catch {}
                          const wholeA = Number.isFinite(decA as any) ? (rA / Math.pow(10, decA as number)) : rA;
                          const wholeB = Number.isFinite(decB as any) ? (rB / Math.pow(10, decB as number)) : rB;
                          if (wholeA > 0 && wholeB > 0) price_a_per_b = wholeA / wholeB;
                        } catch {}
                        const liqBase = (rA > 0 && rB > 0) ? Math.min(rA, rB) : 0;
                        const item: AmmPool = { id: pk58, dex: 'Raydium', mint_a: mintA, mint_b: mintB, fee_bps: Number((state as any).tradeFeeRate || (state as any).feeRate || 0), price_a_per_b, liquidity_base: liqBase, updated_ms: Date.now(), pool_kind: 'amm', liquidity_display: liqBase } as any;
                        const prev = raydiumCache.data || { amm: [], clmm: [] };
                        const next: PoolsPayload = { amm: prev.amm.slice(), clmm: prev.clmm.slice() };
                        const idx = next.amm.findIndex(p => p.id === item.id);
                        if (idx >= 0) next.amm[idx] = { ...next.amm[idx], ...item }; else next.amm.push(item);
                        const d = diffNormalizedPools(prev, next);
                        raydiumCache.data = next; raydiumCache.ts = Date.now();
                        try { emit('pool-updates', { source: 'raydium', updatedAmm: d.amm.length, updatedClmm: d.clmm.length, sample: { amm: d.amm.slice(0, 20), clmm: [] }, ts: Date.now() }); } catch {}
                        // Prefer incremental graph apply when enabled; fallback to rebuild
                        try {
                          const inc = !!((CONFIG.system as any)?.graphIncrementalMode);
                          const gmod: any = await import('./graph.js');
                          const hasDelta = (d.amm.length || d.clmm.length || d.addedAmm || d.removedAmm || d.addedClmm || d.removedClmm);
                          if (inc && hasDelta) {
                            await scheduleDexApply('raydium', prev as any);
                          } else {
                            const thresh = Math.max(0, Number((CONFIG.system as any)?.graphDeltaRebuildThreshold || 0));
                            const delta = d.amm.length;
                            if (thresh === 0 || delta >= thresh) gmod.scheduleGraphRebuild(undefined, Math.max(50, Number((CONFIG.system as any)?.graphRebuildDebounceMs || 150)));
                          }
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
                  // Trigger incremental graph apply when enabled; else schedule rebuild (debounced)
                  try {
                    const inc = !!((CONFIG.system as any)?.graphIncrementalMode);
                    const gmod: any = await import('./graph.js');
                    const prevSnap = orcaCache.data ? prev : { amm: [], clmm: [] };
                    if (inc && (d.clmm.length || d.amm.length || d.addedClmm || d.removedClmm || d.addedAmm || d.removedAmm)) {
                      await scheduleDexApply('orca', prevSnap as any);
                    } else {
                      const thresh = Math.max(0, Number((CONFIG.system as any)?.graphDeltaRebuildThreshold || 0));
                      const delta = d.amm.length + d.clmm.length + d.addedAmm + d.addedClmm + d.removedAmm + d.removedClmm;
                      if (thresh === 0 || delta >= thresh) gmod.scheduleGraphRebuild(undefined, Math.max(50, Number((CONFIG.system as any)?.graphRebuildDebounceMs || 150)));
                    }
                  } catch {}
                  ok = true;
                }
              } catch (e:any) {
                try { logger.warn('orca.ws.parse failed', { error: String(e?.message || e) }); } catch {}
              }
              // Do not fallback to HTTP refresh when user subscribed; leave updates to manual refresh
            } else if ((ownerMeteora && owner === ownerMeteora) || isMeteoraTarget) {
              try { wsCounts.meteora = (wsCounts.meteora || 0) + 1; } catch {}
              const pk58 = toB58Any(pk);
              // Try on-chain decode via Meteora DLMM SDK; fallback to HTTP refresh if unavailable
              let updated = false;
              try {
                const poolId = pk58;
                // Lazy-load DLMM module (CJS or ESM)
                let mod: any = (handle as any).__dlmmMod || null;
                if (!mod) {
                  try {
                    const mmod: any = await import('node:module');
                    const createRequire: any = (mmod && (mmod as any).createRequire) || (mmod?.default && (mmod as any).default.createRequire);
                    const req: any = createRequire ? createRequire(import.meta.url) : undefined;
                    if (req && !mod) {
                      const specs = ['@meteora-ag/dlmm','@meteora-ag/dlmm/ts-client','@meteora-ag/dlmm-sdk','@meteora-ag/dlmm-sdk-public','@meteora-ag/dlmm/dist/index.js','@meteora-ag/dlmm-sdk/dist/index.js'];
                      for (const spec of specs) { try { const m2 = req(spec); if (m2) { mod = m2; break; } } catch {} }
                    }
                  } catch {}
                  if (!mod) {
                    try {
                      const dyn = (Function('return import')()) as any;
                      const specs = ['@meteora-ag/dlmm','@meteora-ag/dlmm/ts-client','@meteora-ag/dlmm-sdk','@meteora-ag/dlmm-sdk-public','@meteora-ag/dlmm/dist/index.js','@meteora-ag/dlmm-sdk/dist/index.js'];
                      for (const spec of specs) { try { const m2 = await dyn(spec); if (m2) { mod = m2; break; } } catch {} }
                    } catch {}
                  }
                  (handle as any).__dlmmMod = mod;
                }
                const DLMM: any = mod && (mod as any).default ? (mod as any).default : (((mod as any)?.DLMM) || mod);
                if (DLMM) {
                  // Attempt multiple state accessors for robustness across SDK variants
                  const getStateFns = [
                    (DLMM as any).getLbPairState,
                    (DLMM as any).getLbPair,
                    (DLMM as any).lbPairState,
                  ].filter((f: any) => typeof f === 'function');
                  let state: any = null;
                  for (const fn of getStateFns) {
                    try { state = await fn(conn, new web3.PublicKey(poolId)); if (state) break; } catch {}
                  }
                  // Fallback: try reading minimal fields via generic accessors
                  let tokenX: string | undefined;
                  let tokenY: string | undefined;
                  let activeId: number | undefined;
                  let binStep: number | undefined;
                  try { tokenX = state?.tokenXMint?.toBase58?.() || state?.mint_x || state?.tokenXMint || state?.tokenA || undefined; } catch {}
                  try { tokenY = state?.tokenYMint?.toBase58?.() || state?.mint_y || state?.tokenYMint || state?.tokenB || undefined; } catch {}
                  try { activeId = Number(state?.activeId ?? state?.active_id); } catch {}
                  try { binStep = Number(state?.binStep ?? state?.bin_step); } catch {}
                  if (tokenX && tokenY && Number.isFinite(activeId as any) && Number.isFinite(binStep as any)) {
                    // Resolve decimals
                    let decA: number | undefined; let decB: number | undefined;
                    try { const tok = await import('../utils/tokens.js'); const a = await (tok as any).resolveMint(tokenX); const b = await (tok as any).resolveMint(tokenY); decA = Number(a?.decimals); decB = Number(b?.decimals); } catch {}
                    // Prefer reserves-based price if available; fallback to activeId/binStep
                    let price_a_per_b: number | undefined;
                    try {
                      // Try extracting reserves with multiple candidate field names
                      const rx = Number(state?.reserveX ?? state?.reserve_x ?? state?.reserve_x_amount ?? state?.tokenXBalance ?? state?.tokenBalanceX ?? 0);
                      const ry = Number(state?.reserveY ?? state?.reserve_y ?? state?.reserve_y_amount ?? state?.tokenYBalance ?? state?.tokenBalanceY ?? 0);
                      if (Number.isFinite(rx) && Number.isFinite(ry) && rx > 0 && ry > 0 && Number.isFinite(decA as any) && Number.isFinite(decB as any)) {
                        const wholeA = rx / Math.pow(10, decA as number);
                        const wholeB = ry / Math.pow(10, decB as number);
                        if (wholeA > 0 && wholeB > 0) price_a_per_b = wholeA / wholeB;
                      }
                    } catch {}
                    try {
                      if (!(price_a_per_b && price_a_per_b > 0) && Number.isFinite(decA as any) && Number.isFinite(decB as any)) {
                        const f = Math.pow(1.0001, binStep as number);
                        if (f > 0) {
                          const bPerA = Math.pow(f, activeId as number) * Math.pow(10, (decA as number) - (decB as number));
                          const cand = [bPerA > 0 ? (1 / bPerA) : 0, bPerA].filter(v => Number.isFinite(v) && v > 0);
                          price_a_per_b = cand[0];
                        }
                      }
                    } catch {}

                    // Subscribe bin-array accounts to capture reserve changes within active bin
                    try {
                      const poolPk = new web3.PublicKey(poolId);
                      let metas: any[] | undefined;
                      const getBounds = (DLMM as any)?.getBinArrayLowerUpperBinId;
                      const getMetas = (DLMM as any)?.getBinArrayAccountMetasCoverage || (DLMM as any)?.getBinArrayKeysCoverage;
                      if (getBounds && getMetas) {
                        const bnjs = await import('bn.js').catch(() => null as any);
                        const BN = (bnjs && (bnjs as any).default) ? (bnjs as any).default : (bnjs as any);
                        const bounds = await getBounds(conn, poolPk).catch(() => null as any);
                        const toNum = (v: any): number => { try { if (v && typeof v.toNumber === 'function') return v.toNumber(); const s = (v && typeof v.toString === 'function') ? v.toString() : String(v); const n = Number(s); return Number.isFinite(n) ? n : NaN; } catch { return NaN; } };
                        const loNum = toNum(bounds?.lowerBinId);
                        const hiNum = toNum(bounds?.upperBinId);
                        if (BN && Number.isFinite(loNum) && Number.isFinite(hiNum)) {
                          try {
                            metas = getMetas.length === 3
                              ? getMetas(new BN(String(loNum)), new BN(String(hiNum)), poolPk)
                              : await getMetas(conn, new web3.PublicKey((CONFIG as any)?.meteora?.programId), poolPk).catch(() => null as any);
                          } catch {}
                        }
                      }
                      const keys: string[] = Array.isArray(metas)
                        ? metas.map((m: any) => (m?.pubkey?.toBase58?.() || m?.pubkey || m?.pubKey || m?.address)).filter(Boolean)
                        : [];
                      for (const k of keys) {
                        try {
                          if (targetedSourceByAccount.has(k)) continue;
                          const vpk = new web3.PublicKey(k);
                          const id = await subscribeAccountWithRetry(vpk, handle);
                          subs.push({ kind: 'account', id });
                          targetedSourceByAccount.set(k, 'meteora');
                        } catch {}
                      }
                    } catch {}
                    // Upsert minimal item
                    const prev = meteoraCache.data || { amm: [], clmm: [] };
                    const next: PoolsPayload = { amm: prev.amm.slice(), clmm: prev.clmm.slice() } as any;
                    const idx = next.clmm.findIndex(p => p.id === poolId);
                    const item: ClmmPool = {
                      id: poolId,
                      dex: 'Meteora',
                      mint_a: tokenX,
                      mint_b: tokenY,
                      fee_bps: 0,
                      sqrt_price_x64: 0,
                      liquidity: 0,
                      tick_spacing: Number.isFinite(binStep as any) ? (binStep as number) : 0,
                      updated_ms: Date.now(),
                      price_a_per_b: (price_a_per_b && price_a_per_b > 0) ? price_a_per_b : undefined,
                      pool_kind: 'clmm',
                    } as any;
                    if (idx >= 0) next.clmm[idx] = { ...next.clmm[idx], ...item }; else next.clmm.push(item);
                    const d = diffNormalizedPools(prev, next);
                    meteoraCache.data = next; meteoraCache.ts = Date.now();
                    try { emit('pool-updates', { source: 'meteora', updatedAmm: d.amm.length, updatedClmm: d.clmm.length, sample: { amm: [], clmm: d.clmm.slice(0, 20) }, ts: Date.now() }); } catch {}
                    // Apply incrementally and push to arb-rs
                    try {
                      const gmod: any = await import('./graph.js');
                      const hasDelta = (d.amm.length || d.clmm.length || d.addedAmm || d.removedAmm || d.addedClmm || d.removedClmm);
                      if (hasDelta) {
                        await scheduleDexApply('meteora', prev as any);
                      }
                    } catch {}
                    updated = true;
                  }
                }
              } catch {}
              if (!updated) {
                // Fallback: debounced HTTP refresh
                const minGap = Number((CONFIG.system as any)?.poolRefreshMinGapMs || 3000);
                const last = (getMeteoraPoolsCached as any).__lastForceAt || 0;
                const nowMs = Date.now();
                if (nowMs - last >= minGap) {
                  (getMeteoraPoolsCached as any).__lastForceAt = nowMs;
                  getMeteoraPoolsCached(true).catch(() => {});
                }
              }
              return;
            } else if (pk) {
              // Fallback: if account belongs to any known program, refresh both
              // Disabled while subscribed
            }
          } catch {}
        };
        // Helper: subscribe with retry/backoff to avoid calling while WS is closing
        const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
        const subscribeAccountWithRetry = async (accountPk: any, cb: (pk: any, info: any) => void): Promise<number> => {
          const maxAttempts = Math.max(1, Number(((CONFIG.system as any)?.wsSubscribeMaxAttempts) || 10));
          const baseBackoffMs = Math.max(50, Number(((CONFIG.system as any)?.wsSubscribeBackoffMs) || 250));
          let attempt = 0;
          // Probe internal readyState if available to avoid subscribing during CLOSING/CLOSED
          const waitUntilWsReady = async () => {
            try {
              const deadline = Date.now() + Math.max(500, Number(((CONFIG.system as any)?.wsReadyWaitMs) || 3000));
              for (;;) {
                let ws = (conn as any)?._rpcWebSocket?._ws;
                let rs = Number(ws?.readyState);
                // 0 CONNECTING, 1 OPEN, 2 CLOSING, 3 CLOSED
                if (!ws || rs === 3) {
                  try { await (conn as any)?._rpcWebSocket?.connect?.(); } catch {}
                  // brief delay and re-check
                  await sleep(100);
                  ws = (conn as any)?._rpcWebSocket?._ws;
                  rs = Number(ws?.readyState);
                }
                if (rs === 0 || rs === 1) return; // CONNECTING or OPEN is acceptable
                if (Date.now() >= deadline) return;
                await sleep(150);
              }
            } catch {}
          };
          // Attempt loop
          for (;;) {
            await waitUntilWsReady();
            try {
              const id = await conn.onAccountChange(accountPk, (info: any) => { try { cb(accountPk, info); } catch {} });
              return id as unknown as number;
            } catch (e: any) {
              const msg = String(e?.message || e);
              const isWsState = msg.includes('socket was not') || msg.includes('readyState');
              attempt += 1;
              if (!isWsState || attempt >= maxAttempts) {
                // Give up on non-WS errors or after exhausting retries
                throw e;
              }
              const delay = Math.min(5000, Math.floor(baseBackoffMs * Math.pow(1.5, attempt - 1)));
              try { logger.debug('pools.ws subscribe retry(account)', { attempt, delayMs: delay }); } catch {}
              await sleep(delay);
            }
          }
        };
        const subscribeProgramWithRetry = async (programPk: any, cb: (ch: any) => void): Promise<number> => {
          const maxAttempts = Math.max(1, Number(((CONFIG.system as any)?.wsSubscribeMaxAttempts) || 10));
          const baseBackoffMs = Math.max(50, Number(((CONFIG.system as any)?.wsSubscribeBackoffMs) || 250));
          let attempt = 0;
          const waitUntilWsReady = async () => {
            try {
              const deadline = Date.now() + Math.max(500, Number(((CONFIG.system as any)?.wsReadyWaitMs) || 3000));
              for (;;) {
                let ws = (conn as any)?._rpcWebSocket?._ws;
                let rs = Number(ws?.readyState);
                if (!ws || rs === 3) {
                  try { await (conn as any)?._rpcWebSocket?.connect?.(); } catch {}
                  await sleep(100);
                  ws = (conn as any)?._rpcWebSocket?._ws;
                  rs = Number(ws?.readyState);
                }
                if (rs === 0 || rs === 1) return;
                if (Date.now() >= deadline) return;
                await sleep(150);
              }
            } catch {}
          };
          for (;;) {
            await waitUntilWsReady();
            try {
              const id = await conn.onProgramAccountChange(programPk, (ch: any) => { try { cb(ch); } catch {} });
              return id as unknown as number;
            } catch (e: any) {
              const msg = String(e?.message || e);
              const isWsState = msg.includes('socket was not') || msg.includes('readyState');
              attempt += 1;
              if (!isWsState || attempt >= maxAttempts) {
                throw e;
              }
              const delay = Math.min(5000, Math.floor(baseBackoffMs * Math.pow(1.5, attempt - 1)));
              try { logger.debug('pools.ws subscribe retry(program)', { attempt, delayMs: delay }); } catch {}
              await sleep(delay);
            }
          }
        };
        // Debounced per-DEX apply: coalesce multiple WS updates into a single apply+push
        const wsApply: Record<'raydium'|'orca'|'meteora', { timer: NodeJS.Timeout | null; baseline: any | null }> = {
          raydium: { timer: null, baseline: null },
          orca: { timer: null, baseline: null },
          meteora: { timer: null, baseline: null },
        };
        const WS_APPLY_DEBOUNCE_MS = Math.max(10, Number(((CONFIG.system as any)?.wsApplyDebounceMs) || 75));
        const getCurrentCache = (dex: 'raydium'|'orca'|'meteora'): any => {
          if (dex === 'raydium') return raydiumCache.data || { amm: [], clmm: [] };
          if (dex === 'orca') return orcaCache.data || { amm: [], clmm: [] };
          return meteoraCache.data || { amm: [], clmm: [] };
        };
        async function scheduleDexApply(dex: 'raydium'|'orca'|'meteora', baseline: any): Promise<void> {
          try {
            if (!wsApply[dex].baseline) wsApply[dex].baseline = baseline;
            if (wsApply[dex].timer) return;
            wsApply[dex].timer = setTimeout(async () => {
              const base = wsApply[dex].baseline; wsApply[dex].baseline = null; wsApply[dex].timer = null;
              if (!base) return;
              try {
                const gmod: any = await import('./graph.js');
                const cur = getCurrentCache(dex);
                if (typeof gmod.applyPoolUpdates === 'function') {
                  await gmod.applyPoolUpdates(base, cur, { pushToArb: true });
                }
              } catch {}
            }, WS_APPLY_DEBOUNCE_MS);
          } catch {}
        }
        // Helper: attach Raydium AMM vault (token) accounts for a given AMM pool address
        const attachRaydiumAmmVaults = async (poolAddr: string) => {
          try {
            const pk = new web3.PublicKey(poolAddr);
            const { withRpcLimit } = await import('../utils/rpcLimiter.js');
            const acc: any = await withRpcLimit(() => conn.getAccountInfo(pk, CONFIG.system.txCommitment as any));
            if (!acc || !acc.data) return;
            const rmod: any = await import('@raydium-io/raydium-sdk-v2').catch(() => null);
            const ammLayout = rmod?.LiquidityStateLayoutV4 || rmod?.LIQUIDITY_STATE_LAYOUT_V4;
            if (!ammLayout || typeof ammLayout.decode !== 'function') return;
            let state: any = null;
            try { state = ammLayout.decode((acc as any).data); } catch { state = null; }
            const vA = state?.baseVault?.toBase58?.() || state?.vaultA?.toBase58?.();
            const vB = state?.quoteVault?.toBase58?.() || state?.vaultB?.toBase58?.();
            const vaults = Array.from(new Set([vA, vB].filter(Boolean)));
            for (const v of vaults) {
              try {
                const vpk = new web3.PublicKey(v as string);
                const id = await subscribeAccountWithRetry(vpk, handle);
                subs.push({ kind: 'account', id });
                targetedSourceByAccount.set(String(v), 'raydium');
              } catch {}
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
              const dex = String((e as any)?.dex || '');
              if (dex !== 'Orca') continue;
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
          // Rate-limit new attachments per second based on config
          const perSec = Math.max(1, Number(((CONFIG.system as any)?.wsAttachPerSec) || 10));
          const intervalMs = Math.floor(1000 / perSec);
          const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
          for (let i = 0; i < uniq.length; i++) {
            const addr = uniq[i];
            try {
              const pk = new PublicKey(addr);
              const id = await subscribeAccountWithRetry(pk, handle);
              subs.push({ kind: 'account', id }); attached++;
              try { targetedSourceByAccount.set(pk.toBase58(), 'orca'); } catch {}
            } catch {}
            if (i < uniq.length - 1 && intervalMs > 0) { await sleep(intervalMs); }
          }
          attachedOrcaPools = attached;
          logger.info('pools.ws subscribe orca.pools', { attached, target: uniq.length, source: 'orca' });
          // Subscribe at program level only if we had no targeted addresses and explicit fallback is allowed
          if (attached === 0 && !!((CONFIG.system as any)?.wsFallbackPrograms) && ((CONFIG.system as any)?.wsFallbackAllowZeroTargets === true)) {
            try { logger.info('pools.ws subscribe orca(program)', { source: 'orca', cat: 'pools' }); } catch {}
            {
              const id = await subscribeProgramWithRetry(orcaProg, (ch: any) => handle(ch.accountId, ch.accountInfo));
              subs.push({ kind: 'program', id });
            }
          }
        } catch (e:any) {
          logger.warn('pools.ws orca address subscribe failed', { error: String(e?.message || e) });
          // Fallback to program-level subscription (may include non-pool accounts) only when explicitly allowed
          if (!!((CONFIG.system as any)?.wsFallbackPrograms) && ((CONFIG.system as any)?.wsFallbackAllowZeroTargets === true)) {
            try { logger.info('pools.ws subscribe orca(fallback)', { source: 'orca', cat: 'pools' }); } catch {}
            {
              const id = await subscribeProgramWithRetry(orcaProg, (ch: any) => handle(ch.accountId, ch.accountInfo));
              subs.push({ kind: 'program', id });
            }
          }
        }
        // Raydium address-level subscriptions when we have known pool ids (from prior refresh)
        try {
          // Prefer graph edge pool ids if available
          const edgePoolIds = new Set<string>();
          try {
            const gmod: any = await import('./graph.js');
            const snap = await gmod.getGraphSnapshot(false);
            for (const e of (snap?.edges || [])) {
              const dex = String((e as any)?.dex || '');
              if (dex !== 'Raydium') continue;
              const pid = String((e as any)?.pool_id || '');
              if (pid) edgePoolIds.add(pid.replace(/-rev$/,''));
            }
            try { logger.info('pools.ws targets.raydium from graph', { size: edgePoolIds.size }); } catch {}
          } catch {}
          const rayKnown: string[] = [];
          try { for (const p of (raydiumCache.data?.amm || [])) if (p?.id) rayKnown.push(String(p.id)); } catch {}
          try { for (const p of (raydiumCache.data?.clmm || [])) if (p?.id) rayKnown.push(String(p.id)); } catch {}
          const base = edgePoolIds.size > 0 ? Array.from(edgePoolIds) : rayKnown;
          const uniqueRay = Array.from(new Set(base.filter(Boolean)));
          let attachedRay = 0;
          // Rate-limit new attachments per second based on config
          const perSecRay = Math.max(1, Number(((CONFIG.system as any)?.wsAttachPerSec) || 10));
          const intervalMsRay = Math.floor(1000 / perSecRay);
          const sleepRay = (ms: number) => new Promise(r => setTimeout(r, ms));
          for (let i = 0; i < uniqueRay.length; i++) {
            const addr = uniqueRay[i];
            try {
              const pk = new web3.PublicKey(addr);
              const id = await subscribeAccountWithRetry(pk, handle);
              subs.push({ kind: 'account', id }); attachedRay++;
              try { targetedSourceByAccount.set(pk.toBase58(), 'raydium'); } catch {}
              // Opportunistically attach AMM vault listeners for AMM pools
              // Safe to call for any Raydium pool; function is a no-op for CLMM layouts
              attachRaydiumAmmVaults(addr).catch(() => {});
            } catch {}
            if (i < uniqueRay.length - 1 && intervalMsRay > 0) { await sleepRay(intervalMsRay); }
          }
          attachedRaydiumPools = attachedRay;
          logger.info('pools.ws subscribe raydium.pools', { attached: attachedRay, target: uniqueRay.length });
          // Fallback to program-level if none attached and explicit fallback is allowed
          if (attachedRay === 0 && !!((CONFIG.system as any)?.wsFallbackPrograms) && ((CONFIG.system as any)?.wsFallbackAllowZeroTargets === true)) {
            try { logger.info('pools.ws subscribe raydium.amm(fallback)', { source: 'raydium', cat: 'pools' }); } catch {}
            {
              const idA = await subscribeProgramWithRetry(rayAmm, (ch: any) => handle(ch.accountId, ch.accountInfo));
              subs.push({ kind: 'program', id: idA });
            }
            try { logger.info('pools.ws subscribe raydium.clmm(fallback)', { source: 'raydium', cat: 'pools' }); } catch {}
            {
              const idC = await subscribeProgramWithRetry(rayClmm, (ch: any) => handle(ch.accountId, ch.accountInfo));
              subs.push({ kind: 'program', id: idC });
            }
          }
        } catch {}
        // Meteora targeted subscriptions from graph edges. If none yet, retry briefly for targets; fallback to program-level when configured.
        try {
          const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
          const attachMeteora = async (): Promise<number> => {
            let attached = 0;
            const edgeIds: string[] = Array.from(meteoraTargets);
            // Rate-limit new attachments per second based on config
            const perSecMet = Math.max(1, Number(((CONFIG.system as any)?.wsAttachPerSec) || 10));
            const intervalMsMet = Math.floor(1000 / perSecMet);
            const sleepMet = (ms: number) => new Promise(r => setTimeout(r, ms));
            for (let i = 0; i < edgeIds.length; i++) {
              const addr = edgeIds[i];
              try {
                const pk = new web3.PublicKey(addr);
                const id = await subscribeAccountWithRetry(pk, handle);
                subs.push({ kind: 'account', id }); attached++;
                try { targetedSourceByAccount.set(pk.toBase58(), 'meteora'); } catch {}
              } catch {}
              if (i < edgeIds.length - 1 && intervalMsMet > 0) { await sleepMet(intervalMsMet); }
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
            try { logger.info('pools.ws subscribe meteora.pools', { attached: attachedMet, target: meteoraTargets.size, source: 'meteora' }); } catch {}
          } else {
            // Program-level fallback when configured
            const meteoraProg = String((CONFIG as any)?.meteora?.programId || '').trim();
            if (meteoraProg && !!((CONFIG.system as any)?.meteoraWsProgramFallback)) {
              try { logger.info('pools.ws subscribe meteora(program)', { source: 'meteora', cat: 'pools' }); } catch {}
              {
                const id = await subscribeProgramWithRetry(new web3.PublicKey(meteoraProg), (ch: any) => handle(ch.accountId, ch.accountInfo));
                subs.push({ kind: 'program', id });
              }
              attachedMeteoraPools = 1;
            }
          }
        } catch (e:any) {
          logger.warn('pools.ws meteora subscribe failed', { error: String(e?.message || e) });
          attachedMeteoraPools = 0;
        }

        wsUnsubscribe = () => {
          try {
            // Begin async teardown and websocket close; future setups will await wsClosePromise
            wsClosePromise = (async () => {
              try {
                // Best-effort await listener removals, but avoid calling into RPC when WS is CLOSING/CLOSED
                const removals: Array<Promise<any>> = [];
                const wsAny = (wsConn as any)?._rpcWebSocket?._ws;
                const ready: number = Number(wsAny?.readyState);
                const canRpc = (ready === 0 || ready === 1); // CONNECTING or OPEN
                for (const s of subs) {
                  try {
                    if (!canRpc) continue;
                    if (s.kind === 'account') {
                      removals.push((conn as any).removeAccountChangeListener(s.id).catch(() => {}));
                    } else {
                      removals.push((conn as any).removeProgramAccountChangeListener(s.id).catch(() => {}));
                    }
                  } catch {}
                }
                if (canRpc && removals.length) {
                  try { await Promise.allSettled(removals); } catch {}
                }
                // Close underlying websocket if present to avoid CLOSING race on next subscribe
                try {
                  const wsAny2 = (wsConn as any)?._rpcWebSocket?._ws;
                  const rs: number | undefined = Number(wsAny2?.readyState);
                  // 0 CONNECTING, 1 OPEN, 2 CLOSING
                  if (wsAny2 && (rs === 0 || rs === 1 || rs === 2)) {
                    try { (wsConn as any)?._rpcWebSocket?.close?.(); } catch {}
                  }
                  // Wait until CLOSED (3) or socket disappears, with small timeout
                  const deadline = Date.now() + Math.max(500, Number(((CONFIG.system as any)?.wsCloseWaitMs) || 2000));
                  let cur = Number(wsAny2?.readyState);
                  while (wsAny2 && cur !== 3 && Date.now() < deadline) {
                    await new Promise(r => setTimeout(r, 100));
                    cur = Number(wsAny2?.readyState);
                  }
                } catch {}
              } finally {
                try { wsConn = undefined; } catch {}
              }
            })();
            // Detach immediately; actual close will be awaited by the next setup
            wsClosePromise?.catch(() => {});
          } catch {}
        };
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
            try {
              const lastTgts: any = (getWsTargets as any)?._last || {};
              emit('log', { level: 'debug', message: `pools:ws aggregate ray=${snapshot.raydium} orc=${snapshot.orca} met=${snapshot.meteora} | attach/tgt ray=${attachedRaydiumPools}/${lastTgts?.raydium?.target ?? 'n/a'} orc=${attachedOrcaPools}/${lastTgts?.orca?.target ?? 'n/a'} met=${attachedMeteoraPools}/${lastTgts?.meteora?.target ?? 'n/a'}`, timestamp: new Date().toISOString(), context: { cat: 'pools' } });
            } catch {}
            // Reconcile targets vs attached (debounced): if attached << targets, trigger retarget
            (async () => {
              try {
                const tgt = await getWsTargets();
                const needRay = Math.max(0, (tgt.raydium.target || 0) - (attachedRaydiumPools || 0));
                const needOrc = Math.max(0, (tgt.orca.target || 0) - (attachedOrcaPools || 0));
                const needMet = Math.max(0, (tgt.meteora.target || 0) - (attachedMeteoraPools || 0));
                const sumNeed = needRay + needOrc + needMet;
                // Also retarget if significantly over target (shed excess subs)
                const lastTgts: any = (getWsTargets as any)?._last || {};
                const tgtRay = Math.max(0, Number(lastTgts?.raydium?.target || 0));
                const tgtOrc = Math.max(0, Number(lastTgts?.orca?.target || 0));
                const tgtMet = Math.max(0, Number(lastTgts?.meteora?.target || 0));
                const overRay = (tgtRay > 0) && (attachedRaydiumPools || 0) > Math.floor(tgtRay * 1.5);
                const overOrc = (tgtOrc > 0) && (attachedOrcaPools || 0) > Math.floor(tgtOrc * 1.5);
                const overMet = (tgtMet > 0) && (attachedMeteoraPools || 0) > Math.floor(tgtMet * 1.5);
                if (sumNeed > 0 || overRay || overOrc || overMet) {
                  const last = (reconcileNow as any)._last || 0;
                  if (Date.now() - last > 5000) { await reconcileNow(); }
                }
              } catch {}
            })();
          } catch {}
        }, aggPeriod);
      };
      setup()
        .catch((e: any) => logger.warn('pools.ws setup failed', { error: String(e?.message || e) }))
        .finally(() => { wsSetupActive = false; });
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
export function peekMeteoraBalancedPools(): PoolsPayload { return metbalCache.data || { amm: [], clmm: [] }; }


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
      // Use union of v2+v1 (prefer v2) when available
      const union = await fetchMeteoraBalancedAllImpl().catch(async () => {
        const raw = await fetchMeteoraBalancedHttpImpl();
        return await normalizeMeteoraBalancedHttpImpl(raw);
      });
      const norm = union;
      const prev = metbalCache.data;
      metbalCache.data = norm; metbalCache.ts = Date.now();
      poolsMetrics.meteora_balanced.fetches = (poolsMetrics.meteora_balanced.fetches || 0) + 1;
      poolsMetrics.meteora_balanced.lastMs = Date.now() - t0;
      poolsMetrics.meteora_balanced.lastAmm = (norm.amm || []).length;
      try {
        const d = diffNormalizedPools(prev || { amm: [], clmm: [] }, norm);
        emit('pools-update', { source: 'meteora_balanced', amm: (norm.amm || []).length, clmm: 0, ts: Date.now() });
        emit('pool-updates', { source: 'meteora_balanced', updatedAmm: d.amm.length, updatedClmm: d.clmm.length, addedAmm: d.addedAmm, removedAmm: d.removedAmm, addedClmm: d.addedClmm, removedClmm: d.removedClmm, sample: { amm: d.amm.slice(0, 50), clmm: [] }, ts: Date.now() });
        const inc = !!((CONFIG.system as any)?.graphIncrementalMode);
        const hasDelta = d.amm.length || d.clmm.length || d.addedAmm || d.removedAmm || d.addedClmm || d.removedClmm;
        try {
          const gmod: any = await import('./graph.js');
          if (inc && hasDelta && typeof gmod.applyPoolUpdates === 'function') {
            await gmod.applyPoolUpdates(prev || { amm: [], clmm: [] }, norm, { pushToArb: true });
          }
        } catch {}
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
      // Emit fine-grained pool-updates (deltas) and prefer incremental graph apply when enabled
      try {
        const d = diffNormalizedPools(prev || { amm: [], clmm: [] }, norm);
        const sample = { amm: d.amm.slice(0, 100), clmm: d.clmm.slice(0, 100) };
        emit('pool-updates', { source: 'raydium', updatedAmm: d.amm.length, updatedClmm: d.clmm.length, addedAmm: d.addedAmm, removedAmm: d.removedAmm, addedClmm: d.addedClmm, removedClmm: d.removedClmm, sample, ts: Date.now(), canon: (CONFIG.system as any)?.canonicalizePairs || 'none' });
        const inc = !!((CONFIG.system as any)?.graphIncrementalMode);
        const hasDelta = d.amm.length || d.clmm.length || d.addedAmm || d.removedAmm || d.addedClmm || d.removedClmm;
        try {
          const gmod: any = await import('./graph.js');
          if (inc && hasDelta && typeof gmod.applyPoolUpdates === 'function') {
            await gmod.applyPoolUpdates(prev || { amm: [], clmm: [] }, norm, { pushToArb: true });
          } else {
            const thresh = Math.max(0, Number((CONFIG.system as any)?.graphDeltaRebuildThreshold || 0));
            const delta = d.amm.length + d.clmm.length + d.addedAmm + d.addedClmm + d.removedAmm + d.removedClmm;
            if (thresh === 0 || delta >= thresh) gmod.scheduleGraphRebuild(undefined, Math.max(50, Number((CONFIG.system as any)?.graphRebuildDebounceMs || 150)));
          }
        } catch {}
        try { logger.info('pools.delta raydium', { updatedAmm: d.amm.length, updatedClmm: d.clmm.length, addedAmm: d.addedAmm, removedAmm: d.removedAmm, addedClmm: d.addedClmm, removedClmm: d.removedClmm, cat: 'pools' }); } catch {}
      } catch {}
      // Cross-DEX validation: Compare prices across all DEXes
      try {
        const allPools = {
          raydium: raydiumCache.data || { amm: [], clmm: [] },
          orca: orcaCache.data || { amm: [], clmm: [] },
          meteora: meteoraCache.data || { amm: [], clmm: [] }
        };
        validateCrossDexPrices(allPools);
      } catch {}
      // Opportunistic price warmup (anchors + top-N pool mints) after first source completes
      try {
        const sys: any = (CONFIG as any)?.system || {};
        const enable = sys.warmPricesOnStart !== false;
        if (enable && !(refreshAllSources as any).__didWarmPricesOnce) {
          const topN = Math.max(10, Number(sys.priceWarmTopN || 200));
          const collect = (pp: { amm: any[]; clmm: any[] }) => {
            const arr = [...(pp.amm || []), ...(pp.clmm || [])];
            return arr.map(p => ({
              mints: [String(p.mint_a || ''), String(p.mint_b || '')],
              tvl: Number((p as any)?.tvl_usd ?? (p as any)?.liquidity_display ?? 0)
            }));
          };
          const items = [
            ...collect(raydiumCache.data || { amm: [], clmm: [] }),
            ...collect(orcaCache.data || { amm: [], clmm: [] }),
            ...collect(meteoraCache.data || { amm: [], clmm: [] }),
            ...collect(metbalCache.data || { amm: [], clmm: [] }),
          ];
          const ranked = items.sort((a,b) => (b.tvl || 0) - (a.tvl || 0)).slice(0, topN);
          const set = new Set<string>();
          for (const it of ranked) { for (const m of (it.mints || [])) if (m) set.add(m); }
          // Always include anchors
          set.add('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
          set.add('So11111111111111111111111111111111111111112');
          const ids = Array.from(set);
          if (ids.length) {
            const { fetchPricesByMints } = await import('../jupiter/jupiter.js');
            const fresh = await fetchPricesByMints(ids, { catOverride: 'priceWarm', ignorePause: true });
            const priceStore = await import('./priceStore.js');
            priceStore.setPrices(fresh as any);
            (refreshAllSources as any).__didWarmPricesOnce = true;
          }
        }
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
      // Emit fine-grained pool-updates (deltas) and prefer incremental graph apply when enabled
      try {
        const d = diffNormalizedPools(prev || { amm: [], clmm: [] }, data);
        const sample = { amm: d.amm.slice(0, 100), clmm: d.clmm.slice(0, 100) };
        emit('pool-updates', { source: 'orca', updatedAmm: d.amm.length, updatedClmm: d.clmm.length, addedAmm: d.addedAmm, removedAmm: d.removedAmm, addedClmm: d.addedClmm, removedClmm: d.removedClmm, sample, ts: Date.now(), canon: (CONFIG.system as any)?.canonicalizePairs || 'none' });
        try { logger.debug('pools.delta orca', { updatedAmm: d.amm.length, updatedClmm: d.clmm.length, addedAmm: d.addedAmm, removedAmm: d.removedAmm, addedClmm: d.addedClmm, removedClmm: d.removedClmm, cat: 'pools' }); } catch {}
        const inc = !!((CONFIG.system as any)?.graphIncrementalMode);
        const hasDelta = d.amm.length || d.clmm.length || d.addedAmm || d.removedAmm || d.addedClmm || d.removedClmm;
        try {
          const gmod: any = await import('./graph.js');
          if (inc && hasDelta && typeof gmod.applyPoolUpdates === 'function') {
            await gmod.applyPoolUpdates(prev || { amm: [], clmm: [] }, data);
          } else {
            const thresh = Math.max(0, Number((CONFIG.system as any)?.graphDeltaRebuildThreshold || 0));
            const delta = d.amm.length + d.clmm.length + d.addedAmm + d.addedClmm + d.removedAmm + d.removedClmm;
            if (thresh === 0 || delta >= thresh) gmod.scheduleGraphRebuild(undefined, Math.max(50, Number((CONFIG.system as any)?.graphRebuildDebounceMs || 150)));
          }
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
        const inc = !!((CONFIG.system as any)?.graphIncrementalMode);
        const hasDelta = d.amm.length || d.clmm.length || d.addedAmm || d.removedAmm || d.addedClmm || d.removedClmm;
        try {
          const gmod: any = await import('./graph.js');
          if (inc && hasDelta && typeof gmod.applyPoolUpdates === 'function') {
            await gmod.applyPoolUpdates(prev || { amm: [], clmm: [] }, norm);
          }
        } catch {}
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
 


