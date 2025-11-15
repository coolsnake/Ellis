import { logger } from '../../utils/logger.js';
import { emit } from '../realtime.js';
import { CONFIG } from '../../utils/config.js';
import { writeJson, joinPath } from '../../utils/fs.js';
import type { ClmmPool, PoolsPayload } from './types.js';
import { canonicalizePairs, validateHttpUrl, swapABFields } from './common.js';
import { verifyCanonicalization } from './validation.js';
import { httpLogStart, httpLogResponse, httpLog429, httpLogNonOk } from './httpLog.js';
import { anyToBigInt, ratioToDecimalString, sqrtPriceX64ToPriceRatio } from './precision.js';

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
  let tokenModule: any = null;
  let enrichedDecimals: Map<string, number> = new Map();
  try {
    tokenModule = await import('../../utils/tokens.js');
    if (typeof (tokenModule as any).resolveMint === 'function') {
      resolveMintFn = (tokenModule as any).resolveMint as any;
    }
  } catch {}
  const arrCandidates: any[] = [];
  if (Array.isArray(raw)) arrCandidates.push(raw);
  if (Array.isArray(raw?.data)) arrCandidates.push(raw.data);
  if (Array.isArray(raw?.pools)) arrCandidates.push(raw.pools);
  if (Array.isArray(raw?.whirlpools)) arrCandidates.push(raw.whirlpools);
  const arr: any[] = arrCandidates.find(a => Array.isArray(a) && a.length) || (Array.isArray(raw) ? raw : (Array.isArray(raw?.data) ? raw.data : []));
  
  // Enrich missing token decimals before price calculations
  try {
    const enrichFn = tokenModule?.enrichPoolTokenDecimals;
    if (typeof enrichFn === 'function') {
      const maybeMap = await enrichFn(arr, { logger, forceOnchain: true });
      if (maybeMap instanceof Map) enrichedDecimals = maybeMap;
    } else {
      const { enrichPoolTokenDecimals } = await import('../../utils/tokens.js');
      enrichedDecimals = await enrichPoolTokenDecimals(arr, { logger, forceOnchain: true });
    }
  } catch (err: any) {
    try { logger.warn('orca.normalizer.enrich.failed', { error: String(err?.message || err), cat: 'pools' }); } catch {}
    enrichedDecimals = new Map();
  }
  
  // Reload Jupiter decimals after enrichment so this pass sees new tokens immediately
  try {
    if (typeof tokenModule?.loadJupiterTokenMap === 'function') {
      jupMap = await tokenModule.loadJupiterTokenMap();
    } else {
      const { loadJupiterTokenMap } = await import('../../utils/tokens.js');
      jupMap = await loadJupiterTokenMap();
    }
  } catch {}
  
  for (const it of arr) {
    const id = String(it?.address || it?.id || '');
    const tokenA = it?.tokenA || it?.token_a || {};
    const tokenB = it?.tokenB || it?.token_b || {};
    let mint_a = String(tokenA?.mint || it?.mintA || '');
    let mint_b = String(tokenB?.mint || it?.mintB || '');
    let decA = Number((tokenA?.decimals ?? it?.decimalsA));
    let decB = Number((tokenB?.decimals ?? it?.decimalsB));
    const enrichedA = enrichedDecimals.get(mint_a);
    const enrichedB = enrichedDecimals.get(mint_b);
    if (typeof enrichedA === 'number' && Number.isFinite(enrichedA)) decA = enrichedA;
    if (typeof enrichedB === 'number' && Number.isFinite(enrichedB)) decB = enrichedB;
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
    const liquidityRaw = anyToBigInt(liquidityVal);
    const tick_spacing = Number((it?.tickSpacing ?? it?.state?.tickSpacing) || 0);
    const amtAraw = (it?.tokenBalanceA ?? it?.tokenAAmount ?? it?.token_a_amount ?? it?.amountA ?? it?.baseAmount ?? 0);
    const amtBraw = (it?.tokenBalanceB ?? it?.tokenBAmount ?? it?.token_b_amount ?? it?.amountB ?? it?.quoteAmount ?? 0);
    let amount_a = Number(typeof amtAraw === 'string' ? Number(amtAraw) : amtAraw || 0);
    let amount_b = Number(typeof amtBraw === 'string' ? Number(amtBraw) : amtBraw || 0);
    const incomingPrice = Number(it?.price ?? it?.price_a_per_b ?? it?.priceAperB ?? 0);
    if (isWhirlpool && id && sqrt_price_x64 > 0) {
      const sqrtRaw = anyToBigInt(sqrtPriceStr);
      let priceRatio = sqrtRaw && Number.isFinite(decA) && Number.isFinite(decB)
        ? sqrtPriceX64ToPriceRatio(sqrtRaw, decA as number, decB as number)
        : null;
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
        // Derive/extract execution-critical accounts for Orca Whirlpool
        let oracle: string | undefined;
        let token_vault_a: string | undefined;
        let token_vault_b: string | undefined;
        let account_a: string | undefined;
        let account_b: string | undefined;
        try {
          // Extract oracle if present in API response
          const oracleFromApi = String((it as any)?.oracle ?? '');
          if (oracleFromApi && oracleFromApi !== '11111111111111111111111111111111') {
            oracle = oracleFromApi;
          } else {
            // Derive oracle PDA: [b"oracle", whirlpool.key()]
            try {
              const { PublicKey } = await import('@solana/web3.js');
              const poolPk = new PublicKey(id);
              const programId = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
              const [oraclePda] = PublicKey.findProgramAddressSync(
                [Buffer.from('oracle'), poolPk.toBuffer()],
                programId
              );
              oracle = oraclePda.toBase58();
            } catch {}
          }
          
          // Extract vault accounts from API response
          const vaultA = String((it as any)?.tokenVaultA ?? (it as any)?.token_vault_a ?? (it as any)?.vaultA ?? '');
          const vaultB = String((it as any)?.tokenVaultB ?? (it as any)?.token_vault_b ?? (it as any)?.vaultB ?? '');
          if (vaultA && vaultA !== '11111111111111111111111111111111') {
            token_vault_a = vaultA;
            account_a = vaultA;  // Use vault as account_a
          }
          if (vaultB && vaultB !== '11111111111111111111111111111111') {
            token_vault_b = vaultB;
            account_b = vaultB;  // Use vault as account_b
          }
        } catch (e: any) {
          try {
            logger.debug('orca.exec_accounts.extraction.failed', {
              cat: 'orca',
              ctx: { pool: id, error: String(e?.message || e) }
            });
          } catch {}
        }
        
        clmm.push({
          id,
          dex: 'Orca',
          mint_a: cA,
          mint_b: cB,
          fee_bps,
          sqrt_price_x64,
          sqrt_price_x64_raw: sqrtRaw ? sqrtRaw.toString() : undefined,
          liquidity,
          liquidity_raw: liquidityRaw ? liquidityRaw.toString() : undefined,
          tick_spacing,
          updated_ms: now,
          price_a_per_b: priceDerived > 0 ? priceDerived : undefined,
          price_a_per_b_num: priceRatio ? priceRatio.numerator.toString() : undefined,
          price_a_per_b_den: priceRatio ? priceRatio.denominator.toString() : undefined,
          price_a_per_b_exact: ratioToDecimalString(priceRatio) ?? undefined,
          amount_a: cAmtA,
          amount_b: cAmtB,
          decimals_a: Number.isFinite(cDecA) ? cDecA : undefined,
          decimals_b: Number.isFinite(cDecB) ? cDecB : undefined,
          account_a,
          account_b,
          pool_kind: 'clmm',
          pool_liquidity_raw,
          tvl_usd,
          liquidity_display,
          oracle,
          token_vault_a,
          token_vault_b,
        });
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
  
  // OPTIMIZATION: Pre-cache Orca pool states to eliminate RPC calls during transaction building
  await populateOrcaPoolStates(clmmCanon);
  
  return { amm: [], clmm: clmmCanon };
}

/**
 * Pre-populate execution cache with Orca Whirlpool CLMM states
 * This eliminates 100-300ms RPC calls per Orca swap during transaction building
 * Similar to populateMeteoraActiveIds but for Orca pools
 */
async function populateOrcaPoolStates(pools: ClmmPool[]): Promise<void> {
  if (!pools || pools.length === 0) return;
  
  try {
    const { executionCache } = await import('../../execution/cache.js');
    const { getConnection } = await import('../../wallet/wallet.js');
    const { withRpcLimit } = await import('../../utils/rpcLimiter.js');
    const { PublicKey } = await import('@solana/web3.js');
    const sdkAny: any = await import('@orca-so/whirlpools-sdk').catch(() => null);
    const ParsableWhirlpool = sdkAny?.ParsableWhirlpool;
    const PriceMath = sdkAny?.PriceMath;
    let BN = sdkAny?.BN;
    if (!BN) {
      try { BN = (await import('bn.js')).default; } catch {}
    }
    const connection = getConnection();
    
    const startTime = Date.now();
    let cached = 0;
    let failed = 0;
    
    const WHIRLPOOL_PROGRAM_ID = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
    
    // Batch fetch pool states (100 at a time to respect RPC limits)
    const BATCH_SIZE = 100;
    for (let i = 0; i < pools.length; i += BATCH_SIZE) {
      const batch = pools.slice(i, i + BATCH_SIZE);
      const pubkeys = batch.map(p => {
        try {
          const id = p.id.replace(/-rev$/, ''); // Strip -rev suffix
          return new PublicKey(id);
        } catch {
          return null;
        }
      }).filter((pk): pk is InstanceType<typeof PublicKey> => pk !== null);
      
      if (pubkeys.length === 0) continue;
      
      try {
        // Fetch multiple pool accounts in one RPC call
        const accounts = await withRpcLimit(() => connection.getMultipleAccountsInfo(pubkeys));
        
        if (accounts.length !== pubkeys.length) {
          try {
            logger.warn('orca.poolState.batch_length_mismatch', {
              cat: 'orca',
              ctx: {
                batchStart: i,
                batchSize: batch.length,
                pubkeysLength: pubkeys.length,
                accountsLength: accounts.length,
                expected: pubkeys.length
              }
            });
          } catch {}
        }
        
        for (let j = 0; j < Math.min(accounts.length, batch.length); j++) {
          const pool = batch[j];
          const acc = accounts[j];
          
          if (!acc) {
            failed++;
            try {
              logger.info('orca.poolState.account_not_found', {
                cat: 'orca',
                ctx: {
                  pool: pool.id.slice(0, 8) + '...',
                  poolId: pool.id,
                  strippedId: pool.id.replace(/-rev$/, ''),
                  hint: 'pool missing on-chain'
                }
              });
            } catch {}
            continue;
          }
          
          if (!acc.data) {
            failed++;
            try {
              logger.info('orca.poolState.account_no_data', {
                cat: 'orca',
                ctx: {
                  pool: pool.id.slice(0, 8) + '...',
                  poolId: pool.id,
                  accountOwner: acc.owner?.toBase58?.() || 'unknown',
                  accountLamports: acc.lamports || 0
                }
              });
            } catch {}
            continue;
          }
          
          try {
            const poolPk = pubkeys[j];
            const buffer = Buffer.from(acc.data);
            const SQRT_PRICE_OFFSET = 65;
            const TICK_OFFSET = 101;
            const LIQUIDITY_OFFSET = 181;
            const FEE_RATE_OFFSET = 205;
            
            let sqrtPriceX64: bigint | undefined;
            let tickIndex: number | undefined;
            let liquidity: bigint | undefined;
            let feeRateBps: number | undefined;
            
            let parsed: any = null;
            if (ParsableWhirlpool && typeof ParsableWhirlpool.parse === 'function') {
              try { parsed = ParsableWhirlpool.parse(poolPk, acc); } catch {}
            }
            
            if (parsed) {
              sqrtPriceX64 = BigInt(parsed.sqrtPrice?.toString?.() || '0');
              tickIndex = Number(parsed.tickCurrentIndex);
              liquidity = BigInt(parsed.liquidity?.toString?.() || '0');
            } else {
              const sqrtLow = buffer.readBigUInt64LE(SQRT_PRICE_OFFSET);
              const sqrtHigh = buffer.readBigUInt64LE(SQRT_PRICE_OFFSET + 8);
              sqrtPriceX64 = sqrtLow + (sqrtHigh << 64n);
              tickIndex = buffer.readInt32LE(TICK_OFFSET);
              const liqLow = buffer.readBigUInt64LE(LIQUIDITY_OFFSET);
              const liqHigh = buffer.readBigUInt64LE(LIQUIDITY_OFFSET + 8);
              liquidity = liqLow + (liqHigh << 64n);
            }
            
            const feeRateRaw = buffer.length >= FEE_RATE_OFFSET + 2 ? buffer.readUInt16LE(FEE_RATE_OFFSET) : undefined;
            if (feeRateRaw != null) {
              feeRateBps = Math.round(feeRateRaw / 100);
            }
            
            executionCache.setHot(pool.id, {
              sqrtPriceX64,
              currentTickIndex: tickIndex,
              liquidity,
              feeRate: feeRateBps
            });
            cached++;
            
            // Enrich normalized pool in-place so downstream graph/builders have prices
            if (sqrtPriceX64) {
              (pool as any).sqrt_price_x64_raw = sqrtPriceX64.toString();
            }
            if (Number.isFinite(tickIndex)) {
              (pool as any).tick_current_index = tickIndex;
            }
            if (liquidity) {
              (pool as any).liquidity_raw = liquidity.toString();
              (pool as any).liquidity = Number(liquidity.toString());
            }
            
            let derivedPrice: number | undefined;
            const decA = Number((pool as any).decimals_a);
            const decB = Number((pool as any).decimals_b);
            if (
              PriceMath &&
              BN &&
              sqrtPriceX64 &&
              Number.isFinite(decA) &&
              Number.isFinite(decB)
            ) {
              try {
                const sqrtForSdk =
                  parsed?.sqrtPrice && BN.isBN(parsed.sqrtPrice)
                    ? parsed.sqrtPrice
                    : new BN(sqrtPriceX64.toString());
                const priceDec = PriceMath.sqrtPriceX64ToPrice(sqrtForSdk, decA, decB);
                const priceNum =
                  typeof priceDec?.toNumber === 'function'
                    ? priceDec.toNumber()
                    : Number(priceDec?.toString?.() ?? priceDec);
                if (Number.isFinite(priceNum) && priceNum > 0) {
                  derivedPrice = priceNum;
                }
              } catch {}
            }
            
            if (!derivedPrice && PriceMath && BN && Number.isFinite(decA) && Number.isFinite(decB) && Number.isFinite(tickIndex)) {
              try {
                const priceDec = PriceMath.priceFromTick(Number(tickIndex), decA, decB);
                const priceNum =
                  typeof priceDec?.toNumber === 'function'
                    ? priceDec.toNumber()
                    : Number(priceDec?.toString?.() ?? priceDec);
                if (Number.isFinite(priceNum) && priceNum > 0) {
                  derivedPrice = priceNum;
                }
              } catch {}
            }
            
            if (derivedPrice && derivedPrice > 0) {
              (pool as any).price_a_per_b = derivedPrice;
              (pool as any).price_a_per_b_exact = derivedPrice.toString();
            }
            
            try {
              logger.info('orca.poolState.cached', {
                cat: 'orca',
                ctx: {
                  pool: pool.id.slice(0, 8) + '...',
                  sqrtPriceX64: sqrtPriceX64?.toString(),
                  currentTickIndex: tickIndex,
                  liquidity: liquidity?.toString(),
                  feeRate: feeRateBps,
                  price: derivedPrice
                }
              });
            } catch {}
          } catch (readErr) {
            failed++;
            try {
              logger.warn('orca.poolState.read_failed', {
                cat: 'orca',
                ctx: {
                  pool: pool.id.slice(0, 8) + '...',
                  error: String((readErr as any)?.message || readErr)
                }
              });
            } catch {}
          }
        }
      } catch (batchErr) {
        failed += batch.length;
        try {
          logger.error('orca.poolState.batch_failed', {
            cat: 'orca',
            ctx: {
              batchStart: i,
              batchSize: batch.length,
              error: String((batchErr as any)?.message || batchErr)
            }
          });
        } catch {}
      }
    }
    
    const durationMs = Date.now() - startTime;
    const avgMs = pools.length > 0 ? Math.round(durationMs / pools.length) : 0;
    
    try {
      logger.info('orca.poolState.cache_populated', {
        cat: 'orca',
        ctx: {
          total: pools.length,
          cached,
          failed,
          durationMs,
          avgMs
        }
      });
    } catch {}
  } catch (err) {
    try {
      logger.error('orca.poolState.cache_error', {
        cat: 'orca',
        ctx: {
          error: String((err as any)?.message || err),
          stack: (err as any)?.stack
        }
      });
    } catch {}
  }
}


