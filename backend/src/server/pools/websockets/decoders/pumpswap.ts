/**
 * Pumpswap pool decoder
 * 
 * Handles decoding and WebSocket updates for Pumpswap AMM pools.
 * 
 * Pumpswap is a simple AMM where price is derived from token vault balances.
 * Unlike Raydium/Orca/Meteora, Pumpswap pools don't have complex account structures.
 * 
 * WebSocket updates for Pumpswap primarily come from vault token accounts,
 * not the pool account itself. The pool data is fetched via GraphQL and cached.
 */

import { logger } from '../../../../utils/logger.js';
import { logCatchError, logCatchDebug } from '../../../../utils/errorHandler.js';
import { anyToBigInt } from '../../precision.js';
import { processPriceThroughPipeline } from '../../pricePipeline.js';
import { diffNormalizedPools, parseTokenAccountAmount } from '../../../pools.utils.js';
import { pumpswapCache, vaultBalanceCache, findPoolInCache } from '../../../pools.cache.js';
import { emit } from '../../../realtime.js';
import { wsDecodeStats, wsDeltaStats, incrementSkipReason } from '../../../pools.metrics.js';
import { validateDecodedPool, validatePriceDelta } from '../validation.js';
import { CONFIG } from '../../../../utils/config.js';
// Import pool activation tracking for lazy activation mode
import { tryActivatePool } from '../../../pools.activation.js';
import type { 
  DecodedPool, 
  UpdateResult, 
  AccountInfo, 
  ProcessedPriceResult,
  DerivedAccountInfo 
} from './types.js';
import type { AmmPool, PoolsPayload } from '../../types.js';

// Program ID
export const PUMPSWAP_PROGRAM_ID = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

// PumpSwap total fee: 20 bps LP fee + 5 bps protocol fee = 25 bps total
const DEFAULT_FEE_BPS = 25;

/**
 * Pumpswap pool account layout offsets
 * 
 * Pool account structure:
 * [discriminator(8), pool_bump(1), index(2), creator(32), base_mint(32), quote_mint(32),
 *  lp_mint(32), pool_base_token_account(32), pool_quote_token_account(32), lp_supply(8), ...]
 */
const POOL_LAYOUT = {
  DISCRIMINATOR: 0,
  POOL_BUMP: 8,
  INDEX: 9,
  CREATOR: 11,
  BASE_MINT: 43,
  QUOTE_MINT: 75,
  LP_MINT: 107,
  VAULT_A: 139,  // pool_base_token_account
  VAULT_B: 171,  // pool_quote_token_account
  LP_SUPPLY: 203,
  MIN_LENGTH: 211,  // Minimum buffer length to decode vault addresses
} as const;

/**
 * Decoded pumpswap pool state from account data
 */
interface PumpswapPoolState {
  baseMint: string;
  quoteMint: string;
  vaultA: string;
  vaultB: string;
  lpSupply?: bigint;
}

/**
 * Decode pumpswap pool state from account data buffer
 * 
 * Extracts mint addresses and vault addresses from the pool account.
 * This allows us to look up vault balances and calculate price.
 */
export function decodePumpswapPoolState(data: Buffer): PumpswapPoolState | null {
  try {
    if (!data || data.length < POOL_LAYOUT.MIN_LENGTH) {
      return null;
    }

    // Import PublicKey dynamically to avoid circular dependencies
    const { PublicKey } = require('@solana/web3.js');

    // Extract base_mint (32 bytes at offset 43)
    const baseMintBytes = data.subarray(POOL_LAYOUT.BASE_MINT, POOL_LAYOUT.BASE_MINT + 32);
    const baseMint = new PublicKey(baseMintBytes).toBase58();

    // Extract quote_mint (32 bytes at offset 75)
    const quoteMintBytes = data.subarray(POOL_LAYOUT.QUOTE_MINT, POOL_LAYOUT.QUOTE_MINT + 32);
    const quoteMint = new PublicKey(quoteMintBytes).toBase58();

    // Extract vault_a / pool_base_token_account (32 bytes at offset 139)
    const vaultABytes = data.subarray(POOL_LAYOUT.VAULT_A, POOL_LAYOUT.VAULT_A + 32);
    const vaultA = new PublicKey(vaultABytes).toBase58();

    // Extract vault_b / pool_quote_token_account (32 bytes at offset 171)
    const vaultBBytes = data.subarray(POOL_LAYOUT.VAULT_B, POOL_LAYOUT.VAULT_B + 32);
    const vaultB = new PublicKey(vaultBBytes).toBase58();

    // Optionally extract lp_supply (8 bytes at offset 203)
    let lpSupply: bigint | undefined;
    if (data.length >= POOL_LAYOUT.LP_SUPPLY + 8) {
      // Read 8 bytes as little-endian u64
      const view = new DataView(data.buffer, data.byteOffset + POOL_LAYOUT.LP_SUPPLY, 8);
      lpSupply = view.getBigUint64(0, true); // true = little-endian
    }

    return {
      baseMint,
      quoteMint,
      vaultA,
      vaultB,
      lpSupply,
    };
  } catch (e) {
    logCatchDebug('pumpswap.decodePoolState', e);
    return null;
  }
}

// Debounce state for graph updates
let pumpswapApplyState: { baseline: PoolsPayload | null; timer: NodeJS.Timeout | null } = { baseline: null, timer: null };
const DEBOUNCE_MS = 50;

/**
 * Schedule debounced graph update for Pumpswap
 */
async function scheduleDexApply(source: 'pumpswap', baseline: PoolsPayload): Promise<void> {
  try {
    if (!pumpswapApplyState.baseline) {
      pumpswapApplyState.baseline = baseline;
    }
    if (pumpswapApplyState.timer) {
      clearTimeout(pumpswapApplyState.timer);
    }
    pumpswapApplyState.timer = setTimeout(async () => {
      try {
        const gmod: any = await import('../../../graph.js');
        const current = pumpswapCache.data;
        if (current && pumpswapApplyState.baseline) {
          // Use applyPoolUpdates for incremental graph updates
          if (typeof gmod?.applyPoolUpdates === 'function') {
            await gmod.applyPoolUpdates(pumpswapApplyState.baseline, current, { pushToArb: false });
          }
        }
      } catch (e) {
        logCatchDebug('pumpswap.scheduleDexApply', e);
      } finally {
        pumpswapApplyState.baseline = null;
        pumpswapApplyState.timer = null;
      }
    }, DEBOUNCE_MS);
  } catch (e) {
    logCatchDebug('pumpswap.scheduleDexApply.setup', e);
  }
}

/**
 * Decode Pumpswap pool from vault balance updates
 * 
 * Pumpswap pools don't have a complex pool account structure.
 * The pool data (mints, vaults) comes from GraphQL and is cached.
 * WebSocket updates to vaults provide real-time balance changes.
 */
export function decodePumpswapPool(
  existingPool: AmmPool,
  vaultABalance: bigint | null,
  vaultBBalance: bigint | null
): DecodedPool | null {
  try {
    if (!existingPool) return null;

    const mintA = existingPool.native_mint_a || existingPool.mint_a;
    const mintB = existingPool.native_mint_b || existingPool.mint_b;
    
    if (!mintA || !mintB) {
      logger.debug('pumpswap.decode.missing_mints', { poolId: existingPool.id, cat: 'pools' });
      return null;
    }

    // Get decimals with fallback logging
    let decA = existingPool.native_decimals_a ?? existingPool.decimals_a;
    let decB = existingPool.native_decimals_b ?? existingPool.decimals_b;

    if (!Number.isFinite(decA)) {
      logger.warn('pumpswap.decoder.decimals_fallback', {
        poolId: existingPool.id?.slice(0, 8) + '…',
        mint: mintA?.slice(0, 8) + '…',
        side: 'A',
        fallbackValue: 9,
        reason: 'cache_missing_decimals',
        cat: 'pools'
      });
      decA = 9;
    }
    if (!Number.isFinite(decB)) {
      logger.warn('pumpswap.decoder.decimals_fallback', {
        poolId: existingPool.id?.slice(0, 8) + '…',
        mint: mintB?.slice(0, 8) + '…',
        side: 'B',
        fallbackValue: 6,
        reason: 'cache_missing_decimals',
        cat: 'pools'
      });
      decB = 6;
    }

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
      logger.debug('pumpswap.decode.missing_reserves', { 
        poolId: existingPool.id, 
        hasA: reserveA !== null, 
        hasB: reserveB !== null,
        cat: 'pools' 
      });
      return null;
    }

    return {
      id: existingPool.id,
      dex: 'Pumpswap',
      mint_a: mintA,
      mint_b: mintB,
      fee_bps: existingPool.fee_bps || DEFAULT_FEE_BPS,
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
    logCatchDebug('pumpswap.decode', e);
    return null;
  }
}

/**
 * Handle Pumpswap pool account update
 * 
 * This is called when a pool account update is received via WebSocket.
 * We decode the pool state to get vault addresses, then look up cached vault balances.
 */
export async function handlePumpswapPoolAccountUpdate(
  info: AccountInfo,
  poolId: string
): Promise<UpdateResult> {
  try {
    const data = Buffer.isBuffer(info.data) ? info.data : Buffer.from(info.data ?? []);
    
    if (!data || data.length < POOL_LAYOUT.MIN_LENGTH) {
      logger.debug('pumpswap.pool_update.data_too_short', {
        pool: poolId.slice(0, 8) + '…',
        len: data?.length || 0,
        cat: 'pools'
      });
      wsDeltaStats.pumpswap.skipped += 1;
      incrementSkipReason('pumpswap', 'data_too_short');
      return { success: false, error: 'data_too_short', skipped: true };
    }

    // Decode pool state to get vault addresses
    const poolState = decodePumpswapPoolState(data);
    if (!poolState) {
      logger.debug('pumpswap.pool_update.decode_failed', {
        pool: poolId.slice(0, 8) + '…',
        cat: 'pools'
      });
      wsDeltaStats.pumpswap.skipped += 1;
      incrementSkipReason('pumpswap', 'pool_state_decode_failed');
      return { success: false, error: 'pool_decode_failed', skipped: true };
    }

    // Find existing pool in cache to get metadata (decimals, fee, etc.)
    const poolData = findPoolInCache(poolId);
    if (!poolData || poolData.source !== 'pumpswap') {
      logger.debug('pumpswap.pool_update.not_in_cache', {
        pool: poolId.slice(0, 8) + '…',
        cat: 'pools'
      });
      wsDeltaStats.pumpswap.skipped += 1;
      incrementSkipReason('pumpswap', 'pool_not_in_cache');
      return { success: true, skipped: true, skipReason: 'pool_not_in_cache' };
    }

    const existingPool = poolData.pool as AmmPool;
    const { vaultA, vaultB, baseMint, quoteMint } = poolState;

    // Get both vault balances from cache
    const balanceA = vaultBalanceCache.get(vaultA) ?? null;
    const balanceB = vaultBalanceCache.get(vaultB) ?? null;

    if (balanceA === null || balanceB === null) {
      logger.debug('pumpswap.pool_update.awaiting_vaults', {
        pool: poolId.slice(0, 8) + '…',
        hasA: balanceA !== null,
        hasB: balanceB !== null,
        vaultA: vaultA.slice(0, 8) + '…',
        vaultB: vaultB.slice(0, 8) + '…',
        cat: 'pools'
      });
      // Still a valid pool account - just waiting for vault data
      wsDeltaStats.pumpswap.skipped += 1;
      incrementSkipReason('pumpswap', 'awaiting_vault_balances');
      return { success: true, skipped: true, skipReason: 'awaiting_vault_balances' };
    }

    // Use existing pool metadata with decoded vault info
    const poolWithVaults: AmmPool = {
      ...existingPool,
      native_account_a: vaultA,
      native_account_b: vaultB,
      native_mint_a: baseMint,
      native_mint_b: quoteMint,
    };

    // Decode the pool with vault balances
    const decoded = decodePumpswapPool(poolWithVaults, balanceA, balanceB);
    if (!decoded) {
      wsDeltaStats.pumpswap.skipped += 1;
      incrementSkipReason('pumpswap', 'pool_decode_with_vaults_failed');
      return { success: false, error: 'decode_failed', skipped: true };
    }

    // Process through price pipeline
    const mintA = decoded.native_mint_a || decoded.mint_a;
    const mintB = decoded.native_mint_b || decoded.mint_b;
    const reserveA = anyToBigInt(decoded.reserve_a_raw);
    const reserveB = anyToBigInt(decoded.reserve_b_raw);
    let decA = decoded.native_decimals_a ?? decoded.decimals_a;
    let decB = decoded.native_decimals_b ?? decoded.decimals_b;

    // Fallback decimals with logging
    if (!Number.isFinite(decA)) {
      logger.warn('pumpswap.decoder.decimals_fallback', {
        poolId: poolId?.slice(0, 8) + '…',
        mint: mintA?.slice(0, 8) + '…',
        side: 'A',
        fallbackValue: 9,
        reason: 'decoded_pool_missing_decimals',
        cat: 'pools'
      });
      decA = 9;
    }
    if (!Number.isFinite(decB)) {
      logger.warn('pumpswap.decoder.decimals_fallback', {
        poolId: poolId?.slice(0, 8) + '…',
        mint: mintB?.slice(0, 8) + '…',
        side: 'B',
        fallbackValue: 6,
        reason: 'decoded_pool_missing_decimals',
        cat: 'pools'
      });
      decB = 6;
    }

    // Validate decimals against known tokens
    try {
      const { validateDecimalsForMint } = await import('../../decimals.js');
      if (mintA) validateDecimalsForMint(mintA, decA, poolId, 'Pumpswap');
      if (mintB) validateDecimalsForMint(mintB, decB, poolId, 'Pumpswap');
    } catch {}

    const processedPrice = processPriceThroughPipeline({
      mintA,
      mintB,
      decimalsA: decA,
      decimalsB: decB,
      poolId,
      dex: 'Pumpswap',
      poolType: 'amm',
      reserveA,
      reserveB,
    });

    if (!processedPrice) {
      wsDeltaStats.pumpswap.skipped += 1;
      incrementSkipReason('pumpswap', 'price_calc_failed');
      return { success: false, error: 'price_calc_failed', skipped: true };
    }

    // Calculate liquidity
    const wholeA = reserveA ? Number(reserveA) / Math.pow(10, decA) : 0;
    const wholeB = reserveB ? Number(reserveB) / Math.pow(10, decB) : 0;
    const liquidityBase = Math.min(wholeA, wholeB);

    // Build the updated pool item
    const item: AmmPool = {
      id: poolId,
      dex: 'Pumpswap',
      mint_a: processedPrice.mintA,
      mint_b: processedPrice.mintB,
      fee_bps: decoded.fee_bps || DEFAULT_FEE_BPS,
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
    const validation = validateDecodedPool('pumpswap', item, poolId);
    if (!validation.valid) {
      wsDecodeStats.pumpswap.failures += 1;
      incrementSkipReason('pumpswap', `validation_failed:${validation.reasons.join(',')}`);
      return { success: false, error: `validation_failed:${validation.reasons.join(',')}`, skipped: true };
    }

    // Update cache
    const prev = pumpswapCache.data || { amm: [], clmm: [] };
    const next: PoolsPayload = { amm: prev.amm.slice(), clmm: prev.clmm.slice() };
    const idx = next.amm.findIndex(p => p.id === item.id);

    // Validate price delta against previous value
    if (idx >= 0) {
      validatePriceDelta('pumpswap', poolId, item.price_a_per_b, next.amm[idx].price_a_per_b);
    }

    if (idx >= 0) {
      const prevPool = next.amm[idx];
      const orientationChanged = prevPool.mint_a !== item.mint_a || prevPool.mint_b !== item.mint_b;
      if (orientationChanged) {
        logger.warn('ws.update.orientation_changed', {
          poolId: poolId.slice(0, 8) + '…',
          dex: 'Pumpswap',
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
    wsDecodeStats.pumpswap.successes += 1;
    wsDeltaStats.pumpswap.decoded += 1;

    const delta = diffNormalizedPools(prev, next);
    pumpswapCache.data = next;
    pumpswapCache.ts = Date.now();

    const hasDelta = delta.amm.length || delta.clmm.length || delta.addedAmm || delta.removedAmm || delta.addedClmm || delta.removedClmm;
    if (hasDelta) {
      wsDeltaStats.pumpswap.applied += 1;
    } else {
      wsDeltaStats.pumpswap.skipped += 1;
      incrementSkipReason('pumpswap', 'no_delta');
    }

    // Emit update event
    try {
      emit('pool-updates', {
        source: 'pumpswap',
        updatedAmm: delta.amm.length,
        updatedClmm: 0,
        sample: { amm: delta.amm.slice(0, 20), clmm: [] },
        ts: Date.now()
      });
    } catch {}

    // Schedule graph update
    if (hasDelta) {
      await scheduleDexApply('pumpswap', prev);
    }

    logger.debug('pumpswap.pool_update.success', {
      pool: poolId.slice(0, 8) + '…',
      price: item.price_a_per_b,
      hasDelta,
      cat: 'pools'
    });

    // Try to activate pool for lazy activation mode (only activates on first valid price update)
    const hasValidPrice = !!(
      processedPrice?.priceForward &&
      Number.isFinite(processedPrice.priceForward) &&
      processedPrice.priceForward > 0
    );
    tryActivatePool(poolId, 'pumpswap', hasValidPrice);

    return { success: true, pool: item as DecodedPool, delta };
  } catch (e) {
    wsDecodeStats.pumpswap.failures += 1;
    logCatchError('pumpswap.handlePoolAccountUpdate', e, { pool: poolId.slice(0, 8) + '…' });
    return { success: false, error: String((e as Error)?.message || e) };
  }
}

/**
 * Handle Pumpswap vault balance update
 * 
 * This is called when a vault token account update is received via WebSocket.
 * We use the cached vault balances to recalculate the pool price.
 */
export async function handlePumpswapVaultUpdate(
  info: AccountInfo,
  vaultAddress: string,
  poolId: string
): Promise<UpdateResult> {
  try {
    // Parse the new vault balance
    const data = Buffer.isBuffer(info.data) ? info.data : Buffer.from(info.data ?? []);
    const newBalance = parseTokenAccountAmount(data);
    
    if (newBalance === null) {
      logger.debug('pumpswap.vault.parse.fail', { vault: vaultAddress.slice(0, 8) + '…', cat: 'pools' });
      return { success: false, error: 'parse_failed', skipped: true };
    }

    // Cache the vault balance
    vaultBalanceCache.set(vaultAddress, newBalance);
    
    logger.debug('pumpswap.vault.balance_cached', {
      vault: vaultAddress.slice(0, 8) + '…',
      balance: newBalance.toString(),
      poolId: poolId.slice(0, 8) + '…',
      cat: 'pools'
    });

    // Find the pool in cache
    const poolData = findPoolInCache(poolId);
    if (!poolData || poolData.source !== 'pumpswap') {
      logger.debug('pumpswap.vault.pool.not_found', { 
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
      logger.debug('pumpswap.vault.pool.missing_vaults', { 
        pool: poolId.slice(0, 8) + '…', 
        cat: 'pools' 
      });
      return { success: true, skipped: true, skipReason: 'pool_missing_vaults' };
    }

    // Get both vault balances from cache
    const balanceA = vaultBalanceCache.get(vaultA) ?? null;
    const balanceB = vaultBalanceCache.get(vaultB) ?? null;

    if (balanceA === null || balanceB === null) {
      logger.debug('pumpswap.vault.awaiting_both', {
        pool: poolId.slice(0, 8) + '…',
        hasA: balanceA !== null,
        hasB: balanceB !== null,
        cat: 'pools'
      });
      return { success: true, skipped: true, skipReason: 'awaiting_both_vaults' };
    }

    // Decode the pool with updated balances
    const decoded = decodePumpswapPool(existingPool, balanceA, balanceB);
    if (!decoded) {
      return { success: false, error: 'decode_failed', skipped: true };
    }

    // Process through price pipeline
    const mintA = decoded.native_mint_a || decoded.mint_a;
    const mintB = decoded.native_mint_b || decoded.mint_b;
    const reserveA = anyToBigInt(decoded.reserve_a_raw);
    const reserveB = anyToBigInt(decoded.reserve_b_raw);
    let decA = decoded.native_decimals_a ?? decoded.decimals_a;
    let decB = decoded.native_decimals_b ?? decoded.decimals_b;

    // Fallback decimals with logging (vault update path)
    if (!Number.isFinite(decA)) {
      logger.warn('pumpswap.decoder.decimals_fallback', {
        poolId: poolId?.slice(0, 8) + '…',
        mint: mintA?.slice(0, 8) + '…',
        side: 'A',
        fallbackValue: 9,
        reason: 'vault_update_missing_decimals',
        cat: 'pools'
      });
      decA = 9;
    }
    if (!Number.isFinite(decB)) {
      logger.warn('pumpswap.decoder.decimals_fallback', {
        poolId: poolId?.slice(0, 8) + '…',
        mint: mintB?.slice(0, 8) + '…',
        side: 'B',
        fallbackValue: 6,
        reason: 'vault_update_missing_decimals',
        cat: 'pools'
      });
      decB = 6;
    }

    // Validate decimals against known tokens
    try {
      const { validateDecimalsForMint } = await import('../../decimals.js');
      if (mintA) validateDecimalsForMint(mintA, decA, poolId, 'Pumpswap');
      if (mintB) validateDecimalsForMint(mintB, decB, poolId, 'Pumpswap');
    } catch {}

    const processedPrice = processPriceThroughPipeline({
      mintA,
      mintB,
      decimalsA: decA,
      decimalsB: decB,
      poolId,
      dex: 'Pumpswap',
      poolType: 'amm',
      reserveA,
      reserveB,
    });

    if (!processedPrice) {
      wsDeltaStats.pumpswap.skipped += 1;
      incrementSkipReason('pumpswap', 'price_calc_failed');
      return { success: false, error: 'price_calc_failed', skipped: true };
    }

    // Calculate liquidity
    const wholeA = reserveA ? Number(reserveA) / Math.pow(10, decA) : 0;
    const wholeB = reserveB ? Number(reserveB) / Math.pow(10, decB) : 0;
    const liquidityBase = Math.min(wholeA, wholeB);

    // Build the updated pool item
    const item: AmmPool = {
      id: poolId,
      dex: 'Pumpswap',
      mint_a: processedPrice.mintA,
      mint_b: processedPrice.mintB,
      fee_bps: decoded.fee_bps || DEFAULT_FEE_BPS,
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
    const validation = validateDecodedPool('pumpswap', item, poolId);
    if (!validation.valid) {
      wsDecodeStats.pumpswap.failures += 1;
      incrementSkipReason('pumpswap', `validation_failed:${validation.reasons.join(',')}`);
      return { success: false, error: `validation_failed:${validation.reasons.join(',')}`, skipped: true };
    }

    // Update cache
    const prev = pumpswapCache.data || { amm: [], clmm: [] };
    const next: PoolsPayload = { amm: prev.amm.slice(), clmm: prev.clmm.slice() };
    const idx = next.amm.findIndex(p => p.id === item.id);

    // Validate price delta against previous value
    if (idx >= 0) {
      validatePriceDelta('pumpswap', poolId, item.price_a_per_b, next.amm[idx].price_a_per_b);
    }

    if (idx >= 0) {
      const prevPool = next.amm[idx];
      const orientationChanged = prevPool.mint_a !== item.mint_a || prevPool.mint_b !== item.mint_b;
      if (orientationChanged) {
        logger.warn('ws.update.orientation_changed', {
          poolId: poolId.slice(0, 8) + '…',
          dex: 'Pumpswap',
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
    wsDecodeStats.pumpswap.successes += 1;
    wsDeltaStats.pumpswap.decoded += 1;
    
    const delta = diffNormalizedPools(prev, next);
    pumpswapCache.data = next;
    pumpswapCache.ts = Date.now();

    const hasDelta = delta.amm.length || delta.clmm.length || delta.addedAmm || delta.removedAmm || delta.addedClmm || delta.removedClmm;
    if (hasDelta) {
      wsDeltaStats.pumpswap.applied += 1;
    } else {
      wsDeltaStats.pumpswap.skipped += 1;
      incrementSkipReason('pumpswap', 'no_delta');
    }

    // Emit update event
    try {
      emit('pool-updates', {
        source: 'pumpswap',
        updatedAmm: delta.amm.length,
        updatedClmm: 0,
        sample: { amm: delta.amm.slice(0, 20), clmm: [] },
        ts: Date.now()
      });
    } catch {}

    // Schedule graph update
    if (hasDelta) {
      await scheduleDexApply('pumpswap', prev);
    }

    // Try to activate pool for lazy activation mode (only activates on first valid price update)
    const hasValidPriceVault = !!(
      processedPrice?.priceForward &&
      Number.isFinite(processedPrice.priceForward) &&
      processedPrice.priceForward > 0
    );
    tryActivatePool(poolId, 'pumpswap', hasValidPriceVault);

    return { success: true, pool: item as DecodedPool, delta };
  } catch (e) {
    wsDecodeStats.pumpswap.failures += 1;
    logCatchError('pumpswap.handleVaultUpdate', e, { vault: vaultAddress.slice(0, 8) + '…' });
    return { success: false, error: String((e as Error)?.message || e) };
  }
}

/**
 * Handle Pumpswap WebSocket account update
 * 
 * Pumpswap can receive updates from:
 * 1. Pool accounts (owned by pumpswap program) - decode pool state directly
 * 2. Vault accounts (owned by SPL Token) - update vault balances
 * 
 * This function routes to the appropriate handler based on account owner.
 */
export async function handlePumpswapUpdate(
  info: AccountInfo,
  accountAddress: string,
  derivedAccountToPool: Map<string, DerivedAccountInfo> = new Map()
): Promise<UpdateResult> {
  try {
    wsDecodeStats.pumpswap.attempts += 1;
    
    // Determine account owner
    const owner = typeof info.owner === 'string' 
      ? info.owner 
      : info.owner?.toBase58?.() || '';
    
    // Route based on owner
    if (owner === PUMPSWAP_PROGRAM_ID) {
      // This is a pool account update (owned by pumpswap program)
      // Decode the pool state directly
      return handlePumpswapPoolAccountUpdate(info, accountAddress);
    }
    
    // Check if this is a derived account (vault)
    const derivedMeta = derivedAccountToPool.get(accountAddress);
    if (!derivedMeta) {
      logger.debug('pumpswap.update.unknown_account', {
        account: accountAddress.slice(0, 8) + '…',
        owner: owner.slice(0, 8) + '…',
        cat: 'pools'
      });
      wsDeltaStats.pumpswap.skipped += 1;
      incrementSkipReason('pumpswap', 'unknown_account');
      return { success: false, error: 'unknown_account', skipped: true };
    }

    if (derivedMeta.accountType !== 'vault' && derivedMeta.accountType !== 'reserve') {
      logger.debug('pumpswap.update.not_vault', {
        account: accountAddress.slice(0, 8) + '…',
        accountType: derivedMeta.accountType,
        cat: 'pools'
      });
      wsDeltaStats.pumpswap.skipped += 1;
      incrementSkipReason('pumpswap', 'not_vault_account');
      return { success: true, skipped: true, skipReason: 'not_vault' };
    }

    return handlePumpswapVaultUpdate(info, accountAddress, derivedMeta.poolId);
  } catch (e) {
    wsDecodeStats.pumpswap.failures += 1;
    logCatchError('pumpswap.handleUpdate', e, { account: accountAddress.slice(0, 8) + '…' });
    return { success: false, error: String((e as Error)?.message || e) };
  }
}

/**
 * Check if an owner is the Pumpswap program
 */
export function isPumpswapOwner(owner: string): boolean {
  return owner === PUMPSWAP_PROGRAM_ID;
}

/**
 * Get Pumpswap program ID
 */
export const PUMPSWAP_PROGRAM = PUMPSWAP_PROGRAM_ID;

