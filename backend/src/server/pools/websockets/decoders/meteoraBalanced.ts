/**
 * Meteora Balanced (DAMM) pool decoder
 * 
 * Handles decoding and WebSocket updates for Meteora Balanced (Dynamic AMM) pools.
 * 
 * Meteora Balanced is similar to Pumpswap in that price is derived from vault balances.
 * Unlike DLMM pools which use bins, Balanced pools are simple AMM pools.
 * 
 * WebSocket updates for Meteora Balanced primarily come from vault token accounts.
 * The pool data is fetched via HTTP API and cached.
 */

import { logger } from '../../../../utils/logger.js';
import { logCatchError, logCatchDebug } from '../../../../utils/errorHandler.js';
import { anyToBigInt } from '../../precision.js';
import { processPriceThroughPipeline } from '../../pricePipeline.js';
import { diffNormalizedPools, parseTokenAccountAmount } from '../../../pools.utils.js';
import { metbalCache, vaultBalanceCache, findPoolInCache } from '../../../pools.cache.js';
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
import type { AmmPool, PoolsPayload } from '../../types.js';

// Program IDs - Meteora DAMM has v1 and v2 versions
export const METEORA_BALANCED_V1_PROGRAM = 'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB';
export const METEORA_BALANCED_V2_PROGRAM = 'cpaZT9LgfEDuBsZ4NhVPfqr6KPc6BmJKNsxbgDqJpump';

// Debounce state for graph updates
let metbalApplyState: { baseline: PoolsPayload | null; timer: NodeJS.Timeout | null } = { baseline: null, timer: null };
const DEBOUNCE_MS = 50;

/**
 * Schedule debounced graph update for Meteora Balanced
 */
async function scheduleDexApply(source: 'meteora_balanced', baseline: PoolsPayload): Promise<void> {
  try {
    if (!metbalApplyState.baseline) {
      metbalApplyState.baseline = baseline;
    }
    if (metbalApplyState.timer) {
      clearTimeout(metbalApplyState.timer);
    }
    metbalApplyState.timer = setTimeout(async () => {
      try {
        const gmod: any = await import('../../../graph.js');
        const current = metbalCache.data;
        if (current && metbalApplyState.baseline) {
          // Use applyPoolUpdates for incremental graph updates
          if (typeof gmod?.applyPoolUpdates === 'function') {
            await gmod.applyPoolUpdates(metbalApplyState.baseline, current, { pushToArb: false });
          }
        }
      } catch (e) {
        logCatchDebug('meteora_balanced.scheduleDexApply', e);
      } finally {
        metbalApplyState.baseline = null;
        metbalApplyState.timer = null;
      }
    }, DEBOUNCE_MS);
  } catch (e) {
    logCatchDebug('meteora_balanced.scheduleDexApply.setup', e);
  }
}

/**
 * Decode Meteora Balanced pool from vault balance updates
 * 
 * Meteora Balanced pools are simple AMMs where price is derived from vault balances.
 * The pool data comes from HTTP API and is cached.
 * WebSocket updates to vaults provide real-time balance changes.
 */
export function decodeMeteoraBalancedPool(
  existingPool: AmmPool,
  vaultABalance: bigint | null,
  vaultBBalance: bigint | null
): DecodedPool | null {
  try {
    if (!existingPool) return null;

    const mintA = existingPool.native_mint_a || existingPool.mint_a;
    const mintB = existingPool.native_mint_b || existingPool.mint_b;
    
    if (!mintA || !mintB) {
      logger.debug('meteora_balanced.decode.missing_mints', { poolId: existingPool.id, cat: 'pools' });
      return null;
    }

    // Get decimals
    const decA = existingPool.native_decimals_a ?? existingPool.decimals_a ?? 9;
    const decB = existingPool.native_decimals_b ?? existingPool.decimals_b ?? 6;

    // Calculate reserves from vault balances
    let reserveA = vaultABalance;
    let reserveB = vaultBBalance;

    // Fall back to cached raw reserves if vault balances not available
    if (reserveA === null && existingPool.native_reserve_a_raw) {
      reserveA = anyToBigInt(existingPool.native_reserve_a_raw);
    }
    if (reserveB === null && existingPool.native_reserve_b_raw) {
      reserveB = anyToBigInt(existingPool.native_reserve_b_raw);
    }

    if (reserveA === null || reserveB === null) {
      logger.debug('meteora_balanced.decode.missing_reserves', { 
        poolId: existingPool.id, 
        hasA: reserveA !== null, 
        hasB: reserveB !== null,
        cat: 'pools' 
      });
      return null;
    }

    return {
      id: existingPool.id,
      dex: existingPool.dex || 'MeteoraBalanced_v2', // Preserve version info
      mint_a: mintA,
      mint_b: mintB,
      fee_bps: existingPool.fee_bps || 30,
      price_a_per_b: 0, // Will be calculated through pipeline
      liquidity_base: 0, // Will be calculated
      updated_ms: Date.now(),
      pool_kind: 'amm',
      native_mint_a: mintA,
      native_mint_b: mintB,
      native_decimals_a: decA,
      native_decimals_b: decB,
      reserve_a_raw: reserveA.toString(),
      reserve_b_raw: reserveB.toString(),
      native_reserve_a_raw: reserveA.toString(),
      native_reserve_b_raw: reserveB.toString(),
      native_account_a: existingPool.native_account_a,
      native_account_b: existingPool.native_account_b,
    };
  } catch (e) {
    logCatchDebug('meteora_balanced.decode', e);
    return null;
  }
}

/**
 * Handle Meteora Balanced vault balance update
 * 
 * This is called when a vault token account update is received via WebSocket.
 * We use the cached vault balances to recalculate the pool price.
 */
export async function handleMeteoraBalancedVaultUpdate(
  info: AccountInfo,
  vaultAddress: string,
  poolId: string
): Promise<UpdateResult> {
  try {
    // Parse the new vault balance
    const data = Buffer.isBuffer(info.data) ? info.data : Buffer.from(info.data ?? []);
    const newBalance = parseTokenAccountAmount(data);
    
    if (newBalance === null) {
      logger.debug('meteora_balanced.vault.parse.fail', { vault: vaultAddress.slice(0, 8) + '…', cat: 'pools' });
      return { success: false, error: 'parse_failed', skipped: true };
    }

    // Cache the vault balance
    vaultBalanceCache.set(vaultAddress, newBalance);
    
    logger.debug('meteora_balanced.vault.balance_cached', {
      vault: vaultAddress.slice(0, 8) + '…',
      balance: newBalance.toString(),
      poolId: poolId.slice(0, 8) + '…',
      cat: 'pools'
    });

    // Find the pool in cache
    const poolData = findPoolInCache(poolId);
    if (!poolData || poolData.source !== 'meteora_balanced') {
      logger.debug('meteora_balanced.vault.pool.not_found', { 
        vault: vaultAddress.slice(0, 8) + '…', 
        pool: poolId.slice(0, 8) + '…', 
        cat: 'pools' 
      });
      return { success: true, skipped: true, skipReason: 'pool_not_in_cache' };
    }

    const existingPool = poolData.pool as AmmPool;
    
    // Get vault addresses from the pool
    const vaultA = existingPool.native_account_a || existingPool.account_a;
    const vaultB = existingPool.native_account_b || existingPool.account_b;
    
    if (!vaultA || !vaultB) {
      logger.debug('meteora_balanced.vault.pool.missing_vaults', { 
        pool: poolId.slice(0, 8) + '…', 
        cat: 'pools' 
      });
      return { success: true, skipped: true, skipReason: 'pool_missing_vaults' };
    }

    // Get both vault balances from cache
    const balanceA = vaultBalanceCache.get(vaultA) ?? null;
    const balanceB = vaultBalanceCache.get(vaultB) ?? null;

    if (balanceA === null || balanceB === null) {
      logger.debug('meteora_balanced.vault.awaiting_both', {
        pool: poolId.slice(0, 8) + '…',
        hasA: balanceA !== null,
        hasB: balanceB !== null,
        cat: 'pools'
      });
      return { success: true, skipped: true, skipReason: 'awaiting_both_vaults' };
    }

    // Decode the pool with updated balances
    const decoded = decodeMeteoraBalancedPool(existingPool, balanceA, balanceB);
    if (!decoded) {
      return { success: false, error: 'decode_failed', skipped: true };
    }

    // Process through price pipeline
    const mintA = decoded.native_mint_a || decoded.mint_a;
    const mintB = decoded.native_mint_b || decoded.mint_b;
    const reserveA = anyToBigInt(decoded.reserve_a_raw);
    const reserveB = anyToBigInt(decoded.reserve_b_raw);
    const decA = decoded.native_decimals_a ?? decoded.decimals_a ?? 9;
    const decB = decoded.native_decimals_b ?? decoded.decimals_b ?? 6;

    // Validate decimals against known tokens
    try {
      const { validateDecimalsForMint } = await import('../../decimals.js');
      if (mintA) validateDecimalsForMint(mintA, decA, poolId, 'MeteoraBalanced');
      if (mintB) validateDecimalsForMint(mintB, decB, poolId, 'MeteoraBalanced');
    } catch {}

    const processedPrice = processPriceThroughPipeline({
      mintA,
      mintB,
      decimalsA: decA,
      decimalsB: decB,
      poolId,
      dex: decoded.dex || 'MeteoraBalanced_v2',
      poolType: 'amm',
      reserveA,
      reserveB,
    });

    if (!processedPrice) {
      wsDeltaStats.meteora_balanced.skipped += 1;
      incrementSkipReason('meteora_balanced', 'price_calc_failed');
      return { success: false, error: 'price_calc_failed', skipped: true };
    }

    // Calculate liquidity
    const wholeA = reserveA ? Number(reserveA) / Math.pow(10, decA) : 0;
    const wholeB = reserveB ? Number(reserveB) / Math.pow(10, decB) : 0;
    const liquidityBase = Math.min(wholeA, wholeB);

    // Build the updated pool item
    const item: AmmPool = {
      id: poolId,
      dex: decoded.dex || 'MeteoraBalanced_v2',
      mint_a: processedPrice.mintA,
      mint_b: processedPrice.mintB,
      fee_bps: decoded.fee_bps || 30,
      price_a_per_b: processedPrice.priceForward,
      liquidity_base: liquidityBase,
      updated_ms: Date.now(),
      pool_kind: 'amm',
      liquidity_display: liquidityBase,
      decimals_a: processedPrice.decimalsA,
      decimals_b: processedPrice.decimalsB,
      reserve_a_raw: processedPrice.wasSwapped ? reserveB?.toString() : reserveA?.toString(),
      reserve_b_raw: processedPrice.wasSwapped ? reserveA?.toString() : reserveB?.toString(),
      was_swapped: processedPrice.wasSwapped,
      native_mint_a: mintA,
      native_mint_b: mintB,
      native_decimals_a: decA,
      native_decimals_b: decB,
      native_reserve_a_raw: reserveA?.toString(),
      native_reserve_b_raw: reserveB?.toString(),
      native_account_a: vaultA,
      native_account_b: vaultB,
      _pipelineProcessed: true,
    } as AmmPool;

    // Validate decoded pool
    const validation = validateDecodedPool('meteora_balanced', item, poolId);
    if (!validation.valid) {
      wsDecodeStats.meteora_balanced.failures += 1;
      incrementSkipReason('meteora_balanced', `validation_failed:${validation.reasons.join(',')}`);
      return { success: false, error: `validation_failed:${validation.reasons.join(',')}`, skipped: true };
    }

    // Update cache
    const prev = metbalCache.data || { amm: [], clmm: [] };
    const next: PoolsPayload = { amm: prev.amm.slice(), clmm: prev.clmm.slice() };
    const idx = next.amm.findIndex(p => p.id === item.id);

    // Validate price delta against previous value
    if (idx >= 0) {
      validatePriceDelta('meteora_balanced', poolId, item.price_a_per_b, next.amm[idx].price_a_per_b);
    }

    if (idx >= 0) {
      const prevPool = next.amm[idx];
      const orientationChanged = prevPool.mint_a !== item.mint_a || prevPool.mint_b !== item.mint_b;
      if (orientationChanged) {
        logger.warn('ws.update.orientation_changed', {
          poolId: poolId.slice(0, 8) + '…',
          dex: 'MeteoraBalanced',
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
        next.amm[idx] = { ...item, ...orientationIndependentFields };
      } else {
        next.amm[idx] = { ...next.amm[idx], ...item };
      }
    } else {
      next.amm.push(item);
    }

    // Update stats and cache
    wsDecodeStats.meteora_balanced.successes += 1;
    wsDeltaStats.meteora_balanced.decoded += 1;
    
    const delta = diffNormalizedPools(prev, next);
    metbalCache.data = next;
    metbalCache.ts = Date.now();

    const hasDelta = delta.amm.length || delta.clmm.length || delta.addedAmm || delta.removedAmm || delta.addedClmm || delta.removedClmm;
    if (hasDelta) {
      wsDeltaStats.meteora_balanced.applied += 1;
    } else {
      wsDeltaStats.meteora_balanced.skipped += 1;
      incrementSkipReason('meteora_balanced', 'no_delta');
    }

    // Emit update event
    try {
      emit('pool-updates', {
        source: 'meteora_balanced',
        updatedAmm: delta.amm.length,
        updatedClmm: 0,
        sample: { amm: delta.amm.slice(0, 20), clmm: [] },
        ts: Date.now()
      });
    } catch {}

    // Schedule graph update
    if (hasDelta) {
      await scheduleDexApply('meteora_balanced', prev);
    }

    return { success: true, pool: item as DecodedPool, delta };
  } catch (e) {
    wsDecodeStats.meteora_balanced.failures += 1;
    logCatchError('meteora_balanced.handleVaultUpdate', e, { vault: vaultAddress.slice(0, 8) + '…' });
    return { success: false, error: String((e as Error)?.message || e) };
  }
}

/**
 * Handle Meteora Balanced WebSocket account update
 * 
 * Meteora Balanced updates come from vault token accounts, not pool accounts.
 * This function routes to handleMeteoraBalancedVaultUpdate.
 */
export async function handleMeteoraBalancedUpdate(
  info: AccountInfo,
  accountAddress: string,
  derivedAccountToPool: Map<string, DerivedAccountInfo> = new Map()
): Promise<UpdateResult> {
  try {
    wsDecodeStats.meteora_balanced.attempts += 1;
    
    // Check if this is a derived account (vault)
    const derivedMeta = derivedAccountToPool.get(accountAddress);
    if (!derivedMeta) {
      logger.debug('meteora_balanced.update.unknown_account', {
        account: accountAddress.slice(0, 8) + '…',
        cat: 'pools'
      });
      return { success: false, error: 'unknown_account', skipped: true };
    }

    if (derivedMeta.accountType !== 'vault' && derivedMeta.accountType !== 'reserve') {
      logger.debug('meteora_balanced.update.not_vault', {
        account: accountAddress.slice(0, 8) + '…',
        accountType: derivedMeta.accountType,
        cat: 'pools'
      });
      return { success: true, skipped: true, skipReason: 'not_vault' };
    }

    return handleMeteoraBalancedVaultUpdate(info, accountAddress, derivedMeta.poolId);
  } catch (e) {
    wsDecodeStats.meteora_balanced.failures += 1;
    logCatchError('meteora_balanced.handleUpdate', e, { account: accountAddress.slice(0, 8) + '…' });
    return { success: false, error: String((e as Error)?.message || e) };
  }
}

/**
 * Check if an owner is a Meteora Balanced program
 */
export function isMeteoraBalancedOwner(owner: string): boolean {
  return owner === METEORA_BALANCED_V1_PROGRAM || owner === METEORA_BALANCED_V2_PROGRAM;
}

/**
 * Get Meteora Balanced program IDs
 */
export const METEORA_BALANCED_PROGRAMS = {
  V1: METEORA_BALANCED_V1_PROGRAM,
  V2: METEORA_BALANCED_V2_PROGRAM,
};

