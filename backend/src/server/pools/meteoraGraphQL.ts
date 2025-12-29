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
import { executionCache } from '../../execution/cache.js';
import { isValidPublicKey } from '../../execution/builder/utils.js';
import { resolveMeteoraBitmapExtensions } from './meteora.js';

/**
 * Fetch Meteora DLMM pool summaries only (no detail fetch, no RPC enrichment).
 * Used for early filtering before expensive detail+RPC phases.
 */
export async function fetchMeteoraSummaryOnly(mints: string[]): Promise<SummaryPool[]> {
  const retries = Number((CONFIG as any)?.meteora?.maxHttpRetries || 2);
  const backoffMs = Number((CONFIG as any)?.meteora?.httpBackoffMs || 500);
  const pageSize = Number((CONFIG as any)?.meteora?.pageSize || 1000);
  const maxPages = Number((CONFIG as any)?.meteora?.graphqlMaxPages || 50);
  const pageDelayMs = Number((CONFIG as any)?.meteora?.pageDelayMs || 200);
  const mintBatchSize = Number((CONFIG as any)?.meteora?.mintBatchSize || 10);

  const poolsMap = new Map<string, SummaryPool>();
  const mintBatches = chunkArray(mints, mintBatchSize);

  logger.info('meteora.graphql.summary_only.start', {
    totalMints: mints.length,
    batchCount: mintBatches.length,
    mintBatchSize,
    cat: 'meteora',
  });

  if (pageDelayMs > 0 && mints.length > 0) {
    await new Promise(resolve => setTimeout(resolve, pageDelayMs));
  }

  for (let batchIdx = 0; batchIdx < mintBatches.length; batchIdx++) {
    const mintBatch = mintBatches[batchIdx];
    try {
      const pools = await fetchMeteoraPoolsForMintBatch({
        mints: mintBatch,
        retries,
        backoffMs,
        pageSize,
        maxPages,
        pageDelayMs,
      });
      for (const pool of pools) {
        const key = pool.pubkey || pool.baseKey;
        if (!key) continue;
        poolsMap.set(key, {
          pubkey: key,
          mint_a: pool.tokenXMint,
          mint_b: pool.tokenYMint,
          dex: 'meteora',
          type: 'clmm',
          _updatedAt: pool._updatedAt,
        });
      }

      logger.debug('meteora.graphql.summary_only.batch', {
        batchIdx,
        batchSize: mintBatch.length,
        count: pools.length,
        total: poolsMap.size,
        cat: 'meteora',
      });
    } catch (e: any) {
      logger.warn('meteora.graphql.summary_only.batch.failed', {
        batchIdx,
        batchSize: mintBatch.length,
        error: String(e?.message || e),
        cat: 'meteora',
      });
    }
    if (pageDelayMs > 0 && batchIdx < mintBatches.length - 1) {
      await new Promise(resolve => setTimeout(resolve, pageDelayMs));
    }
  }

  const result = Array.from(poolsMap.values());
  logger.info('meteora.graphql.summary_only.complete', {
    count: result.length,
    mints: mints.length,
    cat: 'meteora',
  });
  return result;
}

export async function fetchMeteoraGraphQL(mints: string[]): Promise<any[]> {
  const CACHE_PATH = joinPath(CONFIG.cacheDir, 'meteora-graphql-raw.json');
  const retries = Number((CONFIG as any)?.meteora?.maxHttpRetries || 2);
  const backoffMs = Number((CONFIG as any)?.meteora?.httpBackoffMs || 500);
  const pageSize = Number((CONFIG as any)?.meteora?.pageSize || 1000);
  // Use graphqlMaxPages for batch queries (higher limit for anchor tokens)
  const maxPages = Number((CONFIG as any)?.meteora?.graphqlMaxPages || 50);
  const pageDelayMs = Number((CONFIG as any)?.meteora?.pageDelayMs || 200);
  // Reduced default batch size and add max limit to prevent query overload
  const maxDetailBatchSize = Number((CONFIG as any)?.meteora?.maxDetailBatchSize || 40);
  const detailBatchSize = Math.min(
    Number((CONFIG as any)?.meteora?.detailBatchSize || 10),
    maxDetailBatchSize
  );
  const detailDelayMs = Number((CONFIG as any)?.meteora?.detailBatchDelayMs ?? pageDelayMs);
  // Batch optimization: query multiple mints at once using _in clause
  const mintBatchSize = Number((CONFIG as any)?.meteora?.mintBatchSize || 10);
  
  const poolsMap = new Map<string, any>();
  
  // Chunk mints into batches for efficient querying
  const mintBatches = chunkArray(mints, mintBatchSize);

  logger.info('meteora.graphql.batch.start', {
    totalMints: mints.length,
    batchCount: mintBatches.length,
    mintBatchSize,
    cat: 'meteora',
  });

  // Add initial delay before first request to respect rate limits
  if (pageDelayMs > 0 && mints.length > 0) {
    await new Promise(resolve => setTimeout(resolve, pageDelayMs));
  }

  for (let batchIdx = 0; batchIdx < mintBatches.length; batchIdx++) {
    const mintBatch = mintBatches[batchIdx];
    try {
      const pools = await fetchMeteoraPoolsForMintBatch({
        mints: mintBatch,
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
      
      logger.debug('meteora.graphql.batch.summary', { 
        batchIdx,
        batchSize: mintBatch.length,
        count: pools.length,
        total: poolsMap.size,
        cat: 'meteora' 
      });
    } catch (e: any) {
      logger.warn('meteora.graphql.batch.failed', { 
        batchIdx,
        batchSize: mintBatch.length,
        error: String(e?.message || e), 
        cat: 'meteora' 
      });
    }
    // Rate limit delay between batches
    if (pageDelayMs > 0 && batchIdx < mintBatches.length - 1) {
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
  
  // Count how many pools have bitmap extension PDAs from GraphQL
  let bitmapExtCount = 0;
  for (const pool of detailedPools.values()) {
    if (pool.bitmapExtensionPDA) bitmapExtCount++;
  }
  
  try {
    logger.info('meteora.graphql.bitmap_ext.from_graphql', {
      total: ids.length,
      found: bitmapExtCount,
      cat: 'meteora'
    });
  } catch (e) { logCatchError('pools.meteoraGraphQL', e); }

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
  
  logger.info('meteora.graphql.complete', { count: merged.length, mints: mints.length, batches: mintBatches.length, detail: detailedPools.size, cat: 'meteora' });
  return merged;
}

/**
 * Fetch Meteora DLMM pools for a batch of mints using GraphQL _in clause
 * Much more efficient than per-mint queries
 */
async function fetchMeteoraPoolsForMintBatch(opts: {
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
    const data = await executeShyftGraphQL<{ meteora_dlmm_LbPair: any[] }>({
      dex: 'meteora',
      query: `
        query MeteoraPoolsByMints($mints: [String!]!, $limit: Int!, $offset: Int!) {
          meteora_dlmm_LbPair(
            where: {_or: [
              {tokenXMint: {_in: $mints}}, 
              {tokenYMint: {_in: $mints}}
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
            binArrayBitmap
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

    const pagePools = data?.meteora_dlmm_LbPair || [];
    if (pagePools.length === 0) break;

    allPools.push(...pagePools);
    logger.debug('meteora.graphql.batch.page', { 
      mintCount: opts.mints.length, 
      page, 
      count: pagePools.length, 
      total: allPools.length, 
      cat: 'meteora' 
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

async function fetchMeteoraPoolsForToken(opts: {
  mint: string;
  retries: number;
  backoffMs: number;
  pageSize: number;
  maxPages: number;
  pageDelayMs: number;
}): Promise<any[]> {
  // Validate mint address
  if (!opts.mint || !isValidPublicKey(opts.mint)) {
    logger.warn('meteora.graphql.summary.invalid_mint', {
      mint: String(opts.mint).slice(0, 8) + '…',
      cat: 'meteora'
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
      logger.warn('meteora.graphql.summary.skipping_invalid_variables', {
        mint: opts.mint.slice(0, 8) + '…',
        page,
        cat: 'meteora'
      });
      break;
    }
    
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
            binArrayBitmap
            _updatedAt
          }
        }
      `,
      variables,
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
      logger.warn('meteora.graphql.variables.invalid', {
        queryType,
        reason: 'ids array is empty or invalid',
        idsType: typeof ids,
        idsLength: Array.isArray(ids) ? ids.length : 'N/A',
        cat: 'meteora'
      });
      return false;
    }
    
    // Validate each ID in the array
    const invalidIds = ids.filter(id => !isValidPublicKey(id));
    if (invalidIds.length > 0) {
      logger.warn('meteora.graphql.variables.invalid_ids', {
        queryType,
        invalidCount: invalidIds.length,
        totalCount: ids.length,
        sampleInvalid: invalidIds.slice(0, 2).map(id => String(id).slice(0, 8) + '…'),
        cat: 'meteora'
      });
      return false;
    }
  } else if (queryType === 'summary') {
    const { mint, limit, offset } = variables;
    if (!mint || typeof mint !== 'string' || !isValidPublicKey(mint)) {
      logger.warn('meteora.graphql.variables.invalid', {
        queryType,
        reason: 'mint is invalid',
        mint: String(mint).slice(0, 8) + '…',
        cat: 'meteora'
      });
      return false;
    }
    if (typeof limit !== 'number' || limit <= 0 || limit > 1000) {
      logger.warn('meteora.graphql.variables.invalid', {
        queryType,
        reason: 'limit is out of range',
        limit,
        cat: 'meteora'
      });
      return false;
    }
    if (typeof offset !== 'number' || offset < 0) {
      logger.warn('meteora.graphql.variables.invalid', {
        queryType,
        reason: 'offset is invalid',
        offset,
        cat: 'meteora'
      });
      return false;
    }
  }
  return true;
}

/**
 * Helper function to fetch a single Meteora chunk with retry and chunk splitting on failure
 */
async function fetchMeteoraChunkWithRetry(
  chunk: string[],
  chunkIndex: number,
  opts: { retries: number; backoffMs: number; delayMs: number },
  result: Map<string, any>
): Promise<void> {
  const maxRetries = opts.retries;
  let lastErr: any;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const data = await executeShyftGraphQL<{ 
        meteora_dlmm_LbPair: any[];
        meteora_dlmm_BinArrayBitmapExtension: any[];
      }>({
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
              binArrayBitmap
              _updatedAt
            }
            meteora_dlmm_BinArrayBitmapExtension(
              where: {lbPair: {_in: $ids}}
            ) {
              pubkey
              lbPair
            }
          }
        `,
        variables: { ids: chunk },
        retries: 0, // We handle retries here
        backoffMs: opts.backoffMs,
        extraLogContext: { phase: 'detail', chunkIndex, chunkSize: chunk.length, attempt },
      });

      const pools = data?.meteora_dlmm_LbPair || [];
      const bitmapExtensions = data?.meteora_dlmm_BinArrayBitmapExtension || [];
      
      // Create a map of pool ID (lbPair) -> bitmap extension PDA (pubkey)
      const bitmapExtMap = new Map<string, string>();
      for (const ext of bitmapExtensions) {
        const poolId = ext.lbPair; // lbPair is the pool's pubkey
        const bitmapPda = ext.pubkey; // pubkey is the bitmap extension PDA
        if (poolId && bitmapPda) {
          bitmapExtMap.set(poolId, bitmapPda);
        }
      }
      
      for (const pool of pools) {
        const key = pool?.pubkey || pool?.baseKey;
        if (!key) continue;
        
        // Attach bitmap extension PDA if found
        // Use pool.pubkey to match against lbPair from bitmap extension
        const bitmapExt = pool.pubkey ? bitmapExtMap.get(pool.pubkey) : undefined;
        if (bitmapExt) {
          pool.bitmapExtensionPDA = bitmapExt;
        }
        
        result.set(key, pool);
      }
      
      try {
        poolsMetrics.meteora.detailBatches += 1;
      } catch (e) { logCatchError('pools.meteoraGraphQL', e); }
      
      logger.debug('meteora.graphql.detail.chunk', {
        idx: chunkIndex,
        fetched: pools.length,
        total: result.size,
        cat: 'meteora',
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
        
        logger.warn('meteora.graphql.detail.splitting_chunk', {
          chunkIndex,
          originalSize: chunk.length,
          newSizes: [chunk1.length, chunk2.length],
          cat: 'meteora'
        });
        
        // Recursively retry with smaller chunks
        await fetchMeteoraChunkWithRetry(chunk1, chunkIndex, opts, result);
        await fetchMeteoraChunkWithRetry(chunk2, chunkIndex, opts, result);
        return;
      }
      
      // Log error but continue retrying if attempts remain
      if (attempt < maxRetries) {
        const sampleIds = chunk.slice(0, 3).map(id => {
          const trimmed = String(id).trim();
          return trimmed.length > 8 ? trimmed.slice(0, 8) + '…' : trimmed;
        });
        
        logger.warn('meteora.graphql.detail.failed.retrying', {
          chunkIndex,
          chunkSize: chunk.length,
          sampleIds,
          attempt,
          error: errMsg,
          cat: 'meteora',
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
  
  logger.warn('meteora.graphql.detail.failed', {
    chunkIndex,
    chunkSize: chunk.length,
    sampleIds,
    error: String((lastErr as any)?.message || lastErr),
    errorType: (lastErr as any)?.constructor?.name,
    cat: 'meteora',
  });
  
  try {
    poolsMetrics.meteora.detailFailures += 1;
  } catch (e) { logCatchError('pools.meteoraGraphQL', e); }
}

/**
 * Fetch Meteora DLMM pool details by pool addresses.
 * Exported for use in early-filter flow where only survivor pools need detail fetching.
 */
export async function fetchMeteoraPoolsByAddress(
  poolIds: string[],
  opts: { retries: number; backoffMs: number; batchSize: number; delayMs: number }
): Promise<Map<string, any>> {
  const result = new Map<string, any>();
  
  // Validate and filter pool IDs first
  const validIds = validatePoolIds(poolIds);
  if (!validIds.length) {
    logger.debug('meteora.graphql.detail.no_valid_ids', {
      originalCount: poolIds.length,
      cat: 'meteora'
    });
    return result;
  }
  
  // Log if we filtered out invalid IDs
  if (validIds.length < poolIds.length) {
    logger.warn('meteora.graphql.detail.filtered_invalid_ids', {
      originalCount: poolIds.length,
      validCount: validIds.length,
      filteredCount: poolIds.length - validIds.length,
      cat: 'meteora'
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
      logger.debug('meteora.graphql.detail.skipping_empty_chunk', {
        chunkIndex: i,
        cat: 'meteora'
      });
      continue;
    }
    
    // Validate variables before querying
    if (!validateGraphQLVariables({ ids: chunk }, 'detail')) {
      logger.warn('meteora.graphql.detail.skipping_invalid_chunk', {
        chunkIndex: i,
        chunkSize: chunk.length,
        cat: 'meteora'
      });
      continue; // Skip this chunk
    }
    
    // Use helper function with retry and chunk splitting
    await fetchMeteoraChunkWithRetry(chunk, i, opts, result);

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
          } catch (e) { logCatchError('pools.meteoraGraphQL', e); }
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
  
  // Create map to collect token program IDs during decimal resolution
  const tokenPrograms = new Map<string, 'spl-token' | 'token-2022'>();
  
  const decimalsMapPromise = resolveManyDecimals(Array.from(allMints), { 
    logger, 
    normalizeMode: true,
    tokenPrograms // Pass the map to collect token program info
  });

  // Collect pool info for bitmap extension gap-filling (with activeId for smarter resolution)
  const poolInfoMap = new Map<string, { id: string; activeId?: number }>();
  for (const pool of raw) {
    const id = pool.pubkey || pool.baseKey;
    if (id && typeof id === 'string' && id.length > 0) {
      const activeId = Number(pool.activeId ?? 0);
      poolInfoMap.set(id, { id, activeId: Number.isFinite(activeId) ? activeId : undefined });
    }
  }

  // Build set of pools that already have bitmap extension PDAs from GraphQL
  const poolsWithGraphQLPDA = new Set<string>();
  for (const pool of raw) {
    const id = pool.pubkey || pool.baseKey;
    if (id && pool.bitmapExtensionPDA) {
      poolsWithGraphQLPDA.add(id);
    }
  }
  
  // Fetch via RPC for ALL pools that GraphQL didn't return a PDA for
  // Don't rely on binArrayBitmap field - GraphQL data may be stale
  // Pass activeId so we can skip pools that don't need bitmap extensions
  const poolsToCheck = Array.from(poolInfoMap.values()).filter(p => !poolsWithGraphQLPDA.has(p.id));
  
  const bitmapExtensionMapPromise = poolsToCheck.length > 0
    ? resolveMeteoraBitmapExtensions(poolsToCheck)
    : Promise.resolve(new Map<string, string>());
  
  try {
    logger.info('meteora.graphql.bitmap_ext.gap_fill', {
      total: poolInfoMap.size,
      fromGraphQL: poolsWithGraphQLPDA.size,
      toCheckRPC: poolsToCheck.length,
      cat: 'meteora'
    });
  } catch (e) { logCatchError('pools.meteoraGraphQL', e); }

  const [vaultBalances, decimalsMap, bitmapExtensionMap] = await Promise.all([
    vaultBalancesPromise, 
    decimalsMapPromise,
    bitmapExtensionMapPromise
  ]);
  
  for (const pool of raw) {
    try {
      const id = pool.pubkey || pool.baseKey;
      if (!id) continue;
      
      // VALIDATION: Ensure pool ID is not a vault address
      if (id === pool.reserveX || id === pool.reserveY) {
        try {
          logger.warn('meteora.graphql.pool_id_is_vault', {
            id: id.slice(0, 8) + '…',
            reserveX: pool.reserveX?.slice(0, 8) + '…',
            reserveY: pool.reserveY?.slice(0, 8) + '…',
            cat: 'meteora'
          });
        } catch (e) { logCatchError('pools.meteoraGraphQL', e); }
        continue; // Skip this pool
      }
      
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
      } catch (e) { logCatchError('pools.meteoraGraphQL', e); }
      
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
        } catch (e) { logCatchError('pools.meteoraGraphQL', e); }
        
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
      } catch (e) { logCatchError('pools.meteoraGraphQL', e); }
      
      // Swap amounts if pipeline swapped mints
      const finalAmountA = wasSwapped ? amount_b_whole : amount_a_whole;
      const finalAmountB = wasSwapped ? amount_a_whole : amount_b_whole;

      // Determine token programs (use native mints for lookup since that's what we fetched)
      const tokenProgramA = tokenPrograms.get(mint_a) || 'spl-token';
      const tokenProgramB = tokenPrograms.get(mint_b) || 'spl-token';

      // Map reserveX/reserveY to account_a/account_b for resolver compatibility
      // Follow the same pattern as HTTP normalization: map based on native mint order, then swap if needed
      let account_a: string | undefined;
      let account_b: string | undefined;
      
      if (pool.reserveX && pool.reserveY) {
        // First, map based on native mint order (before pipeline processing)
        // mint_a and mint_b here are the native mints from pool.tokenXMint/tokenYMint
        const tokenXMint = String(pool.tokenXMint || mint_a);
        if (tokenXMint === mint_a) {
          account_a = pool.reserveX;
          account_b = pool.reserveY;
        } else {
          account_a = pool.reserveY;
          account_b = pool.reserveX;
        }
        
        // Then swap if pipeline swapped the mints (to match finalMintA/finalMintB order)
        if (wasSwapped) {
          [account_a, account_b] = [account_b, account_a];
        }
      }

      // Get bitmap extension: GraphQL first, then RPC gap-fill, then fallback
      // GraphQL data may be stale, so RPC verifies all pools without a GraphQL PDA
      let bin_array_bitmap_extension: string | undefined = pool.bitmapExtensionPDA;
      
      // If GraphQL didn't have it, check RPC gap-fill results
      if (!bin_array_bitmap_extension) {
        bin_array_bitmap_extension = bitmapExtensionMap.get(id);
      }
      
      // Final fallback to program ID (RPC returns this if account doesn't exist)
      if (!bin_array_bitmap_extension) {
        bin_array_bitmap_extension = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';
      }

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
        bin_step: Number(pool.binStep || 0),
        active_id: Number(pool.activeId || 0),
        liquidity: pool.liquidity,
        reserve_x: pool.reserveX,
        reserve_y: pool.reserveY,
        oracle: pool.oracle,
        _updatedAt: pool._updatedAt,
        was_swapped: wasSwapped,
        _pipelineProcessed: true, // Mark as processed by price pipeline
        native_mint_a: mint_a,
        native_mint_b: mint_b,
        native_decimals_a: decA,
        native_decimals_b: decB,
        native_reserve_a_raw: pool.reserveX ? String(pool.reserveX) : undefined,
        native_reserve_b_raw: pool.reserveY ? String(pool.reserveY) : undefined,
        token_program_a: wasSwapped ? tokenProgramB : tokenProgramA,
        token_program_b: wasSwapped ? tokenProgramA : tokenProgramB,
        amount_a_whole: finalAmountA,
        amount_b_whole: finalAmountB,
        liquidity_display: tvl_usd,
        account_a,
        account_b,
        bin_array_bitmap_extension,
      } as any);
    } catch (error: any) {
      logger.warn('meteora.graphql.normalize.pool.failed', { 
        error: String(error?.message || error), 
        cat: 'meteora' 
      });
    }
  }
  
  logger.info('meteora.graphql.normalized', { 
    clmm: clmm.length,
    tokenProgramsDetected: tokenPrograms.size,
    token2022Count: Array.from(tokenPrograms.values()).filter(p => p === 'token-2022').length,
    cat: 'meteora' 
  });
  
  // OPTIMIZATION: Fetch fresh activeIds from on-chain data
  // This ensures we have the most up-to-date activeId for accurate price calculations
  // The GraphQL indexer data may be stale
  try {
    const { populateMeteoraActiveIds } = await import('./meteora.js');
    await populateMeteoraActiveIds(clmm);
    
    // Update pool objects with fresh activeIds from cache and recalculate prices
    let priceUpdates = 0;
    for (const pool of clmm) {
      try {
        const cached = executionCache.getHot(pool.id);
        if (cached?.activeId !== undefined && cached.activeId !== null) {
          const oldActiveId = (pool as any).active_id;
          (pool as any).active_id = cached.activeId;
          
          // Only recalculate if activeId changed
          if (oldActiveId !== cached.activeId) {
            // Recalculate price with fresh activeId
            if (pool.bin_step && pool.mint_a && pool.mint_b && pool.decimals_a !== undefined && pool.decimals_b !== undefined) {
              const tokenXMint = (pool as any).native_mint_a;
              const tokenYMint = (pool as any).native_mint_b;
              
              if (tokenXMint && tokenYMint) {
                const processed = processPriceThroughPipeline({
                  mintA: pool.mint_a,
                  mintB: pool.mint_b,
                  decimalsA: pool.decimals_a,
                  decimalsB: pool.decimals_b,
                  poolId: pool.id,
                  dex: 'Meteora',
                  poolType: 'clmm',
                  activeId: cached.activeId,
                  binStep: pool.bin_step,
                  tokenXMint,
                  tokenYMint,
                });
                
                if (processed) {
                  (pool as any).price_a_per_b = processed.priceForward;
                  priceUpdates++;
                  
                  logger.info('meteora.graphql.price_updated_from_onchain', {
                    pool: pool.id.slice(0, 8),
                    oldActiveId,
                    newActiveId: cached.activeId,
                    newPrice: processed.priceForward,
                    cat: 'meteora'
                  });
                }
              }
            }
          }
        }
      } catch (err) {
        logger.debug('meteora.graphql.activeId_update_failed', {
          pool: pool.id.slice(0, 8),
          error: String(err),
          cat: 'meteora'
        });
      }
    }
    
    if (priceUpdates > 0) {
      logger.info('meteora.graphql.onchain_enrichment_complete', {
        poolCount: clmm.length,
        priceUpdates,
        cat: 'meteora'
      });
    }
  } catch (err) {
    logger.warn('meteora.graphql.onchain_enrichment_failed', {
      error: String(err),
      cat: 'meteora'
    });
  }

  // Ensure pool cache objects have bin array PDAs after enrichment.
  // These come from executionCache.hot populated by populateMeteoraActiveIds (anchor decode).
  // Having them on the pool objects allows:
  // - resolver (`peekMeteoraPools`) to set hop.binArrayLower/Upper without extra work
  // - getMeteoraPoolsGraphQL() to persist them into executionCache.static
  try {
    for (const pool of clmm) {
      try {
        const hot = executionCache.getHot(pool.id);
        const bins: any = hot?.binArrays as any;
        if (!bins) continue;
        // Prefer active bin array PDA when available; fall back to lower/upper.
        const active = bins.active || bins.lower;
        const upper = bins.upper || bins.lower;
        if (active) (pool as any).bin_array_lower = String(active);
        if (upper) (pool as any).bin_array_upper = String(upper);
      } catch {}
    }
  } catch {}
  
  return { amm: [], clmm: clmm };
}

