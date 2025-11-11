import { logger } from '../../utils/logger.js';
import { emit } from '../realtime.js';
import { CONFIG } from '../../utils/config.js';
import { writeJson, joinPath } from '../../utils/fs.js';
import type { AmmPool, PoolsPayload } from './types.js';
import { canonicalizePairs, validateHttpUrl, swapABFields } from './common.js';
import { verifyCanonicalization } from './validation.js';
import { httpLogStart, httpLogResponse, httpLog429, httpLogNonOk } from './httpLog.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export async function fetchPumpswapGraphQL(): Promise<any> {
  const CACHE_PATH = joinPath(CONFIG.cacheDir, 'pumpswap-raw-sample.json');
  const apiKey = (CONFIG as any)?.pumpswap?.shyftApiKey || '';
  if (!apiKey) {
    try { logger.warn('pumpswap.graphql apiKey missing', { cat: 'pumpswap' }); } catch {}
    return [];
  }

  const retries = Number((CONFIG as any)?.pumpswap?.maxHttpRetries || 2);
  const backoffMs = Number((CONFIG as any)?.pumpswap?.httpBackoffMs || 500);
  const pageSize = Number((CONFIG as any)?.pumpswap?.pageSize || 1000);
  const maxPages = Number((CONFIG as any)?.pumpswap?.maxPages || 10);
  
  const pools = new Map<string, any>(); // Dedupe by pubkey
  
  // Fetch pools involving SOL
  const solPools = await fetchPoolsForToken(SOL_MINT, apiKey, retries, backoffMs, pageSize, maxPages);
  for (const p of solPools) pools.set(p.pubkey, p);
  
  // Fetch pools involving USDC
  const usdcPools = await fetchPoolsForToken(USDC_MINT, apiKey, retries, backoffMs, pageSize, maxPages);
  for (const p of usdcPools) pools.set(p.pubkey, p);
  
  const allPools = Array.from(pools.values());
  try { await writeJson(CACHE_PATH, allPools); } catch (e: any) {
    try { logger.warn('pumpswap.cache write failed', { file: CACHE_PATH, error: String(e?.message || e), cat: 'pumpswap' }); } catch {}
  }
  try { logger.info('pumpswap.graphql raw', { count: allPools.length, cat: 'pumpswap' }); } catch {}
  return allPools;
}

async function fetchPoolsForToken(
  mintAddress: string, 
  apiKey: string, 
  retries: number, 
  backoffMs: number,
  pageSize: number,
  maxPages: number
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
          try { emit('log', { level: 'warn', message: 'arb:429 source=pumpswap kind=graphql', timestamp: new Date().toISOString(), context: { cat: 'arb' } }); } catch {}
          try { logger.warn('pumpswap.graphql 429', { mint: mintAddress, page, cat: 'pumpswap' }); } catch {}
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
          try { logger.warn('pumpswap.graphql errors', { errors: JSON.stringify(json.errors), cat: 'pumpswap' }); } catch {}
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
        try { logger.warn('pumpswap.graphql fetch failed', { mint: mintAddress, page, error: msg, cat: 'pumpswap' }); } catch {}
        break; // Exit retry loop on final failure
      }
    }
    
    if (pagePools.length === 0) {
      // No more results, exit pagination loop
      break;
    }
    
    allPools.push(...pagePools);
    try { logger.debug('pumpswap.graphql page', { mint: mintAddress, page, count: pagePools.length, total: allPools.length, cat: 'pumpswap' }); } catch {}
    
    // If we got fewer results than pageSize, we've reached the end
    if (pagePools.length < pageSize) {
      break;
    }
    
    offset += pageSize;
    page++;
  }
  
  return allPools;
}

export async function normalizePumpswapPools(raw: any): Promise<PoolsPayload> {
  const now = Date.now();
  const amm: AmmPool[] = [];
  const pools = Array.isArray(raw) ? raw : [];
  
  const defaultFeeBps = Number((CONFIG as any)?.pumpswap?.defaultFeeBps || 30);
  const minLiqBase = Number((CONFIG as any)?.pumpswap?.minLiqBase || 0);
  
  for (const pool of pools) {
    try {
      const id = pool.pubkey;
      const mint_a = pool.base_mint;
      const mint_b = pool.quote_mint;
      
      if (!id || !mint_a || !mint_b) continue;
      
      // Note: Shyft doesn't provide reserve data in this query
      // For now, set placeholder values - could be enriched via RPC later
      const price_a_per_b = 0; // Would need reserve data
      const liquidity_base = 0; // Would need reserve data or lp_supply calculation
      
      if (minLiqBase > 0 && liquidity_base < minLiqBase) continue;
      
      amm.push({
        id,
        dex: 'Pumpswap',
        mint_a,
        mint_b,
        fee_bps: defaultFeeBps,
        price_a_per_b,
        liquidity_base,
        updated_ms: now,
        account_a: pool.pool_base_token_account,
        account_b: pool.pool_quote_token_account,
        pool_kind: 'amm',
        lp_mint: pool.lp_mint,
      });
    } catch (e: any) {
      try { logger.warn('pumpswap.normalize.pool.failed', { error: String(e?.message || e), cat: 'pumpswap' }); } catch {}
    }
  }
  
  // Apply canonicalization like other DEXes
  const ammCanon = canonicalizePairs(amm);
  
  // Verify canonicalization: ensure price inversion happens correctly when mints are swapped
  try {
    const ammVerification = verifyCanonicalization(ammCanon, swapABFields);
    if (!ammVerification.valid) {
      try {
        logger.warn('pumpswap.canonicalization.verification.failed', {
          errors: ammVerification.errors.length,
          cat: 'pumpswap'
        });
      } catch {}
    }
  } catch {}
  
  try {
    const canon = String(((CONFIG as any)?.system?.canonicalizePairs) || 'quoteHierarchy');
    logger.info('pumpswap.graphql normalized', { amm: ammCanon.length, cat: 'pumpswap', canon });
  } catch {}
  
  return { amm: ammCanon, clmm: [] };
}

