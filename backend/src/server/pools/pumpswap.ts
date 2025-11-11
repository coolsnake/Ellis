import { logger } from '../../utils/logger.js';
import { emit } from '../realtime.js';
import { CONFIG } from '../../utils/config.js';
import { writeJson, joinPath } from '../../utils/fs.js';
import type { AmmPool, PoolsPayload } from './types.js';
import { canonicalizePairs, validateHttpUrl, swapABFields } from './common.js';
import { verifyCanonicalization } from './validation.js';
import { httpLogStart, httpLogResponse, httpLog429, httpLogNonOk } from './httpLog.js';
import { PublicKey } from '@solana/web3.js';
import { getConnection } from '../../wallet/wallet.js';
import { withRpcLimit } from '../../utils/rpcLimiter.js';

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
  const pageDelayMs = Number((CONFIG as any)?.pumpswap?.pageDelayMs || 200);
  
  const pools = new Map<string, any>(); // Dedupe by pubkey
  
  // Fetch pools involving SOL
  const solPools = await fetchPoolsForToken(SOL_MINT, apiKey, retries, backoffMs, pageSize, maxPages, pageDelayMs);
  for (const p of solPools) pools.set(p.pubkey, p);
  
  // Small delay between token queries to avoid rate limiting
  if (pageDelayMs > 0) await new Promise(r => setTimeout(r, pageDelayMs));
  
  // Fetch pools involving USDC
  const usdcPools = await fetchPoolsForToken(USDC_MINT, apiKey, retries, backoffMs, pageSize, maxPages, pageDelayMs);
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
    
    // Add delay before next page request to avoid rate limiting
    if (page < maxPages && pageDelayMs > 0) {
      await new Promise(r => setTimeout(r, pageDelayMs));
    }
  }
  
  return allPools;
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
 * Enriches Pumpswap pools with RPC data (token account balances)
 * This allows us to calculate price and liquidity from actual reserves
 * Returns enriched pools and metrics for monitoring
 */
export async function enrichPumpswapPoolsWithRpc(pools: any[]): Promise<{ pools: any[]; metrics: { success: number; fail: number; ms: number } }> {
  if (!pools || pools.length === 0) return { pools, metrics: { success: 0, fail: 0, ms: 0 } };
  
  const batchSize = Number((CONFIG as any)?.pumpswap?.rpcBatchSize || 100);
  const enabled = ((CONFIG as any)?.pumpswap?.enableRpcEnrichment !== false);
  
  if (!enabled) {
    try { logger.debug('pumpswap.rpc.enrichment.disabled', { cat: 'pumpswap' }); } catch {}
    return { pools, metrics: { success: 0, fail: 0, ms: 0 } };
  }
  
  const connection = getConnection();
  const enriched: any[] = [];
  let successCount = 0;
  let failCount = 0;
  const t0 = Date.now();
  
  try { logger.info('pumpswap.rpc.enrichment.start', { poolCount: pools.length, batchSize, cat: 'pumpswap' }); } catch {}
  
  for (let i = 0; i < pools.length; i += batchSize) {
    const batch = pools.slice(i, i + batchSize);
    
    try {
      // Collect all vault addresses for this batch
      const vaultAddresses: PublicKey[] = [];
      const vaultMapping: Map<string, { poolIndex: number; side: 'base' | 'quote' }> = new Map();
      
      for (let j = 0; j < batch.length; j++) {
        const pool = batch[j];
        const poolIdx = i + j;
        
        if (pool.pool_base_token_account) {
          try {
            const pk = new PublicKey(pool.pool_base_token_account);
            vaultAddresses.push(pk);
            vaultMapping.set(pool.pool_base_token_account, { poolIndex: poolIdx, side: 'base' });
          } catch {}
        }
        
        if (pool.pool_quote_token_account) {
          try {
            const pk = new PublicKey(pool.pool_quote_token_account);
            vaultAddresses.push(pk);
            vaultMapping.set(pool.pool_quote_token_account, { poolIndex: poolIdx, side: 'quote' });
          } catch {}
        }
      }
      
      if (vaultAddresses.length === 0) {
        enriched.push(...batch);
        continue;
      }
      
      // Fetch all vault accounts in one RPC call
      const weight = Math.max(1, Math.ceil(vaultAddresses.length / 100));
      const accountInfos = await withRpcLimit(
        () => connection.getMultipleAccountsInfo(vaultAddresses),
        weight,
        { module: 'pools', method: 'getMultipleAccountsInfo' }
      );
      
      // Create a map of vault address -> balance
      const balances = new Map<string, bigint>();
      for (let k = 0; k < vaultAddresses.length; k++) {
        const info = accountInfos[k];
        if (info?.data) {
          const amount = parseTokenAccountAmount(info.data);
          if (amount !== null) {
            balances.set(vaultAddresses[k].toBase58(), amount);
          }
        }
      }
      
      // Enrich each pool in the batch with balance data
      for (const pool of batch) {
        const baseBalance = pool.pool_base_token_account ? balances.get(pool.pool_base_token_account) : null;
        const quoteBalance = pool.pool_quote_token_account ? balances.get(pool.pool_quote_token_account) : null;
        
        enriched.push({
          ...pool,
          base_reserve: baseBalance !== null ? baseBalance.toString() : undefined,
          quote_reserve: quoteBalance !== null ? quoteBalance.toString() : undefined,
        });
        
        if (baseBalance !== null && quoteBalance !== null) {
          successCount++;
        } else {
          failCount++;
        }
      }
      
      try { logger.debug('pumpswap.rpc.enrichment.batch', { 
        batch: Math.floor(i / batchSize) + 1, 
        vaultCount: vaultAddresses.length, 
        success: successCount, 
        fail: failCount,
        cat: 'pumpswap' 
      }); } catch {}
      
    } catch (e: any) {
      try { logger.warn('pumpswap.rpc.enrichment.batch.failed', { 
        batch: Math.floor(i / batchSize) + 1, 
        error: String(e?.message || e), 
        cat: 'pumpswap' 
      }); } catch {}
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
    ms,
    cat: 'pumpswap' 
  }); } catch {}
  
  return { pools: enriched, metrics: { success: successCount, fail: failCount, ms } };
}

export async function normalizePumpswapPools(raw: any): Promise<PoolsPayload> {
  const now = Date.now();
  const amm: AmmPool[] = [];
  const pools = Array.isArray(raw) ? raw : [];
  
  const defaultFeeBps = Number((CONFIG as any)?.pumpswap?.defaultFeeBps || 30);
  const minLiqBase = Number((CONFIG as any)?.pumpswap?.minLiqBase || 0);
  
  // Load Jupiter token map for decimals lookup
  let jupMap: Record<string, { decimals: number }> = {};
  try {
    const { loadJupiterTokenMap } = await import('../../utils/tokens.js');
    jupMap = await loadJupiterTokenMap().catch(() => ({} as any));
  } catch {}
  
  for (const pool of pools) {
    try {
      const id = pool.pubkey;
      const mint_a = pool.base_mint;
      const mint_b = pool.quote_mint;
      
      if (!id || !mint_a || !mint_b) continue;
      
      // Try to get decimals from Jupiter map or fallback to common values
      let decA = jupMap[mint_a]?.decimals;
      let decB = jupMap[mint_b]?.decimals;
      
      // Fallback to common token decimals
      if (!Number.isFinite(decA)) {
        if (mint_a === SOL_MINT) decA = 9;
        else decA = 6; // Most tokens use 6 decimals
      }
      if (!Number.isFinite(decB)) {
        if (mint_b === SOL_MINT) decB = 9;
        else if (mint_b === USDC_MINT) decB = 6;
        else decB = 6;
      }
      
      // Calculate price and liquidity from RPC-enriched reserves
      let price_a_per_b = 0;
      let liquidity_base = 0;
      
      if (pool.base_reserve && pool.quote_reserve) {
        try {
          // Parse reserves as BigInt from string
          const baseReserveRaw = BigInt(pool.base_reserve);
          const quoteReserveRaw = BigInt(pool.quote_reserve);
          
          // Convert to whole tokens using decimals
          const baseReserve = Number(baseReserveRaw) / Math.pow(10, decA);
          const quoteReserve = Number(quoteReserveRaw) / Math.pow(10, decB);
          
          // Price = amount of A per 1 unit of B
          if (quoteReserve > 0) {
            price_a_per_b = baseReserve / quoteReserve;
          }
          
          // For liquidity, we can use the formula: 2 * sqrt(base * quote) for constant product AMM
          // But for simplicity, we'll sum the USD value of both sides if we have prices
          // For now, use a simple heuristic based on reserves
          
          // Try to get USD prices from the price store
          let baseUsdPrice = 0;
          let quoteUsdPrice = 0;
          
          try {
            const { getPriceByMint } = await import('../priceStore.js');
            const priceA = getPriceByMint(mint_a);
            const priceB = getPriceByMint(mint_b);
            if (priceA?.usdc) baseUsdPrice = priceA.usdc;
            if (priceB?.usdc) quoteUsdPrice = priceB.usdc;
          } catch {}
          
          // Calculate USD liquidity if we have prices
          if (baseUsdPrice > 0 && quoteUsdPrice > 0) {
            liquidity_base = (baseReserve * baseUsdPrice) + (quoteReserve * quoteUsdPrice);
          } else if (baseUsdPrice > 0) {
            liquidity_base = baseReserve * baseUsdPrice * 2; // Estimate total from one side
          } else if (quoteUsdPrice > 0) {
            liquidity_base = quoteReserve * quoteUsdPrice * 2;
          } else if (mint_b === USDC_MINT) {
            // If quote is USDC, use quote reserve * 2 as USD liquidity
            liquidity_base = quoteReserve * 2;
          } else if (mint_a === USDC_MINT) {
            // If base is USDC, use base reserve * 2 as USD liquidity
            liquidity_base = baseReserve * 2;
          }
        } catch (e: any) {
          try { logger.warn('pumpswap.normalize.price.calc.failed', { 
            pool: id, 
            error: String(e?.message || e), 
            cat: 'pumpswap' 
          }); } catch {}
        }
      }
      
      // Skip pools below minimum liquidity threshold
      if (minLiqBase > 0 && liquidity_base < minLiqBase) {
        try { logger.debug('pumpswap.normalize.pool.skip.min_liq', { 
          pool: id, 
          liquidity: liquidity_base, 
          minLiqBase, 
          cat: 'pumpswap' 
        }); } catch {}
        continue;
      }
      
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
        // Store decimals for later use
        decimals_a: decA,
        decimals_b: decB,
        // Store raw reserves for potential future use
        amount_a: pool.base_reserve ? BigInt(pool.base_reserve).toString() : undefined,
        amount_b: pool.quote_reserve ? BigInt(pool.quote_reserve).toString() : undefined,
      } as any);
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
    const withPrice = ammCanon.filter(p => p.price_a_per_b > 0).length;
    const withLiq = ammCanon.filter(p => p.liquidity_base > 0).length;
    logger.info('pumpswap.graphql normalized', { 
      total: ammCanon.length, 
      withPrice, 
      withLiq, 
      cat: 'pumpswap', 
      canon 
    });
  } catch {}
  
  return { amm: ammCanon, clmm: [] };
}

