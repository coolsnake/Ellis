import { logger } from '../../utils/logger.js';
import { CONFIG } from '../../utils/config.js';
import { writeJson, joinPath } from '../../utils/fs.js';
import type { AmmPool, ClmmPool, PoolsPayload } from './types.js';
import { canonicalizePools } from './canonical.js';
import { resolveManyDecimals } from './decimals.js';
import { processPriceThroughPipeline } from './pricePipeline.js';
import { priceFromReserves } from './priceFormulas.js';
import { executeShyftGraphQL } from './shyftHelpers.js';
import { poolsMetrics } from '../pools.metrics.js';

export async function fetchRaydiumGraphQL(mints: string[]): Promise<any[]> {
  const CACHE_PATH = joinPath(CONFIG.cacheDir, 'raydium-graphql-raw.json');
  const retries = Number((CONFIG as any)?.raydium?.maxHttpRetries || 2);
  const backoffMs = Number((CONFIG as any)?.raydium?.httpBackoffMs || 500);
  const pageSize = Number((CONFIG as any)?.raydium?.pageSize || 1000);
  const maxPages = Number((CONFIG as any)?.raydium?.maxPages || 10);
  const pageDelayMs = Number((CONFIG as any)?.raydium?.pageDelayMs || 200);
  const detailBatchSize = Number((CONFIG as any)?.raydium?.detailBatchSize || 50);
  const detailDelayMs = Number((CONFIG as any)?.raydium?.detailBatchDelayMs ?? pageDelayMs);

  const poolsMap = new Map<string, any>();

  for (const mint of mints) {
    try {
      const pools = await fetchRaydiumPoolsForToken({
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

      logger.debug('raydium.graphql.mint.summary', {
        mint: mint.slice(0, 8),
        count: pools.length,
        total: poolsMap.size,
        cat: 'raydium',
      });
    } catch (e: any) {
      logger.warn('raydium.graphql.mint.failed', {
        mint: mint.slice(0, 8),
        error: String(e?.message || e),
        cat: 'raydium',
      });
    }
  }

  const uniquePoolIds = Array.from(poolsMap.keys());
  const detailedPools = await fetchRaydiumPoolsByAddress(uniquePoolIds, {
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

  // Include any pools that we fetched by address but did not see during mint scans (edge-case)
  for (const [id, detail] of detailedPools.entries()) {
    if (!poolsMap.has(id)) merged.push(detail);
  }

  try {
    await writeJson(CACHE_PATH, merged);
  } catch (e: any) {
    logger.warn('raydium.graphql.cache.write.failed', {
      file: CACHE_PATH,
      error: String(e?.message || e),
      cat: 'raydium',
    });
  }

  logger.info('raydium.graphql.complete', {
    count: merged.length,
    mints: mints.length,
    detail: detailedPools.size,
    cat: 'raydium',
  });
  return merged;
}

async function fetchRaydiumPoolsForToken(opts: {
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
    const data = await executeShyftGraphQL<{ Raydium_LiquidityPoolv4: any[] }>({
      dex: 'raydium',
      query: `
        query RaydiumPoolsByMint($mint: String!, $limit: Int!, $offset: Int!) {
          Raydium_LiquidityPoolv4(
            where: {_or: [
              {baseMint: {_eq: $mint}},
              {quoteMint: {_eq: $mint}}
            ]},
            limit: $limit,
            offset: $offset
          ) {
            pubkey
            baseMint
            quoteMint
            baseDecimal
            quoteDecimal
            lpMint
            poolOpenTime
            swapBaseInAmount
            swapQuoteInAmount
            swapBaseOutAmount
            swapQuoteOutAmount
            swapFeeNumerator
            swapFeeDenominator
            state
            status
            _updatedAt
          }
        }
      `,
      variables: {
        mint: opts.mint,
        limit: opts.pageSize,
        offset,
      },
      extraLogContext: { phase: 'summary', mint: opts.mint, page },
      retries: opts.retries,
      backoffMs: opts.backoffMs,
    });

    const pagePools = data?.Raydium_LiquidityPoolv4 || [];
    if (pagePools.length === 0) break;

    allPools.push(...pagePools);
    logger.debug('raydium.graphql page', { 
      mint: opts.mint, 
      page, 
      count: pagePools.length, 
      total: allPools.length, 
      cat: 'raydium' 
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

async function fetchRaydiumPoolsByAddress(
  poolIds: string[],
  opts: { retries: number; backoffMs: number; batchSize: number; delayMs: number }
): Promise<Map<string, any>> {
  const result = new Map<string, any>();
  if (!poolIds.length) return result;

  const chunks = chunkArray(poolIds, Math.max(1, opts.batchSize));
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    try {
      const data = await executeShyftGraphQL<{ Raydium_LiquidityPoolv4: any[] }>({
        dex: 'raydium',
        query: `
          query RaydiumPoolsByAddress($ids: [String!]) {
            Raydium_LiquidityPoolv4(
              where: {pubkey: {_in: $ids}}
            ) {
              pubkey
              baseMint
              quoteMint
              baseDecimal
              quoteDecimal
              lpMint
              lpReserve
              lpVault
              baseVault
              quoteVault
              baseNeedTakePnl
              quoteNeedTakePnl
              baseTotalPnl
              quoteTotalPnl
              marketId
              marketProgramId
              openOrders
              targetOrders
              owner
              withdrawQueue
              amountWaveRatio
              depth
              nonce
              pnlDenominator
              pnlNumerator
              poolOpenTime
              punishCoinAmount
              punishPcAmount
              quoteLotSize
              baseLotSize
              minPriceMultiplier
              maxPriceMultiplier
              minSeparateDenominator
              minSeparateNumerator
              minSize
              maxOrder
              orderbookToInitTime
              resetFlag
              state
              status
              swapBaseInAmount
              swapQuoteInAmount
              swapBaseOutAmount
              swapQuoteOutAmount
              swapFeeNumerator
              swapFeeDenominator
              swapBase2QuoteFee
              swapQuote2BaseFee
              tradeFeeNumerator
              tradeFeeDenominator
              volMaxCutRatio
              systemDecimalValue
              amountWaveRatio
              _updatedAt
            }
          }
        `,
        variables: { ids: chunk },
        retries: opts.retries,
        backoffMs: opts.backoffMs,
        extraLogContext: { phase: 'detail', chunkIndex: i, chunkSize: chunk.length },
      });

      const pools = data?.Raydium_LiquidityPoolv4 || [];
      for (const pool of pools) {
        if (!pool?.pubkey) continue;
        result.set(pool.pubkey, pool);
      }
      try {
        poolsMetrics.raydium.detailBatches += 1;
        poolsMetrics.raydium.apiBatches += 1;
        const count = poolsMetrics.raydium.detailBatches;
        const prevAvg = poolsMetrics.raydium.apiBatchSizeAvg || 0;
        poolsMetrics.raydium.apiBatchSizeAvg = count > 0 ? ((prevAvg * (count - 1)) + chunk.length) / count : chunk.length;
      } catch {}
      logger.debug('raydium.graphql.detail.chunk', {
        idx: i,
        chunk: chunk.length,
        total: result.size,
        cat: 'raydium',
      });
    } catch (err) {
      logger.warn('raydium.graphql.detail.failed', {
        chunk: i,
        error: String((err as any)?.message || err),
        cat: 'raydium',
      });
      try { poolsMetrics.raydium.detailFailures += 1; } catch {}
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

export async function normalizeRaydiumGraphQL(raw: any[]): Promise<PoolsPayload> {
  const now = Date.now();
  const amm: AmmPool[] = [];
  const clmm: ClmmPool[] = [];
  
  // Extract all mints for batch decimal resolution
  const allMints = new Set<string>();
  for (const pool of raw) {
    if (pool.baseMint) allMints.add(pool.baseMint);
    if (pool.quoteMint) allMints.add(pool.quoteMint);
  }
  
  const decimalsMap = await resolveManyDecimals(Array.from(allMints), { 
    logger, 
    normalizeMode: true 
  });
  
  for (const pool of raw) {
    try {
      const id = pool.pubkey;
      if (!id) continue;
      
      const mint_a = pool.baseMint;
      const mint_b = pool.quoteMint;
      
      if (!mint_a || !mint_b) continue;
      
      // Get decimals with fallback
      const decA = pool.baseDecimal ?? decimalsMap.get(mint_a) ?? 9;
      const decB = pool.quoteDecimal ?? decimalsMap.get(mint_b) ?? 9;
      
      // Parse fee: swapFeeNumerator / swapFeeDenominator * 10000 = bps
      let fee_bps = 25; // Default
      try {
        const feeNum = Number(pool.swapFeeNumerator || pool.tradeFeeNumerator || 0);
        const feeDenom = Number(pool.swapFeeDenominator || pool.tradeFeeDenominator || 10000);
        if (feeDenom > 0) {
          fee_bps = Math.round((feeNum / feeDenom) * 10000);
        }
      } catch {}
      
      // Determine if this is AMM or CLMM
      // Raydium CLMM pools have different structure - check for CLMM-specific fields
      const isClmm = pool.tickSpacing !== undefined || pool.sqrtPrice !== undefined;
      
      if (isClmm) {
        // Handle CLMM pool (future enhancement)
        // For now, skip CLMM from GraphQL since we don't have full support
        continue;
      } else {
        // AMM V4 pool
        // Try to derive price from swap volume ratios
        let price_a_per_b = 0;
        
        try {
          // Method 1: Use swap volumes if available
          const swapBaseIn = BigInt(pool.swapBaseInAmount || 0);
          const swapQuoteIn = BigInt(pool.swapQuoteInAmount || 0);
          
          if (swapBaseIn > 0n && swapQuoteIn > 0n) {
            // Price ≈ quoteIn / baseIn (adjusted for decimals)
            const rawPrice = priceFromReserves(swapQuoteIn, swapBaseIn, decB, decA);
            
            if (rawPrice && rawPrice > 0) {
              const processed = processPriceThroughPipeline({
                mintA: mint_a,
                mintB: mint_b,
                rawPrice: 1 / rawPrice, // Invert since we calculated quote/base
                decimalsA: decA,
                decimalsB: decB,
                poolId: id,
                dex: 'Raydium',
                poolType: 'amm'
              });
              
              if (processed) {
                price_a_per_b = processed.priceForward;
              }
            }
          }
        } catch {}
        
        amm.push({
          id,
          dex: 'Raydium',
          mint_a,
          mint_b,
          fee_bps,
          price_a_per_b,
          updated_ms: now,
          decimals_a: decA,
          decimals_b: decB,
          account_a: pool.baseVault,
          account_b: pool.quoteVault,
          pool_kind: 'amm',
          lp_mint: pool.lpMint,
          market_id: pool.marketId,
          market_program_id: pool.marketProgramId,
          open_orders: pool.openOrders,
          target_orders: pool.targetOrders,
          authority: pool.owner,
          pool_open_time: pool.poolOpenTime,
          status: pool.status,
          _updatedAt: pool._updatedAt,
          _pipelineProcessed: true, // Mark as processed by price pipeline
        native_mint_a: mint_a,
        native_mint_b: mint_b,
        native_decimals_a: decA,
        native_decimals_b: decB,
        native_account_a: pool.baseVault,
        native_account_b: pool.quoteVault,
        native_open_orders: pool.openOrders,
        native_target_orders: pool.targetOrders,
        native_base_need_take_pnl: pool.baseNeedTakePnl,
        native_quote_need_take_pnl: pool.quoteNeedTakePnl,
        native_lp_vault: pool.lpVault,
        native_withdraw_queue: pool.withdrawQueue,
        } as any);
      }
    } catch (error: any) {
      logger.warn('raydium.graphql.normalize.pool.failed', { 
        error: String(error?.message || error), 
        cat: 'raydium' 
      });
    }
  }
  
  // Apply canonicalization
  const ammCanon = canonicalizePools(amm);
  const clmmCanon = canonicalizePools(clmm);
  
  logger.info('raydium.graphql.normalized', { 
    amm: ammCanon.length, 
    clmm: clmmCanon.length, 
    cat: 'raydium' 
  });
  
  return { amm: ammCanon, clmm: clmmCanon };
}

