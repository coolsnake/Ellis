import { logger } from '../../utils/logger.js';
import { emit } from '../realtime.js';
import { CONFIG } from '../../utils/config.js';
import { writeJson, joinPath } from '../../utils/fs.js';
import type { ClmmPool, PoolsPayload } from './types.js';
import { canonicalizePairs, canonicalizePairsLex } from './common.js';
import { httpLogStart, httpLogResponse, httpLog429, httpLogNonOk } from './httpLog.js';

export async function fetchOrcaHttp(): Promise<any> {
  const ORCA_RAW_PATH = joinPath(CONFIG.cacheDir, 'orca-raw-sample.json');
  const base = CONFIG.orca?.apiUrl || 'https://api.orca.so/v2/solana/pools';
  const retries = CONFIG.orca?.maxHttpRetries ?? 2;
  const backoffMs = CONFIG.orca?.httpBackoffMs ?? 500;
  const maxPages = CONFIG.orca?.maxPages ?? 5;
  const size = Number(CONFIG.orca?.pageSize ?? 500);
  const params: Record<string, string> = {};
  if (Number.isFinite(size as any) && size > 0) params.size = String(size);
  // Optional TVL/liquidity sorting & filters (only include if configured)
  try {
    const sortBy = (CONFIG.orca as any)?.sortBy;
    const sortDirection = (CONFIG.orca as any)?.sortDirection;
    const minTvl = (CONFIG.orca as any)?.minTvl;
    const minVolume = (CONFIG.orca as any)?.minVolume;
    const minLockedLiquidityPercent = (CONFIG.orca as any)?.minLockedLiquidityPercent;
    const hasRewards = (CONFIG.orca as any)?.hasRewards;
    const hasWarning = (CONFIG.orca as any)?.hasWarning;
    const hasAdaptiveFee = (CONFIG.orca as any)?.hasAdaptiveFee;
    const isWavebreak = (CONFIG.orca as any)?.isWavebreak;
    const token = (CONFIG.orca as any)?.token;
    const tokensBothOf = (CONFIG.orca as any)?.tokensBothOf;
    const addresses = (CONFIG.orca as any)?.addresses;
    const includeBlocked = (CONFIG.orca as any)?.includeBlocked;
    if (sortBy) params.sortBy = String(sortBy);
    if (sortDirection) params.sortDirection = String(sortDirection);
    if (minTvl != null) params.minTvl = String(minTvl);
    if (minVolume != null) params.minVolume = String(minVolume);
    if (minLockedLiquidityPercent != null) params.minLockedLiquidityPercent = String(minLockedLiquidityPercent);
    if (hasRewards != null) params.hasRewards = String(hasRewards);
    if (hasWarning != null) params.hasWarning = String(hasWarning);
    if (hasAdaptiveFee != null) params.hasAdaptiveFee = String(hasAdaptiveFee);
    if (isWavebreak != null) params.isWavebreak = String(isWavebreak);
    if (token) params.token = String(token);
    if (tokensBothOf) params.tokensBothOf = String(tokensBothOf);
    if (addresses) params.addresses = String(addresses);
    if (includeBlocked != null) params.includeBlocked = String(includeBlocked);
  } catch {}
  const buildUrl = (cursor?: string) => {
    const sp = new URLSearchParams(params);
    if (cursor) sp.append('cursor', cursor);
    return `${base}?${sp.toString()}`;
  };
  let nextCursor: string | undefined;
  let ok = true; let pageCount = 0;
  const merged: any[] = [];
  const runPaged = async () => {
    while (ok && pageCount < maxPages) {
      const started = Date.now();
      const url = buildUrl(nextCursor);
      // eslint-disable-next-line no-undef
      const res = await ((globalThis as any).fetch || fetch)(url);
      const ms = Date.now() - started;
      if (res.status === 429) {
        try { emit('log', { level: 'warn', message: 'arb:429 source=orca kind=http', timestamp: new Date().toISOString(), context: { cat: 'arb' } }); } catch {}
        try { httpLog429({ source: 'orca', url, cid: `http-${Date.now()}` }); } catch {}
        ok = false; break;
      }
      if (!res.ok) {
        try {
          const txt = await res.text().catch(() => '');
          httpLogNonOk({ source: 'orca', url, cid: `http-${Date.now()}`, status: res.status, bodySample: (txt || '').slice(0, 200) });
        } catch { logger.warn('orca.http non-ok', { status: res.status }); }
        ok = false; break;
      }
      const json = await res.json().catch(() => null);
      const data = Array.isArray(json) ? json : (Array.isArray(json?.data) ? json.data : []);
      merged.push(...data);
      pageCount += 1;
      nextCursor = (json && typeof json === 'object') ? (json.cursor || json.nextCursor || json.next) : undefined;
      try { httpLogResponse({ source: 'orca', url, cid: `http-${Date.now()}`, status: res.status, ms, count: data.length }); } catch {}
      if (!nextCursor) break;
      if (pageCount >= maxPages) break;
    }
  };
  await runPaged();
  if (merged.length === 0) {
    const started = Date.now();
    const url = buildUrl();
    // eslint-disable-next-line no-undef
    const res = await ((globalThis as any).fetch || fetch)(url);
    const ms = Date.now() - started;
    if (!res.ok) throw new Error(`http ${res.status}`);
    const json: any = await res.json();
    const data: any[] = Array.isArray(json) ? json : (Array.isArray(json?.data) ? json.data : []);
    try { httpLogResponse({ source: 'orca', url, cid: `http-${Date.now()}`, status: res.status, ms, count: data.length }); } catch {}
    try { await writeJson(ORCA_RAW_PATH, data); } catch (e: any) { try { logger.warn('orca.cache write failed', { file: ORCA_RAW_PATH, error: String(e?.message || e), cat: 'orca' }); } catch {} }
    return data;
  }
  try { await writeJson(ORCA_RAW_PATH, merged); } catch (e: any) { try { logger.warn('orca.cache write failed', { file: ORCA_RAW_PATH, error: String(e?.message || e), cat: 'orca' }); } catch {} }
  return merged;
}

export async function normalizeOrcaHttp(raw: any): Promise<PoolsPayload> {
  const now = Date.now();
  const clmm: ClmmPool[] = [];
  let jupMap: Record<string, { symbol: string; decimals: number }> = {};
  let resolveMintFn: undefined | ((s: string) => Promise<{ mint: string; decimals: number }>);
  const symbolToMintCache = new Map<string, { mint?: string; decimals?: number; tried: boolean }>();
  try {
    const tok = await import('../../utils/tokens.js');
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
  for (const it of arr) {
    const id = String(it?.address || it?.id || '');
    const tokenA = it?.tokenA || it?.token_a || {};
    const tokenB = it?.tokenB || it?.token_b || {};
    let mint_a = String(tokenA?.mint || it?.mintA || '');
    let mint_b = String(tokenB?.mint || it?.mintB || '');
    let decA = Number((tokenA?.decimals ?? it?.decimalsA));
    let decB = Number((tokenB?.decimals ?? it?.decimalsB));
    if (!Number.isFinite(decA) && jupMap[mint_a]?.decimals != null) decA = Number(jupMap[mint_a].decimals);
    if (!Number.isFinite(decB) && jupMap[mint_b]?.decimals != null) decB = Number(jupMap[mint_b].decimals);
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
    let fee_bps = 0;
    const feeRateRaw = (it as any)?.feeRate;
    if (typeof feeRateRaw === 'number') {
      fee_bps = feeRateRaw <= 1 ? Math.round(feeRateRaw * 10_000) : Math.round(feeRateRaw);
    } else if (typeof (it as any)?.fee_bps === 'number') {
      fee_bps = Math.round((it as any).fee_bps);
    }
    const poolType = String(it?.type || it?.poolType || '').toLowerCase();
    const isWhirlpool = poolType.includes('whirlpool') || poolType.includes('concentrated') || typeof it?.tickSpacing === 'number' || typeof it?.state?.tickSpacing === 'number';
    const sqrtPriceStr = (it?.sqrtPrice ?? it?.sqrtPriceX64 ?? it?.state?.sqrtPriceX64 ?? it?.state?.sqrtPrice ?? 0);
    let sqrt_price_x64 = Number(typeof sqrtPriceStr === 'string' ? Number(sqrtPriceStr) : sqrtPriceStr || 0);
    const liquidityVal = (it?.liquidity ?? it?.state?.liquidity ?? 0);
    const liquidity = Number(typeof liquidityVal === 'string' ? Number(liquidityVal) : liquidityVal || 0);
    const tick_spacing = Number((it?.tickSpacing ?? it?.state?.tickSpacing) || 0);
    const amtAraw = (it?.tokenBalanceA ?? it?.tokenAAmount ?? it?.token_a_amount ?? it?.amountA ?? it?.baseAmount ?? 0);
    const amtBraw = (it?.tokenBalanceB ?? it?.tokenBAmount ?? it?.token_b_amount ?? it?.amountB ?? it?.quoteAmount ?? 0);
    let amount_a = Number(typeof amtAraw === 'string' ? Number(amtAraw) : amtAraw || 0);
    let amount_b = Number(typeof amtBraw === 'string' ? Number(amtBraw) : amtBraw || 0);
    const incomingPrice = Number(it?.price ?? it?.price_a_per_b ?? it?.priceAperB ?? 0);
    if (isWhirlpool && id && sqrt_price_x64 > 0) {
      let cA = mint_a; let cB = mint_b; let cDecA = decA; let cDecB = decB; let cAmtA = amount_a; let cAmtB = amount_b;
      let priceFromSqrt = 0;
      if (sqrt_price_x64 > 0 && Number.isFinite(cDecA) && Number.isFinite(cDecB)) {
        const two64 = Math.pow(2, 64);
        const ratio = sqrt_price_x64 / two64;
        // Lock orientation to A per 1 B
        const aPerB = Math.pow(10, cDecB - cDecA) / (ratio * ratio);
        if (Number.isFinite(aPerB) && aPerB > 0) priceFromSqrt = aPerB;
      }
      const incomingCanonical = (incomingPrice > 0) ? incomingPrice : 0;
      let priceDerived = priceFromSqrt > 0 ? priceFromSqrt : incomingCanonical;
      
      // Magnitude-only calibration (no flips)
      try {
        const { getPriceByMint } = await import('../../server/priceStore.js');
        const getUsd = (m: string) => { try { return getPriceByMint(m)?.usdc ?? undefined; } catch { return undefined; } };
        const { calibrateMagnitude } = await import('../../server/priceCalib.js');
        const calibrated = calibrateMagnitude(cA, cB, priceDerived, getUsd);
        if (calibrated && calibrated > 0) priceDerived = calibrated;
      } catch {}
      const wholeA = Number.isFinite(cDecA) ? (cAmtA / Math.pow(10, cDecA as number)) : undefined;
      const wholeB = Number.isFinite(cDecB) ? (cAmtB / Math.pow(10, cDecB as number)) : undefined;
      const tvlUsdcRaw = (it as any)?.tvlUsdc;
      const tvlUsdcNum = typeof tvlUsdcRaw === 'string' ? Number(tvlUsdcRaw) : (typeof tvlUsdcRaw === 'number' ? tvlUsdcRaw : 0);
      const tvl_usd = Number.isFinite(tvlUsdcNum) && tvlUsdcNum > 0 ? tvlUsdcNum : undefined;
      const pool_liquidity_raw = (tvl_usd != null)
        ? tvl_usd
        : (Number.isFinite(wholeA as any) && Number.isFinite(wholeB as any)) ? Math.min(wholeA as number, wholeB as number) : undefined;
      const liquidity_display = (tvl_usd != null) ? tvl_usd : undefined;
      let usdDevOkOrca = true;
      try {
        const sanityCfg = (CONFIG as any)?.sanity || {};
        const apply = (sanityCfg as any).sanity_applyOrcaClmm ?? true;
        if (apply !== false) {
          const maxDeviation = Number.isFinite(Number(sanityCfg.maxPriceDeviation)) ? Number(sanityCfg.maxPriceDeviation) : 50;
          const { getPriceByMint } = await import('../../server/priceStore.js');
          const pa = getPriceByMint(cA)?.usdc ?? null;
          const pb = getPriceByMint(cB)?.usdc ?? null;
          if (pa && pb && priceDerived && (priceDerived as number) > 0) {
            const ref = (pb as number) / (pa as number);
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
  // Canonicalize pair ordering per-source policy (default: none for Orca)
  let clmmCanon = clmm;
  try {
    const mode = String(((CONFIG as any)?.orca?.canonicalizePairs || 'none'));
    if (mode === 'lex') clmmCanon = canonicalizePairsLex(clmm);
  } catch {}
  if (!clmm.length) {
    logger.warn('orca.http normalized 0 clmm', { hint: 'Check inspect log for field presence and pool types' });
  }
  return { amm: [], clmm: clmmCanon };
}


