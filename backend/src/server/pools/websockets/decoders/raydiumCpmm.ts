/**
 * Raydium CPMM (Constant Product Market Maker) pool decoder
 * 
 * Handles decoding and WebSocket updates for Raydium CPMM pools.
 * 
 * CPMM pools use a constant product formula (x*y=k) like AMM V4 but with
 * a different account structure. They are simpler than CLMM pools.
 * 
 * Program ID: CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C
 */

import { logger } from '../../../../utils/logger.js';
import { logCatchError, logCatchDebug } from '../../../../utils/errorHandler.js';
import { processPriceThroughPipeline } from '../../pricePipeline.js';
import { canonicalizePools } from '../../canonical.js';
import { cpmmCache } from '../../../pools.cache.js';
import { emit } from '../../../realtime.js';
import { wsDecodeStats, wsDeltaStats, incrementSkipReason } from '../../../pools.metrics.js';
import { validateDecodedPool, validatePriceDelta } from '../validation.js';
import { tryActivatePool } from '../../../pools.activation.js';
import type { 
  DecodedPool, 
  UpdateResult, 
  AccountInfo, 
  ProcessedPriceResult,
  DerivedAccountInfo,
} from './types.js';
import type { CpmmPool } from '../../types.js';

// Program ID
const RAYDIUM_CPMM_PROGRAM = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

// Minimum buffer length for basic validation before SDK decode
const MIN_CPMM_BUFFER_LENGTH = 200;

// Cached SDK layout for performance (loaded lazily)
let CpmmPoolInfoLayout: any = null;

// Debounce state for graph updates
let cpmmApplyState: { baseline: { cpmm: CpmmPool[] } | null; timer: NodeJS.Timeout | null } = { baseline: null, timer: null };
const DEBOUNCE_MS = 50;

/**
 * Load the CPMM layout from SDK (lazy initialization)
 */
async function loadCpmmLayout(): Promise<any> {
  if (CpmmPoolInfoLayout) return CpmmPoolInfoLayout;
  
  try {
    const cpmmLayoutModule = await import('@raydium-io/raydium-sdk-v2/lib/raydium/cpmm/layout.js');
    CpmmPoolInfoLayout = cpmmLayoutModule.CpmmPoolInfoLayout;
    return CpmmPoolInfoLayout;
  } catch (e) {
    logCatchDebug('raydiumCpmm.loadLayout', e);
    return null;
  }
}

/**
 * Schedule debounced graph update for CPMM
 */
async function scheduleCpmmApply(baseline: { cpmm: CpmmPool[] }): Promise<void> {
  try {
    if (!cpmmApplyState.baseline) {
      cpmmApplyState.baseline = baseline;
    }
    if (cpmmApplyState.timer) {
      clearTimeout(cpmmApplyState.timer);
    }
    cpmmApplyState.timer = setTimeout(async () => {
      try {
        const gmod: any = await import('../../../graph.js');
        const current = cpmmCache.data;
        if (current && cpmmApplyState.baseline) {
          // Use applyPoolUpdates for incremental graph updates
          if (typeof gmod?.applyCpmmPoolUpdates === 'function') {
            await gmod.applyCpmmPoolUpdates(cpmmApplyState.baseline, current, { pushToArb: false });
          }
        }
      } catch (e) {
        logCatchDebug('raydiumCpmm.scheduleCpmmApply', e);
      } finally {
        cpmmApplyState.baseline = null;
        cpmmApplyState.timer = null;
      }
    }, DEBOUNCE_MS);
  } catch (e) {
    logCatchDebug('raydiumCpmm.scheduleCpmmApply.setup', e);
  }
}

/**
 * Decode Raydium CPMM pool from account data
 * 
 * Uses the Raydium SDK's CpmmPoolInfoLayout for reliable decoding.
 * This is more robust than manual buffer parsing as it uses the official IDL.
 */
export async function decodeRaydiumCpmmPool(
  data: Buffer,
  poolId: string,
  derivedAccountToPool?: Map<string, DerivedAccountInfo>
): Promise<DecodedPool | null> {
  try {
    if (!data || data.length < MIN_CPMM_BUFFER_LENGTH) {
      return null;
    }

    // Check for derived account (vault) confusion
    if (derivedAccountToPool?.has(poolId)) {
      const derivedMeta = derivedAccountToPool.get(poolId);
      logger.warn('raydium.decoder.cpmm.vault_as_pool.prevented', {
        account: poolId.slice(0, 8) + '…',
        accountType: derivedMeta?.accountType,
        parentPool: derivedMeta?.poolId?.slice(0, 8) + '…',
        reason: 'account_is_vault_not_pool',
        cat: 'pools'
      });
      return null;
    }

    // Load SDK layout (cached after first call)
    const layout = await loadCpmmLayout();
    if (!layout?.decode) {
      logCatchDebug('raydium.decodeCpmm.layout_unavailable', 'SDK layout not available');
      return null;
    }

    // Decode using SDK layout - more reliable than manual offset parsing
    const state = layout.decode(data);
    if (!state) {
      return null;
    }

    // Extract fields from decoded state
    const token0Mint = state.mintA?.toBase58?.() || '';
    const token1Mint = state.mintB?.toBase58?.() || '';
    const token0Vault = state.vaultA?.toBase58?.() || '';
    const token1Vault = state.vaultB?.toBase58?.() || '';
    const ammConfig = state.configId?.toBase58?.() || '';
    const observationKey = state.observationId?.toBase58?.() || '';
    const lpMint = state.mintLp?.toBase58?.() || '';
    const creator = state.poolCreator?.toBase58?.() || '';
    const token0Program = state.mintProgramA?.toBase58?.() || '';
    const token1Program = state.mintProgramB?.toBase58?.() || '';
    const mint0Decimals = state.mintDecimalA ?? 9;
    const mint1Decimals = state.mintDecimalB ?? 6;
    
    // Validate required fields
    if (!token0Mint || !token1Mint) {
      return null;
    }
    
    if (!token0Vault || !token1Vault) {
      return null;
    }

    // Determine token programs
    const tokenProgramA = token0Program === TOKEN_2022_PROGRAM_ID ? 'token-2022' : 'spl-token';
    const tokenProgramB = token1Program === TOKEN_2022_PROGRAM_ID ? 'token-2022' : 'spl-token';

    // CPMM uses 25 bps default fee
    const fee_bps = 25;

    return {
      id: poolId,
      dex: 'Raydium',
      mint_a: token0Mint,
      mint_b: token1Mint,
      fee_bps,
      price_a_per_b: 0, // Will be calculated through pipeline after vault fetch
      updated_ms: Date.now(),
      pool_kind: 'cpmm' as any,
      native_mint_a: token0Mint,
      native_mint_b: token1Mint,
      decimals_a: mint0Decimals,
      decimals_b: mint1Decimals,
      native_decimals_a: mint0Decimals,
      native_decimals_b: mint1Decimals,
      account_a: token0Vault,
      account_b: token1Vault,
      native_account_a: token0Vault,
      native_account_b: token1Vault,
      // CPMM-specific fields
      amm_config: ammConfig,
      observation_key: observationKey,
      lp_mint: lpMint,
      creator,
      token_program_a: tokenProgramA,
      token_program_b: tokenProgramB,
    } as any;
  } catch (e) {
    logCatchDebug('raydium.decodeCpmm', e, { poolId });
    return null;
  }
}

/**
 * Handle Raydium CPMM WebSocket update
 */
async function handleCpmmUpdate(
  info: AccountInfo,
  poolId: string,
  derivedAccountToPool: Map<string, DerivedAccountInfo>,
  owner: string
): Promise<UpdateResult> {
  const data = Buffer.isBuffer(info.data) ? info.data : Buffer.from(info.data ?? []);
  
  // Decode the pool
  const decoded = await decodeRaydiumCpmmPool(data, poolId, derivedAccountToPool);
  if (!decoded) {
    return { success: false, error: 'decode_failed', skipped: true };
  }

  const mintA = decoded.native_mint_a || decoded.mint_a;
  const mintB = decoded.native_mint_b || decoded.mint_b;
  
  // Get decimals from decoded data or cache
  let decA = decoded.decimals_a ?? decoded.native_decimals_a;
  let decB = decoded.decimals_b ?? decoded.native_decimals_b;
  
  // Fallback to cache or resolver
  if (!Number.isFinite(decA) || !Number.isFinite(decB)) {
    const cachedPools = cpmmCache.data?.cpmm || [];
    const existing = cachedPools.find((p: any) => p.id === poolId);
    if (existing) {
      if (!Number.isFinite(decA)) decA = existing.native_decimals_a ?? existing.decimals_a;
      if (!Number.isFinite(decB)) decB = existing.native_decimals_b ?? existing.decimals_b;
    }
  }
  
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
      logger.warn('raydium.decoder.cpmm.decimals_resolve_error', {
        poolId: poolId.slice(0, 8) + '…',
        mintA: mintA?.slice(0, 8) + '…',
        mintB: mintB?.slice(0, 8) + '…',
        error: String((resolveErr as Error)?.message || resolveErr),
        cat: 'pools'
      });
    }
  }

  // Fallback to defaults
  if (!Number.isFinite(decA)) {
    logger.warn('raydium.decoder.cpmm.decimals_fallback', {
      poolId: poolId.slice(0, 8) + '…',
      mint: mintA?.slice(0, 8) + '…',
      side: 'A',
      fallbackValue: 9,
      cat: 'pools'
    });
    decA = 9;
  }
  if (!Number.isFinite(decB)) {
    logger.warn('raydium.decoder.cpmm.decimals_fallback', {
      poolId: poolId.slice(0, 8) + '…',
      mint: mintB?.slice(0, 8) + '…',
      side: 'B',
      fallbackValue: 6,
      cat: 'pools'
    });
    decB = 6;
  }

  // For CPMM, we need vault balances to calculate price
  // Try to get from execution cache hot data (updated by vault subscriptions)
  let reserveA: bigint | undefined;
  let reserveB: bigint | undefined;
  
  try {
    const { vaultBalanceCache } = await import('../../../pools.cache.js');
    const vaultA = decoded.account_a || (decoded as any).native_account_a;
    const vaultB = decoded.account_b || (decoded as any).native_account_b;
    
    if (vaultA && vaultBalanceCache.has(vaultA)) {
      reserveA = vaultBalanceCache.get(vaultA);
    }
    if (vaultB && vaultBalanceCache.has(vaultB)) {
      reserveB = vaultBalanceCache.get(vaultB);
    }
  } catch {}

  // Process through price pipeline
  let processedPrice: ProcessedPriceResult | null = null;
  if (Number.isFinite(decA) && Number.isFinite(decB) && reserveA && reserveB && reserveA > 0n && reserveB > 0n) {
    processedPrice = processPriceThroughPipeline({
      mintA,
      mintB,
      decimalsA: decA!,
      decimalsB: decB!,
      poolId,
      dex: 'Raydium',
      poolType: 'cpmm',
      reserveA,
      reserveB,
    });
  }

  // Calculate whole token amounts from reserves
  const amountAWhole = reserveA && decA !== undefined ? Number(reserveA) / Math.pow(10, decA) : undefined;
  const amountBWhole = reserveB && decB !== undefined ? Number(reserveB) / Math.pow(10, decB) : undefined;

  // Build the pool item
  const item: CpmmPool = {
    id: poolId,
    dex: 'Raydium',
    mint_a: processedPrice?.mintA || mintA,
    mint_b: processedPrice?.mintB || mintB,
    fee_bps: decoded.fee_bps,
    price_a_per_b: processedPrice?.priceForward || 0,
    updated_ms: Date.now(),
    pool_kind: 'cpmm',
    decimals_a: processedPrice?.decimalsA || decA,
    decimals_b: processedPrice?.decimalsB || decB,
    native_mint_a: mintA,
    native_mint_b: mintB,
    native_decimals_a: decA,
    native_decimals_b: decB,
    account_a: processedPrice?.wasSwapped ? (decoded as any).account_b : (decoded as any).account_a,
    account_b: processedPrice?.wasSwapped ? (decoded as any).account_a : (decoded as any).account_b,
    native_account_a: (decoded as any).account_a,
    native_account_b: (decoded as any).account_b,
    amm_config: (decoded as any).amm_config,
    observation_key: (decoded as any).observation_key,
    lp_mint: (decoded as any).lp_mint,
    token_program_a: processedPrice?.wasSwapped 
      ? (decoded as any).token_program_b 
      : (decoded as any).token_program_a,
    token_program_b: processedPrice?.wasSwapped 
      ? (decoded as any).token_program_a 
      : (decoded as any).token_program_b,
    was_swapped: processedPrice?.wasSwapped || false,
    reserve_a_raw: reserveA?.toString(),
    reserve_b_raw: reserveB?.toString(),
    amount_a_whole: amountAWhole,
    amount_b_whole: amountBWhole,
    _pipelineProcessed: true,
  };

  // Validate decoded pool
  const validation = validateDecodedPool('raydium-cpmm', item as any, poolId);
  if (!validation.valid) {
    wsDecodeStats.raydium_cpmm.failures += 1;
    incrementSkipReason('raydium_cpmm', `validation_failed:${validation.reasons.join(',')}`);
    return { success: false, error: `validation_failed:${validation.reasons.join(',')}`, skipped: true };
  }

  // Update cache
  const prev = cpmmCache.data || { cpmm: [] };
  const next = { cpmm: prev.cpmm.slice() };
  const idx = next.cpmm.findIndex(p => p.id === item.id);

  // Validate price delta against previous value
  if (idx >= 0) {
    validatePriceDelta('raydium-cpmm' as any, poolId, item.price_a_per_b, next.cpmm[idx].price_a_per_b);
  }

  if (idx >= 0) {
    const prevPool = next.cpmm[idx];
    const orientationChanged = prevPool.mint_a !== item.mint_a || prevPool.mint_b !== item.mint_b;
    if (orientationChanged) {
      logger.warn('ws.update.orientation_changed', {
        poolId: poolId.slice(0, 8) + '…',
        dex: 'Raydium',
        poolType: 'cpmm',
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
      next.cpmm[idx] = { ...item, ...orientationIndependentFields };
    } else {
      next.cpmm[idx] = { ...next.cpmm[idx], ...item };
    }
  } else {
    next.cpmm.push(item);
  }

  // Update execution cache
  try {
    const { executionCache } = await import('../../../../execution/cache.js');
    const existingStatic = executionCache.getStatic(poolId) || {};
    
    executionCache.setStatic(poolId, {
      ...existingStatic,
      rawAccountData: data,
      rawAccountDataUpdatedMs: Date.now(),
      programId: RAYDIUM_CPMM_PROGRAM,
      dex: 'Raydium',
      pool_kind: 'cpmm',
      mint_a: item.mint_a,
      mint_b: item.mint_b,
      decimals_a: item.decimals_a,
      decimals_b: item.decimals_b,
      native_mint_a: item.native_mint_a,
      native_mint_b: item.native_mint_b,
      native_decimals_a: item.native_decimals_a,
      native_decimals_b: item.native_decimals_b,
      vault_a: item.account_a,
      vault_b: item.account_b,
      native_account_a: item.native_account_a,
      native_account_b: item.native_account_b,
      amm_config: item.amm_config,
      observation_key: item.observation_key,
      lp_mint: item.lp_mint,
      token_program_a: item.token_program_a,
      token_program_b: item.token_program_b,
    });
  } catch (cacheErr) {
    logCatchDebug('raydiumCpmm.cache_update', cacheErr, { pool: poolId.slice(0, 8) + '…' });
  }

  // Update stats and cache
  wsDecodeStats.raydium_cpmm.successes += 1;
  wsDeltaStats.raydium_cpmm.decoded += 1;

  // Check for delta
  const prevPool = prev.cpmm.find(p => p.id === item.id);
  const hasDelta = !prevPool || 
    prevPool.price_a_per_b !== item.price_a_per_b ||
    prevPool.reserve_a_raw !== item.reserve_a_raw ||
    prevPool.reserve_b_raw !== item.reserve_b_raw;

  if (hasDelta) {
    wsDeltaStats.raydium_cpmm.applied += 1;
  } else {
    wsDeltaStats.raydium_cpmm.skipped += 1;
    incrementSkipReason('raydium_cpmm', 'no_delta_detected');
  }

  cpmmCache.data = next;
  cpmmCache.ts = Date.now();

  // Emit update event
  try {
    emit('pool-updates', {
      source: 'raydium-cpmm',
      updatedCpmm: 1,
      sample: { cpmm: [item] },
      ts: Date.now()
    });
  } catch {}

  // Schedule graph update
  if (hasDelta) {
    await scheduleCpmmApply(prev);
  }

  // Try to activate pool for lazy activation mode
  const hasValidPrice = !!(
    item.price_a_per_b &&
    Number.isFinite(item.price_a_per_b) &&
    item.price_a_per_b > 0
  );
  tryActivatePool(poolId, 'raydium-cpmm' as any, hasValidPrice);

  return { success: true, pool: item as unknown as DecodedPool };
}

/**
 * Handle Raydium CPMM vault update (for reserve tracking)
 */
export async function handleCpmmVaultUpdate(
  info: AccountInfo,
  vaultAddress: string,
  poolId: string
): Promise<UpdateResult> {
  try {
    const data = Buffer.isBuffer(info.data) ? info.data : Buffer.from(info.data ?? []);
    
    // SPL Token account is 165 bytes, Token-2022 is larger
    if (data.length < 72) {
      return { success: false, error: 'invalid_vault_data', skipped: true };
    }

    // Read balance from token account (offset 64, u64)
    const balance = data.readBigUInt64LE(64);
    
    // Update vault balance cache
    const { vaultBalanceCache } = await import('../../../pools.cache.js');
    vaultBalanceCache.set(vaultAddress, balance);
    
    // Try to trigger a pool update if we have both vault balances
    const { executionCache } = await import('../../../../execution/cache.js');
    const poolData = executionCache.getStatic(poolId);
    
    if (poolData) {
      const vaultA = poolData.native_account_a;
      const vaultB = poolData.native_account_b;
      
      if (vaultA && vaultB) {
        const balanceA = vaultBalanceCache.get(vaultA);
        const balanceB = vaultBalanceCache.get(vaultB);
        
        if (balanceA !== undefined && balanceB !== undefined && balanceA > 0n && balanceB > 0n) {
          // We have both balances - recalculate price
          const decA = poolData.native_decimals_a ?? poolData.decimals_a ?? 9;
          const decB = poolData.native_decimals_b ?? poolData.decimals_b ?? 6;
          const mintA = poolData.native_mint_a ?? poolData.mint_a;
          const mintB = poolData.native_mint_b ?? poolData.mint_b;
          
          if (mintA && mintB) {
            const processedPrice = processPriceThroughPipeline({
              mintA,
              mintB,
              decimalsA: decA,
              decimalsB: decB,
              poolId,
              dex: 'Raydium',
              poolType: 'cpmm',
              reserveA: balanceA,
              reserveB: balanceB,
            });
            
            if (processedPrice && processedPrice.priceForward > 0) {
              // Calculate whole token amounts from reserves
              const amountAWhole = Number(balanceA) / Math.pow(10, decA);
              const amountBWhole = Number(balanceB) / Math.pow(10, decB);
              
              // Update pool in cache
              const prev = cpmmCache.data || { cpmm: [] };
              const idx = prev.cpmm.findIndex(p => p.id === poolId);
              
              if (idx >= 0) {
                const next = { cpmm: prev.cpmm.slice() };
                next.cpmm[idx] = {
                  ...next.cpmm[idx],
                  price_a_per_b: processedPrice.priceForward,
                  reserve_a_raw: balanceA.toString(),
                  reserve_b_raw: balanceB.toString(),
                  amount_a_whole: amountAWhole,
                  amount_b_whole: amountBWhole,
                  updated_ms: Date.now(),
                };
                
                cpmmCache.data = next;
                cpmmCache.ts = Date.now();
                
                // Emit update
                try {
                  emit('pool-updates', {
                    source: 'raydium-cpmm',
                    updatedCpmm: 1,
                    sample: { cpmm: [next.cpmm[idx]] },
                    ts: Date.now()
                  });
                } catch {}
                
                return { success: true };
              }
            }
          }
        }
      }
    }
    
    return { success: true };
  } catch (e) {
    logCatchDebug('raydiumCpmm.handleVaultUpdate', e, { vault: vaultAddress.slice(0, 8) + '…' });
    return { success: false, error: String((e as Error)?.message || e) };
  }
}

/**
 * Handle Raydium CPMM WebSocket account update
 * 
 * Main entry point for processing CPMM pool updates from WebSocket.
 */
export async function handleRaydiumCpmmUpdate(
  info: AccountInfo,
  poolId: string,
  derivedAccountToPool: Map<string, DerivedAccountInfo> = new Map()
): Promise<UpdateResult> {
  try {
    wsDecodeStats.raydium_cpmm.attempts += 1;
    
    const owner = typeof info.owner === 'string' ? info.owner : info.owner?.toBase58?.() || '';
    const data = Buffer.isBuffer(info.data) ? info.data : Buffer.from(info.data ?? []);
    
    if (!data || data.length === 0) {
      return { success: false, error: 'no_data', skipped: true };
    }

    // Check if this is a vault update
    const derivedMeta = derivedAccountToPool.get(poolId);
    if (derivedMeta?.accountType === 'vault') {
      return handleCpmmVaultUpdate(info, poolId, derivedMeta.poolId);
    }

    // Try to decode as CPMM pool
    const decoded = await decodeRaydiumCpmmPool(data, poolId, derivedAccountToPool);
    if (decoded) {
      return handleCpmmUpdate(info, poolId, derivedAccountToPool, owner);
    }

    // Decode failed
    wsDecodeStats.raydium_cpmm.failures += 1;
    return { success: false, error: 'decode_failed', skipped: true };
  } catch (e) {
    wsDecodeStats.raydium_cpmm.failures += 1;
    logCatchError('raydiumCpmm.handleUpdate', e, { poolId: poolId.slice(0, 8) + '…' });
    return { success: false, error: String((e as Error)?.message || e) };
  }
}

/**
 * Check if an owner is the Raydium CPMM program
 */
export function isRaydiumCpmmOwner(owner: string): boolean {
  return owner === RAYDIUM_CPMM_PROGRAM;
}

/**
 * Raydium CPMM program ID
 */
export const RAYDIUM_CPMM_PROGRAM_ID = RAYDIUM_CPMM_PROGRAM;
