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
    
    // Extract vault addresses early for validation
    const reserveX = String((it as any)?.reserve_x || (it as any)?.reserveX || '');
    const reserveY = String((it as any)?.reserve_y || (it as any)?.reserveY || '');
    
    // VALIDATION: Ensure pool ID is not a vault address
    if (id === reserveX || id === reserveY) {
      try {
        logger.warn('meteora.pool_id_is_vault', {
          id: id.slice(0, 8) + '…',
          reserveX: reserveX.slice(0, 8) + '…',
          reserveY: reserveY.slice(0, 8) + '…',
          cat: 'meteora'
        });
      } catch {}
      continue; // Skip this pool
    }
    
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
      // reserveX and reserveY are already extracted earlier for validation
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

    const nativeAccountA = account_a;
    const nativeAccountB = account_b;

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
      was_swapped: wasSwapped,
      native_mint_a: mint_a,
      native_mint_b: mint_b,
      native_decimals_a: decA,
      native_decimals_b: decB,
      native_account_a: nativeAccountA,
      native_account_b: nativeAccountB,
      native_reserve_a_raw: amount_a_atomic?.toString(),
      native_reserve_b_raw: amount_b_atomic?.toString(),
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

export async function resolveMeteoraBitmapExtensions(poolIds: string[]): Promise<Map<string, string>> {
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
          
          if (!info) {
            // Account doesn't exist - use fallback
            result.set(entry.id, fallback);
            continue;
          }
          
          // Check if owner matches program ID
          let ownerMatches = false;
          try {
            if (info.owner) {
              // info.owner from getMultipleAccountsInfo is always a PublicKey
              // Handle both PublicKey instance and any object with equals method
              if (info.owner instanceof PublicKey) {
                ownerMatches = info.owner.equals(programId);
              } else {
                // Fallback for other owner types (shouldn't happen, but handle gracefully)
                const ownerStr = typeof info.owner === 'string' 
                  ? info.owner 
                  : (info.owner as any)?.toBase58?.() || String(info.owner);
                ownerMatches = ownerStr === programId.toBase58();
              }
            }
          } catch (ownerErr) {
            // Log owner check failure for debugging
            try {
              logger.debug('meteora.bitmap_ext.owner_check_failed', {
                pool: entry.id,
                pda: entry.pda.toBase58(),
                ownerType: typeof info.owner,
                error: String((ownerErr as any)?.message || ownerErr),
                cat: 'meteora'
              });
            } catch {}
          }
          
          if (ownerMatches) {
            result.set(entry.id, entry.pda.toBase58());
            try {
              logger.debug('meteora.bitmap_ext.resolved', {
                pool: entry.id,
                pda: entry.pda.toBase58(),
                cat: 'meteora'
              });
            } catch {}
          } else {
            result.set(entry.id, fallback);
            // Log why we're using fallback
            try {
              logger.debug('meteora.bitmap_ext.fallback', {
                pool: entry.id,
                pda: entry.pda.toBase58(),
                owner: info.owner ? (info.owner instanceof PublicKey ? info.owner.toBase58() : String(info.owner)) : 'null',
                expectedOwner: programId.toBase58(),
                cat: 'meteora'
              });
            } catch {}
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
export async function populateMeteoraActiveIds(pools: ClmmPool[]): Promise<void> {
  if (pools.length === 0) return;
  
  try {
    const { executionCache } = await import('../../execution/cache.js');
    const { getConnection } = await import('../../wallet/wallet.js');
    const { PublicKey } = await import('@solana/web3.js');
    const connection = getConnection();
    
    const startTime = Date.now();
    let cached = 0;
    let failed = 0;
    
    // Import Meteora SDK for program creation and decoding
    const { createProgram } = await import('@meteora-ag/dlmm');
    const programId = new PublicKey(METEORA_DLMM_PROGRAM_ID);
    
    // Create Anchor program instance for account decoding (same as WebSocket handler)
    const program = createProgram(connection, { programId });
    
    if (!program || !program.coder?.accounts) {
      throw new Error('Meteora program or coder not available');
    }
    
    // Import DLMM for bin array derivation
    const mod = await import('@meteora-ag/dlmm');
    const DLMM: any = (mod && (mod as any).default) ? (mod as any).default : (((mod as any).DLMM) || mod);
    
    // Batch fetch pool account data (100 at a time)
    const BATCH_SIZE = 100;
    for (let i = 0; i < pools.length; i += BATCH_SIZE) {
      const batch = pools.slice(i, i + BATCH_SIZE);
      
      try {
        const pks = batch.map(p => new PublicKey(p.id));
        const accounts = await connection.getMultipleAccountsInfo(pks);
        
        // Process each account and decode using Anchor
        for (let j = 0; j < accounts.length; j++) {
          const pool = batch[j];
          const acc = accounts[j];
          
          if (acc?.data) {
            try {
              // Decode account using Anchor coder (same method as WebSocket handler)
              const state = program.coder.accounts.decode('lbPair', acc.data);
              const activeId = Number(state?.activeId ?? state?.active_id);
              
              if (Number.isFinite(activeId)) {
                // Sanity check: activeId should be within reasonable bounds
                // Based on IDL constants: MIN_BIN_ID = -443636, MAX_BIN_ID = 443636
                if (activeId < -443636 || activeId > 443636) {
                  try {
                    logger.warn('meteora.activeId.out_of_bounds', {
                      pool: pool.id.slice(0, 8),
                      activeId,
                      cat: 'meteora'
                    });
                  } catch {}
                  failed++;
                  continue;
                }
                
                // Derive bin array addresses
                const binArrayAddresses = await deriveBinArrays(
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
                  const arrayCount = binArrayAddresses?.arrays?.length || 
                                   (binArrayAddresses ? Object.keys(binArrayAddresses).filter(k => binArrayAddresses[k as keyof typeof binArrayAddresses] && k !== 'arrays' && k !== 'range').length : 0);
                  logger.debug('meteora.activeId.cached', {
                    cat: 'meteora',
                    ctx: {
                      pool: pool.id.slice(0, 8) + '...',
                      activeId: activeId,
                      method: 'anchor_decode',
                      binArrayCount: arrayCount,
                      cachedRange: binArrayAddresses?.range ? `${binArrayAddresses.range.lower}..${binArrayAddresses.range.upper}` : 'legacy'
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
          avgMs: pools.length > 0 ? Math.round(durationMs / pools.length) : 0,
          method: 'anchor_decode'
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
 * Returns a range of bin arrays around the active bin for better cache coverage
 */
async function deriveBinArrays(
  poolPk: any,
  activeId: number,
  programId: any,
  DLMM: any
): Promise<{ 
  lower?: string;
  upper?: string;
  active?: string;
  arrays?: Array<{ index: number; address: string }>;
  range?: { lower: number; upper: number };
} | undefined> {
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
    const activeBinArrayIdx = arrIdx.toNumber();
    
    // Derive a range of bin arrays around the active bin
    // This ensures we have enough cached for most swaps (conservative range: ±5)
    const CACHE_RANGE = 5; // Cache 5 bin arrays on each side of active (11 total)
    const arrays: Array<{ index: number; address: string }> = [];
    
    // Allow negative indexes - they are valid in Meteora DLMM
    const startIdx = activeBinArrayIdx - CACHE_RANGE;
    const endIdx = activeBinArrayIdx + CACHE_RANGE;
    
    let activeAddress: string | undefined;
    let lowerAddress: string | undefined;
    let upperAddress: string | undefined;
    
    for (let i = startIdx; i <= endIdx; i++) {
      try {
        const binArrayPda = deriveBinArray(poolPk, new BN(i), programId);
        
        // Handle different return types from deriveBinArray
        let binArrayPk: any;
        if (Array.isArray(binArrayPda)) {
          binArrayPk = binArrayPda[0];
        } else {
          binArrayPk = binArrayPda;
        }
        
        // Ensure we have a PublicKey-like object with toBase58 method
        // deriveBinArray should return PublicKey, but handle edge cases
        if (!binArrayPk || typeof binArrayPk?.toBase58 !== 'function') {
          // If it's a string, convert to PublicKey
          const { PublicKey } = await import('@solana/web3.js');
          binArrayPk = new PublicKey(String(binArrayPk));
        }
        
        const address = typeof binArrayPk?.toBase58 === 'function' ? binArrayPk.toBase58() : String(binArrayPk);
        arrays.push({ index: i, address });
        
        // Track active, lower, and upper for backward compatibility
        if (i === activeBinArrayIdx) {
          activeAddress = address;
        }
        if (i === activeBinArrayIdx - 1) {
          lowerAddress = address;
        }
        if (i === activeBinArrayIdx + 1) {
          upperAddress = address;
        }
      } catch (e: any) {
        // Skip invalid derivations
        try { 
          logger.debug('meteora.deriveBinArrays.skip_index', { 
            cat: 'meteora', 
            ctx: { index: i, error: String(e?.message || e) } 
          }); 
        } catch {}
      }
    }
    
    if (arrays.length === 0) {
      return undefined;
    }
    
    // Return both new format (arrays) and backward-compatible format (lower/upper)
    return {
      lower: lowerAddress,
      upper: upperAddress,
      active: activeAddress,
      arrays,
      range: { lower: startIdx, upper: endIdx }
    };
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


