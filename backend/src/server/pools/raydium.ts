import { logger } from '../../utils/logger.js';
import { emit } from '../realtime.js';
import { CONFIG } from '../../utils/config.js';
import { readJson, writeJson, joinPath } from '../../utils/fs.js';
import type { AmmPool, ClmmPool, PoolsPayload } from './types.js';
import { canonicalizePairs, validateHttpUrl } from './common.js';

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

    // Prefer global list-mode (sorted by liquidity) when enabled; fallback to mint-based mode for resilience
    try {
      const listModeDisabled = (CONFIG.raydium as any)?.enableApiFetchByMints === true;
      if (!listModeDisabled) {
        const baseUrl = 'https://api-v3.raydium.io/pools/info/list';
        const pageSize = Math.max(20, Number((CONFIG as any)?.raydium?.pageSize || (CONFIG as any)?.raydium?.httpPageSize || 50));
        const maxPages = Math.max(1, Number((CONFIG as any)?.raydium?.maxPages || (CONFIG as any)?.raydium?.httpMaxPagesGlobal || 10));
        const collected: any[] = [];
        let page = 1;
        for (let i = 0; i < maxPages; i++) {
          try {
            const qs = new URLSearchParams({
              poolType: 'all',
              poolSortField: 'liquidity',
              sortType: 'desc',
              pageSize: String(pageSize),
              page: String(page),
            });
            const url = `${baseUrl}?${qs.toString()}`;
            const started = Date.now();
            try { logger.debug('raydium.http list request', { page, pageSize, cat: 'raydium' }); } catch {}
            const res = await fetchFn(url, { headers: { accept: 'application/json' } });
            if (res?.status === 429) {
              try { emit('log', { level: 'warn', message: 'arb:429 source=raydium kind=http surface=pools.info.list', timestamp: new Date().toISOString(), context: { cat: 'arb' } }); } catch {}
              try { logger.warn('raydium.http 429 list', { page, cat: 'raydium' }); } catch {}
              break; // fallback to mint-mode
            }
            if (!res?.ok) {
              const txt = await res?.text?.();
              logger.warn('raydium.http non-ok list', { status: res?.status, body: (txt || '').slice(0, 200), cat: 'raydium' });
              break; // fallback to mint-mode
            }
            const json = await res.json().catch(() => null);
            const arr = Array.isArray(json?.data?.data) ? json.data.data : [];
            if (arr.length) collected.push(...arr);
            const hasNext = !!json?.data?.hasNextPage;
            page += 1;
            try { logger.debug('raydium.http list page ok', { page: page - 1, ms: Date.now() - started, count: arr.length, next: !!hasNext, cat: 'raydium' }); } catch {}
            if (!hasNext) break;
          } catch (e: any) {
            const msg = String(e?.message || e);
            logger.warn('raydium.http list fetch failed', { error: msg, cat: 'raydium' });
            break; // fallback to mint-mode
          }
        }
        if (collected.length) {
          logger.info('raydium.http.list.fetch ok', { count: collected.length, cat: 'raydium' });
          try { await writeJson(RAYDIUM_RAW_PATH, { data: collected }); } catch (e: any) { try { logger.warn('raydium.cache write failed', { file: RAYDIUM_RAW_PATH, error: String(e?.message || e), cat: 'raydium' }); } catch {} }
          return { data: collected };
        }
        logger.warn('raydium.http list returned 0; falling back to mint-mode');
      }
    } catch {}

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
    const pageSize = Math.max(20, Number(((CONFIG as any)?.raydium?.pageSize) || (CONFIG.raydium as any)?.httpPageSize || 50));
    const maxPagesGlobal = Math.max(1, Number(((CONFIG as any)?.raydium?.maxPages) || 10));
    const concurrency = Math.max(1, Math.min(3, Number(((CONFIG as any)?.raydium?.concurrency) || (CONFIG.raydium as any)?.sdkConcurrency || 8)));
    const maxRetries = Math.max(0, Number(((CONFIG as any)?.raydium?.maxHttpRetries) || 2));
    const backoffMs = Math.max(50, Number(((CONFIG as any)?.raydium?.httpBackoffMs) || 300));

    const collected: any[] = [];
    const queue: Array<() => Promise<void>> = [];
    let globalPagesFetched = 0;

    for (const mint of uniq) {
      queue.push(async () => {
        let page = 1;
        let hasNext = true;
        while (hasNext && globalPagesFetched < maxPagesGlobal) {
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
            // retry loop
            let res: any = null; let attempt = 0;
            for (; attempt <= maxRetries; attempt++) {
              res = await fetchFn(url, { headers: { accept: 'application/json' } });
              if (res?.status === 429) {
                try { emit('log', { level: 'warn', message: 'arb:429 source=raydium kind=http surface=pools.info', timestamp: new Date().toISOString(), context: { cat: 'arb' } }); } catch {}
                try { logger.warn('raydium.http 429', { mint, page, cat: 'raydium' }); } catch {}
                await sleep(backoffMs * (attempt + 1));
                continue;
              }
              if (!res?.ok) {
                if (attempt < maxRetries) { await sleep(backoffMs * (attempt + 1)); continue; }
              }
              break;
            }
            if (res?.status === 429) {
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
            globalPagesFetched += 1;
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
  // Load Jupiter token decimals to enforce authoritative values for CLMM
  let jupMap: Record<string, { symbol?: string; decimals?: number }> = {};
  try {
    const tok = await import('../../utils/tokens.js');
    if (typeof (tok as any).loadJupiterTokenMap === 'function') {
      jupMap = await (tok as any).loadJupiterTokenMap();
    }
  } catch {}

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
    const hasSqrt = (it as any)?.sqrtPriceX64 != null || (it as any)?.sqrtPrice != null;
    const hasTick = (it as any)?.tickSpacing != null || (it as any)?.config?.tickSpacing != null;
    const isClmm = typeStr.includes('concentrated') || pooltype.map((s: any) => String(s).toLowerCase()).includes('clmm') || hasSqrt || hasTick;
    const fee_bps = toFeeBps((it as any)?.feeRate ?? (it as any)?.tradeFeeRate ?? (it as any)?.feeBps ?? (it as any)?.tradeFeeBps);
    let decA = Number((it?.mintA as any)?.decimals);
    let decB = Number((it?.mintB as any)?.decimals);
    // Fallback to token resolver if Raydium payload omits decimals
    try {
      if (!Number.isFinite(decA) || !Number.isFinite(decB)) {
        const tok = await import('../../utils/tokens.js');
        if (!Number.isFinite(decA)) { const r = await (tok as any).resolveMint(mintA); decA = Number(r?.decimals); }
        if (!Number.isFinite(decB)) { const r = await (tok as any).resolveMint(mintB); decB = Number(r?.decimals); }
      }
    } catch {}
    const price = Number((it as any)?.price);
    const tvl = Number((it as any)?.tvl);
    const mintAmountA = Number((it as any)?.mintAmountA);
    const mintAmountB = Number((it as any)?.mintAmountB);

    if (isClmm) {
      const tick = Number((it as any)?.tickSpacing ?? (it as any)?.config?.tickSpacing ?? 0);
      const sqrt = Number((it as any)?.sqrtPriceX64 ?? (it as any)?.sqrtPrice ?? 0);
      const liquidity = Number((it as any)?.liquidity ?? 0);
      const tvl_usd = Number.isFinite(tvl) && tvl > 0 ? tvl : undefined;
      // Accept legacy test fields reserveA/reserveB as whole reserves
      const reserveA = Number((it as any)?.reserveA ?? NaN);
      const reserveB = Number((it as any)?.reserveB ?? NaN);
      const amount_a_whole = Number.isFinite(mintAmountA) ? mintAmountA : (Number.isFinite(reserveA) ? reserveA : undefined);
      const amount_b_whole = Number.isFinite(mintAmountB) ? mintAmountB : (Number.isFinite(reserveB) ? reserveB : undefined);
      // Enforce authoritative decimals from Jupiter list, then anchors, then clamp
      try {
        const jDecA = Number(jupMap[mintA]?.decimals);
        const jDecB = Number(jupMap[mintB]?.decimals);
        if (Number.isFinite(jDecA)) decA = jDecA;
        if (Number.isFinite(jDecB)) decB = jDecB;
        // Anchors: SOL 9, USDC/USDT/USD1 6
        if (mintA === 'So11111111111111111111111111111111111111112') decA = 9;
        if (mintB === 'So11111111111111111111111111111111111111112') decB = 9;
        if (mintA === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') decA = 6;
        if (mintB === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') decB = 6;
        if (mintA === 'Es9vMFrzaCERfCkS7fGXx9bK6A7bP4J1yDrJZGB48JpN') decA = 6;
        if (mintB === 'Es9vMFrzaCERfCkS7fGXx9bK6A7bP4J1yDrJZGB48JpN') decB = 6;
        if (mintA === 'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB') decA = 6;
        if (mintB === 'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB') decB = 6;
        decA = Math.min(12, Math.max(0, Math.round(Number(decA))));
        decB = Math.min(12, Math.max(0, Math.round(Number(decB))));
      } catch {}
      let price_from_sqrt = 0;
      let price_from_sqrt_alt = 0;
      try {
        if (sqrt > 0 && Number.isFinite(decA) && Number.isFinite(decB)) {
          const two64 = Math.pow(2, 64);
          const ratio = sqrt / two64;
          // Candidate set from both scale directions to guard against vendor orientation nuances
          const scale1 = Math.pow(10, (decB as number) - (decA as number));
          const scale2 = Math.pow(10, (decA as number) - (decB as number));
          const c1 = scale1 / (ratio * ratio);
          const c2 = (ratio * ratio) / scale1;
          const c3 = scale2 / (ratio * ratio);
          const c4 = (ratio * ratio) / scale2;
          // Pick a primary and alt; we will still evaluate full candidate set later
          price_from_sqrt = Number.isFinite(c1) && c1 > 0 ? c1 : 0;
          price_from_sqrt_alt = Number.isFinite(c2) && c2 > 0 ? c2 : 0;
          try {
            const extra: number[] = [];
            if (Number.isFinite(c3) && c3 > 0) extra.push(c3);
            if (Number.isFinite(c4) && c4 > 0) extra.push(c4);
            // Append to candidates immediately if we already built the list
            // (we add again below defensively)
          } catch {}
        }
      } catch {}
      // Choose candidate closer to USD reference (when available): sqrt-derived vs incoming vs reserves-derived (decimals-aware)
      let px = 0;
      try {
        const { getPriceByMint } = await import('../priceStore.js');
        let pa = getPriceByMint(mintA)?.usdc ?? null;
        let pb = getPriceByMint(mintB)?.usdc ?? null;
        try {
          const STABLES = new Set<string>([
            ...((((CONFIG as any)?.system as any)?.stableMints || []) as string[]),
            'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
            'Es9vMFrzaCERfCkS7fGXx9bK6A7bP4J1yDrJZGB48JpN',
          ]);
          if (!(typeof pa === 'number' && pa > 0) && STABLES.has(mintA)) pa = 1;
          if (!(typeof pb === 'number' && pb > 0) && STABLES.has(mintB)) pb = 1;
        } catch {}
        const directRef = (pa && pb && (pa as number) > 0 && (pb as number) > 0) ? ((pb as number) / (pa as number)) : undefined;
        const refs: number[] = [];
        if (Number.isFinite(directRef as any) && (directRef as number) > 0) refs.push(directRef as number);
        const candidates: number[] = [];
        let usedWhole = false;
        if (price_from_sqrt > 0) candidates.push(price_from_sqrt);
        if (price_from_sqrt_alt > 0) candidates.push(price_from_sqrt_alt);
        // Add alternate scale candidates as well
        try {
          if (sqrt > 0 && Number.isFinite(decA) && Number.isFinite(decB)) {
            const ratio = sqrt / Math.pow(2, 64);
            const scale2 = Math.pow(10, (decA as number) - (decB as number));
            const c3 = scale2 / (ratio * ratio);
            const c4 = (ratio * ratio) / scale2;
            if (Number.isFinite(c3) && c3 > 0) candidates.push(c3);
            if (Number.isFinite(c4) && c4 > 0) candidates.push(c4);
          }
        } catch {}
        // Do not include vendor-reported price; rely on sqrt/reserves only for CLMM
        try {
          // Reserves-derived using decimals (treat mintAmountA/B as atomic, convert to whole)
          const hasDecs = Number.isFinite(decA) && Number.isFinite(decB);
          const aAtomic = Number((it as any)?.mintAmountA ?? NaN);
          const bAtomic = Number((it as any)?.mintAmountB ?? NaN);
          const wholeAdec = (hasDecs && Number.isFinite(aAtomic)) ? (aAtomic / Math.pow(10, decA as number)) : NaN;
          const wholeBdec = (hasDecs && Number.isFinite(bAtomic)) ? (bAtomic / Math.pow(10, decB as number)) : NaN;
          if (Number.isFinite(wholeAdec) && Number.isFinite(wholeBdec) && (wholeBdec as number) > 0) {
            const fromDec = (wholeAdec as number) / (wholeBdec as number);
            if (fromDec > 0 && Number.isFinite(fromDec)) { candidates.push(fromDec); usedWhole = true; }
          } else {
            // Fallback: use whole amounts if they appear to be already whole
            const wholeA = Number.isFinite(amount_a_whole as any) ? (amount_a_whole as number) : NaN;
            const wholeB = Number.isFinite(amount_b_whole as any) ? (amount_b_whole as number) : NaN;
            if (Number.isFinite(wholeA) && Number.isFinite(wholeB) && (wholeB as number) > 0) {
              const fromWhole = (wholeA as number) / (wholeB as number);
              if (fromWhole > 0 && Number.isFinite(fromWhole)) { candidates.push(fromWhole); usedWhole = true; }
            }
          }
        } catch {}
        // Use USD references only to choose between pool-derived candidates; never substitute USD ref as price
        if (refs.length && candidates.length > 1) {
          // Robust pick: minimize median deviation across refs
          let best = candidates[0];
          let bestMed = Number.POSITIVE_INFINITY;
          for (let i = 0; i < candidates.length; i++) {
            const v = candidates[i];
            const devs = refs.map((r) => Math.max(v / r, r / v));
            const med = devs.sort((a,b)=>a-b)[Math.floor(devs.length/2)];
            if (med + 1e-12 < bestMed) { bestMed = med; best = v; }
          }
          px = best;
        } else {
          px = price_from_sqrt > 0 ? price_from_sqrt : (Number(price) > 0 ? Number(price) : 0);
        }
      } catch {
        px = price_from_sqrt > 0 ? price_from_sqrt : (Number(price) > 0 ? Number(price) : 0);
      }
      // Magnitude-only calibration to align with USD reference without flipping orientation
      try {
        const { getPriceByMint } = await import('../priceStore.js');
        const getUsd = (m: string) => {
          try {
            const v = getPriceByMint(m)?.usdc ?? undefined;
            if (typeof v === 'number' && v > 0) return v;
            const STABLES = new Set<string>([
              ...((((CONFIG as any)?.system as any)?.stableMints || []) as string[]),
              'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
              'Es9vMFrzaCERfCkS7fGXx9bK6A7bP4J1yDrJZGB48JpN',
            ]);
            return STABLES.has(m) ? 1 : undefined;
          } catch { return undefined; }
        };
        const { calibrateMagnitude } = await import('../priceCalib.js');
        const calibrated = calibrateMagnitude(mintA, mintB, px, getUsd);
        if (calibrated && calibrated > 0) px = calibrated;
      } catch {}
      let ok = true;
      try {
        const sanityCfg = (CONFIG as any)?.sanity || {};
        const apply = (sanityCfg as any).sanity_applyRaydiumClmm ?? true;
        if (apply !== false && px > 0) {
          const maxDeviation = Number.isFinite(Number((sanityCfg as any).maxPriceDeviationClmm))
            ? Number((sanityCfg as any).maxPriceDeviationClmm)
            : (Number.isFinite(Number((sanityCfg as any).maxPriceDeviation)) ? Number((sanityCfg as any).maxPriceDeviation) : 5);
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
        // Populate pool_liquidity_raw as min(wholeA, wholeB) using decimals-aware amounts when available
        let pool_liquidity_raw: number | undefined = undefined;
        try {
          const aAtomic = Number((it as any)?.mintAmountA ?? NaN);
          const bAtomic = Number((it as any)?.mintAmountB ?? NaN);
          if (Number.isFinite(decA) && Number.isFinite(decB) && Number.isFinite(aAtomic) && Number.isFinite(bAtomic)) {
            const wa = aAtomic / Math.pow(10, decA as number);
            const wb = bAtomic / Math.pow(10, decB as number);
            const min = Math.min(wa, wb);
            if (Number.isFinite(min) && min > 0) pool_liquidity_raw = min;
          }
        } catch {}
        clmm.push({ id, dex: 'Raydium', mint_a: mintA, mint_b: mintB, fee_bps, sqrt_price_x64: Number.isFinite(sqrt) ? sqrt : 0, liquidity: Number.isFinite(liquidity) ? liquidity : 0, tick_spacing: Number.isFinite(tick) ? tick : 0, updated_ms: now, price_a_per_b: px > 0 ? px : undefined, decimals_a: Number.isFinite(decA) ? decA : undefined, decimals_b: Number.isFinite(decB) ? decB : undefined, pool_kind: 'clmm', tvl_usd, amount_a_whole, amount_b_whole, pool_liquidity_raw, liquidity_display: tvl_usd });
      }
    } else {
      const tvl_usd = Number.isFinite(tvl) && tvl > 0 ? tvl : undefined;
      // Accept legacy test fields reserveA/reserveB as whole reserves when mintAmountA/B absent
      const reserveA0 = Number((it as any)?.reserveA ?? NaN);
      const reserveB0 = Number((it as any)?.reserveB ?? NaN);
      const amount_a_whole = Number.isFinite(mintAmountA) ? mintAmountA : (Number.isFinite(reserveA0) ? reserveA0 : undefined);
      const amount_b_whole = Number.isFinite(mintAmountB) ? mintAmountB : (Number.isFinite(reserveB0) ? reserveB0 : undefined);
      // Treat mintAmountA/B as atomic units by default; prefer decimals-aware price when available
      const amounts_are_whole = undefined;
      const liquidity_base = Number.isFinite(amount_a_whole as any) && Number.isFinite(amount_b_whole as any)
        ? Math.min(amount_a_whole as number, amount_b_whole as number)
        : 0;
      const liquidity_display = (tvl_usd != null) ? tvl_usd : (liquidity_base > 0 ? liquidity_base : undefined);
      let price_in = Number.isFinite(price) && price > 0 ? Number(price) : 0;
      const price_res = (Number.isFinite(amount_a_whole as any) && Number.isFinite(amount_b_whole as any) && (amount_b_whole as number) > 0)
        ? ((amount_a_whole as number) / (amount_b_whole as number))
        : ((Number.isFinite(reserveA0) && Number.isFinite(reserveB0) && reserveB0 > 0) ? (reserveA0 / reserveB0) : 0);
      // Derive from decimals when available (treat raw amounts as atomic)
      const price_res_decs = (Number.isFinite(decA) && Number.isFinite(decB) && Number.isFinite(mintAmountA) && Number.isFinite(mintAmountB) && (mintAmountB as number) > 0)
        ? ((mintAmountA as number) / Math.pow(10, decA as number)) / ((mintAmountB as number) / Math.pow(10, decB as number))
        : 0;
      // Prefer reserves-derived price; only fall back to upstream price when reserves are unavailable
      // Prefer decimals-aware reserves-derived price; fallback to raw ratio, then upstream
      const price_from_reserves = (price_res_decs > 0 ? price_res_decs : (price_res > 0 ? price_res : 0));
      let price_sane = price_from_reserves > 0 ? price_from_reserves : (price_in > 0 ? price_in : 0);
      // Removed stable-aware flip to avoid double-orientation corrections; orientation handled later via canonicalization/graph USD refs
      try {
        const sanityCfg = (CONFIG as any)?.sanity || {};
        const apply = (sanityCfg as any).sanity_applyRaydiumAmm ?? true;
        if (apply !== false) {
          const maxDeviation = Number.isFinite(Number(sanityCfg.maxPriceDeviation)) ? Number(sanityCfg.maxPriceDeviation) : 50;
          const { getPriceByMint } = await import('../priceStore.js');
          let pa = getPriceByMint(mintA)?.usdc ?? null;
          let pb = getPriceByMint(mintB)?.usdc ?? null;
          // Stable fallback: assume 1.0 when missing
          try {
            const STABLES = new Set<string>([
              ...((((CONFIG as any)?.system as any)?.stableMints || []) as string[]),
              'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
              'Es9vMFrzaCERfCkS7fGXx9bK6A7bP4J1yDrJZGB48JpN',
            ]);
            if (!(typeof pa === 'number' && pa > 0) && STABLES.has(mintA)) pa = 1;
            if (!(typeof pb === 'number' && pb > 0) && STABLES.has(mintB)) pb = 1;
          } catch {}
          if (pa && pb && (pa as number) > 0 && (pb as number) > 0) {
            const ref = (pb as number) / (pa as number);
            // Magnitude-only calibration: do not include reciprocals; keep orientation A per 1 B
            const candidates: number[] = [];
            if (price_in > 0) candidates.push(price_in);
            if (price_res > 0) candidates.push(price_res);
            if (price_res_decs > 0) candidates.push(price_res_decs);
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
      const pushedPrice = Number.isFinite(price_sane) ? price_sane : 0;
      amm.push({ id, dex: 'Raydium', mint_a: mintA, mint_b: mintB, fee_bps, price_a_per_b: pushedPrice, liquidity_base, updated_ms: now, decimals_a: Number.isFinite(decA) ? decA : undefined, decimals_b: Number.isFinite(decB) ? decB : undefined, pool_kind: 'amm', tvl_usd, amount_a_whole, amount_b_whole, amounts_are_whole, liquidity_display });
    }
  }

  const ammCanon = canonicalizePairs(amm);
  const clmmCanon = canonicalizePairs(clmm);
  logger.info('raydium.pools normalized', { amm: ammCanon.length, clmm: clmmCanon.length, cat: 'raydium' });
  return { amm: ammCanon, clmm: clmmCanon };
}


