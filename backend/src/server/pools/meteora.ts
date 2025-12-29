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
import type { MeteoraPoolApiResponse, MeteoraApiListResponse } from './api-types.js';
import { isValidMeteoraPool } from './api-types.js';
import { logCatchError } from '../../utils/errorHandler.js';

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
            if (res?.status === 429) { try { logger.warn('meteora.http 429', { page, cat: 'meteora' }); emit('log', { level: 'warn', message: `arb:429 source=meteora page=${page}`, timestamp: new Date().toISOString(), context: { cat: 'arb' } }); } catch (e) { logCatchError('pools.meteora', e); }; httpLog429({ source: 'meteora', url, cid }); throw new Error('http 429'); }
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
        try { await writeJson(METEORA_RAW_PATH, out); } catch (e: any) { try { logger.warn('meteora.cache write failed', { file: METEORA_RAW_PATH, error: String(e?.message || e), cat: 'meteora' }); } catch (e) { logCatchError('pools.meteora', e); } }
        try { logger.info('meteora.http raw', { count: out.length, cat: 'meteora' }); } catch (e) { logCatchError('pools.meteora', e); }
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
    try { httpLogResponse({ source: 'meteora', url, cid: `http-${Date.now()}`, status: res.status, ms: 0, count: single.length }); } catch (e) { logCatchError('pools.meteora', e); }
    try { await writeJson(METEORA_RAW_PATH, single); } catch (e: any) { try { logger.warn('meteora.cache write failed', { file: METEORA_RAW_PATH, error: String(e?.message || e), cat: 'meteora' }); } catch (e) { logCatchError('pools.meteora', e); } }
    return single;
  } catch {
    return [];
  }
}

export async function normalizeMeteoraHttp(raw: MeteoraApiListResponse | MeteoraPoolApiResponse[] | unknown): Promise<PoolsPayload> {
  const now = Date.now();
  const clmm: ClmmPool[] = [];
  try {
    await import('../../execution/resolver/tokenMeta.js');
  } catch (e) { logCatchError('pools.meteora', e); }
  
  // Extract array from various response formats
  const rawArr: unknown[] = (() => {
    if (Array.isArray(raw)) return raw;
    const r = raw as { pairs?: unknown[]; data?: unknown[] };
    if (Array.isArray(r?.pairs)) return r.pairs;
    if (Array.isArray(r?.data)) return r.data;
    return [];
  })();
  
  // Filter to only valid Meteora pools
  const arr = rawArr.filter(isValidMeteoraPool);
  
  // Extract all unique mints for batch decimal resolution
  const allMints = new Set<string>();
  for (const it of arr) {
    const pool = it as MeteoraPoolApiResponse;
    const tokenA = pool.tokenA || pool.tokenX || {};
    const tokenB = pool.tokenB || pool.tokenY || {};
    const mint_a = String(pool.mint_x || tokenA?.mint || pool.tokenXMint || '');
    const mint_b = String(pool.mint_y || tokenB?.mint || pool.tokenYMint || '');
    if (mint_a) allMints.add(mint_a);
    if (mint_b) allMints.add(mint_b);
  }
  
  // Batch resolve decimals using centralized resolver with RPC-first validation
  const decimalsMap = await resolveManyDecimals(Array.from(allMints), { 
    logger, 
    batchSize: 100,
    normalizeMode: true // RPC validation priority during normalization
  });
  
  // Pass pool info with activeId for smarter bitmap extension resolution
  // This allows skipping pools that don't need extensions (activeId within internal bitmap range)
  const bitmapExtensionMap = await resolveMeteoraBitmapExtensions(
    arr
      .map(it => {
        const pool = it as MeteoraPoolApiResponse;
        const id = String(pool.address || pool.id || pool.poolAddress || '');
        const activeId = Number(pool.active_id ?? pool.activeId ?? 0);
        return { id, activeId: Number.isFinite(activeId) ? activeId : undefined };
      })
      .filter(p => typeof p.id === 'string' && p.id.length > 0)
  );
  
  for (const it of arr) {
    const pool = it as MeteoraPoolApiResponse;
    const id = String(pool.address || pool.id || pool.poolAddress || '');
    const tokenA = pool.tokenA || pool.tokenX || {};
    const tokenB = pool.tokenB || pool.tokenY || {};
    
    // Extract vault addresses early for validation
    const reserveX = String(pool.reserve_x || pool.reserveX || '');
    const reserveY = String(pool.reserve_y || pool.reserveY || '');
    
    // VALIDATION: Ensure pool ID is not a vault address
    if (id === reserveX || id === reserveY) {
      try {
        logger.warn('meteora.pool_id_is_vault', {
          id: id.slice(0, 8) + '…',
          reserveX: reserveX.slice(0, 8) + '…',
          reserveY: reserveY.slice(0, 8) + '…',
          cat: 'meteora'
        });
      } catch (e) { logCatchError('pools.meteora', e); }
      continue; // Skip this pool
    }
    
    let mint_a = String(pool.mint_x || tokenA?.mint || pool.tokenXMint || '');
    let mint_b = String(pool.mint_y || tokenB?.mint || pool.tokenYMint || '');
    if (!id || !mint_a || !mint_b) continue;
    
    // Get decimals from centralized resolver with API fallback
    const apiDecA = Number((tokenA?.decimals ?? pool.decimalsA));
    const apiDecB = Number((tokenB?.decimals ?? pool.decimalsB));
    
    let decA = decimalsMap.get(mint_a) ?? apiDecA;
    let decB = decimalsMap.get(mint_b) ?? apiDecB;

    if (!Number.isFinite(decA)) decA = 6;
    if (!Number.isFinite(decB)) decB = 6;

    // Clamp to reasonable integer bounds
    decA = Math.min(12, Math.max(0, Math.round(Number(decA))));
    decB = Math.min(12, Math.max(0, Math.round(Number(decB))));
    
    const amtAraw = (pool.reserve_x_amount ?? pool.tokenBalanceA ?? pool.tokenAAmount ?? pool.amountA ?? pool.baseAmount ?? 0);
    const amtBraw = (pool.reserve_y_amount ?? pool.tokenBalanceB ?? pool.tokenBAmount ?? pool.amountB ?? pool.quoteAmount ?? 0);
    const amount_a_atomic = looksLikeAtomicAmount(amtAraw) ? BigInt(String(amtAraw)) : undefined;
    const amount_b_atomic = looksLikeAtomicAmount(amtBraw) ? BigInt(String(amtBraw)) : undefined;

    const tvlUsdcRaw = pool.tvlUsdc ?? pool.tvlUsd ?? pool.liquidity;
    const tvl_usd = Number.isFinite(Number(tvlUsdcRaw)) && Number(tvlUsdcRaw) > 0 ? Number(tvlUsdcRaw) : undefined;

    const processedPrice = processPriceThroughPipeline({
      mintA: mint_a,
      mintB: mint_b,
      decimalsA: decA,
      decimalsB: decB,
      poolId: id,
      dex: 'Meteora',
      poolType: 'clmm',
      activeId: Number(pool.active_id ?? pool.activeId),
      binStep: Number(pool.bin_step ?? pool.binStep),
      tokenXMint: String(pool.mint_x || pool.tokenXMint || tokenA?.mint || ''),
      tokenYMint: String(pool.mint_y || pool.tokenYMint || tokenB?.mint || ''),
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
      const tokenXMint = String(pool.mint_x || pool.tokenXMint || tokenA?.mint || '');
      
      if (reserveX && reserveY) {
        if (tokenXMint === mint_a) {
          account_a = reserveX;
          account_b = reserveY;
        } else {
          account_a = reserveY;
          account_b = reserveX;
        }
      }
    } catch (e) { logCatchError('pools.meteora', e); }

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
      fee_bps: Math.round(Number(pool.feeRate || 0) * 100),
      sqrt_price_x64: 0, // Let graph builder derive if needed
      liquidity: 0,
      tick_spacing: Number(pool.bin_step || pool.binStep || 0),
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
  } catch (e) { logCatchError('pools.meteora', e); }
  
  // OPTIMIZATION: Pre-cache active bin IDs to eliminate RPC calls during transaction building
  await populateMeteoraActiveIds(clmm);
  
  return { amm: [], clmm: clmm };
}

/**
 * Pool info for bitmap extension resolution
 * When activeId is provided, we can skip pools that don't need bitmap extensions
 */
export interface PoolBitmapInfo {
  id: string;
  activeId?: number;
}

/**
 * Resolve bitmap extension PDAs for Meteora DLMM pools using SDK derivation.
 * 
 * Uses the official Meteora SDK's `deriveBinArrayBitmapExtension` function
 * which uses the correct PDA seeds: ["bitmap", lbPair.toBytes()]
 * 
 * When activeId is provided, uses `isOverflowDefaultBinArrayBitmap` to skip
 * pools that don't need bitmap extensions (their activeId is within the
 * internal bitmap range of ±512 bin array indices).
 * 
 * @param pools - Array of pool IDs (strings) or pool info objects with activeId
 * @returns Map of pool ID -> bitmap extension PDA (or program ID if not needed)
 */
export async function resolveMeteoraBitmapExtensions(
  pools: (string | PoolBitmapInfo)[]
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const fallback = METEORA_DLMM_PROGRAM_ID;
  
  // Normalize input to PoolBitmapInfo format
  const poolInfos: PoolBitmapInfo[] = pools
    .map(p => typeof p === 'string' ? { id: p } : p)
    .filter(p => typeof p.id === 'string' && p.id.length > 0);
  
  // Dedupe by pool ID
  const uniqueMap = new Map<string, PoolBitmapInfo>();
  for (const p of poolInfos) {
    if (!uniqueMap.has(p.id)) {
      uniqueMap.set(p.id, p);
    }
  }
  const unique = Array.from(uniqueMap.values());
  
  if (unique.length === 0) return result;

  // Log sample of pool IDs being checked (first 3) for debugging
  try {
    logger.info('meteora.bitmap_ext.checking', {
      total: unique.length,
      sample: unique.slice(0, 3).map(p => p.id.slice(0, 8) + '…'),
      withActiveId: unique.filter(p => p.activeId !== undefined).length,
      cat: 'meteora'
    });
  } catch (e) { logCatchError('pools.meteora', e); }

  try {
    const { PublicKey } = await import('@solana/web3.js');
    const { getConnection } = await import('../../wallet/wallet.js');
    const { withRpcLimit } = await import('../../utils/rpcLimiter.js');
    const connection = getConnection();
    const programId = new PublicKey(METEORA_DLMM_PROGRAM_ID);
    
    // Try to import SDK function for correct derivation
    let deriveBinArrayBitmapExtension: ((lbPair: any, programId: any) => [any, number]) | null = null;
    
    try {
      const dlmmSdk = await import('@meteora-ag/dlmm');
      deriveBinArrayBitmapExtension = dlmmSdk.deriveBinArrayBitmapExtension;
      
      logger.debug('meteora.bitmap_ext.sdk_loaded', {
        hasDerive: !!deriveBinArrayBitmapExtension,
        cat: 'meteora'
      });
    } catch (sdkErr) {
      logger.warn('meteora.bitmap_ext.sdk_fallback', {
        error: String((sdkErr as any)?.message || sdkErr),
        reason: 'Using manual derivation with correct "bitmap" seed',
        cat: 'meteora'
      });
    }

    const derived: { id: string; pda: any }[] = [];
    
    for (const poolInfo of unique) {
      try {
        const poolPk = new PublicKey(poolInfo.id);
        
        // Derive bitmap extension PDA using SDK or manual method
        // NOTE: We MUST always derive and check if the account exists on-chain,
        // because a pool may have liquidity outside the default bitmap range
        // even if the current activeId is within range. The on-chain account
        // existence is the source of truth, not the current price position.
        let bitmapExtPda: any;
        
        if (deriveBinArrayBitmapExtension) {
          // Use SDK's derivation function (correct seeds: ["bitmap", lbPair.toBytes()])
          const [pda] = deriveBinArrayBitmapExtension(poolPk, programId);
          bitmapExtPda = pda;
        } else {
          // Manual fallback with CORRECT seed ("bitmap", not "BitmapExtension")
          const [pda] = PublicKey.findProgramAddressSync(
            [Buffer.from('bitmap'), poolPk.toBuffer()],
            programId
          );
          bitmapExtPda = pda;
        }
        
        derived.push({ id: poolInfo.id, pda: bitmapExtPda });
      } catch (err) {
        result.set(poolInfo.id, fallback);
        try {
          logger.info('meteora.bitmap_ext.derive_failed', {
            pool: poolInfo.id,
            error: String((err as any)?.message || err),
            cat: 'meteora'
          });
        } catch (e) { logCatchError('pools.meteora', e); }
      }
    }

    // Log sample of derived PDAs for debugging
    try {
      logger.info('meteora.bitmap_ext.derived_sample', {
        total: derived.length,
        sample: derived.slice(0, 3).map(entry => ({
          poolId: entry.id.slice(0, 8) + '…',
          pda: entry.pda.toBase58().slice(0, 8) + '…',
          fullPda: entry.pda.toBase58()
        })),
        cat: 'meteora'
      });
    } catch (e) { logCatchError('pools.meteora', e); }

    const BATCH_SIZE = 100;
    let totalChecked = 0;
    let totalExist = 0;
    let totalMissing = 0;
    let totalOwnerMismatch = 0;
    
    for (let i = 0; i < derived.length; i += BATCH_SIZE) {
      const batch = derived.slice(i, i + BATCH_SIZE);
      const pubkeys = batch.map(entry => entry.pda);
      
      // Log what we're checking in this batch
      try {
        logger.debug('meteora.bitmap_ext.batch_checking', {
          batchIndex: Math.floor(i / BATCH_SIZE),
          batchSize: batch.length,
          samplePda: pubkeys[0]?.toBase58().slice(0, 8) + '…',
          cat: 'meteora'
        });
      } catch (e) { logCatchError('pools.meteora', e); }
      
      try {
        const weight = Math.max(1, Math.ceil(batch.length / 100));
        const infos = await withRpcLimit(
          () => connection.getMultipleAccountsInfo(pubkeys),
          weight,
          { module: 'pools', method: 'meteora.bitmapExtBatch' }
        );

        // Log RPC response details
        try {
          const nonNullCount = infos?.filter(i => i !== null).length || 0;
          logger.debug('meteora.bitmap_ext.rpc_response', {
            batchIndex: Math.floor(i / BATCH_SIZE),
            requested: batch.length,
            returned: infos?.length || 0,
            nonNull: nonNullCount,
            cat: 'meteora'
          });
        } catch (e) { logCatchError('pools.meteora', e); }

        for (let j = 0; j < batch.length; j++) {
          const entry = batch[j];
          const info = infos?.[j];
          totalChecked++;
          
          if (!info) {
            // Account doesn't exist - use fallback
            totalMissing++;
            result.set(entry.id, fallback);
            continue;
          }
          
          totalExist++;
          
          // Check if owner matches program ID
          // Note: If account exists at this PDA, it should be owned by the program
          // But we verify to be safe
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
              logger.info('meteora.bitmap_ext.owner_check_failed', {
                pool: entry.id,
                pda: entry.pda.toBase58(),
                ownerType: typeof info.owner,
                error: String((ownerErr as any)?.message || ownerErr),
                cat: 'meteora'
              });
            } catch (e) { logCatchError('pools.meteora', e); }
          }
          
          if (ownerMatches) {
            result.set(entry.id, entry.pda.toBase58());
            try {
              logger.debug('meteora.bitmap_ext.resolved', {
                pool: entry.id,
                pda: entry.pda.toBase58(),
                cat: 'meteora'
              });
            } catch (e) { logCatchError('pools.meteora', e); }
          } else {
            totalOwnerMismatch++;
            result.set(entry.id, fallback);
            // Log owner mismatch at INFO level so we can see it
            try {
              logger.info('meteora.bitmap_ext.owner_mismatch', {
                pool: entry.id,
                pda: entry.pda.toBase58(),
                owner: info.owner ? (info.owner instanceof PublicKey ? info.owner.toBase58() : String(info.owner)) : 'null',
                expectedOwner: programId.toBase58(),
                cat: 'meteora'
              });
            } catch (e) { logCatchError('pools.meteora', e); }
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
        } catch (e) { logCatchError('pools.meteora', e); }
      }
    }

    try {
      logger.info('meteora.bitmap_ext.batch_complete', {
        total: unique.length,
        checked: totalChecked,
        exist: totalExist,
        missing: totalMissing,
        ownerMismatch: totalOwnerMismatch,
        resolved: Array.from(result.values()).filter(v => v !== fallback).length,
        fallback: Array.from(result.values()).filter(v => v === fallback).length,
        cat: 'meteora'
      });
    } catch (e) { logCatchError('pools.meteora', e); }
  } catch (err) {
    try {
      logger.warn('meteora.bitmap_ext.batch_unavailable', {
        error: String((err as any)?.message || err),
        cat: 'meteora'
      });
    } catch (e) { logCatchError('pools.meteora', e); }
    for (const p of unique) {
      if (!result.has(p.id)) result.set(p.id, fallback);
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
                  } catch (e) { logCatchError('pools.meteora', e); }
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
                
                // Validate bin arrays exist on-chain
                let validatedBinArrays: typeof binArrayAddresses = undefined;
                
                if (binArrayAddresses?.arrays && binArrayAddresses.arrays.length > 0) {
                  try {
                    const pdaKeys = binArrayAddresses.arrays.map(a => new PublicKey(a.address));
                    const binArrayInfos = await connection.getMultipleAccountsInfo(pdaKeys);
                    
                    const validArrays: Array<{ index: number; address: string }> = [];
                    let validLower: string | undefined;
                    let validUpper: string | undefined;
                    let validActive: string | undefined;
                    
                    const BIN_ARRAY_SIZE = 70;
                    const activeBinArrayIdx = Math.floor(activeId / BIN_ARRAY_SIZE);
                    
                    for (let k = 0; k < binArrayAddresses.arrays.length; k++) {
                      const info = binArrayInfos[k];
                      const arr = binArrayAddresses.arrays[k];
                      
                      if (info && info.owner.equals(programId) && info.data.length > 0) {
                        validArrays.push(arr);
                        
                        // Track special positions
                        if (arr.index === activeBinArrayIdx) {
                          validActive = arr.address;
                        }
                        if (arr.index === activeBinArrayIdx - 1) {
                          validLower = arr.address;
                        }
                        if (arr.index === activeBinArrayIdx + 1) {
                          validUpper = arr.address;
                        }
                      }
                    }
                    
                    if (validArrays.length > 0) {
                      validatedBinArrays = {
                        lower: validLower,
                        upper: validUpper,
                        active: validActive,
                        arrays: validArrays,
                        range: binArrayAddresses.range
                      };
                    }
                  } catch (e) {
                    logCatchError('pools.meteora.binArrayValidation', e);
                  }
                }
                
                // Cache active bin ID AND validated bin array addresses
                // Include binStep for boundary crossing detection in cache
                executionCache.setHot(pool.id, {
                  activeId: activeId,
                  binStep: (pool as any).bin_step,
                  binArrays: validatedBinArrays,
                });
                
                // CRITICAL: Also populate static cache for local quotes to work
                // Local quote needs mint_a, mint_b to determine swap direction
                const existingStatic = executionCache.getStatic(pool.id) || {} as any;
                executionCache.setStatic(pool.id, {
                  ...existingStatic,
                  programId: existingStatic.programId || programId.toBase58(),
                  dex: existingStatic.dex || 'meteora',
                  pool_kind: existingStatic.pool_kind || 'clmm',
                  mint_a: (pool as any).mint_a ?? existingStatic.mint_a,
                  mint_b: (pool as any).mint_b ?? existingStatic.mint_b,
                  decimals_a: (pool as any).decimals_a ?? existingStatic.decimals_a,
                  decimals_b: (pool as any).decimals_b ?? existingStatic.decimals_b,
                  native_mint_a: (pool as any).native_mint_a ?? existingStatic.native_mint_a,
                  native_mint_b: (pool as any).native_mint_b ?? existingStatic.native_mint_b,
                  binStep: (pool as any).bin_step ?? existingStatic.binStep,
                  // Use validated bin arrays
                  ...(validatedBinArrays?.lower ? { bin_array_lower: validatedBinArrays.lower } : {}),
                  ...(validatedBinArrays?.upper ? { bin_array_upper: validatedBinArrays.upper } : {}),
                });
                
                cached++;
                
                try {
                  const derivedCount = binArrayAddresses?.arrays?.length || 0;
                  const validatedCount = validatedBinArrays?.arrays?.length || 0;
                  logger.debug('meteora.activeId.cached', {
                    cat: 'meteora',
                    ctx: {
                      pool: pool.id.slice(0, 8) + '...',
                      activeId: activeId,
                      method: 'anchor_decode',
                      binArraysDerived: derivedCount,
                      binArraysValidated: validatedCount,
                      hasActive: !!validatedBinArrays?.active,
                      cachedRange: validatedBinArrays?.range ? `${validatedBinArrays.range.lower}..${validatedBinArrays.range.upper}` : 'none'
                    }
                  });
                } catch (e) { logCatchError('pools.meteora', e); }
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
              } catch (e) { logCatchError('pools.meteora', e); }
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
        } catch (e) { logCatchError('pools.meteora', e); }
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
    } catch (e) { logCatchError('pools.meteora', e); }
  } catch (err) {
    try {
      logger.warn('meteora.activeId.populate_failed', {
        cat: 'meteora',
        ctx: { error: String((err as any)?.message || err) }
      });
    } catch (e) { logCatchError('pools.meteora', e); }
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
    // Get BN from DLMM SDK, globalThis, or bn.js fallback.
    // NOTE: DLMM.BN can be missing depending on module/bundler interop.
    let BN: any = (DLMM as any).BN || (globalThis as any).BN;
    if (!BN) {
      try {
        const bnjs = await import('bn.js').catch(() => null as any);
        BN = (bnjs && (bnjs as any).default) ? (bnjs as any).default : bnjs;
      } catch {}
    }
    if (!BN) {
      try {
        logger.warn('meteora.deriveBinArrays.no_bn', {
          cat: 'meteora',
          ctx: {
            pool: typeof poolPk?.toBase58 === 'function' ? poolPk.toBase58().slice(0, 8) + '...' : String(poolPk).slice(0, 8) + '...',
            activeId,
            msg: 'BN not available; cannot pre-derive bin arrays during refresh'
          }
        });
      } catch (e) { logCatchError('pools.meteora', e); }
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
        } catch (e) { logCatchError('pools.meteora', e); }
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
    } catch (e) { logCatchError('pools.meteora', e); }
    return undefined;
  }
}


