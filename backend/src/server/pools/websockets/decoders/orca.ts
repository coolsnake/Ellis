/**
 * Orca Whirlpool decoder
 * 
 * Handles decoding and WebSocket updates for Orca CLMM (Whirlpool) pools.
 * 
 * Orca uses the Whirlpools SDK for parsing pool account data.
 */

import { logger } from '../../../../utils/logger.js';
import { logCatchError, logCatchDebug } from '../../../../utils/errorHandler.js';
import { anyToBigInt } from '../../precision.js';
import { processPriceThroughPipeline } from '../../pricePipeline.js';
import { diffNormalizedPools } from '../../../pools.utils.js';
import { orcaCache } from '../../../pools.cache.js';
import { deriveOrcaFeeBps } from '../../orca.js';
import { emit } from '../../../realtime.js';
import { wsDecodeStats, wsDeltaStats, incrementSkipReason } from '../../../pools.metrics.js';
import { validateDecodedPool } from '../validation.js';
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
 * Decode Orca Whirlpool from account data using the SDK
 */
export async function decodeOrcaWhirlpool(
  data: Buffer,
  poolId: string,
  accountPubkey?: any
): Promise<{ parsed: any; mintA: string; mintB: string } | null> {
  try {
    const sdk = await import('@orca-so/whirlpools-sdk').catch(() => null);
    if (!sdk) {
      logger.debug('orca.decoder.sdk_missing', { cat: 'pools' });
      return null;
    }

    const { ParsableWhirlpool } = sdk as any;
    
    // ParsableWhirlpool.parse needs the pubkey and account info
    const info = { data };
    const parsed = ParsableWhirlpool.parse(accountPubkey, info);
    
    if (!parsed) {
      logger.debug('orca.decoder.parse_null', {
        poolId: poolId.slice(0, 8) + '…',
        dataLength: data?.length || 0,
        cat: 'pools'
      });
      return null;
    }

    const mintA = parsed.tokenMintA?.toBase58?.() || '';
    const mintB = parsed.tokenMintB?.toBase58?.() || '';
    
    if (!mintA || !mintB) {
      logger.debug('orca.decoder.missing_mints', {
        poolId: poolId.slice(0, 8) + '…',
        cat: 'pools'
      });
      return null;
    }

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
    
    const data = Buffer.isBuffer(info.data) ? info.data : Buffer.from(info.data ?? []);
    
    if (!data || data.length === 0) {
      return { success: false, error: 'no_data', skipped: true };
    }

    // Decode the pool
    const decoded = await decodeOrcaWhirlpool(data, poolId, accountPubkey);
    if (!decoded) {
      wsDecodeStats.orca.failures += 1;
      return { success: false, error: 'decode_failed', skipped: true };
    }

    const { parsed, mintA, mintB } = decoded;
    const sqrtRaw = anyToBigInt(parsed.sqrtPrice);
    const sqrt_price_x64 = sqrtRaw ? Number(sqrtRaw) : Number(parsed.sqrtPrice);

    // Get decimals for the NATIVE mint order
    let decA: number | undefined;
    let decB: number | undefined;
    
    try {
      const { resolveDecimals } = await import('../../decimals.js');
      if (mintA) decA = await resolveDecimals(mintA);
      if (mintB) decB = await resolveDecimals(mintB);
    } catch {
      if (!Number.isFinite(decA)) decA = 9;
      if (!Number.isFinite(decB)) decB = 6;
    }

    // Process through price pipeline
    let processedPrice: ProcessedPriceResult | null = null;
    if (Number.isFinite(decA) && Number.isFinite(decB) && sqrtRaw) {
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
          cat: 'pools'
        });
      }
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
      executionCache.setHot(poolId, {
        sqrtPriceX64: sqrtRaw,
        currentTickIndex: Number(parsed.tickCurrentIndex),
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
    
    if (idx >= 0) {
      next.clmm[idx] = { ...next.clmm[idx], ...clmmItem };
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

