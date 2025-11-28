/**
 * Meteora DLMM pool decoder
 * 
 * Handles decoding and WebSocket updates for Meteora DLMM (Dynamic Liquidity Market Maker) pools.
 * 
 * Meteora DLMM uses bin-based pricing with activeId and binStep instead of sqrt price.
 */

import { logger } from '../../../../utils/logger.js';
import { logCatchError, logCatchDebug } from '../../../../utils/errorHandler.js';
import { anyToBigInt } from '../../precision.js';
import { processPriceThroughPipeline } from '../../pricePipeline.js';
import { diffNormalizedPools } from '../../../pools.utils.js';
import { meteoraCache } from '../../../pools.cache.js';
import { deriveMeteoraBinArrayAddresses } from '../../../pools.derivation.js';
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
const METEORA_DLMM_PROGRAM = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';

// Debounce state for graph updates
let meteoraApplyState: { baseline: PoolsPayload | null; timer: NodeJS.Timeout | null } = { baseline: null, timer: null };
const DEBOUNCE_MS = 50;

// Meteora program instance cache
let meteoraProgramInstance: any = null;

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
 * Safely extract a field from state using multiple possible field names
 * Logs debug info when using fallbacks and warns if all extractions fail
 */
function extractFieldSafe<T>(
  state: any,
  fieldNames: string[],
  poolId: string,
  fieldLabel: string,
  converter?: (val: any) => T
): T | undefined {
  for (let i = 0; i < fieldNames.length; i++) {
    const fieldName = fieldNames[i];
    try {
      const val = state?.[fieldName];
      if (val !== undefined && val !== null) {
        // Log if using fallback (not the primary field name)
        if (i > 0) {
          logger.debug('meteora.field.fallback', {
            pool: poolId.slice(0, 8) + '…',
            field: fieldLabel,
            usedField: fieldName,
            primaryField: fieldNames[0],
            cat: 'pools'
          });
        }
        
        // Apply converter if provided (e.g., toBase58)
        if (converter) {
          return converter(val);
        }
        return val as T;
      }
    } catch (err) {
      // Log the specific field extraction error
      logger.debug('meteora.field.extract.error', {
        pool: poolId.slice(0, 8) + '…',
        field: fieldLabel,
        attemptedField: fieldName,
        error: String((err as Error)?.message || err),
        cat: 'pools'
      });
    }
  }
  
  // All extractions failed
  logger.warn('meteora.field.extract.all_failed', {
    pool: poolId.slice(0, 8) + '…',
    field: fieldLabel,
    attemptedFields: fieldNames,
    stateKeys: Object.keys(state || {}).slice(0, 15),
    cat: 'pools'
  });
  
  return undefined;
}

/**
 * Ensure Meteora program is initialized
 */
async function ensureMeteoraProgram(): Promise<any> {
  if (meteoraProgramInstance) return meteoraProgramInstance;
  
  try {
    const { createProgram } = await import('@meteora-ag/dlmm');
    const { Connection } = await import('@solana/web3.js');
    
    const rpcUrl = (CONFIG as any).rpc?.url || (CONFIG as any).rpcUrl || 'https://api.mainnet-beta.solana.com';
    const conn = new Connection(rpcUrl);
    
    meteoraProgramInstance = createProgram(conn);
    return meteoraProgramInstance;
  } catch (e) {
    logCatchDebug('meteora.ensureProgram', e);
    return null;
  }
}

/**
 * Schedule debounced graph update for Meteora
 */
async function scheduleDexApply(source: 'meteora', baseline: PoolsPayload): Promise<void> {
  try {
    if (!meteoraApplyState.baseline) {
      meteoraApplyState.baseline = baseline;
    }
    if (meteoraApplyState.timer) {
      clearTimeout(meteoraApplyState.timer);
    }
    meteoraApplyState.timer = setTimeout(async () => {
      try {
        const gmod: any = await import('../../../graph.js');
        const current = meteoraCache.data;
        if (current && meteoraApplyState.baseline) {
          // Use applyPoolUpdates for incremental graph updates
          if (typeof gmod?.applyPoolUpdates === 'function') {
            await gmod.applyPoolUpdates(meteoraApplyState.baseline, current, { pushToArb: false });
          }
        }
      } catch (e) {
        logCatchDebug('meteora.scheduleDexApply', e);
      } finally {
        meteoraApplyState.baseline = null;
        meteoraApplyState.timer = null;
      }
    }, DEBOUNCE_MS);
  } catch (e) {
    logCatchDebug('meteora.scheduleDexApply.setup', e);
  }
}

/**
 * Decode Meteora DLMM lbPair from account data
 */
export async function decodeMeteoraLbPair(
  data: Buffer,
  poolId: string
): Promise<{ state: any; isBinArray: boolean } | null> {
  try {
    const program = await ensureMeteoraProgram();
    if (!program || !data) return null;

    let state: any = null;
    let isBinArray = false;

    try {
      state = program.coder.accounts.decode('lbPair', data);
      
      // Enhanced diagnostic logging: compare SDK decode with direct binary reads
      const sdkActiveId = state?.activeId ?? state?.active_id;
      const sdkBinStep = state?.binStep ?? state?.bin_step;
      
      // Read from both documented offset sets to identify correct one
      let binary_activeId_240: number | null = null;
      let binary_activeId_180: number | null = null;
      let binary_binStep_232: number | null = null;
      let binary_binStep_176: number | null = null;
      
      // Ensure Buffer type for direct binary reads
      const rawBuffer = Buffer.from(data);
      try { binary_activeId_240 = rawBuffer.readInt32LE(240); } catch {}
      try { binary_activeId_180 = rawBuffer.readInt32LE(180); } catch {}
      try { binary_binStep_232 = rawBuffer.readUInt16LE(232); } catch {}
      try { binary_binStep_176 = rawBuffer.readUInt16LE(176); } catch {}
      
      // SDK decode is authoritative - binary offset comparison is for diagnostics only
      logger.debug('meteora.decoder.values_comparison', {
        id: poolId.slice(0, 8) + '…',
        sdk_activeId: sdkActiveId,
        sdk_binStep: sdkBinStep,
        binary_activeId_240,
        binary_activeId_180,
        binary_binStep_232,
        binary_binStep_176,
        sdk_keys: Object.keys(state || {}).slice(0, 15),
        data_length: data.length,
        cat: 'pools'
      });
      
      // Note: Binary offsets 180 and 240 are both incorrect for the current Meteora account layout.
      // The SDK decode is the authoritative source - direct binary reads are unreliable.
      // This debug log is kept for diagnostic purposes only.
      if (Number.isFinite(sdkActiveId)) {
        const matchesOffset240 = sdkActiveId === binary_activeId_240;
        const matchesOffset180 = sdkActiveId === binary_activeId_180;
        if (!matchesOffset240 && !matchesOffset180) {
          // Expected: SDK decode doesn't match legacy binary offsets (which are outdated)
          logger.debug('meteora.decoder.activeId_offset_mismatch', {
            id: poolId.slice(0, 8) + '…',
            sdk_activeId: sdkActiveId,
            binary_activeId_240,
            binary_activeId_180,
            note: 'SDK decode is authoritative; binary offsets are outdated',
            cat: 'pools'
          });
        }
      }
      
      logger.debug('meteora.decoder.lbPair.decoded', {
        id: poolId.slice(0, 8) + '…',
        keys: Object.keys(state || {}).slice(0, 10),
        cat: 'pools'
      });
    } catch (err: any) {
      logger.debug('meteora.decoder.lbPair.fail', {
        id: poolId,
        error: String(err?.message || err),
        cat: 'pools'
      });

      // Try decoding as binArray
      try {
        const bin = program.coder.accounts.decode('binArray', data);
        if (bin) {
          isBinArray = true;
          logger.debug('meteora.decoder.binArray.decoded', {
            id: poolId.slice(0, 8) + '…',
            keys: Object.keys(bin || {}).slice(0, 10),
            cat: 'pools'
          });
          return { state: bin, isBinArray: true };
        }
      } catch {}
      
      return null;
    }

    if (!state) return null;
    
    return { state, isBinArray };
  } catch (e) {
    logCatchDebug('meteora.decodeLbPair', e, { poolId });
    return null;
  }
}

/**
 * Decode Meteora bin array from account data
 */
export async function decodeMeteoraBinArray(
  data: Buffer,
  poolId: string
): Promise<any | null> {
  try {
    const program = await ensureMeteoraProgram();
    if (!program || !data) return null;

    const bin = program.coder.accounts.decode('binArray', data);
    return bin || null;
  } catch (e) {
    logCatchDebug('meteora.decodeBinArray', e, { poolId });
    return null;
  }
}

/**
 * Handle Meteora WebSocket account update
 * 
 * This is the main entry point for processing Meteora DLMM updates from WebSocket.
 */
export async function handleMeteoraUpdate(
  info: AccountInfo,
  poolId: string,
  derivedAccountToPool: Map<string, DerivedAccountInfo> = new Map(),
  accountPubkey?: any
): Promise<UpdateResult> {
  try {
    wsDecodeStats.meteora.attempts += 1;
    
    const data = Buffer.isBuffer(info.data) ? info.data : Buffer.from(info.data ?? []);
    
    if (!data || data.length === 0) {
      return { success: false, error: 'no_data', skipped: true };
    }

    // Decode the pool
    const decoded = await decodeMeteoraLbPair(data, poolId);
    if (!decoded) {
      wsDecodeStats.meteora.failures += 1;
      return { success: false, error: 'decode_failed', skipped: true };
    }

    const { state, isBinArray } = decoded;

    // If it's a bin array, we don't process it as a pool
    if (isBinArray) {
      logger.debug('meteora.ws.binArray.ignored', {
        pool: poolId.slice(0, 8) + '…',
        reason: 'option1_reserves_only',
        cat: 'pools'
      });
      return { success: true, skipped: true, skipReason: 'bin_array' };
    }

    if (!state) {
      logger.warn('meteora.ws.state.missing', { id: poolId, cat: 'pools' });
      return { success: false, error: 'state_missing', skipped: true };
    }

    // Extract pool fields using safe extraction with logging
    const tokenX = extractFieldSafe<string>(
      state,
      ['tokenXMint', 'mint_x', 'tokenA'],
      poolId,
      'tokenX',
      (val) => val?.toBase58?.() || String(val)
    );
    
    const tokenY = extractFieldSafe<string>(
      state,
      ['tokenYMint', 'mint_y', 'tokenB'],
      poolId,
      'tokenY',
      (val) => val?.toBase58?.() || String(val)
    );
    
    const activeId = extractFieldSafe<number>(
      state,
      ['activeId', 'active_id'],
      poolId,
      'activeId',
      (val) => Number(val)
    );
    
    const binStep = extractFieldSafe<number>(
      state,
      ['binStep', 'bin_step'],
      poolId,
      'binStep',
      (val) => Number(val)
    );

    const accountA = toB58(state?.reserveX);
    const accountB = toB58(state?.reserveY);

    // Log extracted field values for debugging
    logger.info('meteora.ws.fields_extracted', {
      id: poolId.slice(0, 8) + '…',
      activeId,
      binStep,
      tokenX: tokenX?.slice(0, 8),
      tokenY: tokenY?.slice(0, 8),
      accountA: accountA?.slice(0, 8),
      accountB: accountB?.slice(0, 8),
      activeId_valid: Number.isFinite(activeId),
      binStep_valid: Number.isFinite(binStep),
      cat: 'pools'
    });

    if (!tokenX || !tokenY) {
      wsDeltaStats.meteora.skipped += 1;
      incrementSkipReason('meteora', 'missing_tokens');
      return { success: false, error: 'missing_tokens', skipped: true };
    }

    // Get decimals from cache
    const cachedPools = meteoraCache.data || { amm: [], clmm: [] };
    const existing = cachedPools.clmm.find(p => p.id === poolId);
    
    let decA = existing?.native_decimals_a ?? existing?.decimals_a;
    let decB = existing?.native_decimals_b ?? existing?.decimals_b;

    // Fallback to execution cache
    if (!Number.isFinite(decA) || !Number.isFinite(decB)) {
      try {
        const { executionCache } = await import('../../../../execution/cache.js');
        const cached = executionCache.getStatic(poolId);
        if (!Number.isFinite(decA)) decA = cached?.native_decimals_a ?? cached?.decimals_a;
        if (!Number.isFinite(decB)) decB = cached?.native_decimals_b ?? cached?.decimals_b;
      } catch {}
    }

    // Fallback to resolver
    if (!Number.isFinite(decA) || !Number.isFinite(decB)) {
      try {
        const { resolveDecimals } = await import('../../decimals.js');
        if (!Number.isFinite(decA)) decA = await resolveDecimals(tokenX);
        if (!Number.isFinite(decB)) decB = await resolveDecimals(tokenY);
      } catch {
        if (!Number.isFinite(decA)) decA = 9;
        if (!Number.isFinite(decB)) decB = 6;
      }
    }

    // Ensure valid numbers
    if (Number.isFinite(decA)) decA = Number(decA);
    if (Number.isFinite(decB)) decB = Number(decB);
    if (!Number.isFinite(decA)) decA = undefined;
    if (!Number.isFinite(decB)) decB = undefined;

    // Validate decimals against known tokens
    try {
      const { validateDecimalsForMint } = await import('../../decimals.js');
      if (tokenX && Number.isFinite(decA)) validateDecimalsForMint(tokenX, decA!, poolId, 'Meteora');
      if (tokenY && Number.isFinite(decB)) validateDecimalsForMint(tokenY, decB!, poolId, 'Meteora');
    } catch {}

    // Process through price pipeline
    let processedPrice: ProcessedPriceResult | null = null;
    if (Number.isFinite(activeId) && Number.isFinite(binStep) && decA != null && decB != null) {
      processedPrice = processPriceThroughPipeline({
        mintA: tokenX,
        mintB: tokenY,
        decimalsA: decA,
        decimalsB: decB,
        poolId,
        dex: 'Meteora',
        poolType: 'clmm',
        activeId: Number(activeId),
        binStep: Number(binStep),
        tokenXMint: tokenX,
        tokenYMint: tokenY,
      });

      if (!processedPrice) {
        logger.warn('meteora.ws.price.pipeline_failed', {
          id: poolId,
          activeId: Number(activeId),
          binStep: Number(binStep),
          tokenX: tokenX?.slice(0, 8),
          tokenY: tokenY?.slice(0, 8),
          cat: 'pools'
        });
      } else {
        // Log calculated price for verification
        logger.info('meteora.ws.price.calculated', {
          id: poolId.slice(0, 8) + '…',
          activeId: Number(activeId),
          binStep: Number(binStep),
          decimalsA: decA,
          decimalsB: decB,
          priceForward: processedPrice.priceForward,
          priceReverse: processedPrice.priceReverse,
          wasSwapped: processedPrice.wasSwapped,
          mintA: processedPrice.mintA?.slice(0, 8),
          mintB: processedPrice.mintB?.slice(0, 8),
          cat: 'pools'
        });
      }
    }

    if (!processedPrice) {
      wsDeltaStats.meteora.skipped += 1;
      const tokenReason = `missing_${!tokenX ? 'tokenX' : ''}${!tokenY ? 'tokenY' : ''}_priceCalc`;
      incrementSkipReason('meteora', tokenReason);
      return { success: false, error: 'price_calc_failed', skipped: true, skipReason: tokenReason };
    }

    const tickSpacing = Number.isFinite(binStep) ? Number(binStep) : 0;
    const liquidityRaw = anyToBigInt(state?.liquidity ?? 0);
    const liquidity = liquidityRaw ? Number(liquidityRaw) : Number(state?.liquidity ?? 0);
    const sqrtPriceRaw = anyToBigInt(state?.sqrtPriceX64 ?? state?.sqrt_price_x64 ?? 0);
    const feeBps = Number(state?.tradeFeeRate ?? state?.feeRate ?? state?.fee_rate ?? state?.fees ?? 0);

    // Check for derived account (vault) confusion
    if (derivedAccountToPool.has(poolId)) {
      const derivedMeta = derivedAccountToPool.get(poolId);
      logger.warn('meteora.ws.derived_as_pool.prevented', {
        account: poolId.slice(0, 8) + '…',
        accountType: derivedMeta?.accountType,
        parentPool: derivedMeta?.poolId?.slice(0, 8) + '…',
        reason: 'account_is_derived_not_pool',
        cat: 'pools'
      });
      return { success: false, error: 'derived_as_pool', skipped: true };
    }

    // Derive bin array addresses
    const program = await ensureMeteoraProgram();
    const binArrayAddresses = await deriveMeteoraBinArrayAddresses(
      accountPubkey,
      program?.programId,
      typeof activeId === 'number' ? Number(activeId) : undefined
    );

    // Build the pool item with pipeline-processed prices
    const item: ClmmPool = {
      id: poolId,
      dex: 'Meteora',
      mint_a: processedPrice.mintA,
      mint_b: processedPrice.mintB,
      fee_bps: Number.isFinite(feeBps) ? feeBps : 0,
      sqrt_price_x64: sqrtPriceRaw ? Number(sqrtPriceRaw) : Number(state?.sqrtPriceX64 ?? state?.sqrt_price_x64 ?? 0),
      sqrt_price_x64_raw: sqrtPriceRaw?.toString(),
      liquidity: Number.isFinite(liquidity) ? liquidity : 0,
      liquidity_raw: liquidityRaw?.toString(),
      tick_spacing: tickSpacing,
      updated_ms: Date.now(),
      pool_kind: 'clmm',
      price_a_per_b: processedPrice.priceForward,
      decimals_a: processedPrice.decimalsA,
      decimals_b: processedPrice.decimalsB,
      // Store vault accounts in canonical order
      account_a: processedPrice.wasSwapped ? accountB : accountA,
      account_b: processedPrice.wasSwapped ? accountA : accountB,
      price_a_per_b_exact: processedPrice.priceForward?.toString(),
      was_swapped: processedPrice.wasSwapped,
      native_mint_a: tokenX,
      native_mint_b: tokenY,
      native_decimals_a: decA,
      native_decimals_b: decB,
      native_account_a: accountA,
      native_account_b: accountB,
      _pipelineProcessed: true,
    } as ClmmPool;

    // Add Meteora-specific fields
    if (Number.isFinite(activeId)) (item as any).active_id = Number(activeId);
    if (tickSpacing) (item as any).bin_step = tickSpacing;
    if (binArrayAddresses.lower) (item as any).bin_array_lower = binArrayAddresses.lower;
    if (binArrayAddresses.upper) (item as any).bin_array_upper = binArrayAddresses.upper;

    // Update execution cache
    try {
      const { executionCache } = await import('../../../../execution/cache.js');
      const existingStatic = executionCache.getStatic(poolId) || {};
      
      const nextStatic: any = {
        ...existingStatic,
        programId: String(program?.programId?.toBase58?.() || METEORA_DLMM_PROGRAM),
        vaults: { a: accountA, b: accountB },
        binStep: tickSpacing,
        mint_a: processedPrice.mintA,
        mint_b: processedPrice.mintB,
        decimals_a: processedPrice.decimalsA,
        decimals_b: processedPrice.decimalsB,
        token_program_a: (existingStatic as any)?.token_program_a,
        token_program_b: (existingStatic as any)?.token_program_b,
        account_a: processedPrice.wasSwapped ? accountB : accountA,
        account_b: processedPrice.wasSwapped ? accountA : accountB,
        bin_array_bitmap_extension: (existingStatic as any)?.bin_array_bitmap_extension,
        native_mint_a: tokenX,
        native_mint_b: tokenY,
        native_decimals_a: decA,
        native_decimals_b: decB,
        native_account_a: accountA,
        native_account_b: accountB,
        rawAccountData: data,
        rawAccountDataUpdatedMs: Date.now()
      };

      if (binArrayAddresses.lower) nextStatic.bin_array_lower = binArrayAddresses.lower;
      if (binArrayAddresses.upper) nextStatic.bin_array_upper = binArrayAddresses.upper;
      executionCache.setStatic(poolId, nextStatic);

      // Store hot pool data
      if (Number.isFinite(activeId) || binArrayAddresses.lower || binArrayAddresses.upper) {
        const existingHot = executionCache.getHot(poolId) || {};
        executionCache.setHot(poolId, {
          ...existingHot,
          activeId: Number.isFinite(activeId) ? Number(activeId) : existingHot.activeId,
          sqrtPriceX64: sqrtPriceRaw ?? existingHot.sqrtPriceX64,
          liquidity: liquidityRaw ?? existingHot.liquidity,
          feeRate: Number.isFinite(feeBps) ? feeBps : existingHot.feeRate,
          binArrays: {
            ...(existingHot.binArrays || {}),
            ...binArrayAddresses,
          },
        });

        logger.debug('meteora.ws.cache_updated', {
          pool: poolId.slice(0, 8) + '…',
          activeId: Number(activeId),
          binStep: tickSpacing,
          hasRawData: !!data,
          cat: 'pools'
        });
      }
    } catch (cacheErr) {
      logger.warn('meteora.ws.cache_update_failed', {
        pool: poolId.slice(0, 8) + '…',
        error: String((cacheErr as Error)?.message || cacheErr),
        cat: 'pools'
      });
    }

    // Validate decoded pool
    const validation = validateDecodedPool('meteora', item, poolId);
    if (!validation.valid) {
      wsDecodeStats.meteora.failures += 1;
      incrementSkipReason('meteora', `validation_failed:${validation.reasons.join(',')}`);
      logger.warn('meteora.ws.validation.failed', { id: poolId, reasons: validation.reasons, cat: 'pools' });
      return { success: false, error: `validation_failed:${validation.reasons.join(',')}`, skipped: true };
    }

    // Update cache
    const prev = meteoraCache.data || { amm: [], clmm: [] };
    const next: PoolsPayload = { amm: prev.amm.slice(), clmm: prev.clmm.slice() };
    const idx = next.clmm.findIndex(p => p.id === item.id);

    // Validate price delta against previous value
    if (idx >= 0) {
      validatePriceDelta('meteora', poolId, item.price_a_per_b, next.clmm[idx].price_a_per_b);
    }

    if (idx >= 0) {
      const prevPool = next.clmm[idx];
      const orientationChanged = prevPool.mint_a !== item.mint_a || prevPool.mint_b !== item.mint_b;
      if (orientationChanged) {
        logger.warn('ws.update.orientation_changed', {
          poolId: poolId.slice(0, 8) + '…',
          dex: 'Meteora',
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

    // Update stats and cache
    wsDecodeStats.meteora.successes += 1;
    wsDeltaStats.meteora.decoded += 1;
    
    const delta = diffNormalizedPools(prev, next);
    meteoraCache.data = next;
    meteoraCache.ts = Date.now();

    const hasDelta = delta.amm.length || delta.clmm.length || delta.addedAmm || delta.removedAmm || delta.addedClmm || delta.removedClmm;
    if (hasDelta) {
      wsDeltaStats.meteora.applied += 1;
    } else {
      wsDeltaStats.meteora.skipped += 1;
      const prevPool = prev.clmm.find(p => p.id === item.id);
      if (prevPool) {
        const reasons: string[] = [];
        // Check active_id first (primary price field for Meteora DLMM)
        const prevActiveId = (prevPool as any).active_id;
        const newActiveId = (item as any).active_id;
        if (Number.isFinite(prevActiveId) && Number.isFinite(newActiveId) && prevActiveId === newActiveId) {
          reasons.push('active_id_unchanged');
        } else if (!Number.isFinite(prevActiveId) || !Number.isFinite(newActiveId)) {
          reasons.push('active_id_missing');
        }
        if ((prevPool as any).sqrt_price_x64_raw === item.sqrt_price_x64_raw) reasons.push('sqrt_price_unchanged');
        if ((prevPool as any).liquidity_raw === item.liquidity_raw) reasons.push('liquidity_raw_unchanged');
        if (Math.abs((prevPool.liquidity || 0) - (item.liquidity || 0)) === 0) reasons.push('liquidity_unchanged');
        if (Math.abs((prevPool.price_a_per_b || 0) - (item.price_a_per_b || 0)) <= 1e-9) reasons.push('price_unchanged');
        incrementSkipReason('meteora', reasons.length > 0 ? reasons.join('+') : 'no_delta_detected');
      } else {
        incrementSkipReason('meteora', 'prev_pool_missing');
      }
    }

    // Emit update event
    try {
      const sample = { amm: [], clmm: delta.clmm.slice(0, 20) };
      emit('pool-updates', {
        source: 'meteora',
        updatedAmm: delta.amm.length,
        updatedClmm: delta.clmm.length,
        addedAmm: delta.addedAmm,
        removedAmm: delta.removedAmm,
        addedClmm: delta.addedClmm,
        removedClmm: delta.removedClmm,
        sample,
        ts: Date.now(),
        canon: (CONFIG.system as any)?.canonicalizePairs || 'none'
      });
    } catch {}

    // Schedule graph update
    if (hasDelta) {
      await scheduleDexApply('meteora', prev);
    }

    logger.debug('meteora.ws.clmm.fields', {
      id: poolId,
      priceForward: processedPrice.priceForward,
      binStep: tickSpacing,
      activeId,
      decimals: { a: processedPrice.decimalsA, b: processedPrice.decimalsB },
      wasSwapped: processedPrice.wasSwapped,
      cat: 'pools'
    });

    return { success: true, pool: item as DecodedPool, delta };
  } catch (e) {
    wsDecodeStats.meteora.failures += 1;
    logCatchError('meteora.handleUpdate', e, { poolId: poolId.slice(0, 8) + '…' });
    return { success: false, error: String((e as Error)?.message || e) };
  }
}

/**
 * Check if an owner is the Meteora DLMM program
 */
export function isMeteoraOwner(owner: string): boolean {
  return owner === METEORA_DLMM_PROGRAM || owner === String((CONFIG as any)?.meteora?.programId || '').trim();
}

/**
 * Get Meteora program ID
 */
export const METEORA_PROGRAM = METEORA_DLMM_PROGRAM;

