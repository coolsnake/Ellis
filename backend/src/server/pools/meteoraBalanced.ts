import { logger } from '../../utils/logger.js';
import { emit } from '../realtime.js';
import { CONFIG } from '../../utils/config.js';
import { writeJson, joinPath } from '../../utils/fs.js';
import type { AmmPool, PoolsPayload } from './types.js';
import { canonicalizePairs, validateHttpUrl } from './common.js';
import { httpLogStart, httpLogResponse, httpLog429, httpLogNonOk } from './httpLog.js';

export async function fetchMeteoraBalancedHttp(): Promise<any> {
  const RAW_PATH = joinPath(CONFIG.cacheDir, 'meteora-balanced-raw-sample.json');
  try {
    const baseUnsafe = (CONFIG as any)?.meteoraBalanced?.apiUrl || '';
    const base = validateHttpUrl(baseUnsafe) || '';
    if (!base) { try { await writeJson(RAW_PATH, []); } catch {}; return []; }
    const retries = Number(((CONFIG as any)?.meteoraBalanced?.maxHttpRetries) || 2);
    const backoffMs = Number(((CONFIG as any)?.meteoraBalanced?.httpBackoffMs) || 500);
    const maxPages = Number(((CONFIG as any)?.meteoraBalanced?.maxPages) || 3);
    const size = Number(((CONFIG as any)?.meteoraBalanced?.pageSize) || 200);
    // eslint-disable-next-line no-undef
    const fetchFn: any = (globalThis as any).fetch || fetch;
    // Build candidate bases with a safe v1->v2 fallback for DAMM
    const candidates: string[] = (() => {
      const list = [base];
      try {
        if (/\/v1\/pairs(\/?$|\?)/.test(base)) {
          const v2 = base.replace('/v1/pairs', '/v2/pairs');
          if (v2 !== base) list.push(v2);
        }
      } catch {}
      return list;
    })();

    for (const baseCandidate of candidates) {
      const out: any[] = [];
      let page = 0;
      for (let i = 0; i < (maxPages && maxPages > 0 ? maxPages : Number.POSITIVE_INFINITY); i++) {
        const url = (() => {
          const sp = new URLSearchParams();
          if (Number.isFinite(size) && size > 0) sp.append('limit', String(size));
          sp.append('page', String(page));
          const qs = sp.toString();
          return qs ? `${baseCandidate}?${qs}` : baseCandidate;
        })();
        const started = Date.now();
        const cid = httpLogStart({ source: 'meteora_balanced', url });
        let res: any = null; let ok = false;
        for (let attempt = 0; attempt <= retries; attempt++) {
          res = await fetchFn(url, { headers: { accept: 'application/json' } });
          if (res?.status === 429) { httpLog429({ source: 'meteora_balanced', url, cid }); await new Promise(r => setTimeout(r, backoffMs * (attempt + 1))); continue; }
          if (!res?.ok) {
            const txt = await res?.text?.();
            httpLogNonOk({ source: 'meteora_balanced', url, cid, status: res?.status || 0, bodySample: (txt || '').slice(0, 200) });
            if (attempt < retries) { await new Promise(r => setTimeout(r, backoffMs * (attempt + 1))); continue; }
          }
          ok = true; break;
        }
        const ms = Date.now() - started;
        if (!ok || !res?.ok) { httpLogResponse({ source: 'meteora_balanced', url, cid, status: res?.status || 0, ms, count: 0 }); break; }
        const json: any = await res.json().catch(() => null);
        const data = Array.isArray(json) ? json : (Array.isArray(json?.data) ? json.data : []);
        out.push(...data);
        httpLogResponse({ source: 'meteora_balanced', url, cid, status: res.status, ms, count: data.length });
        if (!json?.next && !json?.hasNextPage) break;
        page += 1;
      }
      if (out.length > 0) {
        try { await writeJson(RAW_PATH, out); } catch {}
        return out;
      }
      // If this candidate produced nothing, try next candidate (e.g., v2)
    }
    // If all candidates failed/empty, return []
    try { await writeJson(RAW_PATH, []); } catch {}
    return [];
  } catch {
    return [];
  }
}

export async function normalizeMeteoraBalancedHttp(raw: any): Promise<PoolsPayload> {
  const now = Date.now();
  const amm: AmmPool[] = [];

  const arrCandidates: any[] = [];
  if (Array.isArray(raw)) arrCandidates.push(raw);
  if (Array.isArray(raw?.data)) arrCandidates.push(raw.data);
  const arr: any[] = arrCandidates.find(a => Array.isArray(a) && a.length) || (Array.isArray(raw) ? raw : (Array.isArray(raw?.data) ? raw.data : []));

  const toMint = (v: any): string => {
    if (!v) return '';
    if (typeof v === 'string') return v;
    if (v?.mint) return String(v.mint);
    if (v?.address) return String(v.address);
    return '';
  };
  const toDec = (v: any): number | undefined => {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const toFeeBps = (v: any): number => {
    const n = Number(v?.feeRate ?? v?.tradeFeeBps ?? v?.feeBps);
    if (!Number.isFinite(n)) return 30;
    return n <= 1 ? Math.round(n * 10_000) : Math.round(n);
  };

  for (const it of arr) {
    try {
      const id = String(it?.address || it?.id || '');
      const a = it?.tokenA || it?.mintA || it?.base || {};
      const b = it?.tokenB || it?.mintB || it?.quote || {};
      const mint_a = toMint(a) || toMint(a?.info) || String(it?.mintA || '');
      const mint_b = toMint(b) || toMint(b?.info) || String(it?.mintB || '');
      if (!id || !mint_a || !mint_b) continue;

      const decA = toDec(a?.decimals ?? it?.decimalsA);
      const decB = toDec(b?.decimals ?? it?.decimalsB);
      const amtAraw = Number(it?.reserveA ?? it?.amountA ?? it?.tokenAmountA ?? 0);
      const amtBraw = Number(it?.reserveB ?? it?.amountB ?? it?.tokenAmountB ?? 0);
      const tvl_usd = Number(it?.tvlUsd ?? it?.tvl_usd);
      const fee_bps = toFeeBps(it);

      const wholeA = (Number.isFinite(amtAraw) && Number.isFinite(decA)) ? (amtAraw / Math.pow(10, decA as number)) : NaN;
      const wholeB = (Number.isFinite(amtBraw) && Number.isFinite(decB)) ? (amtBraw / Math.pow(10, decB as number)) : NaN;

      let price_a_per_b = 0;
      if (Number.isFinite(wholeA) && Number.isFinite(wholeB) && (wholeB as number) > 0) {
        price_a_per_b = (wholeA as number) / (wholeB as number);
      } else {
        const p = Number(it?.price ?? it?.price_a_per_b ?? it?.priceAperB);
        if (Number.isFinite(p) && p > 0) price_a_per_b = p;
      }

      const liquidity_base = (Number.isFinite(wholeA) && Number.isFinite(wholeB))
        ? Math.min(wholeA as number, wholeB as number)
        : 0;

      amm.push({
        id,
        dex: 'Meteora',
        mint_a,
        mint_b,
        fee_bps,
        price_a_per_b: Number.isFinite(price_a_per_b) ? price_a_per_b : 0,
        liquidity_base,
        updated_ms: now,
        pool_kind: 'amm',
        amount_a_whole: Number.isFinite(wholeA) ? wholeA as number : undefined,
        amount_b_whole: Number.isFinite(wholeB) ? wholeB as number : undefined,
        amounts_are_whole: Number.isFinite(wholeA) || Number.isFinite(wholeB) ? true : undefined,
        decimals_a: Number.isFinite(decA as any) ? (decA as number) : undefined,
        decimals_b: Number.isFinite(decB as any) ? (decB as number) : undefined,
        tvl_usd: Number.isFinite(tvl_usd) && tvl_usd > 0 ? tvl_usd : undefined,
        liquidity_display: Number.isFinite(tvl_usd) && tvl_usd > 0 ? tvl_usd : (liquidity_base > 0 ? liquidity_base : undefined),
      });
    } catch {}
  }

  const ammCanon = canonicalizePairs(amm);
  try { logger.info('meteora.balanced normalized', { amm: ammCanon.length, cat: 'meteora' }); } catch {}
  return { amm: ammCanon, clmm: [] };
}

// New: explicit v1 and v2 HTTP fetchers and a union fetch for both
export async function fetchMeteoraBalancedV1Http(baseUrl?: string): Promise<any[]> {
  const cfg: any = (CONFIG as any)?.meteoraBalanced || {};
  const baseUnsafe = baseUrl || cfg.apiUrl || '';
  const base = validateHttpUrl(baseUnsafe) || '';
  if (!base) return [];
  const retries = Number(cfg.maxHttpRetries || 2);
  const backoffMs = Number(cfg.httpBackoffMs || 500);
  const maxPages = Number(cfg.maxPages || 3);
  const size = Number(cfg.pageSize || 200);
  // eslint-disable-next-line no-undef
  const fetchFn: any = (globalThis as any).fetch || fetch;
  const out: any[] = [];
  let page = 0;
  for (let i = 0; i < (maxPages && maxPages > 0 ? maxPages : Number.POSITIVE_INFINITY); i++) {
    const url = (() => {
      const sp = new URLSearchParams();
      if (Number.isFinite(size) && size > 0) sp.append('limit', String(size));
      sp.append('page', String(page));
      const qs = sp.toString();
      return qs ? `${base}?${qs}` : base;
    })();
    const cid = httpLogStart({ source: 'meteora_balanced', url });
    let res: any = null; let ok = false;
    for (let attempt = 0; attempt <= retries; attempt++) {
      res = await fetchFn(url, { headers: { accept: 'application/json' } });
      if (res?.status === 429) { httpLog429({ source: 'meteora_balanced', url, cid }); await new Promise(r => setTimeout(r, backoffMs * (attempt + 1))); continue; }
      if (!res?.ok) {
        const txt = await res?.text?.();
        httpLogNonOk({ source: 'meteora_balanced', url, cid, status: res?.status || 0, bodySample: (txt || '').slice(0, 200) });
        if (attempt < retries) { await new Promise(r => setTimeout(r, backoffMs * (attempt + 1))); continue; }
      }
      ok = true; break;
    }
    if (!ok || !res?.ok) { httpLogResponse({ source: 'meteora_balanced', url, cid, status: res?.status || 0, ms: 0, count: 0 }); break; }
    const json: any = await res.json().catch(() => null);
    const data = Array.isArray(json) ? json : (Array.isArray(json?.data) ? json.data : []);
    out.push(...data);
    httpLogResponse({ source: 'meteora_balanced', url, cid, status: res.status, ms: 0, count: data.length });
    if (!json?.next && !json?.hasNextPage) break;
    page += 1;
  }
  return out;
}

export async function fetchMeteoraBalancedV2Http(baseUrl?: string): Promise<any[]> {
  const cfg: any = (CONFIG as any)?.meteoraBalanced || {};
  const baseUnsafe = baseUrl || cfg.apiUrlV2 || '';
  const base = validateHttpUrl(baseUnsafe) || '';
  if (!base) return [];
  const retries = Number(cfg.maxHttpRetries || 2);
  const backoffMs = Number(cfg.httpBackoffMs || 500);
  const maxPages = Number(cfg.maxPages || 3);
  const size = Number(cfg.pageSize || 200);
  // eslint-disable-next-line no-undef
  const fetchFn: any = (globalThis as any).fetch || fetch;
  const out: any[] = [];
  let page = 0;
  for (let i = 0; i < (maxPages && maxPages > 0 ? maxPages : Number.POSITIVE_INFINITY); i++) {
    const url = (() => {
      const sp = new URLSearchParams();
      if (Number.isFinite(size) && size > 0) sp.append('limit', String(size));
      sp.append('page', String(page));
      const qs = sp.toString();
      return qs ? `${base}?${qs}` : base;
    })();
    const cid = httpLogStart({ source: 'meteora_balanced_v2', url });
    let res: any = null; let ok = false;
    for (let attempt = 0; attempt <= retries; attempt++) {
      res = await fetchFn(url, { headers: { accept: 'application/json' } });
      if (res?.status === 429) { httpLog429({ source: 'meteora_balanced_v2', url, cid }); await new Promise(r => setTimeout(r, backoffMs * (attempt + 1))); continue; }
      if (!res?.ok) {
        const txt = await res?.text?.();
        httpLogNonOk({ source: 'meteora_balanced_v2', url, cid, status: res?.status || 0, bodySample: (txt || '').slice(0, 200) });
        if (attempt < retries) { await new Promise(r => setTimeout(r, backoffMs * (attempt + 1))); continue; }
      }
      ok = true; break;
    }
    if (!ok || !res?.ok) { httpLogResponse({ source: 'meteora_balanced_v2', url, cid, status: res?.status || 0, ms: 0, count: 0 }); break; }
    const json: any = await res.json().catch(() => null);
    const data = Array.isArray(json) ? json : (Array.isArray(json?.data) ? json.data : []);
    out.push(...data);
    httpLogResponse({ source: 'meteora_balanced_v2', url, cid, status: res.status, ms: 0, count: data.length });
    if (!json?.next && !json?.hasNextPage) break;
    page += 1;
  }
  return out;
}

export async function fetchMeteoraBalancedAll(): Promise<PoolsPayload> {
  const v2 = await fetchMeteoraBalancedV2Http();
  const v1 = await fetchMeteoraBalancedV1Http();
  const normV2 = await normalizeMeteoraBalancedHttp(v2);
  const normV1 = await normalizeMeteoraBalancedHttp(v1);
  const combinedAmm = mergeBalancedPools(normV2.amm, normV1.amm);
  const ammCanon = canonicalizePairs(combinedAmm);
  return { amm: ammCanon, clmm: [] } as any;
}

export function mergeBalancedPools(v2: AmmPool[], v1: AmmPool[]): AmmPool[] {
  const byKey = new Map<string, AmmPool>();
  const makeKey = (p: AmmPool): string => {
    const id = String((p as any).id || '');
    if (id) return `id:${id}`;
    const a = String((p as any).mint_a || '');
    const b = String((p as any).mint_b || '');
    const [x, y] = a <= b ? [a, b] : [b, a];
    return `pair:${x}:${y}`;
  };
  for (const p of (v1 || [])) {
    const k = makeKey(p);
    if (!byKey.has(k)) byKey.set(k, p);
  }
  for (const p of (v2 || [])) {
    const k = makeKey(p);
    byKey.set(k, p); // prefer/override with v2
  }
  return Array.from(byKey.values());
}


