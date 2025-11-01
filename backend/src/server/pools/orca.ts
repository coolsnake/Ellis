import { logger } from '../../utils/logger.js';
import { emit } from '../realtime.js';
import { CONFIG } from '../../utils/config.js';
import { writeJson, joinPath } from '../../utils/fs.js';
import type { ClmmPool, PoolsPayload } from './types.js';
import { canonicalizePairs, validateHttpUrl, swapABFields } from './common.js';
import { verifyCanonicalization } from './validation.js';
import { httpLogStart, httpLogResponse, httpLog429, httpLogNonOk } from './httpLog.js';

const FEERATE_FIELDS = ['tradingFeeRate', 'tradeFeeRate', 'feeRate', 'tradeFee', 'fee', 'makerFee', 'takerFee'];
const FEEBPS_FIELDS = ['fee_bps', 'feeBps', 'fee_in_bps'];
const PROTOCOL_FEE_FIELDS = ['protocolFeeRate', 'protocolFee'];

const toNumber = (value: any): number | undefined => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim() !== '') {
    const num = Number(value);
    return Number.isFinite(num) ? num : undefined;
  }
  return undefined;
};

export function deriveOrcaFeeBps(raw: any): number {
  // 1. Explicit bps fields take precedence
  for (const field of FEEBPS_FIELDS) {
    const val = toNumber(raw?.[field]);
    if (Number.isFinite(val) && (val as number) > 0) {
      return Math.round(val as number);
    }
  }

  const protocolRateRaw = PROTOCOL_FEE_FIELDS.map((f) => toNumber(raw?.[f]))
    .find((v) => Number.isFinite(v) && (v as number) > 0);
  const feeRateRaw = FEERATE_FIELDS.map((f) => toNumber(raw?.[f]))
    .find((v) => Number.isFinite(v) && (v as number) > 0);

  const toBps = (rate: number | undefined): number => {
    if (!Number.isFinite(rate) || (rate as number) <= 0) return 0;
    const n = rate as number;
    if (Number.isInteger(n) && n > 1 && n <= 10_000) {
      // On-chain Whirlpool accounts encode feeRate in hundredths of a basis point
      return Math.round(n / 100);
    }
    if (n >= 100) return Math.round(n); // already in bps (100 = 1%)
    if (n >= 0.01) return Math.round(n * 100); // treat as percentage value
    return Math.round(n * 10_000); // decimal fraction (0.003 => 30 bps)
  };

  const protocolBps = toBps(protocolRateRaw);
  let feeBps = toBps(feeRateRaw);

  if (feeBps > 0) {
    if (protocolBps > 0 && protocolBps <= feeBps) {
      feeBps -= protocolBps;
    }
    return feeBps;
  }

  return protocolBps > 0 ? protocolBps : 0;
}

export async function fetchOrcaHttp(): Promise<any> {
  const ORCA_RAW_PATH = joinPath(CONFIG.cacheDir, 'orca-raw-sample.json');
  const baseUnsafe = CONFIG.orca?.apiUrl || 'https://api.orca.so/v2/solana/pools';
  const base = validateHttpUrl(baseUnsafe) || 'https://api.orca.so/v2/solana/pools';
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
    // Enforce authoritative decimals: prefer Jupiter list when present, then hard-override anchors
    try {
      const jDecA = Number(jupMap[mint_a]?.decimals);
      const jDecB = Number(jupMap[mint_b]?.decimals);
      if (Number.isFinite(jDecA)) decA = jDecA;
      if (Number.isFinite(jDecB)) decB = jDecB;
      // Anchors: SOL 9, USDC 6, USDT 6
      if (mint_a === 'So11111111111111111111111111111111111111112') decA = 9;
      if (mint_b === 'So11111111111111111111111111111111111111112') decB = 9;
      if (mint_a === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') decA = 6;
      if (mint_b === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') decB = 6;
      if (mint_a === 'Es9vMFrzaCERfCkS7fGXx9bK6A7bP4J1yDrJZGB48JpN') decA = 6;
      if (mint_b === 'Es9vMFrzaCERfCkS7fGXx9bK6A7bP4J1yDrJZGB48JpN') decB = 6;
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
      // Clamp to reasonable integer bounds
      decA = Math.min(12, Math.max(0, Math.round(Number(decA))));
      decB = Math.min(12, Math.max(0, Math.round(Number(decB))));
    } catch {}
    const fee_bps = deriveOrcaFeeBps(it);
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
      
      // Ensure decimals are definitely set before computing price
      // Double-check decimals are finite after all the setup above
      if (!Number.isFinite(cDecA) || !Number.isFinite(cDecB)) {
        // Try one more time to get decimals if missing
        try {
          if (!Number.isFinite(cDecA)) {
            const tok = await import('../../utils/tokens.js');
            const r = await (tok as any).resolveMint(cA);
            if (Number.isFinite(Number(r?.decimals))) cDecA = Number(r.decimals);
          }
          if (!Number.isFinite(cDecB)) {
            const tok = await import('../../utils/tokens.js');
            const r = await (tok as any).resolveMint(cB);
            if (Number.isFinite(Number(r?.decimals))) cDecB = Number(r.decimals);
          }
          // Clamp again after potential fix
          cDecA = Math.min(12, Math.max(0, Math.round(Number(cDecA))));
          cDecB = Math.min(12, Math.max(0, Math.round(Number(cDecB))));
        } catch {}
      }
      
      let priceFromSqrt = 0;
      if (sqrt_price_x64 > 0 && Number.isFinite(cDecA) && Number.isFinite(cDecB)) {
        try {
          const two64 = Math.pow(2, 64);
          const ratio = sqrt_price_x64 / two64;
          // Orca sqrt encodes sqrt(B/A) in smallest units. Let R = ratio.
          // Then B/A = R^2, so A/B = 1 / R^2.
          // Adjust for decimals: amounts are in smallest units, so scale = 10^(decB-decA).
          // Therefore A-per-1-B (in whole-token units) = (scale) / (R^2).
          // NOTE: Orca uses decB - decA, while Raydium uses decA - decB (see raydium.ts)
          const scale = Math.pow(10, (cDecB as number) - (cDecA as number));
          const aPerB = scale / (ratio * ratio);
          if (Number.isFinite(aPerB) && aPerB > 0) priceFromSqrt = aPerB;
        } catch (e) {
          // If sqrt calculation fails, log for debugging
          try {
            logger.debug('orca.priceFromSqrt.calc.failed', { 
              id, 
              mint_a: cA, 
              mint_b: cB, 
              sqrt_price_x64,
              decA: cDecA, 
              decB: cDecB,
              error: String(e?.message || e),
              cat: 'orca' 
            });
          } catch {}
        }
      } else {
        // Log when we can't compute priceFromSqrt due to missing data
        if (sqrt_price_x64 > 0) {
          try {
            logger.debug('orca.priceFromSqrt.missing.decimals', { 
              id, 
              mint_a: cA, 
              mint_b: cB, 
              sqrt_price_x64,
              decA: cDecA, 
              decB: cDecB,
              decA_finite: Number.isFinite(cDecA),
              decB_finite: Number.isFinite(cDecB),
              cat: 'orca' 
            });
          } catch {}
        }
      }
      
      // Fallback: try to derive price from token amounts if sqrt calculation failed
      if (priceFromSqrt === 0 && cAmtA > 0 && cAmtB > 0 && Number.isFinite(cDecA) && Number.isFinite(cDecB)) {
        try {
          const wholeA = cAmtA / Math.pow(10, cDecA as number);
          const wholeB = cAmtB / Math.pow(10, cDecB as number);
          if (wholeA > 0 && wholeB > 0 && Number.isFinite(wholeA) && Number.isFinite(wholeB)) {
            // A per 1 B = (amountA / amountB) adjusted for decimals already handled above
            const derivedFromAmounts = wholeA / wholeB;
            if (Number.isFinite(derivedFromAmounts) && derivedFromAmounts > 0) {
              priceFromSqrt = derivedFromAmounts;
            }
          }
        } catch {}
      }
      
      // Handle fallback to incomingPrice: normalize if it appears to be in wrong units
      let incomingCanonical = (incomingPrice > 0) ? incomingPrice : 0;
      if (priceFromSqrt === 0 && incomingCanonical > 0 && Number.isFinite(cDecA) && Number.isFinite(cDecB)) {
        // The Orca API price field might be in smallest units rather than whole-token units
        // If the price is suspiciously large (> 1e6), it might need decimal normalization
        // However, we'll let calibrateMagnitude handle the fine-tuning with its power-of-10 search
        // Just add debug logging to help diagnose
        if (incomingCanonical > 1e6) {
          try {
            logger.debug('orca.incomingPrice.fallback', { 
              id, 
              mint_a: cA, 
              mint_b: cB, 
              incomingPrice: incomingCanonical,
              decA: cDecA, 
              decB: cDecB,
              sqrt_price_x64,
              hint: 'priceFromSqrt failed, using incomingPrice which may need normalization',
              cat: 'orca' 
            });
          } catch {}
        }
      }
      
      let priceDerived = priceFromSqrt > 0 ? priceFromSqrt : incomingCanonical;
      
      // Magnitude-only calibration (no flips)
      try {
        const { getPriceByMint } = await import('../../server/priceStore.js');
        const getUsd = (m: string) => { try { return getPriceByMint(m)?.usdc ?? undefined; } catch { return undefined; } };
        const { calibrateMagnitude } = await import('../../server/priceCalib.js');
        const calibrated = calibrateMagnitude(cA, cB, priceDerived, getUsd);
        if (calibrated && calibrated > 0) priceDerived = calibrated;
      } catch {}
      // No USD-based orientation here; orientation handled centrally in graph
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
  // Canonicalize pairs using unified policy; handles A/B swap and price inversion when needed
  const clmmCanon = canonicalizePairs(clmm);
  
  // Verify canonicalization: ensure price inversion happens correctly when mints are swapped
  try {
    const clmmVerification = verifyCanonicalization(clmmCanon, swapABFields);
    if (!clmmVerification.valid) {
      try {
        logger.warn('orca.canonicalization.verification.failed', {
          clmmErrors: clmmVerification.errors.length,
          cat: 'orca'
        });
      } catch {}
    }
  } catch {}
  
  if (!clmm.length) {
    logger.warn('orca.http normalized 0 clmm', { hint: 'Check inspect log for field presence and pool types' });
  }
  return { amm: [], clmm: clmmCanon };
}


