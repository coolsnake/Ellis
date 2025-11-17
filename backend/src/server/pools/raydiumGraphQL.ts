import { logger } from '../../utils/logger.js';
import { CONFIG } from '../../utils/config.js';
import { writeJson, joinPath } from '../../utils/fs.js';
import type { AmmPool, ClmmPool, PoolsPayload } from './types.js';
import { canonicalizePools } from './canonical.js';
import { resolveManyDecimals } from './decimals.js';
import { httpLogStart, httpLogResponse, httpLog429, httpLogNonOk } from './httpLog.js';
import { processPriceThroughPipeline } from './pricePipeline.js';
import { priceFromReserves } from './priceFormulas.js';

export async function fetchRaydiumGraphQL(mints: string[]): Promise<any[]> {
  const CACHE_PATH = joinPath(CONFIG.cacheDir, 'raydium-graphql-raw.json');
  
  // Get API key using helper (will be created next)
  const apiKey = (CONFIG as any)?.raydium?.shyftApiKey || 
                 (CONFIG as any)?.pumpswap?.shyftApiKey || 
                 (CONFIG as any)?.shyft?.apiKey || 
                 '';
  
  if (!apiKey) {
    logger.warn('raydium.graphql.apiKey.missing', { cat: 'raydium' });
    return [];
  }
  
  const retries = Number((CONFIG as any)?.raydium?.maxHttpRetries || 2);
  const backoffMs = Number((CONFIG as any)?.raydium?.httpBackoffMs || 500);
  const pageSize = Number((CONFIG as any)?.raydium?.pageSize || 1000);
  const maxPages = Number((CONFIG as any)?.raydium?.maxPages || 10);
  const pageDelayMs = Number((CONFIG as any)?.raydium?.pageDelayMs || 200);
  
  const poolsMap = new Map<string, any>();
  
  for (const mint of mints) {
    try {
      const pools = await fetchRaydiumPoolsForToken(
        mint, apiKey, retries, backoffMs, pageSize, maxPages, pageDelayMs
      );
      for (const pool of pools) {
        poolsMap.set(pool.pubkey, pool);
      }
      
      logger.debug('raydium.graphql.mint.fetched', { 
        mint: mint.slice(0, 8), 
        count: pools.length,
        total: poolsMap.size,
        cat: 'raydium' 
      });
      
      if (pageDelayMs > 0 && mints.indexOf(mint) < mints.length - 1) {
        await new Promise(r => setTimeout(r, pageDelayMs));
      }
    } catch (e: any) {
      logger.warn('raydium.graphql.mint.failed', { 
        mint: mint.slice(0, 8), 
        error: String(e?.message || e), 
        cat: 'raydium' 
      });
    }
  }
  
  const allPools = Array.from(poolsMap.values());
  try { await writeJson(CACHE_PATH, allPools); } catch (e: any) {
    logger.warn('raydium.graphql.cache.write.failed', { 
      file: CACHE_PATH, 
      error: String(e?.message || e), 
      cat: 'raydium' 
    });
  }
  
  logger.info('raydium.graphql.complete', { count: allPools.length, mints: mints.length, cat: 'raydium' });
  return allPools;
}

async function fetchRaydiumPoolsForToken(
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
  
  // Use same pattern as Pumpswap: native fetch + GraphQL query string
  const fetchFn: any = (globalThis as any).fetch || fetch;
  
  while (page < maxPages) {
    // GraphQL query as string (same pattern as Pumpswap)
    const query = `
      query GetRaydiumPools {
        Raydium_LiquidityPoolv4(
          where: {_or: [
            {baseMint: {_eq: "${mintAddress}"}}, 
            {quoteMint: {_eq: "${mintAddress}"}}
          ]},
          limit: ${pageSize},
          offset: ${offset}
        ) {
          pubkey
          baseMint
          quoteMint
          baseDecimal
          quoteDecimal
          lpMint
          baseVault
          quoteVault
          marketId
          marketProgramId
          openOrders
          targetOrders
          owner
          poolOpenTime
          swapBaseInAmount
          swapQuoteInAmount
          swapBaseOutAmount
          swapQuoteOutAmount
          swapFeeNumerator
          swapFeeDenominator
          status
          state
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
    
    // Retry loop (same pattern as Pumpswap)
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const cid = httpLogStart({ 
          source: 'raydium', 
          url: `${url}?${params}`, 
          extra: { mint: mintAddress, page, offset } 
        });
        
        const res = await fetchFn(`${url}?${params}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, operationName: 'GetRaydiumPools' })
        });
        
        if (res?.status === 429) {
          logger.warn('raydium.graphql 429', { mint: mintAddress, page, cat: 'raydium' });
          httpLog429({ source: 'raydium', url: `${url}?${params}`, cid });
          if (attempt < retries) {
            await new Promise(r => setTimeout(r, backoffMs * (attempt + 1)));
            continue;
          }
          throw new Error('429');
        }
        
        if (!res?.ok) {
          httpLogNonOk({ source: 'raydium', url: `${url}?${params}`, cid, status: res?.status });
          throw new Error(`http ${res?.status}`);
        }
        
        const json = await res.json();
        
        if (json?.errors) {
          logger.warn('raydium.graphql errors', { 
            errors: JSON.stringify(json.errors), 
            cat: 'raydium' 
          });
          throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
        }
        
        pagePools = json?.data?.Raydium_LiquidityPoolv4 || [];
        httpLogResponse({ 
          source: 'raydium', 
          url: `${url}?${params}`, 
          cid, 
          status: res.status, 
          ms: 0, 
          count: pagePools.length 
        });
        break; // Success
      } catch (e: any) {
        const msg = String(e?.message || e);
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, backoffMs * (attempt + 1)));
          continue;
        }
        logger.warn('raydium.graphql fetch failed', { 
          mint: mintAddress, 
          page, 
          error: msg, 
          cat: 'raydium' 
        });
        break;
      }
    }
    
    if (pagePools.length === 0) break;
    
    allPools.push(...pagePools);
    logger.debug('raydium.graphql page', { 
      mint: mintAddress, 
      page, 
      count: pagePools.length, 
      total: allPools.length, 
      cat: 'raydium' 
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

