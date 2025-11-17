import { logger } from '../../utils/logger.js';
import { CONFIG } from '../../utils/config.js';
import { writeJson, joinPath } from '../../utils/fs.js';
import type { ClmmPool, PoolsPayload } from './types.js';
import { canonicalizePools } from './canonical.js';
import { resolveManyDecimals } from './decimals.js';
import { processPriceThroughPipeline } from './pricePipeline.js';
import { executeShyftGraphQL } from './shyftHelpers.js';
import { poolsMetrics } from '../pools.metrics.js';

export async function fetchOrcaGraphQL(mints: string[]): Promise<any[]> {
  const CACHE_PATH = joinPath(CONFIG.cacheDir, 'orca-graphql-raw.json');
  const retries = Number((CONFIG as any)?.orca?.maxHttpRetries || 2);
  const backoffMs = Number((CONFIG as any)?.orca?.httpBackoffMs || 500);
  const pageSize = Number((CONFIG as any)?.orca?.pageSize || 1000);
  const maxPages = Number((CONFIG as any)?.orca?.maxPages || 10);
  const pageDelayMs = Number((CONFIG as any)?.orca?.pageDelayMs || 200);
  const detailBatchSize = Number((CONFIG as any)?.orca?.detailBatchSize || 50);
  const detailDelayMs = Number((CONFIG as any)?.orca?.detailBatchDelayMs || 0);

  const poolsMap = new Map<string, any>();

  for (const mint of mints) {
    try {
      const pools = await fetchOrcaPoolsForToken({
        mint,
        retries,
        backoffMs,
        pageSize,
        maxPages,
        pageDelayMs,
      });
      for (const pool of pools) {
        poolsMap.set(pool.pubkey, pool);
      }

      logger.debug('orca.graphql.mint.summary', {
        mint: mint.slice(0, 8),
        count: pools.length,
        total: poolsMap.size,
        cat: 'orca',
      });
    } catch (e: any) {
      logger.warn('orca.graphql.mint.failed', { 
        mint: mint.slice(0, 8), 
        error: String(e?.message || e), 
        cat: 'orca' 
      });
    }
  }

  const uniquePoolIds = Array.from(poolsMap.keys());
  const detailedPools = await fetchOrcaPoolsByAddress(uniquePoolIds, {
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
    logger.warn('orca.graphql.cache.write.failed', { 
      file: CACHE_PATH, 
      error: String(e?.message || e), 
      cat: 'orca' 
    });
  }
  
  logger.info('orca.graphql.complete', { count: merged.length, mints: mints.length, detail: detailedPools.size, cat: 'orca' });
  return merged;
}

async function fetchOrcaPoolsForToken(opts: {
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
    const data = await executeShyftGraphQL<{ ORCA_WHIRLPOOLS_whirlpool: any[] }>({
      dex: 'orca',
      query: `
        query OrcaPoolsByMint($mint: String!, $limit: Int!, $offset: Int!) {
          ORCA_WHIRLPOOLS_whirlpool(
            where: {_or: [
              {tokenMintA: {_eq: $mint}}, 
              {tokenMintB: {_eq: $mint}}
            ]},
            limit: $limit,
            offset: $offset
          ) {
            pubkey
            tokenMintA
            tokenMintB
            tokenVaultA
            tokenVaultB
            feeRate
            protocolFeeRate
            liquidity
            sqrtPrice
            tickCurrentIndex
            tickSpacing
            feeGrowthGlobalA
            feeGrowthGlobalB
            rewardLastUpdatedTimestamp
            protocolFeeOwedA
            protocolFeeOwedB
            whirlpoolsConfig
            whirlpoolBump
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

    const pagePools = data?.ORCA_WHIRLPOOLS_whirlpool || [];
    if (pagePools.length === 0) break;

    allPools.push(...pagePools);
    logger.debug('orca.graphql page', { 
      mint: opts.mint, 
      page, 
      count: pagePools.length, 
      total: allPools.length, 
      cat: 'orca' 
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

async function fetchOrcaPoolsByAddress(
  poolIds: string[],
  opts: { retries: number; backoffMs: number; batchSize: number; delayMs: number }
): Promise<Map<string, any>> {
  const result = new Map<string, any>();
  if (!poolIds.length) return result;

  const chunks = chunkArray(poolIds, Math.max(1, opts.batchSize));
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    try {
      const data = await executeShyftGraphQL<{ ORCA_WHIRLPOOLS_whirlpool: any[] }>({
        dex: 'orca',
        query: `
          query OrcaPoolsByAddress($ids: [String!]) {
            ORCA_WHIRLPOOLS_whirlpool(
              where: {pubkey: {_in: $ids}}
            ) {
              pubkey
              tokenMintA
              tokenMintB
              tokenVaultA
              tokenVaultB
              feeRate
              protocolFeeRate
              liquidity
              sqrtPrice
              tickCurrentIndex
              tickSpacing
              feeGrowthGlobalA
              feeGrowthGlobalB
              rewardLastUpdatedTimestamp
              protocolFeeOwedA
              protocolFeeOwedB
              whirlpoolsConfig
              whirlpoolBump
              rewardInfos
              oracle
              _updatedAt
            }
          }
        `,
        variables: { ids: chunk },
        retries: opts.retries,
        backoffMs: opts.backoffMs,
        extraLogContext: { phase: 'detail', chunkIndex: i, chunkSize: chunk.length },
      });

      const pools = data?.ORCA_WHIRLPOOLS_whirlpool || [];
      for (const pool of pools) {
        if (!pool?.pubkey) continue;
        result.set(pool.pubkey, pool);
      }
      try {
        poolsMetrics.orca.detailBatches += 1;
      } catch {}
      logger.debug('orca.graphql.detail.chunk', { idx: i, fetched: pools.length, total: result.size, cat: 'orca' });
    } catch (err) {
      logger.warn('orca.graphql.detail.failed', {
        chunk: i,
        error: String((err as any)?.message || err),
        cat: 'orca',
      });
      try { poolsMetrics.orca.detailFailures += 1; } catch {}
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

export async function normalizeOrcaGraphQL(raw: any[]): Promise<PoolsPayload> {
  const now = Date.now();
  const clmm: ClmmPool[] = [];
  
  const allMints = new Set<string>();
  for (const pool of raw) {
    if (pool.tokenMintA) allMints.add(pool.tokenMintA);
    if (pool.tokenMintB) allMints.add(pool.tokenMintB);
  }
  
  const decimalsMap = await resolveManyDecimals(Array.from(allMints), { 
    logger, 
    normalizeMode: true 
  });
  
  for (const pool of raw) {
    try {
      const id = pool.pubkey;
      if (!id) continue;
      
      const mint_a = pool.tokenMintA;
      const mint_b = pool.tokenMintB;
      
      if (!mint_a || !mint_b) continue;
      
      const decA = decimalsMap.get(mint_a) ?? 9;
      const decB = decimalsMap.get(mint_b) ?? 9;
      
      // Parse fee: feeRate is in hundredths of bps (100 = 1 bps)
      let fee_bps = 30;
      try {
        const feeRate = Number(pool.feeRate || 0);
        fee_bps = Math.round(feeRate / 100); // Convert from hundredths
      } catch {}
      
      // Calculate price from sqrtPrice
      let price_a_per_b = 0;
      try {
        const sqrtPriceStr = pool.sqrtPrice;
        if (sqrtPriceStr) {
          const { calculateClmmPrice } = await import('./priceFormulas.js');
          const rawPrice = calculateClmmPrice(sqrtPriceStr, decA, decB);
          
          if (rawPrice && rawPrice > 0) {
            const processed = processPriceThroughPipeline({
              mintA: mint_a,
              mintB: mint_b,
              rawPrice,
              decimalsA: decA,
              decimalsB: decB,
              poolId: id,
              dex: 'Orca',
              poolType: 'clmm'
            });
            
            if (processed) {
              price_a_per_b = processed.priceForward;
            }
          }
        }
      } catch {}
      
      clmm.push({
        id,
        dex: 'Orca',
        mint_a,
        mint_b,
        fee_bps,
        price_a_per_b,
        updated_ms: now,
        decimals_a: decA,
        decimals_b: decB,
        token_vault_a: pool.tokenVaultA,
        token_vault_b: pool.tokenVaultB,
        pool_kind: 'clmm',
        sqrt_price_x64: pool.sqrtPrice,
        liquidity: pool.liquidity,
        tick_current_index: pool.tickCurrentIndex,
        tick_spacing: pool.tickSpacing,
        whirlpools_config: pool.whirlpoolsConfig,
        _updatedAt: pool._updatedAt,
        _pipelineProcessed: true, // Mark as processed by price pipeline
        native_mint_a: mint_a,
        native_mint_b: mint_b,
        native_decimals_a: decA,
        native_decimals_b: decB,
        native_account_a: pool.tokenVaultA,
        native_account_b: pool.tokenVaultB,
        native_oracle: pool.oracle,
        native_reward_infos: pool.rewardInfos,
      } as any);
    } catch (error: any) {
      logger.warn('orca.graphql.normalize.pool.failed', { 
        error: String(error?.message || error), 
        cat: 'orca' 
      });
    }
  }
  
  const clmmCanon = canonicalizePools(clmm);
  
  logger.info('orca.graphql.normalized', { clmm: clmmCanon.length, cat: 'orca' });
  
  return { amm: [], clmm: clmmCanon };
}

