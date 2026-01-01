import { logger } from '../../utils/logger.js';
import { CONFIG } from '../../utils/config.js';
import { writeJson, joinPath } from '../../utils/fs.js';
import type { ClmmPool, PoolsPayload, SummaryPool } from './types.js';
import { resolveManyDecimals } from './decimals.js';
import { processPriceThroughPipeline } from './pricePipeline.js';
import { executeShyftGraphQL } from './shyftHelpers.js';
import { poolsMetrics } from '../pools.metrics.js';
import { loadJupiterTokenMap } from '../../utils/tokens.js';
import { Connection, PublicKey } from '@solana/web3.js';
import { logCatchError } from '../../utils/errorHandler.js';
import { withRpcLimit } from '../../utils/rpcLimiter.js';
import { isValidPublicKey } from '../../execution/builder/utils.js';

/**
 * Fetch Orca Whirlpool summaries only (no detail fetch, no RPC enrichment).
 * Used for early filtering before expensive detail+RPC phases.
 */
export async function fetchOrcaSummaryOnly(mints: string[]): Promise<SummaryPool[]> {
  const retries = Number((CONFIG as any)?.orca?.maxHttpRetries || 2);
  const backoffMs = Number((CONFIG as any)?.orca?.httpBackoffMs || 500);
  const pageSize = Number((CONFIG as any)?.orca?.pageSize || 1000);
  const maxPages = Number((CONFIG as any)?.orca?.graphqlMaxPages || 50);
  const pageDelayMs = Number((CONFIG as any)?.orca?.pageDelayMs || 200);
  const mintBatchSize = Number((CONFIG as any)?.orca?.mintBatchSize || 10);

  const poolsMap = new Map<string, SummaryPool>();
  const mintBatches = chunkArray(mints, mintBatchSize);

  logger.info('orca.graphql.summary_only.start', {
    totalMints: mints.length,
    batchCount: mintBatches.length,
    mintBatchSize,
    cat: 'orca',
  });

  if (pageDelayMs > 0 && mints.length > 0) {
    await new Promise(resolve => setTimeout(resolve, pageDelayMs));
  }

  for (let batchIdx = 0; batchIdx < mintBatches.length; batchIdx++) {
    const mintBatch = mintBatches[batchIdx];
    try {
      const pools = await fetchOrcaPoolsForMintBatch({
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
          mint_a: pool.tokenMintA,
          mint_b: pool.tokenMintB,
          dex: 'orca',
          type: 'clmm',
          _updatedAt: pool._updatedAt,
        });
      }

      logger.debug('orca.graphql.summary_only.batch', {
        batchIdx,
        batchSize: mintBatch.length,
        count: pools.length,
        total: poolsMap.size,
        cat: 'orca',
      });
    } catch (e: any) {
      logger.warn('orca.graphql.summary_only.batch.failed', {
        batchIdx,
        batchSize: mintBatch.length,
        error: String(e?.message || e),
        cat: 'orca',
      });
    }
    if (pageDelayMs > 0 && batchIdx < mintBatches.length - 1) {
      await new Promise(resolve => setTimeout(resolve, pageDelayMs));
    }
  }

  const result = Array.from(poolsMap.values());
  logger.info('orca.graphql.summary_only.complete', {
    count: result.length,
    mints: mints.length,
    cat: 'orca',
  });
  return result;
}

export async function fetchOrcaGraphQL(mints: string[]): Promise<any[]> {
  const CACHE_PATH = joinPath(CONFIG.cacheDir, 'orca-graphql-raw.json');
  const retries = Number((CONFIG as any)?.orca?.maxHttpRetries || 2);
  const backoffMs = Number((CONFIG as any)?.orca?.httpBackoffMs || 500);
  const pageSize = Number((CONFIG as any)?.orca?.pageSize || 1000);
  // Use graphqlMaxPages for batch queries (higher limit for anchor tokens)
  const maxPages = Number((CONFIG as any)?.orca?.graphqlMaxPages || 50);
  const pageDelayMs = Number((CONFIG as any)?.orca?.pageDelayMs || 200);
  // Reduced default batch size and add max limit to prevent query overload
  const maxDetailBatchSize = Number((CONFIG as any)?.orca?.maxDetailBatchSize || 40);
  const detailBatchSize = Math.min(
    Number((CONFIG as any)?.orca?.detailBatchSize || 20),
    maxDetailBatchSize
  );
  const detailDelayMs = Number((CONFIG as any)?.orca?.detailBatchDelayMs ?? pageDelayMs);
  // Batch optimization: query multiple mints at once using _in clause
  const mintBatchSize = Number((CONFIG as any)?.orca?.mintBatchSize || 10);

  const poolsMap = new Map<string, any>();

  // Chunk mints into batches for efficient querying
  const mintBatches = chunkArray(mints, mintBatchSize);

  logger.info('orca.graphql.batch.start', {
    totalMints: mints.length,
    batchCount: mintBatches.length,
    mintBatchSize,
    cat: 'orca',
  });

  // Add initial delay before first request to respect rate limits
  if (pageDelayMs > 0 && mints.length > 0) {
    await new Promise(resolve => setTimeout(resolve, pageDelayMs));
  }

  for (let batchIdx = 0; batchIdx < mintBatches.length; batchIdx++) {
    const mintBatch = mintBatches[batchIdx];
    try {
      const pools = await fetchOrcaPoolsForMintBatch({
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

      logger.debug('orca.graphql.batch.summary', {
        batchIdx,
        batchSize: mintBatch.length,
        count: pools.length,
        total: poolsMap.size,
        cat: 'orca',
      });
    } catch (e: any) {
      logger.warn('orca.graphql.batch.failed', { 
        batchIdx,
        batchSize: mintBatch.length,
        error: String(e?.message || e), 
        cat: 'orca' 
      });
    }
    // Rate limit delay between batches
    if (pageDelayMs > 0 && batchIdx < mintBatches.length - 1) {
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
  
  logger.info('orca.graphql.complete', { count: merged.length, mints: mints.length, batches: mintBatches.length, detail: detailedPools.size, cat: 'orca' });
  return merged;
}

/**
 * Fetch Orca Whirlpool pools for a batch of mints using GraphQL _in clause
 * Much more efficient than per-mint queries
 */
async function fetchOrcaPoolsForMintBatch(opts: {
  mints: string[];
  retries: number;
  backoffMs: number;
  pageSize: number;
  maxPages: number;
  pageDelayMs: number;
}): Promise<any[]> {
  // Validate pagination params
  const safePageSize = Math.min(Math.max(1, opts.pageSize), 1000);
  const safeMaxPages = Math.min(Math.max(1, opts.maxPages), 20);
  
  const allPools: any[] = [];
  let offset = 0;
  let page = 0;
  
  while (page < safeMaxPages) {
    const data = await executeShyftGraphQL<{ ORCA_WHIRLPOOLS_whirlpool: any[] }>({
      dex: 'orca',
      query: `
        query OrcaPoolsByMints($mints: [String!]!, $limit: Int!, $offset: Int!) {
          ORCA_WHIRLPOOLS_whirlpool(
            where: {_or: [
              {tokenMintA: {_in: $mints}}, 
              {tokenMintB: {_in: $mints}}
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
        mints: opts.mints,
        limit: safePageSize,
        offset,
      },
      retries: opts.retries,
      backoffMs: opts.backoffMs,
      extraLogContext: { phase: 'batch-summary', mintCount: opts.mints.length, page },
    });

    const pagePools = data?.ORCA_WHIRLPOOLS_whirlpool || [];
    if (pagePools.length === 0) break;

    allPools.push(...pagePools);
    logger.debug('orca.graphql.batch.page', { 
      mintCount: opts.mints.length, 
      page, 
      count: pagePools.length, 
      total: allPools.length, 
      cat: 'orca' 
    });

    if (pagePools.length < safePageSize) break;

    offset += safePageSize;
    page++;
    
    if (page < safeMaxPages && opts.pageDelayMs > 0) {
      await new Promise(r => setTimeout(r, opts.pageDelayMs));
    }
  }
  
  return allPools;
}

async function fetchOrcaPoolsForToken(opts: {
  mint: string;
  retries: number;
  backoffMs: number;
  pageSize: number;
  maxPages: number;
  pageDelayMs: number;
}): Promise<any[]> {
  // Validate mint address
  if (!opts.mint || !isValidPublicKey(opts.mint)) {
    logger.warn('orca.graphql.summary.invalid_mint', {
      mint: String(opts.mint).slice(0, 8) + '…',
      cat: 'orca'
    });
    return [];
  }
  
  // Validate pagination params
  const safePageSize = Math.min(Math.max(1, opts.pageSize), 1000);
  const safeMaxPages = Math.min(Math.max(1, opts.maxPages), 20);
  
  const allPools: any[] = [];
  let offset = 0;
  let page = 0;
  
  while (page < safeMaxPages) {
    const variables = {
      mint: opts.mint,
      limit: safePageSize,
      offset,
    };
    
    // Validate variables before querying
    if (!validateGraphQLVariables(variables, 'summary')) {
      logger.warn('orca.graphql.summary.skipping_invalid_variables', {
        mint: opts.mint.slice(0, 8) + '…',
        page,
        cat: 'orca'
      });
      break;
    }
    
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
      variables,
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

    if (pagePools.length < safePageSize) break;

    offset += safePageSize;
    page++;
    
    if (page < safeMaxPages && opts.pageDelayMs > 0) {
      await new Promise(r => setTimeout(r, opts.pageDelayMs));
    }
  }
  
  return allPools;
}

/**
 * Validates and filters pool IDs to ensure they are valid Solana addresses
 */
function validatePoolIds(ids: string[]): string[] {
  return ids.filter(id => {
    if (!id || typeof id !== 'string') return false;
    const trimmed = id.trim();
    if (!trimmed || trimmed.length < 32) return false; // Solana addresses are 32-44 chars
    return isValidPublicKey(trimmed);
  });
}

/**
 * Validates GraphQL variables before sending query
 */
function validateGraphQLVariables(variables: Record<string, any>, queryType: 'summary' | 'detail'): boolean {
  if (queryType === 'detail') {
    const ids = variables.ids;
    if (!Array.isArray(ids) || ids.length === 0) {
      logger.warn('orca.graphql.variables.invalid', {
        queryType,
        reason: 'ids array is empty or invalid',
        idsType: typeof ids,
        idsLength: Array.isArray(ids) ? ids.length : 'N/A',
        cat: 'orca'
      });
      return false;
    }
    
    // Validate each ID in the array
    const invalidIds = ids.filter(id => !isValidPublicKey(id));
    if (invalidIds.length > 0) {
      logger.warn('orca.graphql.variables.invalid_ids', {
        queryType,
        invalidCount: invalidIds.length,
        totalCount: ids.length,
        sampleInvalid: invalidIds.slice(0, 2).map(id => String(id).slice(0, 8) + '…'),
        cat: 'orca'
      });
      return false;
    }
  } else if (queryType === 'summary') {
    const { mint, limit, offset } = variables;
    if (!mint || typeof mint !== 'string' || !isValidPublicKey(mint)) {
      logger.warn('orca.graphql.variables.invalid', {
        queryType,
        reason: 'mint is invalid',
        mint: String(mint).slice(0, 8) + '…',
        cat: 'orca'
      });
      return false;
    }
    if (typeof limit !== 'number' || limit <= 0 || limit > 1000) {
      logger.warn('orca.graphql.variables.invalid', {
        queryType,
        reason: 'limit is out of range',
        limit,
        cat: 'orca'
      });
      return false;
    }
    if (typeof offset !== 'number' || offset < 0) {
      logger.warn('orca.graphql.variables.invalid', {
        queryType,
        reason: 'offset is invalid',
        offset,
        cat: 'orca'
      });
      return false;
    }
  }
  return true;
}

/**
 * Helper function to fetch a single Orca chunk with retry and chunk splitting on failure
 */
async function fetchOrcaChunkWithRetry(
  chunk: string[],
  chunkIndex: number,
  opts: { retries: number; backoffMs: number; delayMs: number },
  result: Map<string, any>
): Promise<void> {
  const maxRetries = opts.retries;
  let lastErr: any;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
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
        retries: 0, // We handle retries here
        backoffMs: opts.backoffMs,
        extraLogContext: { phase: 'detail', chunkIndex, chunkSize: chunk.length, attempt },
      });

      const pools = data?.ORCA_WHIRLPOOLS_whirlpool || [];
      for (const pool of pools) {
        if (!pool?.pubkey) continue;
        result.set(pool.pubkey, pool);
      }
      
      try {
        poolsMetrics.orca.detailBatches += 1;
      } catch (e) { logCatchError('pools.orcaGraphQL', e); }
      
      logger.debug('orca.graphql.detail.chunk', {
        idx: chunkIndex,
        fetched: pools.length,
        total: result.size,
        cat: 'orca',
      });
      
      return; // Success
    } catch (err) {
      lastErr = err;
      const errMsg = String((err as any)?.message || err);
      const isDatabaseError = errMsg.includes('database') || errMsg.includes('unexpected');
      
      // If it's a database error and chunk can be split, try splitting
      if (isDatabaseError && chunk.length > 1 && attempt === maxRetries) {
        const mid = Math.floor(chunk.length / 2);
        const chunk1 = chunk.slice(0, mid);
        const chunk2 = chunk.slice(mid);
        
        logger.warn('orca.graphql.detail.splitting_chunk', {
          chunkIndex,
          originalSize: chunk.length,
          newSizes: [chunk1.length, chunk2.length],
          cat: 'orca'
        });
        
        // Recursively retry with smaller chunks
        await fetchOrcaChunkWithRetry(chunk1, chunkIndex, opts, result);
        await fetchOrcaChunkWithRetry(chunk2, chunkIndex, opts, result);
        return;
      }
      
      // Log error but continue retrying if attempts remain
      if (attempt < maxRetries) {
        const sampleIds = chunk.slice(0, 3).map(id => {
          const trimmed = String(id).trim();
          return trimmed.length > 8 ? trimmed.slice(0, 8) + '…' : trimmed;
        });
        
        logger.warn('orca.graphql.detail.failed.retrying', {
          chunkIndex,
          chunkSize: chunk.length,
          sampleIds,
          attempt,
          error: errMsg,
          cat: 'orca',
        });
        
        // Exponential backoff for database errors
        const backoff = isDatabaseError ? opts.backoffMs * 2 : opts.backoffMs;
        await new Promise(r => setTimeout(r, backoff * (attempt + 1)));
        continue;
      }
    }
  }
  
  // Final failure - log and track
  const sampleIds = chunk.slice(0, 5).map(id => {
    const trimmed = String(id).trim();
    return trimmed.length > 8 ? trimmed.slice(0, 8) + '…' : trimmed;
  });
  
  logger.warn('orca.graphql.detail.failed', {
    chunkIndex,
    chunkSize: chunk.length,
    sampleIds,
    error: String((lastErr as any)?.message || lastErr),
    errorType: (lastErr as any)?.constructor?.name,
    cat: 'orca',
  });
  
  try {
    poolsMetrics.orca.detailFailures += 1;
  } catch (e) { logCatchError('pools.orcaGraphQL', e); }
}

/**
 * Fetch Orca Whirlpool details by pool addresses.
 * Exported for use in early-filter flow where only survivor pools need detail fetching.
 */
export async function fetchOrcaPoolsByAddress(
  poolIds: string[],
  opts: { retries: number; backoffMs: number; batchSize: number; delayMs: number }
): Promise<Map<string, any>> {
  const result = new Map<string, any>();
  
  // Validate and filter pool IDs first
  const validIds = validatePoolIds(poolIds);
  if (!validIds.length) {
    logger.debug('orca.graphql.detail.no_valid_ids', {
      originalCount: poolIds.length,
      cat: 'orca'
    });
    return result;
  }
  
  // Log if we filtered out invalid IDs
  if (validIds.length < poolIds.length) {
    logger.warn('orca.graphql.detail.filtered_invalid_ids', {
      originalCount: poolIds.length,
      validCount: validIds.length,
      filteredCount: poolIds.length - validIds.length,
      cat: 'orca'
    });
  }

  // Apply batch size limits to prevent query overload
  const MAX_BATCH_SIZE = 40; // Hard limit
  const safeBatchSize = Math.min(Math.max(1, opts.batchSize), MAX_BATCH_SIZE);
  const chunks = chunkArray(validIds, safeBatchSize);
  
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    
    // Double-check chunk is not empty (defensive)
    if (!chunk || chunk.length === 0) {
      logger.debug('orca.graphql.detail.skipping_empty_chunk', {
        chunkIndex: i,
        cat: 'orca'
      });
      continue;
    }
    
    // Validate variables before querying
    if (!validateGraphQLVariables({ ids: chunk }, 'detail')) {
      logger.warn('orca.graphql.detail.skipping_invalid_chunk', {
        chunkIndex: i,
        chunkSize: chunk.length,
        cat: 'orca'
      });
      continue; // Skip this chunk
    }
    
    // Use helper function with retry and chunk splitting
    await fetchOrcaChunkWithRetry(chunk, i, opts, result);

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
          } catch (e) { logCatchError('pools.orcaGraphQL', e); }
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
  
  // Create map to collect token program IDs during decimal resolution
  const tokenPrograms = new Map<string, 'spl-token' | 'token-2022'>();
  
  const decimalsMapPromise = resolveManyDecimals(Array.from(allMints), { 
    logger, 
    normalizeMode: true,
    tokenPrograms // Pass the map to collect token program info
  });

  const [vaultBalances, decimalsMap] = await Promise.all([
    vaultBalancesPromise, 
    decimalsMapPromise
  ]);
  
  for (const pool of raw) {
    try {
      const id = pool.pubkey;
      if (!id) continue;
      
      // VALIDATION: Ensure pool ID is not a vault address
      if (id === pool.tokenVaultA || id === pool.tokenVaultB) {
        // Log and skip this pool - the pubkey field contains a vault address, not a pool address
        try {
          logger.warn('orca.graphql.pool_id_is_vault', {
            id: id.slice(0, 8) + '…',
            tokenVaultA: pool.tokenVaultA?.slice(0, 8) + '…',
            tokenVaultB: pool.tokenVaultB?.slice(0, 8) + '…',
            cat: 'orca'
          });
        } catch (e) { logCatchError('pools.orcaGraphQL', e); }
        continue; // Skip this pool
      }
      
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
      } catch (e) { logCatchError('pools.orcaGraphQL', e); }
      
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
      } catch (e) { logCatchError('pools.orcaGraphQL', e); }
      
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
      } catch (e) { logCatchError('pools.orcaGraphQL', e); }
      
      // Swap account/vault fields if pipeline swapped mints (CANONICAL order)
      const finalTokenVaultA = wasSwapped ? pool.tokenVaultB : pool.tokenVaultA;
      const finalTokenVaultB = wasSwapped ? pool.tokenVaultA : pool.tokenVaultB;
      // NATIVE accounts are ALWAYS in on-chain order (never swap based on canonicalization)
      // native_account_a pairs with native_mint_a (tokenMintA), native_account_b pairs with native_mint_b (tokenMintB)
      const finalNativeAccountA = pool.tokenVaultA;
      const finalNativeAccountB = pool.tokenVaultB;
      
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
        // CRITICAL FIX: Negate tick index when mints are swapped
        // When price orientation changes (mints swapped), tick index must be negated
        tick_current_index: wasSwapped && typeof pool.tickCurrentIndex === 'number' 
          ? -pool.tickCurrentIndex 
          : pool.tickCurrentIndex,
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

