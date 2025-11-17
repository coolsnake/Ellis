import { logger } from '../../utils/logger.js';
import { emit } from '../realtime.js';
import { CONFIG } from '../../utils/config.js';
import { writeJson, joinPath } from '../../utils/fs.js';
import type { ClmmPool, PoolsPayload } from './types.js';
import { validateHttpUrl, swapABFields } from './common.js';
import { canonicalizePools } from './canonical.js';
import { resolveManyDecimals } from './decimals.js';
import { verifyCanonicalization } from './validation.js';
import { httpLogStart, httpLogResponse, httpLog429, httpLogNonOk } from './httpLog.js';
import { getTokenMeta } from '../../execution/resolver/tokenMeta.js';
import { processPriceThroughPipeline } from './pricePipeline.js';
import { getPriceByMint } from '../../server/priceStore.js';

const METEORA_DLMM_PROGRAM_ID = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';
const ATOMIC_INT_REGEX = /^[-+]?\d+$/;

function looksLikeAtomicAmount(value: any): boolean {
  if (typeof value === 'number') {
    return Number.isFinite(value) && Number.isSafeInteger(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return false;
    if (/[eE\.]/.test(trimmed)) return false;
    return ATOMIC_INT_REGEX.test(trimmed);
  }
  return false;
}

export async function fetchMeteoraHttp(): Promise<any> {
  const METEORA_RAW_PATH = joinPath(CONFIG.cacheDir, 'meteora-raw-sample.json');
  try {
    const baseUnsafe = (CONFIG as any)?.meteora?.apiUrl || 'https://dlmm-api.meteora.ag/pair/all_with_pagination';
    const baseResolved = validateHttpUrl(baseUnsafe) || 'https://dlmm-api.meteora.ag/pair/all_with_pagination';
    const size = Number(((CONFIG as any)?.meteora?.pageSize) || 200);
    const retries = Number(((CONFIG as any)?.meteora?.maxHttpRetries) || 2);
    const backoffMs = Number(((CONFIG as any)?.meteora?.httpBackoffMs) || 500);
    const maxPages = Number(((CONFIG as any)?.meteora?.maxPages) || 3);
    const candidates: string[] = (() => {
      const list: string[] = [];
      try {
        const b = baseResolved;
        // Prefer all_with_pagination; add v1/pairs as secondary if user gave that
        if (/\/v1\/pairs(\/?.*)?$/.test(b)) {
          list.push(b);
          const alt = b.replace('/v1/pairs', '/pair/all_with_pagination');
          if (alt && alt !== b) list.push(alt);
        } else {
          list.push(b);
          const maybeV1 = b.replace('/pair/all_with_pagination', '/v1/pairs');
          if (maybeV1 && maybeV1 !== b) list.push(maybeV1);
        }
      } catch { list.push(baseResolved); }
      return Array.from(new Set(list.filter(Boolean)));
    })();
    const build = (baseUrl: string, page: number, limit: number) => {
      const sp = new URLSearchParams();
      sp.append('page', String(Math.max(0, page)));
      if (Number.isFinite(limit as any) && limit > 0) sp.append('limit', String(limit));
      const qs = sp.toString();
      return qs ? `${baseUrl}?${qs}` : baseUrl;
    };
    // eslint-disable-next-line no-undef
    const fetchFn: any = (globalThis as any).fetch || fetch;
    for (const base of candidates) {
      // Pagination loop on this base
      const out: any[] = [];
      let page = 0;
      const pageLimit = (maxPages && maxPages > 0) ? maxPages : Number.POSITIVE_INFINITY;
      for (let i = 0; i < pageLimit; i++) {
        let ok = false;
        for (let attempt = 0; attempt <= retries; attempt++) {
          try {
            const url = build(base, page, size);
            const cid = httpLogStart({ source: 'meteora', url, extra: { page, limit: size } });
            const res = await fetchFn(url, { headers: { accept: 'application/json' }, method: 'GET' });
            if (res?.status === 429) { try { logger.warn('meteora.http 429', { page, cat: 'meteora' }); emit('log', { level: 'warn', message: `arb:429 source=meteora page=${page}`, timestamp: new Date().toISOString(), context: { cat: 'arb' } }); } catch {}; httpLog429({ source: 'meteora', url, cid }); throw new Error('http 429'); }
            if (!res?.ok) throw new Error(`http ${res?.status}`);
            const json: any = await res.json().catch(() => null);
            const arr: any[] = Array.isArray(json?.pairs) ? json.pairs : (Array.isArray(json) ? json : (Array.isArray(json?.data) ? json.data : []));
            const more = Array.isArray(arr) && arr.length >= size;
            out.push(...(arr || []));
            page += 1;
            ok = true;
            if (!more) { i = pageLimit; break; }
            httpLogResponse({ source: 'meteora', url, cid, status: res.status, ms: 0, count: arr.length });
            break;
          } catch (e: any) {
            const msg = String(e?.message || e);
            if (/429/.test(msg)) { await new Promise(r => setTimeout(r, backoffMs * (attempt + 1))); continue; }
            if (attempt < retries) await new Promise(r => setTimeout(r, backoffMs * (attempt + 1)));
          }
        }
        if (!ok) break;
      }
      if (out.length > 0) {
        try { await writeJson(METEORA_RAW_PATH, out); } catch (e: any) { try { logger.warn('meteora.cache write failed', { file: METEORA_RAW_PATH, error: String(e?.message || e), cat: 'meteora' }); } catch {} }
        try { logger.info('meteora.http raw', { count: out.length, cat: 'meteora' }); } catch {}
        return out;
      }
      // else try next candidate
    }
    // If all candidates failed, attempt one last single GET on primary base with paging
    const url = build(baseResolved, 0, size);
    const res = await fetchFn(url, { headers: { accept: 'application/json' }, method: 'GET' });
    if (!res?.ok) throw new Error(`http ${res?.status}`);
    const json: any = await res.json().catch(() => null);
    const single = Array.isArray(json?.pairs) ? json.pairs : (Array.isArray(json) ? json : (Array.isArray(json?.data) ? json.data : []));
    try { httpLogResponse({ source: 'meteora', url, cid: `http-${Date.now()}`, status: res.status, ms: 0, count: single.length }); } catch {}
    try { await writeJson(METEORA_RAW_PATH, single); } catch (e: any) { try { logger.warn('meteora.cache write failed', { file: METEORA_RAW_PATH, error: String(e?.message || e), cat: 'meteora' }); } catch {} }
    return single;
  } catch {
    return [];
  }
}

export async function normalizeMeteoraHttp(raw: any): Promise<PoolsPayload> {
  const now = Date.now();
  const clmm: ClmmPool[] = [];
  try {
    const { getTokenMeta } = await import('../../execution/resolver/tokenMeta.js');
  } catch {}
  
  const arrCandidates: any[] = [];
  if (Array.isArray(raw?.pairs)) arrCandidates.push(raw.pairs);
  if (Array.isArray(raw)) arrCandidates.push(raw);
  if (Array.isArray(raw?.data)) arrCandidates.push(raw.data);
  const arr: any[] = arrCandidates.find(a => Array.isArray(a) && a.length) || (Array.isArray(raw?.pairs) ? raw.pairs : (Array.isArray(raw) ? raw : (Array.isArray(raw?.data) ? raw.data : [])));
  
  // Extract all unique mints for batch decimal resolution
  const allMints = new Set<string>();
  for (const it of arr) {
    const tokenA = it?.tokenA || it?.tokenX || {};
    const tokenB = it?.tokenB || it?.tokenY || {};
    const mint_a = String(it?.mint_x || tokenA?.mint || it?.mintA || it?.tokenXMint || '');
    const mint_b = String(it?.mint_y || tokenB?.mint || it?.mintB || it?.tokenYMint || '');
    if (mint_a) allMints.add(mint_a);
    if (mint_b) allMints.add(mint_b);
  }
  
  // Batch resolve decimals using centralized resolver with RPC-first validation
  const decimalsMap = await resolveManyDecimals(Array.from(allMints), { 
    logger, 
    batchSize: 100,
    normalizeMode: true // RPC validation priority during normalization
  });
  
  const bitmapExtensionMap = await resolveMeteoraBitmapExtensions(
    arr
      .map(it => String(it?.address || it?.id || it?.poolAddress || ''))
      .filter(id => typeof id === 'string' && id.length > 0)
  );
  
  for (const it of arr) {
    const id = String(it?.address || it?.id || it?.poolAddress || '');
    const tokenA = it?.tokenA || it?.tokenX || {};
    const tokenB = it?.tokenB || it?.tokenY || {};
    let mint_a = String(it?.mint_x || tokenA?.mint || it?.mintA || it?.tokenXMint || '');
    let mint_b = String(it?.mint_y || tokenB?.mint || it?.mintB || it?.tokenYMint || '');
    if (!id || !mint_a || !mint_b) continue;
    
    // Get decimals from centralized resolver with API fallback
    const apiDecA = Number((tokenA?.decimals ?? it?.decimalsA));
    const apiDecB = Number((tokenB?.decimals ?? it?.decimalsB));
    
    let decA = decimalsMap.get(mint_a) ?? apiDecA;
    let decB = decimalsMap.get(mint_b) ?? apiDecB;

    if (!Number.isFinite(decA)) decA = 6;
    if (!Number.isFinite(decB)) decB = 6;

    // Clamp to reasonable integer bounds
    decA = Math.min(12, Math.max(0, Math.round(Number(decA))));
    decB = Math.min(12, Math.max(0, Math.round(Number(decB))));
    
    const amtAraw = (it?.reserve_x_amount ?? it?.tokenBalanceA ?? it?.tokenAAmount ?? it?.amountA ?? it?.baseAmount ?? 0);
    const amtBraw = (it?.reserve_y_amount ?? it?.tokenBalanceB ?? it?.tokenBAmount ?? it?.amountB ?? it?.quoteAmount ?? 0);
    const amount_a_atomic = looksLikeAtomicAmount(amtAraw) ? BigInt(String(amtAraw)) : undefined;
    const amount_b_atomic = looksLikeAtomicAmount(amtBraw) ? BigInt(String(amtBraw)) : undefined;

    const tvlUsdcRaw = (it as any)?.tvlUsdc ?? (it as any)?.tvlUsd ?? (it as any)?.liquidity;
    const tvl_usd = Number.isFinite(Number(tvlUsdcRaw)) && Number(tvlUsdcRaw) > 0 ? Number(tvlUsdcRaw) : undefined;

    const processedPrice = processPriceThroughPipeline({
      mintA: mint_a,
      mintB: mint_b,
      decimalsA: decA,
      decimalsB: decB,
      poolId: id,
      dex: 'Meteora',
      poolType: 'clmm',
      activeId: Number((it as any)?.active_id ?? (it as any)?.activeId),
      binStep: Number((it as any)?.bin_step ?? (it as any)?.binStep),
      tokenXMint: String((it as any)?.mint_x || (it as any)?.tokenXMint || tokenA?.mint || ''),
      tokenYMint: String((it as any)?.mint_y || (it as any)?.tokenYMint || tokenB?.mint || ''),
    }, {
      getUsd: getPriceByMint,
    });

    if (!processedPrice) {
      continue; // Skip pool if price can't be determined
    }

    const { 
      mintA: finalMintA, 
      mintB: finalMintB, 
      priceForward, 
      wasSwapped,
      decimalsA: finalDecA,
      decimalsB: finalDecB,
    } = processedPrice;

    const [finalAmountAtomicA, finalAmountAtomicB] = wasSwapped
      ? [amount_b_atomic, amount_a_atomic]
      : [amount_a_atomic, amount_b_atomic];
    
    const wholeA = finalAmountAtomicA != null && finalDecA != null ? Number(finalAmountAtomicA) / Math.pow(10, finalDecA) : undefined;
    const wholeB = finalAmountAtomicB != null && finalDecB != null ? Number(finalAmountAtomicB) / Math.pow(10, finalDecB) : undefined;

    const pool_liquidity_raw = tvl_usd ?? (wholeA != null && wholeB != null ? Math.min(wholeA, wholeB) : undefined);

    let account_a: string | undefined;
    let account_b: string | undefined;
    try {
      const reserveX = String((it as any)?.reserve_x || (it as any)?.reserveX || '');
      const reserveY = String((it as any)?.reserve_y || (it as any)?.reserveY || '');
      const tokenXMint = String((it as any)?.mint_x || (it as any)?.tokenXMint || tokenA?.mint || '');
      
      if (reserveX && reserveY) {
        if (tokenXMint === mint_a) {
          account_a = reserveX;
          account_b = reserveY;
        } else {
          account_a = reserveY;
          account_b = reserveX;
        }
      }
    } catch {}

    if (wasSwapped) {
      [account_a, account_b] = [account_b, account_a];
    }
    
    const bin_array_bitmap_extension = bitmapExtensionMap.get(id);
    
    clmm.push({
      id,
      dex: 'Meteora',
      mint_a: finalMintA,
      mint_b: finalMintB,
      fee_bps: Math.round(Number(it.feeRate || 0) * 100),
      sqrt_price_x64: 0, // Let graph builder derive if needed
      liquidity: 0,
      tick_spacing: Number((it as any)?.bin_step || (it as any)?.binStep || 0),
      updated_ms: now,
      price_a_per_b: priceForward,
      amount_a: finalAmountAtomicA?.toString(),
      amount_b: finalAmountAtomicB?.toString(),
      amount_a_whole: wholeA,
      amount_b_whole: wholeB,
      decimals_a: finalDecA,
      decimals_b: finalDecB,
      account_a,
      account_b,
      bin_array_bitmap_extension,
      pool_kind: 'clmm',
      pool_liquidity_raw,
      tvl_usd,
      liquidity_display: tvl_usd ?? pool_liquidity_raw,
      _pipelineProcessed: true,
    } as any);
  }
  
  // No need for manual canonicalization or verification, pipeline handles it.

  try {
    const canon = String(((CONFIG as any)?.system?.canonicalizePairs) || 'lex');
    logger.info('meteora.http normalized', { clmm: clmm.length, cat: 'meteora', canon });
  } catch {}
  
  // OPTIMIZATION: Pre-cache active bin IDs to eliminate RPC calls during transaction building
  await populateMeteoraActiveIds(clmm);
  
  return { amm: [], clmm: clmm };
}

async function resolveMeteoraBitmapExtensions(poolIds: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const unique = Array.from(new Set(poolIds.filter(id => typeof id === 'string' && id.length > 0)));
  if (unique.length === 0) return result;

  const fallback = METEORA_DLMM_PROGRAM_ID;
  try {
    const { PublicKey } = await import('@solana/web3.js');
    const { getConnection } = await import('../../wallet/wallet.js');
    const { withRpcLimit } = await import('../../utils/rpcLimiter.js');
    const connection = getConnection();
    const programId = new PublicKey(METEORA_DLMM_PROGRAM_ID);

    const derived: { id: string; pda: any }[] = [];
    for (const id of unique) {
      try {
        const poolPk = new PublicKey(id);
        const [bitmapExtPda] = PublicKey.findProgramAddressSync(
          [Buffer.from('bitmap_extension'), poolPk.toBuffer()],
          programId
        );
        derived.push({ id, pda: bitmapExtPda });
      } catch (err) {
        result.set(id, fallback);
        try {
          logger.info('meteora.bitmap_ext.derive_failed', {
            pool: id,
            error: String((err as any)?.message || err),
            cat: 'meteora'
          });
        } catch {}
      }
    }

    const BATCH_SIZE = 100;
    for (let i = 0; i < derived.length; i += BATCH_SIZE) {
      const batch = derived.slice(i, i + BATCH_SIZE);
      const pubkeys = batch.map(entry => entry.pda);
      try {
        const weight = Math.max(1, Math.ceil(batch.length / 100));
        const infos = await withRpcLimit(
          () => connection.getMultipleAccountsInfo(pubkeys),
          weight,
          { module: 'pools', method: 'meteora.bitmapExtBatch' }
        );

        for (let j = 0; j < batch.length; j++) {
          const entry = batch[j];
          const info = infos?.[j];
          if (info && typeof info.owner?.equals === 'function' && info.owner.equals(programId)) {
            result.set(entry.id, entry.pda.toBase58());
          } else {
            result.set(entry.id, fallback);
          }
        }
      } catch (batchErr) {
        for (const entry of batch) {
          result.set(entry.id, fallback);
        }
        try {
          logger.warn('meteora.bitmap_ext.batch_failed', {
            error: String((batchErr as any)?.message || batchErr),
            batchSize: batch.length,
            cat: 'meteora'
          });
        } catch {}
      }
    }

    try {
      logger.info('meteora.bitmap_ext.batch_complete', {
        total: unique.length,
        resolved: Array.from(result.values()).filter(v => v !== fallback).length,
        fallback: Array.from(result.values()).filter(v => v === fallback).length,
        cat: 'meteora'
      });
    } catch {}
  } catch (err) {
    try {
      logger.warn('meteora.bitmap_ext.batch_unavailable', {
        error: String((err as any)?.message || err),
        cat: 'meteora'
      });
    } catch {}
    for (const id of unique) {
      if (!result.has(id)) result.set(id, fallback);
    }
  }
  return result;
}

/**
 * Pre-populate execution cache with Meteora active bin IDs and bin array addresses
 * This eliminates 100-200ms RPC calls per Meteora swap during transaction building
 */
async function populateMeteoraActiveIds(pools: ClmmPool[]): Promise<void> {
  if (pools.length === 0) return;
  
  try {
    const { executionCache } = await import('../../execution/cache.js');
    const { getConnection } = await import('../../wallet/wallet.js');
    const { withRpcLimit } = await import('../../utils/rpcLimiter.js');
    const { PublicKey } = await import('@solana/web3.js');
    const connection = getConnection();
    
    const startTime = Date.now();
    let cached = 0;
    let failed = 0;
    
    // Import Meteora SDK once for all pools (for bin array derivation only)
    const mod = await import('@meteora-ag/dlmm');
    // CRITICAL: Resolve the module structure correctly (same as in instruction builder)
    const DLMM: any = (mod && (mod as any).default) ? (mod as any).default : (((mod as any).DLMM) || mod);
    
    const programId = new PublicKey(METEORA_DLMM_PROGRAM_ID);
    
    // Batch fetch pool states (100 at a time to respect RPC limits)
    const BATCH_SIZE = 100;
    for (let i = 0; i < pools.length; i += BATCH_SIZE) {
      const batch = pools.slice(i, i + BATCH_SIZE);
      
      try {
        const pks = batch.map(p => new PublicKey(p.id));
        
        // Use getMultipleAccountsInfo for efficient batch fetching
        // Weight = number of accounts / 100 (RPC limiter convention)
        const weight = Math.max(1, Math.ceil(batch.length / 100));
        const accounts = await withRpcLimit(
          () => connection.getMultipleAccountsInfo(pks),
          weight,
          { module: 'pools', method: 'getMultipleAccountsInfo' }
        );
        
        // Process each account and extract active bin ID
        for (let j = 0; j < accounts.length; j++) {
          const pool = batch[j];
          const acc = accounts[j];
          
          if (acc?.data) {
            try {
              // OPTIMIZATION: Read activeId directly from pool data (much more reliable than SDK decode)
              // Meteora DLMM pool structure has activeId at offset 240 as i32 (4 bytes, signed little-endian)
              // Reference: backend/scripts/analyze-meteora-pool.ts line 75
              const ACTIVE_ID_OFFSET = 240;
              
              if (acc.data.length < ACTIVE_ID_OFFSET + 4) {
                failed++;
                try {
                  logger.debug('meteora.activeId.data_too_short', {
                    cat: 'meteora',
                    ctx: {
                      pool: pool.id.slice(0, 8) + '...',
                      dataLength: acc.data.length,
                      required: ACTIVE_ID_OFFSET + 4
                    }
                  });
                } catch {}
                continue;
              }
              
              // Read activeId as signed 32-bit little-endian integer
              const activeId = Buffer.from(acc.data).readInt32LE(ACTIVE_ID_OFFSET);
              
              if (activeId !== undefined && activeId !== null) {
                // ENHANCEMENT: Also derive bin array addresses deterministically
                const binArrayAddresses = deriveBinArrays(
                  new PublicKey(pool.id),
                  activeId,
                  programId,
                  DLMM
                );
                
                // Cache active bin ID AND bin array addresses
                executionCache.setHot(pool.id, {
                  activeId: activeId,
                  binArrays: binArrayAddresses,
                });
                cached++;
                
                try {
                  logger.debug('meteora.activeId.cached', {
                    cat: 'meteora',
                    ctx: {
                      pool: pool.id.slice(0, 8) + '...',
                      activeId: activeId,
                      binArrayCount: binArrayAddresses ? Object.keys(binArrayAddresses).filter(k => binArrayAddresses[k as keyof typeof binArrayAddresses]).length : 0
                    }
                  });
                } catch {}
              } else {
                failed++;
              }
            } catch (decodeErr) {
              failed++;
              try {
                logger.warn('meteora.activeId.decode_failed', {
                  cat: 'meteora',
                  ctx: {
                    pool: pool.id.slice(0, 8) + '...',
                    error: String((decodeErr as any)?.message || decodeErr)
                  }
                });
              } catch {}
            }
          } else {
            failed++;
          }
        }
      } catch (batchErr) {
        failed += batch.length;
        try {
          logger.warn('meteora.activeId.batch_failed', {
            cat: 'meteora',
            ctx: {
              batchIndex: Math.floor(i / BATCH_SIZE),
              batchSize: batch.length,
              error: String((batchErr as any)?.message || batchErr)
            }
          });
        } catch {}
      }
    }
    
    const durationMs = Date.now() - startTime;
    try {
      logger.info('meteora.activeId.cache_populated', {
        cat: 'meteora',
        ctx: {
          total: pools.length,
          cached,
          failed,
          durationMs,
          avgMs: pools.length > 0 ? Math.round(durationMs / pools.length) : 0
        }
      });
    } catch {}
  } catch (err) {
    try {
      logger.warn('meteora.activeId.populate_failed', {
        cat: 'meteora',
        ctx: { error: String((err as any)?.message || err) }
      });
    } catch {}
  }
}

/**
 * Derive bin array addresses from active bin ID
 * This is deterministic and requires no RPC calls
 */
function deriveBinArrays(
  poolPk: any,
  activeId: number,
  programId: any,
  DLMM: any
): { lower?: string; upper?: string } | undefined {
  try {
    // Get BN from DLMM SDK or globalThis (ES modules don't support require())
    const BN: any = (DLMM as any).BN || (globalThis as any).BN;
    
    if (!BN) {
      // BN not available - return undefined, bins will be derived via SDK fallback during tx build
      try {
        logger.debug('meteora.deriveBinArrays.no_bn', {
          cat: 'meteora',
          ctx: { 
            pool: typeof poolPk?.toBase58 === 'function' ? poolPk.toBase58().slice(0, 8) + '...' : String(poolPk).slice(0, 8) + '...',
            activeId,
            msg: 'BN not available in DLMM SDK, will use SDK fallback during transaction build'
          }
        });
      } catch {}
      return undefined;
    }
    
    const binIdToBinArrayIndex = (DLMM as any)?.binIdToBinArrayIndex;
    const deriveBinArray = (DLMM as any)?.deriveBinArray;
    
    if (!binIdToBinArrayIndex || !deriveBinArray) {
      return undefined;
    }
    
    // Convert activeId to bin array index
    const activeBn = new BN(activeId);
    const idx = binIdToBinArrayIndex(activeBn);
    const arrIdx = idx instanceof BN ? idx : new BN(String(idx));
    
    // Get current and adjacent bin array indexes
    // Most swaps need the active bin array and potentially one on either side
    const currentIdx = arrIdx;
    const lowerIdx = arrIdx.sub(new BN(1));
    const upperIdx = arrIdx.add(new BN(1));
    
    // Derive PDA addresses for bin arrays
    const result: { lower?: string; upper?: string } = {};
    
    try {
      const lowerArray = deriveBinArray(poolPk, lowerIdx, programId);
      const lowerPk = Array.isArray(lowerArray) ? lowerArray[0] : lowerArray;
      result.lower = typeof lowerPk?.toBase58 === 'function' ? lowerPk.toBase58() : String(lowerPk);
    } catch {}
    
    try {
      const upperArray = deriveBinArray(poolPk, upperIdx, programId);
      const upperPk = Array.isArray(upperArray) ? upperArray[0] : upperArray;
      result.upper = typeof upperPk?.toBase58 === 'function' ? upperPk.toBase58() : String(upperPk);
    } catch {}
    
    // Return undefined if we couldn't derive any addresses
    if (!result.lower && !result.upper) {
      return undefined;
    }
    
    return result;
  } catch (err) {
    try {
      const poolStr = typeof poolPk?.toBase58 === 'function' ? poolPk.toBase58().slice(0, 8) + '...' : String(poolPk).slice(0, 8) + '...';
      logger.warn('meteora.deriveBinArrays.failed', {
        cat: 'meteora',
        ctx: { pool: poolStr, activeId, error: String((err as any)?.message || err) }
      });
    } catch {}
    return undefined;
  }
}


