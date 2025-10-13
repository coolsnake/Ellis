import { logger } from '../../utils/logger.js';
import { emit } from '../realtime.js';
import { CONFIG } from '../../utils/config.js';
import { writeJson, joinPath } from '../../utils/fs.js';
import type { ClmmPool, PoolsPayload } from './types.js';
import { canonicalizePairs, validateHttpUrl } from './common.js';
import { httpLogStart, httpLogResponse, httpLog429, httpLogNonOk } from './httpLog.js';

export async function fetchMeteoraHttp(): Promise<any> {
  const METEORA_RAW_PATH = joinPath(CONFIG.cacheDir, 'meteora-raw-sample.json');
  try {
    const baseUnsafe = (CONFIG as any)?.meteora?.apiUrl || 'https://dlmm-api.meteora.ag/pair/all_with_pagination';
    const baseResolved = validateHttpUrl(baseUnsafe) || 'https://dlmm-api.meteora.ag/pair/all_with_pagination';
    const size = Number(((CONFIG as any)?.meteora?.pageSize) || 200);
    const retries = Number(((CONFIG as any)?.meteora?.maxHttpRetries) || 2);
    const backoffMs = Number(((CONFIG as any)?.meteora?.httpBackoffMs) || 500);
    const maxPages = Number(((CONFIG as any)?.meteora?.maxPages) || 3);
    const candidates: string[] = (() => {
      const list: string[] = [];
      try {
        const b = baseResolved;
        // Prefer all_with_pagination; add v1/pairs as secondary if user gave that
        if (/\/v1\/pairs(\/?.*)?$/.test(b)) {
          list.push(b);
          const alt = b.replace('/v1/pairs', '/pair/all_with_pagination');
          if (alt && alt !== b) list.push(alt);
        } else {
          list.push(b);
          const maybeV1 = b.replace('/pair/all_with_pagination', '/v1/pairs');
          if (maybeV1 && maybeV1 !== b) list.push(maybeV1);
        }
      } catch { list.push(baseResolved); }
      return Array.from(new Set(list.filter(Boolean)));
    })();
    const build = (baseUrl: string, page: number, limit: number) => {
      const sp = new URLSearchParams();
      sp.append('page', String(Math.max(0, page)));
      if (Number.isFinite(limit as any) && limit > 0) sp.append('limit', String(limit));
      const qs = sp.toString();
      return qs ? `${baseUrl}?${qs}` : baseUrl;
    };
    // eslint-disable-next-line no-undef
    const fetchFn: any = (globalThis as any).fetch || fetch;
    for (const base of candidates) {
      // Pagination loop on this base
      const out: any[] = [];
      let page = 0;
      const pageLimit = (maxPages && maxPages > 0) ? maxPages : Number.POSITIVE_INFINITY;
      for (let i = 0; i < pageLimit; i++) {
        let ok = false;
        for (let attempt = 0; attempt <= retries; attempt++) {
          try {
            const url = build(base, page, size);
            const cid = httpLogStart({ source: 'meteora', url, extra: { page, limit: size } });
            const res = await fetchFn(url, { headers: { accept: 'application/json' }, method: 'GET' });
            if (res?.status === 429) { try { logger.warn('meteora.http 429', { page, cat: 'meteora' }); emit('log', { level: 'warn', message: `arb:429 source=meteora page=${page}`, timestamp: new Date().toISOString(), context: { cat: 'arb' } }); } catch {}; httpLog429({ source: 'meteora', url, cid }); throw new Error('http 429'); }
            if (!res?.ok) throw new Error(`http ${res?.status}`);
            const json: any = await res.json().catch(() => null);
            const arr: any[] = Array.isArray(json?.pairs) ? json.pairs : (Array.isArray(json) ? json : (Array.isArray(json?.data) ? json.data : []));
            const more = Array.isArray(arr) && arr.length >= size;
            out.push(...(arr || []));
            page += 1;
            ok = true;
            if (!more) { i = pageLimit; break; }
            httpLogResponse({ source: 'meteora', url, cid, status: res.status, ms: 0, count: arr.length });
            break;
          } catch (e: any) {
            const msg = String(e?.message || e);
            if (/429/.test(msg)) { await new Promise(r => setTimeout(r, backoffMs * (attempt + 1))); continue; }
            if (attempt < retries) await new Promise(r => setTimeout(r, backoffMs * (attempt + 1)));
          }
        }
        if (!ok) break;
      }
      if (out.length > 0) {
        try { await writeJson(METEORA_RAW_PATH, out); } catch (e: any) { try { logger.warn('meteora.cache write failed', { file: METEORA_RAW_PATH, error: String(e?.message || e), cat: 'meteora' }); } catch {} }
        try { logger.info('meteora.http raw', { count: out.length, cat: 'meteora' }); } catch {}
        return out;
      }
      // else try next candidate
    }
    // If all candidates failed, attempt one last single GET on primary base with paging
    const url = build(baseResolved, 0, size);
    const res = await fetchFn(url, { headers: { accept: 'application/json' }, method: 'GET' });
    if (!res?.ok) throw new Error(`http ${res?.status}`);
    const json: any = await res.json().catch(() => null);
    const single = Array.isArray(json?.pairs) ? json.pairs : (Array.isArray(json) ? json : (Array.isArray(json?.data) ? json.data : []));
    try { httpLogResponse({ source: 'meteora', url, cid: `http-${Date.now()}`, status: res.status, ms: 0, count: single.length }); } catch {}
    try { await writeJson(METEORA_RAW_PATH, single); } catch (e: any) { try { logger.warn('meteora.cache write failed', { file: METEORA_RAW_PATH, error: String(e?.message || e), cat: 'meteora' }); } catch {} }
    return single;
  } catch {
    return [];
  }
}

export async function normalizeMeteoraHttp(raw: any): Promise<PoolsPayload> {
  const now = Date.now();
  const clmm: ClmmPool[] = [];
  let jupMap: Record<string, { symbol: string; decimals: number }> = {};
  try { const tok = await import('../../utils/tokens.js'); if (typeof (tok as any).loadJupiterTokenMap === 'function') jupMap = await (tok as any).loadJupiterTokenMap(); } catch {}
  const arrCandidates: any[] = [];
  if (Array.isArray(raw?.pairs)) arrCandidates.push(raw.pairs);
  if (Array.isArray(raw)) arrCandidates.push(raw);
  if (Array.isArray(raw?.data)) arrCandidates.push(raw.data);
  const arr: any[] = arrCandidates.find(a => Array.isArray(a) && a.length) || (Array.isArray(raw?.pairs) ? raw.pairs : (Array.isArray(raw) ? raw : (Array.isArray(raw?.data) ? raw.data : [])));
  for (const it of arr) {
    const id = String(it?.address || it?.id || it?.poolAddress || '');
    const tokenA = it?.tokenA || it?.tokenX || {};
    const tokenB = it?.tokenB || it?.tokenY || {};
    let mint_a = String(it?.mint_x || tokenA?.mint || it?.mintA || it?.tokenXMint || '');
    let mint_b = String(it?.mint_y || tokenB?.mint || it?.mintB || it?.tokenYMint || '');
    if (!id || !mint_a || !mint_b) continue;
    let decA = Number((tokenA?.decimals ?? it?.decimalsA));
    let decB = Number((tokenB?.decimals ?? it?.decimalsB));
    if (!Number.isFinite(decA) && jupMap[mint_a]?.decimals != null) decA = Number(jupMap[mint_a].decimals);
    if (!Number.isFinite(decB) && jupMap[mint_b]?.decimals != null) decB = Number(jupMap[mint_b].decimals);
    // Fallback: fetch decimals on-chain if still unknown
    try {
      if (!Number.isFinite(decA)) {
        const tok = await import('../../utils/tokens.js');
        const r = await (tok as any).resolveMint(mint_a);
        if (Number.isFinite(Number(r?.decimals))) decA = Number(r.decimals);
      }
      if (!Number.isFinite(decB)) {
        const tok = await import('../../utils/tokens.js');
        const r = await (tok as any).resolveMint(mint_b);
        if (Number.isFinite(Number(r?.decimals))) decB = Number(r.decimals);
      }
    } catch {}
    // Enforce authoritative decimals from Jupiter list, then anchors, then clamp
    try {
      const jDecA = Number(jupMap[mint_a]?.decimals);
      const jDecB = Number(jupMap[mint_b]?.decimals);
      if (Number.isFinite(jDecA)) decA = jDecA;
      if (Number.isFinite(jDecB)) decB = jDecB;
      if (mint_a === 'So11111111111111111111111111111111111111112') decA = 9;
      if (mint_b === 'So11111111111111111111111111111111111111112') decB = 9;
      if (mint_a === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') decA = 6;
      if (mint_b === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') decB = 6;
      if (mint_a === 'Es9vMFrzaCERfCkS7fGXx9bK6A7bP4J1yDrJZGB48JpN') decA = 6;
      if (mint_b === 'Es9vMFrzaCERfCkS7fGXx9bK6A7bP4J1yDrJZGB48JpN') decB = 6;
      decA = Math.min(12, Math.max(0, Math.round(Number(decA))));
      decB = Math.min(12, Math.max(0, Math.round(Number(decB))));
    } catch {}
    const feeBasePctRaw: any = (it as any)?.base_fee_percentage;
    let fee_bps = 0;
    if (feeBasePctRaw != null) {
      const val = Number(feeBasePctRaw);
      if (Number.isFinite(val)) fee_bps = val <= 1 ? Math.round(val * 10_000) : Math.round(val * 100);
    } else {
      const feeRaw = (it as any)?.feeRate ?? (it as any)?.fee_bps;
      if (typeof feeRaw === 'number') fee_bps = feeRaw <= 1 ? Math.round(feeRaw * 10_000) : Math.round(feeRaw);
    }
    let price_a_per_b = Number((it as any)?.current_price ?? (it as any)?.price ?? (it as any)?.price_a_per_b ?? 0);
    const amtAraw = (it?.reserve_x_amount ?? it?.tokenBalanceA ?? it?.tokenAAmount ?? it?.amountA ?? it?.baseAmount ?? 0);
    const amtBraw = (it?.reserve_y_amount ?? it?.tokenBalanceB ?? it?.tokenBAmount ?? it?.amountB ?? it?.quoteAmount ?? 0);
    let amount_a = Number(typeof amtAraw === 'string' ? Number(amtAraw) : amtAraw || 0);
    let amount_b = Number(typeof amtBraw === 'string' ? Number(amtBraw) : amtBraw || 0);
    const tvlUsdcRaw = (it as any)?.tvlUsdc ?? (it as any)?.tvlUsd ?? (it as any)?.liquidity;
    const tvlUsdcNum = typeof tvlUsdcRaw === 'string' ? Number(tvlUsdcRaw) : (typeof tvlUsdcRaw === 'number' ? tvlUsdcRaw : 0);
    const tvl_usd = Number.isFinite(tvlUsdcNum) && tvlUsdcNum > 0 ? tvlUsdcNum : undefined;
    const pool_liquidity_raw = (tvl_usd != null)
      ? tvl_usd
      : (Number.isFinite(decA) && Number.isFinite(decB)
          ? Math.min((amount_a/Math.pow(10, decA as number)), (amount_b/Math.pow(10, decB as number)))
          : undefined);
    const liquidity_display = (tvl_usd != null) ? tvl_usd : undefined;
    // Derive A-per-1-B from active bin; tests expect active bin precedence over current_price
    try {
      const activeId = Number((it as any)?.active_id ?? (it as any)?.activeId);
      const binStep = Number((it as any)?.bin_step ?? (it as any)?.binStep);
      if (Number.isFinite(activeId) && Number.isFinite(binStep) && Number.isFinite(decA) && Number.isFinite(decB)) {
        const f = Math.pow(1.0001, binStep);
        if (f > 0) {
          // Two candidates depending on vendor orientation; pick by USD ref later
          const bPerA = Math.pow(f, activeId) * Math.pow(10, (decA as number) - (decB as number));
          const aPerB1 = bPerA > 0 ? (1 / bPerA) : 0; // A per 1 B via reciprocal
          const aPerB2 = bPerA; // treat directly as A per 1 B (alt)
          const cand: number[] = [];
          if (aPerB1 > 0 && Number.isFinite(aPerB1)) cand.push(aPerB1);
          if (aPerB2 > 0 && Number.isFinite(aPerB2)) cand.push(aPerB2);
          if (cand.length) {
            // Defer choosing until USD ref selection below; stash best for now
            price_a_per_b = cand[0];
          }
        }
      }
    } catch {}
    // Fallback: derive from reserves/decimals if active-bin price not set
    try {
      const haveDecs = Number.isFinite(decA) && Number.isFinite(decB);
      const wholeA = haveDecs && Number.isFinite(amount_a) ? (amount_a / Math.pow(10, decA as number)) : NaN;
      const wholeB = haveDecs && Number.isFinite(amount_b) ? (amount_b / Math.pow(10, decB as number)) : NaN;
      if (!(price_a_per_b > 0) && Number.isFinite(wholeA) && Number.isFinite(wholeB) && (wholeB as number) > 0) {
        const derived = (wholeA as number) / (wholeB as number);
        if (derived > 0 && Number.isFinite(derived)) price_a_per_b = derived;
      }
    } catch {}
    // Prefer candidate closer to USD ref between active-bin and incoming price
    try {
      const { getPriceByMint } = await import('../../server/priceStore.js');
      const pa = getPriceByMint(mint_a)?.usdc ?? null;
      const pb = getPriceByMint(mint_b)?.usdc ?? null;
      const ref = (pa && pb && (pa as number) > 0 && (pb as number) > 0) ? ((pb as number) / (pa as number)) : undefined;
      const cand: number[] = [];
      if (Number.isFinite(price_a_per_b) && price_a_per_b > 0) cand.push(price_a_per_b);
      // If we computed two possible A/B candidates above, include reciprocal too
      try { if (Number.isFinite(price_a_per_b) && price_a_per_b > 0) { const inv = 1 / (price_a_per_b as number); if (inv > 0 && Number.isFinite(inv)) cand.push(inv); } } catch {}
      if (ref && cand.length) {
        let best = cand[0];
        let bestDev = Math.max(best / (ref as number), (ref as number) / best);
        for (let i = 1; i < cand.length; i++) {
          const v = cand[i];
          const d = Math.max(v / (ref as number), (ref as number) / v);
          if (d + 1e-12 < bestDev) { bestDev = d; best = v; }
        }
        price_a_per_b = best;
      }
    } catch {}
    // Stable-aware orientation flip here is redundant with canonicalizePairs; avoid double flipping
    try {
      const { getPriceByMint } = await import('../../server/priceStore.js');
      const getUsd = (m: string) => { try { return getPriceByMint(m)?.usdc ?? undefined; } catch { return undefined; } };
      const { calibrateMagnitude } = await import('../../server/priceCalib.js');
      const calibrated = calibrateMagnitude(mint_a, mint_b, price_a_per_b, getUsd);
      if (calibrated && calibrated > 0) price_a_per_b = calibrated;
    } catch {}
    let price_ok = true;
    try {
      const sanityCfg = (CONFIG as any)?.sanity || {};
      const apply = (sanityCfg as any).sanity_applyMeteoraClmm ?? true;
      if (apply !== false) {
        const baseMaxDev = Number.isFinite(Number((sanityCfg as any).maxPriceDeviationClmm)) ? Number((sanityCfg as any).maxPriceDeviationClmm)
          : (Number.isFinite(Number(sanityCfg.maxPriceDeviation)) ? Number(sanityCfg.maxPriceDeviation) : 5);
        const { getPriceByMint } = await import('../../server/priceStore.js');
        const pa = getPriceByMint(mint_a)?.usdc ?? null;
        const pb = getPriceByMint(mint_b)?.usdc ?? null;
        const px = (price_a_per_b && price_a_per_b > 0) ? price_a_per_b : undefined;
        if (pa && pb && px && (px as number) > 0) {
          const SOL = 'So11111111111111111111111111111111111111112';
          const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
          const isAnchor = (mint_a === SOL && mint_b === USDC) || (mint_a === USDC && mint_b === SOL);
          const maxDeviation = isAnchor ? Math.max(baseMaxDev, 100) : baseMaxDev;
          const ref = (pb as number) / (pa as number);
          const dev = Math.max((px as number) / ref, ref / (px as number));
          if (dev > maxDeviation) price_ok = false;
        }
      }
    } catch {}
    if (!price_ok) { try { logger.warn('meteora.clmm drop by sanity', { id, mint_a, mint_b, price_a_per_b, cat: 'meteora' }); } catch {}; continue; }
    
    clmm.push({ id, dex: 'Meteora', mint_a, mint_b, fee_bps, sqrt_price_x64: 0, liquidity: 0, tick_spacing: Number((it as any)?.bin_step || (it as any)?.binStep || 0), updated_ms: now, price_a_per_b: (price_a_per_b && price_a_per_b > 0) ? price_a_per_b : undefined, amount_a, amount_b, decimals_a: Number.isFinite(decA) ? decA : undefined, decimals_b: Number.isFinite(decB) ? decB : undefined, pool_kind: 'clmm', pool_liquidity_raw, tvl_usd, liquidity_display } as any);
  }
  // Canonicalize pairs using unified policy; handles A/B swap and price inversion when needed
  const clmmCanon = canonicalizePairs(clmm);
  try {
    const canon = String(((CONFIG as any)?.system?.canonicalizePairs) || 'lex');
    logger.info('meteora.http normalized', { clmm: clmmCanon.length, cat: 'meteora', canon });
  } catch {}
  return { amm: [], clmm: clmmCanon };
}


