import { logger } from '../../utils/logger.js';
import { CONFIG } from '../../utils/config.js';
import { writeJson, joinPath } from '../../utils/fs.js';
import type { ClmmPool, PoolsPayload } from './types.js';
import { resolveManyDecimals } from './decimals.js';
import { processPriceThroughPipeline } from './pricePipeline.js';
import { executeShyftGraphQL } from './shyftHelpers.js';
import { poolsMetrics } from '../pools.metrics.js';
import { loadJupiterTokenMap } from '../../utils/tokens.js';
import { Connection, PublicKey } from '@solana/web3.js';
import { withRpcLimit } from '../../utils/rpcLimiter.js';

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
        const key = pool.pubkey || pool.baseKey;
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
        const key = pool?.pubkey || pool?.baseKey;
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

// Helper to batch fetch vault balances via RPC
async function fetchVaultBalances(addresses: string[]): Promise<Map<string, bigint>> {
  const results = new Map<string, bigint>();
  if (addresses.length === 0) return results;

  const connection = new Connection(CONFIG.rpcUrl || 'https://api.mainnet-beta.solana.com');
  const BATCH_SIZE = 100;
  
  for (let i = 0; i < addresses.length; i += BATCH_SIZE) {
    const batch = addresses.slice(i, i + BATCH_SIZE);
    const pubkeys = batch.map(a => new PublicKey(a));
    
    try {
      // Fetch with RPC limit protection
      const accounts = await withRpcLimit(
        () => connection.getMultipleAccountsInfo(pubkeys),
        Math.max(1, Math.ceil(batch.length / 10)),
        { module: 'meteora', method: 'getMultipleAccountsInfo' }
      );
      
      accounts.forEach((acc, idx) => {
        if (acc && acc.data.length >= 64) { // SPL Token Account min length
          // Amount is u64 at offset 64
          try {
            const buf = Buffer.from(acc.data);
            const amount = buf.readBigUInt64LE(64);
            results.set(batch[idx], amount);
          } catch {}
        }
      });
    } catch (e) {
      logger.warn('meteora.graphql.vaults.fetch_failed', { 
        error: String(e), 
        batchIndex: i 
      });
    }
  }
  
  return results;
}

export async function normalizeMeteoraGraphQL(raw: any[]): Promise<PoolsPayload> {
  const now = Date.now();
  const clmm: ClmmPool[] = [];
  
  // Load Jupiter token prices for TVL calculation
  const jupPriceMap = await loadJupiterTokenMap();
  
  // Collect all vault addresses for batch RPC fetching
  const vaultAddresses = new Set<string>();
  for (const pool of raw) {
    if (pool.reserveX) vaultAddresses.add(pool.reserveX);
    if (pool.reserveY) vaultAddresses.add(pool.reserveY);
  }

  // Batch fetch vault balances
  // This runs in parallel with decimal resolution to save time
  const vaultBalancesPromise = fetchVaultBalances(Array.from(vaultAddresses));

  const allMints = new Set<string>();
  for (const pool of raw) {
    if (pool.tokenXMint) allMints.add(pool.tokenXMint);
    if (pool.tokenYMint) allMints.add(pool.tokenYMint);
  }
  
  const decimalsMapPromise = resolveManyDecimals(Array.from(allMints), { 
    logger, 
    normalizeMode: true 
  });

  const [vaultBalances, decimalsMap] = await Promise.all([
    vaultBalancesPromise, 
    decimalsMapPromise
  ]);
  
  for (const pool of raw) {
    try {
      const id = pool.pubkey || pool.baseKey;
      if (!id) continue;
      
      const mint_a = pool.tokenXMint;
      const mint_b = pool.tokenYMint;
      
      if (!mint_a || !mint_b) continue;
      
      // Use Jupiter token map as fallback before defaulting to 9
      const decA = decimalsMap.get(mint_a) ?? jupPriceMap[mint_a]?.decimals ?? 9;
      const decB = decimalsMap.get(mint_b) ?? jupPriceMap[mint_b]?.decimals ?? 9;
      
      // Log when using Jupiter fallback to track decimal resolution sources
      if (!decimalsMap.has(mint_a) && jupPriceMap[mint_a]?.decimals) {
        logger.debug('meteora.decimals.jupiter_fallback', {
          mint: mint_a.slice(0, 8),
          decimals: decA,
          pool: id,
          cat: 'meteora'
        });
      }
      if (!decimalsMap.has(mint_b) && jupPriceMap[mint_b]?.decimals) {
        logger.debug('meteora.decimals.jupiter_fallback', {
          mint: mint_b.slice(0, 8),
          decimals: decB,
          pool: id,
          cat: 'meteora'
        });
      }
      
      // Default fee: Meteora DLMM typically uses binStep as fee indicator
      // binStep of 10 = 0.1% = 10 bps, binStep of 25 = 0.25% = 25 bps
      let fee_bps = 25; // Default
      try {
        const binStep = Number(pool.binStep || 0);
        if (binStep > 0 && binStep <= 1000) {
          fee_bps = binStep; // binStep is already in bps
        }
      } catch {}
      
      // Process price through pipeline with raw Meteora DLMM data
      let price_a_per_b = 0;
      let finalMintA = mint_a;
      let finalMintB = mint_b;
      let finalDecA = decA;
      let finalDecB = decB;
      let wasSwapped = false;
      
      let tvl_usd: number | undefined;
      let amount_a_whole: number | undefined;
      let amount_b_whole: number | undefined;

      // Extract variables outside try block to ensure they are available in scope
      const activeId = Number(pool.activeId || 0);
      const binStep = Number(pool.binStep || 0);
      const tokenXMint = String(pool.tokenXMint || mint_a);
      const tokenYMint = String(pool.tokenYMint || mint_b);
      
      try {
        // Calculate TVL
        try {
          // Meteora returns reserveX/reserveY as vault addresses
          const vaultX = pool.reserveX;
          const vaultY = pool.reserveY;
          
          const balX = vaultX ? vaultBalances.get(vaultX) : undefined;
          const balY = vaultY ? vaultBalances.get(vaultY) : undefined;
          
          if (balX !== undefined && balY !== undefined) {
            const priceA = jupPriceMap[mint_a]?.usdPrice;
            const priceB = jupPriceMap[mint_b]?.usdPrice;
            
            const amountA = Number(balX) / Math.pow(10, decA);
            const amountB = Number(balY) / Math.pow(10, decB);
            
            amount_a_whole = amountA;
            amount_b_whole = amountB;
            
            if (priceA && priceB) {
              tvl_usd = (amountA * priceA) + (amountB * priceB);
            } else if (priceA) {
              tvl_usd = amountA * priceA * 2;
            } else if (priceB) {
              tvl_usd = amountB * priceB * 2;
            }
          }
        } catch {}
        
        if (activeId != null && binStep != null && tokenXMint && tokenYMint) {
          const processed = processPriceThroughPipeline({
            mintA: mint_a,
            mintB: mint_b,
            decimalsA: decA,
            decimalsB: decB,
            poolId: id,
            dex: 'Meteora',
            poolType: 'clmm',
            activeId,
            binStep,
            tokenXMint,
            tokenYMint,
          });
          
          if (processed) {
            price_a_per_b = processed.priceForward;
            finalMintA = processed.mintA;
            finalMintB = processed.mintB;
            finalDecA = processed.decimalsA;
            finalDecB = processed.decimalsB;
            wasSwapped = processed.wasSwapped;
          }
        }
      } catch {}
      
      // Swap amounts if pipeline swapped mints
      const finalAmountA = wasSwapped ? amount_b_whole : amount_a_whole;
      const finalAmountB = wasSwapped ? amount_a_whole : amount_b_whole;

      clmm.push({
        id,
        dex: 'Meteora',
        mint_a: finalMintA,
        mint_b: finalMintB,
        fee_bps,
        price_a_per_b,
        tvl_usd,
        updated_ms: now,
        decimals_a: finalDecA,
        decimals_b: finalDecB,
        pool_kind: 'clmm',
        bin_step: pool.binStep,
        active_id: pool.activeId,
        liquidity: pool.liquidity,
        reserve_x: pool.reserveX,
        reserve_y: pool.reserveY,
        _updatedAt: pool._updatedAt,
        was_swapped: wasSwapped,
        _pipelineProcessed: true, // Mark as processed by price pipeline
        native_mint_a: mint_a,
        native_mint_b: mint_b,
        native_decimals_a: decA,
        native_decimals_b: decB,
        native_reserve_a_raw: pool.reserveX ? String(pool.reserveX) : undefined,
        native_reserve_b_raw: pool.reserveY ? String(pool.reserveY) : undefined,
        amount_a_whole: finalAmountA,
        amount_b_whole: finalAmountB,
        liquidity_display: tvl_usd,
      } as any);
    } catch (error: any) {
      logger.warn('meteora.graphql.normalize.pool.failed', { 
        error: String(error?.message || error), 
        cat: 'meteora' 
      });
    }
  }
  
  logger.info('meteora.graphql.normalized', { clmm: clmm.length, cat: 'meteora' });
  
  return { amm: [], clmm: clmm };
}

