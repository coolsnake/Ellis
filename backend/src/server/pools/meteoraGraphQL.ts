import { logger } from '../../utils/logger.js';
import { CONFIG } from '../../utils/config.js';
import { writeJson, joinPath } from '../../utils/fs.js';
import type { ClmmPool, PoolsPayload } from './types.js';
import { canonicalizePools } from './canonical.js';
import { resolveManyDecimals } from './decimals.js';
import { httpLogStart, httpLogResponse, httpLog429, httpLogNonOk } from './httpLog.js';
import { processPriceThroughPipeline } from './pricePipeline.js';

export async function fetchMeteoraGraphQL(mints: string[]): Promise<any[]> {
  const CACHE_PATH = joinPath(CONFIG.cacheDir, 'meteora-graphql-raw.json');
  
  // Get API key using fallback chain
  const apiKey = (CONFIG as any)?.meteora?.shyftApiKey || 
                 (CONFIG as any)?.pumpswap?.shyftApiKey || 
                 (CONFIG as any)?.shyft?.apiKey || 
                 '';
  
  if (!apiKey) {
    logger.warn('meteora.graphql.apiKey.missing', { cat: 'meteora' });
    return [];
  }
  
  const retries = Number((CONFIG as any)?.meteora?.maxHttpRetries || 2);
  const backoffMs = Number((CONFIG as any)?.meteora?.httpBackoffMs || 500);
  const pageSize = Number((CONFIG as any)?.meteora?.pageSize || 1000);
  const maxPages = Number((CONFIG as any)?.meteora?.maxPages || 10);
  const pageDelayMs = Number((CONFIG as any)?.meteora?.pageDelayMs || 200);
  
  const poolsMap = new Map<string, any>();
  
  for (const mint of mints) {
    try {
      const pools = await fetchMeteoraPoolsForToken(
        mint, apiKey, retries, backoffMs, pageSize, maxPages, pageDelayMs
      );
      for (const pool of pools) {
        poolsMap.set(pool.baseKey || pool.pubkey, pool);
      }
      
      logger.debug('meteora.graphql.mint.fetched', { 
        mint: mint.slice(0, 8), 
        count: pools.length,
        total: poolsMap.size,
        cat: 'meteora' 
      });
      
      if (pageDelayMs > 0 && mints.indexOf(mint) < mints.length - 1) {
        await new Promise(r => setTimeout(r, pageDelayMs));
      }
    } catch (e: any) {
      logger.warn('meteora.graphql.mint.failed', { 
        mint: mint.slice(0, 8), 
        error: String(e?.message || e), 
        cat: 'meteora' 
      });
    }
  }
  
  const allPools = Array.from(poolsMap.values());
  try { await writeJson(CACHE_PATH, allPools); } catch (e: any) {
    logger.warn('meteora.graphql.cache.write.failed', { 
      file: CACHE_PATH, 
      error: String(e?.message || e), 
      cat: 'meteora' 
    });
  }
  
  logger.info('meteora.graphql.complete', { count: allPools.length, mints: mints.length, cat: 'meteora' });
  return allPools;
}

async function fetchMeteoraPoolsForToken(
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
  
  const fetchFn: any = (globalThis as any).fetch || fetch;
  
  while (page < maxPages) {
    const query = `
      query GetMeteoraPools {
        meteora_dlmm_LbPair(
          where: {_or: [
            {tokenXMint: {_eq: "${mintAddress}"}}, 
            {tokenYMint: {_eq: "${mintAddress}"}}
          ]},
          limit: ${pageSize},
          offset: ${offset}
        ) {
          baseKey
          pubkey
          tokenXMint
          tokenYMint
          reserveX
          reserveY
          binStep
          protocolFee
          liquidity
          activeId
          _updatedAt
        }
      }
    `;
    
    const url = 'https://programs.shyft.to/v0/graphql/accounts';
    const params = new URLSearchParams({ 
      api_key: apiKey, 
      network: 'mainnet-beta' 
    });
    
    let pagePools: any[] = [];
    
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const cid = httpLogStart({ 
          source: 'meteora', 
          url: `${url}?${params}`, 
          extra: { mint: mintAddress, page, offset } 
        });
        
        const res = await fetchFn(`${url}?${params}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, operationName: 'GetMeteoraPools' })
        });
        
        if (res?.status === 429) {
          logger.warn('meteora.graphql 429', { mint: mintAddress, page, cat: 'meteora' });
          httpLog429({ source: 'meteora', url: `${url}?${params}`, cid });
          if (attempt < retries) {
            await new Promise(r => setTimeout(r, backoffMs * (attempt + 1)));
            continue;
          }
          throw new Error('429');
        }
        
        if (!res?.ok) {
          httpLogNonOk({ source: 'meteora', url: `${url}?${params}`, cid, status: res?.status });
          throw new Error(`http ${res?.status}`);
        }
        
        const json = await res.json();
        
        if (json?.errors) {
          logger.warn('meteora.graphql errors', { 
            errors: JSON.stringify(json.errors), 
            cat: 'meteora' 
          });
          throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
        }
        
        pagePools = json?.data?.meteora_dlmm_LbPair || [];
        httpLogResponse({ 
          source: 'meteora', 
          url: `${url}?${params}`, 
          cid, 
          status: res.status, 
          ms: 0, 
          count: pagePools.length 
        });
        break;
      } catch (e: any) {
        const msg = String(e?.message || e);
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, backoffMs * (attempt + 1)));
          continue;
        }
        logger.warn('meteora.graphql fetch failed', { 
          mint: mintAddress, 
          page, 
          error: msg, 
          cat: 'meteora' 
        });
        break;
      }
    }
    
    if (pagePools.length === 0) break;
    
    allPools.push(...pagePools);
    logger.debug('meteora.graphql page', { 
      mint: mintAddress, 
      page, 
      count: pagePools.length, 
      total: allPools.length, 
      cat: 'meteora' 
    });
    
    if (pagePools.length < pageSize) break;
    
    offset += pageSize;
    page++;
    
    if (page < maxPages && pageDelayMs > 0) {
      await new Promise(r => setTimeout(r, pageDelayMs));
    }
  }
  
  return allPools;
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

