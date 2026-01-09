/**
 * Raydium CPMM (Constant Product Market Maker) GraphQL fetcher and normalizer.
 * 
 * CPMM pools use a constant product formula (x*y=k) like AMM V4 but with
 * a different account structure and program ID.
 * 
 * Program ID: CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C
 */

import { logger } from '../../utils/logger.js';
import { CONFIG } from '../../utils/config.js';
import { writeJson, joinPath } from '../../utils/fs.js';
import type { CpmmPool, SummaryPool } from './types.js';
import { resolveManyDecimals } from './decimals.js';
import { processPriceThroughPipeline } from './pricePipeline.js';
import { executeShyftGraphQL } from './shyftHelpers.js';
import { loadJupiterTokenMap } from '../../utils/tokens.js';
import { PublicKey } from '@solana/web3.js';
import { logCatchError } from '../../utils/errorHandler.js';
import { withRpcLimit } from '../../utils/rpcLimiter.js';
import { getConnection } from '../../wallet/wallet.js';
import type { RaydiumCpmmPoolApiResponse } from './api-types.js';
import { isValidRaydiumCpmmPool } from './api-types.js';

// CPMM Program ID
const RAYDIUM_CPMM_PROGRAM = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';

// Token Program IDs
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

/**
 * Chunk array into smaller pieces
 */
function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/**
 * Fetch CPMM pool summaries only (no detail fetch, no RPC enrichment).
 * Used for early filtering before expensive detail+RPC phases.
 */
export async function fetchRaydiumCpmmSummaryOnly(mints: string[]): Promise<SummaryPool[]> {
  const retries = Number((CONFIG as any)?.raydiumCpmm?.maxHttpRetries || 2);
  const backoffMs = Number((CONFIG as any)?.raydiumCpmm?.httpBackoffMs || 500);
  const pageSize = Number((CONFIG as any)?.raydiumCpmm?.graphqlPageSize || 1000);
  const maxPages = Number((CONFIG as any)?.raydiumCpmm?.graphqlMaxPages || 50);
  const pageDelayMs = Number((CONFIG as any)?.raydiumCpmm?.pageDelayMs || 200);
  const mintBatchSize = Number((CONFIG as any)?.raydiumCpmm?.mintBatchSize || 10);

  const poolsMap = new Map<string, SummaryPool>();

  // Separate anchor tokens from regular tokens to avoid pagination crowding
  const { getAnchorSet } = await import('../universe.js');
  const anchors = getAnchorSet();
  const anchorMints: string[] = [];
  const regularMints: string[] = [];
  for (const mint of mints) {
    if (anchors.has(mint)) {
      anchorMints.push(mint);
    } else {
      regularMints.push(mint);
    }
  }

  logger.info('raydium.cpmm.graphql.summary_only.start', {
    totalMints: mints.length,
    anchorMints: anchorMints.length,
    regularMints: regularMints.length,
    cat: 'raydium-cpmm',
  });

  // Add initial delay
  const initialDelayMultiplier = Number((CONFIG as any)?.raydiumCpmm?.initialDelayMultiplier || 10);
  const initialDelayMs = pageDelayMs * initialDelayMultiplier;
  if (initialDelayMs > 0 && mints.length > 0) {
    await new Promise(resolve => setTimeout(resolve, initialDelayMs));
  }

  // PHASE 1: Query anchor tokens INDIVIDUALLY
  for (let i = 0; i < anchorMints.length; i++) {
    const anchorMint = anchorMints[i];
    try {
      const pools = await fetchRaydiumCpmmPoolsForMintBatch({
        mints: [anchorMint],
        retries,
        backoffMs,
        pageSize,
        maxPages,
        pageDelayMs,
      });
      for (const pool of pools) {
        if (!pool?.pubkey) continue;
        poolsMap.set(pool.pubkey, {
          pubkey: pool.pubkey,
          mint_a: pool.token0Mint,
          mint_b: pool.token1Mint,
          dex: 'raydium-cpmm',
          type: 'cpmm',
          _updatedAt: pool._updatedAt,
        });
      }

      logger.info('raydium.cpmm.graphql.summary_only.anchor.complete', {
        mint: anchorMint.slice(0, 8) + '…',
        count: pools.length,
        total: poolsMap.size,
        cat: 'raydium-cpmm',
      });
    } catch (e: any) {
      logger.warn('raydium.cpmm.graphql.summary_only.anchor.failed', {
        mint: anchorMint.slice(0, 8) + '…',
        error: String(e?.message || e),
        cat: 'raydium-cpmm',
      });
    }
    if (pageDelayMs > 0 && i < anchorMints.length - 1) {
      await new Promise(resolve => setTimeout(resolve, pageDelayMs));
    }
  }

  // PHASE 2: Query regular tokens in batches
  const mintBatches = chunkArray(regularMints, mintBatchSize);

  for (let batchIdx = 0; batchIdx < mintBatches.length; batchIdx++) {
    const mintBatch = mintBatches[batchIdx];
    try {
      const pools = await fetchRaydiumCpmmPoolsForMintBatch({
        mints: mintBatch,
        retries,
        backoffMs,
        pageSize,
        maxPages,
        pageDelayMs,
      });
      for (const pool of pools) {
        if (!pool?.pubkey) continue;
        poolsMap.set(pool.pubkey, {
          pubkey: pool.pubkey,
          mint_a: pool.token0Mint,
          mint_b: pool.token1Mint,
          dex: 'raydium-cpmm',
          type: 'cpmm',
          _updatedAt: pool._updatedAt,
        });
      }

      logger.debug('raydium.cpmm.graphql.summary_only.batch', {
        batchIdx,
        batchSize: mintBatch.length,
        count: pools.length,
        total: poolsMap.size,
        cat: 'raydium-cpmm',
      });
    } catch (e: any) {
      logger.warn('raydium.cpmm.graphql.summary_only.batch.failed', {
        batchIdx,
        batchSize: mintBatch.length,
        error: String(e?.message || e),
        cat: 'raydium-cpmm',
      });
    }
    if (pageDelayMs > 0 && batchIdx < mintBatches.length - 1) {
      await new Promise(resolve => setTimeout(resolve, pageDelayMs));
    }
  }

  const result = Array.from(poolsMap.values());
  logger.info('raydium.cpmm.graphql.summary_only.complete', {
    count: result.length,
    mints: mints.length,
    cat: 'raydium-cpmm',
  });
  return result;
}

/**
 * Fetch Raydium CPMM pools for a batch of mints using GraphQL _in clause
 */
async function fetchRaydiumCpmmPoolsForMintBatch(opts: {
  mints: string[];
  retries: number;
  backoffMs: number;
  pageSize: number;
  maxPages: number;
  pageDelayMs: number;
}): Promise<RaydiumCpmmPoolApiResponse[]> {
  const allPools: RaydiumCpmmPoolApiResponse[] = [];
  let offset = 0;
  let page = 0;

  while (page < opts.maxPages) {
    // Add delay BEFORE each request (except the first page)
    if (opts.pageDelayMs > 0 && page > 0) {
      await new Promise(r => setTimeout(r, opts.pageDelayMs));
    }
    
    const data = await executeShyftGraphQL<{ Raydium_CPMM_PoolState: RaydiumCpmmPoolApiResponse[] }>({
      dex: 'raydium-cpmm',
      query: `
        query RaydiumCpmmPoolsByMints($mints: [String!]!, $limit: Int!, $offset: Int!) {
          Raydium_CPMM_PoolState(
            where: {_or: [
              {token0Mint: {_in: $mints}},
              {token1Mint: {_in: $mints}}
            ]},
            limit: $limit,
            offset: $offset
          ) {
            pubkey
            token0Mint
            token1Mint
            token0Vault
            token1Vault
            token0Program
            token1Program
            lpMint
            ammConfig
            observationKey
            mintDecimals0
            mintDecimals1
            status
            openTime
            _updatedAt
          }
        }
      `,
      variables: {
        mints: opts.mints,
        limit: opts.pageSize,
        offset,
      },
      extraLogContext: { phase: 'cpmm-batch-summary', mintCount: opts.mints.length, page },
      retries: opts.retries,
      backoffMs: opts.backoffMs,
    });

    const pagePools = data?.Raydium_CPMM_PoolState || [];
    if (pagePools.length === 0) break;

    allPools.push(...pagePools);
    logger.debug('raydium.cpmm.graphql.batch.page', { 
      mintCount: opts.mints.length, 
      page, 
      count: pagePools.length, 
      total: allPools.length, 
      cat: 'raydium-cpmm' 
    });

    if (pagePools.length < opts.pageSize) break;

    offset += opts.pageSize;
    page++;
  }
  
  return allPools;
}

/**
 * Fetch Raydium CPMM pool details by pool addresses.
 * Exported for use in early-filter flow where only survivor pools need detail fetching.
 */
export async function fetchRaydiumCpmmPoolsByAddress(
  poolIds: string[],
  opts: { retries: number; backoffMs: number; batchSize: number; delayMs: number }
): Promise<Map<string, RaydiumCpmmPoolApiResponse>> {
  const result = new Map<string, RaydiumCpmmPoolApiResponse>();
  if (!poolIds.length) return result;

  const chunks = chunkArray(poolIds, Math.max(1, opts.batchSize));
  for (let i = 0; i < chunks.length; i++) {
    // Add delay BEFORE each request (except the first batch)
    if (opts.delayMs > 0 && i > 0) {
      await new Promise(r => setTimeout(r, opts.delayMs));
    }
    
    const chunk = chunks[i];
    try {
      const data = await executeShyftGraphQL<{ Raydium_CPMM_PoolState: RaydiumCpmmPoolApiResponse[] }>({
        dex: 'raydium-cpmm',
        query: `
          query RaydiumCpmmPoolsByAddress($ids: [String!]) {
            Raydium_CPMM_PoolState(
              where: {pubkey: {_in: $ids}}
            ) {
              pubkey
              token0Mint
              token1Mint
              token0Vault
              token1Vault
              token0Program
              token1Program
              lpMint
              lpSupply
              ammConfig
              observationKey
              creator
              status
              mintDecimals0
              mintDecimals1
              bump
              openTime
              _updatedAt
            }
          }
        `,
        variables: { ids: chunk },
        retries: opts.retries,
        backoffMs: opts.backoffMs,
        extraLogContext: { phase: 'cpmm-detail', chunkIndex: i, chunkSize: chunk.length },
      });

      const pools = data?.Raydium_CPMM_PoolState || [];
      for (const pool of pools) {
        if (!pool?.pubkey) continue;
        result.set(pool.pubkey, pool);
      }
      logger.debug('raydium.cpmm.graphql.detail.chunk', {
        idx: i,
        chunk: chunk.length,
        total: result.size,
        cat: 'raydium-cpmm',
      });
    } catch (err) {
      logger.warn('raydium.cpmm.graphql.detail.failed', {
        chunk: i,
        error: String((err as any)?.message || err),
        cat: 'raydium-cpmm',
      });
    }
  }

  return result;
}

/**
 * Full CPMM pool fetch with pagination and detail enrichment
 */
export async function fetchRaydiumCpmmGraphQL(mints: string[]): Promise<RaydiumCpmmPoolApiResponse[]> {
  const CACHE_PATH = joinPath(CONFIG.cacheDir, 'raydium-cpmm-graphql-raw.json');
  const retries = Number((CONFIG as any)?.raydiumCpmm?.maxHttpRetries || 2);
  const backoffMs = Number((CONFIG as any)?.raydiumCpmm?.httpBackoffMs || 500);
  const pageSize = Number((CONFIG as any)?.raydiumCpmm?.pageSize || 1000);
  const maxPages = Number((CONFIG as any)?.raydiumCpmm?.maxPages || 50);
  const pageDelayMs = Number((CONFIG as any)?.raydiumCpmm?.pageDelayMs || 200);
  const detailBatchSize = Number((CONFIG as any)?.raydiumCpmm?.detailBatchSize || 50);
  const detailDelayMs = Number((CONFIG as any)?.raydiumCpmm?.detailBatchDelayMs ?? pageDelayMs);
  const mintBatchSize = Number((CONFIG as any)?.raydiumCpmm?.mintBatchSize || 10);

  const poolsMap = new Map<string, RaydiumCpmmPoolApiResponse>();

  // Separate anchor tokens from regular tokens
  const { getAnchorSet } = await import('../universe.js');
  const anchors = getAnchorSet();
  const anchorMints: string[] = [];
  const regularMints: string[] = [];
  for (const mint of mints) {
    if (anchors.has(mint)) {
      anchorMints.push(mint);
    } else {
      regularMints.push(mint);
    }
  }

  logger.info('raydium.cpmm.graphql.fetch.start', {
    totalMints: mints.length,
    anchorMints: anchorMints.length,
    regularMints: regularMints.length,
    cat: 'raydium-cpmm',
  });

  // Initial delay
  const initialDelayMultiplier = Number((CONFIG as any)?.raydiumCpmm?.initialDelayMultiplier || 10);
  const initialDelayMs = pageDelayMs * initialDelayMultiplier;
  if (initialDelayMs > 0 && mints.length > 0) {
    await new Promise(resolve => setTimeout(resolve, initialDelayMs));
  }

  // PHASE 1: Query anchor tokens INDIVIDUALLY
  for (let i = 0; i < anchorMints.length; i++) {
    const anchorMint = anchorMints[i];
    try {
      const pools = await fetchRaydiumCpmmPoolsForMintBatch({
        mints: [anchorMint],
        retries,
        backoffMs,
        pageSize,
        maxPages,
        pageDelayMs,
      });
      for (const pool of pools) {
        poolsMap.set(pool.pubkey, pool);
      }

      logger.info('raydium.cpmm.graphql.anchor.complete', {
        mint: anchorMint.slice(0, 8) + '…',
        count: pools.length,
        total: poolsMap.size,
        cat: 'raydium-cpmm',
      });
    } catch (e: any) {
      logger.warn('raydium.cpmm.graphql.anchor.failed', { 
        mint: anchorMint.slice(0, 8) + '…',
        error: String(e?.message || e), 
        cat: 'raydium-cpmm' 
      });
    }
    if (pageDelayMs > 0 && i < anchorMints.length - 1) {
      await new Promise(resolve => setTimeout(resolve, pageDelayMs));
    }
  }

  // PHASE 2: Query regular tokens in batches
  const mintBatches = chunkArray(regularMints, mintBatchSize);

  for (let batchIdx = 0; batchIdx < mintBatches.length; batchIdx++) {
    const mintBatch = mintBatches[batchIdx];
    try {
      const pools = await fetchRaydiumCpmmPoolsForMintBatch({
        mints: mintBatch,
        retries,
        backoffMs,
        pageSize,
        maxPages,
        pageDelayMs,
      });
      for (const pool of pools) {
        poolsMap.set(pool.pubkey, pool);
      }

      logger.debug('raydium.cpmm.graphql.batch.summary', {
        batchIdx,
        batchSize: mintBatch.length,
        count: pools.length,
        total: poolsMap.size,
        cat: 'raydium-cpmm',
      });
    } catch (e: any) {
      logger.warn('raydium.cpmm.graphql.batch.failed', {
        batchIdx,
        batchSize: mintBatch.length,
        error: String(e?.message || e),
        cat: 'raydium-cpmm',
      });
    }
    if (pageDelayMs > 0 && batchIdx < mintBatches.length - 1) {
      await new Promise(resolve => setTimeout(resolve, pageDelayMs));
    }
  }

  const uniquePoolIds = Array.from(poolsMap.keys());
  
  // Add delay BEFORE starting detail phase
  if (pageDelayMs > 0 && uniquePoolIds.length > 0) {
    await new Promise(resolve => setTimeout(resolve, pageDelayMs));
  }
  
  const detailedPools = await fetchRaydiumCpmmPoolsByAddress(uniquePoolIds, {
    retries,
    backoffMs,
    batchSize: detailBatchSize,
    delayMs: detailDelayMs,
  });

  const merged: RaydiumCpmmPoolApiResponse[] = [];
  for (const [id, summary] of poolsMap.entries()) {
    const detail = detailedPools.get(id);
    merged.push(detail ? { ...summary, ...detail } : summary);
  }

  // Include any pools from detail fetch not in summary
  for (const [id, detail] of detailedPools.entries()) {
    if (!poolsMap.has(id)) merged.push(detail);
  }

  try {
    await writeJson(CACHE_PATH, merged);
  } catch (e: any) {
    logger.warn('raydium.cpmm.graphql.cache.write.failed', {
      file: CACHE_PATH,
      error: String(e?.message || e),
      cat: 'raydium-cpmm',
    });
  }

  logger.info('raydium.cpmm.graphql.complete', {
    count: merged.length,
    mints: mints.length,
    batches: mintBatches.length,
    detail: detailedPools.size,
    cat: 'raydium-cpmm',
  });
  return merged;
}

/**
 * Helper to batch fetch vault balances via RPC
 */
async function fetchVaultBalances(addresses: string[]): Promise<Map<string, bigint>> {
  const results = new Map<string, bigint>();
  if (addresses.length === 0) return results;

  const connection = getConnection();
  const BATCH_SIZE = 100;
  
  for (let i = 0; i < addresses.length; i += BATCH_SIZE) {
    const batch = addresses.slice(i, i + BATCH_SIZE);
    const pubkeys = batch.map(a => new PublicKey(a));
    
    try {
      const accounts = await withRpcLimit(
        () => connection.getMultipleAccountsInfo(pubkeys),
        Math.max(1, Math.ceil(batch.length / 10)),
        { module: 'raydium-cpmm', method: 'getMultipleAccountsInfo' }
      );
      
      accounts.forEach((acc, idx) => {
        if (acc && acc.data.length >= 72) { // SPL Token Account min length
          try {
            const buf = Buffer.from(acc.data);
            const amount = buf.readBigUInt64LE(64);
            results.set(batch[idx], amount);
          } catch (e) { logCatchError('pools.raydiumCpmmGraphQL', e); }
        }
      });
    } catch (e) {
      logger.warn('raydium.cpmm.graphql.vaults.fetch_failed', { 
        error: String(e), 
        batchIndex: i 
      });
    }
  }
  
  return results;
}

/**
 * Normalize raw CPMM pool data into CpmmPool format
 */
export async function normalizeRaydiumCpmmGraphQL(raw: RaydiumCpmmPoolApiResponse[]): Promise<{ cpmm: CpmmPool[] }> {
  const now = Date.now();
  const cpmm: CpmmPool[] = [];
  
  // Filter to valid pools
  const validPools = raw.filter(isValidRaydiumCpmmPool);
  
  // Load Jupiter token prices for TVL calculation
  const jupPriceMap = await loadJupiterTokenMap();

  // Collect all vault addresses for batch RPC fetching
  const vaultAddresses = new Set<string>();
  for (const pool of validPools) {
    if (pool.token0Vault) vaultAddresses.add(pool.token0Vault);
    if (pool.token1Vault) vaultAddresses.add(pool.token1Vault);
  }

  // Extract all mints for batch decimal resolution
  const allMints = new Set<string>();
  for (const pool of validPools) {
    if (pool.token0Mint) allMints.add(pool.token0Mint);
    if (pool.token1Mint) allMints.add(pool.token1Mint);
  }
  
  // Batch fetch vault balances and decimals in parallel
  const [vaultBalances, decimalsMap] = await Promise.all([
    fetchVaultBalances(Array.from(vaultAddresses)),
    resolveManyDecimals(Array.from(allMints), { logger, normalizeMode: true })
  ]);
  
  for (const pool of validPools) {
    try {
      const id = pool.pubkey;
      if (!id) continue;
      
      const mint_a = pool.token0Mint;
      const mint_b = pool.token1Mint;
      
      if (!mint_a || !mint_b) continue;
      
      // Get decimals with fallback
      const decA = pool.mintDecimals0 ?? decimalsMap.get(mint_a) ?? 9;
      const decB = pool.mintDecimals1 ?? decimalsMap.get(mint_b) ?? 9;
      
      // Parse token programs
      const tokenProgramA = pool.token0Program === TOKEN_2022_PROGRAM_ID ? 'token-2022' : 'spl-token';
      const tokenProgramB = pool.token1Program === TOKEN_2022_PROGRAM_ID ? 'token-2022' : 'spl-token';
      
      // Get fee from ammConfig (default to 25 bps if not available)
      // CPMM typically uses 25 bps (0.25%) fee
      const fee_bps = 25;
      
      // Calculate amounts and TVL from vault balances
      let amount_a_whole: number | undefined;
      let amount_b_whole: number | undefined;
      let tvl_usd: number | undefined;
      let reserveA: bigint | undefined;
      let reserveB: bigint | undefined;
      
      try {
        const balA = pool.token0Vault ? vaultBalances.get(pool.token0Vault) : undefined;
        const balB = pool.token1Vault ? vaultBalances.get(pool.token1Vault) : undefined;
        
        if (balA !== undefined && balB !== undefined) {
          reserveA = balA;
          reserveB = balB;
          
          const wholeA = Number(balA) / Math.pow(10, decA);
          const wholeB = Number(balB) / Math.pow(10, decB);
          
          amount_a_whole = wholeA;
          amount_b_whole = wholeB;
          
          const priceA = jupPriceMap[mint_a]?.usdPrice;
          const priceB = jupPriceMap[mint_b]?.usdPrice;
          
          if (priceA && priceB) {
            tvl_usd = (wholeA * priceA) + (wholeB * priceB);
          } else if (priceA) {
            tvl_usd = wholeA * priceA * 2;
          } else if (priceB) {
            tvl_usd = wholeB * priceB * 2;
          }
        }
      } catch (e) { logCatchError('pools.raydiumCpmmGraphQL', e); }

      // Process price through pipeline with reserves
      let price_a_per_b = 0;
      let finalMintA = mint_a;
      let finalMintB = mint_b;
      let finalDecA = decA;
      let finalDecB = decB;
      let wasSwapped = false;
      
      try {
        if (reserveA && reserveB && reserveA > 0n && reserveB > 0n) {
          const processed = processPriceThroughPipeline({
            mintA: mint_a,
            mintB: mint_b,
            decimalsA: decA,
            decimalsB: decB,
            poolId: id,
            dex: 'Raydium',
            poolType: 'cpmm',
            reserveA,
            reserveB,
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
      } catch (e) { logCatchError('pools.raydiumCpmmGraphQL', e); }
      
      // Swap account fields if pipeline swapped mints (CANONICAL order)
      const finalAccountA = wasSwapped ? pool.token1Vault : pool.token0Vault;
      const finalAccountB = wasSwapped ? pool.token0Vault : pool.token1Vault;
      // NATIVE accounts are ALWAYS in on-chain order
      const finalNativeAccountA = pool.token0Vault;
      const finalNativeAccountB = pool.token1Vault;
      
      const finalAmountA = wasSwapped ? amount_b_whole : amount_a_whole;
      const finalAmountB = wasSwapped ? amount_a_whole : amount_b_whole;
      
      cpmm.push({
        id,
        dex: 'Raydium',
        mint_a: finalMintA,
        mint_b: finalMintB,
        fee_bps,
        price_a_per_b,
        tvl_usd,
        updated_ms: now,
        decimals_a: finalDecA,
        decimals_b: finalDecB,
        account_a: finalAccountA,
        account_b: finalAccountB,
        pool_kind: 'cpmm',
        amm_config: pool.ammConfig,
        observation_key: pool.observationKey,
        lp_mint: pool.lpMint,
        authority: pool.creator,
        token_program_a: wasSwapped 
          ? (tokenProgramB as 'spl-token' | 'token-2022') 
          : (tokenProgramA as 'spl-token' | 'token-2022'),
        token_program_b: wasSwapped 
          ? (tokenProgramA as 'spl-token' | 'token-2022') 
          : (tokenProgramB as 'spl-token' | 'token-2022'),
        _updatedAt: pool._updatedAt,
        was_swapped: wasSwapped,
        _pipelineProcessed: true,
        native_mint_a: mint_a,
        native_mint_b: mint_b,
        native_decimals_a: decA,
        native_decimals_b: decB,
        native_account_a: finalNativeAccountA,
        native_account_b: finalNativeAccountB,
        amount_a_whole: finalAmountA,
        amount_b_whole: finalAmountB,
        reserve_a_raw: reserveA?.toString(),
        reserve_b_raw: reserveB?.toString(),
        liquidity_display: tvl_usd,
        pool_liquidity_raw: Math.min(amount_a_whole || 0, amount_b_whole || 0),
      });
    } catch (error: any) {
      logger.warn('raydium.cpmm.graphql.normalize.pool.failed', { 
        error: String(error?.message || error), 
        cat: 'raydium-cpmm' 
      });
    }
  }
  
  logger.info('raydium.cpmm.graphql.normalized', { 
    cpmm: cpmm.length,
    cat: 'raydium-cpmm' 
  });
  
  // Populate executionCache for CPMM pools (enables zero-RPC builds)
  try {
    const { executionCache } = await import('../../execution/cache.js');
    let cached = 0;
    
    for (const pool of cpmm) {
      try {
        const existing = executionCache.getStatic(pool.id) || {};
        executionCache.setStatic(pool.id, {
          ...existing,
          programId: RAYDIUM_CPMM_PROGRAM,
          dex: 'Raydium',
          pool_kind: 'cpmm',
          mint_a: pool.mint_a,
          mint_b: pool.mint_b,
          decimals_a: pool.decimals_a,
          decimals_b: pool.decimals_b,
          vault_a: pool.account_a,
          vault_b: pool.account_b,
          native_mint_a: pool.native_mint_a,
          native_mint_b: pool.native_mint_b,
          native_decimals_a: pool.native_decimals_a,
          native_decimals_b: pool.native_decimals_b,
          native_account_a: pool.native_account_a,
          native_account_b: pool.native_account_b,
          amm_config: pool.amm_config,
          observation_key: pool.observation_key,
          lp_mint: pool.lp_mint,
          token_program_a: pool.token_program_a,
          token_program_b: pool.token_program_b,
        });
        cached++;
      } catch {}
    }
    
    logger.info('raydium.cpmm.execution_cache.populated', {
      cached,
      total: cpmm.length,
      cat: 'raydium-cpmm'
    });
  } catch (cacheErr) {
    logger.debug('raydium.cpmm.execution_cache.failed', {
      error: String((cacheErr as any)?.message || cacheErr),
      cat: 'raydium-cpmm'
    });
  }
  
  return { cpmm };
}
