import { logger } from '../../utils/logger.js';
import { CONFIG } from '../../utils/config.js';
import { writeJson, joinPath } from '../../utils/fs.js';
import type { ClmmPool, PoolsPayload } from './types.js';
import { canonicalizePools } from './canonical.js';
import { resolveManyDecimals } from './decimals.js';
import { processPriceThroughPipeline } from './pricePipeline.js';
import { executeShyftGraphQL } from './shyftHelpers.js';
import { poolsMetrics } from '../pools.metrics.js';

export async function fetchMeteoraGraphQL(mints: string[]): Promise<any[]> {
  const CACHE_PATH = joinPath(CONFIG.cacheDir, 'meteora-graphql-raw.json');
  const retries = Number((CONFIG as any)?.meteora?.maxHttpRetries || 2);
  const backoffMs = Number((CONFIG as any)?.meteora?.httpBackoffMs || 500);
  const pageSize = Number((CONFIG as any)?.meteora?.pageSize || 1000);
  const maxPages = Number((CONFIG as any)?.meteora?.maxPages || 10);
  const pageDelayMs = Number((CONFIG as any)?.meteora?.pageDelayMs || 200);
  const detailBatchSize = Number((CONFIG as any)?.meteora?.detailBatchSize || 50);
  const detailDelayMs = Number((CONFIG as any)?.meteora?.detailBatchDelayMs ?? pageDelayMs);
  
  const poolsMap = new Map<string, any>();
  
  for (let idx = 0; idx < mints.length; idx++) {
    const mint = mints[idx];
    try {
      const pools = await fetchMeteoraPoolsForToken({
        mint,
        retries,
        backoffMs,
        pageSize,
        maxPages,
        pageDelayMs,
      });
      for (const pool of pools) {
        const key = pool.baseKey || pool.pubkey;
        if (!key) continue;
        poolsMap.set(key, pool);
      }
      
      logger.debug('meteora.graphql.mint.summary', { 
        mint: mint.slice(0, 8), 
        count: pools.length,
        total: poolsMap.size,
        cat: 'meteora' 
      });
    } catch (e: any) {
      logger.warn('meteora.graphql.mint.failed', { 
        mint: mint.slice(0, 8), 
        error: String(e?.message || e), 
        cat: 'meteora' 
      });
    }
    if (pageDelayMs > 0 && idx < mints.length - 1) {
      await new Promise(resolve => setTimeout(resolve, pageDelayMs));
    }
  }

  const ids = Array.from(poolsMap.keys());
  const detailedPools = await fetchMeteoraPoolsByAddress(ids, {
    retries,
    backoffMs,
    batchSize: detailBatchSize,
    delayMs: detailDelayMs,
  });

  const merged: any[] = [];
  for (const [id, summary] of poolsMap.entries()) {
    const detail = detailedPools.get(id);
    merged.push(detail ? { ...summary, ...detail } : summary);
  }
  for (const [id, detail] of detailedPools.entries()) {
    if (!poolsMap.has(id)) merged.push(detail);
  }
  
  try { await writeJson(CACHE_PATH, merged); } catch (e: any) {
    logger.warn('meteora.graphql.cache.write.failed', { 
      file: CACHE_PATH, 
      error: String(e?.message || e), 
      cat: 'meteora' 
    });
  }
  
  logger.info('meteora.graphql.complete', { count: merged.length, mints: mints.length, detail: detailedPools.size, cat: 'meteora' });
  return merged;
}

async function fetchMeteoraPoolsForToken(opts: {
  mint: string;
  retries: number;
  backoffMs: number;
  pageSize: number;
  maxPages: number;
  pageDelayMs: number;
}): Promise<any[]> {
  const allPools: any[] = [];
  let offset = 0;
  let page = 0;
  
  while (page < opts.maxPages) {
    const data = await executeShyftGraphQL<{ meteora_dlmm_LbPair: any[] }>({
      dex: 'meteora',
      query: `
        query MeteoraPoolsByMint($mint: String!, $limit: Int!, $offset: Int!) {
          meteora_dlmm_LbPair(
            where: {_or: [
              {tokenXMint: {_eq: $mint}}, 
              {tokenYMint: {_eq: $mint}}
            ]},
            limit: $limit,
            offset: $offset
          ) {
            baseKey
            pubkey
            tokenXMint
            tokenYMint
            reserveX
            reserveY
            binStep
            protocolFee
            activeId
            _updatedAt
          }
        }
      `,
      variables: {
        mint: opts.mint,
        limit: opts.pageSize,
        offset,
      },
      retries: opts.retries,
      backoffMs: opts.backoffMs,
      extraLogContext: { phase: 'summary', mint: opts.mint, page },
    });

    const pagePools = data?.meteora_dlmm_LbPair || [];
    if (pagePools.length === 0) break;

    allPools.push(...pagePools);
    logger.debug('meteora.graphql page', { 
      mint: opts.mint, 
      page, 
      count: pagePools.length, 
      total: allPools.length, 
      cat: 'meteora' 
    });

    if (pagePools.length < opts.pageSize) break;

    offset += opts.pageSize;
    page++;
    
    if (page < opts.maxPages && opts.pageDelayMs > 0) {
      await new Promise(r => setTimeout(r, opts.pageDelayMs));
    }
  }
  
  return allPools;
}

async function fetchMeteoraPoolsByAddress(
  poolIds: string[],
  opts: { retries: number; backoffMs: number; batchSize: number; delayMs: number }
): Promise<Map<string, any>> {
  const result = new Map<string, any>();
  if (!poolIds.length) return result;

  const chunks = chunkArray(poolIds, Math.max(1, opts.batchSize));
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    try {
        const data = await executeShyftGraphQL<{ meteora_dlmm_LbPair: any[] }>({
          dex: 'meteora',
          query: `
          query MeteoraPoolsByAddress($ids: [String!]) {
            meteora_dlmm_LbPair(
              where: {_or: [
                {baseKey: {_in: $ids}},
                {pubkey: {_in: $ids}}
              ]}
            ) {
              baseKey
              pubkey
              tokenXMint
              tokenYMint
              reserveX
              reserveY
              binStep
              protocolFee
              activeId
              oracle
              status
              _updatedAt
            }
          }
        `,
          variables: { ids: chunk },
          retries: opts.retries,
          backoffMs: opts.backoffMs,
          extraLogContext: { phase: 'detail', chunkIndex: i, chunkSize: chunk.length },
        });

      const pools = data?.meteora_dlmm_LbPair || [];
      for (const pool of pools) {
        const key = pool?.baseKey || pool?.pubkey;
        if (!key) continue;
        result.set(key, pool);
      }
      try {
        poolsMetrics.meteora.detailBatches += 1;
      } catch {}
      logger.debug('meteora.graphql.detail.chunk', {
        idx: i,
        fetched: pools.length,
        total: result.size,
        cat: 'meteora',
      });
    } catch (err) {
      logger.warn('meteora.graphql.detail.failed', {
        chunk: i,
        error: String((err as any)?.message || err),
        cat: 'meteora',
      });
      try { poolsMetrics.meteora.detailFailures += 1; } catch {}
    }

    if (opts.delayMs > 0 && i < chunks.length - 1) {
      await new Promise(r => setTimeout(r, opts.delayMs));
    }
  }

  return result;
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

export async function normalizeMeteoraGraphQL(raw: any[]): Promise<PoolsPayload> {
  const now = Date.now();
  const clmm: ClmmPool[] = [];
  
  const allMints = new Set<string>();
  for (const pool of raw) {
    if (pool.tokenXMint) allMints.add(pool.tokenXMint);
    if (pool.tokenYMint) allMints.add(pool.tokenYMint);
  }
  
  const decimalsMap = await resolveManyDecimals(Array.from(allMints), { 
    logger, 
    normalizeMode: true 
  });
  
  for (const pool of raw) {
    try {
      const id = pool.baseKey || pool.pubkey;
      if (!id) continue;
      
      const mint_a = pool.tokenXMint;
      const mint_b = pool.tokenYMint;
      
      if (!mint_a || !mint_b) continue;
      
      const decA = decimalsMap.get(mint_a) ?? 9;
      const decB = decimalsMap.get(mint_b) ?? 9;
      
      // Default fee: Meteora DLMM typically uses binStep as fee indicator
      // binStep of 10 = 0.1% = 10 bps, binStep of 25 = 0.25% = 25 bps
      let fee_bps = 25; // Default
      try {
        const binStep = Number(pool.binStep || 0);
        if (binStep > 0 && binStep <= 1000) {
          fee_bps = binStep; // binStep is already in bps
        }
      } catch {}
      
      // Calculate price from activeId and binStep
      let price_a_per_b = 0;
      try {
        const activeId = Number(pool.activeId || 0);
        const binStep = Number(pool.binStep || 0);
        
        if (activeId && binStep) {
          // Meteora DLMM price formula: price = (1 + binStep/10000)^activeId
          const binStepDecimal = binStep / 10000;
          const rawPrice = Math.pow(1 + binStepDecimal, activeId);
          
          // Adjust for decimal differences
          const decimalAdjustedPrice = rawPrice * Math.pow(10, decB - decA);
          
          const processed = processPriceThroughPipeline({
            mintA: mint_a,
            mintB: mint_b,
            rawPrice: decimalAdjustedPrice,
            decimalsA: decA,
            decimalsB: decB,
            poolId: id,
            dex: 'Meteora',
            poolType: 'clmm'
          });
          
          if (processed) {
            price_a_per_b = processed.priceForward;
          }
        }
      } catch {}
      
      clmm.push({
        id,
        dex: 'Meteora',
        mint_a,
        mint_b,
        fee_bps,
        price_a_per_b,
        updated_ms: now,
        decimals_a: decA,
        decimals_b: decB,
        pool_kind: 'clmm',
        bin_step: pool.binStep,
        active_id: pool.activeId,
        liquidity: pool.liquidity,
        reserve_x: pool.reserveX,
        reserve_y: pool.reserveY,
        _updatedAt: pool._updatedAt,
        _pipelineProcessed: true, // Mark as processed by price pipeline
        native_mint_a: mint_a,
        native_mint_b: mint_b,
        native_decimals_a: decA,
        native_decimals_b: decB,
        native_reserve_a_raw: pool.reserveX ? String(pool.reserveX) : undefined,
        native_reserve_b_raw: pool.reserveY ? String(pool.reserveY) : undefined,
      } as any);
    } catch (error: any) {
      logger.warn('meteora.graphql.normalize.pool.failed', { 
        error: String(error?.message || error), 
        cat: 'meteora' 
      });
    }
  }
  
  const clmmCanon = canonicalizePools(clmm);
  
  logger.info('meteora.graphql.normalized', { clmm: clmmCanon.length, cat: 'meteora' });
  
  return { amm: [], clmm: clmmCanon };
}

