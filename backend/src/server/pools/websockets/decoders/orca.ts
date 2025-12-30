/**
 * Orca Whirlpool decoder
 * 
 * Handles decoding and WebSocket updates for Orca CLMM (Whirlpool) pools.
 * 
 * Orca uses the Whirlpools SDK for parsing pool account data.
 */

import { PublicKey } from '@solana/web3.js';
import { logger } from '../../../../utils/logger.js';
import { logCatchError, logCatchDebug } from '../../../../utils/errorHandler.js';
import { anyToBigInt } from '../../precision.js';
import { processPriceThroughPipeline } from '../../pricePipeline.js';
import { diffNormalizedPools } from '../../../pools.utils.js';
import { orcaCache } from '../../../pools.cache.js';
import { deriveOrcaFeeBps } from '../../orca.js';
import { emit } from '../../../realtime.js';
import { wsDecodeStats, wsDeltaStats, incrementSkipReason } from '../../../pools.metrics.js';
import { validateDecodedPool, validatePriceDelta } from '../validation.js';
import { CONFIG } from '../../../../utils/config.js';
import type { 
  DecodedPool, 
  UpdateResult, 
  AccountInfo, 
  ProcessedPriceResult,
  DerivedAccountInfo 
} from './types.js';
import type { ClmmPool, PoolsPayload } from '../../types.js';

// Program ID
const ORCA_WHIRLPOOL_PROGRAM = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';

// Debounce state for graph updates
let orcaApplyState: { baseline: PoolsPayload | null; timer: NodeJS.Timeout | null } = { baseline: null, timer: null };
const DEBOUNCE_MS = 50;

/**
 * Schedule debounced graph update for Orca
 */
async function scheduleDexApply(source: 'orca', baseline: PoolsPayload): Promise<void> {
  try {
    if (!orcaApplyState.baseline) {
      orcaApplyState.baseline = baseline;
    }
    if (orcaApplyState.timer) {
      clearTimeout(orcaApplyState.timer);
    }
    orcaApplyState.timer = setTimeout(async () => {
      try {
        const gmod: any = await import('../../../graph.js');
        const current = orcaCache.data;
        if (current && orcaApplyState.baseline) {
          // Use applyPoolUpdates for incremental graph updates
          if (typeof gmod?.applyPoolUpdates === 'function') {
            await gmod.applyPoolUpdates(orcaApplyState.baseline, current, { pushToArb: false });
          }
        }
      } catch (e) {
        logCatchDebug('orca.scheduleDexApply', e);
      } finally {
        orcaApplyState.baseline = null;
        orcaApplyState.timer = null;
      }
    }, DEBOUNCE_MS);
  } catch (e) {
    logCatchDebug('orca.scheduleDexApply.setup', e);
  }
}

/**
 * Convert owner to PublicKey if it's a string
 */
function toPublicKey(owner: any): PublicKey | null {
  if (!owner) return null;
  if (owner instanceof PublicKey) return owner;
  if (typeof owner === 'string') {
    try {
      return new PublicKey(owner);
    } catch {
      return null;
    }
  }
  if (typeof owner?.toBase58 === 'function') {
    // Already a PublicKey-like object
    return owner as PublicKey;
  }
  return null;
}

/**
 * Manually decode Orca Whirlpool account data without SDK
 * 
 * Whirlpool account layout:
 * - 8 bytes: discriminator
 * - 32 bytes: whirlpoolsConfig (PublicKey)
 * - 1 byte: whirlpoolBump
 * - 2 bytes: tickSpacing (u16)
 * - 2 bytes: tickSpacingSeed (u16)
 * - 2 bytes: feeRate (u16)
 * - 2 bytes: protocolFeeRate (u16)
 * - 16 bytes: liquidity (u128)
 * - 16 bytes: sqrtPrice (u128)
 * - 4 bytes: tickCurrentIndex (i32)
 * - 8 bytes: protocolFeeOwedA (u64)
 * - 8 bytes: protocolFeeOwedB (u64)
 * - 32 bytes: tokenMintA (PublicKey)
 * - 32 bytes: tokenMintB (PublicKey)
 * - 32 bytes: tokenVaultA (PublicKey)
 * - 32 bytes: tokenVaultB (PublicKey)
 * - 32 bytes: oracle (PublicKey)
 */
function decodeWhirlpoolManually(inputData: Buffer | Uint8Array): {
  tickSpacing: number;
  feeRate: number;
  liquidity: bigint;
  sqrtPrice: bigint;
  tickCurrentIndex: number;
  tokenMintA: PublicKey;
  tokenMintB: PublicKey;
  tokenVaultA: PublicKey;
  tokenVaultB: PublicKey;
  oracle: PublicKey;
} | null {
  try {
    // Ensure we have a proper Node.js Buffer with all methods
    const data = Buffer.from(inputData);
    
    // Minimum size check (discriminator + config + basic fields + mints + vaults)
    if (data.length < 300) {
      return null;
    }

    let offset = 8; // Skip discriminator
    
    // Skip whirlpoolsConfig (32 bytes)
    offset += 32;
    
    // Skip whirlpoolBump (1 byte)
    offset += 1;
    
    // tickSpacing (2 bytes, u16 LE)
    const tickSpacing = data.readUInt16LE(offset);
    offset += 2;
    
    // Skip tickSpacingSeed (2 bytes)
    offset += 2;
    
    // feeRate (2 bytes, u16 LE) - in hundredths of a bip (1/1000000)
    const feeRate = data.readUInt16LE(offset);
    offset += 2;
    
    // Skip protocolFeeRate (2 bytes)
    offset += 2;
    
    // liquidity (16 bytes, u128 LE)
    const liquidityBuf = data.subarray(offset, offset + 16);
    const liquidity = bufferToU128LE(liquidityBuf);
    offset += 16;
    
    // sqrtPrice (16 bytes, u128 LE)
    const sqrtPriceBuf = data.subarray(offset, offset + 16);
    const sqrtPrice = bufferToU128LE(sqrtPriceBuf);
    offset += 16;
    
    // tickCurrentIndex (4 bytes, i32 LE)
    const tickCurrentIndex = data.readInt32LE(offset);
    offset += 4;
    
    // Skip protocolFeeOwedA (8 bytes)
    offset += 8;
    
    // Skip protocolFeeOwedB (8 bytes)
    offset += 8;
    
    // tokenMintA (32 bytes)
    const tokenMintA = new PublicKey(data.subarray(offset, offset + 32));
    offset += 32;
    
    // tokenMintB (32 bytes)
    const tokenMintB = new PublicKey(data.subarray(offset, offset + 32));
    offset += 32;
    
    // tokenVaultA (32 bytes)
    const tokenVaultA = new PublicKey(data.subarray(offset, offset + 32));
    offset += 32;
    
    // tokenVaultB (32 bytes)
    const tokenVaultB = new PublicKey(data.subarray(offset, offset + 32));
    offset += 32;
    
    // Skip feeGrowthGlobalA (16 bytes)
    offset += 16;
    
    // Skip feeGrowthGlobalB (16 bytes)
    offset += 16;
    
    // Skip rewardLastUpdatedTimestamp (8 bytes)
    offset += 8;
    
    // Skip rewardInfos (3 * 128 bytes = 384 bytes)
    offset += 384;
    
    // oracle (32 bytes) - may be at different offset depending on version
    // Try to read if there's enough data
    let oracle: PublicKey;
    if (data.length >= offset + 32) {
      oracle = new PublicKey(data.subarray(offset, offset + 32));
    } else {
      oracle = PublicKey.default;
    }
    
    return {
      tickSpacing,
      feeRate,
      liquidity,
      sqrtPrice,
      tickCurrentIndex,
      tokenMintA,
      tokenMintB,
      tokenVaultA,
      tokenVaultB,
      oracle,
    };
  } catch (e) {
    return null;
  }
}

/**
 * Convert a 16-byte LE buffer to a BigInt (u128)
 */
function bufferToU128LE(buf: Buffer | Uint8Array): bigint {
  let result = 0n;
  for (let i = 15; i >= 0; i--) {
    result = (result << 8n) | BigInt(buf[i]);
  }
  return result;
}

/**
 * Decode Orca Whirlpool from account data using the SDK
 * 
 * IMPORTANT: ParsableWhirlpool.parse requires a full AccountInfo object with
 * data, owner, executable, and lamports fields. The owner MUST be a PublicKey
 * object, not a string. The SDK validates that the account is owned by the
 * Whirlpool program.
 */
export async function decodeOrcaWhirlpool(
  accountInfo: AccountInfo,
  poolId: string,
  accountPubkey?: any
): Promise<{ parsed: any; mintA: string; mintB: string } | null> {
  try {
    // First try SDK-based decoding
    const sdk = await import('@orca-so/whirlpools-sdk').catch((err) => {
      // Log at info level once to diagnose SDK issues on server
      if (!(decodeOrcaWhirlpool as any)._sdkErrorLogged) {
        (decodeOrcaWhirlpool as any)._sdkErrorLogged = true;
        logger.info('orca.decoder.sdk_import_error', { 
          error: String(err?.message || err),
          stack: err?.stack?.split('\n').slice(0, 3).join(' | '),
          cat: 'pools' 
        });
      }
      return null;
    });
    
    if (sdk) {
      const { ParsableWhirlpool } = sdk as any;
      
      if (ParsableWhirlpool && typeof ParsableWhirlpool.parse === 'function') {
        // CRITICAL: Convert owner to PublicKey if it's a string
        const ownerPubkey = toPublicKey(accountInfo.owner);
        if (ownerPubkey) {
          const sdkAccountInfo = {
            data: accountInfo.data,
            executable: accountInfo.executable,
            lamports: accountInfo.lamports,
            owner: ownerPubkey,
            rentEpoch: accountInfo.rentEpoch ?? 0,
          };
          
          const parsed = ParsableWhirlpool.parse(accountPubkey, sdkAccountInfo);
          
          if (parsed) {
            const mintA = parsed.tokenMintA?.toBase58?.() || '';
            const mintB = parsed.tokenMintB?.toBase58?.() || '';
            
            if (mintA && mintB) {
              return { parsed, mintA, mintB };
            }
          }
        }
      }
    }
    
    // Fallback: Manual decoding without SDK
    logger.debug('orca.decoder.using_manual_fallback', {
      poolId: poolId.slice(0, 8) + '…',
      cat: 'pools'
    });
    
    const data = accountInfo.data;
    const manualDecoded = decodeWhirlpoolManually(data);
    
    if (!manualDecoded) {
      logger.info('orca.decoder.manual_decode_failed', {
        poolId: poolId.slice(0, 8) + '…',
        dataLength: data?.length || 0,
        cat: 'pools'
      });
      return null;
    }
    
    const mintA = manualDecoded.tokenMintA.toBase58();
    const mintB = manualDecoded.tokenMintB.toBase58();
    
    if (!mintA || !mintB) {
      logger.info('orca.decoder.missing_mints', {
        poolId: poolId.slice(0, 8) + '…',
        cat: 'pools'
      });
      return null;
    }
    
    // Create a parsed object compatible with the rest of the code
    const parsed = {
      sqrtPrice: manualDecoded.sqrtPrice,
      liquidity: manualDecoded.liquidity,
      tickSpacing: manualDecoded.tickSpacing,
      tickCurrentIndex: manualDecoded.tickCurrentIndex,
      feeRate: manualDecoded.feeRate,
      tokenMintA: manualDecoded.tokenMintA,
      tokenMintB: manualDecoded.tokenMintB,
      tokenVaultA: manualDecoded.tokenVaultA,
      tokenVaultB: manualDecoded.tokenVaultB,
      oracle: manualDecoded.oracle,
    };
    
    logger.debug('orca.decoder.manual_success', {
      poolId: poolId.slice(0, 8) + '…',
      mintA: mintA.slice(0, 8) + '…',
      mintB: mintB.slice(0, 8) + '…',
      cat: 'pools'
    });

    return { parsed, mintA, mintB };
  } catch (e) {
    logCatchDebug('orca.decode', e, { poolId });
    return null;
  }
}

/**
 * Handle Orca WebSocket account update
 * 
 * This is the main entry point for processing Orca Whirlpool updates from WebSocket.
 */
export async function handleOrcaUpdate(
  info: AccountInfo,
  poolId: string,
  derivedAccountToPool: Map<string, DerivedAccountInfo> = new Map(),
  accountPubkey?: any
): Promise<UpdateResult> {
  try {
    wsDecodeStats.orca.attempts += 1;
    
    // Log entry for debugging
    logger.info('orca.decoder.handleUpdate.entry', {
      poolId: poolId.slice(0, 8) + '…',
      hasData: !!info?.data,
      dataLength: info?.data?.length || 0,
      hasOwner: !!info?.owner,
      ownerType: typeof info?.owner,
      cat: 'pools'
    });
    
    // Ensure data is a Buffer for later use
    const data = Buffer.isBuffer(info.data) ? info.data : Buffer.from(info.data ?? []);
    
    if (!data || data.length === 0) {
      logger.info('orca.decoder.no_data', {
        poolId: poolId.slice(0, 8) + '…',
        cat: 'pools'
      });
      return { success: false, error: 'no_data', skipped: true };
    }

    // Create a normalized AccountInfo with Buffer data for the SDK
    // CRITICAL: Pass the full AccountInfo (including owner) to the decoder
    // The Orca SDK validates that the account is owned by the Whirlpool program
    const normalizedInfo: AccountInfo = {
      data,
      executable: info.executable ?? false,
      lamports: info.lamports ?? 0,
      owner: info.owner,
    };

    // Decode the pool - pass full AccountInfo, not just data buffer
    logger.info('orca.decoder.calling_decode', {
      poolId: poolId.slice(0, 8) + '…',
      dataLength: data.length,
      hasAccountPubkey: !!accountPubkey,
      cat: 'pools'
    });
    
    const decoded = await decodeOrcaWhirlpool(normalizedInfo, poolId, accountPubkey);
    
    logger.info('orca.decoder.decode_result', {
      poolId: poolId.slice(0, 8) + '…',
      success: !!decoded,
      cat: 'pools'
    });
    
    if (!decoded) {
      wsDecodeStats.orca.failures += 1;
      return { success: false, error: 'decode_failed', skipped: true };
    }

    const { parsed, mintA, mintB } = decoded;
    const sqrtRaw = anyToBigInt(parsed.sqrtPrice);
    const sqrt_price_x64 = sqrtRaw ? Number(sqrtRaw) : Number(parsed.sqrtPrice);

    // Log parsed values for debugging
    logger.info('orca.decoder.parsed_values', {
      poolId: poolId.slice(0, 8) + '…',
      mintA: mintA?.slice(0, 8) + '…',
      mintB: mintB?.slice(0, 8) + '…',
      sqrtRaw: sqrtRaw?.toString()?.slice(0, 20) + '…',
      sqrtRawType: typeof sqrtRaw,
      hasSqrtRaw: !!sqrtRaw,
      cat: 'pools'
    });

    // Get decimals for the NATIVE mint order
    let decA: number | undefined;
    let decB: number | undefined;
    
    try {
      const { resolveDecimals, validateDecimalsForMint } = await import('../../decimals.js');
      if (mintA) decA = await resolveDecimals(mintA);
      if (mintB) decB = await resolveDecimals(mintB);
      
      // Validate decimals against known tokens
      if (Number.isFinite(decA)) validateDecimalsForMint(mintA, decA!, poolId, 'Orca');
      if (Number.isFinite(decB)) validateDecimalsForMint(mintB, decB!, poolId, 'Orca');
    } catch (decErr) {
      logger.info('orca.decoder.decimals_error', {
        poolId: poolId.slice(0, 8) + '…',
        error: String((decErr as Error)?.message || decErr),
        cat: 'pools'
      });
      if (!Number.isFinite(decA)) decA = 9;
      if (!Number.isFinite(decB)) decB = 6;
    }

    logger.info('orca.decoder.decimals_resolved', {
      poolId: poolId.slice(0, 8) + '…',
      decA,
      decB,
      cat: 'pools'
    });

    // Process through price pipeline
    let processedPrice: ProcessedPriceResult | null = null;
    const canProcessPrice = Number.isFinite(decA) && Number.isFinite(decB) && sqrtRaw;
    
    if (canProcessPrice) {
      processedPrice = processPriceThroughPipeline({
        mintA,
        mintB,
        decimalsA: decA!,
        decimalsB: decB!,
        poolId,
        dex: 'Orca',
        poolType: 'clmm',
        sqrtPriceX64: sqrtRaw,
      });

      if (!processedPrice) {
        logger.warn('orca.ws.price.pipeline_failed', {
          id: poolId,
          mintA: mintA?.slice(0, 8),
          mintB: mintB?.slice(0, 8),
          sqrtRaw: sqrtRaw?.toString()?.slice(0, 20),
          cat: 'pools'
        });
      }
    } else {
      logger.info('orca.decoder.cannot_process_price', {
        poolId: poolId.slice(0, 8) + '…',
        hasDecA: Number.isFinite(decA),
        hasDecB: Number.isFinite(decB),
        hasSqrtRaw: !!sqrtRaw,
        cat: 'pools'
      });
    }

    if (!processedPrice) {
      wsDeltaStats.orca.skipped += 1;
      incrementSkipReason('orca', 'price_calc_failed');
      return { success: false, error: 'price_calc_failed', skipped: true, skipReason: 'price_calc_failed' };
    }

    const liquidityRaw = anyToBigInt(parsed.liquidity);
    const liquidity = Number(parsed.liquidity);
    const tick_spacing = Number(parsed.tickSpacing);
    const fee_bps = deriveOrcaFeeBps(parsed as any);

    // Debug logging for fee validation issues
    if (!Number.isFinite(fee_bps) || fee_bps < 0 || fee_bps > 10000) {
      logger.warn('orca.ws.invalid_fee_debug', {
        id: poolId.slice(0, 8) + '…',
        fee_bps,
        parsed_feeRate: parsed?.feeRate,
        parsed_fee: parsed?.fee,
        parsed_tradeFeeRate: parsed?.tradeFeeRate,
        parsed_tradingFeeRate: parsed?.tradingFeeRate,
        parsed_protocolFeeRate: parsed?.protocolFeeRate,
        cat: 'pools'
      });
    }

    // Check for derived account (vault) confusion
    if (derivedAccountToPool.has(poolId)) {
      const derivedMeta = derivedAccountToPool.get(poolId);
      logger.warn('orca.ws.vault_as_pool.prevented', {
        account: poolId.slice(0, 8) + '…',
        accountType: derivedMeta?.accountType,
        parentPool: derivedMeta?.poolId?.slice(0, 8) + '…',
        reason: 'account_is_vault_not_pool',
        cat: 'pools'
      });
      return { success: false, error: 'vault_as_pool', skipped: true };
    }

    // Build the pool item with pipeline-processed prices
    const clmmItem: ClmmPool = {
      id: poolId,
      dex: 'Orca',
      mint_a: processedPrice.mintA,
      mint_b: processedPrice.mintB,
      fee_bps,
      sqrt_price_x64,
      sqrt_price_x64_raw: sqrtRaw?.toString(),
      liquidity,
      liquidity_raw: liquidityRaw?.toString(),
      tick_spacing,
      updated_ms: Date.now(),
      pool_kind: 'clmm',
      liquidity_display: liquidity,
      price_a_per_b: processedPrice.priceForward,
      decimals_a: processedPrice.decimalsA,
      decimals_b: processedPrice.decimalsB,
      was_swapped: processedPrice.wasSwapped,
      native_mint_a: mintA,
      native_mint_b: mintB,
      _pipelineProcessed: true,
    } as ClmmPool;

    // Update execution cache with raw account data
    try {
      const { executionCache } = await import('../../../../execution/cache.js');
      const existingStatic = executionCache.getStatic(poolId) || {};

      // Get native vault addresses
      const nativeVaultA = parsed.tokenVaultA?.toBase58?.();
      const nativeVaultB = parsed.tokenVaultB?.toBase58?.();

      // Store static pool data with CANONICAL orientation
      executionCache.setStatic(poolId, {
        ...existingStatic,
        // IMPORTANT: whirlpoolsConfig is NOT the program ID - it's a config PDA
        // Always use the actual Orca Whirlpool program ID
        programId: (CONFIG as any).orca?.programId || ORCA_WHIRLPOOL_PROGRAM,
        // Store vaults in CANONICAL order (matching mint_a/mint_b)
        vaults: {
          a: processedPrice.wasSwapped ? nativeVaultB : nativeVaultA,
          b: processedPrice.wasSwapped ? nativeVaultA : nativeVaultB
        },
        oracle: parsed.oracle?.toBase58?.(),
        tickSpacing: tick_spacing,
        // CRITICAL: Store CANONICALIZED mint/decimal order
        mint_a: processedPrice.mintA,
        mint_b: processedPrice.mintB,
        decimals_a: processedPrice.decimalsA,
        decimals_b: processedPrice.decimalsB,
        // Preserve native orientation for reference
        native_mint_a: mintA,
        native_mint_b: mintB,
        native_vault_a: nativeVaultA,
        native_vault_b: nativeVaultB,
        // Store raw account data for local parsing during tx building
        rawAccountData: data,
        rawAccountDataUpdatedMs: Date.now()
      });

      // Store hot pool data (frequently changing price/liquidity)
      // Include tickSpacing for boundary crossing detection in cache
      executionCache.setHot(poolId, {
        sqrtPriceX64: sqrtRaw,
        currentTickIndex: Number(parsed.tickCurrentIndex),
        tickSpacing: tick_spacing,
        liquidity: liquidityRaw,
        feeRate: fee_bps
      });

      logger.debug('orca.ws.cache_updated', {
        pool: poolId.slice(0, 8) + '…',
        hasRawData: !!data,
        sqrtPrice: sqrtRaw?.toString(),
        currentTick: parsed.tickCurrentIndex,
        liquidity: liquidityRaw?.toString(),
        cat: 'pools'
      });
    } catch (cacheErr) {
      logger.warn('orca.ws.cache_update_failed', {
        pool: poolId.slice(0, 8) + '…',
        error: String((cacheErr as Error)?.message || cacheErr),
        cat: 'pools'
      });
    }

    // Validate decoded pool before applying
    const validation = validateDecodedPool('orca', clmmItem, poolId);
    if (!validation.valid) {
      wsDecodeStats.orca.failures += 1;
      incrementSkipReason('orca', `validation_failed:${validation.reasons.join(',')}`);
      logger.warn('orca.ws.validation.failed', { id: poolId, reasons: validation.reasons, cat: 'pools' });
      return { success: false, error: `validation_failed:${validation.reasons.join(',')}`, skipped: true };
    }

    // Update cache
    const prev = orcaCache.data || { amm: [], clmm: [] };
    const next: PoolsPayload = { amm: prev.amm.slice(), clmm: prev.clmm.slice() };
    const idx = next.clmm.findIndex(p => p.id === poolId);
    
    // Validate price delta against previous value
    if (idx >= 0) {
      const prevPool = next.clmm[idx];
      validatePriceDelta('orca', poolId, clmmItem.price_a_per_b, prevPool.price_a_per_b);
    }
    
    if (idx >= 0) {
      const prevPool = next.clmm[idx];
      const orientationChanged = prevPool.mint_a !== clmmItem.mint_a || prevPool.mint_b !== clmmItem.mint_b;
      
      if (orientationChanged) {
        logger.warn('ws.update.orientation_changed', {
          poolId: poolId.slice(0, 8) + '…',
          dex: 'Orca',
          prevMintA: prevPool.mint_a?.slice(0, 8),
          prevMintB: prevPool.mint_b?.slice(0, 8),
          newMintA: clmmItem.mint_a?.slice(0, 8),
          newMintB: clmmItem.mint_b?.slice(0, 8),
          cat: 'pools'
        });
        
        // Preserve orientation-independent fields
        const orientationIndependentFields = {
          tvl_usd: prevPool.tvl_usd,
          liquidity_display: prevPool.liquidity_display,
          pool_liquidity_raw: prevPool.pool_liquidity_raw,
        };
        next.clmm[idx] = { ...clmmItem, ...orientationIndependentFields };
      } else {
        next.clmm[idx] = { ...next.clmm[idx], ...clmmItem };
      }
    } else {
      next.clmm.push(clmmItem);
    }

    // Update stats and cache
    wsDecodeStats.orca.successes += 1;
    wsDeltaStats.orca.decoded += 1;
    orcaCache.data = next;
    orcaCache.ts = Date.now();

    const delta = diffNormalizedPools(prev, next);
    const hasDelta = delta.clmm.length || delta.amm.length || delta.addedClmm || delta.removedClmm || delta.addedAmm || delta.removedAmm;

    // Emit update event
    try {
      const sample = { amm: [], clmm: delta.clmm.slice(0, 20) };
      emit('pool-updates', {
        source: 'orca',
        updatedAmm: delta.amm.length,
        updatedClmm: delta.clmm.length,
        addedAmm: delta.addedAmm,
        removedAmm: delta.removedAmm,
        addedClmm: delta.addedClmm,
        removedClmm: delta.removedClmm,
        sample,
        ts: Date.now()
      });
    } catch {}

    // Track delta stats
    if (hasDelta) {
      wsDeltaStats.orca.applied += 1;
    } else {
      wsDeltaStats.orca.skipped += 1;
      const prevPool = prev.clmm.find(p => p.id === poolId);
      if (prevPool) {
        const reasons: string[] = [];
        if ((prevPool as any).sqrt_price_x64_raw === clmmItem.sqrt_price_x64_raw) reasons.push('sqrt_price_unchanged');
        if ((prevPool as any).liquidity_raw === clmmItem.liquidity_raw) reasons.push('liquidity_raw_unchanged');
        if (Math.abs((prevPool.liquidity || 0) - (clmmItem.liquidity || 0)) === 0) reasons.push('liquidity_unchanged');
        if (Math.abs((prevPool.price_a_per_b || 0) - (clmmItem.price_a_per_b || 0)) <= 1e-9) reasons.push('price_unchanged');
        incrementSkipReason('orca', reasons.length > 0 ? reasons.join('+') : 'no_delta_detected');
      } else {
        incrementSkipReason('orca', 'new_pool');
      }
    }

    // Schedule graph update
    if (hasDelta) {
      await scheduleDexApply('orca', prev);
    }

    return { success: true, pool: clmmItem as DecodedPool, delta };
  } catch (e) {
    wsDecodeStats.orca.failures += 1;
    logCatchError('orca.handleUpdate', e, { poolId: poolId.slice(0, 8) + '…' });
    return { success: false, error: String((e as Error)?.message || e) };
  }
}

/**
 * Check if an owner is the Orca Whirlpool program
 */
export function isOrcaOwner(owner: string): boolean {
  return owner === ORCA_WHIRLPOOL_PROGRAM;
}

/**
 * Get Orca program ID
 */
export const ORCA_PROGRAM = ORCA_WHIRLPOOL_PROGRAM;

