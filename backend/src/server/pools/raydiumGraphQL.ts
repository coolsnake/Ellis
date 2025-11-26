import { logger } from '../../utils/logger.js';
import { CONFIG } from '../../utils/config.js';
import { writeJson, joinPath } from '../../utils/fs.js';
import type { AmmPool, ClmmPool, PoolsPayload } from './types.js';
import { resolveManyDecimals } from './decimals.js';
import { processPriceThroughPipeline } from './pricePipeline.js';
import { executeShyftGraphQL } from './shyftHelpers.js';
import { poolsMetrics } from '../pools.metrics.js';
import { loadJupiterTokenMap } from '../../utils/tokens.js';
import { Connection, PublicKey } from '@solana/web3.js';
import { logCatchError } from '../../utils/errorHandler.js';
import { withRpcLimit } from '../../utils/rpcLimiter.js';
import { getConnection } from '../../wallet/wallet.js';

// Constants for ammConfig account structure
const TRADE_FEE_RATE_OFFSET = 47; // u32 at byte offset 47 in ammConfig account

// Cache ammConfig fee rates to avoid redundant RPC calls
const ammConfigFeeCache = new Map<string, { feeBps: number; ts: number }>();
const AMM_CONFIG_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours (configs are immutable)

/**
 * Fetch and decode fee rates from Raydium CLMM ammConfig accounts
 * AmmConfig account structure:
 *   - bump (u8): 1 byte at offset 0
 *   - index (u16): 2 bytes at offset 1
 *   - owner (pubkey): 32 bytes at offset 3
 *   - protocol_fee_rate (u32): 4 bytes at offset 35
 *   - (padding/alignment or other field): 4 bytes at offset 39
 *   - (another field): 4 bytes at offset 43
 *   - trade_fee_rate (u32): 4 bytes at offset 47 ← WE READ THIS
 *   - ... rest of struct
 * 
 * trade_fee_rate is in parts per million (PPM)
 * Convert to basis points: fee_bps = trade_fee_rate / 100
 * Example: trade_fee_rate = 2500 → 25 bps → 0.25%
 */
export async function fetchAmmConfigFeeRates(
  ammConfigAddresses: Set<string>
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (!ammConfigAddresses.size) return result;
  
  const now = Date.now();
  const addressesToFetch: string[] = [];
  
  // Check cache first
  for (const addr of ammConfigAddresses) {
    const cached = ammConfigFeeCache.get(addr);
    if (cached && now - cached.ts < AMM_CONFIG_CACHE_TTL) {
      result.set(addr, cached.feeBps);
    } else {
      addressesToFetch.push(addr);
    }
  }
  
  if (!addressesToFetch.length) {
    logger.debug('raydium.clmm.ammConfig.all_cached', {
      total: ammConfigAddresses.size,
      cat: 'raydium-clmm',
    });
    return result;
  }
  
  try {
    const connection = getConnection();
    const batchSize = Number((CONFIG as any)?.raydiumClmm?.ammConfigBatchSize || 50);
    const delayMs = Number((CONFIG as any)?.raydiumClmm?.pageDelayMs || 200);
    
    logger.debug('raydium.clmm.ammConfig.fetch.start', {
      total: addressesToFetch.length,
      cached: result.size,
      batchSize,
      delayMs,
      cat: 'raydium-clmm',
    });
    
    // Process in batches to respect rate limits
    for (let i = 0; i < addressesToFetch.length; i += batchSize) {
      const batch = addressesToFetch.slice(i, i + batchSize);
      const publicKeys = batch.map(addr => new PublicKey(addr));
      
      try {
        const accountInfos = await withRpcLimit(
          () => connection.getMultipleAccountsInfo(publicKeys),
          Math.max(1, Math.ceil(batch.length / 10)),
          { module: 'raydium-clmm', method: 'getMultipleAccountsInfo' }
        );
        
        for (let j = 0; j < batch.length; j++) {
          const configAddr = batch[j];
          const accountInfo = accountInfos[j];
          
          if (!accountInfo?.data || accountInfo.data.length < TRADE_FEE_RATE_OFFSET + 4) {
            logger.warn('raydium.clmm.ammConfig.invalid', {
              config: configAddr.slice(0, 8),
              dataLen: accountInfo?.data?.length || 0,
              cat: 'raydium-clmm',
            });
            continue;
          }
          
          try {
            // Step 1: Try using Raydium SDK to decode AmmConfig account
            let feeBps: number | undefined;
            
            try {
              const sdk: any = await import('@raydium-io/raydium-sdk-v2');
              
              // Try various SDK layout paths for AmmConfig
              const ammConfigLayout = 
                (sdk as any)?.AmmConfigLayout ||
                (sdk as any)?.AmmConfigStateLayout ||
                (sdk as any)?.Clmm?.AmmConfigLayout ||
                (sdk as any)?.Clmm?.AmmConfigStateLayout ||
                (sdk as any)?.raydium?.clmm?.layout?.AmmConfigLayout ||
                (sdk as any)?.raydium?.clmm?.layout?.AmmConfigStateLayout;
              
              if (ammConfigLayout?.decode) {
                try {
                  const decoded = ammConfigLayout.decode(accountInfo.data);
                  const tradeFeeRate = decoded.tradeFeeRate || decoded.trade_fee_rate || decoded.tradeFeeRatePPM;
                  
                  if (tradeFeeRate != null) {
                    // Convert from parts per million to basis points
                    // tradeFeeRate is in PPM (parts per million), so fee_bps = tradeFeeRate / 100
                    feeBps = Number(tradeFeeRate) / 100;
                    
                    logger.debug('raydium.clmm.ammConfig.sdk_decoded', {
                      config: configAddr.slice(0, 8),
                      tradeFeeRate: Number(tradeFeeRate),
                      feeBps,
                      cat: 'raydium-clmm',
                    });
                  }
                } catch (decodeErr: any) {
                  logger.debug('raydium.clmm.ammConfig.sdk_decode.failed', {
                    config: configAddr.slice(0, 8),
                    error: String(decodeErr?.message || decodeErr),
                    cat: 'raydium-clmm',
                  });
                }
              }
            } catch (sdkErr: any) {
              logger.debug('raydium.clmm.ammConfig.sdk_import.failed', {
                config: configAddr.slice(0, 8),
                error: String(sdkErr?.message || sdkErr),
                cat: 'raydium-clmm',
              });
            }
            
            // Step 2: Fallback to manual byte reading if SDK decoding failed
            if (feeBps == null || !Number.isFinite(feeBps) || feeBps <= 0 || feeBps > 10000) {
              const buffer = Buffer.from(accountInfo.data);
              
              // Diagnostic: Read values at multiple offsets to see what we're getting
              const valueAt35 = buffer.length >= 39 ? buffer.readUInt32LE(35) : null;
              const valueAt39 = buffer.length >= 43 ? buffer.readUInt32LE(39) : null;
              const valueAt43 = buffer.length >= 47 ? buffer.readUInt32LE(43) : null;
              const valueAt47 = buffer.length >= 51 ? buffer.readUInt32LE(47) : null;
              
              logger.info('raydium.clmm.ammConfig.diagnostic', {
                config: configAddr.slice(0, 8),
                bufferLength: buffer.length,
                TRADE_FEE_RATE_OFFSET,
                valueAt35,
                valueAt39,
                valueAt43,
                valueAt47,
                valueAt35_bps: valueAt35 ? valueAt35 / 100 : null,
                valueAt39_bps: valueAt39 ? valueAt39 / 100 : null,
                valueAt43_bps: valueAt43 ? valueAt43 / 100 : null,
                valueAt47_bps: valueAt47 ? valueAt47 / 100 : null,
                cat: 'raydium-clmm',
              });
              
              // Read trade_fee_rate as u32 little-endian at offset 43
              const tradeFeeRatePPM = buffer.readUInt32LE(TRADE_FEE_RATE_OFFSET);
              
              logger.info('raydium.clmm.ammConfig.reading', {
                config: configAddr.slice(0, 8),
                offset: TRADE_FEE_RATE_OFFSET,
                tradeFeeRatePPM,
                feeBps_before_check: tradeFeeRatePPM / 100,
                cat: 'raydium-clmm',
              });
              
              // Step 3: Sanity check - if value is unreasonably high, try alternative offset
              if (tradeFeeRatePPM > 1000000) {
                // Try reading at offset 47 (in case there's more padding)
                const altOffset = TRADE_FEE_RATE_OFFSET + 4;
                if (buffer.length >= altOffset + 4) {
                  const altValue = buffer.readUInt32LE(altOffset);
                  if (altValue > 0 && altValue <= 1000000) {
                    feeBps = altValue / 100;
                    logger.info('raydium.clmm.ammConfig.alt_offset_used', {
                      config: configAddr.slice(0, 8),
                      original: tradeFeeRatePPM,
                      altValue,
                      feeBps,
                      cat: 'raydium-clmm',
                    });
                  }
                }
                
                // If still invalid, log and skip (no default)
                if (!feeBps || feeBps > 10000) {
                  logger.warn('raydium.clmm.ammConfig.invalid_fee', {
                    config: configAddr.slice(0, 8),
                    tradeFeeRatePPM,
                    altOffsetValue: buffer.length >= altOffset + 4 ? buffer.readUInt32LE(altOffset) : null,
                    cat: 'raydium-clmm',
                  });
                  continue; // Skip this config
                }
              } else {
                // Convert from parts per million to basis points
                feeBps = tradeFeeRatePPM / 100;
              }
            }
            
            // Only set result if we have a valid fee
            if (feeBps && feeBps > 0 && feeBps <= 10000) {
              result.set(configAddr, feeBps);
              ammConfigFeeCache.set(configAddr, { feeBps, ts: now });
              
              logger.debug('raydium.clmm.ammConfig.decoded', {
                config: configAddr.slice(0, 8),
                feeBps,
                method: feeBps ? 'sdk_or_manual' : 'manual',
                cat: 'raydium-clmm',
              });
            } else {
              logger.warn('raydium.clmm.ammConfig.invalid_fee_skipped', {
                config: configAddr.slice(0, 8),
                feeBps,
                cat: 'raydium-clmm',
              });
            }
          } catch (err: any) {
            logger.warn('raydium.clmm.ammConfig.decode.failed', {
              config: configAddr.slice(0, 8),
              error: String(err?.message || err),
              cat: 'raydium-clmm',
            });
          }
        }
        
        logger.debug('raydium.clmm.ammConfig.batch', {
          batchIndex: Math.floor(i / batchSize),
          batchSize: batch.length,
          decoded: result.size,
          cat: 'raydium-clmm',
        });
      } catch (err) {
        logger.warn('raydium.clmm.ammConfig.batch.failed', {
          batchIndex: Math.floor(i / batchSize),
          error: String(err),
          cat: 'raydium-clmm',
        });
      }
      
      // Add delay between batches (except after the last batch)
      if (delayMs > 0 && i + batchSize < addressesToFetch.length) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
    
    logger.info('raydium.clmm.ammConfig.batch.complete', {
      total: addressesToFetch.length,
      decoded: result.size - (ammConfigAddresses.size - addressesToFetch.length),
      cached: ammConfigAddresses.size - addressesToFetch.length,
      batches: Math.ceil(addressesToFetch.length / batchSize),
      cat: 'raydium-clmm',
    });
  } catch (err) {
    logger.error('raydium.clmm.ammConfig.batch.failed', {
      error: String(err),
      cat: 'raydium-clmm',
    });
  }
  
  return result;
}

/**
 * Fetch raw account data for CLMM pools and extract observation_state, amm_config, etc.
 * This enables zero-RPC transaction building by caching these fields during pool fetch.
 */
async function fetchClmmPoolRawData(
  poolIds: string[],
  opts: { batchSize: number; delayMs: number }
): Promise<Map<string, { observationState?: string; ammConfig?: string; oracle?: string; vaultA?: string; vaultB?: string; tickSpacing?: number }>> {
  const result = new Map<string, any>();
  if (!poolIds.length) return result;
  
  const { deriveRaydiumClmmCacheFields } = await import('../pools.derivation.js');
  const connection = getConnection();
  const batchSize = Math.min(opts.batchSize, 100);
  const delayMs = opts.delayMs;
  
  logger.info('raydium.clmm.raw_data.fetch.start', {
    total: poolIds.length,
    batchSize,
    cat: 'raydium-clmm',
  });
  
  for (let i = 0; i < poolIds.length; i += batchSize) {
    const batch = poolIds.slice(i, i + batchSize);
    const publicKeys = batch.map(id => new PublicKey(id));
    
    try {
      const accountInfos = await withRpcLimit(
        () => connection.getMultipleAccountsInfo(publicKeys),
        Math.max(1, Math.ceil(batch.length / 10)),
        { module: 'raydium-clmm', method: 'getMultipleAccountsInfo' }
      );
      
      for (let j = 0; j < batch.length; j++) {
        const poolId = batch[j];
        const accountInfo = accountInfos[j];
        
        if (!accountInfo?.data) continue;
        
        try {
          const derived = await deriveRaydiumClmmCacheFields(
            poolId,
            Buffer.from(accountInfo.data),
            { programId: accountInfo.owner?.toBase58() }
          );
          
          if (derived) {
            result.set(poolId, {
              observationState: derived.observationState,
              ammConfig: derived.ammConfig,
              oracle: derived.oracle,
              vaultA: derived.vaultA,
              vaultB: derived.vaultB,
              tickSpacing: derived.tickSpacing,
            });
          }
        } catch (err) {
          logger.debug('raydium.clmm.raw_data.decode.failed', {
            pool: poolId.slice(0, 8),
            error: String(err),
            cat: 'raydium-clmm',
          });
        }
      }
      
      logger.debug('raydium.clmm.raw_data.batch', {
        batchIndex: Math.floor(i / batchSize),
        decoded: result.size,
        cat: 'raydium-clmm',
      });
    } catch (err) {
      logger.warn('raydium.clmm.raw_data.batch.failed', {
        batchIndex: Math.floor(i / batchSize),
        error: String(err),
        cat: 'raydium-clmm',
      });
    }
    
    if (delayMs > 0 && i + batchSize < poolIds.length) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  
  logger.info('raydium.clmm.raw_data.fetch.complete', {
    total: poolIds.length,
    decoded: result.size,
    cat: 'raydium-clmm',
  });
  
  return result;
}

export async function fetchRaydiumGraphQL(mints: string[]): Promise<any[]> {
  const CACHE_PATH = joinPath(CONFIG.cacheDir, 'raydium-graphql-raw.json');
  const retries = Number((CONFIG as any)?.raydium?.maxHttpRetries || 2);
  const backoffMs = Number((CONFIG as any)?.raydium?.httpBackoffMs || 500);
  const pageSize = Number((CONFIG as any)?.raydium?.pageSize || 1000);
  const maxPages = Number((CONFIG as any)?.raydium?.maxPages || 10);
  const pageDelayMs = Number((CONFIG as any)?.raydium?.pageDelayMs || 200);
  const detailBatchSize = Number((CONFIG as any)?.raydium?.detailBatchSize || 50);
  const detailDelayMs = Number((CONFIG as any)?.raydium?.detailBatchDelayMs ?? pageDelayMs);

  const poolsMap = new Map<string, any>();

  // Add initial delay before first request to respect rate limits
  if (pageDelayMs > 0 && mints.length > 0) {
    await new Promise(resolve => setTimeout(resolve, pageDelayMs));
  }

  for (let idx = 0; idx < mints.length; idx++) {
    const mint = mints[idx];
    try {
      const pools = await fetchRaydiumPoolsForToken({
        mint,
        retries,
        backoffMs,
        pageSize,
        maxPages,
        pageDelayMs,
      });
      for (const pool of pools) {
        poolsMap.set(pool.pubkey, pool);
      }

      logger.debug('raydium.graphql.mint.summary', {
        mint: mint.slice(0, 8),
        count: pools.length,
        total: poolsMap.size,
        cat: 'raydium',
      });
    } catch (e: any) {
      logger.warn('raydium.graphql.mint.failed', {
        mint: mint.slice(0, 8),
        error: String(e?.message || e),
        cat: 'raydium',
      });
    }
    if (pageDelayMs > 0 && idx < mints.length - 1) {
      await new Promise(resolve => setTimeout(resolve, pageDelayMs));
    }
  }

  const uniquePoolIds = Array.from(poolsMap.keys());
  
  // Add delay BEFORE starting detail phase to respect rate limits
  if (pageDelayMs > 0 && uniquePoolIds.length > 0) {
    await new Promise(resolve => setTimeout(resolve, pageDelayMs));
  }
  
  const detailedPools = await fetchRaydiumPoolsByAddress(uniquePoolIds, {
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

  // Include any pools that we fetched by address but did not see during mint scans (edge-case)
  for (const [id, detail] of detailedPools.entries()) {
    if (!poolsMap.has(id)) merged.push(detail);
  }

  try {
    await writeJson(CACHE_PATH, merged);
  } catch (e: any) {
    logger.warn('raydium.graphql.cache.write.failed', {
      file: CACHE_PATH,
      error: String(e?.message || e),
      cat: 'raydium',
    });
  }

  logger.info('raydium.graphql.complete', {
    count: merged.length,
    mints: mints.length,
    detail: detailedPools.size,
    cat: 'raydium',
  });
  return merged;
}

async function fetchRaydiumPoolsForToken(opts: {
  mint: string;
  retries: number;
  backoffMs: number;
  pageSize: number;
  maxPages: number;
  pageDelayMs: number;
}): Promise<any[]> {
  const allPools: any[] = [];
  let offset = 0;
  let page = 0;

  while (page < opts.maxPages) {
    const data = await executeShyftGraphQL<{ Raydium_LiquidityPoolv4: any[] }>({
      dex: 'raydium',
      query: `
        query RaydiumPoolsByMint($mint: String!, $limit: Int!, $offset: Int!) {
          Raydium_LiquidityPoolv4(
            where: {_or: [
              {baseMint: {_eq: $mint}},
              {quoteMint: {_eq: $mint}}
            ]},
            limit: $limit,
            offset: $offset
          ) {
            pubkey
            baseMint
            quoteMint
            baseDecimal
            quoteDecimal
            baseVault
            quoteVault
            lpMint
            poolOpenTime
            swapBaseInAmount
            swapQuoteInAmount
            swapBaseOutAmount
            swapQuoteOutAmount
            swapFeeNumerator
            swapFeeDenominator
            state
            status
            _updatedAt
          }
        }
      `,
      variables: {
        mint: opts.mint,
        limit: opts.pageSize,
        offset,
      },
      extraLogContext: { phase: 'summary', mint: opts.mint, page },
      retries: opts.retries,
      backoffMs: opts.backoffMs,
    });

    const pagePools = data?.Raydium_LiquidityPoolv4 || [];
    if (pagePools.length === 0) break;

    allPools.push(...pagePools);
    logger.debug('raydium.graphql page', { 
      mint: opts.mint, 
      page, 
      count: pagePools.length, 
      total: allPools.length, 
      cat: 'raydium' 
    });

    if (pagePools.length < opts.pageSize) break;

    offset += opts.pageSize;
    page++;
    
    if (page < opts.maxPages && opts.pageDelayMs > 0) {
      await new Promise(r => setTimeout(r, opts.pageDelayMs));
    }
  }
  
  return allPools;
}

async function fetchRaydiumClmmPoolsForToken(opts: {
  mint: string;
  retries: number;
  backoffMs: number;
  pageSize: number;
  maxPages: number;
  pageDelayMs: number;
}): Promise<any[]> {
  const allPools: any[] = [];
  let offset = 0;
  let page = 0;

  while (page < opts.maxPages) {
    // Add delay BEFORE each request (except the first page)
    if (opts.pageDelayMs > 0 && page > 0) {
      await new Promise(r => setTimeout(r, opts.pageDelayMs));
    }
    
    const data = await executeShyftGraphQL<{ RAYDIUM_CLMM_PoolState: any[] }>({
      dex: 'raydium-clmm',
      query: `
        query RaydiumClmmPoolsByMint($mint: String!, $limit: Int!, $offset: Int!) {
          RAYDIUM_CLMM_PoolState(
            where: {_or: [
              {tokenMint0: {_eq: $mint}},
              {tokenMint1: {_eq: $mint}}
            ]},
            limit: $limit,
            offset: $offset
          ) {
            pubkey
            mintDecimals0
            mintDecimals1
            owner
            bump
            liquidity
            tickArrayBitmap
            tickCurrent
            tickSpacing
            tokenMint0
            tokenMint1
            tokenVault0
            tokenVault1
            sqrtPriceX64
            ammConfig
            _updatedAt
          }
        }
      `,
      variables: {
        mint: opts.mint,
        limit: opts.pageSize,
        offset,
      },
      extraLogContext: { phase: 'clmm-summary', mint: opts.mint, page },
      retries: opts.retries,
      backoffMs: opts.backoffMs,
    });

    const pagePools = data?.RAYDIUM_CLMM_PoolState || [];
    if (pagePools.length === 0) break;

    allPools.push(...pagePools);
    logger.debug('raydium.clmm.graphql.page', { 
      mint: opts.mint, 
      page, 
      count: pagePools.length, 
      total: allPools.length, 
      cat: 'raydium-clmm' 
    });

    if (pagePools.length < opts.pageSize) break;

    offset += opts.pageSize;
    page++;
  }
  
  return allPools;
}

async function fetchRaydiumClmmPoolsByAddress(
  poolIds: string[],
  opts: { retries: number; backoffMs: number; batchSize: number; delayMs: number }
): Promise<Map<string, any>> {
  const result = new Map<string, any>();
  if (!poolIds.length) return result;

  const chunks = chunkArray(poolIds, Math.max(1, opts.batchSize));
  for (let i = 0; i < chunks.length; i++) {
    // Add delay BEFORE each request (except the first batch)
    if (opts.delayMs > 0 && i > 0) {
      await new Promise(r => setTimeout(r, opts.delayMs));
    }
    
    const chunk = chunks[i];
    try {
      const data = await executeShyftGraphQL<{ RAYDIUM_CLMM_PoolState: any[] }>({
        dex: 'raydium-clmm',
        query: `
          query RaydiumClmmPoolsByAddress($ids: [String!]) {
            RAYDIUM_CLMM_PoolState(
              where: {pubkey: {_in: $ids}}
            ) {
              pubkey
              mintDecimals0
              mintDecimals1
              owner
              bump
              liquidity
              tickArrayBitmap
              tickCurrent
              tickSpacing
              tokenMint0
              tokenMint1
              tokenVault0
              tokenVault1
              sqrtPriceX64
              ammConfig
              _updatedAt
            }
          }
        `,
        variables: { ids: chunk },
        retries: opts.retries,
        backoffMs: opts.backoffMs,
        extraLogContext: { phase: 'clmm-detail', chunkIndex: i, chunkSize: chunk.length },
      });

      const pools = data?.RAYDIUM_CLMM_PoolState || [];
      for (const pool of pools) {
        if (!pool?.pubkey) continue;
        result.set(pool.pubkey, pool);
      }
      try {
        poolsMetrics.raydium.detailBatches += 1;
        poolsMetrics.raydium.apiBatches += 1;
      } catch (e) { logCatchError('pools.raydiumGraphQL', e); }
      logger.debug('raydium.clmm.graphql.detail.chunk', {
        idx: i,
        chunk: chunk.length,
        total: result.size,
        cat: 'raydium-clmm',
      });
    } catch (err) {
      logger.warn('raydium.clmm.graphql.detail.failed', {
        chunk: i,
        error: String((err as any)?.message || err),
        cat: 'raydium-clmm',
      });
    }
  }

  return result;
}

export async function fetchRaydiumClmmGraphQL(mints: string[]): Promise<any[]> {
  const CACHE_PATH = joinPath(CONFIG.cacheDir, 'raydium-clmm-graphql-raw.json');
  const retries = Number((CONFIG as any)?.raydiumClmm?.maxHttpRetries || 2);
  const backoffMs = Number((CONFIG as any)?.raydiumClmm?.httpBackoffMs || 500);
  const pageSize = Number((CONFIG as any)?.raydiumClmm?.pageSize || 1000);
  const maxPages = Number((CONFIG as any)?.raydiumClmm?.maxPages || 10);
  const pageDelayMs = Number((CONFIG as any)?.raydiumClmm?.pageDelayMs || 200);
  const detailBatchSize = Number((CONFIG as any)?.raydiumClmm?.detailBatchSize || 50);
  const detailDelayMs = Number((CONFIG as any)?.raydiumClmm?.detailBatchDelayMs ?? pageDelayMs);

  const poolsMap = new Map<string, any>();

  // Add longer initial delay before first request to let Shyft rate limit window reset
  // after preceding AMM requests. Uses 10x page delay (e.g., 200ms → 2000ms)
  const initialDelayMultiplier = Number((CONFIG as any)?.raydiumClmm?.initialDelayMultiplier || 10);
  const initialDelayMs = pageDelayMs * initialDelayMultiplier;
  if (initialDelayMs > 0 && mints.length > 0) {
    logger.debug('raydium.clmm.graphql.initial_delay', { 
      initialDelayMs, 
      pageDelayMs, 
      multiplier: initialDelayMultiplier,
      cat: 'raydium-clmm' 
    });
    await new Promise(resolve => setTimeout(resolve, initialDelayMs));
  }

  for (let idx = 0; idx < mints.length; idx++) {
    // Add delay BEFORE processing each mint (except the first one)
    if (pageDelayMs > 0 && idx > 0) {
      await new Promise(resolve => setTimeout(resolve, pageDelayMs));
    }
    
    const mint = mints[idx];
    try {
      const pools = await fetchRaydiumClmmPoolsForToken({
        mint,
        retries,
        backoffMs,
        pageSize,
        maxPages,
        pageDelayMs,
      });
      for (const pool of pools) {
        poolsMap.set(pool.pubkey, pool);
      }

      logger.debug('raydium.clmm.graphql.mint.summary', {
        mint: mint.slice(0, 8),
        count: pools.length,
        total: poolsMap.size,
        cat: 'raydium-clmm',
      });
    } catch (e: any) {
      logger.warn('raydium.clmm.graphql.mint.failed', {
        mint: mint.slice(0, 8),
        error: String(e?.message || e),
        cat: 'raydium-clmm',
      });
    }
  }

  const uniquePoolIds = Array.from(poolsMap.keys());
  
  // Add delay BEFORE starting detail phase to respect rate limits
  if (pageDelayMs > 0 && uniquePoolIds.length > 0) {
    await new Promise(resolve => setTimeout(resolve, pageDelayMs));
  }
  
  const detailedPools = await fetchRaydiumClmmPoolsByAddress(uniquePoolIds, {
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

  // Include any pools that we fetched by address but did not see during mint scans
  for (const [id, detail] of detailedPools.entries()) {
    if (!poolsMap.has(id)) merged.push(detail);
  }

  try {
    await writeJson(CACHE_PATH, merged);
  } catch (e: any) {
    logger.warn('raydium.clmm.graphql.cache.write.failed', {
      file: CACHE_PATH,
      error: String(e?.message || e),
      cat: 'raydium-clmm',
    });
  }

  logger.info('raydium.clmm.graphql.complete', {
    count: merged.length,
    mints: mints.length,
    detail: detailedPools.size,
    cat: 'raydium-clmm',
  });
  return merged;
}

async function fetchRaydiumPoolsByAddress(
  poolIds: string[],
  opts: { retries: number; backoffMs: number; batchSize: number; delayMs: number }
): Promise<Map<string, any>> {
  const result = new Map<string, any>();
  if (!poolIds.length) return result;

  const chunks = chunkArray(poolIds, Math.max(1, opts.batchSize));
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    try {
      const data = await executeShyftGraphQL<{ Raydium_LiquidityPoolv4: any[] }>({
        dex: 'raydium',
        query: `
          query RaydiumPoolsByAddress($ids: [String!]) {
            Raydium_LiquidityPoolv4(
              where: {pubkey: {_in: $ids}}
            ) {
              pubkey
              baseMint
              quoteMint
              baseDecimal
              quoteDecimal
              lpMint
              lpVault
              baseVault
              quoteVault
              baseNeedTakePnl
              quoteNeedTakePnl
              baseTotalPnl
              quoteTotalPnl
              marketId
              marketProgramId
              openOrders
              targetOrders
              owner
              withdrawQueue
              amountWaveRatio
              depth
              nonce
              pnlDenominator
              pnlNumerator
              poolOpenTime
              punishCoinAmount
              punishPcAmount
              quoteLotSize
              baseLotSize
              minPriceMultiplier
              maxPriceMultiplier
              minSeparateDenominator
              minSeparateNumerator
              minSize
              maxOrder
              orderbookToInitTime
              resetFlag
              state
              status
              swapBaseInAmount
              swapQuoteInAmount
              swapBaseOutAmount
              swapQuoteOutAmount
              swapFeeNumerator
              swapFeeDenominator
              swapBase2QuoteFee
              swapQuote2BaseFee
              tradeFeeNumerator
              tradeFeeDenominator
              volMaxCutRatio
              systemDecimalValue
              amountWaveRatio
              _updatedAt
            }
          }
        `,
        variables: { ids: chunk },
        retries: opts.retries,
        backoffMs: opts.backoffMs,
        extraLogContext: { phase: 'detail', chunkIndex: i, chunkSize: chunk.length },
      });

      const pools = data?.Raydium_LiquidityPoolv4 || [];
      for (const pool of pools) {
        if (!pool?.pubkey) continue;
        result.set(pool.pubkey, pool);
      }
      try {
        poolsMetrics.raydium.detailBatches += 1;
        poolsMetrics.raydium.apiBatches += 1;
        const count = poolsMetrics.raydium.detailBatches;
        const prevAvg = poolsMetrics.raydium.apiBatchSizeAvg || 0;
        poolsMetrics.raydium.apiBatchSizeAvg = count > 0 ? ((prevAvg * (count - 1)) + chunk.length) / count : chunk.length;
      } catch (e) { logCatchError('pools.raydiumGraphQL', e); }
      logger.debug('raydium.graphql.detail.chunk', {
        idx: i,
        chunk: chunk.length,
        total: result.size,
        cat: 'raydium',
      });
    } catch (err) {
      logger.warn('raydium.graphql.detail.failed', {
        chunk: i,
        error: String((err as any)?.message || err),
        cat: 'raydium',
      });
      try { poolsMetrics.raydium.detailFailures += 1; } catch (e) { logCatchError('pools.raydiumGraphQL', e); }
    }

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
        { module: 'raydium', method: 'getMultipleAccountsInfo' }
      );
      
      accounts.forEach((acc, idx) => {
        if (acc && acc.data.length >= 64) { // SPL Token Account min length
          // Amount is u64 at offset 64
          try {
            const buf = Buffer.from(acc.data);
            const amount = buf.readBigUInt64LE(64);
            results.set(batch[idx], amount);
          } catch (e) { logCatchError('pools.raydiumGraphQL', e); }
        }
      });
    } catch (e) {
      logger.warn('raydium.graphql.vaults.fetch_failed', { 
        error: String(e), 
        batchIndex: i 
      });
    }
  }
  
  return results;
}

export async function normalizeRaydiumGraphQL(raw: any[]): Promise<PoolsPayload> {
  const now = Date.now();
  const amm: AmmPool[] = [];
  const clmm: ClmmPool[] = [];
  
  // Load Jupiter token prices for TVL calculation
  const jupPriceMap = await loadJupiterTokenMap();

  // Collect unique ammConfig addresses from CLMM pools
  const ammConfigAddrs = new Set<string>();
  for (const pool of raw) {
    // Identify CLMM pools (they have tokenMint0, AMM pools have baseMint/quoteMint)
    const isClmm = pool.tokenMint0 !== undefined || pool.tokenVault0 !== undefined || pool.tickSpacing !== undefined;
    if (isClmm && pool.ammConfig) {
      ammConfigAddrs.add(pool.ammConfig);
    }
  }
  
  // Fetch fee rates for all unique ammConfig accounts
  logger.info('raydium.graphql.ammConfig.fetch', {
    uniqueConfigs: ammConfigAddrs.size,
    totalPools: raw.length,
    cat: 'raydium',
  });
  
  const configFeeRates = await fetchAmmConfigFeeRates(ammConfigAddrs);

  // Collect all vault addresses for batch RPC fetching
  const vaultAddresses = new Set<string>();
  for (const pool of raw) {
    // AMM vaults
    if (pool.baseVault) vaultAddresses.add(pool.baseVault);
    if (pool.quoteVault) vaultAddresses.add(pool.quoteVault);
    // CLMM vaults
    if (pool.tokenVault0) vaultAddresses.add(pool.tokenVault0);
    if (pool.tokenVault1) vaultAddresses.add(pool.tokenVault1);
  }

  // Batch fetch vault balances
  // This runs in parallel with decimal resolution to save time
  const vaultBalancesPromise = fetchVaultBalances(Array.from(vaultAddresses));

  // Extract all mints for batch decimal resolution
  const allMints = new Set<string>();
  for (const pool of raw) {
    // AMM mints
    if (pool.baseMint) allMints.add(pool.baseMint);
    if (pool.quoteMint) allMints.add(pool.quoteMint);
    // CLMM mints
    if (pool.tokenMint0) allMints.add(pool.tokenMint0);
    if (pool.tokenMint1) allMints.add(pool.tokenMint1);
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
      if (id === pool.baseVault || id === pool.quoteVault || id === pool.tokenVault0 || id === pool.tokenVault1) {
        try {
          logger.warn('raydium.graphql.pool_id_is_vault', {
            id: id.slice(0, 8) + '…',
            cat: 'raydium'
          });
        } catch (e) { logCatchError('pools.raydiumGraphQL', e); }
        continue; // Skip this pool
      }
      
      // Determine if this is AMM or CLMM based on available fields
      const isClmm = pool.tokenMint0 !== undefined || pool.tokenVault0 !== undefined || pool.tickSpacing !== undefined;
      
      // Set mint variables based on pool type
      const mint_a = isClmm ? pool.tokenMint0 : pool.baseMint;
      const mint_b = isClmm ? pool.tokenMint1 : pool.quoteMint;
      
      if (!mint_a || !mint_b) continue;
      
      // Get decimals with fallback
      const decA = isClmm 
        ? (pool.mintDecimals0 ?? decimalsMap.get(mint_a) ?? 9)
        : (pool.baseDecimal ?? decimalsMap.get(mint_a) ?? 9);
      const decB = isClmm
        ? (pool.mintDecimals1 ?? decimalsMap.get(mint_b) ?? 9)
        : (pool.quoteDecimal ?? decimalsMap.get(mint_b) ?? 9);
      
      // Parse fee based on pool type
      let fee_bps = 25; // Default
      try {
        if (isClmm) {
          // Get fee rate from ammConfig account
          if (pool.ammConfig && configFeeRates.has(pool.ammConfig)) {
            fee_bps = configFeeRates.get(pool.ammConfig)!;
            logger.debug('raydium.clmm.fee.from_config', {
              pool: id.slice(0, 8),
              ammConfig: pool.ammConfig.slice(0, 8),
              feeBps: fee_bps,
              cat: 'raydium-clmm',
            });
          } else {
            logger.debug('raydium.clmm.fee.default', {
              pool: id.slice(0, 8),
              ammConfig: pool.ammConfig || 'missing',
              cat: 'raydium-clmm',
            });
          }
        } else {
          const feeNum = Number(pool.swapFeeNumerator || pool.tradeFeeNumerator || 0);
          const feeDenom = Number(pool.swapFeeDenominator || pool.tradeFeeDenominator || 10000);
          if (feeDenom > 0) {
            fee_bps = Math.round((feeNum / feeDenom) * 10000);
          }
        }
      } catch (e) { logCatchError('pools.raydiumGraphQL', e); }
      
      if (isClmm) {
        // Handle CLMM pool - Concentrated Liquidity Market Maker
        // Calculate amounts and TVL from vault balances
        let amount_a_whole: number | undefined;
        let amount_b_whole: number | undefined;
        let tvl_usd: number | undefined;
        
        try {
          const balA = pool.tokenVault0 ? vaultBalances.get(pool.tokenVault0) : undefined;
          const balB = pool.tokenVault1 ? vaultBalances.get(pool.tokenVault1) : undefined;
          
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
              tvl_usd = wholeA * priceA * 2;
            } else if (priceB) {
              tvl_usd = wholeB * priceB * 2;
            }
          }
        } catch (e) { logCatchError('pools.raydiumGraphQL', e); }

        // Process price through pipeline with sqrtPriceX64
        let price_a_per_b = 0;
        let finalMintA = mint_a;
        let finalMintB = mint_b;
        let finalDecA = decA;
        let finalDecB = decB;
        let wasSwapped = false;
        
        try {
          if (pool.sqrtPriceX64) {
            const processed = processPriceThroughPipeline({
              mintA: mint_a,
              mintB: mint_b,
              decimalsA: decA,
              decimalsB: decB,
              poolId: id,
              dex: 'Raydium',
              poolType: 'clmm',
              sqrtPriceX64: BigInt(pool.sqrtPriceX64),
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
        } catch (e) { logCatchError('pools.raydiumGraphQL', e); }
        
        // Swap account fields if pipeline swapped mints
        const finalAccountA = wasSwapped ? pool.tokenVault1 : pool.tokenVault0;
        const finalAccountB = wasSwapped ? pool.tokenVault0 : pool.tokenVault1;
        const finalNativeAccountA = wasSwapped ? pool.tokenVault1 : pool.tokenVault0;
        const finalNativeAccountB = wasSwapped ? pool.tokenVault0 : pool.tokenVault1;
        
        const finalAmountA = wasSwapped ? amount_b_whole : amount_a_whole;
        const finalAmountB = wasSwapped ? amount_a_whole : amount_b_whole;
        
        clmm.push({
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
          pool_kind: 'clmm',
          authority: pool.owner,
          tick_spacing: pool.tickSpacing,
          tick_current: pool.tickCurrent,
          liquidity: pool.liquidity,
          sqrt_price_x64: Number(pool.sqrtPriceX64 || 0),
          sqrt_price_x64_raw: pool.sqrtPriceX64 ? String(pool.sqrtPriceX64) : undefined,
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
          amount_a: finalAmountA,
          amount_b: finalAmountB,
          liquidity_display: tvl_usd,
        } as any);
      } else {
        // AMM V4 pool
        // Calculate amounts and TVL from vault balances
        let amount_a_whole: number | undefined;
        let amount_b_whole: number | undefined;
        let tvl_usd: number | undefined;
        let reserveA: bigint | undefined;
        let reserveB: bigint | undefined;
        
        try {
          const balA = pool.baseVault ? vaultBalances.get(pool.baseVault) : undefined;
          const balB = pool.quoteVault ? vaultBalances.get(pool.quoteVault) : undefined;
          
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
              tvl_usd = wholeA * priceA * 2; // Assume balanced
            } else if (priceB) {
              tvl_usd = wholeB * priceB * 2; // Assume balanced
            }
          }
        } catch (e) { logCatchError('pools.raydiumGraphQL', e); }

        // Process price through pipeline with reserves or swap volumes as fallback
        let price_a_per_b = 0;
        let finalMintA = mint_a;
        let finalMintB = mint_b;
        let finalDecA = decA;
        let finalDecB = decB;
        let wasSwapped = false;
        
        try {
          // Fallback to swap volumes if reserves not available (and vault fetch failed)
          const reserveA_fallback = reserveA ?? (pool.baseReserve ? BigInt(pool.baseReserve) : null) ?? (pool.swapBaseInAmount ? BigInt(pool.swapBaseInAmount) : null);
          const reserveB_fallback = reserveB ?? (pool.quoteReserve ? BigInt(pool.quoteReserve) : null) ?? (pool.swapQuoteInAmount ? BigInt(pool.swapQuoteInAmount) : null);
          
          if (reserveA_fallback && reserveB_fallback && reserveA_fallback > 0n && reserveB_fallback > 0n) {
            const processed = processPriceThroughPipeline({
              mintA: mint_a,
              mintB: mint_b,
              decimalsA: decA,
              decimalsB: decB,
              poolId: id,
              dex: 'Raydium',
              poolType: 'amm',
              reserveA: reserveA_fallback,
              reserveB: reserveB_fallback,
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
        } catch (e) { logCatchError('pools.raydiumGraphQL', e); }
        
        // Swap account fields if pipeline swapped mints
        const finalAccountA = wasSwapped ? pool.quoteVault : pool.baseVault;
        const finalAccountB = wasSwapped ? pool.baseVault : pool.quoteVault;
        const finalNativeAccountA = wasSwapped ? pool.quoteVault : pool.baseVault;
        const finalNativeAccountB = wasSwapped ? pool.baseVault : pool.quoteVault;
        
        const finalAmountA = wasSwapped ? amount_b_whole : amount_a_whole;
        const finalAmountB = wasSwapped ? amount_a_whole : amount_b_whole;
        
        amm.push({
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
          was_swapped: wasSwapped,
          _pipelineProcessed: true, // Mark as processed by price pipeline
          native_mint_a: mint_a,
          native_mint_b: mint_b,
          native_decimals_a: decA,
          native_decimals_b: decB,
          native_account_a: finalNativeAccountA,
          native_account_b: finalNativeAccountB,
          native_open_orders: pool.openOrders,
          native_target_orders: pool.targetOrders,
          native_base_need_take_pnl: pool.baseNeedTakePnl,
          native_quote_need_take_pnl: pool.quoteNeedTakePnl,
          native_lp_vault: pool.lpVault,
          native_withdraw_queue: pool.withdrawQueue,
          amount_a_whole: finalAmountA,
          amount_b_whole: finalAmountB,
          amount_a: finalAmountA,
          amount_b: finalAmountB,
          liquidity_display: tvl_usd,
        } as any);
      }
    } catch (error: any) {
      logger.warn('raydium.graphql.normalize.pool.failed', { 
        error: String(error?.message || error), 
        cat: 'raydium' 
      });
    }
  }
  
  logger.info('raydium.graphql.normalized', { 
    amm: amm.length, 
    clmm: clmm.length,
    ammConfigs: configFeeRates.size,
    cat: 'raydium' 
  });
  
  // Populate executionCache for Raydium AMM pools (enables zero-RPC builds)
  try {
    const { executionCache } = await import('../../execution/cache.js');
    let ammCached = 0;
    
    for (const pool of amm) {
      try {
        const existing = executionCache.getStatic(pool.id) || {};
        executionCache.setStatic(pool.id, {
          ...existing,
          programId: (CONFIG as any)?.raydium?.ammV4Program || '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
          dex: 'Raydium',
          pool_kind: 'amm',
          mint_a: pool.mint_a,
          mint_b: pool.mint_b,
          decimals_a: pool.decimals_a,
          decimals_b: pool.decimals_b,
          vault_a: pool.account_a,
          vault_b: pool.account_b,
          market_id: pool.market_id,
          market_program_id: pool.market_program_id,
          open_orders: pool.amm_open_orders,
          target_orders: pool.amm_target_orders,
          authority: pool.amm_authority || pool.owner,
          lp_mint: pool.lp_mint,
        });
        ammCached++;
      } catch {}
    }
    
    logger.info('raydium.amm.execution_cache.populated', {
      ammCached,
      total: amm.length,
      cat: 'raydium'
    });
  } catch (cacheErr) {
    logger.debug('raydium.amm.execution_cache.failed', {
      error: String((cacheErr as any)?.message || cacheErr),
      cat: 'raydium'
    });
  }
  
  // Populate executionCache for Raydium CLMM pools (enables zero-RPC builds)
  try {
    const { executionCache } = await import('../../execution/cache.js');
    
    // Import tick array derivation functions for zero-RPC tick array caching
    const { getTickArrayStartIndexByTick, deriveTickArrayPda } = await import('../../execution/raydiumTickArrays.js');
    const { PublicKey } = await import('@solana/web3.js');
    
    // Fetch raw data for CLMM pools to extract observation_state and other fields
    // This is critical for zero-RPC transaction building
    const clmmPoolIds = clmm.map((p: any) => p.id);
    const rawDataMap = await fetchClmmPoolRawData(clmmPoolIds, {
      batchSize: 50,
      delayMs: 100,
    });
    
    let clmmCached = 0;
    let clmmWithObservation = 0;
    let clmmWithTickArrays = 0;
    
    const programIdStr = (CONFIG as any)?.raydium?.clmmProgram || 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';
    const programPk = new PublicKey(programIdStr);
    
    for (const pool of clmm) {
      try {
        const existing = executionCache.getStatic(pool.id) || {};
        const rawData = rawDataMap.get(pool.id);
        
        // Derive tick arrays from tickCurrent and tick_spacing (GraphQL-provided)
        // This enables zero-RPC transaction building by pre-caching tick array PDAs
        let tickArrayLower: string | undefined;
        let tickArrayCenter: string | undefined;
        let tickArrayUpper: string | undefined;
        
        const tickCurrent = (pool as any).tick_current;
        const tickSpacing = pool.tick_spacing;
        
        if (Number.isFinite(tickCurrent) && Number.isFinite(tickSpacing) && tickSpacing > 0) {
          try {
            const poolPk = new PublicKey(pool.id);
            const centerStart = getTickArrayStartIndexByTick(tickCurrent, tickSpacing);
            const delta = 60 * Math.max(1, tickSpacing);
            
            // Derive center, lower, and upper tick array PDAs in parallel
            const [lowerPk, centerPk, upperPk] = await Promise.all([
              deriveTickArrayPda(programPk, poolPk, centerStart - delta).catch(() => null),
              deriveTickArrayPda(programPk, poolPk, centerStart).catch(() => null),
              deriveTickArrayPda(programPk, poolPk, centerStart + delta).catch(() => null),
            ]);
            
            if (lowerPk) tickArrayLower = lowerPk.toBase58();
            if (centerPk) tickArrayCenter = centerPk.toBase58();
            if (upperPk) tickArrayUpper = upperPk.toBase58();
            
            if (tickArrayLower && tickArrayCenter && tickArrayUpper) {
              clmmWithTickArrays++;
            }
          } catch (e) {
            logger.debug('raydium.clmm.graphql.tick_array_derivation.failed', {
              pool: pool.id.slice(0, 8) + '…',
              error: String((e as any)?.message || e),
              cat: 'raydium'
            });
          }
        }
        
        executionCache.setStatic(pool.id, {
          ...existing,
          programId: programIdStr,
          dex: 'Raydium',
          pool_kind: 'clmm',
          mint_a: pool.mint_a,
          mint_b: pool.mint_b,
          decimals_a: pool.decimals_a,
          decimals_b: pool.decimals_b,
          vault_a: pool.account_a,
          vault_b: pool.account_b,
          tick_spacing: pool.tick_spacing,
          amm_config: rawData?.ammConfig || (pool as any).amm_config || (pool as any).ammConfig,
          observation_state: rawData?.observationState,
          oracle: rawData?.oracle,
          // Store derived tick arrays in static cache for zero-RPC builds
          tickArrayLower,
          tickArrayCenter,
          tickArrayUpper,
        });
        clmmCached++;
        if (rawData?.observationState) clmmWithObservation++;
      } catch {}
    }
    
    logger.info('raydium.clmm.execution_cache.populated', {
      clmmCached,
      clmmWithObservation,
      clmmWithTickArrays,
      total: clmm.length,
      cat: 'raydium'
    });
  } catch (cacheErr) {
    logger.debug('raydium.clmm.execution_cache.failed', {
      error: String((cacheErr as any)?.message || cacheErr),
      cat: 'raydium'
    });
  }
  
  return { amm: amm, clmm: clmm };
}
