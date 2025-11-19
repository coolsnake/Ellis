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

export async function fetchOrcaGraphQL(mints: string[]): Promise<any[]> {
  const CACHE_PATH = joinPath(CONFIG.cacheDir, 'orca-graphql-raw.json');
  const retries = Number((CONFIG as any)?.orca?.maxHttpRetries || 2);
  const backoffMs = Number((CONFIG as any)?.orca?.httpBackoffMs || 500);
  const pageSize = Number((CONFIG as any)?.orca?.pageSize || 1000);
  const maxPages = Number((CONFIG as any)?.orca?.maxPages || 10);
  const pageDelayMs = Number((CONFIG as any)?.orca?.pageDelayMs || 200);
  const detailBatchSize = Number((CONFIG as any)?.orca?.detailBatchSize || 50);
  const detailDelayMs = Number((CONFIG as any)?.orca?.detailBatchDelayMs ?? pageDelayMs);

  const poolsMap = new Map<string, any>();

  for (let idx = 0; idx < mints.length; idx++) {
    const mint = mints[idx];
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
    if (pageDelayMs > 0 && idx < mints.length - 1) {
      await new Promise(resolve => setTimeout(resolve, pageDelayMs));
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
        { module: 'orca', method: 'getMultipleAccountsInfo' }
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
      logger.warn('orca.graphql.vaults.fetch_failed', { 
        error: String(e), 
        batchIndex: i 
      });
    }
  }
  
  return results;
}

export async function normalizeOrcaGraphQL(raw: any[]): Promise<PoolsPayload> {
  const now = Date.now();
  const clmm: ClmmPool[] = [];
  
  // Load Jupiter token prices for TVL calculation
  const jupPriceMap = await loadJupiterTokenMap();

  // Collect all vault addresses for batch RPC fetching
  const vaultAddresses = new Set<string>();
  for (const pool of raw) {
    if (pool.tokenVaultA) vaultAddresses.add(pool.tokenVaultA);
    if (pool.tokenVaultB) vaultAddresses.add(pool.tokenVaultB);
  }

  // Batch fetch vault balances
  // This runs in parallel with decimal resolution to save time
  const vaultBalancesPromise = fetchVaultBalances(Array.from(vaultAddresses));

  const allMints = new Set<string>();
  for (const pool of raw) {
    if (pool.tokenMintA) allMints.add(pool.tokenMintA);
    if (pool.tokenMintB) allMints.add(pool.tokenMintB);
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
      
      // Calculate amounts and TVL from vault balances
      let amount_a_whole: number | undefined;
      let amount_b_whole: number | undefined;
      let tvl_usd: number | undefined;
      
      try {
        const balA = pool.tokenVaultA ? vaultBalances.get(pool.tokenVaultA) : undefined;
        const balB = pool.tokenVaultB ? vaultBalances.get(pool.tokenVaultB) : undefined;
        
        if (balA !== undefined && balB !== undefined) {
          const wholeA = Number(balA) / Math.pow(10, decA);
          const wholeB = Number(balB) / Math.pow(10, decB);
          
          amount_a_whole = wholeA;
          amount_b_whole = wholeB;
          
          const priceA = jupPriceMap[mint_a]?.usdPrice;
          const priceB = jupPriceMap[mint_b]?.usdPrice;
          
          if (priceA && priceB) {
            tvl_usd = (wholeA * priceA) + (wholeB * priceB);
          } else if (priceA) {
            tvl_usd = wholeA * priceA * 2; // Assume balanced
          } else if (priceB) {
            tvl_usd = wholeB * priceB * 2; // Assume balanced
          }
        }
      } catch {}
      
      // Process price through pipeline with raw sqrtPriceX64 data
      let price_a_per_b = 0;
      let finalMintA = mint_a;
      let finalMintB = mint_b;
      let finalDecA = decA;
      let finalDecB = decB;
      let wasSwapped = false;
      
      try {
        const sqrtPriceStr = pool.sqrtPrice;
        if (sqrtPriceStr) {
          const { anyToBigInt } = await import('./precision.js');
          const sqrtPriceX64 = anyToBigInt(sqrtPriceStr);
          
          if (sqrtPriceX64) {
            const processed = processPriceThroughPipeline({
              mintA: mint_a,
              mintB: mint_b,
              decimalsA: decA,
              decimalsB: decB,
              poolId: id,
              dex: 'Orca',
              poolType: 'clmm',
              sqrtPriceX64,
              // Use actual vault balances if available
              reserveA: amount_a_whole ? BigInt(Math.floor(amount_a_whole * Math.pow(10, decA))) : undefined,
              reserveB: amount_b_whole ? BigInt(Math.floor(amount_b_whole * Math.pow(10, decB))) : undefined,
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
        }
      } catch {}
      
      // Swap account/vault fields if pipeline swapped mints
      const finalTokenVaultA = wasSwapped ? pool.tokenVaultB : pool.tokenVaultA;
      const finalTokenVaultB = wasSwapped ? pool.tokenVaultA : pool.tokenVaultB;
      const finalNativeAccountA = wasSwapped ? pool.tokenVaultB : pool.tokenVaultA;
      const finalNativeAccountB = wasSwapped ? pool.tokenVaultA : pool.tokenVaultB;
      
      const finalAmountA = wasSwapped ? amount_b_whole : amount_a_whole;
      const finalAmountB = wasSwapped ? amount_a_whole : amount_b_whole;
      
      clmm.push({
        id,
        dex: 'Orca',
        mint_a: finalMintA,
        mint_b: finalMintB,
        fee_bps,
        price_a_per_b,
        updated_ms: now,
        decimals_a: finalDecA,
        decimals_b: finalDecB,
        token_vault_a: finalTokenVaultA,
        token_vault_b: finalTokenVaultB,
        pool_kind: 'clmm',
        sqrt_price_x64: pool.sqrtPrice,
        liquidity: pool.liquidity,
        tick_current_index: pool.tickCurrentIndex,
        tick_spacing: pool.tickSpacing,
        whirlpools_config: pool.whirlpoolsConfig,
        _updatedAt: pool._updatedAt,
        was_swapped: wasSwapped,
        _pipelineProcessed: true, // Mark as processed by price pipeline
        native_mint_a: mint_a,
        native_mint_b: mint_b,
        native_decimals_a: decA,
        native_decimals_b: decB,
        native_account_a: finalNativeAccountA,
        native_account_b: finalNativeAccountB,
        native_oracle: pool.oracle,
        native_reward_infos: pool.rewardInfos,
        amount_a: finalAmountA,
        amount_b: finalAmountB,
        amount_a_whole: finalAmountA,
        amount_b_whole: finalAmountB,
        tvl_usd,
        liquidity_display: tvl_usd,
      } as any);
    } catch (error: any) {
      logger.warn('orca.graphql.normalize.pool.failed', { 
        error: String(error?.message || error), 
        cat: 'orca' 
      });
    }
  }
  
  logger.info('orca.graphql.normalized', { clmm: clmm.length, cat: 'orca' });
  
  return { amm: [], clmm: clmm };
}

