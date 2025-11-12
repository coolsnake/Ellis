import { logger } from '../../utils/logger.js';
import { emit } from '../realtime.js';
import { CONFIG } from '../../utils/config.js';
import { writeJson, joinPath } from '../../utils/fs.js';
import type { AmmPool, PoolsPayload } from './types.js';
import { canonicalizePairs, validateHttpUrl } from './common.js';
import { httpLogStart, httpLogResponse, httpLog429, httpLogNonOk } from './httpLog.js';
import { PublicKey } from '@solana/web3.js';

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
    return n <= 1 ? Math.round(n * 100) : Math.round(n);
  };

  for (const it of arr) {
    try {
      const id = String(it?.pool_address || it?.address || it?.id || '');
      const a = it?.tokenA || it?.mintA || it?.base || {};
      const b = it?.tokenB || it?.mintB || it?.quote || {};
      const mint_a = String(it?.token_a_mint || toMint(a) || toMint(a?.info) || it?.mintA || '');
      const mint_b = String(it?.token_b_mint || toMint(b) || toMint(b?.info) || it?.mintB || '');
      if (!id || !mint_a || !mint_b) continue;

      const decA = toDec(a?.decimals ?? it?.decimalsA);
      const decB = toDec(b?.decimals ?? it?.decimalsB);
      const amtAraw = Number(it?.reserveA ?? it?.amountA ?? it?.tokenAmountA ?? 0);
      const amtBraw = Number(it?.reserveB ?? it?.amountB ?? it?.tokenAmountB ?? 0);
      
      // Log first pool's raw data structure for debugging
      if (arr.indexOf(it) === 0) {
        try {
          logger.info('meteora.balanced.api_sample', {
            hasTokenA: !!it?.tokenA,
            hasTokenB: !!it?.tokenB,
            hasMintA: !!it?.mintA,
            hasMintB: !!it?.mintB,
            hasReserveA: it?.reserveA !== undefined,
            hasReserveB: it?.reserveB !== undefined,
            hasAmountA: it?.amountA !== undefined,
            hasAmountB: it?.amountB !== undefined,
            hasTokenADecimals: !!a?.decimals,
            hasTokenBDecimals: !!b?.decimals,
            hasDecimalsA: it?.decimalsA !== undefined,
            hasDecimalsB: it?.decimalsB !== undefined,
            hasTvl: it?.tvl !== undefined,
            hasPrice: it?.price !== undefined,
            apiKeys: Object.keys(it).slice(0, 15),
            tokenAKeys: Object.keys(a).slice(0, 10),
            tokenBKeys: Object.keys(b).slice(0, 10),
            cat: 'meteora'
          });
        } catch {}
      }
      
      // Parse TVL and apply scaling if needed (API may return in milli-USD)
      const tvlRaw = Number(it?.tvl ?? it?.tvlUsd ?? it?.tvl_usd ?? 0);
      const wholeA = (Number.isFinite(amtAraw) && Number.isFinite(decA)) ? (amtAraw / Math.pow(10, decA as number)) : NaN;
      const wholeB = (Number.isFinite(amtBraw) && Number.isFinite(decB)) ? (amtBraw / Math.pow(10, decB as number)) : NaN;
      
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
            hasAmtAraw: Number.isFinite(amtAraw),
            hasAmtBraw: Number.isFinite(amtBraw),
            hasDecA: Number.isFinite(decA),
            hasDecB: Number.isFinite(decB),
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

      amm.push({
        id,
        dex: 'MeteoraBalanced',
        mint_a,
        mint_b,
        fee_bps,
        price_a_per_b: (price_a_per_b > 0) ? price_a_per_b : undefined,
        liquidity_base,
        updated_ms: now,
        pool_kind: 'amm',
        amount_a_whole: Number.isFinite(wholeA) ? wholeA as number : undefined,
        amount_b_whole: Number.isFinite(wholeB) ? wholeB as number : undefined,
        amounts_are_whole: Number.isFinite(wholeA) || Number.isFinite(wholeB) ? true : undefined,
        decimals_a: Number.isFinite(decA as any) ? (decA as number) : undefined,
        decimals_b: Number.isFinite(decB as any) ? (decB as number) : undefined,
        tvl_usd: tvl_usd != null && tvl_usd > 0 ? tvl_usd : undefined,
        pool_liquidity_raw,
        liquidity_display: tvl_usd != null && tvl_usd > 0 ? tvl_usd : (liquidity_base > 0 ? liquidity_base : undefined),
      });
    } catch {}
  }

  const ammCanon = canonicalizePairs(amm);
  
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
          logger.info('meteora.balanced.filter.min_liq', {
            before: beforeFilter,
            after: filtered.length,
            minLiqBase,
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
      const wholeA = toNum(amounts?.[0]);
      const wholeB = toNum(amounts?.[1]);
      const usdA = toNum(usdAmounts?.[0]);
      const usdB = toNum(usdAmounts?.[1]);
      let price_a_per_b = 0;
      if (wholeB > 0 && wholeA > 0) price_a_per_b = wholeA / wholeB;
      else if (usdA > 0 && usdB > 0) price_a_per_b = usdA / usdB;
      
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
      
      const liquidity_base = (wholeA > 0 && wholeB > 0) ? Math.min(wholeA, wholeB) : 0;
      
      // Calculate pool_liquidity_raw
      const pool_liquidity_raw = (() => {
        if (tvl_usd > 0) return tvl_usd;
        if (liquidity_base > 0) return liquidity_base;
        return undefined;
      })();
      
      amm.push({
        id,
        dex: 'MeteoraBalanced',
        mint_a,
        mint_b,
        fee_bps,
        price_a_per_b: (price_a_per_b > 0) ? price_a_per_b : undefined,
        liquidity_base,
        updated_ms: now,
        pool_kind: 'amm',
        amount_a_whole: wholeA > 0 ? wholeA : undefined,
        amount_b_whole: wholeB > 0 ? wholeB : undefined,
        tvl_usd: tvl_usd > 0 ? tvl_usd : undefined,
        pool_liquidity_raw,
        liquidity_display: (tvl_usd > 0) ? tvl_usd : (liquidity_base > 0 ? liquidity_base : undefined),
      } as any);
    } catch {}
  }
  const ammCanon = canonicalizePairs(amm);
  
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
  const maxPages = Number(cfg.maxPages || 3);
  const size = Number(cfg.pageSize || 200);
  // eslint-disable-next-line no-undef
  const fetchFn: any = (globalThis as any).fetch || fetch;
  const out: any[] = [];
  const hideLow = (() => {
    try {
      const raw = (CONFIG as any)?.meteoraBalanced?.hideLowTvl;
      if (raw == null) return undefined;
      const n = Number(raw);
      return Number.isFinite(n) && n > 0 ? n : undefined;
    } catch { return undefined; }
  })();
  const anchors: string[] = [
    'So11111111111111111111111111111111111111112', // SOL
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  ];
  for (const addr of anchors) {
    let page = 0;
    for (let i = 0; i < (maxPages && maxPages > 0 ? maxPages : Number.POSITIVE_INFINITY); i++) {
      const url = (() => {
        const sp = new URLSearchParams();
        sp.append('address', addr);
        if (Number.isFinite(size) && size > 0) sp.append('limit', String(size));
        sp.append('page', String(page));
        if (hideLow != null) sp.append('hide_low_tvl', String(hideLow));
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
      const hasMore = (() => {
        if (json?.next || json?.hasNextPage) return true;
        const pages = Number(json?.pages || 0);
        const curr = Number(json?.current_page || (page + 1));
        return pages > 0 && curr < pages;
      })();
      if (!hasMore) break;
      page += 1;
      await new Promise(r => setTimeout(r, 110));
    }
  }
  // Deduplicate by pool address/id
  const seen = new Set<string>();
  const dedup: any[] = [];
  for (const it of out) {
    const id = String(it?.pool_address || it?.address || it?.id || '');
    if (id && !seen.has(id)) { seen.add(id); dedup.push(it); }
  }
  return dedup;
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

  // Collect all vault addresses
  const vaultAddresses: string[] = [];
  const poolToVaults: Map<number, { vaultA: string; vaultB: string; mintA: string; mintB: string }> = new Map();
  
  for (let i = 0; i < pools.length; i++) {
    const pool = pools[i];
    const vaultA = pool?.token_a_vault;
    const vaultB = pool?.token_b_vault;
    const mintA = pool?.token_a_mint;
    const mintB = pool?.token_b_mint;
    
    if (vaultA && vaultB && mintA && mintB) {
      vaultAddresses.push(vaultA, vaultB);
      poolToVaults.set(i, { vaultA, vaultB, mintA, mintB });
    }
  }

  if (vaultAddresses.length === 0) {
    return { pools, metrics: { success: 0, fail: 0, ms: Date.now() - t0 } };
  }

  // Fetch vault account data via RPC
  const web3 = await import('@solana/web3.js');
  const conn = new web3.Connection(CONFIG.rpcUrl, CONFIG.system.txCommitment as any);
  
  const batchSize = 100;
  const vaultData: Map<string, { amount: bigint; decimals: number }> = new Map();
  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < vaultAddresses.length; i += batchSize) {
    const batch = vaultAddresses.slice(i, i + batchSize);
    const pubkeys = batch.map(addr => new PublicKey(addr));
    
    try {
      // Simple delay for rate limiting
      await new Promise(r => setTimeout(r, 50));
      const accounts = await conn.getMultipleAccountsInfo(pubkeys);
      
      for (let j = 0; j < accounts.length; j++) {
        const account = accounts[j];
        const address = batch[j];
        
        if (account && account.data && account.data.length >= 72) {
          try {
            // SPL Token account layout: amount is at offset 64 (8 bytes, little-endian)
            const buf = Buffer.from(account.data);
            const amount = buf.readBigUInt64LE(64);
            // Decimals is at offset 44 (1 byte)
            const decimals = buf.readUInt8(44);
            vaultData.set(address, { amount, decimals });
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

  // Enrich pools with reserve data
  for (const [poolIdx, vaults] of poolToVaults.entries()) {
    const pool = pools[poolIdx];
    const vaultAData = vaultData.get(vaults.vaultA);
    const vaultBData = vaultData.get(vaults.vaultB);
    
    if (vaultAData && vaultBData) {
      pool.reserveA = Number(vaultAData.amount);
      pool.reserveB = Number(vaultBData.amount);
      pool.decimalsA = vaultAData.decimals;
      pool.decimalsB = vaultBData.decimals;
      
      // Also try to get decimals from Jupiter if vault decimals seem wrong
      const jupDecA = jupMap[vaults.mintA]?.decimals;
      const jupDecB = jupMap[vaults.mintB]?.decimals;
      if (Number.isFinite(jupDecA)) pool.decimalsA = jupDecA;
      if (Number.isFinite(jupDecB)) pool.decimalsB = jupDecB;
      
      // Calculate whole amounts and pool_liquidity_raw
      const decA = pool.decimalsA;
      const decB = pool.decimalsB;
      if (Number.isFinite(decA) && Number.isFinite(decB)) {
        const wholeA = Number(vaultAData.amount) / Math.pow(10, decA);
        const wholeB = Number(vaultBData.amount) / Math.pow(10, decB);
        
        // Store raw reserves as strings for precise calculations
        pool.reserve_a_raw = vaultAData.amount.toString();
        pool.reserve_b_raw = vaultBData.amount.toString();
        
        // IMPORTANT: Do NOT override pool_liquidity_raw from API data
        // Vaults can have tokens even when pool liquidity is zero (rugpulled pools)
        // Only set pool_liquidity_raw if it's not already set from API
        if (!pool.pool_liquidity_raw && Number.isFinite(wholeA) && Number.isFinite(wholeB)) {
          const minVault = Math.min(wholeA, wholeB);
          // Only use vault-based liquidity if it's significant (> $10 equivalent)
          // This helps filter out dust/rugpulled pools
          if (minVault > 10) {
            pool.pool_liquidity_raw = minVault;
            try {
              logger.debug('meteora.balanced.rpc.liquidity_from_vaults', {
                pool: pool.pool_address || pool.id,
                minVault,
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
  return out;
}

export async function fetchMeteoraBalancedAll(): Promise<PoolsPayload> {
  const v2 = await fetchMeteoraBalancedV2Http();
  const v1 = await fetchMeteoraBalancedV1Http();
  
  // Enrich v2 pools with RPC data (vault balances)
  const enrichResult = await enrichMeteoraBalancedWithRpc(v2);
  const enrichedV2 = enrichResult.pools;
  
  const normV2 = await normalizeMeteoraBalancedHttp(enrichedV2);
  const normV1 = await normalizeMeteoraBalancedV1(v1);
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


