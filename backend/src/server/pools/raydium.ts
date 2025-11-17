import { logger } from '../../utils/logger.js';
import { emit } from '../realtime.js';
import { CONFIG } from '../../utils/config.js';
import { readJson, writeJson, joinPath } from '../../utils/fs.js';
import type { AmmPool, ClmmPool, PoolsPayload } from './types.js';
import { validateHttpUrl, swapABFields } from './common.js';
import { canonicalizePools } from './canonical.js';
import { resolveManyDecimals } from './decimals.js';
import { anyToBigInt, ratioToDecimalString, sqrtPriceX64ToPriceRatio } from './precision.js';
import { verifyCanonicalization } from './validation.js';

let rayProbeOffset = 0;

const ATOMIC_AMOUNT_REGEX = /^[-+]?\d+$/;

function looksLikeAtomicAmount(value: any): boolean {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return false;
    if (trimmed.includes('.') || trimmed.includes('e') || trimmed.includes('E')) return false;
    return ATOMIC_AMOUNT_REGEX.test(trimmed);
  }
  return false;
}

function normalizeAmount(raw: any, decimals?: number): number | undefined {
  if (raw == null) return undefined;
  const num = Number(raw);
  if (!Number.isFinite(num)) return undefined;
  if (looksLikeAtomicAmount(raw) && Number.isFinite(decimals)) {
    return num / Math.pow(10, decimals as number);
  }
  return num;
}

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
    const concurrency = Math.max(1, Math.min(8, Number(((CONFIG as any)?.raydium?.concurrency) || (CONFIG as any)?.raydium?.sdkConcurrency || 8)));
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

/**
 * Fetches and decodes Raydium AMM pool state from chain to extract Serum market accounts
 * Uses RPC limiter to avoid rate limiting
 */
async function fetchRaydiumAmmPoolAccounts(poolId: string): Promise<{
  marketId?: string;
  marketProgramId?: string;
  ammAuthority?: string;
  ammOpenOrders?: string;
  ammTargetOrders?: string;
  lpMint?: string;
  baseVault?: string;
  quoteVault?: string;
} | null> {
  try {
    const { Connection, PublicKey } = await import('@solana/web3.js');
    const { withRpcLimit } = await import('../../utils/rpcLimiter.js');
    const connection = new Connection(CONFIG.rpcUrl);
    
    const poolPk = new PublicKey(poolId);
    const accountInfo = await withRpcLimit(
      () => connection.getAccountInfo(poolPk),
      1,
      { module: 'pools', method: 'getAccountInfo' }
    );
    
    if (!accountInfo?.data || accountInfo.data.length < 324) {
      return null;
    }
    
    // Decode Raydium AMM V4 layout
    // Reference: https://github.com/raydium-io/raydium-sdk-V2/blob/master/src/liquidity/layout.ts
    const rmod: any = await import('@raydium-io/raydium-sdk-v2');
    const layouts = [
      (rmod as any)?.LiquidityStateLayoutV4,
      (rmod as any)?.liquidityStateV4Layout,
    ].filter(Boolean);
    
    for (const layout of layouts) {
      try {
        const state = layout.decode(accountInfo.data);
        
        // Extract all required accounts
        const toBase58 = (v: any) => {
          if (!v) return undefined;
          if (typeof v.toBase58 === 'function') return v.toBase58();
          if (typeof v === 'string') return v;
          return undefined;
        };
        
        return {
          marketId: toBase58(state.marketId || state.market_id),
          marketProgramId: toBase58(state.marketProgramId || state.market_program_id),
          ammAuthority: toBase58(state.ammAuthority || state.authority || state.owner),
          ammOpenOrders: toBase58(state.ammOpenOrders || state.openOrders || state.open_orders),
          ammTargetOrders: toBase58(state.ammTargetOrders || state.targetOrders || state.target_orders),
          lpMint: toBase58(state.lpMint || state.lp_mint),
          baseVault: toBase58(state.baseVault || state.coinVault || state.base_vault),
          quoteVault: toBase58(state.quoteVault || state.pcVault || state.quote_vault),
        };
      } catch (decodeErr) {
        // Try next layout
        continue;
      }
    }
    
    return null;
  } catch (err) {
    try {
      logger.debug('raydium.amm.pool_accounts.fetch.err', {
        cat: 'pools',
        ctx: { poolId: poolId.slice(0, 8) + '...', error: String((err as any)?.message || err) }
      });
    } catch {}
    return null;
  }
}

/**
 * Fetches and decodes Serum market account to extract market sub-accounts
 * Uses RPC limiter to avoid rate limiting
 */
async function fetchSerumMarketAccounts(marketId: string, marketProgramId: string): Promise<{
  bids?: string;
  asks?: string;
  eventQueue?: string;
  baseVault?: string;
  quoteVault?: string;
  vaultSignerNonce?: number;
  authority?: string;
} | null> {
  try {
    const { Connection, PublicKey } = await import('@solana/web3.js');
    const { withRpcLimit } = await import('../../utils/rpcLimiter.js');
    const connection = new Connection(CONFIG.rpcUrl);
    
    const marketPk = new PublicKey(marketId);
    const accountInfo = await withRpcLimit(
      () => connection.getAccountInfo(marketPk),
      1,
      { module: 'pools', method: 'getAccountInfo' }
    );
    
    if (!accountInfo?.data || accountInfo.data.length < 388) {
      return null;
    }
    
    // Decode Serum/OpenBook market layout
    // Market state is at specific offsets in the account data
    // Reference: https://github.com/project-serum/serum-dex/blob/master/dex/src/state.rs
    const data = accountInfo.data;
    
    const readPubkey = (offset: number): string => {
      const bytes = data.slice(offset, offset + 32);
      return new PublicKey(bytes).toBase58();
    };
    
    const readU64 = (offset: number): number => {
      const bytes = data.slice(offset, offset + 8);
      // Use DataView for cross-platform compatibility
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return Number(view.getBigUint64(0, true)); // true = little endian
    };
    
    // Serum Market Layout offsets
    // bids: offset 101, asks: offset 133, eventQueue: offset 165
    // baseVault: offset 197, quoteVault: offset 229
    // vaultSignerNonce: offset 357 (u64)
    
    try {
      const bids = readPubkey(101);
      const asks = readPubkey(133);
      const eventQueue = readPubkey(165);
      const baseVault = readPubkey(197);
      const quoteVault = readPubkey(229);
      const vaultSignerNonce = readU64(357);
      
      // Derive vault signer (authority) from nonce
      let authority: string | undefined;
      try {
        const [vaultSigner] = await PublicKey.findProgramAddress(
          [marketPk.toBuffer(), Buffer.from([Number(vaultSignerNonce)])],
          new PublicKey(marketProgramId)
        );
        authority = vaultSigner.toBase58();
      } catch {}
      
      return {
        bids,
        asks,
        eventQueue,
        baseVault,
        quoteVault,
        vaultSignerNonce,
        authority,
      };
    } catch (decodeErr) {
      try {
        logger.debug('serum.market.decode.err', {
          cat: 'pools',
          ctx: { marketId: marketId.slice(0, 8) + '...', error: String((decodeErr as any)?.message || decodeErr) }
        });
      } catch {}
      return null;
    }
  } catch (err) {
    try {
      logger.debug('serum.market.fetch.err', {
        cat: 'pools',
        ctx: { marketId: marketId.slice(0, 8) + '...', error: String((err as any)?.message || err) }
      });
    } catch {}
    return null;
  }
}

/**
 * Batch fetches and decodes multiple Raydium AMM pool accounts at once
 * More efficient than individual fetches - reduces RPC calls by ~100x
 */
async function batchFetchRaydiumPoolAccounts(
  poolIds: string[]
): Promise<Map<string, {
  marketId?: string;
  marketProgramId?: string;
  ammAuthority?: string;
  ammOpenOrders?: string;
  ammTargetOrders?: string;
  lpMint?: string;
  baseVault?: string;
  quoteVault?: string;
}>> {
  const { Connection, PublicKey } = await import('@solana/web3.js');
  const { withRpcLimit } = await import('../../utils/rpcLimiter.js');
  const connection = new Connection(CONFIG.rpcUrl);
  const results = new Map();
  
  const BATCH_SIZE = 100; // Same as Orca/Meteora pattern
  
  try {
    logger.info('raydium.amm.pool_accounts.batch.start', { 
      count: poolIds.length, 
      batchSize: BATCH_SIZE,
      cat: 'pools' 
    });
  } catch {}
  
  // Load decoder layouts once
  const rmod: any = await import('@raydium-io/raydium-sdk-v2');
  const layouts = [
    (rmod as any)?.LiquidityStateLayoutV4,
    (rmod as any)?.liquidityStateV4Layout,
  ].filter(Boolean);
  
  const toBase58 = (v: any) => {
    if (!v) return undefined;
    if (typeof v.toBase58 === 'function') return v.toBase58();
    if (typeof v === 'string') return v;
    return undefined;
  };
  
  for (let i = 0; i < poolIds.length; i += BATCH_SIZE) {
    const batch = poolIds.slice(i, i + BATCH_SIZE);
    const pubkeys = batch.map(id => new PublicKey(id));
    
    try {
      // Batch fetch pool accounts
      const weight = Math.max(1, Math.ceil(batch.length / 100));
      const accountInfos = await withRpcLimit(
        () => connection.getMultipleAccountsInfo(pubkeys),
        weight,
        { module: 'pools', method: 'getMultipleAccountsInfo' }
      );
      
      // Decode each account
      for (let j = 0; j < accountInfos.length; j++) {
        const accountInfo = accountInfos[j];
        const poolId = batch[j];
        
        if (!accountInfo?.data || accountInfo.data.length < 324) continue;
        
        // Try to decode with each layout
        for (const layout of layouts) {
          try {
            const state = layout.decode(accountInfo.data);
            
            results.set(poolId, {
              marketId: toBase58(state.marketId || state.market_id),
              marketProgramId: toBase58(state.marketProgramId || state.market_program_id),
              ammAuthority: toBase58(state.ammAuthority || state.authority || state.owner),
              ammOpenOrders: toBase58(state.ammOpenOrders || state.openOrders || state.open_orders),
              ammTargetOrders: toBase58(state.ammTargetOrders || state.targetOrders || state.target_orders),
              lpMint: toBase58(state.lpMint || state.lp_mint),
              baseVault: toBase58(state.baseVault || state.coinVault || state.base_vault),
              quoteVault: toBase58(state.quoteVault || state.pcVault || state.quote_vault),
            });
            break; // Successfully decoded
          } catch {
            continue; // Try next layout
          }
        }
      }
      
      try {
        logger.debug('raydium.amm.pool_accounts.batch.progress', {
          cat: 'pools',
          ctx: {
            processed: Math.min(i + BATCH_SIZE, poolIds.length),
            total: poolIds.length,
            decoded: results.size,
          }
        });
      } catch {}
      
      // Small delay between batches
      if (i + BATCH_SIZE < poolIds.length) {
        await new Promise(r => setTimeout(r, 50));
      }
    } catch (err) {
      try {
        logger.warn('raydium.amm.pool_accounts.batch.failed', {
          cat: 'pools',
          ctx: { 
            batchStart: i, 
            batchSize: batch.length,
            error: String((err as any)?.message || err) 
          }
        });
      } catch {}
    }
  }
  
  try {
    logger.info('raydium.amm.pool_accounts.batch.complete', { 
      total: poolIds.length,
      decoded: results.size,
      cat: 'pools' 
    });
  } catch {}
  
  return results;
}

/**
 * Batch fetches and decodes multiple Serum market accounts at once
 * More efficient than individual fetches - reduces RPC calls by ~100x
 */
async function batchFetchSerumMarketAccounts(
  marketIds: string[],
  marketProgramIds: Map<string, string>
): Promise<Map<string, {
  bids?: string;
  asks?: string;
  eventQueue?: string;
  baseVault?: string;
  quoteVault?: string;
  vaultSignerNonce?: number;
  authority?: string;
}>> {
  const { Connection, PublicKey } = await import('@solana/web3.js');
  const { withRpcLimit } = await import('../../utils/rpcLimiter.js');
  const connection = new Connection(CONFIG.rpcUrl);
  const results = new Map();
  
  const BATCH_SIZE = 100;
  
  try {
    logger.info('raydium.amm.market_accounts.batch.start', { 
      count: marketIds.length,
      batchSize: BATCH_SIZE,
      cat: 'pools' 
    });
  } catch {}
  
  for (let i = 0; i < marketIds.length; i += BATCH_SIZE) {
    const batch = marketIds.slice(i, i + BATCH_SIZE);
    const pubkeys = batch.map(id => new PublicKey(id));
    
    try {
      // Batch fetch market accounts
      const weight = Math.max(1, Math.ceil(batch.length / 100));
      const accountInfos = await withRpcLimit(
        () => connection.getMultipleAccountsInfo(pubkeys),
        weight,
        { module: 'pools', method: 'getMultipleAccountsInfo' }
      );
      
      // Decode each market account
      for (let j = 0; j < accountInfos.length; j++) {
        const accountInfo = accountInfos[j];
        const marketId = batch[j];
        
        if (!accountInfo?.data || accountInfo.data.length < 388) continue;
        
        const data = accountInfo.data;
        
        const readPubkey = (offset: number): string => {
          const bytes = data.slice(offset, offset + 32);
          return new PublicKey(bytes).toBase58();
        };
        
        const readU64 = (offset: number): number => {
          const bytes = data.slice(offset, offset + 8);
          const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
          return Number(view.getBigUint64(0, true));
        };
        
        try {
          const vaultSignerNonce = readU64(357);
          
          // Derive vault signer (authority) from nonce
          let authority: string | undefined;
          const marketProgramId = marketProgramIds.get(marketId);
          if (marketProgramId) {
            try {
              const [vaultSigner] = await PublicKey.findProgramAddress(
                [new PublicKey(marketId).toBuffer(), Buffer.from([Number(vaultSignerNonce)])],
                new PublicKey(marketProgramId)
              );
              authority = vaultSigner.toBase58();
            } catch {}
          }
          
          results.set(marketId, {
            bids: readPubkey(101),
            asks: readPubkey(133),
            eventQueue: readPubkey(165),
            baseVault: readPubkey(197),
            quoteVault: readPubkey(229),
            vaultSignerNonce,
            authority,
          });
        } catch (err) {
          try {
            logger.debug('raydium.amm.market_account.decode.failed', {
              cat: 'pools',
              ctx: { marketId, error: String((err as any)?.message || err) }
            });
          } catch {}
        }
      }
      
      try {
        logger.debug('raydium.amm.market_accounts.batch.progress', {
          cat: 'pools',
          ctx: {
            processed: Math.min(i + BATCH_SIZE, marketIds.length),
            total: marketIds.length,
            decoded: results.size,
          }
        });
      } catch {}
      
      // Small delay between batches
      if (i + BATCH_SIZE < marketIds.length) {
        await new Promise(r => setTimeout(r, 50));
      }
    } catch (err) {
      try {
        logger.warn('raydium.amm.market_accounts.batch.failed', {
          cat: 'pools',
          ctx: { 
            batchStart: i, 
            batchSize: batch.length,
            error: String((err as any)?.message || err) 
          }
        });
      } catch {}
    }
  }
  
  try {
    logger.info('raydium.amm.market_accounts.batch.complete', { 
      total: marketIds.length,
      decoded: results.size,
      cat: 'pools' 
    });
  } catch {}
  
  return results;
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

  const allMints = new Set<string>();
  for (const it of arr) {
    if (!it) continue;
    const mintA = toMint(it?.mintA);
    const mintB = toMint(it?.mintB);
    if (mintA) allMints.add(mintA);
    if (mintB) allMints.add(mintB);
  }
  
  const decimalsMap = await resolveManyDecimals(Array.from(allMints), { 
    logger, 
    normalizeMode: true
  });
  
  const toFeeBps = (v: any): number => {
    const n = Number(v);
    if (!Number.isFinite(n)) return 30;
    return n <= 1 ? Math.round(n * 10_000) : Math.round(n);
  };
  
  const { processPriceThroughPipeline } = await import('./pricePipeline.js');

  for (const it of arr) {
    if (!it) continue;
    const id = String(it?.id || it?.address || it?.pool_id || it?.ammId || '');
    const mintA = toMint(it?.mintA);
    const mintB = toMint(it?.mintB);
    if (!id || !mintA || !mintB) continue;

    const isClmm = (it as any)?.poolType === 'CLMM' || (it as any)?.type?.toLowerCase().includes('concentrated') || (it as any)?.sqrtPriceX64 != null;

    const fee_bps = toFeeBps((it as any)?.feeRate ?? (it as any)?.tradeFeeRate ?? (it as any)?.feeBps ?? (it as any)?.tradeFeeBps);
    const decA = decimalsMap.get(mintA) ?? Number((it?.mintA as any)?.decimals);
    const decB = decimalsMap.get(mintB) ?? Number((it?.mintB as any)?.decimals);
    
    if (!Number.isFinite(decA) || !Number.isFinite(decB)) {
      continue;
    }

    if (isClmm) {
      const sqrtPriceX64 = anyToBigInt((it as any)?.sqrtPriceX64 ?? (it as any)?.sqrtPrice);
      const processed = processPriceThroughPipeline({
        mintA,
        mintB,
        decimalsA: decA,
        decimalsB: decB,
        poolId: id,
        dex: 'Raydium',
        poolType: 'clmm',
        sqrtPriceX64,
      });

      if (processed) {
        const wasSwapped = processed.wasSwapped === true;
        clmm.push({
          id,
          dex: 'Raydium',
          mint_a: processed.mintA,
          mint_b: processed.mintB,
          fee_bps,
          sqrt_price_x64: Number((it as any)?.sqrtPrice ?? (it as any)?.sqrtPriceX64 ?? 0),
          sqrt_price_x64_raw: sqrtPriceX64?.toString(),
          liquidity: Number((it as any)?.liquidity ?? 0),
          liquidity_raw: anyToBigInt((it as any)?.liquidity)?.toString(),
          tick_spacing: Number((it as any)?.tickSpacing),
          updated_ms: now,
          price_a_per_b: processed.priceForward,
          decimals_a: processed.decimalsA,
          decimals_b: processed.decimalsB,
          was_swapped: wasSwapped,
          native_mint_a: mintA,
          native_mint_b: mintB,
          native_decimals_a: decA,
          native_decimals_b: decB,
          pool_kind: 'clmm',
          tvl_usd: (it as any)?.tvl,
          _pipelineProcessed: true,
        } as ClmmPool);
      }
    } else { // AMM
      const reserveA = anyToBigInt((it as any)?.reserveA ?? (it as any)?.mintAmountA);
      const reserveB = anyToBigInt((it as any)?.reserveB ?? (it as any)?.mintAmountB);

      const processed = processPriceThroughPipeline({
        mintA,
        mintB,
        decimalsA: decA,
        decimalsB: decB,
        poolId: id,
        dex: 'Raydium',
        poolType: 'amm',
        reserveA,
        reserveB,
      });

      if (processed) {
        const wasSwapped = processed.wasSwapped === true;
        amm.push({
          id,
          dex: 'Raydium',
          mint_a: processed.mintA,
          mint_b: processed.mintB,
          fee_bps,
          price_a_per_b: processed.priceForward,
          updated_ms: now,
          pool_kind: 'amm',
          liquidity_base: Number((it as any)?.liquidity_base ?? (it as any)?.liquidity ?? 0),
          tvl_usd: (it as any)?.tvl,
          decimals_a: processed.decimalsA,
          decimals_b: processed.decimalsB,
          reserve_a_raw: reserveA?.toString(),
          reserve_b_raw: reserveB?.toString(),
          was_swapped: wasSwapped,
          native_mint_a: mintA,
          native_mint_b: mintB,
          native_decimals_a: decA,
          native_decimals_b: decB,
          native_reserve_a_raw: reserveA?.toString(),
          native_reserve_b_raw: reserveB?.toString(),
          _pipelineProcessed: true,
        } as AmmPool);
      }
    }
  }
  
  logger.info('raydium.pools normalized', { amm: amm.length, clmm: clmm.length, cat: 'raydium' });
  return { amm, clmm };
}


