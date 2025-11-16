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

  // Extract all unique mints for batch decimal resolution
  const allMints = new Set<string>();
  for (const it of arr) {
    if (!it) continue;
    const mintA = toMint(it?.mintA);
    const mintB = toMint(it?.mintB);
    if (mintA) allMints.add(mintA);
    if (mintB) allMints.add(mintB);
  }
  
  // Batch resolve decimals using centralized resolver with RPC-first validation
  const decimalsMap = await resolveManyDecimals(Array.from(allMints), { 
    logger, 
    normalizeMode: true // RPC validation priority during normalization
  });
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
    const tickSpacing = (it as any)?.tickSpacing ?? (it as any)?.config?.tickSpacing;
    const hasTick = typeof tickSpacing === 'number' && tickSpacing > 0; // Only consider valid tick spacing
    const isClmm = typeStr.includes('concentrated') || pooltype.map((s: any) => String(s).toLowerCase()).includes('clmm') || hasSqrt || hasTick;
    const fee_bps = toFeeBps((it as any)?.feeRate ?? (it as any)?.tradeFeeRate ?? (it as any)?.feeBps ?? (it as any)?.tradeFeeBps);
    
    // Get decimals from centralized resolver with API fallback
    let decA = Number((it?.mintA as any)?.decimals);
    let decB = Number((it?.mintB as any)?.decimals);
    
    if (!Number.isFinite(decA)) {
      decA = decimalsMap.get(mintA) ?? 6;
    }
    if (!Number.isFinite(decB)) {
      decB = decimalsMap.get(mintB) ?? 6;
    }
    
    // Clamp to reasonable integer bounds
    decA = Math.min(12, Math.max(0, Math.round(Number(decA))));
    decB = Math.min(12, Math.max(0, Math.round(Number(decB))));
    
    const price = Number((it as any)?.price);
    const tvl = Number((it as any)?.tvl);
    const mintAmountRawA = (it as any)?.mintAmountA;
    const mintAmountRawB = (it as any)?.mintAmountB;
    const mintAmountA = Number(mintAmountRawA);
    const mintAmountB = Number(mintAmountRawB);

    if (isClmm) {
      const tick = Number((it as any)?.tickSpacing ?? (it as any)?.config?.tickSpacing ?? 0);
      const sqrtCandidate = (it as any)?.sqrtPriceX64 ?? (it as any)?.sqrtPrice ?? 0;
      const sqrtBig = anyToBigInt(sqrtCandidate);
      const sqrt = typeof sqrtCandidate === 'number' ? sqrtCandidate : Number(sqrtBig ?? 0n);
      const liquidityCandidate = (it as any)?.liquidity ?? 0;
      const liquidity = Number(liquidityCandidate);
      const liquidityRaw = anyToBigInt(liquidityCandidate);
      const tvl_usd = Number.isFinite(tvl) && tvl > 0 ? tvl : undefined;
      const reserveA = Number((it as any)?.reserveA ?? NaN);
      const reserveB = Number((it as any)?.reserveB ?? NaN);
      const amount_a_whole = Number.isFinite(mintAmountA) ? mintAmountA : (Number.isFinite(reserveA) ? reserveA : undefined);
      const amount_b_whole = Number.isFinite(mintAmountB) ? mintAmountB : (Number.isFinite(reserveB) ? reserveB : undefined);
      let price_from_sqrt = 0;
      // CRITICAL: Verify decimals match mints before calculating price
      // Ensure decA corresponds to mintA and decB corresponds to mintB
      // Re-fetch decimals from resolver if there's any doubt to ensure correctness
      let verifiedDecA = decA;
      let verifiedDecB = decB;
      try {
        // Double-check decimals match the mints (defensive check)
        const decAFromMap = decimalsMap.get(mintA);
        const decBFromMap = decimalsMap.get(mintB);
        if (Number.isFinite(decAFromMap) && decAFromMap !== decA) {
          verifiedDecA = decAFromMap;
        }
        if (Number.isFinite(decBFromMap) && decBFromMap !== decB) {
          verifiedDecB = decBFromMap;
        }
      } catch {}
      
      // Ensure decimals are finite and reasonable
      if (!Number.isFinite(verifiedDecA) || verifiedDecA < 0 || verifiedDecA > 12) {
        verifiedDecA = decimalsMap.get(mintA) ?? 6;
      }
      if (!Number.isFinite(verifiedDecB) || verifiedDecB < 0 || verifiedDecB > 12) {
        verifiedDecB = decimalsMap.get(mintB) ?? 6;
      }
      verifiedDecA = Math.min(12, Math.max(0, Math.round(verifiedDecA)));
      verifiedDecB = Math.min(12, Math.max(0, Math.round(verifiedDecB)));
      
      // Update decA/decB to verified values for consistency
      decA = verifiedDecA;
      decB = verifiedDecB;
      
      let priceRatio = sqrtBig && Number.isFinite(decA) && Number.isFinite(decB)
        ? sqrtPriceX64ToPriceRatio(sqrtBig, decA as number, decB as number)
        : null;
      try {
        if (sqrt > 0 && Number.isFinite(decA) && Number.isFinite(decB)) {
          try {
            const rmod: any = await import('@raydium-io/raydium-sdk-v2');
            const SqrtPriceMath = rmod?.SqrtPriceMath || rmod?.Clmm?.SqrtPriceMath;
            if (SqrtPriceMath?.sqrtPriceX64ToPrice) {
              const sqrtBigInt = sqrtBig ?? BigInt(Math.floor(sqrt));
              // CRITICAL: Use verified decimals that match mintA and mintB
              const priceFromSdk = SqrtPriceMath.sqrtPriceX64ToPrice(sqrtBigInt, decA, decB);
              if (priceFromSdk != null && Number(priceFromSdk) > 0 && Number.isFinite(Number(priceFromSdk))) {
                price_from_sqrt = Number(priceFromSdk);
              }
            }
          } catch {}
          if (price_from_sqrt === 0) {
            if (!priceRatio && sqrtBig) {
              priceRatio = sqrtPriceX64ToPriceRatio(sqrtBig, decA as number, decB as number);
            }
            if (priceRatio?.float && Number.isFinite(priceRatio.float) && priceRatio.float > 0) {
              price_from_sqrt = priceRatio.float;
            } else {
              const two64 = Math.pow(2, 64);
              const ratio = sqrt / two64;
              // CRITICAL: Use verified decimals - decA for mintA, decB for mintB
              // Scale converts from native units to whole units: 10^(decB - decA)
              const scale = Math.pow(10, (decB as number) - (decA as number));
              const aPerB = scale / (ratio * ratio);
              if (Number.isFinite(aPerB) && aPerB > 0) price_from_sqrt = aPerB;
            }
          }
        }
      } catch {}
      // Choose best price from sqrt-derived, upstream, and reserves-derived candidates
      let px = 0;
      try {
        const safeRatio = (num: any, den: any): number | undefined => {
          const a = Number(num);
          const b = Number(den);
          if (!Number.isFinite(a) || !Number.isFinite(b) || !(b > 0)) return undefined;
          const r = a / b;
          return Number.isFinite(r) && r > 0 ? r : undefined;
        };
        const looksLikeAtomic = (value: any): boolean => {
          if (value == null) return false;
          if (typeof value === 'number') return Number.isSafeInteger(value);
          if (typeof value === 'string') {
            const trimmed = value.trim();
            if (!trimmed) return false;
            if (/[eE\.]/.test(trimmed)) return false;
            return /^[-+]?\d+$/.test(trimmed);
          }
          return false;
        };
        const candidates: number[] = [];
        const pushCandidate = (val: number | undefined) => {
          if (!Number.isFinite(val) || !(val as number > 0)) return;
          const v = val as number;
          const dup = candidates.find((existing) => Math.abs(existing - v) <= Math.abs(existing) * 1e-12);
          if (dup == null) candidates.push(v);
        };

        // Highest-confidence candidates first
        pushCandidate(price_from_sqrt > 0 ? price_from_sqrt : undefined);

        const upstreamPrice = Number(price);
        if (upstreamPrice > 0) {
          pushCandidate(1 / upstreamPrice);
        }

        const hasDecs = Number.isFinite(decA) && Number.isFinite(decB);
        if (hasDecs && looksLikeAtomic(mintAmountRawA) && looksLikeAtomic(mintAmountRawB)) {
          const scaledA = mintAmountA / Math.pow(10, decA as number);
          const scaledB = mintAmountB / Math.pow(10, decB as number);
          pushCandidate(safeRatio(scaledA, scaledB));
        }

        pushCandidate(safeRatio(amount_a_whole, amount_b_whole));

        // Use USD reference to select best candidate when multiple available
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
        if (directRef && candidates.length > 1) {
          let best = candidates[0];
          let bestDev = Math.max(best / (directRef as number), (directRef as number) / best);
          for (let i = 1; i < candidates.length; i++) {
            const v = candidates[i];
            const dev = Math.max(v / (directRef as number), (directRef as number) / v);
            if (dev + 1e-12 < bestDev) { bestDev = dev; best = v; }
          }
          px = best;
        } else {
          px = candidates.length > 0 ? candidates[0] : (upstreamPrice > 0 ? (1 / upstreamPrice) : 0);
        }
      } catch {
        px = price_from_sqrt > 0 ? price_from_sqrt : (Number(price) > 0 ? (1 / Number(price)) : 0);
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
        
        // Derive execution-critical accounts for Raydium CLMM
        let observation_state: string | undefined;
        let ex_bitmap: string | undefined;
        let account_a: string | undefined;
        let account_b: string | undefined;
        try {
          const { PublicKey } = await import('@solana/web3.js');
          const poolPk = new PublicKey(id);
          const programId = new PublicKey('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK');
          
          // Derive observation state PDA: [b"observation", pool.key()]
          try {
            const [observationPda] = PublicKey.findProgramAddressSync(
              [Buffer.from('observation'), poolPk.toBuffer()],
              programId
            );
            observation_state = observationPda.toBase58();
          } catch {}
          
          // Derive exBitmap (tick array bitmap extension) PDA: [b"exaccount", pool.key()]
          try {
            const [exBitmapPda] = PublicKey.findProgramAddressSync(
              [Buffer.from('exaccount'), poolPk.toBuffer()],
              programId
            );
            ex_bitmap = exBitmapPda.toBase58();
          } catch {}
          
          // Extract vault accounts from CLMM cache (these are obtained from on-chain decoding)
          try {
            const { getClmmStatic } = await import('../../execution/clmmCache.js');
            const cached = typeof getClmmStatic === 'function' ? getClmmStatic(id) : null;
            if (cached?.vaultA) account_a = cached.vaultA;
            if (cached?.vaultB) account_b = cached.vaultB;
            
            // Log vault extraction for debugging
            try {
              logger.debug('raydium.clmm.vaults.extracted', {
                cat: 'raydium',
                ctx: { 
                  pool: id, 
                  hasVaultA: !!account_a, 
                  hasVaultB: !!account_b,
                  vaultA: account_a?.slice(0, 8) + '...',
                  vaultB: account_b?.slice(0, 8) + '...'
                }
              });
            } catch {}
          } catch (e: any) {
            try {
              logger.debug('raydium.clmm.vaults.cache_miss', {
                cat: 'raydium',
                ctx: { pool: id, error: String(e?.message || e) }
              });
            } catch {}
          }
        } catch (e: any) {
          try {
            logger.debug('raydium.clmm.exec_accounts.derivation.failed', {
              cat: 'raydium',
              ctx: { pool: id, error: String(e?.message || e) }
            });
          } catch {}
        }
        
        clmm.push({
          id,
          dex: 'Raydium',
          mint_a: mintA,
          mint_b: mintB,
          fee_bps,
          sqrt_price_x64: Number.isFinite(sqrt) ? sqrt : 0,
          sqrt_price_x64_raw: sqrtBig ? sqrtBig.toString() : undefined,
          liquidity: Number.isFinite(liquidity) ? liquidity : 0,
          liquidity_raw: liquidityRaw ? liquidityRaw.toString() : undefined,
          tick_spacing: Number.isFinite(tick) ? tick : 0,
          updated_ms: now,
          price_a_per_b: px > 0 ? px : undefined,
          price_a_per_b_num: priceRatio ? priceRatio.numerator.toString() : undefined,
          price_a_per_b_den: priceRatio ? priceRatio.denominator.toString() : undefined,
          price_a_per_b_exact: ratioToDecimalString(priceRatio) ?? undefined,
          decimals_a: Number.isFinite(decA) ? decA : undefined,
          decimals_b: Number.isFinite(decB) ? decB : undefined,
          pool_kind: 'clmm',
          tvl_usd,
          amount_a_whole,
          amount_b_whole,
          pool_liquidity_raw,
          liquidity_display: tvl_usd,
          account_a,
          account_b,
          observation_state,
          ex_bitmap,
        });
      }
    } else {
      const tvl_usd = Number.isFinite(tvl) && tvl > 0 ? tvl : undefined;
      // Accept legacy test fields reserveA/reserveB as whole reserves when mintAmountA/B absent
      const amount_a_whole = normalizeAmount(mintAmountRawA, decA) ?? normalizeAmount((it as any)?.reserveA, decA);
      const amount_b_whole = normalizeAmount(mintAmountRawB, decB) ?? normalizeAmount((it as any)?.reserveB, decB);
      // Treat mintAmountA/B as already scaled unless clearly atomic
      const amounts_are_whole = undefined;
      const liquidity_base = Number.isFinite(amount_a_whole as any) && Number.isFinite(amount_b_whole as any)
        ? Math.min(amount_a_whole as number, amount_b_whole as number)
        : 0;
      const liquidity_display = (tvl_usd != null) ? tvl_usd : (liquidity_base > 0 ? liquidity_base : undefined);
      const price_in = (Number.isFinite(price) && price > 0) ? (1 / Number(price)) : 0;
      const price_res = (Number.isFinite(amount_a_whole as any) && Number.isFinite(amount_b_whole as any) && (amount_b_whole as number) > 0)
        ? ((amount_a_whole as number) / (amount_b_whole as number))
        : 0;
      // Prefer reserves-derived price; only fall back to upstream price when reserves are unavailable
      const price_from_reserves = (price_res > 0 ? price_res : 0);
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
      const reserveARaw = anyToBigInt((it as any)?.reserveA ?? mintAmountA);
      const reserveBRaw = anyToBigInt((it as any)?.reserveB ?? mintAmountB);
      amm.push({
        id,
        dex: 'Raydium',
        mint_a: mintA,
        mint_b: mintB,
        fee_bps,
        price_a_per_b: price_sane,
        liquidity_base,
        updated_ms: now,
        pool_kind: 'amm',
        tvl_usd,
        amount_a_whole,
        amount_b_whole,
        amounts_are_whole,
        decimals_a: Number.isFinite(decA) ? decA : undefined,
        decimals_b: Number.isFinite(decB) ? decB : undefined,
        pool_liquidity_raw: liquidity_base > 0 ? liquidity_base : undefined,
        liquidity_display,
        reserve_a_raw: reserveARaw ? reserveARaw.toString() : undefined,
        reserve_b_raw: reserveBRaw ? reserveBRaw.toString() : undefined,
      });
    }
  }

  // Batch fetch market accounts for AMM pools (Raydium only)
  // This enriches pools with Serum market sub-accounts required for swaps
  // Uses batched getMultipleAccountsInfo instead of individual fetches (10-15x faster)
  const enableMarketFetch = (CONFIG as any)?.raydium?.fetchMarketAccounts !== false;
  if (enableMarketFetch && amm.length > 0) {
    try {
      logger.info('raydium.amm.market_accounts.fetch.start', { count: amm.length, cat: 'pools' });
      const fetchStart = Date.now();
      
      // PHASE 1: Batch fetch all pool accounts
      const poolIds = amm.map(p => p.id);
      const poolAccountsMap = await batchFetchRaydiumPoolAccounts(poolIds);
      
      // PHASE 2: Collect unique market IDs and their program IDs
      const marketIds = new Set<string>();
      const marketProgramIds = new Map<string, string>();
      for (const [poolId, poolData] of poolAccountsMap.entries()) {
        if (poolData.marketId && poolData.marketProgramId) {
          marketIds.add(poolData.marketId);
          marketProgramIds.set(poolData.marketId, poolData.marketProgramId);
        }
      }
      
      // PHASE 3: Batch fetch all market accounts
      const marketAccountsMap = await batchFetchSerumMarketAccounts(
        Array.from(marketIds),
        marketProgramIds
      );
      
      // PHASE 4: Enrich pools with fetched data
      let successCount = 0;
      let skipCount = 0;
      
      for (let i = 0; i < amm.length; i++) {
        const pool = amm[i];
        const poolData = poolAccountsMap.get(pool.id);
        
        if (!poolData?.marketId) {
          skipCount++;
          continue;
        }
        
        const marketData = marketAccountsMap.get(poolData.marketId);
        
        // Update pool with all accounts
        amm[i].market_id = poolData.marketId;
        amm[i].market_program_id = poolData.marketProgramId;
        amm[i].amm_authority = poolData.ammAuthority;
        amm[i].amm_open_orders = poolData.ammOpenOrders;
        amm[i].amm_target_orders = poolData.ammTargetOrders;
        amm[i].lp_mint = poolData.lpMint;
        amm[i].account_a = poolData.baseVault || amm[i].account_a;
        amm[i].account_b = poolData.quoteVault || amm[i].account_b;
        
        if (marketData) {
          amm[i].market_bids = marketData.bids;
          amm[i].market_asks = marketData.asks;
          amm[i].market_event_queue = marketData.eventQueue;
          amm[i].market_base_vault = marketData.baseVault;
          amm[i].market_quote_vault = marketData.quoteVault;
          amm[i].market_authority = marketData.authority;
          successCount++;
        } else {
          try {
            logger.debug('raydium.amm.market_accounts.no_market_data', {
              cat: 'pools',
              ctx: { poolId: pool.id, marketId: poolData.marketId }
            });
          } catch {}
        }
        
        // DEBUG: Log successful fetch for specific pool
        if (pool.id === '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2') {
          try {
            logger.info('raydium.amm.market_accounts.target_pool_enriched', {
              cat: 'pools',
              ctx: {
                poolId: pool.id,
                hasMarketId: !!amm[i].market_id,
                hasMarketBids: !!amm[i].market_bids,
                hasMarketAsks: !!amm[i].market_asks,
                hasAmmAuthority: !!amm[i].amm_authority,
                market_id: amm[i].market_id,
                market_bids: amm[i].market_bids
              }
            });
          } catch {}
        }
      }
      
      const fetchMs = Date.now() - fetchStart;
      logger.info('raydium.amm.market_accounts.fetch.complete', {
        total: amm.length,
        success: successCount,
        skipped: skipCount,
        uniqueMarkets: marketIds.size,
        ms: fetchMs,
        avgMsPerPool: Math.round(fetchMs / amm.length),
        cat: 'pools'
      });
    } catch (err) {
      try {
        logger.error('raydium.amm.market_accounts.fetch.failed', {
          error: String((err as any)?.message || err),
          cat: 'pools'
        });
      } catch {}
    }
  }

  // DEBUG: Log a sample pool before canonicalization to verify market accounts are present
  if (amm.length > 0) {
    const samplePool = amm.find(p => p.id === '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2') || amm[0];
    try {
      logger.info('raydium.amm.before_canon.sample', {
        cat: 'pools',
        ctx: {
          id: samplePool.id,
          hasMarketId: !!samplePool.market_id,
          hasMarketBids: !!samplePool.market_bids,
          hasMarketAsks: !!samplePool.market_asks,
          hasMarketEventQueue: !!samplePool.market_event_queue,
          hasAmmAuthority: !!samplePool.amm_authority,
          hasAmmOpenOrders: !!samplePool.amm_open_orders,
          market_id: samplePool.market_id?.slice(0, 8) + '...',
          market_bids: samplePool.market_bids?.slice(0, 8) + '...'
        }
      });
    } catch {}
  }

  const ammCanon = canonicalizePools(amm);
  const clmmCanon = canonicalizePools(clmm);
  
  // DEBUG: Log same pool after canonicalization
  if (ammCanon.length > 0) {
    const samplePool = ammCanon.find(p => p.id === '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2') || ammCanon[0];
    try {
      logger.info('raydium.amm.after_canon.sample', {
        cat: 'pools',
        ctx: {
          id: samplePool.id,
          hasMarketId: !!samplePool.market_id,
          hasMarketBids: !!samplePool.market_bids,
          hasMarketAsks: !!samplePool.market_asks,
          hasMarketEventQueue: !!samplePool.market_event_queue,
          hasAmmAuthority: !!samplePool.amm_authority,
          hasAmmOpenOrders: !!samplePool.amm_open_orders,
          market_id: samplePool.market_id?.slice(0, 8) + '...',
          market_bids: samplePool.market_bids?.slice(0, 8) + '...'
        }
      });
    } catch {}
  }
  
  // Verify canonicalization: ensure price inversion happens correctly when mints are swapped
  try {
    const ammVerification = verifyCanonicalization(ammCanon, swapABFields);
    const clmmVerification = verifyCanonicalization(clmmCanon, swapABFields);
    if (!ammVerification.valid || !clmmVerification.valid) {
      try {
        logger.warn('raydium.canonicalization.verification.failed', {
          ammErrors: ammVerification.errors.length,
          clmmErrors: clmmVerification.errors.length,
          cat: 'raydium'
        });
      } catch {}
    }
  } catch {}
  
  logger.info('raydium.pools normalized', { amm: ammCanon.length, clmm: clmmCanon.length, cat: 'raydium' });
  return { amm: ammCanon, clmm: clmmCanon };
}


