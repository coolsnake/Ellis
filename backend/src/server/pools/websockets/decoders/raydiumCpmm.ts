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
import { ensureOrientationConsistency } from '../../orientationValidation.js';
import { tryActivatePool } from '../../../pools.activation.js';
// Import per-pool staleness tracking
import { recordPoolActivity } from '../staleness.js';
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

// ─── Batched vault balance fetcher (for program-mode where vaults don't arrive via WS) ───
const VAULT_BATCH_DELAY_MS = 75;
const pendingVaultFetches = new Map<string, Array<{ resolve: (v: bigint | undefined) => void }>>();
let vaultFetchTimer: ReturnType<typeof setTimeout> | null = null;

function queueVaultFetch(vaultAddress: string): Promise<bigint | undefined> {
  // Check cache first (avoid queueing if already known)
  try {
    const { vaultBalanceCache } = require('../../../pools.cache.js');
    if (vaultBalanceCache.has(vaultAddress)) {
      return Promise.resolve(vaultBalanceCache.get(vaultAddress));
    }
  } catch {}

  return new Promise((resolve) => {
    if (!pendingVaultFetches.has(vaultAddress)) {
      pendingVaultFetches.set(vaultAddress, []);
    }
    pendingVaultFetches.get(vaultAddress)!.push({ resolve });

    if (!vaultFetchTimer) {
      vaultFetchTimer = setTimeout(flushVaultFetches, VAULT_BATCH_DELAY_MS);
    }
  });
}

async function flushVaultFetches(): Promise<void> {
  vaultFetchTimer = null;
  const batch = new Map(pendingVaultFetches);
  pendingVaultFetches.clear();
  if (batch.size === 0) return;

  let vaultBalanceCache: Map<string, bigint>;
  try {
    vaultBalanceCache = (await import('../../../pools.cache.js')).vaultBalanceCache;
  } catch { return; }

  // Resolve any that got cached while waiting for the batch timer
  const toFetch: string[] = [];
  for (const [addr, waiters] of batch) {
    if (vaultBalanceCache.has(addr)) {
      const val = vaultBalanceCache.get(addr);
      for (const w of waiters) w.resolve(val);
    } else {
      toFetch.push(addr);
    }
  }
  if (toFetch.length === 0) return;

  try {
    const { getConnection } = await import('../../../../wallet/wallet.js');
    const { PublicKey } = await import('@solana/web3.js');
    const conn = getConnection();

    // Batch RPC in chunks of 100
    for (let i = 0; i < toFetch.length; i += 100) {
      const chunk = toFetch.slice(i, i + 100);
      try {
        const infos = await conn.getMultipleAccountsInfo(
          chunk.map((a: string) => new PublicKey(a))
        );
        for (let j = 0; j < chunk.length; j++) {
          const info = infos[j];
          let balance: bigint | undefined;
          if (info?.data) {
            const buf = Buffer.isBuffer(info.data) ? info.data : Buffer.from(info.data);
            if (buf.length >= 72) {
              balance = buf.readBigUInt64LE(64);
              vaultBalanceCache.set(chunk[j], balance);
            }
          }
          const waiters = batch.get(chunk[j]);
          if (waiters) for (const w of waiters) w.resolve(balance);
        }
      } catch (err) {
        logger.warn('cpmm.vault.batch_fetch.chunk_error', { chunkSize: chunk.length, error: String(err), cat: 'pools' });
        // Resolve chunk with undefined on error
        for (const addr of chunk) {
          const waiters = batch.get(addr);
          if (waiters) for (const w of waiters) w.resolve(undefined);
        }
      }
    }
  } catch (err) {
    logger.warn('cpmm.vault.batch_fetch.error', { total: toFetch.length, error: String(err), cat: 'pools' });
    for (const addr of toFetch) {
      const waiters = batch.get(addr);
      if (waiters) for (const w of waiters) w.resolve(undefined);
    }
  }
}

// ─── ammConfig fee cache (for resolving real fees from on-chain config accounts) ───
const ammConfigFeeCache = new Map<string, number>();
let CpmmConfigInfoLayout: any = null;

async function resolveAmmConfigFee(configId: string): Promise<number | undefined> {
  const SYSTEM_PROGRAM = '11111111111111111111111111111111';
  if (!configId || configId === SYSTEM_PROGRAM) return undefined;
  if (ammConfigFeeCache.has(configId)) return ammConfigFeeCache.get(configId);

  try {
    const { getConnection } = await import('../../../../wallet/wallet.js');
    const { PublicKey } = await import('@solana/web3.js');
    const conn = getConnection();
    const info = await conn.getAccountInfo(new PublicKey(configId));
    if (!info?.data) return undefined;

    // Load CpmmConfigInfoLayout from SDK (lazy)
    if (!CpmmConfigInfoLayout) {
      try {
        const mod = await import('@raydium-io/raydium-sdk-v2/lib/raydium/cpmm/layout.js');
        CpmmConfigInfoLayout = mod.CpmmConfigInfoLayout;
      } catch {
        return undefined;
      }
    }
    const buf = Buffer.isBuffer(info.data) ? info.data : Buffer.from(info.data);
    const config = CpmmConfigInfoLayout.decode(buf);
    // tradeFeeRate is in 1/1_000_000 units → convert to bps (÷ 100)
    const tradeFeeRate = Number(config.tradeFeeRate || 0);
    const feeBps = Math.round(tradeFeeRate / 100);
    ammConfigFeeCache.set(configId, feeBps);
    return feeBps;
  } catch {
    return undefined;
  }
}

/** Exported for use by AMM v4 vaults in pools.websockets.ts */
export { queueVaultFetch, resolveAmmConfigFee, ammConfigFeeCache };

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
 * Wraps CPMM pools in PoolsPayload format expected by applyPoolUpdates
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
          // Wrap CPMM pools in PoolsPayload format for applyPoolUpdates
          const prevPayload = { amm: [], clmm: [], cpmm: cpmmApplyState.baseline.cpmm || [] };
          const nextPayload = { amm: [], clmm: [], cpmm: current.cpmm || [] };
          
          // Use standard applyPoolUpdates for incremental graph updates
          if (typeof gmod?.applyPoolUpdates === 'function') {
            await gmod.applyPoolUpdates(prevPayload, nextPayload, { pushToArb: false });
            try {
              const { logger } = await import('../../../../utils/logger.js');
              logger.debug('raydiumCpmm.graph_update.applied', { 
                prevCount: prevPayload.cpmm.length, 
                nextCount: nextPayload.cpmm.length,
                cat: 'pools' 
              });
            } catch {}
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

    // Filter non-pool accounts (ammConfig, observation, etc.)
    // In program-level subscription mode, ALL accounts owned by the CPMM program arrive.
    // Pool accounts have valid mintA/mintB; non-pool accounts have zero-pubkeys.
    const SYSTEM_PROGRAM = '11111111111111111111111111111111';
    if (!token0Mint || !token1Mint ||
        token0Mint === SYSTEM_PROGRAM || token1Mint === SYSTEM_PROGRAM ||
        token0Mint === token1Mint) {
      return null;
    }

    const token0Vault = state.vaultA?.toBase58?.() || '';
    const token1Vault = state.vaultB?.toBase58?.() || '';
    const ammConfig = state.configId?.toBase58?.() || '';
    const observationKey = state.observationId?.toBase58?.() || '';
    const lpMint = state.mintLp?.toBase58?.() || '';
    const creator = state.poolCreator?.toBase58?.() || '';
    const token0Program = state.mintProgramA?.toBase58?.() || '';
    const token1Program = state.mintProgramB?.toBase58?.() || '';

    // CRITICAL: Use symmetric fallback (9) to avoid ratio errors from mismatched decimals
    // On-chain state should always have decimals, but if missing, log warning
    let mint0Decimals = state.mintDecimalA;
    let mint1Decimals = state.mintDecimalB;

    if (!Number.isFinite(mint0Decimals) || !Number.isFinite(mint1Decimals)) {
      // Log warning - on-chain decimals should never be missing
      logger.warn('raydium.cpmm.decode.decimals_missing_onchain', {
        poolId: poolId.slice(0, 8) + '…',
        token0Mint: token0Mint.slice(0, 8) + '…',
        token1Mint: token1Mint.slice(0, 8) + '…',
        mint0Decimals,
        mint1Decimals,
        warning: 'On-chain decimals missing - using fallback 9, price may be incorrect',
        cat: 'pools'
      });
      if (!Number.isFinite(mint0Decimals)) mint0Decimals = 9;
      if (!Number.isFinite(mint1Decimals)) mint1Decimals = 9;
    }

    if (!token0Vault || !token1Vault) {
      return null;
    }

    // Determine token programs
    const tokenProgramA = token0Program === TOKEN_2022_PROGRAM_ID ? 'token-2022' : 'spl-token';
    const tokenProgramB = token1Program === TOKEN_2022_PROGRAM_ID ? 'token-2022' : 'spl-token';

    // Use cached ammConfig fee if available, otherwise default to 25 bps
    const fee_bps = ammConfigFeeCache.get(ammConfig) ?? 25;

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
  // Prefer native_decimals since mintA/mintB are in native order from chain
  let decA = decoded.native_decimals_a ?? decoded.decimals_a;
  let decB = decoded.native_decimals_b ?? decoded.decimals_b;

  // Fallback to cache or resolver
  if (!Number.isFinite(decA) || !Number.isFinite(decB)) {
    const cachedPools = cpmmCache.data?.cpmm || [];
    const existing = cachedPools.find((p: any) => p.id === poolId);
    if (existing) {
      // CRITICAL: If native decimals missing, derive from canonical + was_swapped
      // When swapped: canonical A = native B, so native A decimals = canonical B decimals
      const wasSwapped = (existing as any)?.was_swapped === true;
      if (!Number.isFinite(decA)) decA = existing.native_decimals_a ?? (wasSwapped ? existing.decimals_b : existing.decimals_a);
      if (!Number.isFinite(decB)) decB = existing.native_decimals_b ?? (wasSwapped ? existing.decimals_a : existing.decimals_b);
    }
  }

  if (!Number.isFinite(decA) || !Number.isFinite(decB)) {
    try {
      const { executionCache } = await import('../../../../execution/cache.js');
      const cached = executionCache.getStatic(poolId);
      // Apply same swap logic for safety
      const cachedWasSwapped = (cached as any)?.was_swapped === true;
      if (!Number.isFinite(decA)) decA = cached?.native_decimals_a ?? (cachedWasSwapped ? cached?.decimals_b : cached?.decimals_a);
      if (!Number.isFinite(decB)) decB = cached?.native_decimals_b ?? (cachedWasSwapped ? cached?.decimals_a : cached?.decimals_b);
    } catch {}
  }

  // Use guaranteed decimal resolution for any still-missing decimals
  // This will do RPC fetch if needed, avoiding dangerous fallback defaults
  if (!Number.isFinite(decA) || !Number.isFinite(decB)) {
    try {
      const { resolveDecimalsGuaranteed } = await import('../../decimals.js');
      
      if (!Number.isFinite(decA) && mintA) {
        const resultA = await resolveDecimalsGuaranteed(mintA, poolId, 'Raydium');
        decA = resultA.decimals;
        if (resultA.source === 'default' && !resultA.validated) {
          logger.warn('raydium.decoder.cpmm.decimals_guaranteed_fallback', {
            poolId: poolId.slice(0, 8) + '…',
            mint: mintA?.slice(0, 8) + '…',
            side: 'A',
            decimals: decA,
            source: resultA.source,
            cat: 'pools'
          });
        }
      }
      if (!Number.isFinite(decB) && mintB) {
        const resultB = await resolveDecimalsGuaranteed(mintB, poolId, 'Raydium');
        decB = resultB.decimals;
        if (resultB.source === 'default' && !resultB.validated) {
          logger.warn('raydium.decoder.cpmm.decimals_guaranteed_fallback', {
            poolId: poolId.slice(0, 8) + '…',
            mint: mintB?.slice(0, 8) + '…',
            side: 'B',
            decimals: decB,
            source: resultB.source,
            cat: 'pools'
          });
        }
      }
    } catch (resolveErr) {
      logger.warn('raydium.decoder.cpmm.decimals_resolve_error', {
        poolId: poolId.slice(0, 8) + '…',
        mintA: mintA?.slice(0, 8) + '…',
        mintB: mintB?.slice(0, 8) + '…',
        error: String((resolveErr as Error)?.message || resolveErr),
        cat: 'pools'
      });
      // Symmetric fallback - use 9 for both to avoid 1000000x price errors from mismatched decimals
      if (!Number.isFinite(decA)) {
        decA = 9;
        logger.warn('raydium.decoder.cpmm.decimals_fallback_used', {
          poolId: poolId.slice(0, 8) + '…',
          mint: mintA?.slice(0, 8) + '…',
          side: 'A',
          fallbackDecimals: 9,
          cat: 'pools'
        });
      }
      if (!Number.isFinite(decB)) {
        decB = 9;
        logger.warn('raydium.decoder.cpmm.decimals_fallback_used', {
          poolId: poolId.slice(0, 8) + '…',
          mint: mintB?.slice(0, 8) + '…',
          side: 'B',
          fallbackDecimals: 9,
          cat: 'pools'
        });
      }
    }
  }

  // For CPMM, we need vault balances to calculate price
  // Try to get from execution cache hot data (updated by vault subscriptions)
  let reserveA: bigint | undefined;
  let reserveB: bigint | undefined;
  const vaultA = decoded.account_a || (decoded as any).native_account_a;
  const vaultB = decoded.account_b || (decoded as any).native_account_b;

  try {
    const { vaultBalanceCache } = await import('../../../pools.cache.js');
    if (vaultA && vaultBalanceCache.has(vaultA)) {
      reserveA = vaultBalanceCache.get(vaultA);
    }
    if (vaultB && vaultBalanceCache.has(vaultB)) {
      reserveB = vaultBalanceCache.get(vaultB);
    }
  } catch {}

  // If vaults not in cache (e.g. program-mode where vault WS events don't arrive),
  // fetch via batched RPC
  if ((!reserveA || !reserveB) && vaultA && vaultB) {
    try {
      if (!reserveA) reserveA = await queueVaultFetch(vaultA);
      if (!reserveB) reserveB = await queueVaultFetch(vaultB);
    } catch {}
  }

  // Resolve fee from ammConfig if still at default 25 bps
  if ((decoded as any).amm_config && decoded.fee_bps === 25) {
    try {
      const resolvedFee = await resolveAmmConfigFee((decoded as any).amm_config);
      if (resolvedFee !== undefined) (decoded as any).fee_bps = resolvedFee;
    } catch {}
  }

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
    // Reserves in canonical order (matching mint_a/mint_b)
    reserve_a_raw: processedPrice?.wasSwapped ? reserveB?.toString() : reserveA?.toString(),
    reserve_b_raw: processedPrice?.wasSwapped ? reserveA?.toString() : reserveB?.toString(),
    // Native reserves preserved for reference
    native_reserve_a_raw: reserveA?.toString(),
    native_reserve_b_raw: reserveB?.toString(),
    // Amounts in canonical order
    amount_a_whole: processedPrice?.wasSwapped ? amountBWhole : amountAWhole,
    amount_b_whole: processedPrice?.wasSwapped ? amountAWhole : amountBWhole,
    _pipelineProcessed: true,
  };

  // Validate decoded pool
  const validation = validateDecodedPool('raydium-cpmm', item as any, poolId);
  if (!validation.valid) {
    wsDecodeStats.raydium_cpmm.failures += 1;
    incrementSkipReason('raydium_cpmm', `validation_failed:${validation.reasons.join(',')}`);
    return { success: false, error: `validation_failed:${validation.reasons.join(',')}`, skipped: true };
  }

  // Ensure orientation consistency with authoritative HTTP data
  const { pool: orientedItem, wasCorrected } = ensureOrientationConsistency(poolId, item);
  const finalItem = orientedItem as CpmmPool;
  if (wasCorrected) {
    logger.debug('raydium.cpmm.ws.orientation_corrected', {
      poolId: poolId.slice(0, 8) + '…',
      cat: 'pools'
    });
  }

  // Update cache
  const prev = cpmmCache.data || { cpmm: [] };
  const next = { cpmm: prev.cpmm.slice() };
  const idx = next.cpmm.findIndex(p => p.id === finalItem.id);

  // Validate price delta against previous value
  if (idx >= 0) {
    validatePriceDelta('raydium-cpmm' as any, poolId, finalItem.price_a_per_b, next.cpmm[idx].price_a_per_b);
  }

  if (idx >= 0) {
    const prevPool = next.cpmm[idx];
    const orientationChanged = prevPool.mint_a !== finalItem.mint_a || prevPool.mint_b !== finalItem.mint_b;
    if (orientationChanged) {
      logger.warn('ws.update.orientation_changed', {
        poolId: poolId.slice(0, 8) + '…',
        dex: 'Raydium',
        poolType: 'cpmm',
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
        // Preserve native reserves - they're in on-chain order, not affected by canonicalization
        native_reserve_a_raw: (prevPool as any).native_reserve_a_raw,
        native_reserve_b_raw: (prevPool as any).native_reserve_b_raw,
      };
      next.cpmm[idx] = { ...finalItem, ...orientationIndependentFields };
    } else {
      next.cpmm[idx] = { ...next.cpmm[idx], ...finalItem };
    }
  } else {
    next.cpmm.push(finalItem);
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
      mint_a: finalItem.mint_a,
      mint_b: finalItem.mint_b,
      decimals_a: finalItem.decimals_a,
      decimals_b: finalItem.decimals_b,
      native_mint_a: finalItem.native_mint_a,
      native_mint_b: finalItem.native_mint_b,
      native_decimals_a: finalItem.native_decimals_a,
      native_decimals_b: finalItem.native_decimals_b,
      vault_a: finalItem.account_a,
      vault_b: finalItem.account_b,
      native_account_a: finalItem.native_account_a,
      native_account_b: finalItem.native_account_b,
      amm_config: finalItem.amm_config,
      observation_key: finalItem.observation_key,
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
          // CRITICAL: If native decimals missing, derive from canonical + was_swapped
          const wasSwapped = (poolData as any)?.was_swapped === true;
          let decA: number | undefined = poolData.native_decimals_a ?? (wasSwapped ? poolData.decimals_b : poolData.decimals_a);
          let decB: number | undefined = poolData.native_decimals_b ?? (wasSwapped ? poolData.decimals_a : poolData.decimals_b);
          
          // CRITICAL FIX: Use guaranteed decimals resolution instead of ?? 9/6 fallback
          // This prevents 10x-1000x price errors from incorrect decimal assumptions
          if (!Number.isFinite(decA) || !Number.isFinite(decB)) {
            try {
              const { resolveDecimalsGuaranteed } = await import('../../decimals.js');
              const mintA = poolData.native_mint_a || (wasSwapped ? poolData.mint_b : poolData.mint_a);
              const mintB = poolData.native_mint_b || (wasSwapped ? poolData.mint_a : poolData.mint_b);
              
              if (!Number.isFinite(decA) && mintA) {
                const resultA = await resolveDecimalsGuaranteed(mintA, poolId, 'Raydium_CPMM');
                decA = resultA.decimals;
                if (resultA.source === 'default' && !resultA.validated) {
                  logger.warn('raydium.cpmm.vault.decimals_fallback', {
                    poolId: poolId.slice(0, 8) + '…',
                    mint: mintA?.slice(0, 8) + '…',
                    side: 'A',
                    decimals: decA,
                    source: resultA.source,
                    warning: 'Price may be 10x-1000x off if actual decimals differ',
                    cat: 'pools'
                  });
                }
              }
              if (!Number.isFinite(decB) && mintB) {
                const resultB = await resolveDecimalsGuaranteed(mintB, poolId, 'Raydium_CPMM');
                decB = resultB.decimals;
                if (resultB.source === 'default' && !resultB.validated) {
                  logger.warn('raydium.cpmm.vault.decimals_fallback', {
                    poolId: poolId.slice(0, 8) + '…',
                    mint: mintB?.slice(0, 8) + '…',
                    side: 'B',
                    decimals: decB,
                    source: resultB.source,
                    warning: 'Price may be 10x-1000x off if actual decimals differ',
                    cat: 'pools'
                  });
                }
              }
            } catch (resolveErr) {
              logger.warn('raydium.cpmm.vault.decimals_resolve_error', {
                poolId: poolId.slice(0, 8) + '…',
                error: String((resolveErr as Error)?.message || resolveErr),
                cat: 'pools'
              });
              // Last resort fallback to 9 (symmetric to avoid ratio errors)
              if (!Number.isFinite(decA)) decA = 9;
              if (!Number.isFinite(decB)) decB = 9;
            }
          }
          
          // CRITICAL FIX: When falling back to canonical mints, must also swap reserves
          // to maintain consistency. Reserves are ALWAYS in native order (from native_account_a/b),
          // so if native_mint_a is missing and we use canonical mint_a, reserves must be swapped.
          const hasNativeMints = !!(poolData.native_mint_a && poolData.native_mint_b);
          let mintA: string | undefined;
          let mintB: string | undefined;
          let reserveA = balanceA;
          let reserveB = balanceB;
          
          if (hasNativeMints) {
            // Native mints available - use them directly with native reserves
            mintA = poolData.native_mint_a;
            mintB = poolData.native_mint_b;
          } else if (poolData.mint_a && poolData.mint_b) {
            // Falling back to canonical mints - need to derive native order
            if (wasSwapped) {
              // Canonical A = Native B, Canonical B = Native A
              // To get native order: native A = canonical B, native B = canonical A
              mintA = poolData.mint_b;
              mintB = poolData.mint_a;
            } else {
              mintA = poolData.mint_a;
              mintB = poolData.mint_b;
            }
            
            logger.debug('raydium.cpmm.vault.derived_native_mints', {
              poolId: poolId.slice(0, 8) + '…',
              wasSwapped,
              mintA: mintA?.slice(0, 8) + '…',
              mintB: mintB?.slice(0, 8) + '…',
              cat: 'pools'
            });
          }
          
          if (mintA && mintB) {
            const processedPrice = processPriceThroughPipeline({
              mintA,
              mintB,
              decimalsA: decA,
              decimalsB: decB,
              poolId,
              dex: 'Raydium',
              poolType: 'cpmm',
              reserveA,
              reserveB,
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
                
                // Schedule graph update for vault balance changes
                wsDeltaStats.raydium_cpmm.applied += 1;
                await scheduleCpmmApply(prev);
                
                // Try to activate pool with new price data
                const hasValidPrice = processedPrice.priceForward > 0;
                tryActivatePool(poolId, 'raydium-cpmm' as any, hasValidPrice);
                
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
      const result = await handleCpmmVaultUpdate(info, poolId, derivedMeta.poolId);
      // Track successful activity for staleness monitoring (track the actual pool, not vault)
      if (result.success) {
        recordPoolActivity(derivedMeta.poolId, 'raydium-cpmm', poolId);
      }
      return result;
    }

    // Try to decode as CPMM pool
    const decoded = await decodeRaydiumCpmmPool(data, poolId, derivedAccountToPool);
    if (decoded) {
      const result = await handleCpmmUpdate(info, poolId, derivedAccountToPool, owner);
      // Track successful activity for staleness monitoring
      if (result.success) {
        recordPoolActivity(poolId, 'raydium-cpmm', poolId);
      }
      return result;
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
