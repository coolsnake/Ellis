import { logger } from '../../utils/logger.js';
import { emit } from '../realtime.js';
import { CONFIG } from '../../utils/config.js';
import { writeJson, joinPath } from '../../utils/fs.js';
import type { AmmPool, PoolsPayload, SummaryPool } from './types.js';
import { validateHttpUrl, swapABFields } from './common.js';
import { canonicalizePools } from './canonical.js';
import { resolveManyDecimals, resolveDecimalsGuaranteed } from './decimals.js';
import { verifyCanonicalization } from './validation.js';
import { httpLogStart, httpLogResponse, httpLog429, httpLogNonOk } from './httpLog.js';
import { PublicKey } from '@solana/web3.js';
import { getConnection } from '../../wallet/wallet.js';
import { withRpcLimit } from '../../utils/rpcLimiter.js';
import type { PumpswapPoolApiResponse, PumpswapGraphQLResponse } from './api-types.js';
import { isValidPumpswapPool } from './api-types.js';
import { logCatchError } from '../../utils/errorHandler.js';
import { ensurePumpswapFeeConfig, computePumpswapPoolFees } from './pumpswapFees.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// Pumpswap AMM program ID
export const PUMPSWAP_PROGRAM_ID = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

// Helper to chunk arrays for batch processing
function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/**
 * Fetch Pumpswap pool summaries only (no RPC enrichment).
 * Used for early filtering before expensive RPC enrichment phase.
 */
export async function fetchPumpswapSummaryOnly(providedMints?: string[]): Promise<SummaryPool[]> {
  const apiKey = (CONFIG as any)?.pumpswap?.shyftApiKey || '';
  if (!apiKey) {
    logger.warn('pumpswap.graphql.summary_only.apiKey_missing', { cat: 'pumpswap' });
    return [];
  }

  const retries = Number((CONFIG as any)?.pumpswap?.maxHttpRetries || 2);
  const backoffMs = Number((CONFIG as any)?.pumpswap?.httpBackoffMs || 500);
  // Use dedicated graphqlPageSize, falling back to 1000 (optimal for Shyft GraphQL)
  const pageSize = Number((CONFIG as any)?.pumpswap?.graphqlPageSize || 1000);
  const maxPages = Number((CONFIG as any)?.pumpswap?.graphqlMaxPages || 50);
  const pageDelayMs = Number((CONFIG as any)?.pumpswap?.pageDelayMs || 200);
  const mintBatchSize = Number((CONFIG as any)?.pumpswap?.mintBatchSize || 10);

  // Use provided mints if available (from shared universe), otherwise compute
  let mints: string[] = [];
  if (providedMints && providedMints.length > 0) {
    mints = providedMints;
    logger.info('pumpswap.graphql.summary_only.universe', { mintCount: mints.length, shared: true, cat: 'pumpswap' });
  } else {
    try {
      const { computeTokenUniverse } = await import('../universe.js');
      const universe = await computeTokenUniverse((CONFIG.system as any)?.tokenUniverseMode);
      mints = Array.from(universe);
      logger.info('pumpswap.graphql.summary_only.universe', { mintCount: mints.length, shared: false, cat: 'pumpswap' });
    } catch (e: any) {
      logger.warn('pumpswap.graphql.summary_only.universe.failed', { error: String(e?.message || e), cat: 'pumpswap' });
      mints = [SOL_MINT, USDC_MINT];
    }
  }

  // Separate anchor tokens from regular tokens to avoid pagination crowding
  const { getAnchorSet } = await import('../universe.js');
  const anchors = getAnchorSet();
  const anchorMints: string[] = [];
  const regularMints: string[] = [];
  
  // First add all anchors to ensure coverage
  for (const anchor of anchors) {
    anchorMints.push(anchor);
  }
  
  // Then categorize the provided mints
  for (const mint of mints) {
    if (!anchors.has(mint)) {
      regularMints.push(mint);
    }
  }

  const poolsMap = new Map<string, SummaryPool>();

  logger.info('pumpswap.graphql.summary_only.start', {
    totalMints: mints.length,
    anchorMints: anchorMints.length,
    regularMints: regularMints.length,
    pageSize,
    maxPages,
    maxPoolsPerAnchor: pageSize * maxPages,
    cat: 'pumpswap',
  });

  if (pageDelayMs > 0 && mints.length > 0) {
    await new Promise(resolve => setTimeout(resolve, pageDelayMs));
  }

  // PHASE 1: Query anchor tokens INDIVIDUALLY to ensure full coverage
  for (let i = 0; i < anchorMints.length; i++) {
    const anchorMint = anchorMints[i];
    try {
      const batchPools = await fetchPoolsForMintBatch([anchorMint], apiKey, retries, backoffMs, pageSize, maxPages, pageDelayMs);
      for (const pool of batchPools) {
        if (!pool?.pubkey) continue;
        poolsMap.set(pool.pubkey, {
          pubkey: pool.pubkey,
          mint_a: pool.base_mint,
          mint_b: pool.quote_mint,
          dex: 'pumpswap',
          type: 'amm',
        });
      }

      logger.info('pumpswap.graphql.summary_only.anchor.complete', {
        mint: anchorMint.slice(0, 8) + '…',
        count: batchPools.length,
        total: poolsMap.size,
        cat: 'pumpswap',
      });
    } catch (e: any) {
      logger.warn('pumpswap.graphql.summary_only.anchor.failed', {
        mint: anchorMint.slice(0, 8) + '…',
        error: String(e?.message || e),
        cat: 'pumpswap',
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
      const batchPools = await fetchPoolsForMintBatch(mintBatch, apiKey, retries, backoffMs, pageSize, maxPages, pageDelayMs);
      for (const pool of batchPools) {
        if (!pool?.pubkey) continue;
        poolsMap.set(pool.pubkey, {
          pubkey: pool.pubkey,
          mint_a: pool.base_mint,
          mint_b: pool.quote_mint,
          dex: 'pumpswap',
          type: 'amm',
        });
      }

      logger.debug('pumpswap.graphql.summary_only.batch', {
        batchIdx,
        batchSize: mintBatch.length,
        count: batchPools.length,
        total: poolsMap.size,
        cat: 'pumpswap',
      });
    } catch (e: any) {
      logger.warn('pumpswap.graphql.summary_only.batch.failed', {
        batchIdx,
        batchSize: mintBatch.length,
        error: String(e?.message || e),
        cat: 'pumpswap',
      });
    }
    if (pageDelayMs > 0 && batchIdx < mintBatches.length - 1) {
      await new Promise(resolve => setTimeout(resolve, pageDelayMs));
    }
  }

  const result = Array.from(poolsMap.values());
  logger.info('pumpswap.graphql.summary_only.complete', {
    count: result.length,
    mints: anchorMints.length + regularMints.length,
    cat: 'pumpswap',
  });
  return result;
}

export async function fetchPumpswapGraphQL(providedMints?: string[]): Promise<PumpswapPoolApiResponse[]> {
  const CACHE_PATH = joinPath(CONFIG.cacheDir, 'pumpswap-raw-sample.json');
  const apiKey = (CONFIG as any)?.pumpswap?.shyftApiKey || '';
  if (!apiKey) {
    try { logger.warn('pumpswap.graphql apiKey missing', { cat: 'pumpswap' }); } catch (e) { logCatchError('pools.pumpswap', e); }
    return [];
  }

  const retries = Number((CONFIG as any)?.pumpswap?.maxHttpRetries || 2);
  const backoffMs = Number((CONFIG as any)?.pumpswap?.httpBackoffMs || 500);
  const pageSize = Number((CONFIG as any)?.pumpswap?.graphqlPageSize || (CONFIG as any)?.pumpswap?.pageSize || 1000);
  // Use graphqlMaxPages for batch queries (higher limit for anchor tokens)
  const maxPages = Number((CONFIG as any)?.pumpswap?.graphqlMaxPages || 50);
  const pageDelayMs = Number((CONFIG as any)?.pumpswap?.pageDelayMs || 200);
  // Batch optimization: query multiple mints at once using _in clause
  const mintBatchSize = Number((CONFIG as any)?.pumpswap?.mintBatchSize || 10);
  
  // Use provided mints if available (from shared universe), otherwise compute
  let mints: string[] = [];
  if (providedMints && providedMints.length > 0) {
    mints = providedMints;
    logger.info('pumpswap.graphql.universe', { mintCount: mints.length, shared: true, cat: 'pumpswap' });
  } else {
    try {
      const { computeTokenUniverse } = await import('../universe.js');
      const universe = await computeTokenUniverse((CONFIG.system as any)?.tokenUniverseMode);
      mints = Array.from(universe);
      logger.info('pumpswap.graphql.universe', { mintCount: mints.length, shared: false, cat: 'pumpswap' });
    } catch (e: any) {
      logger.warn('pumpswap.graphql.universe.failed', { error: String(e?.message || e), cat: 'pumpswap' });
      // Fallback to SOL/USDC if universe fetch fails
      mints = [SOL_MINT, USDC_MINT];
    }
  }
  
  // Separate anchor tokens from regular tokens to avoid pagination crowding
  // Anchor tokens (SOL, USDC, USDT) have many pools and should be queried individually
  const { getAnchorSet } = await import('../universe.js');
  const anchors = getAnchorSet();
  const anchorMints: string[] = [];
  const regularMints: string[] = [];
  
  // First ensure anchors are in the mints list
  const mintsSet = new Set(mints);
  for (const anchor of anchors) {
    mintsSet.add(anchor);
  }
  
  // Then separate them for individual querying
  for (const mint of mintsSet) {
    if (anchors.has(mint)) {
      anchorMints.push(mint);
    } else {
      regularMints.push(mint);
    }
  }
  
  const pools = new Map<string, any>(); // Dedupe by pubkey

  logger.info('pumpswap.graphql.fetch.start', {
    totalMints: mintsSet.size,
    anchorMints: anchorMints.length,
    regularMints: regularMints.length,
    pageSize,
    maxPages,
    maxPoolsPerAnchor: pageSize * maxPages,
    cat: 'pumpswap',
  });

  // Add initial delay before first request to respect rate limits
  if (pageDelayMs > 0 && mintsSet.size > 0) {
    await new Promise(resolve => setTimeout(resolve, pageDelayMs));
  }
  
  // PHASE 1: Query anchor tokens INDIVIDUALLY to ensure full coverage
  // Each anchor gets its own pagination, avoiding crowding from other high-volume tokens
  for (let i = 0; i < anchorMints.length; i++) {
    const anchorMint = anchorMints[i];
    try {
      const anchorPools = await fetchPoolsForMintBatch([anchorMint], apiKey, retries, backoffMs, pageSize, maxPages, pageDelayMs);
      for (const p of anchorPools) {
        pools.set(p.pubkey, p);
      }
      
      logger.info('pumpswap.graphql.anchor.complete', {
        mint: anchorMint.slice(0, 8) + '…',
        count: anchorPools.length,
        total: pools.size,
        cat: 'pumpswap',
      });
    } catch (e: any) {
      logger.warn('pumpswap.graphql.anchor.failed', { 
        mint: anchorMint.slice(0, 8) + '…',
        error: String(e?.message || e), 
        cat: 'pumpswap' 
      });
    }
    // Rate limit delay between anchor queries
    if (pageDelayMs > 0 && i < anchorMints.length - 1) {
      await new Promise(r => setTimeout(r, pageDelayMs));
    }
  }

  // PHASE 2: Query regular tokens in batches (they have fewer pools each)
  const mintBatches = chunkArray(regularMints, mintBatchSize);

  logger.info('pumpswap.graphql.batch.start', {
    regularMints: regularMints.length,
    batchCount: mintBatches.length,
    mintBatchSize,
    cat: 'pumpswap',
  });
  
  // Fetch pools for each batch of mints
  for (let batchIdx = 0; batchIdx < mintBatches.length; batchIdx++) {
    const mintBatch = mintBatches[batchIdx];
    try {
      const batchPools = await fetchPoolsForMintBatch(mintBatch, apiKey, retries, backoffMs, pageSize, maxPages, pageDelayMs);
      for (const p of batchPools) {
        pools.set(p.pubkey, p);
      }
      
      logger.debug('pumpswap.graphql.batch.fetched', { 
        batchIdx,
        batchSize: mintBatch.length,
        count: batchPools.length, 
        total: pools.size,
        cat: 'pumpswap' 
      });
      
      // Rate limit delay between batches
      if (pageDelayMs > 0 && batchIdx < mintBatches.length - 1) {
        await new Promise(r => setTimeout(r, pageDelayMs));
      }
    } catch (e: any) {
      logger.warn('pumpswap.graphql.batch.failed', { 
        batchIdx,
        batchSize: mintBatch.length,
        error: String(e?.message || e), 
        cat: 'pumpswap' 
      });
      // Continue to next batch on failure
    }
  }
  
  const allPools = Array.from(pools.values());
  try { await writeJson(CACHE_PATH, allPools); } catch (e: any) {
    try { logger.warn('pumpswap.cache write failed', { file: CACHE_PATH, error: String(e?.message || e), cat: 'pumpswap' }); } catch (e) { logCatchError('pools.pumpswap', e); }
  }
  try { logger.info('pumpswap.graphql raw', { count: allPools.length, mints: mints.length, batches: mintBatches.length, cat: 'pumpswap' }); } catch (e) { logCatchError('pools.pumpswap', e); }
  return allPools;
}

/**
 * Fetch Pumpswap pools for a batch of mints using GraphQL _in clause
 * Much more efficient than per-mint queries
 */
async function fetchPoolsForMintBatch(
  mints: string[],
  apiKey: string,
  retries: number,
  backoffMs: number,
  pageSize: number,
  maxPages: number,
  pageDelayMs: number
): Promise<any[]> {
  const allPools: any[] = [];
  let offset = 0;
  let page = 0;
  
  // Format mints array for GraphQL - escape and quote each mint
  const mintsArrayStr = JSON.stringify(mints);
  
  while (page < maxPages) {
    const query = `
      query GetPumpswapPoolsByMints($mints: [String!]!, $limit: Int!, $offset: Int!) {
        pump_fun_amm_Pool(
          where: {_or: [
            {base_mint: {_in: $mints}}, 
            {quote_mint: {_in: $mints}}
          ]},
          limit: $limit,
          offset: $offset
        ) {
          base_mint
          quote_mint
          pubkey
          creator
          lp_mint
          lp_supply
          pool_base_token_account
          pool_quote_token_account
          pool_bump
          index
        }
      }
    `;
    
    const url = 'https://programs.shyft.to/v0/graphql/accounts';
    const params = new URLSearchParams({ 
      api_key: apiKey, 
      network: 'mainnet-beta' 
    });
    
    // eslint-disable-next-line no-undef
    const fetchFn: any = (globalThis as any).fetch || fetch;
    
    let pagePools: any[] = [];
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const cid = httpLogStart({ source: 'pumpswap', url: `${url}?${params}`, extra: { mintCount: mints.length, page, offset } });
        const res = await fetchFn(`${url}?${params}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            query, 
            operationName: 'GetPumpswapPoolsByMints',
            variables: {
              mints,
              limit: pageSize,
              offset,
            }
          })
        });
        
        if (res?.status === 429) {
          try { emit('log', { level: 'warn', message: 'arb:429 source=pumpswap kind=graphql', timestamp: new Date().toISOString(), context: { cat: 'arb' } }); } catch (e) { logCatchError('pools.pumpswap', e); }
          try { logger.warn('pumpswap.graphql 429', { mintCount: mints.length, page, cat: 'pumpswap' }); } catch (e) { logCatchError('pools.pumpswap', e); }
          httpLog429({ source: 'pumpswap', url: `${url}?${params}`, cid });
          if (attempt < retries) {
            await new Promise(r => setTimeout(r, backoffMs * (attempt + 1)));
            continue;
          }
          throw new Error('429');
        }
        
        if (!res?.ok) {
          httpLogNonOk({ source: 'pumpswap', url: `${url}?${params}`, cid, status: res?.status });
          throw new Error(`http ${res?.status}`);
        }
        
        const json = await res.json();
        if (json?.errors) {
          try { logger.warn('pumpswap.graphql errors', { errors: JSON.stringify(json.errors), cat: 'pumpswap' }); } catch (e) { logCatchError('pools.pumpswap', e); }
          throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
        }
        
        pagePools = json?.data?.pump_fun_amm_Pool || [];
        httpLogResponse({ source: 'pumpswap', url: `${url}?${params}`, cid, status: res.status, ms: 0, count: pagePools.length });
        break; // Success, exit retry loop
      } catch (e: any) {
        const msg = String(e?.message || e);
        if (/429/.test(msg) && attempt < retries) {
          await new Promise(r => setTimeout(r, backoffMs * (attempt + 1)));
          continue;
        }
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, backoffMs * (attempt + 1)));
          continue;
        }
        try { logger.warn('pumpswap.graphql.batch fetch failed', { mintCount: mints.length, page, error: msg, cat: 'pumpswap' }); } catch (e) { logCatchError('pools.pumpswap', e); }
        break; // Exit retry loop on final failure
      }
    }
    
    if (pagePools.length === 0) {
      // No more results, exit pagination loop
      break;
    }
    
    allPools.push(...pagePools);
    try { logger.debug('pumpswap.graphql.batch.page', { mintCount: mints.length, page, count: pagePools.length, total: allPools.length, cat: 'pumpswap' }); } catch (e) { logCatchError('pools.pumpswap', e); }
    
    // If we got fewer results than pageSize, we've reached the end
    if (pagePools.length < pageSize) {
      break;
    }
    
    offset += pageSize;
    page++;
    
    // Add delay before next page request to avoid rate limiting
    if (page < maxPages && pageDelayMs > 0) {
      await new Promise(r => setTimeout(r, pageDelayMs));
    }
  }
  
  return allPools;
}

async function fetchPoolsForToken(
  mintAddress: string, 
  apiKey: string, 
  retries: number, 
  backoffMs: number,
  pageSize: number,
  maxPages: number,
  pageDelayMs: number
): Promise<any[]> {
  const allPools: any[] = [];
  let offset = 0;
  let page = 0;
  
  while (page < maxPages) {
    const query = `
      query GetPumpswapPools {
        pump_fun_amm_Pool(
          where: {_or: [
            {base_mint: {_eq: "${mintAddress}"}}, 
            {quote_mint: {_eq: "${mintAddress}"}}
          ]},
          limit: ${pageSize},
          offset: ${offset}
        ) {
          base_mint
          quote_mint
          pubkey
          creator
          lp_mint
          lp_supply
          pool_base_token_account
          pool_quote_token_account
          pool_bump
          index
        }
      }
    `;
    
    const url = 'https://programs.shyft.to/v0/graphql/accounts';
    const params = new URLSearchParams({ 
      api_key: apiKey, 
      network: 'mainnet-beta' 
    });
    
    // eslint-disable-next-line no-undef
    const fetchFn: any = (globalThis as any).fetch || fetch;
    
    let pagePools: any[] = [];
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const cid = httpLogStart({ source: 'pumpswap', url: `${url}?${params}`, extra: { mint: mintAddress, page, offset } });
        const res = await fetchFn(`${url}?${params}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, operationName: 'GetPumpswapPools' })
        });
        
        if (res?.status === 429) {
          try { emit('log', { level: 'warn', message: 'arb:429 source=pumpswap kind=graphql', timestamp: new Date().toISOString(), context: { cat: 'arb' } }); } catch (e) { logCatchError('pools.pumpswap', e); }
          try { logger.warn('pumpswap.graphql 429', { mint: mintAddress, page, cat: 'pumpswap' }); } catch (e) { logCatchError('pools.pumpswap', e); }
          httpLog429({ source: 'pumpswap', url: `${url}?${params}`, cid });
          if (attempt < retries) {
            await new Promise(r => setTimeout(r, backoffMs * (attempt + 1)));
            continue;
          }
          throw new Error('429');
        }
        
        if (!res?.ok) {
          httpLogNonOk({ source: 'pumpswap', url: `${url}?${params}`, cid, status: res?.status });
          throw new Error(`http ${res?.status}`);
        }
        
        const json = await res.json();
        if (json?.errors) {
          try { logger.warn('pumpswap.graphql errors', { errors: JSON.stringify(json.errors), cat: 'pumpswap' }); } catch (e) { logCatchError('pools.pumpswap', e); }
          throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
        }
        
        pagePools = json?.data?.pump_fun_amm_Pool || [];
        httpLogResponse({ source: 'pumpswap', url: `${url}?${params}`, cid, status: res.status, ms: 0, count: pagePools.length });
        break; // Success, exit retry loop
      } catch (e: any) {
        const msg = String(e?.message || e);
        if (/429/.test(msg) && attempt < retries) {
          await new Promise(r => setTimeout(r, backoffMs * (attempt + 1)));
          continue;
        }
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, backoffMs * (attempt + 1)));
          continue;
        }
        try { logger.warn('pumpswap.graphql fetch failed', { mint: mintAddress, page, error: msg, cat: 'pumpswap' }); } catch (e) { logCatchError('pools.pumpswap', e); }
        break; // Exit retry loop on final failure
      }
    }
    
    if (pagePools.length === 0) {
      // No more results, exit pagination loop
      break;
    }
    
    allPools.push(...pagePools);
    try { logger.debug('pumpswap.graphql page', { mint: mintAddress, page, count: pagePools.length, total: allPools.length, cat: 'pumpswap' }); } catch (e) { logCatchError('pools.pumpswap', e); }
    
    // If we got fewer results than pageSize, we've reached the end
    if (pagePools.length < pageSize) {
      break;
    }
    
    offset += pageSize;
    page++;
    
    // Add delay before next page request to avoid rate limiting
    if (page < maxPages && pageDelayMs > 0) {
      await new Promise(r => setTimeout(r, pageDelayMs));
    }
  }
  
  return allPools;
}

// ============================================================================
// Fetch Pools by Address (for Discovery)
// ============================================================================

/**
 * Options for fetchPumpswapPoolsByAddress
 */
export interface FetchPumpswapByAddressOptions {
  retries?: number;
  backoffMs?: number;
  batchSize?: number;
  delayMs?: number;
}

/**
 * Fetch Pumpswap pools by their pool addresses (pubkeys).
 * Used by the discovery system to enrich pools found via DexScreener.
 * 
 * @param poolAddresses Array of pool pubkey addresses to fetch
 * @param options Fetch options (retries, backoff, batch size, delay)
 * @returns Map of pool address to raw pool data
 */
export async function fetchPumpswapPoolsByAddress(
  poolAddresses: string[],
  options?: FetchPumpswapByAddressOptions
): Promise<Map<string, PumpswapPoolApiResponse>> {
  const apiKey = (CONFIG as any)?.pumpswap?.shyftApiKey || '';
  if (!apiKey) {
    logger.warn('pumpswap.fetchByAddress.apiKey_missing', { cat: 'pumpswap' });
    return new Map();
  }
  
  if (poolAddresses.length === 0) {
    return new Map();
  }
  
  const retries = options?.retries ?? Number((CONFIG as any)?.pumpswap?.maxHttpRetries || 2);
  const backoffMs = options?.backoffMs ?? Number((CONFIG as any)?.pumpswap?.httpBackoffMs || 500);
  const batchSize = options?.batchSize ?? 50; // Shyft GraphQL limit
  const delayMs = options?.delayMs ?? Number((CONFIG as any)?.pumpswap?.pageDelayMs || 200);
  
  const result = new Map<string, PumpswapPoolApiResponse>();
  const batches = chunkArray(poolAddresses, batchSize);
  
  logger.info('pumpswap.fetchByAddress.start', { 
    totalPools: poolAddresses.length,
    batches: batches.length,
    batchSize,
    cat: 'pumpswap' 
  });
  
  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx];
    
    const query = `
      query GetPumpswapPoolsByAddress($addresses: [String!]!) {
        pump_fun_amm_Pool(where: {pubkey: {_in: $addresses}}) {
          base_mint
          quote_mint
          pubkey
          creator
          lp_mint
          lp_supply
          pool_base_token_account
          pool_quote_token_account
          pool_bump
          index
        }
      }
    `;
    
    const url = 'https://programs.shyft.to/v0/graphql/accounts';
    const params = new URLSearchParams({ 
      api_key: apiKey, 
      network: 'mainnet-beta' 
    });
    
    // eslint-disable-next-line no-undef
    const fetchFn: any = (globalThis as any).fetch || fetch;
    
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const cid = httpLogStart({ source: 'pumpswap', url: `${url}?${params}`, extra: { batch: batchIdx, poolCount: batch.length } });
        const res = await fetchFn(`${url}?${params}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            query, 
            operationName: 'GetPumpswapPoolsByAddress',
            variables: { addresses: batch }
          })
        });
        
        if (res?.status === 429) {
          logger.warn('pumpswap.fetchByAddress.429', { batch: batchIdx, cat: 'pumpswap' });
          httpLog429({ source: 'pumpswap', url: `${url}?${params}`, cid });
          if (attempt < retries) {
            await new Promise(r => setTimeout(r, backoffMs * (attempt + 1)));
            continue;
          }
          throw new Error('429');
        }
        
        httpLogResponse({ source: 'pumpswap', url: `${url}?${params}`, cid, status: res?.status || 0, ms: 0 });
        
        if (!res?.ok) {
          httpLogNonOk({ source: 'pumpswap', url: `${url}?${params}`, status: res?.status || 0, cid });
          if (attempt < retries) {
            await new Promise(r => setTimeout(r, backoffMs * (attempt + 1)));
            continue;
          }
          throw new Error(`HTTP ${res?.status}`);
        }
        
        const json = await res.json();
        const pools = json?.data?.pump_fun_amm_Pool || [];
        
        for (const pool of pools) {
          if (pool?.pubkey) {
            result.set(pool.pubkey, pool);
          }
        }
        
        break; // Success, exit retry loop
        
      } catch (err: any) {
        if (attempt === retries) {
          logger.error('pumpswap.fetchByAddress.batch_error', { 
            batch: batchIdx, 
            error: String(err?.message || err),
            cat: 'pumpswap' 
          });
        }
      }
    }
    
    // Delay between batches
    if (batchIdx < batches.length - 1 && delayMs > 0) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  
  logger.info('pumpswap.fetchByAddress.complete', { 
    requested: poolAddresses.length,
    found: result.size,
    cat: 'pumpswap' 
  });
  
  return result;
}

/**
 * Helper to parse SPL token account balance from raw account data
 * Token account layout: amount is u64 at offset 64
 */
function parseTokenAccountAmount(data: Buffer | Uint8Array): bigint | null {
  try {
    if (!data || data.length < 72) return null;
    // Read u64 little-endian at offset 64
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    return buf.readBigUInt64LE(64);
  } catch {
    return null;
  }
}

/**
 * Parse Pumpswap pool account structure to extract execution-critical addresses
 * 
 * NOTE: After testing, we found that the coin creator vault addresses are NOT
 * reliably stored in the pool account data (offsets returned all zeros = System Program).
 * These addresses need to be derived from the creator and base mint.
 * 
 * This function is kept for future reference but currently returns null.
 */
export async function parsePumpswapPoolAccounts(data: Buffer | Uint8Array): Promise<{ 
  coinCreatorVaultAta: string | null; 
  coinCreatorVaultAuthority: string | null;
}> {
  // These addresses cannot be reliably extracted from pool account data
  // They must be derived during transaction building
  return { coinCreatorVaultAta: null, coinCreatorVaultAuthority: null };
}

/**
 * Helper to parse pump.swap pool fee from pool account data
 * Based on pump.swap pool account layout analysis
 * Fee structure is typically stored as u64 representing fee in basis points
 * Common offsets for AMM pools: around 200-300 bytes into account
 * We'll try multiple known offsets used by various AMM programs
 */
export function parsePumpswapPoolFee(data: Buffer | Uint8Array): number | null {
  try {
    if (!data || data.length < 100) return null;
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    
    // Try common fee offset patterns for Solana AMM programs
    // Most AMMs store fee as u64 or u16 after discriminator and key fields
    const possibleOffsets = [
      72,  // Common offset after discriminator + 2 pubkeys
      88,  // After discriminator + 2 pubkeys + some flags
      104, // Common offset for fee_numerator
      216, // Alternative common offset
      224, // Another pattern seen in AMM programs
    ];
    
    for (const offset of possibleOffsets) {
      if (buf.length >= offset + 8) {
        // Try reading as u64 (fee in basis points or numerator)
        const feeValue = buf.readBigUInt64LE(offset);
        // Valid fee should be between 1 and 10000 bps (0.01% to 100%)
        if (feeValue > 0n && feeValue <= 10000n) {
          return Number(feeValue);
        }
      }
      
      if (buf.length >= offset + 2) {
        // Try reading as u16 (fee in basis points)
        const feeValue = buf.readUInt16LE(offset);
        // Valid fee should be between 1 and 10000 bps
        if (feeValue > 0 && feeValue <= 10000) {
          return feeValue;
        }
      }
    }
    
    return null;
  } catch {
    return null;
  }
}

/**
 * Enriches Pumpswap pools with RPC data (token account balances)
 * This allows us to calculate price and liquidity from actual reserves
 * Returns enriched pools and metrics for monitoring
 */
export async function enrichPumpswapPoolsWithRpc(pools: any[]): Promise<{ pools: any[]; metrics: { success: number; fail: number; ms: number; feesExtracted: number; protocolRecipientsExtracted: number } }> {
  if (!pools || pools.length === 0) return { pools, metrics: { success: 0, fail: 0, ms: 0, feesExtracted: 0, protocolRecipientsExtracted: 0 } };
  
  const batchSize = Number((CONFIG as any)?.pumpswap?.rpcBatchSize || 100);
  const enabled = ((CONFIG as any)?.pumpswap?.enableRpcEnrichment !== false);
  
  if (!enabled) {
    try { logger.debug('pumpswap.rpc.enrichment.disabled', { cat: 'pumpswap' }); } catch (e) { logCatchError('pools.pumpswap', e); }
    return { pools, metrics: { success: 0, fail: 0, ms: 0, feesExtracted: 0, protocolRecipientsExtracted: 0 } };
  }
  
  const connection = getConnection();
  const enriched: any[] = [];
  let successCount = 0;
  let failCount = 0;
  let feesExtracted = 0;
  let protocolRecipientsExtracted = 0;
  const t0 = Date.now();
  
  try { logger.info('pumpswap.rpc.enrichment.start', { poolCount: pools.length, batchSize, cat: 'pumpswap' }); } catch (e) { logCatchError('pools.pumpswap', e); }
  
  for (let i = 0; i < pools.length; i += batchSize) {
    const batch = pools.slice(i, i + batchSize);
    
    try {
      // Collect all addresses to fetch: vaults AND pool accounts
      const allAddresses: PublicKey[] = [];
      const addressMapping: Map<string, { poolIndex: number; type: 'pool' | 'base_vault' | 'quote_vault' }> = new Map();
      
      for (let j = 0; j < batch.length; j++) {
        const pool = batch[j];
        const poolIdx = i + j;
        
        // Add pool account itself to fetch fee data
        if (pool.pubkey) {
          try {
            const pk = new PublicKey(pool.pubkey);
            allAddresses.push(pk);
            addressMapping.set(pool.pubkey, { poolIndex: poolIdx, type: 'pool' });
          } catch (e) { logCatchError('pools.pumpswap', e); }
        }
        
        // Add vault accounts
        if (pool.pool_base_token_account) {
          try {
            const pk = new PublicKey(pool.pool_base_token_account);
            allAddresses.push(pk);
            addressMapping.set(pool.pool_base_token_account, { poolIndex: poolIdx, type: 'base_vault' });
          } catch (e) { logCatchError('pools.pumpswap', e); }
        }
        
        if (pool.pool_quote_token_account) {
          try {
            const pk = new PublicKey(pool.pool_quote_token_account);
            allAddresses.push(pk);
            addressMapping.set(pool.pool_quote_token_account, { poolIndex: poolIdx, type: 'quote_vault' });
          } catch (e) { logCatchError('pools.pumpswap', e); }
        }
      }
      
      if (allAddresses.length === 0) {
        enriched.push(...batch);
        continue;
      }
      
      // Fetch all accounts in one RPC call
      const weight = Math.max(1, Math.ceil(allAddresses.length / 100));
      const accountInfos = await withRpcLimit(
        () => connection.getMultipleAccountsInfo(allAddresses),
        weight,
        { module: 'pools', method: 'getMultipleAccountsInfo' }
      );
      
      // Create maps for balances, fees, creators, and protocol recipients
      const balances = new Map<string, bigint>();
      const fees = new Map<string, number>(); // pool pubkey -> fee_bps
      const creators = new Map<string, string>(); // pool pubkey -> on-chain creator
      const protocolRecipients = new Map<string, string>(); // pool pubkey -> protocol_fee_recipient
      
      for (let k = 0; k < allAddresses.length; k++) {
        const info = accountInfos[k];
        const address = allAddresses[k].toBase58();
        const mapping = addressMapping.get(address);
        
        if (!info?.data || !mapping) continue;
        
        if (mapping.type === 'pool') {
          // Extract fee from pool account
          const fee = parsePumpswapPoolFee(info.data);
          if (fee !== null) {
            const pool = batch[mapping.poolIndex - i];
            if (pool && pool.pubkey) {
              fees.set(pool.pubkey, fee);
              feesExtracted++;
            }
          }
          
          // Extract on-chain coin_creator from pool account
          // Pool account structure: [discriminator(8), pool_bump(1), index(2), creator(32), 
          //   base_mint(32), quote_mint(32), lp_mint(32), pool_base_token_account(32), 
          //   pool_quote_token_account(32), lp_supply(8), coin_creator(32), protocol_fee_recipient(32), ...]
          // coin_creator offset = 8+1+2+32+32+32+32+32+32+8 = 211
          // protocol_fee_recipient offset = 211+32 = 243
          try {
            const buf = Buffer.isBuffer(info.data) ? info.data : Buffer.from(info.data);
            if (buf.length >= 243) { // 211 + 32
              const { PublicKey } = await import('@solana/web3.js');
              const coinCreatorBytes = buf.subarray(211, 243);
              const coinCreatorPubkey = new PublicKey(coinCreatorBytes);
              const coinCreatorBase58 = coinCreatorPubkey.toBase58();
              
              // Validate that we got a proper base58 string
              if (coinCreatorBase58 && coinCreatorBase58.length >= 32) {
                const pool = batch[mapping.poolIndex - i];
                if (pool && pool.pubkey) {
                  creators.set(pool.pubkey, coinCreatorBase58);
                  
                  try {
                    logger.info('pumpswap.extract.coin_creator.success', {
                      pool: pool.pubkey.slice(0, 12),
                      coinCreator: coinCreatorBase58.slice(0, 12),
                      isSystemProgram: coinCreatorBase58 === '11111111111111111111111111111111',
                      cat: 'pumpswap'
                    });
                  } catch (e) { logCatchError('pools.pumpswap', e); }
                }
              }
            }
            
            // Extract protocol_fee_recipient at offset 243
            if (buf.length >= 275) { // 243 + 32
              const { PublicKey, SystemProgram } = await import('@solana/web3.js');
              const protocolRecipientBytes = buf.subarray(243, 275);
              const protocolRecipientPubkey = new PublicKey(protocolRecipientBytes);
              const protocolRecipientBase58 = protocolRecipientPubkey.toBase58();
              
              // System Program ID - means no protocol fee recipient configured
              const SYSTEM_PROGRAM_ID = SystemProgram.programId.toBase58();
              
              // Validate that we got a proper base58 string and it's not System Program
              // System Program ID at this offset means the field is empty/unconfigured
              if (protocolRecipientBase58 && 
                  protocolRecipientBase58.length >= 32 && 
                  protocolRecipientBase58 !== SYSTEM_PROGRAM_ID) {
                const pool = batch[mapping.poolIndex - i];
                if (pool && pool.pubkey) {
                  protocolRecipients.set(pool.pubkey, protocolRecipientBase58);
                  protocolRecipientsExtracted++;
                  
                  try {
                    logger.info('pumpswap.extract.protocol_recipient.success', {
                      pool: pool.pubkey.slice(0, 12),
                      protocolRecipient: protocolRecipientBase58.slice(0, 12),
                      cat: 'pumpswap'
                    });
                  } catch (e) { logCatchError('pools.pumpswap', e); }
                }
              } else if (protocolRecipientBase58 === SYSTEM_PROGRAM_ID) {
                // Log when System Program is found (means field is empty/not configured)
                try {
                  logger.debug('pumpswap.extract.protocol_recipient.system_program', {
                    pool: batch[mapping.poolIndex - i]?.pubkey?.slice(0, 12),
                    note: 'protocol_fee_recipient_not_configured_will_use_fallback',
                    cat: 'pumpswap'
                  });
                } catch (e) { logCatchError('pools.pumpswap', e); }
              }
            }
          } catch (e: any) {
            try {
              logger.warn('pumpswap.extract.pool_fields.failed', {
                pool: address,
                error: String(e?.message || e),
                cat: 'pumpswap'
              });
            } catch (e) { logCatchError('pools.pumpswap', e); }
          }
        } else {
          // Extract balance from vault account
          const amount = parseTokenAccountAmount(info.data);
          if (amount !== null) {
            balances.set(address, amount);
          }
        }
      }
      
      // Enrich each pool in the batch with balance, fee, creator, and protocol recipient data
      for (const pool of batch) {
        const baseBalance = pool.pool_base_token_account ? balances.get(pool.pool_base_token_account) : null;
        const quoteBalance = pool.pool_quote_token_account ? balances.get(pool.pool_quote_token_account) : null;
        const feeBps = pool.pubkey ? fees.get(pool.pubkey) : null;
        const onchainCreator = pool.pubkey ? creators.get(pool.pubkey) : null;
        const protocolRecipient = pool.pubkey ? protocolRecipients.get(pool.pubkey) : null;
        
        enriched.push({
          ...pool,
          base_reserve: baseBalance !== null ? baseBalance.toString() : undefined,
          quote_reserve: quoteBalance !== null ? quoteBalance.toString() : undefined,
          fee_bps: feeBps !== null ? feeBps : undefined, // Add extracted fee
          onchain_creator: onchainCreator || pool.creator, // On-chain coin_creator (offset 211), fallback to GraphQL creator
          protocol_fee_recipient: protocolRecipient || undefined, // On-chain protocol_fee_recipient (offset 243)
          // Note: coin_creator_vault addresses will be derived during transaction building
          // If coin_creator is System Program, no creator fees apply to this pool
        });
        
        if (baseBalance !== null && quoteBalance !== null) {
          successCount++;
        } else {
          failCount++;
        }
      }
      
      try { logger.info('pumpswap.rpc.enrichment.batch', { 
        batch: Math.floor(i / batchSize) + 1, 
        accountCount: allAddresses.length, 
        success: successCount, 
        fail: failCount,
        feesExtracted,
        protocolRecipientsExtracted,
        cat: 'pumpswap' 
      }); } catch (e) { logCatchError('pools.pumpswap', e); }
      
    } catch (e: any) {
      try { logger.warn('pumpswap.rpc.enrichment.batch.failed', { 
        batch: Math.floor(i / batchSize) + 1, 
        error: String(e?.message || e), 
        cat: 'pumpswap' 
      }); } catch (e) { logCatchError('pools.pumpswap', e); }
      // On error, add pools without enrichment
      enriched.push(...batch);
      failCount += batch.length;
    }
  }
  
  const ms = Date.now() - t0;
  
  try { logger.info('pumpswap.rpc.enrichment.complete', { 
    total: pools.length, 
    success: successCount, 
    fail: failCount,
    feesExtracted,
    protocolRecipientsExtracted,
    ms,
    cat: 'pumpswap' 
  }); } catch (e) { logCatchError('pools.pumpswap', e); }
  
  // Phase 2: Fetch Metaplex metadata for meme tokens to cache metadata_creator
  // This eliminates RPC calls during transaction building
  const enableMetadataFetch = ((CONFIG as any)?.pumpswap?.enableMetadataFetch !== false);
  let metadataFetched = 0;
  
  if (enableMetadataFetch) {
    try {
      const SOL_MINT = 'So11111111111111111111111111111111111111112';
      const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
      const METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
      
      // Collect unique meme token mints (not SOL/USDC)
      const memeTokenMints = new Map<string, number[]>(); // mint -> pool indices
      for (let i = 0; i < enriched.length; i++) {
        const pool = enriched[i];
        const baseMint = pool.base_mint;
        const quoteMint = pool.quote_mint;
        
        // Identify meme token (not SOL or USDC)
        let memeMint: string | null = null;
        if (baseMint && baseMint !== SOL_MINT && baseMint !== USDC_MINT) {
          memeMint = baseMint;
        } else if (quoteMint && quoteMint !== SOL_MINT && quoteMint !== USDC_MINT) {
          memeMint = quoteMint;
        }
        
        if (memeMint) {
          if (!memeTokenMints.has(memeMint)) {
            memeTokenMints.set(memeMint, []);
          }
          memeTokenMints.get(memeMint)!.push(i);
        }
      }
      
      if (memeTokenMints.size > 0) {
        logger.info('pumpswap.metadata.fetch.start', {
          uniqueMints: memeTokenMints.size,
          cat: 'pumpswap'
        });
        
        // Fetch metadata in batches
        const mintList = Array.from(memeTokenMints.keys());
        const metadataCreators = new Map<string, string>(); // mint -> creator
        
        for (let i = 0; i < mintList.length; i += batchSize) {
          const batch = mintList.slice(i, i + batchSize);
          
          try {
            // Derive metadata PDAs
            const metadataPdas: PublicKey[] = [];
            for (const mint of batch) {
              try {
                const mintPk = new PublicKey(mint);
                const [pda] = PublicKey.findProgramAddressSync(
                  [
                    Buffer.from('metadata'),
                    METADATA_PROGRAM_ID.toBuffer(),
                    mintPk.toBuffer(),
                  ],
                  METADATA_PROGRAM_ID
                );
                metadataPdas.push(pda);
              } catch {}
            }
            
            if (metadataPdas.length > 0) {
              const metadataAccounts = await withRpcLimit(
                () => connection.getMultipleAccountsInfo(metadataPdas),
                Math.max(1, Math.ceil(metadataPdas.length / 100)),
                { module: 'pools', method: 'getMultipleAccountsInfo' }
              );
              
              for (let j = 0; j < batch.length; j++) {
                const mint = batch[j];
                const account = metadataAccounts[j];
                
                if (account?.data && account.data.length >= 33) {
                  try {
                    // Update authority is at bytes 1-33 in Metaplex metadata
                    const updateAuthority = new PublicKey(account.data.subarray(1, 33));
                    metadataCreators.set(mint, updateAuthority.toBase58());
                    metadataFetched++;
                  } catch {}
                }
              }
            }
          } catch (e: any) {
            logger.debug('pumpswap.metadata.batch.failed', {
              batch: Math.floor(i / batchSize) + 1,
              error: String(e?.message || e),
              cat: 'pumpswap'
            });
          }
        }
        
        // Apply metadata_creator to pools
        for (const [mint, poolIndices] of memeTokenMints.entries()) {
          const metadataCreator = metadataCreators.get(mint);
          if (metadataCreator) {
            for (const idx of poolIndices) {
              enriched[idx].metadata_creator = metadataCreator;
            }
          }
        }
        
        logger.info('pumpswap.metadata.fetch.complete', {
          uniqueMints: memeTokenMints.size,
          metadataFetched,
          cat: 'pumpswap'
        });
      }
    } catch (e: any) {
      logger.warn('pumpswap.metadata.fetch.failed', {
        error: String(e?.message || e),
        cat: 'pumpswap'
      });
    }
  }
  
  return { pools: enriched, metrics: { success: successCount, fail: failCount, ms, feesExtracted, protocolRecipientsExtracted } };
}

export async function normalizePumpswapPools(raw: PumpswapPoolApiResponse[] | unknown): Promise<PoolsPayload> {
  const now = Date.now();
  const amm: AmmPool[] = [];
  const rawArr: unknown[] = Array.isArray(raw) ? raw : [];
  const pools = rawArr.filter(isValidPumpswapPool);
  
  const defaultFeeBps = Number((CONFIG as any)?.pumpswap?.defaultFeeBps || 25);
  const minLiqBase = Number((CONFIG as any)?.pumpswap?.minLiqBase || 0);

  // Warm fee config cache (GlobalConfig + FeeConfig PDAs) for per-pool fee computation
  try {
    const connection = getConnection();
    await ensurePumpswapFeeConfig(connection);
  } catch (e) {
    logCatchError('pumpswap.normalize.ensureFeeConfig', e);
  }

  // Extract all unique mints for batch decimal resolution
  const allMints = new Set<string>();
  for (const pool of pools) {
    if (pool.base_mint) allMints.add(pool.base_mint);
    if (pool.quote_mint) allMints.add(pool.quote_mint);
  }
  
  // Batch resolve decimals using centralized resolver with RPC-first validation
  const decimalsMap = await resolveManyDecimals(Array.from(allMints), { 
    logger, 
    normalizeMode: true // RPC validation priority during normalization
  });
  
  for (const pool of pools) {
    try {
      const id = pool.pubkey;
      const mint_a = pool.base_mint;
      const mint_b = pool.quote_mint;
      
      if (!id || !mint_a || !mint_b) continue;
      
      // VALIDATION: Ensure pool ID is not a vault address
      if (id === pool.pool_base_token_account || id === pool.pool_quote_token_account) {
        try {
          logger.warn('pumpswap.pool_id_is_vault', {
            id: id.slice(0, 8) + '…',
            baseVault: pool.pool_base_token_account?.slice(0, 8) + '…',
            quoteVault: pool.pool_quote_token_account?.slice(0, 8) + '…',
            cat: 'pumpswap'
          });
        } catch (e) { logCatchError('pools.pumpswap', e); }
        continue; // Skip this pool
      }
      
      // Compute per-pool fees using cached GlobalConfig/FeeConfig (market-cap-based tiers)
      const computedFees = computePumpswapPoolFees({
        onchain_base_mint: mint_a,
        native_mint_a: mint_a,
        creator: pool.onchain_creator || pool.creator,
        coinCreator: pool.onchain_creator || pool.creator,
        native_reserve_a_raw: pool.base_reserve,
        native_reserve_b_raw: pool.quote_reserve,
        base_reserve: pool.base_reserve,
        quote_reserve: pool.quote_reserve,
      });
      const feeBps = computedFees.totalFeeBps;
      
      // Get decimals from centralized resolver (avoid silent defaults)
      let decA = decimalsMap.get(mint_a);
      let decB = decimalsMap.get(mint_b);

      if (!Number.isFinite(decA)) {
        const resolved = await resolveDecimalsGuaranteed(mint_a, id, 'Pumpswap');
        decA = resolved.decimals;
        if (resolved.source === 'default' && !resolved.validated) {
          logger.warn('pumpswap.decimals.fallback_default', {
            mint: mint_a.slice(0, 8) + '…',
            pool: id.slice(0, 8) + '…',
            defaultDecimals: decA,
            warning: 'Token decimals unknown - price may be incorrect',
            cat: 'pumpswap'
          });
        }
      }
      if (!Number.isFinite(decB)) {
        const resolved = await resolveDecimalsGuaranteed(mint_b, id, 'Pumpswap');
        decB = resolved.decimals;
        if (resolved.source === 'default' && !resolved.validated) {
          logger.warn('pumpswap.decimals.fallback_default', {
            mint: mint_b.slice(0, 8) + '…',
            pool: id.slice(0, 8) + '…',
            defaultDecimals: decB,
            warning: 'Token decimals unknown - price may be incorrect',
            cat: 'pumpswap'
          });
        }
      }
      
      // Calculate price and liquidity from RPC-enriched reserves
      let price_a_per_b = 0;
      let liquidity_base = 0;
      let baseReserve = 0;
      let quoteReserve = 0;
      let baseReserveRaw = 0n;
      let quoteReserveRaw = 0n;
      let baseUsdPrice = 0;
      let quoteUsdPrice = 0;
      let pool_liquidity_raw = 0;
      let price_a_per_b_exact: string | undefined;
      
      // Variables to store processed/canonical values from pipeline
      let finalMintA = mint_a;
      let finalMintB = mint_b;
      let finalDecA = decA;
      let finalDecB = decB;
      let wasSwapped = false;
      let finalBaseReserve = baseReserve;
      let finalQuoteReserve = quoteReserve;
      
      if (pool.base_reserve && pool.quote_reserve) {
        try {
          // Parse reserves as BigInt from string
          baseReserveRaw = BigInt(pool.base_reserve);
          quoteReserveRaw = BigInt(pool.quote_reserve);
          
          // RUGPULL DETECTION: Check LP supply
          const lpSupply = pool.lp_supply ? BigInt(pool.lp_supply) : 0n;
          
          if (lpSupply === 0n) {
            // No LP tokens = rugpulled pool, skip entirely
            try { 
              logger.debug('pumpswap.normalize.rugpull_detected', { 
                pool: id, 
                mint_a,
                mint_b,
                baseReserve: pool.base_reserve,
                quoteReserve: pool.quote_reserve,
                lpSupply: '0',
                cat: 'pumpswap' 
              }); 
            } catch (e) { logCatchError('pools.pumpswap', e); }
            continue;  // Skip this pool
          }
          
          // Check for suspiciously low LP supply relative to reserves
          const minReserve = baseReserveRaw < quoteReserveRaw ? baseReserveRaw : quoteReserveRaw;
          if (lpSupply > 0n && minReserve > 1_000_000_000n && lpSupply < 1000n) {
            // Likely rugpull: high reserves but nearly zero LP supply
            try { 
              logger.warn('pumpswap.normalize.low_lp_supply', { 
                pool: id,
                mint_a,
                mint_b,
                minReserve: minReserve.toString(),
                lpSupply: lpSupply.toString(),
                cat: 'pumpswap' 
              }); 
            } catch (e) { logCatchError('pools.pumpswap', e); }
            continue;  // Skip suspicious pools
          }
          
          // Convert to whole tokens using decimals
          baseReserve = Number(baseReserveRaw) / Math.pow(10, decA);
          quoteReserve = Number(quoteReserveRaw) / Math.pow(10, decB);
          
          // Update final reserves with actual values
          finalBaseReserve = baseReserve;
          finalQuoteReserve = quoteReserve;
          
          // Calculate raw price using centralized formula helper
          const { priceFromReserves } = await import('./priceFormulas.js');
          const rawPrice = priceFromReserves(baseReserveRaw, quoteReserveRaw, decA, decB);
          
          // Process through centralized pipeline (canonicalization only - no calibration)
          if (rawPrice && rawPrice > 0 && Number.isFinite(rawPrice)) {
            try {
              const { processPriceThroughPipeline } = await import('./pricePipeline.js');
              
              const processed = processPriceThroughPipeline({
                mintA: mint_a,
                mintB: mint_b,
                rawPrice,
                decimalsA: decA,
                decimalsB: decB,
                poolId: id,
                dex: 'Pumpswap',
                poolType: 'amm'
              });
              
              if (processed) {
                wasSwapped = processed.wasSwapped === true;
                // Update to canonical order
                finalMintA = processed.mintA;
                finalMintB = processed.mintB;
                finalDecA = processed.decimalsA;
                finalDecB = processed.decimalsB;
                price_a_per_b = processed.priceForward;
                
                // If mints were swapped, also swap reserves
                if (wasSwapped) {
                  finalBaseReserve = quoteReserve;
                  finalQuoteReserve = baseReserve;
                }
              } else {
                price_a_per_b = rawPrice;
              }
            } catch (err) {
              // Fallback to raw price if pipeline fails
              price_a_per_b = rawPrice;
              try {
                logger.warn('pumpswap.pipeline.failed', {
                  pool: id,
                  error: String(err),
                  cat: 'pumpswap'
                });
              } catch (e) { logCatchError('pools.pumpswap', e); }
            }
          }
          
          // Calculate high-precision price for exact calculations with proper decimal adjustment
          // Correct AMM formula: price_a_per_b = reserveB / reserveA = (quoteRaw / 10^decB) / (baseRaw / 10^decA)
          //                    = (quoteRaw * 10^decA) / (baseRaw * 10^decB)
          if (baseReserveRaw > 0n) {
            try {
              const numerator = quoteReserveRaw * BigInt(Math.pow(10, decA));
              const denominator = baseReserveRaw * BigInt(Math.pow(10, decB));
              const priceExactBigInt = numerator / denominator;
              price_a_per_b_exact = priceExactBigInt.toString();
            } catch (e) { logCatchError('pools.pumpswap', e); }
          }
          
          // Try to get USD prices from the price store
          try {
            const { getPriceByMint } = await import('../priceStore.js');
            const priceA = getPriceByMint(mint_a);
            const priceB = getPriceByMint(mint_b);
            if (priceA?.usdc) baseUsdPrice = priceA.usdc;
            if (priceB?.usdc) quoteUsdPrice = priceB.usdc;
          } catch (e) { logCatchError('pools.pumpswap', e); }
          
          // Calculate USD liquidity if we have prices
          if (baseUsdPrice > 0 && quoteUsdPrice > 0) {
            const baseUsdValue = baseReserve * baseUsdPrice;
            const quoteUsdValue = quoteReserve * quoteUsdPrice;
            liquidity_base = baseUsdValue + quoteUsdValue;
            // pool_liquidity_raw is the minimum of the two sides (for routing preference)
            pool_liquidity_raw = Math.min(baseUsdValue, quoteUsdValue);
          } else if (baseUsdPrice > 0) {
            liquidity_base = baseReserve * baseUsdPrice * 2; // Estimate total from one side
            pool_liquidity_raw = baseReserve * baseUsdPrice;
          } else if (quoteUsdPrice > 0) {
            liquidity_base = quoteReserve * quoteUsdPrice * 2;
            pool_liquidity_raw = quoteReserve * quoteUsdPrice;
          } else if (mint_b === USDC_MINT) {
            // If quote is USDC, use quote reserve * 2 as USD liquidity
            liquidity_base = quoteReserve * 2;
            pool_liquidity_raw = quoteReserve;
          } else if (mint_a === USDC_MINT) {
            // If base is USDC, use base reserve * 2 as USD liquidity
            liquidity_base = baseReserve * 2;
            pool_liquidity_raw = baseReserve;
          } else {
            // No USD prices available, use minimum reserve as heuristic
            pool_liquidity_raw = Math.min(baseReserve, quoteReserve);
          }
        } catch (e: any) {
          try { logger.warn('pumpswap.normalize.price.calc.failed', { 
            pool: id, 
            error: String(e?.message || e), 
            cat: 'pumpswap' 
          }); } catch (e) { logCatchError('pools.pumpswap', e); }
        }
      }
      
      // Skip pools below minimum liquidity threshold
      if (minLiqBase > 0 && liquidity_base < minLiqBase) {
        try { logger.debug('pumpswap.normalize.pool.skip.min_liq', { 
          pool: id, 
          liquidity: liquidity_base, 
          minLiqBase, 
          cat: 'pumpswap' 
        }); } catch (e) { logCatchError('pools.pumpswap', e); }
        continue;
      }
      
      amm.push({
        id,
        dex: 'Pumpswap',
        mint_a: finalMintA,
        mint_b: finalMintB,
        fee_bps: feeBps,
        fee_lp_bps: computedFees.lpFeeBps,
        fee_protocol_bps: computedFees.protocolFeeBps,
        fee_creator_bps: computedFees.creatorFeeBps,
        fee_source: computedFees.source,
        price_a_per_b,
        liquidity_base,
        updated_ms: now,
        // FIX: Swap accounts to match canonical mint order
        account_a: wasSwapped ? pool.pool_quote_token_account : pool.pool_base_token_account,
        account_b: wasSwapped ? pool.pool_base_token_account : pool.pool_quote_token_account,
        pool_kind: 'amm',
        lp_mint: pool.lp_mint,
        lp_supply: pool.lp_supply || undefined, // Store LP supply for reference
        // Decimals for proper unit conversion (now canonical after pipeline)
        decimals_a: finalDecA,
        decimals_b: finalDecB,
        // Whole unit amounts (human-readable) - matches other DEX implementations
        amount_a_whole: finalBaseReserve,
        amount_b_whole: finalQuoteReserve,
        amounts_are_whole: true,
        // FIX: Swap reserves to match canonical mint order
        reserve_a_raw: wasSwapped ? pool.quote_reserve : pool.base_reserve,
        reserve_b_raw: wasSwapped ? pool.base_reserve : pool.quote_reserve,
        was_swapped: wasSwapped,
        native_mint_a: mint_a,
        native_mint_b: mint_b,
        native_decimals_a: decA,
        native_decimals_b: decB,
        native_account_a: pool.pool_base_token_account,
        native_account_b: pool.pool_quote_token_account,
        native_reserve_a_raw: pool.base_reserve || undefined,
        native_reserve_b_raw: pool.quote_reserve || undefined,
        // Liquidity metrics for routing and filtering
        pool_liquidity_raw,
        liquidity_display: liquidity_base || pool_liquidity_raw,
        // High-precision price for exact calculations (if available)
        price_a_per_b_exact,
        // TVL in USD if we could calculate it
        tvl_usd: liquidity_base > 0 ? liquidity_base : undefined,
        // Store original on-chain mint and vault order BEFORE canonicalization
        // This is critical for instruction building to avoid RPC calls
        onchain_base_mint: mint_a,  // Original base mint from on-chain pool
        onchain_quote_mint: mint_b, // Original quote mint from on-chain pool
        onchain_base_vault: pool.pool_base_token_account,  // Original base vault
        onchain_quote_vault: pool.pool_quote_token_account, // Original quote vault
        creator: pool.onchain_creator || pool.creator, // On-chain pool creator (extracted from pool account data during enrichment)
        metadata_creator: (pool as any).metadata_creator || undefined, // Metaplex metadata update authority (for deriving creator vaults)
        protocol_fee_recipient: pool.protocol_fee_recipient || undefined, // On-chain protocol fee recipient (offset 243)
        _pipelineProcessed: true, // Mark as processed by pipeline
      } as any);
    } catch (e: any) {
      try { logger.warn('pumpswap.normalize.pool.failed', { error: String(e?.message || e), cat: 'pumpswap' }); } catch (e) { logCatchError('pools.pumpswap', e); }
    }
  }
  
  // Pools are already canonicalized by the price pipeline - no second pass needed
  // The pipeline sets was_swapped, swaps mints/decimals, and inverts price correctly
  const ammCanon = amm;

  // Verify canonicalization: ensure price inversion happens correctly when mints are swapped
  try {
    const ammVerification = verifyCanonicalization(ammCanon, swapABFields);
    if (!ammVerification.valid) {
      try {
        logger.warn('pumpswap.canonicalization.verification.failed', {
          errors: ammVerification.errors.length,
          cat: 'pumpswap'
        });
      } catch (e) { logCatchError('pools.pumpswap', e); }
    }
  } catch (e) { logCatchError('pools.pumpswap', e); }
  
  try {
    const canon = String(((CONFIG as any)?.system?.canonicalizePairs) || 'quoteHierarchy');
    const withPrice = ammCanon.filter(p => p.price_a_per_b > 0).length;
    const withLiq = ammCanon.filter(p => p.liquidity_base > 0).length;
    const withWholeAmounts = ammCanon.filter(p => p.amount_a_whole && p.amount_b_whole).length;
    const withTvl = ammCanon.filter(p => p.tvl_usd && p.tvl_usd > 0).length;
    const withLpSupply = ammCanon.filter(p => p.lp_supply && p.lp_supply !== '0').length;
    const defaultFeeBps = Number((CONFIG as any)?.pumpswap?.defaultFeeBps || 25);
    const poolsWithExtractedFee = ammCanon.filter(p => {
      const feeBps = Number(p.fee_bps);
      return feeBps !== defaultFeeBps && feeBps > 0 && feeBps <= 10000;
    }).length;
    const poolsUsingDefaultFee = ammCanon.filter(p => {
      const feeBps = Number(p.fee_bps);
      return feeBps === defaultFeeBps;
    }).length;
    logger.info('pumpswap.graphql normalized', { 
      total: ammCanon.length, 
      withPrice, 
      withLiq,
      withWholeAmounts,
      withTvl,
      withLpSupply,
      poolsWithExtractedFee,  // Number of pools with fee extracted from RPC
      poolsUsingDefaultFee,   // Number of pools using the default fee
      defaultFeeBpsValue: defaultFeeBps,  // The actual default fee value in bps
      cat: 'pumpswap', 
      canon 
    });
  } catch (e) { logCatchError('pools.pumpswap', e); }
  
  // Populate executionCache for Pumpswap pools (enables zero-RPC builds)
  try {
    const { executionCache } = await import('../../execution/cache.js');
    let pumpswapCached = 0;
    let withMetadataCreator = 0;
    
    for (const pool of ammCanon) {
      try {
        const existing = executionCache.getStatic(pool.id) || {};
        executionCache.setStatic(pool.id, {
          ...existing,
          programId: PUMPSWAP_PROGRAM_ID,
          dex: 'Pumpswap',
          pool_kind: 'amm',
          mint_a: pool.mint_a,
          mint_b: pool.mint_b,
          decimals_a: pool.decimals_a,
          decimals_b: pool.decimals_b,
          vault_a: pool.account_a,
          vault_b: pool.account_b,
          // Critical: Store on-chain order fields for transaction building
          onchain_base_mint: (pool as any).onchain_base_mint,
          onchain_quote_mint: (pool as any).onchain_quote_mint,
          onchain_base_vault: (pool as any).onchain_base_vault,
          onchain_quote_vault: (pool as any).onchain_quote_vault,
          creator: (pool as any).creator,
          metadata_creator: (pool as any).metadata_creator,
          protocol_fee_recipient: (pool as any).protocol_fee_recipient,
          lp_mint: pool.lp_mint,
        });
        pumpswapCached++;
        if ((pool as any).metadata_creator) withMetadataCreator++;
      } catch {}
    }
    
    logger.info('pumpswap.execution_cache.populated', {
      pumpswapCached,
      withMetadataCreator,
      total: ammCanon.length,
      cat: 'pumpswap'
    });
  } catch (cacheErr) {
    logger.debug('pumpswap.execution_cache.failed', {
      error: String((cacheErr as any)?.message || cacheErr),
      cat: 'pumpswap'
    });
  }
  
  return { amm: ammCanon, clmm: [], cpmm: [] };
}

