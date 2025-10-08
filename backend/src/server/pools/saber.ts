import { logger } from '../../utils/logger.js';
import { emit } from '../realtime.js';
import { CONFIG } from '../../utils/config.js';
import { writeJson, joinPath } from '../../utils/fs.js';
import type { AmmPool, PoolsPayload } from './types.js';
import { canonicalizePairs } from './common.js';
import { httpLogStart, httpLogResponse, httpLog429, httpLogNonOk } from './httpLog.js';

export async function fetchSaberRegistry(): Promise<any> {
  const SABER_RAW_PATH = joinPath(CONFIG.cacheDir, 'saber-raw-sample.json');
  try {
    const base = (CONFIG as any)?.saber?.registryUrl || 'https://raw.githubusercontent.com/saber-hq/saber-registry/master/pools/mainnet.json';
    const retries = Number(((CONFIG as any)?.saber?.maxHttpRetries) || 2);
    const backoffMs = Number(((CONFIG as any)?.saber?.httpBackoffMs) || 500);
    // eslint-disable-next-line no-undef
    const fetchFn: any = (globalThis as any).fetch || fetch;
    const started = Date.now();
    const cid = httpLogStart({ source: 'saber', url: base });
    let res: any = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      res = await fetchFn(base, { headers: { accept: 'application/json' } });
      if (res?.status === 429) {
        httpLog429({ source: 'saber', url: base, cid });
        await new Promise(r => setTimeout(r, backoffMs * (attempt + 1)));
        continue;
      }
      if (!res?.ok) {
        const txt = await res?.text?.();
        httpLogNonOk({ source: 'saber', url: base, cid, status: res?.status || 0, bodySample: (txt || '').slice(0, 200) });
        if (attempt < retries) { await new Promise(r => setTimeout(r, backoffMs * (attempt + 1))); continue; }
      }
      break;
    }
    const ms = Date.now() - started;
    if (!res?.ok) {
      try { await writeJson(SABER_RAW_PATH, []); } catch {}
      httpLogResponse({ source: 'saber', url: base, cid, status: res?.status || 0, ms, count: 0 });
      return [];
    }
    const json: any = await res.json().catch(() => null);
    const arr = Array.isArray(json) ? json : (Array.isArray(json?.pools) ? json.pools : []);
    try { await writeJson(SABER_RAW_PATH, arr); } catch {}
    httpLogResponse({ source: 'saber', url: base, cid, status: res.status, ms, count: arr.length });
    return arr;
  } catch (e: any) {
    const msg = String(e?.message || e);
    try { logger.warn('saber.http failed', { error: msg, cat: 'pools' }); } catch {}
    return [];
  }
}

export async function normalizeSaberRegistry(raw: any): Promise<PoolsPayload> {
  const now = Date.now();
  const amm: AmmPool[] = [];

  const arrCandidates: any[] = [];
  if (Array.isArray(raw)) arrCandidates.push(raw);
  if (Array.isArray(raw?.pools)) arrCandidates.push(raw.pools);
  const arr: any[] = arrCandidates.find(a => Array.isArray(a) && a.length) || (Array.isArray(raw) ? raw : (Array.isArray(raw?.pools) ? raw.pools : []));

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
  const toFeeBps = (it: any): number => {
    const a = Number(it?.feeBps);
    if (Number.isFinite(a)) return Math.round(a);
    const t = Number(it?.fees?.trade);
    if (Number.isFinite(t)) return t <= 1 ? Math.round(t * 10_000) : Math.round(t);
    return 30;
  };

  for (const it of arr) {
    try {
      const id = String(it?.address || it?.lpMint || it?.poolMint || it?.id || '');
      const ta = it?.tokens?.[0] || it?.tokenA || it?.coin || it?.base || {};
      const tb = it?.tokens?.[1] || it?.tokenB || it?.pc || it?.quote || {};
      const mint_a = toMint(ta) || toMint(ta?.info) || String(it?.mintA || '');
      const mint_b = toMint(tb) || toMint(tb?.info) || String(it?.mintB || '');
      if (!id || !mint_a || !mint_b) continue;

      const decA = toDec(ta?.decimals ?? it?.decimalsA ?? it?.mintADecimals);
      const decB = toDec(tb?.decimals ?? it?.decimalsB ?? it?.mintBDecimals);

      const amtAraw = Number(
        it?.reserveA ??
        it?.reservesA ??
        it?.amountA ??
        it?.tokenAmountA ??
        it?.state?.reserveA ??
        0
      );
      const amtBraw = Number(
        it?.reserveB ??
        it?.reservesB ??
        it?.amountB ??
        it?.tokenAmountB ??
        it?.state?.reserveB ??
        0
      );

      const amount_a_whole = Number.isFinite(Number(it?.amount_a_whole)) ? Number(it?.amount_a_whole) : undefined;
      const amount_b_whole = Number.isFinite(Number(it?.amount_b_whole)) ? Number(it?.amount_b_whole) : undefined;

      const wholeA = Number.isFinite(amount_a_whole as any) ? (amount_a_whole as number) : (Number.isFinite(amtAraw) && Number.isFinite(decA) ? (amtAraw / Math.pow(10, decA as number)) : NaN);
      const wholeB = Number.isFinite(amount_b_whole as any) ? (amount_b_whole as number) : (Number.isFinite(amtBraw) && Number.isFinite(decB) ? (amtBraw / Math.pow(10, decB as number)) : NaN);

      const fee_bps = toFeeBps(it);

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

      const pool: AmmPool = {
        id,
        dex: 'Saber',
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
        liquidity_display: Number.isFinite(liquidity_base) && liquidity_base > 0 ? liquidity_base : undefined,
      };
      amm.push(pool);
    } catch {}
  }

  const ammCanon = canonicalizePairs(amm);
  try { logger.info('saber.http normalized', { amm: ammCanon.length, cat: 'pools' }); } catch {}
  return { amm: ammCanon, clmm: [] };
}


