import { logger } from '../../utils/logger.js';
import { emit } from '../realtime.js';
import { CONFIG } from '../../utils/config.js';
import { readJson, writeJson, joinPath } from '../../utils/fs.js';
import type { AmmPool, ClmmPool, PoolsPayload } from './types.js';
import { canonicalizePairs } from './common.js';

let rayProbeOffset = 0;

export async function fetchRaydiumPoolsRaw(): Promise<any> {
  const mode = 'http';
  try {
    const RAYDIUM_RAW_PATH = joinPath(CONFIG.cacheDir, 'raydium-raw-sample.json');
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
    // eslint-disable-next-line no-undef
    const fetchFn: any = (globalThis as any).fetch || fetch;
    if (!fetchFn) {
      logger.warn('raydium.http fetch unavailable on this runtime');
      return { data: [] };
    }

    // Collect mint universe from configured tokenUniverseMode; fallback to Jupiter token map, then watchlist
    let mints: string[] = [];
    try {
      const { computeTokenUniverse } = await import('../universe.js');
      const uni = await computeTokenUniverse((CONFIG.system as any)?.tokenUniverseMode);
      mints = Array.from(uni);
    } catch {}
    if (!mints.length) {
      try {
        const { loadJupiterTokenMap } = await import('../../utils/tokens.js');
        const jmap = await loadJupiterTokenMap();
        mints = Object.keys(jmap || {});
      } catch {}
    }
    if (!mints.length) {
      const wl = await readJson<any[]>(CONFIG.watchlistPath, []);
      mints = wl.map((t: any) => (typeof t === 'string' ? t : t?.id)).filter(Boolean);
    }

    const limit = Math.max(1, Number(CONFIG.raydium?.sdkProbeMintsLimit || 50));
    const uniqAll = Array.from(new Set(mints));
    const start = uniqAll.length > 0 ? (rayProbeOffset % uniqAll.length) : 0;
    const end = start + limit;
    const uniq = uniqAll.length <= limit
      ? uniqAll
      : (end <= uniqAll.length ? uniqAll.slice(start, end) : uniqAll.slice(start).concat(uniqAll.slice(0, end - uniqAll.length)));
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
            if ((CONFIG as any)?.poolsMetrics?.raydium?.backoffMs > 0) await sleep((CONFIG as any).poolsMetrics.raydium.backoffMs); else await sleep(150 + Math.floor(Math.random() * 150));
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
              try { emit('log', { level: 'warn', message: 'arb:429 source=raydium kind=http surface=pools.info', timestamp: new Date().toISOString(), context: { cat: 'arb' } }); } catch {}
              try { logger.warn('raydium.http 429', { mint, page, cat: 'raydium' }); } catch {}
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
      try { await writeJson(RAYDIUM_RAW_PATH, { data: collected }); } catch (e: any) { try { logger.warn('raydium.cache write failed', { file: RAYDIUM_RAW_PATH, error: String(e?.message || e), cat: 'raydium' }); } catch {} }
      return { data: collected };
    }
    logger.warn('raydium.http returned 0');
    try { await writeJson(RAYDIUM_RAW_PATH, { data: [] }); } catch (e: any) { try { logger.warn('raydium.cache write failed', { file: RAYDIUM_RAW_PATH, error: String(e?.message || e), cat: 'raydium' }); } catch {} }
    return { data: [] };
  } catch (e: any) {
    const msg = String(e?.message || e);
    logger.warn('raydium.http failed', { error: msg, cat: 'raydium' });
    try { await writeJson(joinPath(CONFIG.cacheDir, 'raydium-raw-sample.json'), { data: [] }); } catch (e2: any) { try { logger.warn('raydium.cache write failed', { file: joinPath(CONFIG.cacheDir, 'raydium-raw-sample.json'), error: String(e2?.message || e2), cat: 'raydium' }); } catch {} }
    return { data: [] };
  }
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
      let price_from_sqrt = 0;
      try {
        if (sqrt > 0 && Number.isFinite(decA) && Number.isFinite(decB)) {
          const two64 = Math.pow(2, 64);
          const ratio = sqrt / two64;
          const cand1 = Math.pow(10, (decB as number) - (decA as number)) / (ratio * ratio);
          const cand2 = (ratio * ratio) * Math.pow(10, (decA as number) - (decB as number));
          const finite = [cand1, cand2].filter((x) => Number.isFinite(x) && x > 0) as number[];
          let chosen = finite[0] || 0;
          try {
            const { getPriceByMint } = await import('../priceStore.js');
            const pa = getPriceByMint(mintA)?.usdc ?? null;
            const pb = getPriceByMint(mintB)?.usdc ?? null;
            const incoming = Number(price) > 0 ? Number(price) : undefined;
            const refUsd = (pa && pb && (pa as number) > 0 && (pb as number) > 0) ? ((pb as number) / (pa as number)) : undefined;
            const refs = [refUsd, incoming].filter((v) => Number.isFinite(v as any) && (v as number) > 0) as number[];
            if (refs.length && finite.length) {
              let best = finite[0];
              let bestDev = Number.POSITIVE_INFINITY;
              for (const cand of finite) {
                for (const ref of refs) {
                  const dev = Math.max(cand / ref, ref / cand);
                  if (dev + 1e-12 < bestDev) { bestDev = dev; best = cand; }
                }
              }
              chosen = best;
            }
          } catch {}
          price_from_sqrt = chosen;
        }
      } catch {}
      let px = price_from_sqrt > 0 ? price_from_sqrt : (Number(price) > 0 ? Number(price) : 0);
      let ok = true;
      try {
        const sanityCfg = (CONFIG as any)?.sanity || {};
        const apply = (sanityCfg as any).sanity_applyRaydiumClmm ?? true;
        if (apply !== false && px > 0) {
          const maxDeviation = Number.isFinite(Number(sanityCfg.maxPriceDeviation)) ? Number(sanityCfg.maxPriceDeviation) : 50;
          const { getPriceByMint } = await import('../priceStore.js');
          const pa = getPriceByMint(mintA)?.usdc ?? null;
          const pb = getPriceByMint(mintB)?.usdc ?? null;
          if (pa && pb && (pa as number) > 0 && (pb as number) > 0) {
            const ref = (pb as number) / (pa as number);
            const dev = Math.max(px / ref, ref / px);
            if (dev > maxDeviation) ok = false;
          }
        }
      } catch {}
      if (!ok) { try { logger.warn('raydium.clmm drop by sanity', { id, mint_a: mintA, mint_b: mintB, price_in: price, price_from_sqrt }); } catch {} } else {
        clmm.push({ id, dex: 'Raydium', mint_a: mintA, mint_b: mintB, fee_bps, sqrt_price_x64: Number.isFinite(sqrt) ? sqrt : 0, liquidity: Number.isFinite(liquidity) ? liquidity : 0, tick_spacing: Number.isFinite(tick) ? tick : 0, updated_ms: now, price_a_per_b: px > 0 ? px : undefined, decimals_a: Number.isFinite(decA) ? decA : undefined, decimals_b: Number.isFinite(decB) ? decB : undefined, pool_kind: 'clmm', tvl_usd, amount_a_whole, amount_b_whole, liquidity_display: tvl_usd });
      }
    } else {
      const tvl_usd = Number.isFinite(tvl) && tvl > 0 ? tvl : undefined;
      const amount_a_whole = Number.isFinite(mintAmountA) ? mintAmountA : undefined;
      const amount_b_whole = Number.isFinite(mintAmountB) ? mintAmountB : undefined;
      const amounts_are_whole = Number.isFinite(amount_a_whole as any) || Number.isFinite(amount_b_whole as any) ? true : undefined;
      const liquidity_base = Number.isFinite(amount_a_whole as any) && Number.isFinite(amount_b_whole as any)
        ? Math.min(amount_a_whole as number, amount_b_whole as number)
        : 0;
      const liquidity_display = (tvl_usd != null) ? tvl_usd : (liquidity_base > 0 ? liquidity_base : undefined);
      let price_in = Number.isFinite(price) && price > 0 ? Number(price) : 0;
      const price_res = (Number.isFinite(amount_a_whole as any) && Number.isFinite(amount_b_whole as any) && (amount_b_whole as number) > 0)
        ? ((amount_a_whole as number) / (amount_b_whole as number))
        : 0;
      // Derive from decimals when available (treat raw amounts as atomic)
      const price_res_decs = (Number.isFinite(decA) && Number.isFinite(decB) && Number.isFinite(mintAmountA) && Number.isFinite(mintAmountB) && (mintAmountB as number) > 0)
        ? ((mintAmountA as number) / Math.pow(10, decA as number)) / ((mintAmountB as number) / Math.pow(10, decB as number))
        : 0;
      let price_sane = price_in > 0 ? price_in : (price_res > 0 ? price_res : price_res_decs);
      try {
        const sanityCfg = (CONFIG as any)?.sanity || {};
        const apply = (sanityCfg as any).sanity_applyRaydiumAmm ?? true;
        if (apply !== false) {
          const maxDeviation = Number.isFinite(Number(sanityCfg.maxPriceDeviation)) ? Number(sanityCfg.maxPriceDeviation) : 50;
          const { getPriceByMint } = await import('../priceStore.js');
          const pa = getPriceByMint(mintA)?.usdc ?? null;
          const pb = getPriceByMint(mintB)?.usdc ?? null;
          if (pa && pb && (pa as number) > 0 && (pb as number) > 0) {
            const ref = (pb as number) / (pa as number);
            const candidates: number[] = [];
            if (price_in > 0) { candidates.push(price_in); candidates.push(1 / price_in); }
            if (price_res > 0) { candidates.push(price_res); candidates.push(1 / price_res); }
            if (price_res_decs > 0) { candidates.push(price_res_decs); candidates.push(1 / price_res_decs); }
            if (candidates.length) {
              let bestVal = candidates[0];
              let bestDev = Math.max(bestVal / ref, ref / bestVal);
              for (let k = 1; k < candidates.length; k++) {
                const cur = candidates[k];
                const dev = Math.max(cur / ref, ref / cur);
                if (dev + 1e-12 < bestDev) { bestDev = dev; bestVal = cur; }
              }
              price_sane = bestVal;
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

  const ammCanon = canonicalizePairs(amm);
  const clmmCanon = canonicalizePairs(clmm);
  logger.info('raydium.pools normalized', { amm: ammCanon.length, clmm: clmmCanon.length, cat: 'raydium' });
  return { amm: ammCanon, clmm: clmmCanon };
}


