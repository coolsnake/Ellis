/**
 * Raydium pool decoder
 * 
 * Handles decoding and WebSocket updates for Raydium AMM and CLMM pools.
 * 
 * Raydium has two pool types:
 * - AMM V4: Uses LiquidityStateLayoutV4 for constant product pools
 * - CLMM: Uses PoolStateLayout for concentrated liquidity pools
 */

import { logger } from '../../../../utils/logger.js';
import { logCatchError, logCatchDebug } from '../../../../utils/errorHandler.js';
import { anyToBigInt } from '../../precision.js';
import { processPriceThroughPipeline } from '../../pricePipeline.js';
import { canonicalizePools } from '../../canonical.js';
import { diffNormalizedPools } from '../../../pools.utils.js';
import { raydiumCache } from '../../../pools.cache.js';
import { deriveRaydiumClmmCacheFields } from '../../../pools.derivation.js';
import { emit } from '../../../realtime.js';
import { wsDecodeStats, wsDeltaStats, incrementSkipReason } from '../../../pools.metrics.js';
import { validateDecodedPool, validatePriceDelta } from '../validation.js';
// Import pool eligibility tracking for reactive pool filtering
import { onPoolTickUpdate } from '../../../pools.websockets.js';
// Import pool activation tracking for lazy activation mode
import { tryActivatePool } from '../../../pools.activation.js';
import type { 
  DecodedPool, 
  UpdateResult, 
  AccountInfo, 
  ProcessedPriceResult,
  DerivedAccountInfo,
  PoolCache 
} from './types.js';
import type { AmmPool, ClmmPool, PoolsPayload } from '../../types.js';

// Program IDs
const RAYDIUM_AMM_PROGRAM = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const RAYDIUM_CLMM_PROGRAM = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';

// Debounce state for graph updates
let raydiumApplyState: { baseline: PoolsPayload | null; timer: NodeJS.Timeout | null } = { baseline: null, timer: null };
const DEBOUNCE_MS = 50;

/**
 * Convert value to base58 string safely
 */
function toB58(val: any): string {
  if (!val) return '';
  if (typeof val === 'string') return val;
  if (typeof val.toBase58 === 'function') return val.toBase58();
  return String(val);
}

/**
 * Schedule debounced graph update for Raydium
 */
async function scheduleDexApply(source: 'raydium', baseline: PoolsPayload): Promise<void> {
  try {
    if (!raydiumApplyState.baseline) {
      raydiumApplyState.baseline = baseline;
    }
    if (raydiumApplyState.timer) {
      clearTimeout(raydiumApplyState.timer);
    }
    raydiumApplyState.timer = setTimeout(async () => {
      try {
        const gmod: any = await import('../../../graph.js');
        const current = raydiumCache.data;
        if (current && raydiumApplyState.baseline) {
          // Use applyPoolUpdates for incremental graph updates
          if (typeof gmod?.applyPoolUpdates === 'function') {
            await gmod.applyPoolUpdates(raydiumApplyState.baseline, current, { pushToArb: false });
          }
        }
      } catch (e) {
        logCatchDebug('raydium.scheduleDexApply', e);
      } finally {
        raydiumApplyState.baseline = null;
        raydiumApplyState.timer = null;
      }
    }, DEBOUNCE_MS);
  } catch (e) {
    logCatchDebug('raydium.scheduleDexApply.setup', e);
  }
}

/**
 * Decode Raydium CLMM pool from account data
 */
export async function decodeRaydiumClmmPool(
  data: Buffer,
  poolId: string,
  derivedAccountToPool?: Map<string, DerivedAccountInfo>
): Promise<DecodedPool | null> {
  try {
    const rmod: any = await import('@raydium-io/raydium-sdk-v2').catch(() => null);
    if (!rmod || !data) return null;

    const clmmLayout = rmod?.Clmm?.PoolStateLayout || rmod?.CLMM?.POOL_STATE_LAYOUT || rmod?.PoolStateLayout || rmod?.PoolInfoLayout;
    if (!clmmLayout || typeof clmmLayout.decode !== 'function') return null;

    let state: any;
    try {
      state = clmmLayout.decode(data);
    } catch {
      return null;
    }

    if (!state) return null;

    // Validate required fields
    const hasLiquidityField = state?.liquidity != null;
    const hasMintFields = !!(state?.mintA || state?.tokenMintA || state?.mint_a || state?.token_mint_a);
    if (!hasLiquidityField || !hasMintFields) return null;

    const mintA = (state.mintA || state.tokenMintA)?.toBase58?.() || '';
    const mintB = (state.mintB || state.tokenMintB)?.toBase58?.() || '';
    if (!mintA || !mintB) return null;

    const sqrtRaw = anyToBigInt(state.sqrtPriceX64 ?? state.sqrt_price_x64 ?? state.sqrtPrice ?? 0);
    const liqRaw = anyToBigInt(state.liquidity ?? 0);
    const liq = Number(state.liquidity ?? 0);
    const tick = Number(state.tickSpacing ?? state.tick_spacing ?? 0);
    
    // CRITICAL: Raydium CLMM pools store fee in ammConfig account, not pool state.
    // The SDK-decoded state.tradeFeeRate is often 0/undefined.
    // Fee values may be in PPM (parts per million) - need to convert to BPS.
    // Fallback to cached fee_bps from HTTP fetch or execution cache to preserve correct fees.
    let fee = Number(state.tradeFeeRate ?? state.feeRate ?? state.fee_rate ?? 0);
    
    // Convert from PPM to BPS if value appears to be in PPM format
    // PPM values are typically > 10000 for any fee (since 10000 BPS = 100%)
    if (Number.isFinite(fee) && fee > 10000) {
      fee = Math.round(fee / 100);
    }
    
    if (!Number.isFinite(fee) || fee <= 0) {
      // Try to get cached fee from pool cache
      const cachedPools = raydiumCache.data;
      const existingPool = cachedPools?.clmm?.find(p => p.id === poolId);
      if (existingPool?.fee_bps && existingPool.fee_bps > 0) {
        fee = existingPool.fee_bps;
      } else {
        // Try execution cache as fallback
        try {
          const { executionCache } = await import('../../../../execution/cache.js');
          const hotData = executionCache.getHot(poolId);
          if (hotData?.feeRate && hotData.feeRate > 0) {
            fee = hotData.feeRate;
          }
        } catch {}
      }
    }

    if (tick <= 0) return null;

    // Check for derived account (vault) confusion
    if (derivedAccountToPool?.has(poolId)) {
      const derivedMeta = derivedAccountToPool.get(poolId);
      logger.warn('raydium.decoder.clmm.vault_as_pool.prevented', {
        account: poolId.slice(0, 8) + '…',
        accountType: derivedMeta?.accountType,
        parentPool: derivedMeta?.poolId?.slice(0, 8) + '…',
        reason: 'account_is_vault_not_pool',
        cat: 'pools'
      });
      return null;
    }

    // Additional validation: Pools should have vault fields
    const hasVaultFields = !!(state?.vaultA || state?.tokenVault0 || state?.vaultB || state?.tokenVault1);
    if (!hasVaultFields) {
      logger.debug('raydium.decoder.clmm.missing_vault_fields', {
        account: poolId.slice(0, 8) + '…',
        stateKeys: Object.keys(state || {}).slice(0, 20),
        cat: 'pools'
      });
    }

    return {
      id: poolId,
      dex: 'Raydium',
      mint_a: mintA,
      mint_b: mintB,
      fee_bps: fee,
      sqrt_price_x64: Number.isFinite(Number(sqrtRaw)) ? Number(sqrtRaw) : Number(state.sqrtPriceX64 ?? state.sqrt_price_x64 ?? state.sqrtPrice ?? 0),
      sqrt_price_x64_raw: sqrtRaw?.toString(),
      liquidity: Number.isFinite(liq) ? liq : 0,
      liquidity_raw: liqRaw?.toString(),
      tick_spacing: tick,
      updated_ms: Date.now(),
      pool_kind: 'clmm',
      liquidity_display: liq,
      price_a_per_b: 0, // Will be calculated through pipeline
      native_mint_a: mintA,
      native_mint_b: mintB,
    };
  } catch (e) {
    logCatchDebug('raydium.decodeClmm', e, { poolId });
    return null;
  }
}

/**
 * Decode Raydium AMM V4 pool from account data
 */
export async function decodeRaydiumAmmPool(
  data: Buffer,
  poolId: string,
  derivedAccountToPool?: Map<string, DerivedAccountInfo>
): Promise<DecodedPool | null> {
  try {
    const rmod: any = await import('@raydium-io/raydium-sdk-v2').catch(() => null);
    if (!rmod || !data) return null;

    const ammLayout = rmod?.LiquidityStateLayoutV4 || rmod?.LIQUIDITY_STATE_LAYOUT_V4;
    if (!ammLayout || typeof ammLayout.decode !== 'function') return null;

    let state: any;
    try {
      state = ammLayout.decode(data);
    } catch {
      return null;
    }

    if (!state) return null;

    const mintA = (state.baseMint || state.mintA || state.mint_a)?.toBase58?.() || '';
    const mintB = (state.quoteMint || state.mintB || state.mint_b)?.toBase58?.() || '';
    if (!mintA || !mintB) return null;

    // Reserves may be BN; best-effort convert to number
    const rA = Number((state.baseReserve || state.reserveA || state.vaultA || 0).toString ? state.baseReserve.toString() : (state.baseReserve || 0));
    const rB = Number((state.quoteReserve || state.reserveB || state.vaultB || 0).toString ? state.quoteReserve.toString() : (state.quoteReserve || 0));
    const liqBase = (rA > 0 && rB > 0) ? Math.min(rA, rB) : 0;
    
    // Fallback to cached fee_bps if on-chain extraction fails
    // Fee values may be in PPM (parts per million) - need to convert to BPS.
    let fee = Number(state.tradeFeeRate || state.feeRate || 0);
    
    // Convert from PPM to BPS if value appears to be in PPM format
    if (Number.isFinite(fee) && fee > 10000) {
      fee = Math.round(fee / 100);
    }
    
    if (!Number.isFinite(fee) || fee <= 0) {
      const cachedPools = raydiumCache.data;
      const existingPool = cachedPools?.amm?.find(p => p.id === poolId);
      if (existingPool?.fee_bps && existingPool.fee_bps > 0) {
        fee = existingPool.fee_bps;
      } else {
        // Try execution cache as fallback
        try {
          const { executionCache } = await import('../../../../execution/cache.js');
          const hotData = executionCache.getHot(poolId);
          if (hotData?.feeRate && hotData.feeRate > 0) {
            fee = hotData.feeRate;
          }
        } catch {}
      }
    }

    // Check for derived account (vault) confusion
    if (derivedAccountToPool?.has(poolId)) {
      const derivedMeta = derivedAccountToPool.get(poolId);
      logger.warn('raydium.decoder.amm.vault_as_pool.prevented', {
        account: poolId.slice(0, 8) + '…',
        accountType: derivedMeta?.accountType,
        parentPool: derivedMeta?.poolId?.slice(0, 8) + '…',
        reason: 'account_is_vault_not_pool',
        cat: 'pools'
      });
      return null;
    }

    return {
      id: poolId,
      dex: 'Raydium',
      mint_a: mintA,
      mint_b: mintB,
      fee_bps: fee,
      liquidity_base: liqBase,
      updated_ms: Date.now(),
      pool_kind: 'amm',
      liquidity_display: liqBase,
      price_a_per_b: 0, // Will be calculated through pipeline
      native_mint_a: mintA,
      native_mint_b: mintB,
      reserve_a_raw: rA > 0 ? String(rA) : undefined,
      reserve_b_raw: rB > 0 ? String(rB) : undefined,
    };
  } catch (e) {
    logCatchDebug('raydium.decodeAmm', e, { poolId });
    return null;
  }
}

/**
 * Get decimals for a mint from cache or resolver
 */
async function getDecimals(
  mint: string,
  poolId: string,
  existingPool?: ClmmPool | AmmPool | null,
  isNative: boolean = true
): Promise<number | undefined> {
  // First try cache (use native decimals if available)
  if (existingPool) {
    if (isNative) {
      const dec = (existingPool as any).native_decimals_a;
      if (Number.isFinite(dec)) return dec;
    }
    const dec = existingPool.decimals_a;
    if (Number.isFinite(dec)) return dec;
  }

  // Try execution cache
  try {
    const { executionCache } = await import('../../../../execution/cache.js');
    const cached = executionCache.getStatic(poolId);
    if (cached) {
      if (isNative && cached.native_decimals_a) return cached.native_decimals_a;
      if (cached.decimals_a) return cached.decimals_a;
    }
  } catch {}

  // Fallback to resolver
  try {
    const { resolveDecimals } = await import('../../decimals.js');
    return await resolveDecimals(mint);
  } catch {}

  return undefined;
}

/**
 * Handle Raydium WebSocket update for CLMM pools
 */
async function handleClmmUpdate(
  info: AccountInfo,
  poolId: string,
  derivedAccountToPool: Map<string, DerivedAccountInfo>,
  owner: string
): Promise<UpdateResult> {
  const data = Buffer.isBuffer(info.data) ? info.data : Buffer.from(info.data ?? []);
  
  // Decode the pool
  const decoded = await decodeRaydiumClmmPool(data, poolId, derivedAccountToPool);
  if (!decoded) {
    return { success: false, error: 'decode_failed', skipped: true };
  }

  const mintA = decoded.native_mint_a || decoded.mint_a;
  const mintB = decoded.native_mint_b || decoded.mint_b;
  const sqrtRaw = anyToBigInt(decoded.sqrt_price_x64_raw ?? decoded.sqrt_price_x64);

  // Get decimals from cache
  const cachedPools = raydiumCache.data || { amm: [], clmm: [], cpmm: [] };
  const existing = cachedPools.clmm.find(p => p.id === poolId);
  
  let decA = existing?.native_decimals_a ?? existing?.decimals_a;
  let decB = existing?.native_decimals_b ?? existing?.decimals_b;

  // Fallback to execution cache or resolver
  if (!Number.isFinite(decA) || !Number.isFinite(decB)) {
    try {
      const { executionCache } = await import('../../../../execution/cache.js');
      const cached = executionCache.getStatic(poolId);
      if (!Number.isFinite(decA)) decA = cached?.native_decimals_a ?? cached?.decimals_a;
      if (!Number.isFinite(decB)) decB = cached?.native_decimals_b ?? cached?.decimals_b;
    } catch {}
  }

  if (!Number.isFinite(decA) || !Number.isFinite(decB)) {
    try {
      const { resolveDecimals } = await import('../../decimals.js');
      if (!Number.isFinite(decA) && mintA) decA = await resolveDecimals(mintA);
      if (!Number.isFinite(decB) && mintB) decB = await resolveDecimals(mintB);
    } catch (resolveErr) {
      logger.warn('raydium.decoder.clmm.decimals_resolve_error', {
        poolId: poolId.slice(0, 8) + '…',
        mintA: mintA?.slice(0, 8) + '…',
        mintB: mintB?.slice(0, 8) + '…',
        error: String((resolveErr as Error)?.message || resolveErr),
        cat: 'pools'
      });
    }
  }

  // Fallback to defaults if decimals still not resolved - log this as it may cause price errors
  if (!Number.isFinite(decA)) {
    logger.warn('raydium.decoder.clmm.decimals_fallback', {
      poolId: poolId.slice(0, 8) + '…',
      mint: mintA?.slice(0, 8) + '…',
      side: 'A',
      fallbackValue: 9,
      reason: 'all_resolution_sources_failed',
      cat: 'pools'
    });
    decA = 9;
  }
  if (!Number.isFinite(decB)) {
    logger.warn('raydium.decoder.clmm.decimals_fallback', {
      poolId: poolId.slice(0, 8) + '…',
      mint: mintB?.slice(0, 8) + '…',
      side: 'B',
      fallbackValue: 6,
      reason: 'all_resolution_sources_failed',
      cat: 'pools'
    });
    decB = 6;
  }

  // Validate decimals against known tokens
  try {
    const { validateDecimalsForMint } = await import('../../decimals.js');
    if (Number.isFinite(decA)) validateDecimalsForMint(mintA, decA!, poolId, 'Raydium');
    if (Number.isFinite(decB)) validateDecimalsForMint(mintB, decB!, poolId, 'Raydium');
  } catch {}

  // Process through price pipeline
  let processedPrice: ProcessedPriceResult | null = null;
  if (Number.isFinite(decA) && Number.isFinite(decB) && sqrtRaw) {
    processedPrice = processPriceThroughPipeline({
      mintA,
      mintB,
      decimalsA: decA!,
      decimalsB: decB!,
      poolId,
      dex: 'Raydium',
      poolType: 'clmm',
      sqrtPriceX64: sqrtRaw,
    });
  }

  if (!processedPrice) {
    wsDeltaStats.raydium_clmm.skipped += 1;
    incrementSkipReason('raydium_clmm', 'price_calc_failed');
    return { success: false, error: 'price_calc_failed', skipped: true, skipReason: 'price_calc_failed:clmm' };
  }

  // Build the pool item with pipeline-processed prices
  const item: ClmmPool = {
    id: poolId,
    dex: 'Raydium',
    mint_a: processedPrice.mintA,
    mint_b: processedPrice.mintB,
    fee_bps: decoded.fee_bps,
    sqrt_price_x64: decoded.sqrt_price_x64 || 0,
    sqrt_price_x64_raw: decoded.sqrt_price_x64_raw,
    liquidity: decoded.liquidity || 0,
    liquidity_raw: decoded.liquidity_raw,
    tick_spacing: decoded.tick_spacing || 0,
    updated_ms: Date.now(),
    pool_kind: 'clmm',
    liquidity_display: decoded.liquidity,
    price_a_per_b: processedPrice.priceForward,
    decimals_a: processedPrice.decimalsA,
    decimals_b: processedPrice.decimalsB,
    was_swapped: processedPrice.wasSwapped,
    native_mint_a: mintA,
    native_mint_b: mintB,
    _pipelineProcessed: true,
  } as ClmmPool;

  // Validate decoded pool
  const validation = validateDecodedPool('raydium', item, poolId);
  if (!validation.valid) {
    wsDecodeStats.raydium_clmm.failures += 1;
    incrementSkipReason('raydium_clmm', `validation_failed:${validation.reasons.join(',')}`);
    return { success: false, error: `validation_failed:${validation.reasons.join(',')}`, skipped: true };
  }

  // Track CLMM attempt
  wsDecodeStats.raydium_clmm.attempts += 1;

  // Update cache
  const prev = raydiumCache.data || { amm: [], clmm: [], cpmm: [] };
  const next: PoolsPayload = { amm: prev.amm.slice(), clmm: prev.clmm.slice(), cpmm: prev.cpmm?.slice() || [] };
  const idx = next.clmm.findIndex(p => p.id === item.id);

  // Validate price delta against previous value
  // CRITICAL: Check was_swapped to handle orientation differences between HTTP and WS updates
  if (idx >= 0) {
    const prevPool = next.clmm[idx];
    const prevWasSwapped = (prevPool as any).was_swapped ?? false;
    const newWasSwapped = processedPrice?.wasSwapped ?? false;
    
    // Only validate price delta if orientations match
    if (prevWasSwapped === newWasSwapped) {
      validatePriceDelta('raydium', poolId, item.price_a_per_b, prevPool.price_a_per_b);
    } else {
      // Orientation changed - compare with inverted previous price to avoid false alarms
      const adjustedPrevPrice = prevPool.price_a_per_b && prevPool.price_a_per_b > 0 
        ? 1 / prevPool.price_a_per_b 
        : undefined;
      validatePriceDelta('raydium', poolId, item.price_a_per_b, adjustedPrevPrice);
      
      logger.debug('raydium.clmm.ws.orientation_flip', {
        poolId: poolId.slice(0, 8) + '…',
        prevWasSwapped,
        newWasSwapped,
        prevPrice: prevPool.price_a_per_b,
        newPrice: item.price_a_per_b,
        adjustedPrevPrice,
        cat: 'pools'
      });
    }
  }

  if (idx >= 0) {
    const prevPool = next.clmm[idx];
    const orientationChanged = prevPool.mint_a !== item.mint_a || prevPool.mint_b !== item.mint_b;
    if (orientationChanged) {
      logger.warn('ws.update.orientation_changed', {
        poolId: poolId.slice(0, 8) + '…',
        dex: 'Raydium',
        poolType: 'clmm',
        prevMintA: prevPool.mint_a?.slice(0, 8),
        prevMintB: prevPool.mint_b?.slice(0, 8),
        newMintA: item.mint_a?.slice(0, 8),
        newMintB: item.mint_b?.slice(0, 8),
        cat: 'pools'
      });
      
      const orientationIndependentFields = {
        tvl_usd: prevPool.tvl_usd,
        liquidity_display: prevPool.liquidity_display,
        pool_liquidity_raw: prevPool.pool_liquidity_raw,
      };
      next.clmm[idx] = { ...item, ...orientationIndependentFields };
    } else {
      next.clmm[idx] = { ...next.clmm[idx], ...item };
    }
  } else {
    next.clmm.push(item);
  }

  // Update execution cache with raw account data
  try {
    const { executionCache } = await import('../../../../execution/cache.js');
    const existingStatic = executionCache.getStatic(poolId) || {};
    const derived = await deriveRaydiumClmmCacheFields(poolId, data, { programId: owner });
    
    const nextStatic: any = {
      ...existingStatic,
      rawAccountData: data,
      rawAccountDataUpdatedMs: Date.now(),
      mint_a: processedPrice.mintA,
      mint_b: processedPrice.mintB,
      decimals_a: processedPrice.decimalsA,
      decimals_b: processedPrice.decimalsB,
      // CRITICAL: Store native (on-chain) mint orientation for SDK compatibility
      // native_mint_a/b are the actual on-chain values BEFORE canonicalization
      // The Raydium SDK expects native ordering for swap instructions
      native_mint_a: mintA,
      native_mint_b: mintB,
      native_decimals_a: decA,
      native_decimals_b: decB,
    };

    if (derived) {
      if (derived.programId) nextStatic.programId = derived.programId;
      if (derived.oracle) nextStatic.oracle = derived.oracle;
      if (derived.observationState) nextStatic.observation_state = derived.observationState;
      if (derived.ammConfig) nextStatic.amm_config = derived.ammConfig;
      
      if (derived.vaultA && derived.vaultB) {
        if (processedPrice.wasSwapped) {
          nextStatic.account_a = derived.vaultB;
          nextStatic.account_b = derived.vaultA;
        } else {
          nextStatic.account_a = derived.vaultA;
          nextStatic.account_b = derived.vaultB;
        }
        nextStatic.native_account_a = derived.vaultA;
        nextStatic.native_account_b = derived.vaultB;
      }
      
      if (derived.tickSpacing) nextStatic.tick_spacing = derived.tickSpacing;
      if (derived.tickArrays?.lower) {
        nextStatic.tickArrayLower = typeof derived.tickArrays.lower === 'string'
          ? derived.tickArrays.lower
          : (Array.isArray(derived.tickArrays.lower) && derived.tickArrays.lower.length > 0
            ? derived.tickArrays.lower[0]
            : undefined);
      }
      if (derived.tickArrays?.center) nextStatic.tickArrayCenter = derived.tickArrays.center;
      if (derived.tickArrays?.upper) {
        nextStatic.tickArrayUpper = typeof derived.tickArrays.upper === 'string'
          ? derived.tickArrays.upper
          : (Array.isArray(derived.tickArrays.upper) && derived.tickArrays.upper.length > 0
            ? derived.tickArrays.upper[0]
            : undefined);
      }
      // Store exBitmap (tick array bitmap extension) - required for swap instruction optimization
      if (derived.exBitmap) {
        nextStatic.ex_bitmap = derived.exBitmap;
      }
    }
    
    executionCache.setStatic(poolId, nextStatic);
    
    if (derived?.tickArrays || derived?.tickCurrent !== undefined) {
      const hotExisting = executionCache.getHot(poolId) || {};
      
      // Build hot cache update
      // IMPORTANT: If derivation flagged needsTickArrayValidation, propagate it
      // This happens when only center array was derived (safe mode)
      const hotUpdate: any = {
        currentTickIndex: derived?.tickCurrent ?? hotExisting.currentTickIndex,
        // Include tickSpacing for boundary crossing detection in cache
        tickSpacing: derived?.tickSpacing ?? hotExisting.tickSpacing,
      };
      
      // Only include tick arrays if we have them from derivation
      // The cache.setHot will handle boundary crossing detection
      if (derived?.tickArrays) {
        hotUpdate.tickArrays = derived.tickArrays;
      }
      
      // If derivation flagged needsTickArrayValidation, set it explicitly
      // This allows the background validator to pick up this pool
      if (derived?.needsTickArrayValidation) {
        hotUpdate.needsTickArrayValidation = true;
        hotUpdate.tickArrayInvalidatedAt = Date.now();
      }
      
      executionCache.setHot(poolId, hotUpdate);
      
      // Check pool eligibility on tick update
      // This enables reactive pool filtering when tick moves in/out of safe range
      if (derived?.tickCurrent !== undefined) {
        try {
          onPoolTickUpdate(poolId, derived.tickCurrent);
        } catch (eligibilityErr) {
          // Non-fatal - log and continue
          logCatchDebug('raydium.eligibility_check', eligibilityErr);
        }
      }
    }
  } catch (cacheErr) {
    logCatchDebug('raydium.clmm.cache_update', cacheErr, { pool: poolId.slice(0, 8) + '…' });
  }

  // Update stats and cache
  wsDecodeStats.raydium_clmm.successes += 1;
  wsDeltaStats.raydium_clmm.decoded += 1;
  
  const delta = diffNormalizedPools(prev, next);
  raydiumCache.data = next;
  raydiumCache.ts = Date.now();

  const hasDelta = delta.amm.length || delta.clmm.length || delta.addedAmm || delta.removedAmm || delta.addedClmm || delta.removedClmm;
  if (hasDelta) {
    wsDeltaStats.raydium_clmm.applied += 1;
  } else {
    wsDeltaStats.raydium_clmm.skipped += 1;
    const prevPool = prev.clmm.find(p => p.id === item.id);
    if (prevPool) {
      const reasons: string[] = [];
      if ((prevPool as any).sqrt_price_x64_raw === item.sqrt_price_x64_raw) reasons.push('sqrt_price_unchanged');
      if ((prevPool as any).liquidity_raw === item.liquidity_raw) reasons.push('liquidity_raw_unchanged');
      if (Math.abs((prevPool.liquidity || 0) - (item.liquidity || 0)) === 0) reasons.push('liquidity_unchanged');
      if (Math.abs((prevPool.price_a_per_b || 0) - (item.price_a_per_b || 0)) <= 1e-9) reasons.push('price_unchanged');
      incrementSkipReason('raydium_clmm', reasons.length > 0 ? reasons.join('+') : 'no_delta_detected');
    } else {
      incrementSkipReason('raydium_clmm', 'new_pool');
    }
  }

  // Emit update event
  try {
    emit('pool-updates', {
      source: 'raydium',
      updatedAmm: delta.amm.length,
      updatedClmm: delta.clmm.length,
      sample: { amm: delta.amm.slice(0, 20), clmm: [] },
      ts: Date.now()
    });
  } catch {}

  // Schedule graph update
  if (hasDelta) {
    await scheduleDexApply('raydium', prev);
  }

  // Try to activate pool for lazy activation mode (only activates on first valid price update)
  const hasValidPrice = !!(
    processedPrice?.priceForward &&
    Number.isFinite(processedPrice.priceForward) &&
    processedPrice.priceForward > 0
  );
  tryActivatePool(poolId, 'raydium', hasValidPrice);

  return { success: true, pool: item as DecodedPool, delta };
}

/**
 * Handle Raydium WebSocket update for AMM pools
 */
async function handleAmmUpdate(
  info: AccountInfo,
  poolId: string,
  derivedAccountToPool: Map<string, DerivedAccountInfo>
): Promise<UpdateResult> {
  const data = Buffer.isBuffer(info.data) ? info.data : Buffer.from(info.data ?? []);
  
  // Decode the pool
  const decoded = await decodeRaydiumAmmPool(data, poolId, derivedAccountToPool);
  if (!decoded) {
    return { success: false, error: 'decode_failed', skipped: true };
  }

  const mintA = decoded.native_mint_a || decoded.mint_a;
  const mintB = decoded.native_mint_b || decoded.mint_b;
  const rA = Number(decoded.reserve_a_raw || 0);
  const rB = Number(decoded.reserve_b_raw || 0);

  // Get decimals from cache
  const cachedPools = raydiumCache.data || { amm: [], clmm: [], cpmm: [] };
  const existing = cachedPools.amm.find(p => p.id === poolId);
  
  let decA = existing?.native_decimals_a ?? existing?.decimals_a;
  let decB = existing?.native_decimals_b ?? existing?.decimals_b;

  // Fallback to execution cache or resolver
  if (!Number.isFinite(decA) || !Number.isFinite(decB)) {
    try {
      const { executionCache } = await import('../../../../execution/cache.js');
      const cached = executionCache.getStatic(poolId);
      if (!Number.isFinite(decA)) decA = cached?.native_decimals_a ?? cached?.decimals_a;
      if (!Number.isFinite(decB)) decB = cached?.native_decimals_b ?? cached?.decimals_b;
    } catch {}
  }

  if (!Number.isFinite(decA) || !Number.isFinite(decB)) {
    try {
      const { resolveDecimals } = await import('../../decimals.js');
      if (!Number.isFinite(decA) && mintA) decA = await resolveDecimals(mintA);
      if (!Number.isFinite(decB) && mintB) decB = await resolveDecimals(mintB);
    } catch (resolveErr) {
      logger.warn('raydium.decoder.amm.decimals_resolve_error', {
        poolId: poolId.slice(0, 8) + '…',
        mintA: mintA?.slice(0, 8) + '…',
        mintB: mintB?.slice(0, 8) + '…',
        error: String((resolveErr as Error)?.message || resolveErr),
        cat: 'pools'
      });
    }
  }

  // Fallback to defaults if decimals still not resolved - log this as it may cause price errors
  if (!Number.isFinite(decA)) {
    logger.warn('raydium.decoder.amm.decimals_fallback', {
      poolId: poolId.slice(0, 8) + '…',
      mint: mintA?.slice(0, 8) + '…',
      side: 'A',
      fallbackValue: 9,
      reason: 'all_resolution_sources_failed',
      cat: 'pools'
    });
    decA = 9;
  }
  if (!Number.isFinite(decB)) {
    logger.warn('raydium.decoder.amm.decimals_fallback', {
      poolId: poolId.slice(0, 8) + '…',
      mint: mintB?.slice(0, 8) + '…',
      side: 'B',
      fallbackValue: 6,
      reason: 'all_resolution_sources_failed',
      cat: 'pools'
    });
    decB = 6;
  }

  // Validate decimals against known tokens
  try {
    const { validateDecimalsForMint } = await import('../../decimals.js');
    if (Number.isFinite(decA)) validateDecimalsForMint(mintA, decA!, poolId, 'Raydium');
    if (Number.isFinite(decB)) validateDecimalsForMint(mintB, decB!, poolId, 'Raydium');
  } catch {}

  // Calculate price using correct AMM formula with decimal adjustment
  let price_a_per_b: number | undefined;
  if (rA > 0 && rB > 0 && Number.isFinite(decA) && Number.isFinite(decB)) {
    const atomicRatio = rA / rB;
    const decimalAdjustment = Math.pow(10, decB! - decA!);
    price_a_per_b = atomicRatio * decimalAdjustment;
  }

  // Build the pool item
  const item: AmmPool = {
    id: poolId,
    dex: 'Raydium',
    mint_a: mintA,
    mint_b: mintB,
    fee_bps: decoded.fee_bps,
    price_a_per_b: price_a_per_b || 0,
    liquidity_base: decoded.liquidity_base || 0,
    updated_ms: Date.now(),
    pool_kind: 'amm',
    liquidity_display: decoded.liquidity_base,
    decimals_a: decA,
    decimals_b: decB,
  } as AmmPool;

  // Validate decoded pool
  const validation = validateDecodedPool('raydium', item, poolId);
  if (!validation.valid) {
    wsDecodeStats.raydium_amm.failures += 1;
    incrementSkipReason('raydium_amm', `validation_failed:${validation.reasons.join(',')}`);
    return { success: false, error: `validation_failed:${validation.reasons.join(',')}`, skipped: true };
  }

  // Track AMM attempt
  wsDecodeStats.raydium_amm.attempts += 1;

  // Canonicalize pool
  const [canonicalItem] = canonicalizePools([{ ...item }]);
  const finalItem = canonicalItem || item;

  // Update cache
  const prev = raydiumCache.data || { amm: [], clmm: [], cpmm: [] };
  const next: PoolsPayload = { amm: prev.amm.slice(), clmm: prev.clmm.slice(), cpmm: prev.cpmm?.slice() || [] };
  const idx = next.amm.findIndex(p => p.id === finalItem.id);

  // Validate price delta against previous value
  // CRITICAL: Check orientation to handle differences between HTTP and WS updates
  // For Raydium AMM, we use canonicalizePools which may swap mints
  if (idx >= 0) {
    const prevPool = next.amm[idx];
    // Detect if canonicalization changed the orientation
    const wasSwappedByCanon = item.mint_a !== finalItem.mint_a;
    const prevWasSwapped = (prevPool as any).was_swapped ?? false;
    
    // Only validate price delta if orientations match
    if (prevWasSwapped === wasSwappedByCanon) {
      validatePriceDelta('raydium', poolId, finalItem.price_a_per_b, prevPool.price_a_per_b);
    } else {
      // Orientation changed - compare with inverted previous price to avoid false alarms
      const adjustedPrevPrice = prevPool.price_a_per_b && prevPool.price_a_per_b > 0 
        ? 1 / prevPool.price_a_per_b 
        : undefined;
      validatePriceDelta('raydium', poolId, finalItem.price_a_per_b, adjustedPrevPrice);
      
      logger.debug('raydium.amm.ws.orientation_flip', {
        poolId: poolId.slice(0, 8) + '…',
        prevWasSwapped,
        wasSwappedByCanon,
        prevPrice: prevPool.price_a_per_b,
        newPrice: finalItem.price_a_per_b,
        adjustedPrevPrice,
        cat: 'pools'
      });
    }
  }

  if (idx >= 0) {
    const prevPool = next.amm[idx];
    const orientationChanged = prevPool.mint_a !== finalItem.mint_a || prevPool.mint_b !== finalItem.mint_b;
    if (orientationChanged) {
      logger.warn('ws.update.orientation_changed', {
        poolId: poolId.slice(0, 8) + '…',
        dex: 'Raydium',
        poolType: 'amm',
        prevMintA: prevPool.mint_a?.slice(0, 8),
        prevMintB: prevPool.mint_b?.slice(0, 8),
        newMintA: finalItem.mint_a?.slice(0, 8),
        newMintB: finalItem.mint_b?.slice(0, 8),
        cat: 'pools'
      });
      
      const orientationIndependentFields = {
        tvl_usd: prevPool.tvl_usd,
        liquidity_display: prevPool.liquidity_display,
        pool_liquidity_raw: prevPool.pool_liquidity_raw,
      };
      next.amm[idx] = { ...finalItem, ...orientationIndependentFields };
    } else {
      next.amm[idx] = { ...next.amm[idx], ...finalItem };
    }
  } else {
    next.amm.push(finalItem);
  }

  // Update execution cache with AMM-specific fields for zero-RPC building
  try {
    const { executionCache } = await import('../../../../execution/cache.js');
    const existingStatic = executionCache.getStatic(poolId) || {};
    
    // Extract market_id and market_program_id from the decoded pool state
    // Use (decoded as any) because these fields come from Raydium SDK decoding
    const decodedAny = decoded as any;
    const marketId = toB58(decodedAny.marketId || decodedAny.market_id);
    const marketProgramId = toB58(decodedAny.marketProgramId || decodedAny.market_program_id);
    
    executionCache.setStatic(poolId, {
      ...existingStatic,
      rawAccountData: data,
      rawAccountDataUpdatedMs: Date.now(),
      // AMM-specific fields for transaction building
      market_id: marketId || existingStatic.market_id,
      market_program_id: marketProgramId || existingStatic.market_program_id,
      vault_a: (existingStatic as any).vault_a || (decodedAny.baseVault ? toB58(decodedAny.baseVault) : undefined),
      vault_b: (existingStatic as any).vault_b || (decodedAny.quoteVault ? toB58(decodedAny.quoteVault) : undefined),
      mint_a: existingStatic.mint_a || (decodedAny.baseMint ? toB58(decodedAny.baseMint) : undefined),
      mint_b: existingStatic.mint_b || (decodedAny.quoteMint ? toB58(decodedAny.quoteMint) : undefined),
    });
  } catch {}

  // Update stats and cache
  wsDecodeStats.raydium_amm.successes += 1;
  wsDeltaStats.raydium_amm.decoded += 1;
  
  const delta = diffNormalizedPools(prev, next);
  raydiumCache.data = next;
  raydiumCache.ts = Date.now();

  const hasDelta = delta.amm.length || delta.clmm.length || delta.addedAmm || delta.removedAmm || delta.addedClmm || delta.removedClmm;
  if (hasDelta) {
    wsDeltaStats.raydium_amm.applied += 1;
  } else {
    wsDeltaStats.raydium_amm.skipped += 1;
    const prevPool = prev.amm.find(p => p.id === item.id);
    if (prevPool) {
      const reasons: string[] = [];
      if ((prevPool as any).reserve_a_raw === (item as any).reserve_a_raw && (prevPool as any).reserve_b_raw === (item as any).reserve_b_raw) reasons.push('reserves_unchanged');
      if (Math.abs((prevPool.liquidity_base || 0) - (item.liquidity_base || 0)) === 0) reasons.push('liquidity_unchanged');
      if (Math.abs((prevPool.price_a_per_b || 0) - (item.price_a_per_b || 0)) <= 1e-9) reasons.push('price_unchanged');
      incrementSkipReason('raydium_amm', reasons.length > 0 ? reasons.join('+') : 'no_delta_detected');
    } else {
      incrementSkipReason('raydium_amm', 'new_pool');
    }
  }

  // Emit update event
  try {
    emit('pool-updates', {
      source: 'raydium',
      updatedAmm: delta.amm.length,
      updatedClmm: delta.clmm.length,
      sample: { amm: delta.amm.slice(0, 20), clmm: [] },
      ts: Date.now()
    });
  } catch {}

  // Schedule graph update
  if (hasDelta) {
    await scheduleDexApply('raydium', prev);
  }

  // Try to activate pool for lazy activation mode (only activates on first valid price update)
  const hasValidPriceAmm = !!(
    finalItem.price_a_per_b &&
    Number.isFinite(finalItem.price_a_per_b) &&
    finalItem.price_a_per_b > 0
  );
  tryActivatePool(poolId, 'raydium', hasValidPriceAmm);

  return { success: true, pool: finalItem as unknown as DecodedPool, delta };
}

/**
 * Handle Raydium WebSocket account update
 * 
 * This is the main entry point for processing Raydium pool updates from WebSocket.
 * It determines whether the update is for a CLMM or AMM pool and routes accordingly.
 */
export async function handleRaydiumUpdate(
  info: AccountInfo,
  poolId: string,
  derivedAccountToPool: Map<string, DerivedAccountInfo> = new Map()
): Promise<UpdateResult> {
  try {
    // Note: Attempts are tracked in individual handlers (raydium_clmm, raydium_amm)
    
    const owner = typeof info.owner === 'string' ? info.owner : info.owner?.toBase58?.() || '';
    const data = Buffer.isBuffer(info.data) ? info.data : Buffer.from(info.data ?? []);
    
    if (!data || data.length === 0) {
      return { success: false, error: 'no_data', skipped: true };
    }

    // Try CLMM decode first
    const clmmDecoded = await decodeRaydiumClmmPool(data, poolId, derivedAccountToPool);
    if (clmmDecoded) {
      return handleClmmUpdate(info, poolId, derivedAccountToPool, owner);
    }

    // Try AMM decode
    const ammDecoded = await decodeRaydiumAmmPool(data, poolId, derivedAccountToPool);
    if (ammDecoded) {
      return handleAmmUpdate(info, poolId, derivedAccountToPool);
    }

    // Neither decoder succeeded - track as unknown type failure
    // We don't increment specific type failures since the pool type is indeterminate
    return { success: false, error: 'decode_failed_both', skipped: true };
  } catch (e) {
    logCatchError('raydium.handleUpdate', e, { poolId: poolId.slice(0, 8) + '…' });
    return { success: false, error: String((e as Error)?.message || e) };
  }
}

/**
 * Check if an owner is a Raydium program
 */
export function isRaydiumOwner(owner: string): boolean {
  return owner === RAYDIUM_AMM_PROGRAM || owner === RAYDIUM_CLMM_PROGRAM;
}

/**
 * Get Raydium program IDs
 */
export const RAYDIUM_PROGRAMS = {
  AMM: RAYDIUM_AMM_PROGRAM,
  CLMM: RAYDIUM_CLMM_PROGRAM,
};

