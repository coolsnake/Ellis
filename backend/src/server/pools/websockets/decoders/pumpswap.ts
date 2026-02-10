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

import { logger } from "../../../../utils/logger.js";
import {
  logCatchError,
  logCatchDebug,
} from "../../../../utils/errorHandler.js";
import { anyToBigInt } from "../../precision.js";
import { processPriceThroughPipeline } from "../../pricePipeline.js";
import {
  diffNormalizedPools,
  parseTokenAccountAmount,
} from "../../../pools.utils.js";
import {
  pumpswapCache,
  vaultBalanceCache,
  findPoolInCache,
} from "../../../pools.cache.js";
import { emit } from "../../../realtime.js";
import {
  wsDecodeStats,
  wsDeltaStats,
  incrementSkipReason,
} from "../../../pools.metrics.js";
import { validateDecodedPool, validatePriceDelta } from "../validation.js";
import { CONFIG } from "../../../../utils/config.js";
// Import pool activation tracking for lazy activation mode
import { tryActivatePool } from "../../../pools.activation.js";
// Import per-pool staleness tracking
import { recordPoolActivity } from "../staleness.js";
// Import PumpSwap SDK for reliable buffer decoding via Anchor IDL
import { PUMP_AMM_SDK } from "@pump-fun/pump-swap-sdk";
import { computePumpswapPoolFees } from "../../pumpswapFees.js";
import { PublicKey } from "@solana/web3.js";
// Decimal imports are now dynamic via tryResolveDecimalsPairCached (non-blocking)
import type {
  DecodedPool,
  UpdateResult,
  AccountInfo,
  ProcessedPriceResult,
  DerivedAccountInfo,
} from "./types.js";
import type { AmmPool, PoolsPayload } from "../../types.js";

// Program IDs - PumpSwap has two programs:
// 1. Bonding curve (original pump.fun) - 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P
// 2. Post-graduation AMM - pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA
export const PUMPSWAP_BONDING_CURVE_PROGRAM_ID =
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const PUMPSWAP_AMM_PROGRAM_ID =
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
// Keep legacy export for backward compatibility
export const PUMPSWAP_PROGRAM_ID = PUMPSWAP_AMM_PROGRAM_ID;

// PumpSwap total fee: 20 bps LP fee + 5 bps protocol fee = 25 bps total
const DEFAULT_FEE_BPS = 25;

// Minimum buffer length for basic validation before SDK decode
const MIN_POOL_BUFFER_LENGTH = 50;

// Anchor discriminator for PumpSwap Pool accounts: sha256("account:Pool")[0..8]
// Non-pool accounts (global config, fee config) have different discriminators.
const PUMPSWAP_POOL_DISCRIMINATOR = Buffer.from([
  241, 154, 109, 4, 17, 177, 109, 188,
]);

// Pool account layout offsets for protocol_fee_recipient extraction
// Layout: [discriminator(8), pool_bump(1), index(2), creator(32), base_mint(32),
//   quote_mint(32), lp_mint(32), pool_base_token_account(32), pool_quote_token_account(32),
//   lp_supply(8), coin_creator(32), protocol_fee_recipient(32), ...]
const OFFSET_PROTOCOL_FEE_RECIPIENT = 243;
const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";

/**
 * Extract protocol_fee_recipient from raw pool account buffer at offset 243.
 * Returns null if buffer too short or value is System Program (not configured).
 */
function extractProtocolFeeRecipient(data: Buffer): string | null {
  if (data.length < OFFSET_PROTOCOL_FEE_RECIPIENT + 32) return null;
  try {
    const bytes = data.subarray(
      OFFSET_PROTOCOL_FEE_RECIPIENT,
      OFFSET_PROTOCOL_FEE_RECIPIENT + 32
    );
    const pubkey = new PublicKey(bytes).toBase58();
    if (pubkey === SYSTEM_PROGRAM_ID) return null; // Not configured
    return pubkey;
  } catch {
    return null;
  }
}

/**
 * Decoded pumpswap pool state from account data
 */
interface PumpswapPoolState {
  baseMint: string;
  quoteMint: string;
  vaultA: string;
  vaultB: string;
  lpSupply?: bigint;
  coinCreator?: string;
}

/**
 * Decode pumpswap pool state from account data buffer using SDK
 *
 * Uses the PumpSwap SDK's Anchor-based decoder for reliable decoding.
 * This is more robust than manual buffer parsing as it uses the official IDL.
 */
export function decodePumpswapPoolState(
  data: Buffer
): PumpswapPoolState | null {
  try {
    if (!data || data.length < MIN_POOL_BUFFER_LENGTH) {
      return null;
    }

    // Check discriminator before attempting SDK decode.
    // In program-subscription mode ALL accounts owned by PumpSwap arrive;
    // non-pool accounts (global config, fee config) have different discriminators.
    if (
      data.length >= 8 &&
      Buffer.compare(data.subarray(0, 8), PUMPSWAP_POOL_DISCRIMINATOR) !== 0
    ) {
      return null;
    }

    // Use SDK's Anchor-based decoder - NO RPC calls required
    // The SDK uses an offline program coder that decodes directly from buffer
    const decoded = PUMP_AMM_SDK.decodePoolNullable({
      data,
      owner: new PublicKey(PUMPSWAP_AMM_PROGRAM_ID),
      executable: false,
      lamports: 0,
    });

    if (!decoded) {
      return null;
    }

    // Filter non-pool accounts that have zero-pubkey mint fields
    const _baseMint = decoded.baseMint?.toBase58?.() || "";
    const _quoteMint = decoded.quoteMint?.toBase58?.() || "";
    const _SYS = "11111111111111111111111111111111";
    if (
      !_baseMint ||
      !_quoteMint ||
      _baseMint === _SYS ||
      _quoteMint === _SYS ||
      _baseMint === _quoteMint
    ) {
      return null;
    }

    return {
      baseMint: _baseMint,
      quoteMint: _quoteMint,
      vaultA: decoded.poolBaseTokenAccount.toBase58(),
      vaultB: decoded.poolQuoteTokenAccount.toBase58(),
      lpSupply: decoded.lpSupply
        ? BigInt(decoded.lpSupply.toString())
        : undefined,
      coinCreator: decoded.coinCreator?.toBase58(),
    };
  } catch (e) {
    logCatchDebug("pumpswap.decodePoolState", e);
    return null;
  }
}

// Debounce state for graph updates
let pumpswapApplyState: {
  baseline: PoolsPayload | null;
  timer: NodeJS.Timeout | null;
} = { baseline: null, timer: null };
const DEBOUNCE_MS = 50;

/**
 * Schedule debounced graph update for Pumpswap
 */
async function scheduleDexApply(
  source: "pumpswap",
  baseline: PoolsPayload
): Promise<void> {
  try {
    if (!pumpswapApplyState.baseline) {
      pumpswapApplyState.baseline = baseline;
    }
    if (pumpswapApplyState.timer) {
      clearTimeout(pumpswapApplyState.timer);
    }
    pumpswapApplyState.timer = setTimeout(async () => {
      try {
        const gmod: any = await import("../../../graph.js");
        const current = pumpswapCache.data;
        if (current && pumpswapApplyState.baseline) {
          // Use applyPoolUpdates for incremental graph updates
          if (typeof gmod?.applyPoolUpdates === "function") {
            await gmod.applyPoolUpdates(pumpswapApplyState.baseline, current, {
              pushToArb: false,
            });
          }
        }
      } catch (e) {
        logCatchDebug("pumpswap.scheduleDexApply", e);
      } finally {
        pumpswapApplyState.baseline = null;
        pumpswapApplyState.timer = null;
      }
    }, DEBOUNCE_MS);
  } catch (e) {
    logCatchDebug("pumpswap.scheduleDexApply.setup", e);
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

    // CRITICAL: Use on-chain base/quote (native) ordering for PumpSwap.
    // Do NOT derive native mints from canonical order here; that can invert base/quote.
    const wasSwapped = (existingPool as any).was_swapped === true;

    // Get mints - prefer native/on-chain, skip if missing
    let mintA: string | undefined;
    let mintB: string | undefined;

    if (existingPool.native_mint_a && existingPool.native_mint_a.length > 10) {
      mintA = existingPool.native_mint_a;
      mintB = existingPool.native_mint_b;
    } else if (
      (existingPool as any).onchain_base_mint &&
      (existingPool as any).onchain_quote_mint
    ) {
      mintA = (existingPool as any).onchain_base_mint;
      mintB = (existingPool as any).onchain_quote_mint;
    }

    if (!mintA || !mintB) {
      logger.debug("pumpswap.decode.missing_mints", {
        poolId: existingPool.id,
        cat: "pools",
      });
      return null;
    }

    // Get decimals - prefer native, derive from canonical if needed
    let decA: number | undefined;
    let decB: number | undefined;

    if (Number.isFinite(existingPool.native_decimals_a)) {
      decA = existingPool.native_decimals_a;
      decB = existingPool.native_decimals_b;
    } else if (Number.isFinite(existingPool.decimals_a)) {
      // Fallback to canonical decimals only if native decimals are missing
      // (Decimals are per-mint; this does not affect base/quote ordering.)
      if (wasSwapped) {
        decA = existingPool.decimals_b;
        decB = existingPool.decimals_a;
      } else {
        decA = existingPool.decimals_a;
        decB = existingPool.decimals_b;
      }

      logger.debug("pumpswap.decoder.derived_native_decimals", {
        poolId: existingPool.id?.slice(0, 8) + "…",
        wasSwapped,
        decA,
        decB,
        cat: "pools",
      });
    }

    if (!Number.isFinite(decA)) {
      logger.warn("pumpswap.decoder.decimals_fallback", {
        poolId: existingPool.id?.slice(0, 8) + "…",
        mint: mintA?.slice(0, 8) + "…",
        side: "A",
        fallbackValue: 9,
        reason: "cache_missing_decimals",
        cat: "pools",
      });
      decA = 9;
    }
    if (!Number.isFinite(decB)) {
      logger.warn("pumpswap.decoder.decimals_fallback", {
        poolId: existingPool.id?.slice(0, 8) + "…",
        mint: mintB?.slice(0, 8) + "…",
        side: "B",
        fallbackValue: 6,
        reason: "cache_missing_decimals",
        cat: "pools",
      });
      decB = 6;
    }

    // Calculate reserves from vault balances
    let reserveA = vaultABalance;
    let reserveB = vaultBBalance;

    // Fall back to cached raw reserves if vault balances not available
    // CRITICAL: Use native reserves, do NOT derive from canonical order for PumpSwap
    if (reserveA === null) {
      if (existingPool.native_reserve_a_raw) {
        reserveA = anyToBigInt(existingPool.native_reserve_a_raw);
      }
    }
    if (reserveB === null) {
      if (existingPool.native_reserve_b_raw) {
        reserveB = anyToBigInt(existingPool.native_reserve_b_raw);
      }
    }

    if (reserveA === null || reserveB === null) {
      logger.debug("pumpswap.decode.missing_reserves", {
        poolId: existingPool.id,
        hasA: reserveA !== null,
        hasB: reserveB !== null,
        cat: "pools",
      });
      return null;
    }

    // Compute per-pool fees from cached GlobalConfig/FeeConfig
    const poolFeesData = {
      native_mint_a: mintA,
      onchain_base_mint: mintA,
      creator: (existingPool as any).creator,
      coinCreator: (existingPool as any).creator,
      native_reserve_a_raw: reserveA.toString(),
      native_reserve_b_raw: reserveB.toString(),
    };
    const poolFees = computePumpswapPoolFees(poolFeesData);

    return {
      id: existingPool.id,
      dex: "Pumpswap",
      mint_a: mintA,
      mint_b: mintB,
      fee_bps: poolFees.totalFeeBps,
      fee_lp_bps: poolFees.lpFeeBps,
      fee_protocol_bps: poolFees.protocolFeeBps,
      fee_creator_bps: poolFees.creatorFeeBps,
      price_a_per_b: 0, // Will be calculated through pipeline
      liquidity_base: 0, // Will be calculated
      updated_ms: Date.now(),
      pool_kind: "amm",
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
      onchain_base_mint: mintA,
      onchain_quote_mint: mintB,
      onchain_base_vault: existingPool.native_account_a,
      onchain_quote_vault: existingPool.native_account_b,
    } as any;
  } catch (e) {
    logCatchDebug("pumpswap.decode", e);
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
    const data = Buffer.isBuffer(info.data)
      ? info.data
      : Buffer.from(info.data ?? []);

    if (!data || data.length < MIN_POOL_BUFFER_LENGTH) {
      logger.debug("pumpswap.pool_update.data_too_short", {
        pool: poolId.slice(0, 8) + "…",
        len: data?.length || 0,
        cat: "pools",
      });
      wsDeltaStats.pumpswap.skipped += 1;
      incrementSkipReason("pumpswap", "data_too_short");
      return { success: false, error: "data_too_short", skipped: true };
    }

    // Decode pool state to get vault addresses
    const poolState = decodePumpswapPoolState(data);
    if (!poolState) {
      logger.debug("pumpswap.pool_update.decode_failed", {
        pool: poolId.slice(0, 8) + "…",
        cat: "pools",
      });
      wsDeltaStats.pumpswap.skipped += 1;
      incrementSkipReason("pumpswap", "pool_state_decode_failed");
      return { success: false, error: "pool_decode_failed", skipped: true };
    }

    // Extract protocol_fee_recipient from raw buffer (needed for execution cache)
    const protocolFeeRecipient = extractProtocolFeeRecipient(data);

    // Find existing pool in cache to get metadata (decimals, fee, etc.)
    const poolData = findPoolInCache(poolId);
    let existingPool: AmmPool | null =
      poolData?.source === "pumpswap" ? (poolData.pool as AmmPool) : null;
    const { vaultA, vaultB, baseMint, quoteMint } = poolState;

    // Gap 1: Create new pool entry from raw account data when not in cache.
    // In wss-program mode, program-level subscriptions deliver updates for all pools,
    // including ones not yet in cache. We create a minimal entry so vault updates can find it.
    if (!existingPool) {
      // Non-blocking decimal resolution: check cache, queue background RPC for misses
      const { tryResolveDecimalsPairCached } = await import(
        "../../decimals.js"
      );
      const cachedDec = tryResolveDecimalsPairCached(
        baseMint,
        quoteMint,
        poolId,
        "Pumpswap"
      );

      // Skip new pool creation until decimals are available
      if (cachedDec.decA === null || cachedDec.decB === null) {
        incrementSkipReason("pumpswap", "decimals_pending");
        return {
          success: false,
          error: "decimals_pending",
          skipped: true,
          skipReason: "decimals_pending",
        };
      }
      const decANew = cachedDec.decA;
      const decBNew = cachedDec.decB;

      // Build a synthetic existingPool so the rest of the handler can proceed uniformly
      existingPool = {
        id: poolId,
        dex: "Pumpswap",
        mint_a: baseMint,
        mint_b: quoteMint,
        fee_bps: DEFAULT_FEE_BPS,
        price_a_per_b: 0,
        liquidity_base: 0,
        updated_ms: Date.now(),
        pool_kind: "amm",
        native_mint_a: baseMint,
        native_mint_b: quoteMint,
        native_decimals_a: decANew,
        native_decimals_b: decBNew,
        decimals_a: decANew,
        decimals_b: decBNew,
        native_account_a: vaultA,
        native_account_b: vaultB,
        creator: poolState.coinCreator,
      } as AmmPool;

      logger.info("pumpswap.pool_update.new_pool_created", {
        pool: poolId.slice(0, 8) + "…",
        baseMint: baseMint.slice(0, 8) + "…",
        quoteMint: quoteMint.slice(0, 8) + "…",
        vaultA: vaultA.slice(0, 8) + "…",
        vaultB: vaultB.slice(0, 8) + "…",
        decA: decANew,
        decB: decBNew,
        coinCreator: poolState.coinCreator?.slice(0, 8),
        hasProtocolFeeRecipient: !!protocolFeeRecipient,
        cat: "pools",
      });
    }

    // Get both vault balances from cache
    let balanceA = vaultBalanceCache.get(vaultA) ?? null;
    let balanceB = vaultBalanceCache.get(vaultB) ?? null;

    // Vault accounts are owned by Token Program, not PumpSwap program,
    // so they won't arrive via program subscription. Fetch via batched RPC.
    if (balanceA === null || balanceB === null) {
      try {
        const { queueVaultFetch } = await import("./raydiumCpmm.js");
        if (balanceA === null) {
          const fetched = await queueVaultFetch(vaultA);
          if (fetched !== undefined) {
            vaultBalanceCache.set(vaultA, fetched);
            balanceA = fetched;
          }
        }
        if (balanceB === null) {
          const fetched = await queueVaultFetch(vaultB);
          if (fetched !== undefined) {
            vaultBalanceCache.set(vaultB, fetched);
            balanceB = fetched;
          }
        }
      } catch {}
    }

    if (balanceA === null || balanceB === null) {
      // Vault balances not yet available — store the pool entry in cache so vault updates
      // and subsequent pool account updates can find it via findPoolInCache
      const prevAwait = pumpswapCache.data || { amm: [], clmm: [], cpmm: [] };
      const existingIdx = prevAwait.amm.findIndex((p) => p.id === poolId);
      if (existingIdx < 0) {
        const nextAwait: PoolsPayload = {
          amm: [...prevAwait.amm, existingPool],
          clmm: prevAwait.clmm.slice(),
          cpmm: prevAwait.cpmm?.slice() || [],
        };
        pumpswapCache.data = nextAwait;
        pumpswapCache.ts = Date.now();
      }

      logger.debug("pumpswap.pool_update.awaiting_vaults", {
        pool: poolId.slice(0, 8) + "…",
        hasA: balanceA !== null,
        hasB: balanceB !== null,
        vaultA: vaultA.slice(0, 8) + "…",
        vaultB: vaultB.slice(0, 8) + "…",
        poolStoredInCache: existingIdx < 0,
        cat: "pools",
      });
      // Don't activate - no valid pricing yet. Pool sits in cache for future updates.
      wsDeltaStats.pumpswap.skipped += 1;
      incrementSkipReason("pumpswap", "awaiting_vault_balances");
      return {
        success: true,
        skipped: true,
        skipReason: "awaiting_vault_balances",
      };
    }

    // Use existing pool metadata with decoded vault info
    const poolWithVaults: AmmPool = {
      ...existingPool,
      native_account_a: vaultA,
      native_account_b: vaultB,
      native_mint_a: baseMint,
      native_mint_b: quoteMint,
      onchain_base_mint: baseMint,
      onchain_quote_mint: quoteMint,
      onchain_base_vault: vaultA,
      onchain_quote_vault: vaultB,
    };

    // Decode the pool with vault balances
    const decoded = decodePumpswapPool(poolWithVaults, balanceA, balanceB);
    if (!decoded) {
      wsDeltaStats.pumpswap.skipped += 1;
      incrementSkipReason("pumpswap", "pool_decode_with_vaults_failed");
      return { success: false, error: "decode_failed", skipped: true };
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
      logger.warn("pumpswap.decoder.decimals_fallback", {
        poolId: poolId?.slice(0, 8) + "…",
        mint: mintA?.slice(0, 8) + "…",
        side: "A",
        fallbackValue: 9,
        reason: "decoded_pool_missing_decimals",
        cat: "pools",
      });
      decA = 9;
    }
    if (!Number.isFinite(decB)) {
      logger.warn("pumpswap.decoder.decimals_fallback", {
        poolId: poolId?.slice(0, 8) + "…",
        mint: mintB?.slice(0, 8) + "…",
        side: "B",
        fallbackValue: 6,
        reason: "decoded_pool_missing_decimals",
        cat: "pools",
      });
      decB = 6;
    }

    // Validate decimals against known tokens
    try {
      const { validateDecimalsForMint } = await import("../../decimals.js");
      if (mintA) validateDecimalsForMint(mintA, decA, poolId, "Pumpswap");
      if (mintB) validateDecimalsForMint(mintB, decB, poolId, "Pumpswap");
    } catch {}

    const processedPrice = processPriceThroughPipeline({
      mintA,
      mintB,
      decimalsA: decA,
      decimalsB: decB,
      poolId,
      dex: "Pumpswap",
      poolType: "amm",
      reserveA,
      reserveB,
    });

    if (!processedPrice) {
      wsDeltaStats.pumpswap.skipped += 1;
      incrementSkipReason("pumpswap", "price_calc_failed");
      return { success: false, error: "price_calc_failed", skipped: true };
    }

    // Calculate liquidity
    const wholeA = reserveA ? Number(reserveA) / Math.pow(10, decA) : 0;
    const wholeB = reserveB ? Number(reserveB) / Math.pow(10, decB) : 0;
    const liquidityBase = Math.min(wholeA, wholeB);

    // Compute per-pool fees from cached GlobalConfig/FeeConfig
    const updatedFees = computePumpswapPoolFees({
      native_mint_a: mintA,
      onchain_base_mint: mintA,
      creator: (existingPool as any).creator,
      coinCreator: (existingPool as any).creator,
      native_reserve_a_raw: reserveA?.toString(),
      native_reserve_b_raw: reserveB?.toString(),
    });

    // Build the updated pool item
    const item: AmmPool = {
      id: poolId,
      dex: "Pumpswap",
      mint_a: processedPrice.mintA,
      mint_b: processedPrice.mintB,
      fee_bps: updatedFees.totalFeeBps,
      fee_lp_bps: updatedFees.lpFeeBps,
      fee_protocol_bps: updatedFees.protocolFeeBps,
      fee_creator_bps: updatedFees.creatorFeeBps,
      price_a_per_b: processedPrice.priceForward,
      liquidity_base: liquidityBase,
      updated_ms: Date.now(),
      pool_kind: "amm",
      liquidity_display: liquidityBase,
      decimals_a: processedPrice.decimalsA,
      decimals_b: processedPrice.decimalsB,
      reserve_a_raw: processedPrice.wasSwapped
        ? reserveB?.toString()
        : reserveA?.toString(),
      reserve_b_raw: processedPrice.wasSwapped
        ? reserveA?.toString()
        : reserveB?.toString(),
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
    const validation = validateDecodedPool("pumpswap", item, poolId);
    if (!validation.valid) {
      wsDecodeStats.pumpswap.failures += 1;
      incrementSkipReason(
        "pumpswap",
        `validation_failed:${validation.reasons.join(",")}`
      );
      return {
        success: false,
        error: `validation_failed:${validation.reasons.join(",")}`,
        skipped: true,
      };
    }

    // Update cache
    const prev = pumpswapCache.data || { amm: [], clmm: [], cpmm: [] };
    const next: PoolsPayload = {
      amm: prev.amm.slice(),
      clmm: prev.clmm.slice(),
      cpmm: prev.cpmm?.slice() || [],
    };
    const idx = next.amm.findIndex((p) => p.id === item.id);

    // Validate price delta against previous value
    // CRITICAL: Check was_swapped to handle orientation differences between HTTP and WS updates
    if (idx >= 0) {
      const prevPool = next.amm[idx];
      const prevWasSwapped = (prevPool as any).was_swapped ?? false;
      const newWasSwapped = processedPrice.wasSwapped ?? false;

      // Only validate price delta if orientations match
      if (prevWasSwapped === newWasSwapped) {
        validatePriceDelta(
          "pumpswap",
          poolId,
          item.price_a_per_b,
          prevPool.price_a_per_b
        );
      } else {
        // Orientation changed - compare with inverted previous price to avoid false alarms
        const adjustedPrevPrice =
          prevPool.price_a_per_b && prevPool.price_a_per_b > 0
            ? 1 / prevPool.price_a_per_b
            : undefined;
        validatePriceDelta(
          "pumpswap",
          poolId,
          item.price_a_per_b,
          adjustedPrevPrice
        );

        logger.debug("pumpswap.pool.ws.orientation_flip", {
          poolId: poolId.slice(0, 8) + "…",
          prevWasSwapped,
          newWasSwapped,
          prevPrice: prevPool.price_a_per_b,
          newPrice: item.price_a_per_b,
          adjustedPrevPrice,
          cat: "pools",
        });
      }
    }

    if (idx >= 0) {
      const prevPool = next.amm[idx];
      const orientationChanged =
        prevPool.mint_a !== item.mint_a || prevPool.mint_b !== item.mint_b;
      if (orientationChanged) {
        logger.warn("ws.update.orientation_changed", {
          poolId: poolId.slice(0, 8) + "…",
          dex: "Pumpswap",
          prevMintA: prevPool.mint_a?.slice(0, 8),
          prevMintB: prevPool.mint_b?.slice(0, 8),
          newMintA: item.mint_a?.slice(0, 8),
          newMintB: item.mint_b?.slice(0, 8),
          cat: "pools",
        });

        const orientationIndependentFields = {
          tvl_usd: prevPool.tvl_usd,
          liquidity_display: prevPool.liquidity_display,
          pool_liquidity_raw: prevPool.pool_liquidity_raw,
          // Preserve native reserves - they're in on-chain order, not affected by canonicalization
          native_reserve_a_raw: (prevPool as any).native_reserve_a_raw,
          native_reserve_b_raw: (prevPool as any).native_reserve_b_raw,
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

    const hasDelta =
      delta.amm.length ||
      delta.clmm.length ||
      delta.addedAmm ||
      delta.removedAmm ||
      delta.addedClmm ||
      delta.removedClmm;
    if (hasDelta) {
      wsDeltaStats.pumpswap.applied += 1;
    } else {
      wsDeltaStats.pumpswap.skipped += 1;
      incrementSkipReason("pumpswap", "no_delta");
    }

    // Emit update event
    try {
      emit("pool-updates", {
        source: "pumpswap",
        updatedAmm: delta.amm.length,
        updatedClmm: 0,
        sample: { amm: delta.amm.slice(0, 20), clmm: [] },
        ts: Date.now(),
      });
    } catch {}

    // Schedule graph update
    if (hasDelta) {
      await scheduleDexApply("pumpswap", prev);
    }

    // Gap 2: Write to execution cache for SDK quote cache hits
    try {
      const { executionCache } = await import("../../../../execution/cache.js");
      const existingStatic = executionCache.getStatic(poolId) || {};
      executionCache.setStatic(poolId, {
        ...existingStatic,
        dex: "Pumpswap",
        pool_kind: "amm",
        programId: PUMPSWAP_AMM_PROGRAM_ID,
        mint_a: item.mint_a,
        mint_b: item.mint_b,
        decimals_a: item.decimals_a,
        decimals_b: item.decimals_b,
        native_mint_a: mintA,
        native_mint_b: mintB,
        native_decimals_a: decA,
        native_decimals_b: decB,
        native_account_a: vaultA,
        native_account_b: vaultB,
        was_swapped: processedPrice.wasSwapped,
        // Critical for SDK quote cache hit (tryGetCachedPumpswapAccounts checks this field)
        protocol_fee_recipient:
          protocolFeeRecipient ||
          (existingStatic as any)?.protocol_fee_recipient,
      });
    } catch {}

    logger.debug("pumpswap.pool_update.success", {
      pool: poolId.slice(0, 8) + "…",
      price: item.price_a_per_b,
      hasDelta,
      cat: "pools",
    });

    // Try to activate pool for lazy activation mode (only activates on first valid price update)
    const hasValidPrice = !!(
      processedPrice?.priceForward &&
      Number.isFinite(processedPrice.priceForward) &&
      processedPrice.priceForward > 0
    );
    tryActivatePool(poolId, "pumpswap", hasValidPrice);

    // Track successful activity for staleness monitoring
    recordPoolActivity(poolId, "pumpswap", poolId);

    return { success: true, pool: item as DecodedPool, delta };
  } catch (e) {
    wsDecodeStats.pumpswap.failures += 1;
    logCatchError("pumpswap.handlePoolAccountUpdate", e, {
      pool: poolId.slice(0, 8) + "…",
    });
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
    const data = Buffer.isBuffer(info.data)
      ? info.data
      : Buffer.from(info.data ?? []);
    const newBalance = parseTokenAccountAmount(data);

    if (newBalance === null) {
      logger.debug("pumpswap.vault.parse.fail", {
        vault: vaultAddress.slice(0, 8) + "…",
        cat: "pools",
      });
      return { success: false, error: "parse_failed", skipped: true };
    }

    // Cache the vault balance
    vaultBalanceCache.set(vaultAddress, newBalance);

    logger.debug("pumpswap.vault.balance_cached", {
      vault: vaultAddress.slice(0, 8) + "…",
      balance: newBalance.toString(),
      poolId: poolId.slice(0, 8) + "…",
      cat: "pools",
    });

    // Find the pool in cache
    const poolData = findPoolInCache(poolId);
    if (!poolData || poolData.source !== "pumpswap") {
      logger.debug("pumpswap.vault.pool.not_found", {
        vault: vaultAddress.slice(0, 8) + "…",
        pool: poolId.slice(0, 8) + "…",
        cat: "pools",
      });
      return { success: true, skipped: true, skipReason: "pool_not_in_cache" };
    }

    const existingPool = poolData.pool as AmmPool;

    // Get vault addresses from the pool
    // CRITICAL: Must use on-chain base/quote vaults (native order) for PumpSwap.
    // Do NOT derive from canonical order, which can invert base/quote.
    let vaultA: string | undefined;
    let vaultB: string | undefined;

    // Prefer native/on-chain vault addresses if available (non-empty)
    if (
      existingPool.native_account_a &&
      existingPool.native_account_a.length > 10
    ) {
      vaultA = existingPool.native_account_a;
      vaultB = existingPool.native_account_b;
    } else if (
      (existingPool as any).onchain_base_vault &&
      (existingPool as any).onchain_quote_vault
    ) {
      vaultA = (existingPool as any).onchain_base_vault;
      vaultB = (existingPool as any).onchain_quote_vault;
    }

    if (!vaultA || !vaultB) {
      logger.debug("pumpswap.vault.pool.missing_vaults", {
        pool: poolId.slice(0, 8) + "…",
        cat: "pools",
      });
      return {
        success: true,
        skipped: true,
        skipReason: "pool_missing_vaults",
      };
    }

    // Get both vault balances from cache
    const balanceA = vaultBalanceCache.get(vaultA) ?? null;
    const balanceB = vaultBalanceCache.get(vaultB) ?? null;

    if (balanceA === null || balanceB === null) {
      logger.debug("pumpswap.vault.awaiting_both", {
        pool: poolId.slice(0, 8) + "…",
        hasA: balanceA !== null,
        hasB: balanceB !== null,
        cat: "pools",
      });
      return {
        success: true,
        skipped: true,
        skipReason: "awaiting_both_vaults",
      };
    }

    // Decode the pool with updated balances
    const decoded = decodePumpswapPool(existingPool, balanceA, balanceB);
    if (!decoded) {
      return { success: false, error: "decode_failed", skipped: true };
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
      logger.warn("pumpswap.decoder.decimals_fallback", {
        poolId: poolId?.slice(0, 8) + "…",
        mint: mintA?.slice(0, 8) + "…",
        side: "A",
        fallbackValue: 9,
        reason: "vault_update_missing_decimals",
        cat: "pools",
      });
      decA = 9;
    }
    if (!Number.isFinite(decB)) {
      logger.warn("pumpswap.decoder.decimals_fallback", {
        poolId: poolId?.slice(0, 8) + "…",
        mint: mintB?.slice(0, 8) + "…",
        side: "B",
        fallbackValue: 6,
        reason: "vault_update_missing_decimals",
        cat: "pools",
      });
      decB = 6;
    }

    // Validate decimals against known tokens
    try {
      const { validateDecimalsForMint } = await import("../../decimals.js");
      if (mintA) validateDecimalsForMint(mintA, decA, poolId, "Pumpswap");
      if (mintB) validateDecimalsForMint(mintB, decB, poolId, "Pumpswap");
    } catch {}

    const processedPrice = processPriceThroughPipeline({
      mintA,
      mintB,
      decimalsA: decA,
      decimalsB: decB,
      poolId,
      dex: "Pumpswap",
      poolType: "amm",
      reserveA,
      reserveB,
    });

    if (!processedPrice) {
      wsDeltaStats.pumpswap.skipped += 1;
      incrementSkipReason("pumpswap", "price_calc_failed");
      return { success: false, error: "price_calc_failed", skipped: true };
    }

    // Calculate liquidity
    const wholeA = reserveA ? Number(reserveA) / Math.pow(10, decA) : 0;
    const wholeB = reserveB ? Number(reserveB) / Math.pow(10, decB) : 0;
    const liquidityBase = Math.min(wholeA, wholeB);

    // Compute per-pool fees from cached GlobalConfig/FeeConfig
    const updatedFees = computePumpswapPoolFees({
      native_mint_a: mintA,
      onchain_base_mint: mintA,
      creator: (existingPool as any).creator,
      coinCreator: (existingPool as any).creator,
      native_reserve_a_raw: reserveA?.toString(),
      native_reserve_b_raw: reserveB?.toString(),
    });

    // Build the updated pool item
    const item: AmmPool = {
      id: poolId,
      dex: "Pumpswap",
      mint_a: processedPrice.mintA,
      mint_b: processedPrice.mintB,
      fee_bps: updatedFees.totalFeeBps,
      fee_lp_bps: updatedFees.lpFeeBps,
      fee_protocol_bps: updatedFees.protocolFeeBps,
      fee_creator_bps: updatedFees.creatorFeeBps,
      price_a_per_b: processedPrice.priceForward,
      liquidity_base: liquidityBase,
      updated_ms: Date.now(),
      pool_kind: "amm",
      liquidity_display: liquidityBase,
      decimals_a: processedPrice.decimalsA,
      decimals_b: processedPrice.decimalsB,
      reserve_a_raw: processedPrice.wasSwapped
        ? reserveB?.toString()
        : reserveA?.toString(),
      reserve_b_raw: processedPrice.wasSwapped
        ? reserveA?.toString()
        : reserveB?.toString(),
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
    const validation = validateDecodedPool("pumpswap", item, poolId);
    if (!validation.valid) {
      wsDecodeStats.pumpswap.failures += 1;
      incrementSkipReason(
        "pumpswap",
        `validation_failed:${validation.reasons.join(",")}`
      );
      return {
        success: false,
        error: `validation_failed:${validation.reasons.join(",")}`,
        skipped: true,
      };
    }

    // Update cache
    const prev = pumpswapCache.data || { amm: [], clmm: [], cpmm: [] };
    const next: PoolsPayload = {
      amm: prev.amm.slice(),
      clmm: prev.clmm.slice(),
      cpmm: prev.cpmm?.slice() || [],
    };
    const idx = next.amm.findIndex((p) => p.id === item.id);

    // Validate price delta against previous value
    // CRITICAL: Check was_swapped to handle orientation differences between HTTP and WS updates
    if (idx >= 0) {
      const prevPool = next.amm[idx];
      const prevWasSwapped = (prevPool as any).was_swapped ?? false;
      const newWasSwapped = processedPrice.wasSwapped ?? false;

      // Only validate price delta if orientations match
      if (prevWasSwapped === newWasSwapped) {
        validatePriceDelta(
          "pumpswap",
          poolId,
          item.price_a_per_b,
          prevPool.price_a_per_b
        );
      } else {
        // Orientation changed - compare with inverted previous price to avoid false alarms
        const adjustedPrevPrice =
          prevPool.price_a_per_b && prevPool.price_a_per_b > 0
            ? 1 / prevPool.price_a_per_b
            : undefined;
        validatePriceDelta(
          "pumpswap",
          poolId,
          item.price_a_per_b,
          adjustedPrevPrice
        );

        logger.debug("pumpswap.vault.ws.orientation_flip", {
          poolId: poolId.slice(0, 8) + "…",
          prevWasSwapped,
          newWasSwapped,
          prevPrice: prevPool.price_a_per_b,
          newPrice: item.price_a_per_b,
          adjustedPrevPrice,
          cat: "pools",
        });
      }
    }

    if (idx >= 0) {
      const prevPool = next.amm[idx];
      const orientationChanged =
        prevPool.mint_a !== item.mint_a || prevPool.mint_b !== item.mint_b;
      if (orientationChanged) {
        logger.warn("ws.update.orientation_changed", {
          poolId: poolId.slice(0, 8) + "…",
          dex: "Pumpswap",
          prevMintA: prevPool.mint_a?.slice(0, 8),
          prevMintB: prevPool.mint_b?.slice(0, 8),
          newMintA: item.mint_a?.slice(0, 8),
          newMintB: item.mint_b?.slice(0, 8),
          cat: "pools",
        });

        const orientationIndependentFields = {
          tvl_usd: prevPool.tvl_usd,
          liquidity_display: prevPool.liquidity_display,
          pool_liquidity_raw: prevPool.pool_liquidity_raw,
          // Preserve native reserves - they're in on-chain order, not affected by canonicalization
          native_reserve_a_raw: (prevPool as any).native_reserve_a_raw,
          native_reserve_b_raw: (prevPool as any).native_reserve_b_raw,
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

    const hasDelta =
      delta.amm.length ||
      delta.clmm.length ||
      delta.addedAmm ||
      delta.removedAmm ||
      delta.addedClmm ||
      delta.removedClmm;
    if (hasDelta) {
      wsDeltaStats.pumpswap.applied += 1;
    } else {
      wsDeltaStats.pumpswap.skipped += 1;
      incrementSkipReason("pumpswap", "no_delta");
    }

    // Emit update event
    try {
      emit("pool-updates", {
        source: "pumpswap",
        updatedAmm: delta.amm.length,
        updatedClmm: 0,
        sample: { amm: delta.amm.slice(0, 20), clmm: [] },
        ts: Date.now(),
      });
    } catch {}

    // Schedule graph update
    if (hasDelta) {
      await scheduleDexApply("pumpswap", prev);
    }

    // Gap 2: Write to execution cache for SDK quote cache hits (vault update path)
    try {
      const { executionCache } = await import("../../../../execution/cache.js");
      const existingStatic = executionCache.getStatic(poolId) || {};
      executionCache.setStatic(poolId, {
        ...existingStatic,
        dex: "Pumpswap",
        pool_kind: "amm",
        programId: PUMPSWAP_AMM_PROGRAM_ID,
        mint_a: item.mint_a,
        mint_b: item.mint_b,
        decimals_a: item.decimals_a,
        decimals_b: item.decimals_b,
        native_mint_a: mintA,
        native_mint_b: mintB,
        native_decimals_a: decA,
        native_decimals_b: decB,
        native_account_a: vaultA,
        native_account_b: vaultB,
        was_swapped: processedPrice.wasSwapped,
        // Preserve protocol_fee_recipient from pool account handler (vault handler doesn't have raw pool data)
        protocol_fee_recipient:
          (existingPool as any)?.protocol_fee_recipient ||
          (existingStatic as any)?.protocol_fee_recipient,
      });
    } catch {}

    // Try to activate pool for lazy activation mode (only activates on first valid price update)
    const hasValidPriceVault = !!(
      processedPrice?.priceForward &&
      Number.isFinite(processedPrice.priceForward) &&
      processedPrice.priceForward > 0
    );
    tryActivatePool(poolId, "pumpswap", hasValidPriceVault);

    // Track successful activity for staleness monitoring (track the actual pool, not vault)
    recordPoolActivity(poolId, "pumpswap", vaultAddress);

    return { success: true, pool: item as DecodedPool, delta };
  } catch (e) {
    wsDecodeStats.pumpswap.failures += 1;
    logCatchError("pumpswap.handleVaultUpdate", e, {
      vault: vaultAddress.slice(0, 8) + "…",
    });
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
    const owner =
      typeof info.owner === "string"
        ? info.owner
        : info.owner?.toBase58?.() || "";

    // Route based on owner - check both PumpSwap programs
    if (
      owner === PUMPSWAP_AMM_PROGRAM_ID ||
      owner === PUMPSWAP_BONDING_CURVE_PROGRAM_ID
    ) {
      // This is a pool account update (owned by pumpswap program)
      // Decode the pool state directly
      return handlePumpswapPoolAccountUpdate(info, accountAddress);
    }

    // Check if this is a derived account (vault)
    const derivedMeta = derivedAccountToPool.get(accountAddress);
    if (!derivedMeta) {
      logger.debug("pumpswap.update.unknown_account", {
        account: accountAddress.slice(0, 8) + "…",
        owner: owner.slice(0, 8) + "…",
        cat: "pools",
      });
      wsDeltaStats.pumpswap.skipped += 1;
      incrementSkipReason("pumpswap", "unknown_account");
      return { success: false, error: "unknown_account", skipped: true };
    }

    if (
      derivedMeta.accountType !== "vault" &&
      derivedMeta.accountType !== "reserve"
    ) {
      logger.debug("pumpswap.update.not_vault", {
        account: accountAddress.slice(0, 8) + "…",
        accountType: derivedMeta.accountType,
        cat: "pools",
      });
      wsDeltaStats.pumpswap.skipped += 1;
      incrementSkipReason("pumpswap", "not_vault_account");
      return { success: true, skipped: true, skipReason: "not_vault" };
    }

    return handlePumpswapVaultUpdate(info, accountAddress, derivedMeta.poolId);
  } catch (e) {
    wsDecodeStats.pumpswap.failures += 1;
    logCatchError("pumpswap.handleUpdate", e, {
      account: accountAddress.slice(0, 8) + "…",
    });
    return { success: false, error: String((e as Error)?.message || e) };
  }
}

/**
 * Check if an owner is a Pumpswap program (bonding curve or AMM)
 */
export function isPumpswapOwner(owner: string): boolean {
  return (
    owner === PUMPSWAP_AMM_PROGRAM_ID ||
    owner === PUMPSWAP_BONDING_CURVE_PROGRAM_ID
  );
}

/**
 * Get Pumpswap program IDs
 */
export const PUMPSWAP_PROGRAM = PUMPSWAP_PROGRAM_ID; // Legacy export
export const PUMPSWAP_PROGRAMS = {
  BONDING_CURVE: PUMPSWAP_BONDING_CURVE_PROGRAM_ID,
  AMM: PUMPSWAP_AMM_PROGRAM_ID,
};
