import { logger } from '../utils/logger.js';
import { emit } from './realtime.js';
import { CONFIG } from '../utils/config.js';
import { readJson } from '../utils/fs.js';
// Defer web3 imports to runtime to prevent type issues in environments without types
// import { PublicKey } from '@solana/web3.js';

type AmmPool = {
  id: string;
  dex: string;
  mint_a: string;
  mint_b: string;
  fee_bps: number;
  price_a_per_b: number;
  liquidity_base: number;
  updated_ms: number;
  // Optional vault accounts corresponding to mint_a and mint_b
  account_a?: string;
  account_b?: string;
  pool_kind?: 'amm';
  amount_a_whole?: number;
  amount_b_whole?: number;
  amounts_are_whole?: boolean;
  tvl_usd?: number;
  // Enrichments when known
  decimals_a?: number;
  decimals_b?: number;
  pool_liquidity_raw?: number; // min(amount_a_whole, amount_b_whole) when available
  liquidity_display?: number;  // prefer pool_liquidity_raw for display when available
};

type ClmmPool = {
  id: string;
  dex: string;
  mint_a: string;
  mint_b: string;
  fee_bps: number;
  sqrt_price_x64: number;
  liquidity: number;
  tick_spacing: number;
  updated_ms: number;
  // Optional enrichments for coherence across DEX feeds
  price_a_per_b?: number;
  amount_a?: number;
  amount_b?: number;
  decimals_a?: number;
  decimals_b?: number;
  // Optional token vault accounts for CLMM pool
  account_a?: string;
  account_b?: string;
  pool_kind?: 'clmm';
  pool_liquidity_raw?: number;
  tvl_usd?: number;
  amount_a_whole?: number;
  amount_b_whole?: number;
  liquidity_display?: number;  // prefer pool_liquidity_raw for display when available
};

type PoolsPayload = { amm: AmmPool[]; clmm: ClmmPool[] };

const raydiumCache: { data: PoolsPayload | null; ts: number; inflight?: Promise<PoolsPayload> } = { data: null, ts: 0 };
const orcaCache: { data: PoolsPayload | null; ts: number; inflight?: Promise<PoolsPayload> } = { data: null, ts: 0 };
const meteoraCache: { data: PoolsPayload | null; ts: number; inflight?: Promise<PoolsPayload> } = { data: null, ts: 0 };

// WS lifecycle flags: defer websocket subscriptions until graph signals readiness
let wsAllowed: boolean = false;
let wsSetupActive: boolean = false;
let targetedWsActive: boolean = false;

function toB58Any(v: any): string {
  try { if (v && typeof v.toBase58 === 'function') return String(v.toBase58()); } catch {}
  try { const s = v?.toString?.(); if (typeof s === 'string') { const m = /^PublicKey\(([^)]+)\)$/.exec(s); return m ? m[1] : s; } } catch {}
  return typeof v === 'string' ? v : '';
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
} = {
  raydium: {
    fetches: 0, lastMs: 0, lastAmm: 0, lastClmm: 0,
    filteredAmm: 0, filteredClmm: 0, universe: '', zeroOverlapSkips: 0,
    scannedPoolAccs: 0, updatedFromPoolAccs: 0, scannedVaults: 0, updatedFromVaults: 0,
    ownerClmmCount: 0, ownerAmmCount: 0, http429: 0, backoffMs: 0, apiBatches: 0, apiBatchSizeAvg: 0,
  },
  orca: { fetches: 0, lastMs: 0, lastAmm: 0, lastClmm: 0 },
  meteora: { fetches: 0, lastMs: 0, lastClmm: 0 },
};

export function getPoolsMetrics(): any {
  return poolsMetrics;
}

// Removed raw on-chain scan: use SDK-only discovery to avoid brittle binary parsing
let rayProbeOffset = 0; // rolling offset for rotating mint probes across cycles
async function fetchRaydiumPoolsRaw(): Promise<any> {
  const mode = 'http';
  try {
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
    const fetchFn: any = (globalThis as any).fetch;
    if (!fetchFn) {
      logger.warn('raydium.http fetch unavailable on this runtime');
      return { data: [] };
    }

    // Collect mint universe from configured tokenUniverseMode; fallback to previous heuristics
    let mints: string[] = [];
    try {
      const { computeTokenUniverse } = await import('./universe.js');
      const uni = await computeTokenUniverse((CONFIG.system as any)?.tokenUniverseMode);
      mints = Array.from(uni);
    } catch {}
    if (!mints.length) {
      try {
        const { loadJupiterTokenMap } = await import('../utils/tokens.js');
        const jmap = await loadJupiterTokenMap();
        mints = Object.keys(jmap || {});
      } catch {}
    }
    if (!mints.length) {
      try {
        const orca = await getOrcaPoolsCached(false);
        const set = new Set<string>();
        for (const p of (orca?.amm || [])) { if (p?.mint_a) set.add(p.mint_a); if (p?.mint_b) set.add(p.mint_b); }
        for (const p of (orca?.clmm || [])) { if (p?.mint_a) set.add(p.mint_a); if (p?.mint_b) set.add(p.mint_b); }
        mints = Array.from(set);
      } catch {}
    }
    if (!mints.length) {
      const wl = await readJson<any[]>(CONFIG.watchlistPath, []);
      mints = wl.map((t: any) => (typeof t === 'string' ? t : t?.id)).filter(Boolean);
    }

    const limit = Math.max(1, Number(CONFIG.raydium?.sdkProbeMintsLimit || 50));
    const uniqAll = Array.from(new Set(mints));
    // Rotate window across full set to ensure full coverage over time
    const start = uniqAll.length > 0 ? (rayProbeOffset % uniqAll.length) : 0;
    const end = start + limit;
    const uniq = uniqAll.length <= limit
      ? uniqAll
      : (end <= uniqAll.length
          ? uniqAll.slice(start, end)
          : uniqAll.slice(start).concat(uniqAll.slice(0, end - uniqAll.length)));
    rayProbeOffset = (start + limit) % Math.max(uniqAll.length, 1);

    const baseUrl = 'https://api-v3.raydium.io/pools/info/mint';
    const pageSize = Math.max(20, Number((CONFIG.raydium as any)?.httpPageSize || 50));
    const maxPagesPerMint = Math.max(1, Number((CONFIG.raydium as any)?.httpMaxPagesPerMint || 2));
    const concurrency = Math.max(1, Math.min(3, Number(CONFIG.raydium?.sdkConcurrency || 8)));

    const collected: any[] = [];
    const queue: Array<() => Promise<void>> = [];

    for (const mint of uniq) {
      queue.push(async () => {
        let page = 1;
        let hasNext = true;
        let pagesFetched = 0;
        while (hasNext && pagesFetched < maxPagesPerMint) {
          try {
            if (poolsMetrics.raydium.backoffMs > 0) await sleep(poolsMetrics.raydium.backoffMs); else await sleep(150 + Math.floor(Math.random() * 150));
            const qs = new URLSearchParams({
              mint1: mint,
              poolType: 'all',
              poolSortField: 'liquidity',
              sortType: 'desc',
              pageSize: String(pageSize),
              page: String(page),
            });
            const url = `${baseUrl}?${qs.toString()}`;
            const started = Date.now();
            try { logger.info('raydium.http request', { mint, page, pageSize, cat: 'raydium' }); } catch {}
            const res = await fetchFn(url, { headers: { accept: 'application/json' } });
            if (res?.status === 429) {
              poolsMetrics.raydium.http429++;
              poolsMetrics.raydium.backoffMs = Math.min(5000, Math.max(1500, poolsMetrics.raydium.backoffMs * 2 || 1500));
              try { emit('log', { level: 'warn', message: 'arb:429 source=raydium kind=http surface=pools.info', timestamp: new Date().toISOString(), context: { cat: 'arb' } }); } catch {}
              try { logger.warn('raydium.http 429', { mint, page, cat: 'raydium' }); } catch {}
              // Backoff then continue to next loop iteration
              continue;
            }
            if (!res?.ok) {
              const txt = await res?.text?.();
              logger.warn('raydium.http non-ok', { status: res?.status, body: (txt || '').slice(0, 200), cat: 'raydium' });
              break;
            }
            const json = await res.json().catch(() => null);
            const arr = Array.isArray(json?.data?.data) ? json.data.data : [];
            if (arr.length) collected.push(...arr);
            hasNext = !!json?.data?.hasNextPage;
            page += 1;
            pagesFetched += 1;
            try { logger.info('raydium.http page ok', { mint, page: page - 1, ms: Date.now() - started, count: arr.length, next: !!hasNext, cat: 'raydium' }); } catch {}
          } catch (e: any) {
            const msg = String(e?.message || e);
            logger.warn('raydium.http fetch failed', { error: msg, cat: 'raydium' });
            if (/429/.test(msg)) { poolsMetrics.raydium.http429++; poolsMetrics.raydium.backoffMs = Math.min(5000, Math.max(1500, poolsMetrics.raydium.backoffMs * 2 || 1500)); try { emit('log', { level: 'warn', message: 'arb:429 source=raydium kind=http surface=pools.info.catch', timestamp: new Date().toISOString(), context: { cat: 'arb' } }); } catch {} }
            break;
          }
        }
      });
    }

    let idx = 0; const workers: Promise<void>[] = [];
    for (let i = 0; i < concurrency; i++) {
      workers.push((async () => { while (idx < queue.length) { const my = idx++; await queue[my](); } })());
    }
    await Promise.all(workers);

    if (collected.length) {
      logger.info('raydium.http.fetch ok', { count: collected.length, cat: 'raydium' });
      return { data: collected };
    }

    logger.warn('raydium.http returned 0');
    return { data: [] };
  } catch (e: any) {
    const msg = String(e?.message || e);
    logger.warn('raydium.http failed', { error: msg, cat: 'raydium' });
    if (/429/.test(msg)) { try { emit('log', { level: 'warn', message: 'arb:429 source=raydium kind=http surface=fetch', timestamp: new Date().toISOString(), context: { cat: 'arb' } }); } catch {} }
    return { data: [] };
  }
}

function num(v: any): number {
  const n = typeof v === 'string' ? Number(v) : (typeof v === 'number' ? v : 0);
  return Number.isFinite(n) ? n : 0;
}

// Meteora DLMM HTTP fetcher
async function fetchMeteoraHttp(): Promise<any> {
  try {
    const base = (CONFIG as any)?.meteora?.apiUrl || 'https://dlmm-api.meteora.ag/v1/pairs';
    const size = Number(((CONFIG as any)?.meteora?.pageSize) || 200);
    const retries = Number(((CONFIG as any)?.meteora?.maxHttpRetries) || 2);
    const backoffMs = Number(((CONFIG as any)?.meteora?.httpBackoffMs) || 500);
    const maxPages = Number(((CONFIG as any)?.meteora?.maxPages) || 3);
    const build = (page: number, limit: number) => {
      const sp = new URLSearchParams();
      sp.append('page', String(Math.max(0, page)));
      if (Number.isFinite(limit as any) && limit > 0) sp.append('limit', String(limit));
      const qs = sp.toString();
      return qs ? `${base}?${qs}` : base;
    };
    // eslint-disable-next-line no-undef
    const fetchFn: any = (globalThis as any).fetch || fetch;
    const out: any[] = [];
    let page = 0;
    // Treat maxPages=0 (or <0) as unlimited; stop when page is short
    const pageLimit = (maxPages && maxPages > 0) ? maxPages : Number.POSITIVE_INFINITY;
    for (let i = 0; i < pageLimit; i++) {
      let ok = false;
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          const url = build(page, size);
          try { logger.info('meteora.http request', { page, limit: size, cat: 'meteora' }); } catch {}
          const res = await fetchFn(url, { headers: { accept: 'application/json' }, method: 'GET' });
          if (res?.status === 429) { try { logger.warn('meteora.http 429', { page, cat: 'meteora' }); emit('log', { level: 'warn', message: `arb:429 source=meteora page=${page}`, timestamp: new Date().toISOString(), context: { cat: 'arb' } }); } catch {}; throw new Error('http 429'); }
          if (!res?.ok) throw new Error(`http ${res?.status}`);
          const json: any = await res.json().catch(() => null);
          const data: any[] = Array.isArray(json?.pairs) ? json.pairs : (Array.isArray(json) ? json : (Array.isArray(json?.data) ? json.data : []));
          const total = Number((json as any)?.total ?? NaN);
          if (data.length) out.push(...data);
          ok = true; break;
        } catch (e:any) {
          try { logger.warn('meteora.http page failed', { page, attempt: attempt + 1, error: String(e?.message || e), cat: 'meteora' }); } catch {}
          if (attempt < retries) await new Promise(r => setTimeout(r, backoffMs * (attempt + 1)));
        }
      }
      if (ok) {
        try { logger.info('meteora.http page ok', { page, count: out.length, cat: 'meteora' }); } catch {}
      } else {
        break;
      }
      // Stop on short page
      const lastPageSize = Math.min(size, out.length - (page * size));
      if (lastPageSize < size) break;
      // If server provides total, stop when we've collected all
      try { const total = Number((await 0) as any); } catch {}
      // Above no-op keeps TS quiet in some builds; compute real total from latest response is done above
      // We cannot access latest 'total' here; conservatively stop by short page
      page += 1;
    }
    if (out.length === 0) {
      // fallback single
      const res = await fetchFn(build(0, size), { headers: { accept: 'application/json' }, method: 'GET' });
      if (!res?.ok) throw new Error(`http ${res?.status}`);
      const json: any = await res.json().catch(() => null);
      const single = Array.isArray(json?.pairs) ? json.pairs : (Array.isArray(json) ? json : (Array.isArray(json?.data) ? json.data : []));
      try { logger.info('meteora.http single ok', { count: single.length, cat: 'meteora' }); } catch {}
      return single;
    }
    return out;
  } catch {
    return [];
  }
}

async function normalizeMeteoraHttp(raw: any): Promise<PoolsPayload> {
  const now = Date.now();
  const clmm: ClmmPool[] = [];
  let jupMap: Record<string, { symbol: string; decimals: number }> = {};
  try { const tok = await import('../utils/tokens.js'); if (typeof (tok as any).loadJupiterTokenMap === 'function') jupMap = await (tok as any).loadJupiterTokenMap(); } catch {}
  const arrCandidates: any[] = [];
  if (Array.isArray(raw?.pairs)) arrCandidates.push(raw.pairs);
  if (Array.isArray(raw)) arrCandidates.push(raw);
  if (Array.isArray(raw?.data)) arrCandidates.push(raw.data);
  const arr: any[] = arrCandidates.find(a => Array.isArray(a) && a.length) || (Array.isArray(raw?.pairs) ? raw.pairs : (Array.isArray(raw) ? raw : (Array.isArray(raw?.data) ? raw.data : [])));
  for (const it of arr) {
    const id = String(it?.address || it?.id || it?.poolAddress || '');
    const tokenA = it?.tokenA || it?.tokenX || {};
    const tokenB = it?.tokenB || it?.tokenY || {};
    const mint_a = String(it?.mint_x || tokenA?.mint || it?.mintA || it?.tokenXMint || '');
    const mint_b = String(it?.mint_y || tokenB?.mint || it?.mintB || it?.tokenYMint || '');
    if (!id || !mint_a || !mint_b) continue;
    let decA = Number((tokenA?.decimals ?? it?.decimalsA));
    let decB = Number((tokenB?.decimals ?? it?.decimalsB));
    if (!Number.isFinite(decA) && jupMap[mint_a]?.decimals != null) decA = Number(jupMap[mint_a].decimals);
    if (!Number.isFinite(decB) && jupMap[mint_b]?.decimals != null) decB = Number(jupMap[mint_b].decimals);
    // Fee: prefer base_fee_percentage (percentage), fall back to fee_bps/feeRate
    const feeBasePctRaw: any = (it as any)?.base_fee_percentage;
    let fee_bps = 0;
    if (feeBasePctRaw != null) {
      const val = Number(feeBasePctRaw);
      if (Number.isFinite(val)) fee_bps = val <= 1 ? Math.round(val * 10_000) : Math.round(val * 100);
    } else {
      const feeRaw = (it as any)?.feeRate ?? (it as any)?.fee_bps;
      if (typeof feeRaw === 'number') fee_bps = feeRaw <= 1 ? Math.round(feeRaw * 10_000) : Math.round(feeRaw);
    }
    let incomingPrice = Number((it as any)?.current_price ?? (it as any)?.price ?? (it as any)?.price_a_per_b ?? 0);
    const amtAraw = (it?.reserve_x_amount ?? it?.tokenBalanceA ?? it?.tokenAAmount ?? it?.amountA ?? it?.baseAmount ?? 0);
    const amtBraw = (it?.reserve_y_amount ?? it?.tokenBalanceB ?? it?.tokenBAmount ?? it?.amountB ?? it?.quoteAmount ?? 0);
    const amount_a = Number(typeof amtAraw === 'string' ? Number(amtAraw) : amtAraw || 0);
    const amount_b = Number(typeof amtBraw === 'string' ? Number(amtBraw) : amtBraw || 0);
    const tvlUsdcRaw = (it as any)?.tvlUsdc ?? (it as any)?.tvlUsd ?? (it as any)?.liquidity;
    const tvlUsdcNum = typeof tvlUsdcRaw === 'string' ? Number(tvlUsdcRaw) : (typeof tvlUsdcRaw === 'number' ? tvlUsdcRaw : 0);
    const tvl_usd = Number.isFinite(tvlUsdcNum) && tvlUsdcNum > 0 ? tvlUsdcNum : undefined;
    const pool_liquidity_raw = (tvl_usd != null) ? tvl_usd : (Number.isFinite(decA) && Number.isFinite(decB) ? ((amount_a/Math.pow(10, decA as number)) + (amount_b/Math.pow(10, decB as number))) : undefined);
    const liquidity_display = (tvl_usd != null) ? tvl_usd : undefined;
    // Calibrate orientation and magnitude to A-per-B using USD references when available
    // Choose between incoming and its inverse, optionally scaled by powers of 10, minimizing deviation to ref = pa/pb
    // If USD refs unavailable, leave incoming as-is
    try {
      const { getPriceByMint } = await import('./priceStore.js');
      const pa = getPriceByMint(mint_a)?.usdc ?? null;
      const pb = getPriceByMint(mint_b)?.usdc ?? null;
      if (pa && pb && Number(pa) > 0 && Number(pb) > 0 && Number(incomingPrice) > 0) {
        // For A per 1 B, compare against USD reference price(B)/price(A)
        const ref = (pb as number) / (pa as number);
        const base = Number(incomingPrice);
        const inv = 1 / base;
        const cands: number[] = [];
        for (let k = -6; k <= 6; k++) {
          const scale = Math.pow(10, k);
          cands.push(base * scale);
          cands.push(inv * scale);
        }
        let best = base; let bestDev = Number.POSITIVE_INFINITY;
        for (const c of cands) {
          if (!Number.isFinite(c) || !(c > 0)) continue;
          const dev = Math.max(c / ref, ref / c);
          if (dev + 1e-12 < bestDev) { bestDev = dev; best = c; }
        }
        incomingPrice = best;
      }
    } catch {}
    // Optional sanity: drop extreme deviations vs USD ref if both sides priced
    let price_ok = true;
    try {
      const sanityCfg = (CONFIG as any)?.sanity || {};
      const apply = (sanityCfg as any).sanity_applyMeteoraClmm ?? true;
      if (apply !== false) {
        const maxDeviation = Number.isFinite(Number(sanityCfg.maxPriceDeviation)) ? Number(sanityCfg.maxPriceDeviation) : 50;
        const { getPriceByMint } = await import('./priceStore.js');
        const pa = getPriceByMint(mint_a)?.usdc ?? null;
        const pb = getPriceByMint(mint_b)?.usdc ?? null;
        const px = (incomingPrice && incomingPrice > 0) ? incomingPrice : undefined;
        if (pa && pb && px && (px as number) > 0) {
          // For A per 1 B, the USD reference is price(B)/price(A)
          const ref = (pb as number) / (pa as number);
          const dev = Math.max((px as number) / ref, ref / (px as number));
          if (dev > maxDeviation) price_ok = false;
        }
      }
    } catch {}
    if (!price_ok) { try { logger.warn('meteora.clmm drop by sanity', { id, mint_a, mint_b, price_a_per_b: incomingPrice, cat: 'meteora' }); } catch {}; continue; }
    clmm.push({ id, dex: 'Meteora', mint_a, mint_b, fee_bps, sqrt_price_x64: 0, liquidity: 0, tick_spacing: Number((it as any)?.bin_step || (it as any)?.binStep || 0), updated_ms: now, price_a_per_b: (incomingPrice && incomingPrice > 0) ? incomingPrice : undefined, amount_a, amount_b, decimals_a: Number.isFinite(decA) ? decA : undefined, decimals_b: Number.isFinite(decB) ? decB : undefined, pool_kind: 'clmm', pool_liquidity_raw, tvl_usd, liquidity_display } as any);
  }
  // Optional canonicalization of pair order for consistency
  try {
    const mode = String(((CONFIG as any)?.meteora?.canonicalizePairs ?? (CONFIG.system as any)?.canonicalizePairs) || 'none');
    if (mode === 'lex' && clmm.length) {
      for (let i = 0; i < clmm.length; i++) {
        const p = clmm[i];
        if (String(p.mint_a) <= String(p.mint_b)) continue;
        const inv = (p.price_a_per_b && p.price_a_per_b > 0) ? (1 / (p.price_a_per_b as number)) : p.price_a_per_b;
        clmm[i] = { ...p, mint_a: p.mint_b, mint_b: p.mint_a, price_a_per_b: inv as any };
      }
    }
  } catch {}
  try {
    const canon = String(((CONFIG as any)?.meteora?.canonicalizePairs ?? (CONFIG.system as any)?.canonicalizePairs) || 'none');
    logger.info('meteora.http normalized', { clmm: clmm.length, cat: 'meteora', canon });
  } catch {}
  return { amm: [], clmm };
}

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

export async function normalizeRaydiumPools(raw: any): Promise<PoolsPayload> {
  const now = Date.now();
  const amm: AmmPool[] = [];
  const clmm: ClmmPool[] = [];

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

  for (const it of arr) {
    if (!it) continue;
    const id = String(it?.id || it?.address || it?.pool_id || it?.ammId || '');
    const mintA = toMint(it?.mintA);
    const mintB = toMint(it?.mintB);
    if (!id || !mintA || !mintB) continue;
    const typeStr = String(it?.type || it?.poolType || '').toLowerCase();
    const pooltype = Array.isArray((it as any)?.pooltype) ? (it as any).pooltype : [];
    const isClmm = typeStr.includes('concentrated') || pooltype.map((s: any) => String(s).toLowerCase()).includes('clmm');
    const fee_bps = toFeeBps((it as any)?.feeRate ?? (it as any)?.tradeFeeRate ?? (it as any)?.feeBps ?? (it as any)?.tradeFeeBps);
    const decA = Number((it?.mintA as any)?.decimals);
    const decB = Number((it?.mintB as any)?.decimals);
    const price = Number((it as any)?.price);
    const tvl = Number((it as any)?.tvl);
    const mintAmountA = Number((it as any)?.mintAmountA);
    const mintAmountB = Number((it as any)?.mintAmountB);

    if (isClmm) {
      const tick = Number((it as any)?.tickSpacing ?? (it as any)?.config?.tickSpacing ?? 0);
      const sqrt = Number((it as any)?.sqrtPriceX64 ?? (it as any)?.sqrtPrice ?? 0);
      const liquidity = Number((it as any)?.liquidity ?? 0);
      const tvl_usd = Number.isFinite(tvl) && tvl > 0 ? tvl : undefined;
      const amount_a_whole = Number.isFinite(mintAmountA) ? mintAmountA : undefined;
      const amount_b_whole = Number.isFinite(mintAmountB) ? mintAmountB : undefined;
      clmm.push({ id, dex: 'Raydium', mint_a: mintA, mint_b: mintB, fee_bps, sqrt_price_x64: Number.isFinite(sqrt) ? sqrt : 0, liquidity: Number.isFinite(liquidity) ? liquidity : 0, tick_spacing: Number.isFinite(tick) ? tick : 0, updated_ms: now, price_a_per_b: Number.isFinite(price) ? price : undefined, decimals_a: Number.isFinite(decA) ? decA : undefined, decimals_b: Number.isFinite(decB) ? decB : undefined, pool_kind: 'clmm', tvl_usd, amount_a_whole, amount_b_whole, liquidity_display: tvl_usd });
    } else {
      const tvl_usd = Number.isFinite(tvl) && tvl > 0 ? tvl : undefined;
      const amount_a_whole = Number.isFinite(mintAmountA) ? mintAmountA : undefined;
      const amount_b_whole = Number.isFinite(mintAmountB) ? mintAmountB : undefined;
      const amounts_are_whole = Number.isFinite(amount_a_whole as any) || Number.isFinite(amount_b_whole as any) ? true : undefined;
      const liquidity_base = Number.isFinite(amount_a_whole as any) && Number.isFinite(amount_b_whole as any)
        ? Math.min(amount_a_whole as number, amount_b_whole as number)
        : 0;
      const liquidity_display = (tvl_usd != null) ? tvl_usd : (liquidity_base > 0 ? liquidity_base : undefined);
      // Price sanity: choose between incoming price and its reciprocal, and reserves-implied price (and reciprocal), preferring closer to USD ref for A per 1 B
      let price_in = Number.isFinite(price) && price > 0 ? Number(price) : 0;
      const price_res = (Number.isFinite(amount_a_whole as any) && Number.isFinite(amount_b_whole as any) && (amount_b_whole as number) > 0)
        ? ((amount_a_whole as number) / (amount_b_whole as number))
        : 0;
      let price_sane = price_in > 0 ? price_in : price_res;
      try {
        const sanityCfg = (CONFIG as any)?.sanity || {};
        const apply = (sanityCfg as any).sanity_applyRaydiumAmm ?? true;
        if (apply !== false) {
          const maxDeviation = Number.isFinite(Number(sanityCfg.maxPriceDeviation)) ? Number(sanityCfg.maxPriceDeviation) : 50;
          const { getPriceByMint } = await import('./priceStore.js');
          const pa = getPriceByMint(mintA)?.usdc ?? null;
          const pb = getPriceByMint(mintB)?.usdc ?? null;
          if (pa && pb && (pa as number) > 0 && (pb as number) > 0) {
            // For A per 1 B, the USD reference is price(B)/price(A)
            const ref = (pb as number) / (pa as number);
            const candidates: number[] = [];
            if (price_in > 0) { candidates.push(price_in); candidates.push(1 / price_in); }
            if (price_res > 0) { candidates.push(price_res); candidates.push(1 / price_res); }
            if (candidates.length) {
              let bestVal = candidates[0];
              let bestDev = Math.max(bestVal / ref, ref / bestVal);
              for (let k = 1; k < candidates.length; k++) {
                const cur = candidates[k];
                const dev = Math.max(cur / ref, ref / cur);
                if (dev + 1e-12 < bestDev) { bestDev = dev; bestVal = cur; }
              }
              price_sane = bestVal;
              // If still absurdly off, drop this pool by skipping push
              if (bestDev > maxDeviation) {
                try { logger.warn('raydium.amm drop by sanity', { id, mint_a: mintA, mint_b: mintB, price_in, price_res, ref, dev: bestDev, maxDeviation }); } catch {}
                continue;
              }
            }
          }
        }
      } catch {}
      amm.push({ id, dex: 'Raydium', mint_a: mintA, mint_b: mintB, fee_bps, price_a_per_b: Number.isFinite(price_sane) ? price_sane : 0, liquidity_base, updated_ms: now, decimals_a: Number.isFinite(decA) ? decA : undefined, decimals_b: Number.isFinite(decB) ? decB : undefined, pool_kind: 'amm', tvl_usd, amount_a_whole, amount_b_whole, amounts_are_whole, liquidity_display });
    }
  }

  // Optional canonicalization of pair order for consistency
  try {
    const mode = String((CONFIG.system as any)?.canonicalizePairs || 'none');
    if (mode === 'lex') {
      const canonAmm: AmmPool[] = [];
      for (const p of amm) {
        const [a, b] = String(p.mint_a) <= String(p.mint_b) ? [p.mint_a, p.mint_b] : [p.mint_b, p.mint_a];
        const price = (a === p.mint_a) ? p.price_a_per_b : (p.price_a_per_b > 0 ? (1 / p.price_a_per_b) : p.price_a_per_b);
        canonAmm.push({ ...p, mint_a: a, mint_b: b, price_a_per_b: price });
      }
      const canonClmm: ClmmPool[] = [];
      for (const p of clmm) {
        const [a, b] = String(p.mint_a) <= String(p.mint_b) ? [p.mint_a, p.mint_b] : [p.mint_b, p.mint_a];
        const price = (a === p.mint_a) ? p.price_a_per_b : (p.price_a_per_b && p.price_a_per_b > 0 ? (1 / (p.price_a_per_b as number)) : p.price_a_per_b);
        canonClmm.push({ ...p, mint_a: a, mint_b: b, price_a_per_b: price as any });
      }
      logger.info('raydium.pools normalized (canon=lex)', { amm: canonAmm.length, clmm: canonClmm.length, cat: 'raydium' });
      return { amm: canonAmm, clmm: canonClmm };
    }
  } catch {}
  logger.info('raydium.pools normalized', { amm: amm.length, clmm: clmm.length, cat: 'raydium' });
  return { amm, clmm };
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

// Unified refresh orchestrator: fetch all sources and optionally (re)subscribe
export async function refreshAllSources(force = true, subscribe = true): Promise<{ raydium: PoolsPayload; orca: PoolsPayload; meteora: PoolsPayload }> {
  const r = await getRaydiumPoolsNormalized(!!force).catch(() => ({ amm: [], clmm: [] }));
  const o = await getOrcaPoolsCached(!!force).catch(() => ({ amm: [], clmm: [] }));
  const m = await getMeteoraPoolsCached(!!force).catch(() => ({ amm: [], clmm: [] }));
  if (subscribe) {
    try {
      enablePoolWebsocketRefreshes();
      startRaydiumRefreshLoop();
    } catch {}
  }
  return { raydium: r, orca: o, meteora: m };
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
        const web3: any = await import('@solana/web3.js');
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
                if (rmod && info?.data) {
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
                      // Graph rebuilds now orchestrated by refresh endpoint; avoid redundant triggers here
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
                        // Graph rebuilds now orchestrated by refresh endpoint; avoid redundant triggers here
                        updated = true;
                      }
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
                const sdk = await import('@orca-so/whirlpools-sdk');
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
                  try { logger.info('pools.delta orca.ws', { id: pk58.slice(0,6)+'…', updatedClmm: d.clmm.length, cat: 'pools' }); } catch {}
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
        // Meteora targeted subscriptions from scoped graph edges; fallback to program-level when set
        try {
          const edgeIds: string[] = Array.from(meteoraTargets);
          let attachedMet = 0;
          for (const addr of edgeIds) {
            try {
              const pk = new web3.PublicKey(addr);
              const id = await conn.onAccountChange(pk, (info: any) => { handle(pk as any, info); });
              subs.push(id as any); attachedMet++;
            } catch {}
          }
          attachedMeteoraPools = attachedMet;
          if (attachedMet > 0) {
            try { logger.info('pools.ws subscribe meteora.pools', { attached: attachedMet, source: 'meteora' }); } catch {}
          } else {
            // Program-level fallback
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
              // WS unhealthy; when user subscribed, do not trigger HTTP refresh automatically
              try { logger.warn('pools.ws unhealthy', { idleMs: idle, timeoutMs }); } catch {}
              wsHealthy = false;
            }
          } catch {}
        }, Math.max(2000, Math.floor((Number((CONFIG.system as any)?.wsHealthTimeoutMs || 15000)) / 3)));

        // Periodic aggregate logs for WS activity
        const aggPeriod = Math.max(5000, Number((CONFIG.system as any)?.wsAggLogPeriodMs || 15000));
        aggTimer = setInterval(() => {
          try {
            const snapshot = { raydium: wsCounts.raydium, orca: wsCounts.orca, meteora: wsCounts.meteora } as any;
            wsCounts.raydium = 0; wsCounts.orca = 0; wsCounts.meteora = 0;
            logger.info('pools.ws aggregate', { events: snapshot, healthy: wsHealthy, lastEventMs: lastWsEventMs });
            // Emit a dedicated ws-activity event for UI regardless of log filtering
            try { emit('ws-activity', { healthy: wsHealthy, lastEventMs: lastWsEventMs, orca: { attached: attachedOrcaPools, events: snapshot.orca || 0 }, raydium: { attached: attachedRaydiumPools, events: snapshot.raydium || 0 }, meteora: { attached: attachedMeteoraPools, events: snapshot.meteora || 0 } }); } catch {}
            try { emit('log', { level: 'debug', message: `pools:ws aggregate ray=${snapshot.raydium} orca=${snapshot.orca}`, timestamp: new Date().toISOString(), context: { cat: 'pools' } }); } catch {}
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

      const raw: any = await fetchRaydiumPoolsRaw();
      let norm = await normalizeRaydiumPools(raw);
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
        try { logger.info('pools.delta orca', { updatedAmm: d.amm.length, updatedClmm: d.clmm.length, addedAmm: d.addedAmm, removedAmm: d.removedAmm, addedClmm: d.addedClmm, removedClmm: d.removedClmm, cat: 'pools' }); } catch {}
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
    mode: CONFIG.orca?.mode || 'http',
    uniMode: (CONFIG.system as any)?.tokenUniverseMode || 'jupiter',
    anchorBridging: !!((CONFIG.system as any)?.enableAnchorBridging),
    includeAnchors: (CONFIG.system as any)?.includeAnchorsInUniverse !== false,
    canonicalizePairs: (CONFIG.system as any)?.canonicalizePairs || 'none',
  });
  // Try configured mode, then fallbacks to maximize robustness
  const tried: string[] = [];
  const modes: string[] = [];
  const configured = (CONFIG.orca?.mode || 'http') as string;
  if (configured) modes.push(configured);
  for (const m of ['http', 'v4', 'legacy']) { if (!modes.includes(m)) modes.push(m); }
  for (const mode of modes) {
    try {
      if (mode === 'http') {
        const raw = await fetchOrcaHttp();
        let norm = await normalizeOrcaHttp(raw);
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
      }
      if (mode === 'v4') {
        const norm = await fetchOrcaV4();
        logger.info('orca.v4 normalized', { clmm: norm.clmm.length });
        return norm;
      }
      if (mode === 'legacy') {
        const norm = await fetchOrcaLegacy();
        logger.info('orca.legacy normalized', { clmm: norm.clmm.length });
        return norm;
      }
    } catch (e: any) {
      tried.push(`${mode}:${String(e?.message || e)}`);
      const msg = String(e?.message || e);
      const adaptive = /AdaptiveFee/i.test(msg) || /AdaptiveFeeTier/i.test(msg);
      // Simple exponential backoff for subsequent attempts in this process
      const attempt = tried.length;
      const backoff = Math.min(2000, 200 * Math.pow(2, attempt - 1));
      logger.warn(`orca.${mode} failed`, { error: msg, adaptiveFee: adaptive, attempt, backoffMs: backoff });
      await new Promise(r => setTimeout(r, backoff));
      continue;
    }
  }
  logger.warn('orca all modes failed', { tried });
  return { amm: [], clmm: [] };
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
      const raw = await fetchMeteoraHttp();
      let norm = await normalizeMeteoraHttp(raw);
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

async function fetchOrcaHttp(): Promise<any> {
  const base = CONFIG.orca?.apiUrl || 'https://api.orca.so/v2/solana/pools';
  const retries = CONFIG.orca?.maxHttpRetries ?? 2;
  const backoffMs = CONFIG.orca?.httpBackoffMs ?? 500;
  const maxPages = CONFIG.orca?.maxPages ?? 5;
  // Prefer UI-provided pageSize; fallback to 'size' if pageSize is not provided
  const size = Number(CONFIG.orca?.pageSize ?? CONFIG.orca?.size ?? 500);
  const params: Record<string, string> = {};
  // Apply filters from config
  if (CONFIG.orca?.sortBy) params.sortBy = String(CONFIG.orca.sortBy);
  if (CONFIG.orca?.sortDirection) params.sortDirection = String(CONFIG.orca.sortDirection);
  if (Number.isFinite(size as any) && size > 0) params.size = String(size);
  if (CONFIG.orca?.hasRewards !== undefined) params.hasRewards = String(Boolean(CONFIG.orca.hasRewards));
  if (CONFIG.orca?.hasWarning !== undefined) params.hasWarning = String(Boolean(CONFIG.orca.hasWarning));
  if (CONFIG.orca?.hasAdaptiveFee !== undefined) params.hasAdaptiveFee = String(Boolean(CONFIG.orca.hasAdaptiveFee));
  if (CONFIG.orca?.isWavebreak !== undefined) params.isWavebreak = String(Boolean(CONFIG.orca.isWavebreak));
  if (CONFIG.orca?.minTvl !== undefined) params.minTvl = String(CONFIG.orca.minTvl);
  if (CONFIG.orca?.minVolume !== undefined) params.minVolume = String(CONFIG.orca.minVolume);
  if (CONFIG.orca?.minLockedLiquidityPercent !== undefined) params.minLockedLiquidityPercent = String(CONFIG.orca.minLockedLiquidityPercent);
  if (CONFIG.orca?.token) params.token = String(CONFIG.orca.token);
  if (CONFIG.orca?.tokensBothOf) params.tokensBothOf = String(CONFIG.orca.tokensBothOf);
  // Optional prefilter: use universe to set 'token' for conservative narrowing
  try {
    if ((CONFIG.system as any)?.universePrefilterOrca) {
      const { computeTokenUniverse } = await import('./universe.js');
      const uni = await computeTokenUniverse((CONFIG.system as any)?.tokenUniverseMode);
      // Prefer anchoring to a popular pivot (USDC) if present; else SOL; else any
      const pivots = ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'So11111111111111111111111111111111111111112'];
      let chosen: string | undefined = undefined;
      for (const p of pivots) { if (uni.has(p)) { chosen = p; break; } }
      if (!chosen) chosen = Array.from(uni)[0];
      if (chosen && !params.token) params.token = chosen;
    }
  } catch {}
  if (CONFIG.orca?.addresses) params.addresses = String(CONFIG.orca.addresses);
  if (CONFIG.orca?.includeBlocked !== undefined) params.includeBlocked = String(Boolean(CONFIG.orca.includeBlocked));
  if (Array.isArray(CONFIG.orca?.stats) && CONFIG.orca.stats.length) params.stats = CONFIG.orca.stats.join(',');

  function buildUrl(extra: Record<string, string | undefined> = {}): string {
    const search = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) { if (v != null && v !== '') search.append(k, v); }
    for (const [k, v] of Object.entries(extra)) { if (v != null && v !== '') search.append(k, String(v)); }
    const qs = search.toString();
    return qs ? `${base}?${qs}` : base;
  }

  const merged: any[] = [];
  const seenIds = new Set<string>();
  const pushDedup = (arr: any[]) => {
    for (const it of (arr || [])) {
      const id = String(it?.address || it?.id || '');
      if (!id) { merged.push(it); continue; }
      if (!seenIds.has(id)) { seenIds.add(id); merged.push(it); }
    }
  };
  const runPaged = async (): Promise<void> => {
    let nextCursor: string | null = '';
    let page = 0;
    let lastErr: any;
    const pageLimit = (maxPages && maxPages > 0) ? maxPages : Number.POSITIVE_INFINITY;
    while (page < pageLimit) {
      page += 1;
      let ok = false;
      for (let attempt = 0; attempt <= retries; attempt++) {
        const started = Date.now();
        try {
          const url = buildUrl(nextCursor !== null ? (nextCursor ? { next: nextCursor } : { next: '', previous: '' }) : {});
          try { logger.info('orca.http request', { page, params: { ...params, next: nextCursor || undefined } }); } catch {}
          // eslint-disable-next-line no-undef
          const res = await fetch(url);
          if (res.status === 429) {
            try { emit('log', { level: 'warn', message: `arb:429 source=orca kind=http surface=page page=${page}`, timestamp: new Date().toISOString(), context: { cat: 'arb' } }); } catch {}
            try { logger.warn('orca.http 429 page', { page }); } catch {}
            throw new Error('http 429');
          }
          const ms = Date.now() - started;
          if (!res.ok) throw new Error(`http ${res.status}`);
          const json: any = await res.json();
          const data: any[] = Array.isArray(json) ? json : (Array.isArray(json?.data) ? json.data : []);
          if (page === 1) { try { logger.info('orca.http meta', { meta: json?.meta }); } catch {} }
          const count = data.length;
          const metaNext = (json as any)?.meta?.next ?? (json as any)?.meta?.cursor?.next;
          logger.info('orca.http page ok', { page, ms, count, next: !!metaNext });
          if (count > 0) pushDedup(data);
          const rawMeta = (json as any)?.meta;
          if (rawMeta && (Object.prototype.hasOwnProperty.call(rawMeta, 'next') || (rawMeta as any)?.cursor)) {
            const nxt = (rawMeta as any)?.next ?? (rawMeta as any)?.cursor?.next;
            nextCursor = (nxt === null || nxt === undefined) ? null : String(nxt);
          } else {
            nextCursor = null;
          }
          ok = true;
          break;
        } catch (e: any) {
          lastErr = e;
          const msg = String(e?.message || e);
          logger.warn('orca.http page failed', { page, attempt: attempt + 1, error: msg });
          if (attempt === 0 && params.size) {
            const original = params.size;
            const reduced = String(Math.max(50, Math.floor(Number(original) / 2)));
            params.size = reduced;
            try { logger.warn('orca.http reducing size due to failure', { from: original, to: reduced }); } catch {}
          }
          if (attempt < retries) await new Promise(r => setTimeout(r, backoffMs * (attempt + 1)));
        }
      }
      if (!ok) break;
      if (!nextCursor) break; // no more pages
    }
  };

  const originalTokenParam = params.token;
  const pivotMints = ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'So11111111111111111111111111111111111111112'];
  for (const pivot of pivotMints) {
    params.token = pivot;
    const before = merged.length;
    try { logger.info('orca.http pivot pass', { pivot, size: params.size, maxPages }); } catch {}
    await runPaged();
    try { logger.info('orca.http pivot added', { pivot, added: merged.length - before, total: merged.length }); } catch {}
  }
  if (originalTokenParam && !pivotMints.includes(String(originalTokenParam))) {
    params.token = String(originalTokenParam);
    const before = merged.length;
    try { logger.info('orca.http custom-token pass', { token: params.token, size: params.size, maxPages }); } catch {}
    await runPaged();
    try { logger.info('orca.http custom-token added', { token: params.token, added: merged.length - before, total: merged.length }); } catch {}
  }
  if (merged.length === 0) {
    params.token = undefined as any;
    const before = merged.length;
    try { logger.info('orca.http generic pass', { size: params.size, maxPages }); } catch {}
    await runPaged();
    try { logger.info('orca.http generic added', { added: merged.length - before, total: merged.length }); } catch {}
  }
  try { logger.info('orca.http merged', { total: merged.length }); } catch {}

  if (merged.length === 0) {
    // fallback single fetch without cursor params
    const started = Date.now();
    // eslint-disable-next-line no-undef
    const res = await fetch(buildUrl());
    if (res.status === 429) {
      try { emit('log', { level: 'warn', message: 'arb:429 source=orca kind=http surface=fallback', timestamp: new Date().toISOString(), context: { cat: 'arb' } }); } catch {}
      try { logger.warn('orca.http 429 fallback'); } catch {}
      throw new Error('http 429');
    }
    const ms = Date.now() - started;
    if (!res.ok) throw new Error(`http ${res.status}`);
    const json: any = await res.json();
    const data: any[] = Array.isArray(json) ? json : (Array.isArray(json?.data) ? json.data : []);
    logger.info('orca.http single ok', { ms, count: data.length });
    // Return raw HTTP data without enrichment
    return data;
  }

  // Return merged HTTP data without enrichment
  return merged;
}

// Orca enrichment removed: HTTP API provides required fields

async function normalizeOrcaHttp(raw: any): Promise<PoolsPayload> {
  const now = Date.now();
  const clmm: ClmmPool[] = [];
  // Load Jupiter token metadata once to fill decimals where missing
  let jupMap: Record<string, { symbol: string; decimals: number }> = {};
  // Optional: symbol->mint resolver and cache (avoid repeated lookups)
  let resolveMintFn: undefined | ((s: string) => Promise<{ mint: string; decimals: number }>);
  const symbolToMintCache = new Map<string, { mint?: string; decimals?: number; tried: boolean }>();
  try {
    const tok = await import('../utils/tokens.js');
    if (typeof (tok as any).loadJupiterTokenMap === 'function') {
      jupMap = await (tok as any).loadJupiterTokenMap();
    }
    if (typeof (tok as any).resolveMint === 'function') {
      resolveMintFn = (tok as any).resolveMint as any;
    }
  } catch {}
  const arrCandidates: any[] = [];
  if (Array.isArray(raw)) arrCandidates.push(raw);
  if (Array.isArray(raw?.data)) arrCandidates.push(raw.data);
  if (Array.isArray(raw?.pools)) arrCandidates.push(raw.pools);
  if (Array.isArray(raw?.whirlpools)) arrCandidates.push(raw.whirlpools);
  const arr: any[] = arrCandidates.find(a => Array.isArray(a) && a.length) || (Array.isArray(raw) ? raw : (Array.isArray(raw?.data) ? raw.data : []));
  // Inspection stats for troubleshooting
  try {
    const stats: any = { total: arr.length, types: {}, hasTickSpacing: 0, hasSqrtPrice: 0, hasSqrtPriceX64: 0, hasStateSqrtPriceX64: 0, hasLiquidity: 0, hasStateLiquidity: 0, hasPrice: 0 };
    for (const it of arr.slice(0, 200)) { // sample up to 200 for performance
      const t = String(it?.type || it?.poolType || '');
      stats.types[t] = (stats.types[t] || 0) + 1;
      if (typeof it?.tickSpacing === 'number') stats.hasTickSpacing++;
      if (it?.sqrtPrice != null) stats.hasSqrtPrice++;
      if (it?.sqrtPriceX64 != null) stats.hasSqrtPriceX64++;
      if (it?.state?.sqrtPriceX64 != null || it?.state?.sqrtPrice != null) stats.hasStateSqrtPriceX64++;
      if (it?.liquidity != null) stats.hasLiquidity++;
      if (it?.state?.liquidity != null) stats.hasStateLiquidity++;
      if (it?.price != null || it?.price_a_per_b != null || it?.priceAperB != null) stats.hasPrice++;
    }
    const sample = arr.slice(0, 5).map((it) => ({
      address: String(it?.address || it?.id || ''),
      type: it?.type || it?.poolType,
      tickSpacing: it?.tickSpacing ?? it?.state?.tickSpacing,
      sqrtPrice: it?.sqrtPrice,
      sqrtPriceX64: it?.sqrtPriceX64,
      state_sqrtPriceX64: it?.state?.sqrtPriceX64 ?? it?.state?.sqrtPrice,
      liquidity: it?.liquidity,
      state_liquidity: it?.state?.liquidity,
      price: it?.price ?? it?.price_a_per_b ?? it?.priceAperB,
      tokenA: { mint: it?.tokenA?.mint, symbol: it?.tokenA?.symbol, decimals: it?.tokenA?.decimals, amount: it?.tokenAAmount },
      tokenB: { mint: it?.tokenB?.mint, symbol: it?.tokenB?.symbol, decimals: it?.tokenB?.decimals, amount: it?.tokenBAmount },
    }));
    logger.info('orca.http inspect', { total: stats.total, types: stats.types, fields: { tick: stats.hasTickSpacing, sqrt: stats.hasSqrtPrice, sqrtX64: stats.hasSqrtPriceX64, stateSqrt: stats.hasStateSqrtPriceX64, liq: stats.hasLiquidity, stateLiq: stats.hasStateLiquidity, price: stats.hasPrice }, sample });
  } catch {}
	  let orientationMismatchCount = 0;
	  for (const it of arr) {
    const id = String(it?.address || it?.id || '');
    const tokenA = it?.tokenA || it?.token_a || {};
    const tokenB = it?.tokenB || it?.token_b || {};
    let mint_a = String(tokenA?.mint || it?.mintA || '');
    let mint_b = String(tokenB?.mint || it?.mintB || '');
    // Initialize decimals early so symbol-based resolution can update them
    let decA = Number((tokenA?.decimals ?? it?.decimalsA));
    let decB = Number((tokenB?.decimals ?? it?.decimalsB));
    // If decimals missing but mints known, try Jupiter map
    if (!Number.isFinite(decA) && jupMap[mint_a]?.decimals != null) decA = Number(jupMap[mint_a].decimals);
    if (!Number.isFinite(decB) && jupMap[mint_b]?.decimals != null) decB = Number(jupMap[mint_b].decimals);
    // If mints missing, best-effort resolve via symbols using Jupiter token API/cache
    if (!mint_a && resolveMintFn && typeof tokenA?.symbol === 'string' && tokenA.symbol.trim()) {
      const sym = tokenA.symbol.trim();
      const cached = symbolToMintCache.get(sym);
      if (!cached || !cached.tried) {
        try {
          const r = await resolveMintFn(sym);
          symbolToMintCache.set(sym, { mint: r?.mint, decimals: r?.decimals, tried: true });
        } catch {
          symbolToMintCache.set(sym, { tried: true });
        }
      }
      const got = symbolToMintCache.get(sym);
      if (got?.mint) mint_a = got.mint;
      if (!Number.isFinite(Number(decA)) && Number.isFinite(Number(got?.decimals))) decA = Number(got?.decimals);
    }
    if (!mint_b && resolveMintFn && typeof tokenB?.symbol === 'string' && tokenB.symbol.trim()) {
      const sym = tokenB.symbol.trim();
      const cached = symbolToMintCache.get(sym);
      if (!cached || !cached.tried) {
        try {
          const r = await resolveMintFn(sym);
          symbolToMintCache.set(sym, { mint: r?.mint, decimals: r?.decimals, tried: true });
        } catch {
          symbolToMintCache.set(sym, { tried: true });
        }
      }
      const got = symbolToMintCache.get(sym);
      if (got?.mint) mint_b = got.mint;
      if (!Number.isFinite(Number(decB)) && Number.isFinite(Number(got?.decimals))) decB = Number(got?.decimals);
    }
    // Normalize fee: prefer fractional feeRate (0..1) or integer bps fields
    let fee_bps = 0;
    const feeRateRaw = (it as any)?.feeRate;
    if (typeof feeRateRaw === 'number') {
      fee_bps = feeRateRaw <= 1 ? Math.round(feeRateRaw * 10_000) : Math.round(feeRateRaw);
    } else if (typeof (it as any)?.fee_bps === 'number') {
      fee_bps = Math.round((it as any).fee_bps);
    }
    // identify whirlpools either by explicit type or presence of tick spacing
    const poolType = String(it?.type || it?.poolType || '').toLowerCase();
    const isWhirlpool = poolType.includes('whirlpool') || poolType.includes('concentrated') || typeof it?.tickSpacing === 'number' || typeof it?.state?.tickSpacing === 'number';
    // accept multiple field shapes (prefer direct API fields)
    const sqrtPriceStr = (it?.sqrtPrice ?? it?.sqrtPriceX64 ?? it?.state?.sqrtPriceX64 ?? it?.state?.sqrtPrice ?? 0);
    let sqrt_price_x64 = Number(typeof sqrtPriceStr === 'string' ? Number(sqrtPriceStr) : sqrtPriceStr || 0);
    const liquidityVal = (it?.liquidity ?? it?.state?.liquidity ?? 0);
    const liquidity = Number(typeof liquidityVal === 'string' ? Number(liquidityVal) : liquidityVal || 0);
    const tick_spacing = Number((it?.tickSpacing ?? it?.state?.tickSpacing) || 0);
    // Prefer authoritative decimals from Jupiter map when available (override suspect values)
    if (jupMap && mint_a && (jupMap as any)[mint_a] && Number.isFinite(Number((jupMap as any)[mint_a]?.decimals))) {
      decA = Number((jupMap as any)[mint_a].decimals);
    }
    if (jupMap && mint_b && (jupMap as any)[mint_b] && Number.isFinite(Number((jupMap as any)[mint_b]?.decimals))) {
      decB = Number((jupMap as any)[mint_b].decimals);
    }
    // Prefer tokenBalanceA/B and decimals direct from the API
    const amtAraw = (it?.tokenBalanceA ?? it?.tokenAAmount ?? it?.token_a_amount ?? it?.amountA ?? it?.baseAmount ?? 0);
    const amtBraw = (it?.tokenBalanceB ?? it?.tokenBAmount ?? it?.token_b_amount ?? it?.amountB ?? it?.quoteAmount ?? 0);
    let amount_a = Number(typeof amtAraw === 'string' ? Number(amtAraw) : amtAraw || 0);
    let amount_b = Number(typeof amtBraw === 'string' ? Number(amtBraw) : amtBraw || 0);
    const incomingPrice = Number(it?.price ?? it?.price_a_per_b ?? it?.priceAperB ?? 0);
    // If HTTP doesn't provide sqrtPrice, derive from incoming price and decimals when available
    if ((!sqrt_price_x64 || sqrt_price_x64 <= 0) && isWhirlpool) {
      const price = incomingPrice; // expected A per 1 B
      if (price > 0 && Number.isFinite(decA) && Number.isFinite(decB)) {
        // Orca sqrtPriceX64 encodes sqrt(B per A) in smallest units ratio
        // ratio^2 = 10^(decB - decA) / (price_A_per_B)
        const adj = Math.pow(10, decB - decA) / price;
        const sqrt = Math.sqrt(adj);
        const two64 = Math.pow(2, 64);
        sqrt_price_x64 = Math.floor(sqrt * two64);
      }
    }
   if (isWhirlpool && id && sqrt_price_x64 > 0) {
      // Use raw API order (no stable-first canonicalization). price_a_per_b is A per 1 B in input order.
      let cA = mint_a; let cB = mint_b; let cDecA = decA; let cDecB = decB; let cAmtA = amount_a; let cAmtB = amount_b; const swapped = false;
      // Derive price from sqrt using raw decimals
      let priceFromSqrt = 0;
      if (sqrt_price_x64 > 0 && Number.isFinite(cDecA) && Number.isFinite(cDecB)) {
        const two64 = Math.pow(2, 64);
        const ratio = sqrt_price_x64 / two64;
        // Two reciprocal candidates for A per 1 B:
        // cand1 assumes sqrt encodes B per A: A/B = 10^(decB-decA) / (ratio^2)
        // cand2 assumes sqrt encodes A per B: A/B = (ratio^2) * 10^(decA-decB)
        const cand1 = Math.pow(10, cDecB - cDecA) / (ratio * ratio);
        const cand2 = (ratio * ratio) * Math.pow(10, cDecA - cDecB);
        const finiteCands = [cand1, cand2].filter((x) => Number.isFinite(x) && x > 0) as number[];
        let chosen = finiteCands[0] || 0;
        try {
          const { getPriceByMint } = await import('./priceStore.js');
          const pa = getPriceByMint(cA)?.usdc ?? null;
          const pb = getPriceByMint(cB)?.usdc ?? null;
          // For A-per-B, the USD reference should be price(B)/price(A)
          const refUsd = (pa && pb && (pa as number) > 0 && (pb as number) > 0) ? ((pb as number) / (pa as number)) : null;
          const refIncoming = (incomingPrice && incomingPrice > 0) ? incomingPrice : null;
          const ref = refUsd ?? refIncoming;
          if (ref && finiteCands.length) {
            let best = finiteCands[0];
            let bestDev = Math.max(best / ref, ref / best);
            for (let k = 1; k < finiteCands.length; k += 1) {
              const dev = Math.max(finiteCands[k] / ref, ref / finiteCands[k]);
              if (dev + 1e-12 < bestDev) { bestDev = dev; best = finiteCands[k]; }
            }
            chosen = best;
          }
        } catch {}
        priceFromSqrt = chosen;
      }
      // Incoming API price may be in the opposite orientation; when sqrt and decimals are available,
      // we trust the sqrt-derived A-per-B. Only fall back to incoming when sqrt-derived is unavailable.
      const incomingCanonical = (incomingPrice > 0) ? incomingPrice : 0;
      let priceDerived = priceFromSqrt > 0 ? priceFromSqrt : incomingCanonical;
		  // Compare against incoming price adjusted to canonical orientation if available; aggregate mismatches
		  try {
			if (incomingCanonical > 0 && priceFromSqrt > 0) {
			  const r = incomingCanonical / priceFromSqrt; const dev = Math.max(r, 1 / r);
			  if (dev > 1.1) orientationMismatchCount++;
			}
		  } catch {}
      // Whole amounts from tokenBalanceA/B and decimals
      const wholeA = Number.isFinite(cDecA) ? (cAmtA / Math.pow(10, cDecA as number)) : undefined;
      const wholeB = Number.isFinite(cDecB) ? (cAmtB / Math.pow(10, cDecB as number)) : undefined;
      // Prefer API tvlUsdc directly
      const tvlUsdcRaw = (it as any)?.tvlUsdc;
      const tvlUsdcNum = typeof tvlUsdcRaw === 'string' ? Number(tvlUsdcRaw) : (typeof tvlUsdcRaw === 'number' ? tvlUsdcRaw : 0);
      const tvl_usd = Number.isFinite(tvlUsdcNum) && tvlUsdcNum > 0 ? tvlUsdcNum : undefined;
      const pool_liquidity_raw = (tvl_usd != null)
        ? tvl_usd
        : (Number.isFinite(wholeA as any) && Number.isFinite(wholeB as any)) ? Math.min(wholeA as number, wholeB as number) : undefined;
      const liquidity_display = (tvl_usd != null) ? tvl_usd : undefined;
      // Optional USD sanity for Orca CLMM
      let usdDevOkOrca = true;
      try {
        const sanityCfg = (CONFIG as any)?.sanity || {};
        const apply = (sanityCfg as any).sanity_applyOrcaClmm ?? true;
        if (apply !== false) {
          const maxDeviation = Number.isFinite(Number(sanityCfg.maxPriceDeviation)) ? Number(sanityCfg.maxPriceDeviation) : 50;
          const { getPriceByMint } = await import('./priceStore.js');
          const pa = getPriceByMint(cA)?.usdc ?? null;
          const pb = getPriceByMint(cB)?.usdc ?? null;
          if (pa && pb && priceDerived && (priceDerived as number) > 0) {
            const ref = (pa as number) / (pb as number);
            const dev = Math.max((priceDerived as number) / ref, ref / (priceDerived as number));
            if (dev > maxDeviation) { usdDevOkOrca = false; }
          }
        }
      } catch {}
      if (usdDevOkOrca) {
        clmm.push({ id, dex: 'Orca', mint_a: cA, mint_b: cB, fee_bps, sqrt_price_x64, liquidity, tick_spacing, updated_ms: now, price_a_per_b: priceDerived > 0 ? priceDerived : undefined, amount_a: cAmtA, amount_b: cAmtB, decimals_a: Number.isFinite(cDecA) ? cDecA : undefined, decimals_b: Number.isFinite(cDecB) ? cDecB : undefined, pool_kind: 'clmm', pool_liquidity_raw, tvl_usd, liquidity_display });
      } else {
        try { logger.warn('orca.clmm drop by sanity', { id, mint_a: cA, mint_b: cB, price_a_per_b: priceDerived, cat: 'orca' }); } catch {}
      }
    }
	  }
  // Optional canonicalization of pair order for consistency
  try {
    const mode = String((CONFIG.system as any)?.canonicalizePairs || 'none');
    if (mode === 'lex' && clmm.length) {
      for (let i = 0; i < clmm.length; i++) {
        const p = clmm[i];
        if (String(p.mint_a) <= String(p.mint_b)) continue;
        const inv = (p.price_a_per_b && p.price_a_per_b > 0) ? (1 / (p.price_a_per_b as number)) : p.price_a_per_b;
        clmm[i] = { ...p, mint_a: p.mint_b, mint_b: p.mint_a, price_a_per_b: inv as any };
      }
    }
  } catch {}
  // Emit a single summary warning with the total count of mismatches
	  try { if (orientationMismatchCount > 0) logger.warn('pools.price_orientation_mismatch', { count: orientationMismatchCount, source: 'Orca', cat: 'pools' }); } catch {}
  if (!clmm.length) {
    logger.warn('orca.http normalized 0 clmm', { hint: 'Check inspect log for field presence and pool types' });
  }
  return { amm: [], clmm };
}

async function fetchOrcaV4(): Promise<PoolsPayload> {
  const { Connection, PublicKey, Keypair } = await import('@solana/web3.js');
  // Use v4 client & parsers that understand AdaptiveFee tiers
  const clientMod = await import('@orca-so/whirlpools').catch(() => null);
  if (!clientMod) throw new Error('whirlpools v4 not installed');
  const { buildWhirlpoolClient, WhirlpoolContext, ORCA_WHIRLPOOL_PROGRAM_ID } = clientMod as any;
  const programId = new PublicKey(CONFIG.orca?.programId || ORCA_WHIRLPOOL_PROGRAM_ID);
  const conn = new Connection(CONFIG.rpcUrl, CONFIG.system.txCommitment as any);
  // Dummy wallet for context
  const dummy = Keypair.generate();
  const ctx = WhirlpoolContext.from(conn, { publicKey: dummy.publicKey, signTransaction: async (tx: any) => tx, signAllTransactions: async (txs: any) => txs }, programId);
  const client = buildWhirlpoolClient(ctx);

  const wl = await readJson<any[]>(CONFIG.watchlistPath, []);
  const watchMints: string[] = Array.from(new Set(wl.map((t: any) => (typeof t === 'string' ? t : t?.id)).filter(Boolean)));
  const SOL = 'So11111111111111111111111111111111111111112';
  const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const pairs: Array<[string, string]> = [];
  for (const m of watchMints.slice(0, 50)) { if (m !== USDC) pairs.push([m, USDC]); if (m !== SOL) pairs.push([m, SOL]); }
  pairs.push([SOL, USDC]);
  const tickSpacings = [8, 16, 32, 64, 128, 256];
  const addrs: any[] = [];
  const PDAUtil = (await import('@orca-so/whirlpools-sdk').catch(() => null))?.PDAUtil; // for PDA derivation only
  if (!PDAUtil) throw new Error('PDAUtil missing');
  const clmm: ClmmPool[] = [];
  for (const [a, b] of pairs) {
    const [mintA, mintB] = String(a) < String(b) ? [a, b] : [b, a];
    for (const ts of tickSpacings) {
      try {
        const pda = PDAUtil.getWhirlpool(programId, new PublicKey(CONFIG.orca?.configPubkey), new PublicKey(mintA), new PublicKey(mintB), ts);
        addrs.push(pda.publicKey);
      } catch {}
    }
  }
  const unique = Array.from(new Set(addrs.map((p: any) => p.toBase58()))).map((s) => new PublicKey(s));
  const chunk = 50;
  for (let i = 0; i < unique.length; i += chunk) {
    const slice = unique.slice(i, i + chunk);
    try {
      const pools = await client.getPools(slice);
      for (const pool of pools) {
        try {
          const data = pool.getData();
          const id = pool.getAddress().toBase58();
          const mint_a = data.tokenMintA.toBase58();
          const mint_b = data.tokenMintB.toBase58();
          const sqrt_price_x64 = Number(data.sqrtPrice);
          const liquidity = Number(data.liquidity);
          const tick_spacing = Number(data.tickSpacing);
          // feeRate may be undefined for adaptive; derive bps from feeRate or latest fee tier in state
          const fee_bps = Number((data as any)?.feeRate ?? 0);
          if (sqrt_price_x64 > 0) clmm.push({ id, dex: 'Orca', mint_a, mint_b, fee_bps, sqrt_price_x64, liquidity, tick_spacing, updated_ms: Date.now() });
        } catch (e: any) {
          const msg = String(e?.message || e);
          logger.warn('orca.v4 pool parse failed', { error: msg });
        }
      }
    } catch (e: any) {
      const msg = String(e?.message || e);
      logger.warn('orca.v4 batch failed', { error: msg });
    }
  }
  return { amm: [], clmm };
}

async function fetchOrcaLegacy(): Promise<PoolsPayload> {
  const now = Date.now();
  const clmm: ClmmPool[] = [];
  // Legacy parsers may fail on AdaptiveFee tiers; keep behind explicit mode/fallback
  const legacy = await import('@orca-so/whirlpools-sdk');
  const { Connection, PublicKey } = await import('@solana/web3.js');
  const { PDAUtil, ParsableWhirlpool } = legacy as any;
  const PROGRAM_ID = new PublicKey(CONFIG.orca?.programId || 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
  const CONFIG_PUBKEY = new PublicKey(CONFIG.orca?.configPubkey || '7cSHePZUPCXKmgkkCm1cW8XkyRjB6rQAtv6vZ9VJ4N8S');
  const conn = new Connection(CONFIG.rpcUrl, CONFIG.system.txCommitment as any);
  const wl = await readJson<any[]>(CONFIG.watchlistPath, []);
  const watchMints: string[] = Array.from(new Set(wl.map((t: any) => (typeof t === 'string' ? t : t?.id)).filter(Boolean)));
  const SOL = 'So11111111111111111111111111111111111111112';
  const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const pairs: Array<[string, string]> = [];
  for (const m of watchMints.slice(0, 50)) { if (m !== USDC) pairs.push([m, USDC]); if (m !== SOL) pairs.push([m, SOL]); }
  pairs.push([SOL, USDC]);
  const tickSpacings = [8, 16, 32, 64, 128, 256];
  const addrs: any[] = [];
  for (const [a, b] of pairs) {
    const [mintA, mintB] = String(a) < String(b) ? [a, b] : [b, a];
    for (const ts of tickSpacings) {
      try {
        const pda = PDAUtil.getWhirlpool(PROGRAM_ID, CONFIG_PUBKEY, new PublicKey(mintA), new PublicKey(mintB), ts);
        addrs.push(pda.publicKey);
      } catch {}
    }
  }
  const unique = Array.from(new Set(addrs.map((p: any) => p.toBase58()))).map((s) => new PublicKey(s));
  const chunk = 50;
  for (let i = 0; i < unique.length; i += chunk) {
    const slice = unique.slice(i, i + chunk);
    const infos = await conn.getMultipleAccountsInfo(slice, { commitment: CONFIG.system.txCommitment as any } as any);
    for (let j = 0; j < slice.length; j++) {
      const pk = slice[j];
      const info = infos[j];
      if (!info) continue;
      try {
        const parsed = ParsableWhirlpool.parse(pk, info);
        if (!parsed) continue;
        const data = parsed;
        const id = pk.toBase58();
        const mint_a = data.tokenMintA.toBase58();
        const mint_b = data.tokenMintB.toBase58();
        const sqrt_price_x64 = Number(data.sqrtPrice);
        const liquidity = Number(data.liquidity);
        const tick_spacing = Number(data.tickSpacing);
        const fee_bps = Number(data.feeRate);
        if (sqrt_price_x64 > 0) clmm.push({ id, dex: 'Orca', mint_a, mint_b, fee_bps, sqrt_price_x64, liquidity, tick_spacing, updated_ms: now });
      } catch (e: any) {
        const msg = String(e?.message || e);
        const adaptive = /AdaptiveFee/i.test(msg) || /AdaptiveFeeTier/i.test(msg);
        logger.warn('orca.legacy parse failed', { error: msg, adaptiveFee: adaptive });
      }
    }
  }
  return { amm: [], clmm };
}


