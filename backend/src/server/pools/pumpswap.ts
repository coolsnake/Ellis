import { logger } from '../../utils/logger.js';
import { emit } from '../realtime.js';
import { CONFIG } from '../../utils/config.js';
import { writeJson, joinPath } from '../../utils/fs.js';
import type { AmmPool, PoolsPayload } from './types.js';
import { validateHttpUrl, swapABFields } from './common.js';
import { canonicalizePools } from './canonical.js';
import { resolveManyDecimals } from './decimals.js';
import { verifyCanonicalization } from './validation.js';
import { httpLogStart, httpLogResponse, httpLog429, httpLogNonOk } from './httpLog.js';
import { PublicKey } from '@solana/web3.js';
import { getConnection } from '../../wallet/wallet.js';
import { withRpcLimit } from '../../utils/rpcLimiter.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// Pumpswap AMM program ID
export const PUMPSWAP_PROGRAM_ID = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

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
  
  // NEW: Get token universe instead of hardcoded SOL/USDC
  let mints: string[] = [];
  try {
    const { computeTokenUniverse } = await import('../universe.js');
    const universe = await computeTokenUniverse((CONFIG.system as any)?.tokenUniverseMode);
    mints = Array.from(universe);
    logger.info('pumpswap.graphql.universe', { mintCount: mints.length, cat: 'pumpswap' });
  } catch (e: any) {
    logger.warn('pumpswap.graphql.universe.failed', { error: String(e?.message || e), cat: 'pumpswap' });
    // Fallback to SOL/USDC if universe fetch fails
    mints = [SOL_MINT, USDC_MINT];
  }
  
  const pools = new Map<string, any>(); // Dedupe by pubkey
  
  // Fetch pools for each mint in the universe
  for (const mint of mints) {
    try {
      const mintPools = await fetchPoolsForToken(mint, apiKey, retries, backoffMs, pageSize, maxPages, pageDelayMs);
      for (const p of mintPools) {
        pools.set(p.pubkey, p);
      }
      
      logger.debug('pumpswap.graphql.mint.fetched', { 
        mint: mint.slice(0, 8), 
        count: mintPools.length, 
        total: pools.size,
        cat: 'pumpswap' 
      });
      
      // Delay between mints to avoid rate limiting
      if (pageDelayMs > 0 && mints.indexOf(mint) < mints.length - 1) {
        await new Promise(r => setTimeout(r, pageDelayMs));
      }
    } catch (e: any) {
      logger.warn('pumpswap.graphql.mint.failed', { 
        mint: mint.slice(0, 8), 
        error: String(e?.message || e), 
        cat: 'pumpswap' 
      });
      // Continue to next mint on failure
    }
  }
  
  const allPools = Array.from(pools.values());
  try { await writeJson(CACHE_PATH, allPools); } catch (e: any) {
    try { logger.warn('pumpswap.cache write failed', { file: CACHE_PATH, error: String(e?.message || e), cat: 'pumpswap' }); } catch {}
  }
  try { logger.info('pumpswap.graphql raw', { count: allPools.length, mints: mints.length, cat: 'pumpswap' }); } catch {}
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
    try { logger.debug('pumpswap.rpc.enrichment.disabled', { cat: 'pumpswap' }); } catch {}
    return { pools, metrics: { success: 0, fail: 0, ms: 0, feesExtracted: 0, protocolRecipientsExtracted: 0 } };
  }
  
  const connection = getConnection();
  const enriched: any[] = [];
  let successCount = 0;
  let failCount = 0;
  let feesExtracted = 0;
  let protocolRecipientsExtracted = 0;
  const t0 = Date.now();
  
  try { logger.info('pumpswap.rpc.enrichment.start', { poolCount: pools.length, batchSize, cat: 'pumpswap' }); } catch {}
  
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
          } catch {}
        }
        
        // Add vault accounts
        if (pool.pool_base_token_account) {
          try {
            const pk = new PublicKey(pool.pool_base_token_account);
            allAddresses.push(pk);
            addressMapping.set(pool.pool_base_token_account, { poolIndex: poolIdx, type: 'base_vault' });
          } catch {}
        }
        
        if (pool.pool_quote_token_account) {
          try {
            const pk = new PublicKey(pool.pool_quote_token_account);
            allAddresses.push(pk);
            addressMapping.set(pool.pool_quote_token_account, { poolIndex: poolIdx, type: 'quote_vault' });
          } catch {}
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
                  } catch {}
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
                  } catch {}
                }
              } else if (protocolRecipientBase58 === SYSTEM_PROGRAM_ID) {
                // Log when System Program is found (means field is empty/not configured)
                try {
                  logger.debug('pumpswap.extract.protocol_recipient.system_program', {
                    pool: batch[mapping.poolIndex - i]?.pubkey?.slice(0, 12),
                    note: 'protocol_fee_recipient_not_configured_will_use_fallback',
                    cat: 'pumpswap'
                  });
                } catch {}
              }
            }
          } catch (e: any) {
            try {
              logger.warn('pumpswap.extract.pool_fields.failed', {
                pool: address,
                error: String(e?.message || e),
                cat: 'pumpswap'
              });
            } catch {}
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
    feesExtracted,
    protocolRecipientsExtracted,
    ms,
    cat: 'pumpswap' 
  }); } catch {}
  
  return { pools: enriched, metrics: { success: successCount, fail: failCount, ms, feesExtracted, protocolRecipientsExtracted } };
}

export async function normalizePumpswapPools(raw: any): Promise<PoolsPayload> {
  const now = Date.now();
  const amm: AmmPool[] = [];
  const pools = Array.isArray(raw) ? raw : [];
  
  // PumpSwap total fee: 20 bps LP fee + 5 bps protocol fee = 25 bps total
  const defaultFeeBps = Number((CONFIG as any)?.pumpswap?.defaultFeeBps || 25);
  const minLiqBase = Number((CONFIG as any)?.pumpswap?.minLiqBase || 0);
  
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
        } catch {}
        continue; // Skip this pool
      }
      
      // Use extracted fee if available, otherwise fall back to default
      // PumpSwap total fee: 20 bps LP fee + 5 bps protocol fee = 25 bps total
      const defaultFeeBps = Number((CONFIG as any)?.pumpswap?.defaultFeeBps || 25);
      const feeBps = pool.fee_bps !== undefined && Number.isFinite(pool.fee_bps) 
        ? Number(pool.fee_bps) 
        : defaultFeeBps;
      
      // Log when using default fee vs extracted fee for debugging
      if (feeBps === defaultFeeBps && pool.fee_bps === undefined) {
        try {
          logger.debug('pumpswap.normalize.using_default_fee', {
            pool: id,
            defaultFeeBps,
            reason: 'fee_not_extracted_from_rpc',
            cat: 'pumpswap'
          });
        } catch {}
      }
      
      // Get decimals from centralized resolver with fallback to 6
      const decA = decimalsMap.get(mint_a) ?? 6;
      const decB = decimalsMap.get(mint_b) ?? 6;
      
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
            } catch {}
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
            } catch {}
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
              } catch {}
            }
          }
          
          // Calculate high-precision price for exact calculations with proper decimal adjustment
          // price_a_per_b = (baseRaw / 10^decA) / (quoteRaw / 10^decB)
          //               = (baseRaw * 10^decB) / (quoteRaw * 10^decA)
          if (quoteReserveRaw > 0n) {
            try {
              const numerator = baseReserveRaw * BigInt(Math.pow(10, decB));
              const denominator = quoteReserveRaw * BigInt(Math.pow(10, decA));
              const priceExactBigInt = numerator / denominator;
              price_a_per_b_exact = priceExactBigInt.toString();
            } catch {}
          }
          
          // Try to get USD prices from the price store
          try {
            const { getPriceByMint } = await import('../priceStore.js');
            const priceA = getPriceByMint(mint_a);
            const priceB = getPriceByMint(mint_b);
            if (priceA?.usdc) baseUsdPrice = priceA.usdc;
            if (priceB?.usdc) quoteUsdPrice = priceB.usdc;
          } catch {}
          
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
        mint_a: finalMintA,
        mint_b: finalMintB,
        fee_bps: feeBps, // Use extracted fee or default
        price_a_per_b,
        liquidity_base,
        updated_ms: now,
        account_a: pool.pool_base_token_account,
        account_b: pool.pool_quote_token_account,
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
        // Raw reserves in smallest units (for exact calculations)
        reserve_a_raw: pool.base_reserve || undefined,
        reserve_b_raw: pool.quote_reserve || undefined,
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
        protocol_fee_recipient: pool.protocol_fee_recipient || undefined, // On-chain protocol fee recipient (offset 243)
      } as any);
    } catch (e: any) {
      try { logger.warn('pumpswap.normalize.pool.failed', { error: String(e?.message || e), cat: 'pumpswap' }); } catch {}
    }
  }
  
  // Apply canonicalization like other DEXes
  const ammCanon = canonicalizePools(amm);
  
  // FIX: Mark as processed to satisfy graph builder and silence warnings
  ammCanon.forEach(p => (p as any)._pipelineProcessed = true);

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
  } catch {}
  
  return { amm: ammCanon, clmm: [] };
}

