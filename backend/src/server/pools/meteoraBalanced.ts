import { logger } from '../../utils/logger.js';
import { emit } from '../realtime.js';
import { CONFIG } from '../../utils/config.js';
import { writeJson, joinPath } from '../../utils/fs.js';
import type { AmmPool, PoolsPayload } from './types.js';
import { validateHttpUrl } from './common.js';
import { canonicalizePools } from './canonical.js';
import { resolveManyDecimals } from './decimals.js';
import { httpLogStart, httpLogResponse, httpLog429, httpLogNonOk } from './httpLog.js';
import { PublicKey } from '@solana/web3.js';
import { anyToBigInt } from './precision.js';

export async function fetchMeteoraBalancedHttp(): Promise<any> {
  const RAW_PATH = joinPath(CONFIG.cacheDir, 'meteora-balanced-raw-sample.json');
  try {
    const cfg = (CONFIG as any)?.meteoraBalanced || {};
    const baseUnsafe = cfg.apiUrl || '';
    const base = validateHttpUrl(baseUnsafe) || '';
    if (!base) { try { await writeJson(RAW_PATH, []); } catch {}; return []; }
    
    // Check if we should use anchor-tokens-only mode (higher quality, more efficient)
    const anchorTokensOnly = cfg.anchorTokensOnly !== false; // Default: true
    if (anchorTokensOnly) {
      // Use the V1 fetcher which already implements anchor-token filtering
      try {
        logger.info('meteora.balanced.fetch using anchor-tokens-only mode', { cat: 'meteora' });
      } catch {}
      return await fetchMeteoraBalancedV1Http(base);
    }
    
    // Otherwise, fetch all pools with quality filters
    const retries = Number(cfg.maxHttpRetries || 2);
    const backoffMs = Number(cfg.httpBackoffMs || 500);
    const maxPages = Number(cfg.maxPages || 3);
    const size = Number(cfg.pageSize || 200);
    
    // API-level quality filters
    const minLiqBase = Number(cfg.minLiqBase || 0); // For hide_low_tvl API parameter
    const hideLowApr = cfg.hideLowApr === true;
    const tokensVerified = cfg.tokensVerified === true;
    
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
          // Add quality filters to API request
          // hide_low_tvl expects a number (minimum TVL in USD)
          if (minLiqBase > 0) sp.append('hide_low_tvl', String(minLiqBase));
          if (hideLowApr) sp.append('hide_low_apr', 'true');
          if (tokensVerified) sp.append('tokens_verified', 'true');
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
        try {
          logger.info('meteora.balanced.fetch complete', {
            count: out.length,
            minLiqBase,
            hideLowApr,
            tokensVerified,
            cat: 'meteora'
          });
        } catch {}
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

  // Extract all unique mints for batch decimal resolution
  const allMints = new Set<string>();
  for (const it of arr) {
    const a = it?.tokenA || it?.mintA || it?.base || {};
    const b = it?.tokenB || it?.mintB || it?.quote || {};
    const mint_a = String(it?.token_a_mint || toMint(a) || toMint(a?.info) || it?.mintA || '');
    const mint_b = String(it?.token_b_mint || toMint(b) || toMint(b?.info) || it?.mintB || '');
    if (mint_a) allMints.add(mint_a);
    if (mint_b) allMints.add(mint_b);
  }
  
  // Batch resolve decimals using centralized resolver with RPC-first validation
  const decimalsMap = await resolveManyDecimals(Array.from(allMints), { 
    logger, 
    normalizeMode: true // RPC validation priority during normalization
  });
  const toDec = (v: any): number | undefined => {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const toFeeBps = (v: any): number => {
    const n = Number(v?.feeRate ?? v?.tradeFeeRate ?? v?.tradeFeeBps ?? v?.feeBps ?? 0);
    if (!Number.isFinite(n) || n <= 0) return 0;
    if (n > 100) return Math.round(n);
    if (n >= 1) return Math.round(n * 100);
    return Math.round(n * 10_000);
  };

  const deriveAtomic = (raw: any, fallbackWhole?: number, decimals?: number): bigint | null => {
    const val = anyToBigInt(raw);
    if (val && val > 0n) return val;
    if (fallbackWhole != null && Number.isFinite(fallbackWhole) && decimals != null && Number.isFinite(decimals)) {
      const scale = Math.pow(10, decimals as number);
      if (Number.isFinite(scale)) {
        const scaled = Math.round((fallbackWhole as number) * scale);
        if (Number.isFinite(scaled)) {
          try { return BigInt(scaled); } catch {}
        }
      }
    }
    return null;
  };

  for (const it of arr) {
    try {
      const id = String(it?.pool_address || it?.address || it?.id || '');
      const a = it?.tokenA || it?.mintA || it?.base || {};
      const b = it?.tokenB || it?.mintB || it?.quote || {};
      const mint_a = String(it?.token_a_mint || toMint(a) || toMint(a?.info) || it?.mintA || '');
      const mint_b = String(it?.token_b_mint || toMint(b) || toMint(b?.info) || it?.mintB || '');
      if (!id || !mint_a || !mint_b) continue;

      // Extract pool version to determine which program this pool uses
      // This is CRITICAL: v1 and v2 use different on-chain programs
      const poolVersion = Number(it?.pool_version ?? 2); // Default to v2 for V2 API
      const dex = poolVersion === 1 ? 'MeteoraBalanced_v1' : 'MeteoraBalanced_v2';

      // Get decimals from centralized resolver with API fallback
      let decA = toDec(a?.decimals ?? it?.decimalsA) ?? decimalsMap.get(mint_a) ?? 6;
      let decB = toDec(b?.decimals ?? it?.decimalsB) ?? decimalsMap.get(mint_b) ?? 6;
      
      // CRITICAL: Check if we have pre-converted whole amounts from RPC enrichment
      // If vault_a_whole exists, use it directly (already divided by decimals)
      // Otherwise, try to parse from API's raw amounts
      let wholeA = Number.NaN;
      let wholeB = Number.NaN;
      
      if (it?.vault_a_whole !== undefined && it?.vault_b_whole !== undefined) {
        // Use enriched whole amounts (already converted)
        wholeA = Number(it.vault_a_whole);
        wholeB = Number(it.vault_b_whole);
      } else {
        // Fall back to API's raw amounts and convert them
        const amtAraw = Number(it?.reserveA ?? it?.amountA ?? it?.tokenAmountA ?? 0);
        const amtBraw = Number(it?.reserveB ?? it?.amountB ?? it?.tokenAmountB ?? 0);
        wholeA = (Number.isFinite(amtAraw) && Number.isFinite(decA)) ? (amtAraw / Math.pow(10, decA as number)) : NaN;
        wholeB = (Number.isFinite(amtBraw) && Number.isFinite(decB)) ? (amtBraw / Math.pow(10, decB as number)) : NaN;
      }
      
      // Parse TVL and apply scaling if needed (API may return in milli-USD)
      const tvlRaw = Number(it?.tvl ?? it?.tvlUsd ?? it?.tvl_usd ?? 0);
      
      // IMPORTANT: Meteora Balanced API may return TVL in milli-USD (10^-3)
      // Heuristic: if TVL is suspiciously small compared to reserves, scale it up by 1000x
      let tvl_usd: number | undefined = undefined;
      if (Number.isFinite(tvlRaw) && tvlRaw > 0) {
        if (Number.isFinite(wholeA) && Number.isFinite(wholeB)) {
          const minReserve = Math.min(wholeA, wholeB);
          // If minReserve is > 1 but TVL is < 1% of it, likely needs scaling
          // BUT: Don't scale if absolute TVL < 0.1 (likely rugpulled or dust)
          if (minReserve > 1 && tvlRaw < minReserve * 0.01 && tvlRaw * 1000 < minReserve * 100 && tvlRaw >= 0.1) {
            tvl_usd = tvlRaw * 1000;  // Scale from milli-USD to USD
            try {
              logger.debug('meteora.balanced.tvl.scaled', {
                id,
                tvlRaw,
                tvlScaled: tvl_usd,
                minReserve,
                scaleFactor: 1000,
                cat: 'meteora'
              });
            } catch {}
          } else {
            tvl_usd = tvlRaw;  // Use as-is
          }
        } else {
          tvl_usd = tvlRaw;  // No reserve data to compare, use as-is
        }
      }
      
      // Prefer v2 base_fee/dynamic_fee (assumed percent); fallback to existing numeric fields
      let fee_bps = (() => {
        try {
          const bf = Number((it as any)?.base_fee);
          const df = Number((it as any)?.dynamic_fee);
          if (Number.isFinite(bf) || Number.isFinite(df)) {
            const pct = (Number.isFinite(bf) ? bf : 0) + (Number.isFinite(df) ? df : 0);
            if (Number.isFinite(pct)) return Math.round(pct * 100);
          }
        } catch {}
        return toFeeBps(it);
      })();

      let price_a_per_b = 0;
      if (Number.isFinite(wholeA) && Number.isFinite(wholeB) && (wholeB as number) > 0) {
        price_a_per_b = (wholeA as number) / (wholeB as number);
        
        // DIAGNOSTIC: Log price calculation details for problematic prices
        if (price_a_per_b > 100000 || price_a_per_b < 0.00001) {
          try {
            const amtAraw = Number(it?.reserveA ?? it?.amountA ?? it?.tokenAmountA ?? 0);
            const amtBraw = Number(it?.reserveB ?? it?.amountB ?? it?.tokenAmountB ?? 0);
            logger.info('meteora.balanced.price_extreme', {
              pool_id: id.slice(0, 12),
              mint_a: mint_a.slice(0, 8),
              mint_b: mint_b.slice(0, 8),
              amtAraw,
              amtBraw,
              decA,
              decB,
              wholeA,
              wholeB,
              price_a_per_b,
              has_vault_whole: it?.vault_a_whole !== undefined,
              source_a: it?.vault_a_whole !== undefined ? 'vault_whole' : (it?.reserveA ? 'reserveA' : (it?.amountA ? 'amountA' : 'other')),
              source_b: it?.vault_b_whole !== undefined ? 'vault_whole' : (it?.reserveB ? 'reserveB' : (it?.amountB ? 'amountB' : 'other')),
              cat: 'meteora.diagnostic'
            });
          } catch {}
        }
      } else {
        const p = Number(it?.price ?? it?.price_a_per_b ?? it?.priceAperB);
        if (Number.isFinite(p) && p > 0) price_a_per_b = p;
      }
      
      // Log pools without price for debugging
      if (!(price_a_per_b > 0)) {
        try { 
          logger.debug('meteora.balanced.no_price', { 
            id, 
            mint_a, 
            mint_b, 
            hasWholeA: Number.isFinite(wholeA), 
            hasWholeB: Number.isFinite(wholeB),
            wholeA: Number.isFinite(wholeA) ? wholeA : 'NaN',
            wholeB: Number.isFinite(wholeB) ? wholeB : 'NaN',
            hasDecA: Number.isFinite(decA),
            hasDecB: Number.isFinite(decB),
            hasVaultWhole: it?.vault_a_whole !== undefined,
            cat: 'meteora' 
          }); 
        } catch {}
      }

      const liquidity_base = (Number.isFinite(wholeA) && Number.isFinite(wholeB))
        ? Math.min(wholeA as number, wholeB as number)
        : 0;

      // Calculate pool_liquidity_raw with proper priority
      const pool_liquidity_raw = (() => {
        // Priority 1: Use scaled TVL USD if available and valid
        if (tvl_usd != null && tvl_usd > 0) return tvl_usd;
        
        // Priority 2: Use min of reserves (token units) when available
        if (liquidity_base > 0) return liquidity_base;
        
        return undefined;
      })();

      const reserveAAtomic = deriveAtomic(
        (it?.reserveA ?? it?.amountA ?? it?.tokenAmountA ?? it?.token_a_amount ?? it?.vault_a_amount ?? 0),
        Number.isFinite(wholeA) ? wholeA : undefined,
        decA,
      );
      const reserveBAtomic = deriveAtomic(
        (it?.reserveB ?? it?.amountB ?? it?.tokenAmountB ?? it?.token_b_amount ?? it?.vault_b_amount ?? 0),
        Number.isFinite(wholeB) ? wholeB : undefined,
        decB,
      );
      const reserve_a_raw = reserveAAtomic ? reserveAAtomic.toString() : undefined;
      const reserve_b_raw = reserveBAtomic ? reserveBAtomic.toString() : undefined;

      // Extract vault addresses - these are required for WebSocket decoding
      const account_a = String(it?.token_a_vault || '');
      const account_b = String(it?.token_b_vault || '');
      
      // Log warning if vault addresses are missing (this will cause WebSocket decode skips)
      if (!account_a || !account_b) {
        try {
          logger.debug('meteora.balanced.missing_vault_addresses', {
            id,
            mint_a,
            mint_b,
            hasTokenAVault: !!it?.token_a_vault,
            hasTokenBVault: !!it?.token_b_vault,
            cat: 'meteora'
          });
        } catch {}
      }
      
      amm.push({
        id,
        dex,  // 'MeteoraBalanced_v1' or 'MeteoraBalanced_v2' based on pool_version
        mint_a,
        mint_b,
        fee_bps,
        price_a_per_b: (price_a_per_b > 0) ? price_a_per_b : undefined,
        liquidity_base,
        updated_ms: now,
        pool_kind: 'amm',
        // Vault addresses for swap instructions
        account_a,
        account_b,
        lp_mint: String(it?.lp_mint || ''),
        amount_a_whole: Number.isFinite(wholeA) ? wholeA as number : undefined,
        amount_b_whole: Number.isFinite(wholeB) ? wholeB as number : undefined,
        amounts_are_whole: Number.isFinite(wholeA) || Number.isFinite(wholeB) ? true : undefined,
        decimals_a: Number.isFinite(decA as any) ? (decA as number) : undefined,
        decimals_b: Number.isFinite(decB as any) ? (decB as number) : undefined,
        reserve_a_raw,
        reserve_b_raw,
        tvl_usd: tvl_usd != null && tvl_usd > 0 ? tvl_usd : undefined,
        pool_liquidity_raw,
        liquidity_display: tvl_usd != null && tvl_usd > 0 ? tvl_usd : (liquidity_base > 0 ? liquidity_base : undefined),
        native_mint_a: mint_a,
        native_mint_b: mint_b,
        native_decimals_a: decA,
        native_decimals_b: decB,
        native_account_a: account_a,
        native_account_b: account_b,
        native_reserve_a_raw: reserve_a_raw,
        native_reserve_b_raw: reserve_b_raw,
      });
    } catch (err: any) {
      try {
        logger.warn('meteora.balanced.normalize.failed', {
          error: String(err?.message || err),
          pool: String((it as any)?.address || (it as any)?.pool_address || ''),
          cat: 'meteora',
        });
      } catch {}
    }
  }

  const ammCanon = canonicalizePools(amm);
  
  // Count pools with and without prices for diagnostics
  try {
    const withPrice = ammCanon.filter(p => Number.isFinite(p.price_a_per_b) && (p.price_a_per_b || 0) > 0).length;
    const withoutPrice = ammCanon.length - withPrice;
    if (withoutPrice > 0) {
      logger.info('meteora.balanced.v2.price_coverage', {
        total: ammCanon.length,
        withPrice,
        withoutPrice,
        percentageWithPrice: Math.round((withPrice / ammCanon.length) * 100),
        cat: 'meteora'
      });
    }
  } catch {}
  
  // Optional: Apply minimum liquidity filtering
  try {
    const minLiqBase = Number((CONFIG as any)?.meteoraBalanced?.minLiqBase || 0);
    if (minLiqBase > 0) {
      const beforeFilter = ammCanon.length;
      const filtered = ammCanon.filter(p => {
        const liq = p.tvl_usd ?? p.pool_liquidity_raw ?? p.liquidity_base ?? 0;
        const hasDecimals = Number.isFinite(p.decimals_a) && Number.isFinite(p.decimals_b);
        
        // Log pools that are filtered out due to missing data
        if (liq < minLiqBase && liq === 0 && !hasDecimals) {
          try {
            logger.debug('meteora.balanced.filter.no_liq_no_decimals', {
              pool: p.id,
              mintA: p.mint_a,
              mintB: p.mint_b,
              cat: 'meteora'
            });
          } catch {}
        }
        
        return liq >= minLiqBase;
      });
      if (filtered.length !== beforeFilter) {
        try {
          // Count how many were filtered due to missing decimals
          const filteredNoDecimals = ammCanon.filter(p => {
            const liq = p.tvl_usd ?? p.pool_liquidity_raw ?? p.liquidity_base ?? 0;
            const hasDecimals = Number.isFinite(p.decimals_a) && Number.isFinite(p.decimals_b);
            return liq < minLiqBase && !hasDecimals;
          }).length;
          
          logger.info('meteora.balanced.filter.min_liq', {
            before: beforeFilter,
            after: filtered.length,
            minLiqBase,
            filteredNoDecimals,
            cat: 'meteora'
          });
        } catch {}
      }
      try { logger.info('meteora.balanced normalized', { amm: filtered.length, cat: 'meteora' }); } catch {}
      return { amm: filtered, clmm: [] };
    }
  } catch {}
  
  try { logger.info('meteora.balanced normalized', { amm: ammCanon.length, cat: 'meteora' }); } catch {}
  return { amm: ammCanon, clmm: [] };
}

// v1 normalizer: array response shape
export async function normalizeMeteoraBalancedV1(raw: any): Promise<PoolsPayload> {
  const now = Date.now();
  const amm: AmmPool[] = [];
  const arr: any[] = Array.isArray(raw) ? raw : (Array.isArray(raw?.data) ? raw.data : []);
  
  // Extract all unique mints for batch decimal resolution
  const allMints = new Set<string>();
  for (const it of arr) {
    const mints: string[] = Array.isArray((it as any)?.pool_token_mints) ? (it as any).pool_token_mints : [];
    if (mints[0]) allMints.add(String(mints[0]));
    if (mints[1]) allMints.add(String(mints[1]));
  }
  
  // Batch resolve decimals using centralized resolver with RPC-first validation
  const decimalsMap = await resolveManyDecimals(Array.from(allMints), { 
    logger, 
    normalizeMode: true // RPC validation priority during normalization
  });
  
  const toNum = (v: any): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  
  for (const it of (arr || [])) {
    try {
      const id = String(it?.pool_address || '');
      const mints: string[] = Array.isArray((it as any)?.pool_token_mints) ? (it as any).pool_token_mints : [];
      const amounts: (string|number)[] = Array.isArray((it as any)?.pool_token_amounts) ? (it as any).pool_token_amounts : [];
      const usdAmounts: (string|number)[] = Array.isArray((it as any)?.pool_token_usd_amounts) ? (it as any).pool_token_usd_amounts : [];
      const mint_a = String(mints?.[0] || '');
      const mint_b = String(mints?.[1] || '');
      if (!id || !mint_a || !mint_b) continue;
      
      // Extract pool version - V1 API provides this field
      // This is CRITICAL: v1 and v2 use different on-chain programs
      const poolVersion = Number(it?.pool_version ?? 1); // Default to v1 for V1 API
      const dex = poolVersion === 1 ? 'MeteoraBalanced_v1' : 'MeteoraBalanced_v2';
      
      // Get decimals from centralized resolver
      const decimalsA = decimalsMap.get(mint_a) ?? 6;
      const decimalsB = decimalsMap.get(mint_b) ?? 6;
      
      // Parse amounts - V1 API provides whole token amounts (already converted from raw)
      const wholeA = toNum(amounts?.[0]);
      const wholeB = toNum(amounts?.[1]);
      const usdA = toNum(usdAmounts?.[0]);
      const usdB = toNum(usdAmounts?.[1]);
      
      // Calculate price
      let price_a_per_b = 0;
      if (wholeB > 0 && wholeA > 0) {
        price_a_per_b = wholeA / wholeB;
      } else if (usdA > 0 && usdB > 0) {
        price_a_per_b = usdA / usdB;
      }
      
      // Parse TVL and apply scaling if needed
      const tvlRaw = toNum((it as any)?.pool_tvl);
      let tvl_usd = 0;
      if (tvlRaw > 0) {
        const minReserve = (wholeA > 0 && wholeB > 0) ? Math.min(wholeA, wholeB) : 0;
        // If minReserve is > 1 but TVL is < 1% of it, likely needs scaling
        // BUT: Don't scale if absolute TVL < 0.1 (likely rugpulled or dust)
        if (minReserve > 1 && tvlRaw < minReserve * 0.01 && tvlRaw * 1000 < minReserve * 100 && tvlRaw >= 0.1) {
          tvl_usd = tvlRaw * 1000;  // Scale from milli-USD to USD
          try {
            logger.debug('meteora.balanced.v1.tvl.scaled', {
              id,
              tvlRaw,
              tvlScaled: tvl_usd,
              minReserve,
              scaleFactor: 1000,
              cat: 'meteora'
            });
          } catch {}
        } else {
          tvl_usd = tvlRaw;
        }
      }
      
      // Convert total_fee_pct (percent string) to bps
      let fee_bps = (() => {
        const s = String((it as any)?.total_fee_pct ?? '').trim();
        const n = Number(s);
        if (Number.isFinite(n)) return Math.round(n * 100);
        return 0;
      })();
      if (!(fee_bps > 0)) {
        fee_bps = toFeeBps(it);
      }
      if (!(fee_bps > 0)) {
        fee_bps = toFeeBps(it);
      }
      
      const liquidity_base = (wholeA > 0 && wholeB > 0) ? Math.min(wholeA, wholeB) : 0;
      
      // Calculate pool_liquidity_raw
      const pool_liquidity_raw = (() => {
        if (tvl_usd > 0) return tvl_usd;
        if (liquidity_base > 0) return liquidity_base;
        return undefined;
      })();

      const reserveAAtomicV1 = deriveAtomic(
        (it?.reserveA ?? it?.amountA ?? it?.tokenAmountA ?? amounts?.[0] ?? 0),
        Number.isFinite(wholeA) ? wholeA : undefined,
        decimalsA,
      );
      const reserveBAtomicV1 = deriveAtomic(
        (it?.reserveB ?? it?.amountB ?? it?.tokenAmountB ?? amounts?.[1] ?? 0),
        Number.isFinite(wholeB) ? wholeB : undefined,
        decimalsB,
      );
      const reserve_a_raw = reserveAAtomicV1 ? reserveAAtomicV1.toString() : undefined;
      const reserve_b_raw = reserveBAtomicV1 ? reserveBAtomicV1.toString() : undefined;
      
      // Extract vault addresses - these are required for WebSocket decoding
      const account_a = String((it as any)?.pool_token_vaults?.[0] || '');
      const account_b = String((it as any)?.pool_token_vaults?.[1] || '');
      
      // Log warning if vault addresses are missing (this will cause WebSocket decode skips)
      if (!account_a || !account_b) {
        try {
          logger.debug('meteora.balanced.v1.missing_vault_addresses', {
            id,
            mint_a,
            mint_b,
            hasVaultsArray: !!((it as any)?.pool_token_vaults),
            vaultsLength: Array.isArray((it as any)?.pool_token_vaults) ? (it as any).pool_token_vaults.length : 0,
            cat: 'meteora'
          });
        } catch {}
      }
      
      amm.push({
        id,
        dex,  // 'MeteoraBalanced_v1' or 'MeteoraBalanced_v2' based on pool_version
        mint_a,
        mint_b,
        fee_bps,
        price_a_per_b: (price_a_per_b > 0) ? price_a_per_b : undefined,
        liquidity_base,
        updated_ms: now,
        pool_kind: 'amm',
        // Vault addresses for swap instructions (V1 API structure)
        account_a,
        account_b,
        lp_mint: String((it as any)?.lp_mint || ''),
        amount_a_whole: wholeA > 0 ? wholeA : undefined,
        amount_b_whole: wholeB > 0 ? wholeB : undefined,
        decimals_a: decimalsA,
        decimals_b: decimalsB,
        reserve_a_raw,
        reserve_b_raw,
        tvl_usd: tvl_usd > 0 ? tvl_usd : undefined,
        pool_liquidity_raw,
        liquidity_display: (tvl_usd > 0) ? tvl_usd : (liquidity_base > 0 ? liquidity_base : undefined),
        native_mint_a: mint_a,
        native_mint_b: mint_b,
        native_decimals_a: decimalsA,
        native_decimals_b: decimalsB,
        native_account_a: account_a,
        native_account_b: account_b,
        native_reserve_a_raw: reserve_a_raw,
        native_reserve_b_raw: reserve_b_raw,
      } as any);
    } catch (err: any) {
      try {
        logger.warn('meteora.balanced.v1.normalize.failed', {
          error: String(err?.message || err),
          pool: String((it as any)?.address || (it as any)?.pool_address || ''),
          cat: 'meteora',
        });
      } catch {}
    }
  }
  const ammCanon = canonicalizePools(amm);
  
  // Count pools with and without prices for diagnostics
  try {
    const withPrice = ammCanon.filter(p => Number.isFinite(p.price_a_per_b) && (p.price_a_per_b || 0) > 0).length;
    const withoutPrice = ammCanon.length - withPrice;
    if (withoutPrice > 0) {
      logger.info('meteora.balanced.v1.price_coverage', {
        total: ammCanon.length,
        withPrice,
        withoutPrice,
        percentageWithPrice: Math.round((withPrice / ammCanon.length) * 100),
        cat: 'meteora'
      });
    }
  } catch {}
  
  // Optional: Apply minimum liquidity filtering
  try {
    const minLiqBase = Number((CONFIG as any)?.meteoraBalanced?.minLiqBase || 0);
    if (minLiqBase > 0) {
      const beforeFilter = ammCanon.length;
      const filtered = ammCanon.filter(p => {
        const liq = p.tvl_usd ?? p.pool_liquidity_raw ?? p.liquidity_base ?? 0;
        return liq >= minLiqBase;
      });
      if (filtered.length !== beforeFilter) {
        try {
          logger.info('meteora.balanced.v1.filter.min_liq', {
            before: beforeFilter,
            after: filtered.length,
            minLiqBase,
            cat: 'meteora'
          });
        } catch {}
      }
      try { logger.info('meteora.balanced.v1 normalized', { amm: filtered.length, cat: 'meteora' }); } catch {}
      return { amm: filtered, clmm: [] } as any;
    }
  } catch {}
  
  try { logger.info('meteora.balanced.v1 normalized', { amm: ammCanon.length, cat: 'meteora' }); } catch {}
  return { amm: ammCanon, clmm: [] } as any;
}

// New: explicit v1 and v2 HTTP fetchers and a union fetch for both
export async function fetchMeteoraBalancedV1Http(baseUrl?: string): Promise<any[]> {
  const cfg: any = (CONFIG as any)?.meteoraBalanced || {};
  const baseUnsafe = baseUrl || cfg.apiUrl || '';
  const base = validateHttpUrl(baseUnsafe) || '';
  if (!base) return [];
  const retries = Number(cfg.maxHttpRetries || 2);
  const backoffMs = Number(cfg.httpBackoffMs || 500);
  const maxPages = Number(cfg.maxPages || 10);
  const pageSize = Number(cfg.pageSize || 100);
  
  // API-level quality filters (V1 API specific)
  const hideLowApr = cfg.hideLowApr === true;
  const minLiqBase = Number(cfg.minLiqBase || 0);
  const anchorTokensOnly = cfg.anchorTokensOnly !== false;
  
  // eslint-disable-next-line no-undef
  const fetchFn: any = (globalThis as any).fetch || fetch;
  
  // Use the new /pools/search endpoint with include_token_mints filter
  // This endpoint supports pagination and proper token filtering in a single request
  const searchBase = base.replace(/\/pools\/?$/, '/pools/search');
  const allPools = new Map<string, any>(); // Dedupe by pool address
  
  if (anchorTokensOnly) {
    // Fetch pools containing SOL or USDC using the new search endpoint with pagination
    const tokenMints = [
      'So11111111111111111111111111111111111111112', // SOL
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' // USDC
    ];
    
    let page = 0;
    let hasMore = true;
    let totalFetched = 0;
    
    while (hasMore && page < maxPages) {
      const url = (() => {
        const sp = new URLSearchParams();
        sp.append('page', String(page));
        sp.append('size', String(pageSize));
        
        // Add token mint filters - the API will return pools containing ANY of these tokens
        for (const mint of tokenMints) {
          sp.append('include_token_mints', mint);
        }
        
        // Apply quality filters
        if (minLiqBase > 0) {
          sp.append('hide_low_tvl', String(minLiqBase));
        }
        if (hideLowApr) {
          sp.append('hide_low_apr', 'true');
        }
        
        // Filter for dynamic pool type (V1 pools)
        sp.append('pool_type', 'dynamic');
        
        // Sort by TVL descending for quality
        sp.append('sort_key', 'tvl');
        sp.append('order_by', 'desc');
        
        return `${searchBase}?${sp.toString()}`;
      })();
      
      const poolsData = await fetchV1SearchWithRetry(
        url, 
        fetchFn, 
        retries, 
        backoffMs, 
        `anchor_page_${page}`
      );
      
      // Handle response structure from /pools/search endpoint
      // Response can be: { data: [...], page: number, total_count: number }
      // or just an array for backwards compatibility
      let pools: any[] = [];
      if (Array.isArray(poolsData)) {
        pools = poolsData;
      } else if (poolsData?.data) {
        // If data is an array, use it; if it's a single object, wrap it
        pools = Array.isArray(poolsData.data) ? poolsData.data : [poolsData.data];
      }
      
      if (pools.length === 0) {
        hasMore = false;
      } else {
        for (const pool of pools) {
          const poolAddr = pool?.pool_address || pool?.address || pool?.pubkey;
          if (poolAddr) {
            allPools.set(String(poolAddr), pool);
          }
        }
        totalFetched += pools.length;
        page++;
        
        // If we got fewer results than page size, we've reached the end
        if (pools.length < pageSize) {
          hasMore = false;
        }
      }
      
      // Small delay between requests to respect rate limits
      if (hasMore && page < maxPages) {
        await new Promise(r => setTimeout(r, 200));
      }
    }
    
    const data = Array.from(allPools.values());
    
    try {
      logger.info('meteora.balanced.v1.fetch complete (search API)', {
        count: data.length,
        pages: page,
        totalFetched,
        anchorTokensOnly,
        hideLowApr,
        minLiqBase,
        endpoint: 'pools/search',
        cat: 'meteora'
      });
    } catch {}
    
    return data;
  } else {
    // No anchor token filter, fetch all pools with pagination
    let page = 0;
    let hasMore = true;
    let totalFetched = 0;
    
    while (hasMore && page < maxPages) {
      const url = (() => {
        const sp = new URLSearchParams();
        sp.append('page', String(page));
        sp.append('size', String(pageSize));
        
        // Apply quality filters
        if (minLiqBase > 0) {
          sp.append('hide_low_tvl', String(minLiqBase));
        }
        if (hideLowApr) {
          sp.append('hide_low_apr', 'true');
        }
        
        // Filter for dynamic pool type (V1 pools)
        sp.append('pool_type', 'dynamic');
        
        // Sort by TVL descending
        sp.append('sort_key', 'tvl');
        sp.append('order_by', 'desc');
        
        return `${searchBase}?${sp.toString()}`;
      })();
      
      const poolsData = await fetchV1SearchWithRetry(url, fetchFn, retries, backoffMs, `all_page_${page}`);
      
      let pools: any[] = [];
      if (Array.isArray(poolsData)) {
        pools = poolsData;
      } else if (poolsData?.data) {
        pools = Array.isArray(poolsData.data) ? poolsData.data : [poolsData.data];
      }
      
      if (pools.length === 0) {
        hasMore = false;
      } else {
        for (const pool of pools) {
          const poolAddr = pool?.pool_address || pool?.address || pool?.pubkey;
          if (poolAddr) {
            allPools.set(String(poolAddr), pool);
          }
        }
        totalFetched += pools.length;
        page++;
        
        if (pools.length < pageSize) {
          hasMore = false;
        }
      }
      
      if (hasMore && page < maxPages) {
        await new Promise(r => setTimeout(r, 200));
      }
    }
    
    const data = Array.from(allPools.values());
    
    try {
      logger.info('meteora.balanced.v1.fetch complete (search API)', {
        count: data.length,
        pages: page,
        totalFetched,
        anchorTokensOnly: false,
        hideLowApr,
        minLiqBase,
        endpoint: 'pools/search',
        cat: 'meteora'
      });
    } catch {}
    
    return data;
  }
}

// Helper function to fetch v1 search API with retry logic
// Supports both the new /pools/search endpoint and legacy responses
async function fetchV1SearchWithRetry(
  url: string, 
  fetchFn: any, 
  retries: number, 
  backoffMs: number,
  tokenLabel: string
): Promise<any> {
  const cid = httpLogStart({ source: 'meteora_balanced_v1', url, extra: { token: tokenLabel } });
  let res: any = null;
  let ok = false;
  
  // Retry logic
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      res = await fetchFn(url, { headers: { accept: 'application/json' } });
      if (res?.status === 429) {
        httpLog429({ source: 'meteora_balanced_v1', url, cid });
        await new Promise(r => setTimeout(r, backoffMs * (attempt + 1)));
        continue;
      }
      if (!res?.ok) {
        const txt = await res?.text?.();
        httpLogNonOk({ source: 'meteora_balanced_v1', url, cid, status: res?.status || 0, bodySample: (txt || '').slice(0, 200) });
        // Log the actual error response for debugging
        try {
          logger.warn('meteora.balanced.v1.search.fetch.error', {
            token: tokenLabel,
            status: res?.status || 0,
            statusText: res?.statusText || '',
            bodySample: (txt || '').slice(0, 500),
            url: url.slice(0, 200),
            cat: 'meteora'
          });
        } catch {}
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, backoffMs * (attempt + 1)));
          continue;
        }
      }
      ok = true;
      break;
    } catch (err: any) {
      try {
        logger.warn('meteora.balanced.v1.search.fetch.exception', {
          token: tokenLabel,
          error: String(err?.message || err),
          cat: 'meteora'
        });
      } catch {}
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, backoffMs * (attempt + 1)));
        continue;
      }
    }
  }
  
  if (!ok || !res?.ok) {
    httpLogResponse({ source: 'meteora_balanced_v1', url, cid, status: res?.status || 0, ms: 0, count: 0 });
    return [];
  }
  
  const json: any = await res.json().catch(() => null);
  
  // Handle both response formats:
  // 1. New /pools/search endpoint: { data: [...] | {...}, page: number, total_count: number }
  // 2. Legacy endpoint: [...] (direct array)
  let count = 0;
  if (json?.data) {
    // New search API format - return the whole response object
    count = Array.isArray(json.data) ? json.data.length : 1;
  } else if (Array.isArray(json)) {
    // Legacy format - direct array
    count = json.length;
  }
  
  httpLogResponse({ source: 'meteora_balanced_v1', url, cid, status: res.status, ms: 0, count });
  
  // Log response details for debugging
  try {
    if (count === 0) {
      logger.warn('meteora.balanced.v1.search.fetch.empty_response', {
        token: tokenLabel,
        url: url.slice(0, 200),
        responseIsArray: Array.isArray(json),
        hasData: !!json?.data,
        responseType: typeof json,
        cat: 'meteora'
      });
    } else {
      logger.debug('meteora.balanced.v1.search.fetch.token', {
        token: tokenLabel,
        count,
        responseFormat: json?.data ? 'search_api' : 'legacy_array',
        cat: 'meteora'
      });
    }
  } catch {}
  
  // Return the full response (will be handled by caller)
  return json || [];
}

// RPC enrichment: fetch vault token balances to calculate reserves and price
export async function enrichMeteoraBalancedWithRpc(pools: any[]): Promise<{ pools: any[]; metrics: { success: number; fail: number; ms: number } }> {
  const t0 = Date.now();
  const enableEnrichment = (CONFIG as any)?.meteoraBalanced?.enableRpcEnrichment !== false;
  
  if (!enableEnrichment || !pools || pools.length === 0) {
    return { pools, metrics: { success: 0, fail: 0, ms: 0 } };
  }

  try {
    logger.info('meteora.balanced.rpc.enrichment.start', { poolCount: pools.length, cat: 'meteora' });
  } catch {}

  // Load Jupiter token map for decimals
  let jupMap: Record<string, { decimals: number }> = {};
  try {
    const { loadJupiterTokenMap } = await import('../../utils/tokens.js');
    jupMap = await loadJupiterTokenMap().catch(() => ({}));
  } catch {}

  // Collect all vault addresses and LP mints
  const vaultAddresses: string[] = [];
  const lpMintAddresses: string[] = [];
  const poolToVaults: Map<number, { vaultA: string; vaultB: string; mintA: string; mintB: string; lpMint?: string }> = new Map();
  
  for (let i = 0; i < pools.length; i++) {
    const pool = pools[i];
    const vaultA = pool?.token_a_vault;
    const vaultB = pool?.token_b_vault;
    const mintA = pool?.token_a_mint;
    const mintB = pool?.token_b_mint;
    const lpMint = pool?.lp_mint;
    
    if (vaultA && vaultB && mintA && mintB) {
      vaultAddresses.push(vaultA, vaultB);
      if (lpMint) {
        lpMintAddresses.push(lpMint);
      }
      poolToVaults.set(i, { vaultA, vaultB, mintA, mintB, lpMint });
    }
  }

  if (vaultAddresses.length === 0) {
    return { pools, metrics: { success: 0, fail: 0, ms: Date.now() - t0 } };
  }

  // Fetch vault account data via RPC
  const web3 = await import('@solana/web3.js');
  const conn = new web3.Connection(CONFIG.rpcUrl, CONFIG.system.txCommitment as any);
  const { withRpcLimit } = await import('../../utils/rpcLimiter.js');
  
  const batchSize = 100;
  const vaultData: Map<string, { amount: bigint }> = new Map();
  const lpMintData: Map<string, bigint> = new Map();
  const rugpullDetected = new Set<string>(); // Track rugpulled pools to avoid duplicate logging
  let successCount = 0;
  let failCount = 0;

  // Fetch vault balances
  for (let i = 0; i < vaultAddresses.length; i += batchSize) {
    const batch = vaultAddresses.slice(i, i + batchSize);
    const pubkeys = batch.map(addr => new PublicKey(addr));
    
    try {
      // Use RPC limiter for rate limiting (replaces simple delay)
      const weight = Math.max(1, Math.ceil(pubkeys.length / 100));
      const accounts = await withRpcLimit(
        () => conn.getMultipleAccountsInfo(pubkeys),
        weight,
        { module: 'pools', method: 'getMultipleAccountsInfo' }
      );
      
      for (let j = 0; j < accounts.length; j++) {
        const account = accounts[j];
        const address = batch[j];
        
        if (account && account.data && account.data.length >= 72) {
          try {
            // SPL Token account layout: amount is at offset 64 (8 bytes, little-endian)
            const buf = Buffer.from(account.data);
            const amount = buf.readBigUInt64LE(64);
            // Don't read decimals from vault - they can be stale/incorrect
            // We'll get correct decimals from mint metadata via Jupiter token map
            vaultData.set(address, { amount });
            successCount++;
          } catch (e) {
            failCount++;
          }
        } else {
          failCount++;
        }
      }
    } catch (e) {
      failCount += batch.length;
      try {
        logger.warn('meteora.balanced.rpc.batch.failed', { 
          error: String((e as any)?.message || e), 
          batch: i / batchSize,
          cat: 'meteora' 
        });
      } catch {}
    }
  }

  // Fetch LP mint supply data to detect rugpulls
  if (lpMintAddresses.length > 0) {
    try {
      logger.info('meteora.balanced.rpc.lp_mint_fetch.start', { 
        count: lpMintAddresses.length, 
        cat: 'meteora' 
      });
    } catch {}
    
    for (let i = 0; i < lpMintAddresses.length; i += batchSize) {
      const batch = lpMintAddresses.slice(i, i + batchSize);
      const pubkeys = batch.map(addr => new PublicKey(addr));
      
      try {
        const weight = Math.max(1, Math.ceil(pubkeys.length / 100));
        const accounts = await withRpcLimit(
          () => conn.getMultipleAccountsInfo(pubkeys),
          weight,
          { module: 'pools', method: 'getMultipleAccountsInfo' }
        );
        
        for (let j = 0; j < accounts.length; j++) {
          const account = accounts[j];
          const address = batch[j];
          
          if (account && account.data && account.data.length >= 44) {
            try {
              // SPL Token Mint layout: supply is u64 at offset 36
              const buf = Buffer.from(account.data);
              const supply = buf.readBigUInt64LE(36);
              lpMintData.set(address, supply);
            } catch {}
          }
        }
      } catch (e) {
        try {
          logger.warn('meteora.balanced.rpc.lp_mint_batch.failed', { 
            error: String((e as any)?.message || e), 
            batch: i / batchSize,
            cat: 'meteora' 
          });
        } catch {}
      }
    }
    
    try {
      logger.info('meteora.balanced.rpc.lp_mint_fetch.complete', { 
        fetched: lpMintData.size,
        total: lpMintAddresses.length,
        cat: 'meteora' 
      });
    } catch {}
  }

  // Collect missing mint addresses for batch RPC fetch
  const missingMints = new Set<string>();
  for (const [poolIdx, vaults] of poolToVaults.entries()) {
    if (!jupMap[vaults.mintA]?.decimals) missingMints.add(vaults.mintA);
    if (!jupMap[vaults.mintB]?.decimals) missingMints.add(vaults.mintB);
  }
  
  // Fetch missing mint decimals via RPC in batches
  const mintDecimals = new Map<string, number>();
  if (missingMints.size > 0) {
    try {
      logger.info('meteora.balanced.rpc.fetch_missing_decimals', {
        count: missingMints.size,
        cat: 'meteora'
      });
    } catch {}
    
    const missingMintArray = Array.from(missingMints);
    for (let i = 0; i < missingMintArray.length; i += batchSize) {
      const batch = missingMintArray.slice(i, i + batchSize);
      const pubkeys = batch.map(addr => new PublicKey(addr));
      
      try {
        const weight = Math.max(1, Math.ceil(pubkeys.length / 100));
        const accounts = await withRpcLimit(
          () => conn.getMultipleAccountsInfo(pubkeys),
          weight,
          { module: 'pools', method: 'getMultipleAccountsInfo' }
        );
        
        for (let j = 0; j < accounts.length; j++) {
          const account = accounts[j];
          const mintAddress = batch[j];
          
          if (account && account.data && account.data.length >= 45) {
            try {
              // SPL Token Mint layout: decimals is u8 at offset 44
              const decimals = account.data[44];
              mintDecimals.set(mintAddress, decimals);
            } catch {}
          }
        }
      } catch (e) {
        try {
          logger.warn('meteora.balanced.rpc.mint_batch.failed', {
            error: String((e as any)?.message || e),
            batch: i / batchSize,
            cat: 'meteora'
          });
        } catch {}
      }
    }
    
    try {
      logger.info('meteora.balanced.rpc.fetch_missing_decimals.complete', {
        fetched: mintDecimals.size,
        total: missingMints.size,
        cat: 'meteora'
      });
    } catch {}
  }
  
  // Enrich pools with reserve data
  for (const [poolIdx, vaults] of poolToVaults.entries()) {
    const pool = pools[poolIdx];
    const vaultAData = vaultData.get(vaults.vaultA);
    const vaultBData = vaultData.get(vaults.vaultB);
    
    if (vaultAData && vaultBData) {
      // CRITICAL: Store WHOLE amounts (already divided by decimals), not raw amounts
      // The normalizer expects these fields to be in whole token units
      // DO NOT set reserveA/reserveB here as they would be double-converted
      
      // Get decimals from Jupiter token map OR RPC fallback
      let jupDecA = jupMap[vaults.mintA]?.decimals;
      let jupDecB = jupMap[vaults.mintB]?.decimals;
      
      // Fallback to RPC-fetched decimals if Jupiter doesn't have them
      if (!Number.isFinite(jupDecA)) {
        jupDecA = mintDecimals.get(vaults.mintA);
      }
      if (!Number.isFinite(jupDecB)) {
        jupDecB = mintDecimals.get(vaults.mintB);
      }
      
      // CRITICAL: Set decimals from Jupiter or RPC fallback
      if (Number.isFinite(jupDecA)) {
        pool.decimalsA = jupDecA;
      } else {
        // Log warning if we still don't have decimals after RPC fallback
        try {
          logger.warn('meteora.balanced.rpc.missing_decimals_a', {
            pool: pool.pool_address || pool.id,
            mintA: vaults.mintA,
            cat: 'meteora'
          });
        } catch {}
      }
      
      if (Number.isFinite(jupDecB)) {
        pool.decimalsB = jupDecB;
      } else {
        // Log warning if we still don't have decimals after RPC fallback
        try {
          logger.warn('meteora.balanced.rpc.missing_decimals_b', {
            pool: pool.pool_address || pool.id,
            mintB: vaults.mintB,
            cat: 'meteora'
          });
        } catch {}
      }
      
      // Calculate whole amounts and pool_liquidity_raw
      const decA = pool.decimalsA;
      const decB = pool.decimalsB;
      if (Number.isFinite(decA) && Number.isFinite(decB)) {
        const wholeA = Number(vaultAData.amount) / Math.pow(10, decA);
        const wholeB = Number(vaultBData.amount) / Math.pow(10, decB);
        
        // Store CONVERTED amounts that normalizer can use directly
        // Normalizer will look for vault_a_whole / vault_b_whole
        pool.vault_a_whole = wholeA;
        pool.vault_b_whole = wholeB;
        
        // Also store raw reserves as strings for precise calculations
        pool.reserve_a_raw = vaultAData.amount.toString();
        pool.reserve_b_raw = vaultBData.amount.toString();
        
        // Get LP supply for rugpull detection
        const lpMint = vaults.lpMint;
        const lpSupply = lpMint ? lpMintData.get(lpMint) : undefined;
        const minVault = Math.min(wholeA, wholeB);
        
        // RUGPULL/IMBALANCE DETECTION: Check if LP supply is zero or vaults are extremely imbalanced
        const isRugpulled = (() => {
          if (!lpSupply || lpSupply === 0n) {
            // No LP tokens in circulation = rugpulled or empty pool
            return minVault > 1; // Only flag as rugpull if vaults have significant tokens
          }
          
          // Check if LP supply is very low compared to vault balances
          const lpSupplyNum = Number(lpSupply);
          const minVaultRaw = Math.min(Number(vaultAData.amount), Number(vaultBData.amount));
          
          // If vaults have significant value but LP supply is dust (< 1000 units)
          // Normal pools have meaningful LP supply relative to reserves
          if (minVaultRaw > 1_000_000_000 && lpSupplyNum < 1000) {
            return true;
          }
          
          // CRITICAL: Check for extreme vault imbalance (e.g., 1M tokens vs 0.001 SOL)
          // This indicates a drained/rugpulled pool even if LP supply exists
          if (wholeA > 0 && wholeB > 0) {
            const ratio = wholeA > wholeB ? wholeA / wholeB : wholeB / wholeA;
            // If ratio > 100,000, one vault is essentially empty
            if (ratio > 100_000) {
              return true;
            }
          }
          
          return false;
        })();
        
        if (isRugpulled) {
          // Mark pool as rugpulled - set liquidity to near-zero to exclude from routing
          pool.pool_liquidity_raw = 0.001;
          pool.is_rugpulled = true;
          pool.lp_supply = lpSupply ? lpSupply.toString() : '0';
          
          const poolId = pool.pool_address || pool.id;
          if (poolId && !rugpullDetected.has(poolId)) {
            rugpullDetected.add(poolId);
            const ratio = wholeA > 0 && wholeB > 0 
              ? (wholeA > wholeB ? wholeA / wholeB : wholeB / wholeA).toFixed(2)
              : 'N/A';
            try {
              logger.warn('meteora.balanced.rpc.rugpull_detected', {
                pool: poolId,
                vaultA: wholeA.toFixed(6),
                vaultB: wholeB.toFixed(6),
                ratio,
                lpSupply: lpSupply ? lpSupply.toString() : 'null',
                mintA: vaults.mintA,
                mintB: vaults.mintB,
                cat: 'meteora'
              });
            } catch {}
          }
        } else {
          // Pool appears healthy - use API TVL if available, otherwise calculate from vaults
          // Store LP supply for reference
          if (lpSupply) {
            pool.lp_supply = lpSupply.toString();
          }
          
          // Only set pool_liquidity_raw from vaults if API didn't provide it
          if (!pool.pool_liquidity_raw && minVault > 10) {
            pool.pool_liquidity_raw = minVault;
            try {
              logger.debug('meteora.balanced.rpc.liquidity_from_vaults', {
                pool: pool.pool_address || pool.id,
                minVault: minVault.toFixed(6),
                lpSupply: lpSupply ? lpSupply.toString() : 'null',
                cat: 'meteora'
              });
            } catch {}
          }
        }
      }
    }
  }

  const ms = Date.now() - t0;
  try {
    logger.info('meteora.balanced.rpc.enrichment.complete', { 
      total: vaultAddresses.length, 
      success: successCount, 
      fail: failCount,
      rugpulls: rugpullDetected.size,
      ms,
      cat: 'meteora' 
    });
  } catch {}

  return { pools, metrics: { success: successCount, fail: failCount, ms } };
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
  
  // API-level quality filters
  const hideLowTvl = cfg.hideLowTvl === true;
  const hideLowApr = cfg.hideLowApr === true;
  const tokensVerified = cfg.tokensVerified === true;
  
  // eslint-disable-next-line no-undef
  const fetchFn: any = (globalThis as any).fetch || fetch;
  const out: any[] = [];
  let page = 0;
  for (let i = 0; i < (maxPages && maxPages > 0 ? maxPages : Number.POSITIVE_INFINITY); i++) {
    const url = (() => {
      const sp = new URLSearchParams();
      if (Number.isFinite(size) && size > 0) sp.append('limit', String(size));
      sp.append('page', String(page));
      // Add quality filters to API request
      if (hideLowTvl) sp.append('hide_low_tvl', 'true');
      if (hideLowApr) sp.append('hide_low_apr', 'true');
      if (tokensVerified) sp.append('tokens_verified', 'true');
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
    const hasMore = (() => {
      if (json?.next || json?.hasNextPage) return true;
      const pages = Number(json?.pages || 0);
      const curr = Number(json?.current_page || (page + 1));
      if (pages > 0 && curr < pages) return true;
      return Array.isArray(data) && Number.isFinite(size) && size > 0 && data.length >= size;
    })();
    if (!hasMore) break;
    page += 1;
    // Respect 10 RPS: space requests ~100ms apart
    await new Promise(r => setTimeout(r, 110));
  }
  
  try {
    logger.info('meteora.balanced.v2.fetch complete', {
      count: out.length,
      hideLowTvl,
      hideLowApr,
      tokensVerified,
      cat: 'meteora'
    });
  } catch {}
  
  return out;
}

export async function fetchMeteoraBalancedAll(): Promise<PoolsPayload> {
  const cfg: any = (CONFIG as any)?.meteoraBalanced || {};
  
  // Fetch v2 with explicit v2 URL
  const v2Url = cfg.apiUrlV2 || 'https://dammv2-api.meteora.ag/pools';
  const v2 = await fetchMeteoraBalancedV2Http(v2Url);
  
  // Fetch v1 with explicit v1 URL
  // CRITICAL: Pass explicit URL to ensure v1 fetcher uses correct endpoint
  const v1Url = cfg.apiUrl || 'https://damm-api.meteora.ag/pools';
  const v1 = await fetchMeteoraBalancedV1Http(v1Url);
  
  // Log fetch results for debugging
  try {
    logger.info('meteora.balanced.all.fetch', {
      v1Count: v1.length,
      v2Count: v2.length,
      v1Url,
      v2Url,
      cat: 'meteora'
    });
  } catch {}
  
  // Enrich v2 pools with RPC data (vault balances)
  const enrichResult = await enrichMeteoraBalancedWithRpc(v2);
  const enrichedV2 = enrichResult.pools;
  
  const normV2 = await normalizeMeteoraBalancedHttp(enrichedV2);
  const normV1 = await normalizeMeteoraBalancedV1(v1);
  
  // IMPORTANT: Do NOT merge - v1 and v2 are different pool types (different programs)
  // Keep them separate since they have distinct DEX labels and require different swap logic
  const combinedAmm = [...normV2.amm, ...normV1.amm];
  const ammCanon = canonicalizePools(combinedAmm);
  
  try {
    logger.info('meteora.balanced.all.normalized', {
      v1NormCount: normV1.amm.length,
      v2NormCount: normV2.amm.length,
      combinedCount: ammCanon.length,
      cat: 'meteora'
    });
  } catch {}
  
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


