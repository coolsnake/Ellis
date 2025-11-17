import { logger } from '../../utils/logger.js';
import { CONFIG } from '../../utils/config.js';
import { writeJson, joinPath } from '../../utils/fs.js';
import type { ClmmPool, PoolsPayload } from './types.js';
import { canonicalizePools } from './canonical.js';
import { resolveManyDecimals } from './decimals.js';
import { httpLogStart, httpLogResponse, httpLog429, httpLogNonOk } from './httpLog.js';
import { processPriceThroughPipeline } from './pricePipeline.js';

export async function fetchOrcaGraphQL(mints: string[]): Promise<any[]> {
  const CACHE_PATH = joinPath(CONFIG.cacheDir, 'orca-graphql-raw.json');
  
  // Get API key using fallback chain
  const apiKey = (CONFIG as any)?.orca?.shyftApiKey || 
                 (CONFIG as any)?.pumpswap?.shyftApiKey || 
                 (CONFIG as any)?.shyft?.apiKey || 
                 '';
  
  if (!apiKey) {
    logger.warn('orca.graphql.apiKey.missing', { cat: 'orca' });
    return [];
  }
  
  const retries = Number((CONFIG as any)?.orca?.maxHttpRetries || 2);
  const backoffMs = Number((CONFIG as any)?.orca?.httpBackoffMs || 500);
  const pageSize = Number((CONFIG as any)?.orca?.pageSize || 1000);
  const maxPages = Number((CONFIG as any)?.orca?.maxPages || 10);
  const pageDelayMs = Number((CONFIG as any)?.orca?.pageDelayMs || 200);
  
  const poolsMap = new Map<string, any>();
  
  for (const mint of mints) {
    try {
      const pools = await fetchOrcaPoolsForToken(
        mint, apiKey, retries, backoffMs, pageSize, maxPages, pageDelayMs
      );
      for (const pool of pools) {
        poolsMap.set(pool.pubkey, pool);
      }
      
      logger.debug('orca.graphql.mint.fetched', { 
        mint: mint.slice(0, 8), 
        count: pools.length,
        total: poolsMap.size,
        cat: 'orca' 
      });
      
      if (pageDelayMs > 0 && mints.indexOf(mint) < mints.length - 1) {
        await new Promise(r => setTimeout(r, pageDelayMs));
      }
    } catch (e: any) {
      logger.warn('orca.graphql.mint.failed', { 
        mint: mint.slice(0, 8), 
        error: String(e?.message || e), 
        cat: 'orca' 
      });
    }
  }
  
  const allPools = Array.from(poolsMap.values());
  try { await writeJson(CACHE_PATH, allPools); } catch (e: any) {
    logger.warn('orca.graphql.cache.write.failed', { 
      file: CACHE_PATH, 
      error: String(e?.message || e), 
      cat: 'orca' 
    });
  }
  
  logger.info('orca.graphql.complete', { count: allPools.length, mints: mints.length, cat: 'orca' });
  return allPools;
}

async function fetchOrcaPoolsForToken(
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
      query GetOrcaPools {
        ORCA_WHIRLPOOLS_whirlpool(
          where: {_or: [
            {tokenMintA: {_eq: "${mintAddress}"}}, 
            {tokenMintB: {_eq: "${mintAddress}"}}
          ]},
          limit: ${pageSize},
          offset: ${offset}
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
          source: 'orca', 
          url: `${url}?${params}`, 
          extra: { mint: mintAddress, page, offset } 
        });
        
        const res = await fetchFn(`${url}?${params}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, operationName: 'GetOrcaPools' })
        });
        
        if (res?.status === 429) {
          logger.warn('orca.graphql 429', { mint: mintAddress, page, cat: 'orca' });
          httpLog429({ source: 'orca', url: `${url}?${params}`, cid });
          if (attempt < retries) {
            await new Promise(r => setTimeout(r, backoffMs * (attempt + 1)));
            continue;
          }
          throw new Error('429');
        }
        
        if (!res?.ok) {
          httpLogNonOk({ source: 'orca', url: `${url}?${params}`, cid, status: res?.status });
          throw new Error(`http ${res?.status}`);
        }
        
        const json = await res.json();
        
        if (json?.errors) {
          logger.warn('orca.graphql errors', { 
            errors: JSON.stringify(json.errors), 
            cat: 'orca' 
          });
          throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
        }
        
        pagePools = json?.data?.ORCA_WHIRLPOOLS_whirlpool || [];
        httpLogResponse({ 
          source: 'orca', 
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
        logger.warn('orca.graphql fetch failed', { 
          mint: mintAddress, 
          page, 
          error: msg, 
          cat: 'orca' 
        });
        break;
      }
    }
    
    if (pagePools.length === 0) break;
    
    allPools.push(...pagePools);
    logger.debug('orca.graphql page', { 
      mint: mintAddress, 
      page, 
      count: pagePools.length, 
      total: allPools.length, 
      cat: 'orca' 
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
      } as any);
    } catch (error: any) {
      logger.warn('orca.graphql.normalize.pool.failed', { 
        error: String(error?.message || error), 
        cat: 'orca' 
      });
    }
  }
  
  const clmmCanon = canonicalizePools(clmm);
  
  // Pre-populate Orca pool states cache (keep existing pattern)
  try {
    const { populateOrcaPoolStates } = await import('./orca.js');
    await populateOrcaPoolStates(clmmCanon);
  } catch (e: any) {
    logger.warn('orca.graphql.populate_states.failed', {
      error: String(e?.message || e),
      cat: 'orca'
    });
  }
  
  logger.info('orca.graphql.normalized', { clmm: clmmCanon.length, cat: 'orca' });
  
  return { amm: [], clmm: clmmCanon };
}

