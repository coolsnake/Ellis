/**
 * PumpSwap fee computation module.
 *
 * Fetches and caches GlobalConfig + FeeConfig PDAs from on-chain,
 * then computes per-pool fees matching the PumpSwap SDK exactly:
 *
 *   - Pump.fun pools (creator == pumpPoolAuthorityPda(baseMint)):
 *       Market-cap-based tiered fees from FeeConfig.feeTiers
 *   - Non-pump pools:
 *       Flat fees from FeeConfig.flatFees
 *   - Fallback (no FeeConfig):
 *       GlobalConfig defaults (lpFeeBasisPoints, protocolFeeBasisPoints, coinCreatorFeeBasisPoints)
 *
 * Fee application is OUTPUT-side (matches SDK sell.ts):
 *   rawOut = amtIn * reserveOut / (reserveIn + amtIn)
 *   lpFee = ceil(rawOut * lpFeeBps / 10000)
 *   protocolFee = ceil(rawOut * protocolFeeBps / 10000)
 *   creatorFee = ceil(rawOut * creatorFeeBps / 10000)   (only if coinCreator != default)
 *   finalOut = rawOut - lpFee - protocolFee - creatorFee
 */

import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import {
  PUMP_AMM_SDK,
  GLOBAL_CONFIG_PDA,
  PUMP_AMM_FEE_CONFIG_PDA,
  pumpPoolAuthorityPda,
} from '@pump-fun/pump-swap-sdk';
import type { GlobalConfig, FeeConfig, Fees, FeeTier } from '@pump-fun/pump-swap-sdk';
import { logger } from '../../utils/logger.js';
import { logCatchError } from '../../utils/errorHandler.js';

// ─────────────── Cache ───────────────

interface FeeCache {
  globalConfig: GlobalConfig | null;
  feeConfig: FeeConfig | null;
  fetchedAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let feeCache: FeeCache = {
  globalConfig: null,
  feeConfig: null,
  fetchedAt: 0,
};

// Default PublicKey (all zeros) — used to detect if coinCreator is set
const DEFAULT_PUBKEY = PublicKey.default;

// Pump.fun tokens always have 1B supply with 6 decimals = 10^15 atomic units
const PUMP_TOKEN_SUPPLY = new BN('1000000000000000'); // 10^15

// ─────────────── Public API ───────────────

export interface PumpswapPoolFees {
  lpFeeBps: number;
  protocolFeeBps: number;
  creatorFeeBps: number;
  totalFeeBps: number;
  source: 'fee_config_tiered' | 'fee_config_flat' | 'global_config' | 'fallback';
  isPumpPool: boolean;
  marketCapLamports?: string;
}

/**
 * Fetch and cache GlobalConfig + FeeConfig from on-chain.
 * Call once at startup or periodically (e.g. during normalization).
 * Uses getMultipleAccountsInfo for a single RPC round-trip.
 */
export async function ensurePumpswapFeeConfig(connection: { getMultipleAccountsInfo: Function }): Promise<void> {
  const now = Date.now();
  if (feeCache.globalConfig && (now - feeCache.fetchedAt) < CACHE_TTL_MS) {
    return; // Cache still fresh
  }

  try {
    const accounts = await connection.getMultipleAccountsInfo([
      GLOBAL_CONFIG_PDA,
      PUMP_AMM_FEE_CONFIG_PDA,
    ]);

    let globalConfig: GlobalConfig | null = null;
    let feeConfig: FeeConfig | null = null;

    if (accounts[0]?.data) {
      try {
        globalConfig = PUMP_AMM_SDK.decodeGlobalConfig(accounts[0]);
      } catch (e) {
        logCatchError('pumpswap.fees.decodeGlobalConfig', e);
      }
    }

    if (accounts[1]?.data) {
      try {
        feeConfig = PUMP_AMM_SDK.decodeFeeConfig(accounts[1]);
      } catch (e) {
        logCatchError('pumpswap.fees.decodeFeeConfig', e);
      }
    }

    feeCache = { globalConfig, feeConfig, fetchedAt: now };

    logger.info('pumpswap.fees.config.loaded', {
      cat: 'pumpswap',
      hasGlobalConfig: !!globalConfig,
      hasFeeConfig: !!feeConfig,
      feeTiers: feeConfig?.feeTiers?.length ?? 0,
      globalDefaults: globalConfig ? {
        lpFeeBps: globalConfig.lpFeeBasisPoints.toNumber(),
        protocolFeeBps: globalConfig.protocolFeeBasisPoints.toNumber(),
        creatorFeeBps: globalConfig.coinCreatorFeeBasisPoints.toNumber(),
      } : null,
    });
  } catch (e) {
    logCatchError('pumpswap.fees.ensureConfig', e);
    // Keep stale cache if fetch fails
  }
}

/**
 * Get cached fee config (sync, for use at quote time).
 * Returns null if not yet fetched.
 */
export function getPumpswapFeeConfig(): FeeCache {
  return feeCache;
}

/**
 * Compute per-pool fees matching the PumpSwap SDK exactly.
 *
 * @param pool  A pool object with fields: native_mint_a, creator, native_reserve_a_raw, native_reserve_b_raw
 * @returns Fee breakdown with lpFeeBps, protocolFeeBps, creatorFeeBps, totalFeeBps
 */
export function computePumpswapPoolFees(pool: Record<string, any>): PumpswapPoolFees {
  const { globalConfig, feeConfig } = feeCache;

  // Extract pool fields — handle both normalized (canonical) and raw pool shapes
  const baseMintStr: string | undefined = pool.onchain_base_mint ?? pool.native_mint_a ?? pool.base_mint ?? pool.mint_a;
  const creatorStr: string | undefined = pool.creator ?? pool.onchain_creator ?? pool.coinCreator;
  const baseReserveRawStr: string | undefined = pool.native_reserve_a_raw ?? pool.reserve_a_raw ?? pool.base_reserve;
  const quoteReserveRawStr: string | undefined = pool.native_reserve_b_raw ?? pool.reserve_b_raw ?? pool.quote_reserve;

  if (!globalConfig || !baseMintStr) {
    // No config loaded — return fallback 25 BPS
    return {
      lpFeeBps: 20,
      protocolFeeBps: 5,
      creatorFeeBps: 0,
      totalFeeBps: 25,
      source: 'fallback',
      isPumpPool: false,
    };
  }

  try {
    const baseMint = new PublicKey(baseMintStr);
    const creator = creatorStr ? new PublicKey(creatorStr) : DEFAULT_PUBKEY;

    // Determine if this is a pump.fun pool
    const isPump = isPumpPoolCheck(baseMint, creator);

    // Parse reserves for market cap computation
    let baseReserve = new BN(0);
    let quoteReserve = new BN(0);
    if (baseReserveRawStr) {
      try { baseReserve = new BN(String(baseReserveRawStr)); } catch { /* ignore */ }
    }
    if (quoteReserveRawStr) {
      try { quoteReserve = new BN(String(quoteReserveRawStr)); } catch { /* ignore */ }
    }

    // Compute fees matching SDK's computeFeesBps + calculateFeeTier logic exactly.
    // (computeFeesBps is not exported from the SDK's main entry, so we reimplement locally)
    const fees: Fees = localComputeFeesBps(
      globalConfig, feeConfig ?? null, isPump, baseMint, creator,
      baseReserve.isZero() ? new BN(1) : baseReserve,
      quoteReserve,
    );

    const lpBps = fees.lpFeeBps.toNumber();
    const protocolBps = fees.protocolFeeBps.toNumber();
    const creatorBps = fees.creatorFeeBps.toNumber();

    // Determine if coin creator fee applies:
    // Only charged if the pool's coinCreator is not PublicKey.default (all zeros)
    const coinCreator = pool.coinCreator ? new PublicKey(pool.coinCreator) : creator;
    const hasActiveCoinCreator = !coinCreator.equals(DEFAULT_PUBKEY);
    const effectiveCreatorBps = hasActiveCoinCreator ? creatorBps : 0;

    const totalBps = lpBps + protocolBps + effectiveCreatorBps;

    // Determine source
    let source: PumpswapPoolFees['source'] = 'global_config';
    if (feeConfig) {
      source = isPump ? 'fee_config_tiered' : 'fee_config_flat';
    }

    // Compute market cap for diagnostics
    let marketCapLamports: string | undefined;
    if (isPump && !baseReserve.isZero()) {
      try {
        const mcap = quoteReserve.mul(PUMP_TOKEN_SUPPLY).div(baseReserve);
        marketCapLamports = mcap.toString();
      } catch { /* ignore */ }
    }

    return {
      lpFeeBps: lpBps,
      protocolFeeBps: protocolBps,
      creatorFeeBps: effectiveCreatorBps,
      totalFeeBps: totalBps,
      source,
      isPumpPool: isPump,
      marketCapLamports,
    };
  } catch (e) {
    logCatchError('pumpswap.fees.computePoolFees', e);
    // Fallback to global config defaults if available
    if (globalConfig) {
      const lpBps = globalConfig.lpFeeBasisPoints.toNumber();
      const protocolBps = globalConfig.protocolFeeBasisPoints.toNumber();
      return {
        lpFeeBps: lpBps,
        protocolFeeBps: protocolBps,
        creatorFeeBps: 0,
        totalFeeBps: lpBps + protocolBps,
        source: 'global_config',
        isPumpPool: false,
      };
    }
    return {
      lpFeeBps: 20,
      protocolFeeBps: 5,
      creatorFeeBps: 0,
      totalFeeBps: 25,
      source: 'fallback',
      isPumpPool: false,
    };
  }
}

// ─────────────── Helpers ───────────────

/**
 * Check if a pool is a pump.fun pool by comparing creator with the PDA derived from baseMint.
 * Matches SDK's isPumpPool(baseMint, poolCreator).
 */
function isPumpPoolCheck(baseMint: PublicKey, creator: PublicKey): boolean {
  try {
    return pumpPoolAuthorityPda(baseMint).equals(creator);
  } catch {
    return false;
  }
}

/**
 * Local reimplementation of SDK's computeFeesBps + calculateFeeTier.
 * (The SDK exports these from sdk/fees.ts but NOT from the main index.)
 *
 * Logic (from @pump-fun/pump-swap-sdk/src/sdk/fees.ts):
 *   if feeConfig exists:
 *     if isPumpPool → calculateFeeTier(feeTiers, marketCap)
 *     else → feeConfig.flatFees
 *   else → globalConfig defaults
 */
function localComputeFeesBps(
  globalConfig: GlobalConfig,
  feeConfig: FeeConfig | null,
  isPump: boolean,
  _baseMint: PublicKey,
  _creator: PublicKey,
  baseReserve: BN,
  quoteReserve: BN,
): Fees {
  if (feeConfig) {
    if (isPump) {
      // Market cap = quoteReserve * baseMintSupply / baseReserve
      const marketCap = quoteReserve.mul(PUMP_TOKEN_SUPPLY).div(baseReserve);
      return localCalculateFeeTier(feeConfig.feeTiers, marketCap);
    } else {
      return feeConfig.flatFees;
    }
  }

  // Fallback to global config defaults
  return {
    lpFeeBps: globalConfig.lpFeeBasisPoints,
    protocolFeeBps: globalConfig.protocolFeeBasisPoints,
    creatorFeeBps: globalConfig.coinCreatorFeeBasisPoints,
  };
}

/**
 * Reimplementation of SDK's calculateFeeTier.
 * Walk tiers in reverse to find the highest tier where marketCap >= threshold.
 * If marketCap < first tier's threshold, use first tier.
 */
function localCalculateFeeTier(feeTiers: FeeTier[], marketCap: BN): Fees {
  if (!feeTiers || feeTiers.length === 0) {
    // Should not happen with valid FeeConfig, but handle gracefully
    return { lpFeeBps: new BN(20), protocolFeeBps: new BN(5), creatorFeeBps: new BN(0) };
  }

  const firstTier = feeTiers[0];

  if (marketCap.lt(firstTier.marketCapLamportsThreshold)) {
    return firstTier.fees;
  }

  // Walk tiers in reverse — return first (highest) tier where marketCap >= threshold
  for (let i = feeTiers.length - 1; i >= 0; i--) {
    if (marketCap.gte(feeTiers[i].marketCapLamportsThreshold)) {
      return feeTiers[i].fees;
    }
  }

  return firstTier.fees;
}
