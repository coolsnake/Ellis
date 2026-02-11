/**
 * Worker thread for stateless pool account decoding.
 *
 * Receives batches of raw account buffers + lookup data from the main thread,
 * decodes them using DEX SDKs, calculates prices via the pure price pipeline,
 * and returns DecodedPoolResult[].
 *
 * This worker imports ONLY stateless modules — no caches, no metrics, no Socket.IO.
 * All side-effecting apply logic runs on the main thread after receiving results.
 */

import { exposeWorkerHandler } from "./runtime.js";
import { processPriceThroughPipeline } from "../server/pools/pricePipeline.js";
import { anyToBigInt } from "../server/pools/precision.js";
import { PublicKey } from "@solana/web3.js";

import type {
  PoolDecodeWorkerRequest,
  PoolDecodeWorkerResponse,
  DecodeJobRequest,
  DecodeJobEvent,
  DecodedPoolResult,
  DecodedPoolFields,
  DexHint,
  PoolLookupData,
} from "./poolDecode.types.js";

// ── Discriminator constants (pre-computed sha256("account:X")[0..8]) ────────

const DISC_POOL_STATE = Buffer.from([247, 237, 227, 245, 215, 195, 222, 70]); // Raydium CLMM + CPMM
const DISC_WHIRLPOOL = Buffer.from([63, 149, 209, 12, 225, 128, 99, 9]); // Orca
const DISC_POOL = Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]); // PumpSwap + Meteora DAMM

// Raydium AMM V4 is non-Anchor; pool accounts are exactly 752 bytes.
const RAYDIUM_AMM_V4_DATA_SIZE = 752;

// ── Lazy-loaded SDK modules ────────────────────────────────────────────────

let raydiumSdk: any = null;
let cpmmLayout: any = null;
let orcaWhirlpoolDecoder: any = null;
let pumpAmm: any = null;
let meteoraDlmmProgram: any = null;
let meteoraDammV1Program: any = null;

async function getRaydiumSdk() {
  if (!raydiumSdk) {
    raydiumSdk = await import("@raydium-io/raydium-sdk-v2");
  }
  return raydiumSdk;
}

async function getCpmmLayout() {
  if (!cpmmLayout) {
    try {
      const mod = await import(
        "@raydium-io/raydium-sdk-v2/lib/raydium/cpmm/layout.js" as any
      );
      cpmmLayout = mod.CpmmPoolInfoLayout || mod.default?.CpmmPoolInfoLayout;
    } catch {
      // Fallback: try the main SDK export
      const sdk = await getRaydiumSdk();
      cpmmLayout = sdk.CpmmPoolInfoLayout;
    }
  }
  return cpmmLayout;
}

async function getOrcaDecoder() {
  if (!orcaWhirlpoolDecoder) {
    try {
      const mod = await import("@orca-so/whirlpools-client");
      if (mod.getWhirlpoolDecoder) {
        orcaWhirlpoolDecoder = mod.getWhirlpoolDecoder();
      }
    } catch {
      // Will fall back to manual decode
    }
  }
  return orcaWhirlpoolDecoder;
}

async function getPumpAmmSdk() {
  if (!pumpAmm) {
    try {
      const mod = await import("@pump-fun/pump-swap-sdk");
      pumpAmm = mod.PUMP_AMM_SDK || mod.default;
    } catch {
      // PumpSwap SDK not available
    }
  }
  return pumpAmm;
}

// ── Q64.64 constants for Meteora Balanced V2 ──────────────────────────────

const TWO_POW_64 = BigInt(2) ** BigInt(64);

// ── Meteora Balanced V2 offsets (bytemuck/zero-copy) ───────────────────────

const V2_OFFSET_TOKEN_A_MINT = 168;
const V2_OFFSET_TOKEN_B_MINT = 200;
const V2_OFFSET_TOKEN_A_VAULT = 232;
const V2_OFFSET_TOKEN_B_VAULT = 264;
const V2_OFFSET_LIQUIDITY = 440;
const V2_OFFSET_SQRT_PRICE = 456;

// ── Utility functions ──────────────────────────────────────────────────────

function bufferToU128LE(buf: Buffer | Uint8Array): bigint {
  let result = 0n;
  for (let i = 15; i >= 0; i--) {
    result = (result << 8n) | BigInt(buf[i]);
  }
  return result;
}

function matchesDiscriminator(data: Buffer, disc: Buffer): boolean {
  if (data.length < disc.length) return false;
  for (let i = 0; i < disc.length; i++) {
    if (data[i] !== disc[i]) return false;
  }
  return true;
}

function pubkeyToBase58(value: any): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value.toBase58 === "function") return value.toBase58();
  if (typeof value.address === "string") return value.address;
  if (typeof value.toString === "function") return value.toString();
  return "";
}

/**
 * Derive Orca fee in BPS from the on-chain feeRate field.
 * Whirlpool accounts encode feeRate as u16 in hundredths of bps (max 65535 = 655.35 bps).
 */
function deriveOrcaFeeBpsFromRate(feeRate: number): number {
  if (!Number.isFinite(feeRate) || feeRate <= 0) return 30; // default 30bps
  if (Number.isInteger(feeRate) && feeRate > 1 && feeRate <= 65535) {
    return Math.round(feeRate / 100);
  }
  if (feeRate >= 100) return Math.round(feeRate);
  if (feeRate >= 0.01) return Math.round(feeRate * 100);
  return Math.round(feeRate * 10_000);
}

/**
 * Calculate Meteora DLMM fee from on-chain parameters.
 * baseFee = binStep * baseFactor * 10^baseFeePowerFactor / 10000
 * variableFee = ceil(variableFeeControl * (volatilityAccumulator * binStep)^2 / 10^11) / 10^5
 */
function computeMeteoraFee(
  binStep: number,
  baseFactor: number,
  baseFeePowerFactor: number,
  variableFeeControl: number,
  volatilityAccumulator: number
): number {
  const baseFee =
    (binStep * baseFactor * Math.pow(10, baseFeePowerFactor)) / 10000;
  let variableFee = 0;
  if (variableFeeControl > 0 && volatilityAccumulator > 0) {
    const vfRaw =
      (variableFeeControl * Math.pow(volatilityAccumulator * binStep, 2)) /
      1e11;
    variableFee = Math.ceil(vfRaw) / 1e5;
  }
  const totalBps = baseFee + variableFee;
  return Math.round(totalBps * 100) / 100; // round to 2dp bps
}

/**
 * Calculate price from CP-AMM sqrtPrice (Q64.64 fixed-point).
 * sqrtPrice = sqrt(tokenB/tokenA) * 2^64
 * price = (sqrtPrice / 2^64)^2 * 10^(decimalsA - decimalsB)
 */
function calculateCpAmmPrice(
  sqrtPrice: bigint,
  decimalsA: number,
  decimalsB: number
): number | undefined {
  if (!sqrtPrice || sqrtPrice <= 0n) return undefined;
  const sqrtPriceNum = Number(sqrtPrice) / Number(TWO_POW_64);
  const rawPrice = sqrtPriceNum * sqrtPriceNum;
  if (!Number.isFinite(rawPrice) || rawPrice <= 0) return undefined;
  const adjustedPrice = rawPrice * Math.pow(10, decimalsA - decimalsB);
  if (!Number.isFinite(adjustedPrice) || adjustedPrice <= 0) return undefined;
  return adjustedPrice;
}

// ── Per-DEX decode functions ───────────────────────────────────────────────

/**
 * Decode Raydium CLMM pool account.
 */
async function decodeRaydiumClmm(
  data: Buffer,
  lookup: PoolLookupData
): Promise<DecodedPoolResult> {
  const idx = 0; // will be overridden by caller

  if (!matchesDiscriminator(data, DISC_POOL_STATE)) {
    return {
      poolId: lookup.poolId,
      dexHint: "raydium",
      success: false,
      skipReason: "discriminator_mismatch",
      rawBufferIndex: idx,
    };
  }

  if (lookup.decimalsA == null || lookup.decimalsB == null) {
    return {
      poolId: lookup.poolId,
      dexHint: "raydium",
      success: false,
      skipReason: "decimals_pending",
      rawBufferIndex: idx,
    };
  }

  const sdk = await getRaydiumSdk();
  let state: any;
  try {
    const decoder =
      sdk.Clmm?.PoolStateLayout ||
      sdk.CLMM?.POOL_STATE_LAYOUT ||
      sdk.PoolStateLayout ||
      sdk.PoolInfoLayout;
    if (!decoder?.decode) throw new Error("No Raydium CLMM decoder available");
    state = decoder.decode(data);
  } catch {
    return {
      poolId: lookup.poolId,
      dexHint: "raydium",
      success: false,
      error: "sdk_decode_failed",
      rawBufferIndex: idx,
    };
  }

  const mintA = pubkeyToBase58(state.mintA || state.tokenMintA);
  const mintB = pubkeyToBase58(state.mintB || state.tokenMintB);
  if (!mintA || !mintB) {
    return {
      poolId: lookup.poolId,
      dexHint: "raydium",
      success: false,
      error: "missing_mints",
      rawBufferIndex: idx,
    };
  }

  const sqrtRaw = anyToBigInt(
    state.sqrtPriceX64 || state.sqrt_price_x64 || state.sqrtPrice
  );
  if (!sqrtRaw || sqrtRaw <= 0n) {
    return {
      poolId: lookup.poolId,
      dexHint: "raydium",
      success: false,
      error: "invalid_sqrt_price",
      rawBufferIndex: idx,
    };
  }

  const liquidity = anyToBigInt(state.liquidity);
  const tickSpacing = Number(state.tickSpacing || state.tick_spacing || 0);
  const tickCurrent = Number(
    state.tickCurrent || state.tick_current || state.tickCurrentIndex || 0
  );
  const feeRate = Number(
    state.tradeFeeRate || state.feeRate || state.fee_rate || 0
  );
  const ammConfig = pubkeyToBase58(state.ammConfig || state.amm_config);

  // Fee: SDK returns PPM, convert to BPS (/ 100) — or use cached if available
  let feeBps = lookup.cachedFeeBps ?? Math.round(feeRate / 100);
  if (feeBps <= 0 || feeBps > 10000) feeBps = 25; // safe default

  const processed = processPriceThroughPipeline({
    mintA,
    mintB,
    decimalsA: lookup.decimalsA,
    decimalsB: lookup.decimalsB,
    poolId: lookup.poolId,
    dex: "Raydium",
    poolType: "clmm",
    sqrtPriceX64: sqrtRaw,
  });

  if (!processed) {
    return {
      poolId: lookup.poolId,
      dexHint: "raydium",
      success: false,
      error: "price_pipeline_failed",
      rawBufferIndex: idx,
    };
  }

  const pool: DecodedPoolFields = {
    id: lookup.poolId,
    dex: "Raydium",
    mint_a: processed.mintA,
    mint_b: processed.mintB,
    price_a_per_b: processed.priceForward,
    fee_bps: feeBps,
    pool_kind: "clmm",
    updated_ms: Date.now(),
    was_swapped: processed.wasSwapped,
    sqrt_price_x64: Number(sqrtRaw),
    sqrt_price_x64_raw: sqrtRaw.toString(),
    liquidity: liquidity ? Number(liquidity) : undefined,
    liquidity_raw: liquidity?.toString(),
    tick_spacing: tickSpacing,
    tick_current_index: processed.wasSwapped ? -tickCurrent : tickCurrent,
    native_tick_current_index: tickCurrent,
    native_mint_a: mintA,
    native_mint_b: mintB,
    decimals_a: processed.decimalsA,
    decimals_b: processed.decimalsB,
    native_decimals_a: lookup.decimalsA,
    native_decimals_b: lookup.decimalsB,
    amm_config: ammConfig || undefined,
  };

  return {
    poolId: lookup.poolId,
    dexHint: "raydium",
    success: true,
    pool,
    rawBufferIndex: idx,
  };
}

/**
 * Decode Raydium AMM V4 pool account.
 */
async function decodeRaydiumAmmV4(
  data: Buffer,
  lookup: PoolLookupData
): Promise<DecodedPoolResult> {
  const idx = 0;

  // AMM V4 is non-Anchor; accounts are exactly 752 bytes
  if (data.length !== RAYDIUM_AMM_V4_DATA_SIZE) {
    return {
      poolId: lookup.poolId,
      dexHint: "raydium",
      success: false,
      skipReason: "wrong_data_size",
      rawBufferIndex: idx,
    };
  }

  if (lookup.decimalsA == null || lookup.decimalsB == null) {
    return {
      poolId: lookup.poolId,
      dexHint: "raydium",
      success: false,
      skipReason: "decimals_pending",
      rawBufferIndex: idx,
    };
  }

  const sdk = await getRaydiumSdk();
  let state: any;
  try {
    const decoder = sdk.LiquidityStateLayoutV4 || sdk.LIQUIDITY_STATE_LAYOUT_V4;
    if (!decoder?.decode) throw new Error("No Raydium AMM decoder available");
    state = decoder.decode(data);
  } catch {
    return {
      poolId: lookup.poolId,
      dexHint: "raydium",
      success: false,
      error: "sdk_decode_failed",
      rawBufferIndex: idx,
    };
  }

  const mintA = pubkeyToBase58(state.baseMint || state.mintA || state.mint_a);
  const mintB = pubkeyToBase58(state.quoteMint || state.mintB || state.mint_b);
  if (!mintA || !mintB) {
    return {
      poolId: lookup.poolId,
      dexHint: "raydium",
      success: false,
      error: "missing_mints",
      rawBufferIndex: idx,
    };
  }

  const reserveA = anyToBigInt(
    state.baseReserve || state.reserveA || state.vaultA
  );
  const reserveB = anyToBigInt(
    state.quoteReserve || state.reserveB || state.vaultB
  );
  if (!reserveA || reserveA <= 0n || !reserveB || reserveB <= 0n) {
    return {
      poolId: lookup.poolId,
      dexHint: "raydium",
      success: false,
      error: "invalid_reserves",
      rawBufferIndex: idx,
    };
  }

  const feeRate = Number(state.tradeFeeRate || state.feeRate || 0);
  let feeBps = Math.round(feeRate / 100);
  if (feeBps <= 0 || feeBps > 10000) feeBps = 25;

  const processed = processPriceThroughPipeline({
    mintA,
    mintB,
    decimalsA: lookup.decimalsA,
    decimalsB: lookup.decimalsB,
    poolId: lookup.poolId,
    dex: "Raydium",
    poolType: "amm",
    reserveA,
    reserveB,
  });

  if (!processed) {
    return {
      poolId: lookup.poolId,
      dexHint: "raydium",
      success: false,
      error: "price_pipeline_failed",
      rawBufferIndex: idx,
    };
  }

  const pool: DecodedPoolFields = {
    id: lookup.poolId,
    dex: "Raydium",
    mint_a: processed.mintA,
    mint_b: processed.mintB,
    price_a_per_b: processed.priceForward,
    fee_bps: feeBps,
    pool_kind: "amm",
    updated_ms: Date.now(),
    was_swapped: processed.wasSwapped,
    reserve_a_raw: reserveA.toString(),
    reserve_b_raw: reserveB.toString(),
    native_mint_a: mintA,
    native_mint_b: mintB,
    decimals_a: processed.decimalsA,
    decimals_b: processed.decimalsB,
    native_decimals_a: lookup.decimalsA,
    native_decimals_b: lookup.decimalsB,
  };

  return {
    poolId: lookup.poolId,
    dexHint: "raydium",
    success: true,
    pool,
    rawBufferIndex: idx,
  };
}

/**
 * Decode Raydium CPMM pool account.
 * Price depends on vault balances from lookup data (not embedded in pool state).
 */
async function decodeRaydiumCpmm(
  data: Buffer,
  lookup: PoolLookupData
): Promise<DecodedPoolResult> {
  const idx = 0;

  if (!matchesDiscriminator(data, DISC_POOL_STATE)) {
    return {
      poolId: lookup.poolId,
      dexHint: "raydium-cpmm",
      success: false,
      skipReason: "discriminator_mismatch",
      rawBufferIndex: idx,
    };
  }

  const layout = await getCpmmLayout();
  if (!layout?.decode) {
    return {
      poolId: lookup.poolId,
      dexHint: "raydium-cpmm",
      success: false,
      error: "no_cpmm_decoder",
      rawBufferIndex: idx,
    };
  }

  let state: any;
  try {
    state = layout.decode(data);
  } catch {
    return {
      poolId: lookup.poolId,
      dexHint: "raydium-cpmm",
      success: false,
      error: "sdk_decode_failed",
      rawBufferIndex: idx,
    };
  }

  const mintA = pubkeyToBase58(state.mintA);
  const mintB = pubkeyToBase58(state.mintB);
  const vaultA = pubkeyToBase58(state.vaultA);
  const vaultB = pubkeyToBase58(state.vaultB);
  if (!mintA || !mintB) {
    return {
      poolId: lookup.poolId,
      dexHint: "raydium-cpmm",
      success: false,
      error: "missing_mints",
      rawBufferIndex: idx,
    };
  }

  // Decimals: prefer on-chain from state, fall back to lookup
  const decimalsA = state.mintDecimalA ?? lookup.decimalsA;
  const decimalsB = state.mintDecimalB ?? lookup.decimalsB;
  if (decimalsA == null || decimalsB == null) {
    return {
      poolId: lookup.poolId,
      dexHint: "raydium-cpmm",
      success: false,
      skipReason: "decimals_pending",
      rawBufferIndex: idx,
    };
  }

  // CPMM pricing uses vault balances, not embedded reserves
  const reserveA = lookup.vaultBalanceA ? BigInt(lookup.vaultBalanceA) : null;
  const reserveB = lookup.vaultBalanceB ? BigInt(lookup.vaultBalanceB) : null;

  if (!reserveA || reserveA <= 0n || !reserveB || reserveB <= 0n) {
    // No vault balances available — return structural data without price
    // The main thread will queue vault fetches
    return {
      poolId: lookup.poolId,
      dexHint: "raydium-cpmm",
      success: true,
      pool: {
        id: lookup.poolId,
        dex: "Raydium",
        mint_a: mintA,
        mint_b: mintB,
        price_a_per_b: 0,
        fee_bps: lookup.cachedFeeBps ?? 25,
        pool_kind: "cpmm",
        updated_ms: Date.now(),
        was_swapped: false,
        native_mint_a: mintA,
        native_mint_b: mintB,
        decimals_a: decimalsA,
        decimals_b: decimalsB,
        native_account_a: vaultA,
        native_account_b: vaultB,
        amm_config: pubkeyToBase58(state.configId) || undefined,
      },
      rawBufferIndex: idx,
    };
  }

  const processed = processPriceThroughPipeline({
    mintA,
    mintB,
    decimalsA,
    decimalsB,
    poolId: lookup.poolId,
    dex: "Raydium",
    poolType: "cpmm",
    reserveA,
    reserveB,
  });

  if (!processed) {
    return {
      poolId: lookup.poolId,
      dexHint: "raydium-cpmm",
      success: false,
      error: "price_pipeline_failed",
      rawBufferIndex: idx,
    };
  }

  const pool: DecodedPoolFields = {
    id: lookup.poolId,
    dex: "Raydium",
    mint_a: processed.mintA,
    mint_b: processed.mintB,
    price_a_per_b: processed.priceForward,
    fee_bps: lookup.cachedFeeBps ?? 25,
    pool_kind: "cpmm",
    updated_ms: Date.now(),
    was_swapped: processed.wasSwapped,
    reserve_a_raw: reserveA.toString(),
    reserve_b_raw: reserveB.toString(),
    native_mint_a: mintA,
    native_mint_b: mintB,
    decimals_a: processed.decimalsA,
    decimals_b: processed.decimalsB,
    native_decimals_a: decimalsA,
    native_decimals_b: decimalsB,
    native_account_a: vaultA,
    native_account_b: vaultB,
    amm_config: pubkeyToBase58(state.configId) || undefined,
  };

  return {
    poolId: lookup.poolId,
    dexHint: "raydium-cpmm",
    success: true,
    pool,
    rawBufferIndex: idx,
  };
}

/**
 * Decode Orca Whirlpool account via manual buffer parsing (no SDK dependency required).
 * Falls back to SDK decoder if available and manual parse fails.
 */
async function decodeOrca(
  data: Buffer,
  lookup: PoolLookupData
): Promise<DecodedPoolResult> {
  const idx = 0;

  if (!matchesDiscriminator(data, DISC_WHIRLPOOL)) {
    return {
      poolId: lookup.poolId,
      dexHint: "orca",
      success: false,
      skipReason: "discriminator_mismatch",
      rawBufferIndex: idx,
    };
  }

  if (lookup.decimalsA == null || lookup.decimalsB == null) {
    return {
      poolId: lookup.poolId,
      dexHint: "orca",
      success: false,
      skipReason: "decimals_pending",
      rawBufferIndex: idx,
    };
  }

  if (data.length < 300) {
    return {
      poolId: lookup.poolId,
      dexHint: "orca",
      success: false,
      error: "buffer_too_small",
      rawBufferIndex: idx,
    };
  }

  // Manual decode — no SDK dependency, fastest path
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 8; // skip discriminator
  offset += 32; // skip whirlpoolsConfig
  offset += 1; // skip bump

  const tickSpacing = dv.getUint16(offset, true);
  offset += 2;
  offset += 2; // skip tickSpacingSeed
  const feeRate = dv.getUint16(offset, true);
  offset += 2;
  offset += 2; // skip protocolFeeRate

  const liquidity = bufferToU128LE(data.subarray(offset, offset + 16));
  offset += 16;
  const sqrtPrice = bufferToU128LE(data.subarray(offset, offset + 16));
  offset += 16;
  const tickCurrentIndex = dv.getInt32(offset, true);
  offset += 4;

  offset += 8; // skip protocolFeeOwedA
  offset += 8; // skip protocolFeeOwedB

  const tokenMintA = new PublicKey(
    data.subarray(offset, offset + 32)
  ).toBase58();
  offset += 32;
  const tokenMintB = new PublicKey(
    data.subarray(offset, offset + 32)
  ).toBase58();
  offset += 32;
  const tokenVaultA = new PublicKey(
    data.subarray(offset, offset + 32)
  ).toBase58();
  offset += 32;
  const tokenVaultB = new PublicKey(
    data.subarray(offset, offset + 32)
  ).toBase58();
  offset += 32;

  if (!tokenMintA || !tokenMintB) {
    return {
      poolId: lookup.poolId,
      dexHint: "orca",
      success: false,
      error: "missing_mints",
      rawBufferIndex: idx,
    };
  }

  if (sqrtPrice <= 0n) {
    return {
      poolId: lookup.poolId,
      dexHint: "orca",
      success: false,
      error: "invalid_sqrt_price",
      rawBufferIndex: idx,
    };
  }

  if (tickSpacing > 512) {
    return {
      poolId: lookup.poolId,
      dexHint: "orca",
      success: false,
      skipReason: "invalid_tick_spacing",
      rawBufferIndex: idx,
    };
  }

  const feeBps = deriveOrcaFeeBpsFromRate(feeRate);

  const processed = processPriceThroughPipeline({
    mintA: tokenMintA,
    mintB: tokenMintB,
    decimalsA: lookup.decimalsA,
    decimalsB: lookup.decimalsB,
    poolId: lookup.poolId,
    dex: "Orca",
    poolType: "clmm",
    sqrtPriceX64: sqrtPrice,
  });

  if (!processed) {
    return {
      poolId: lookup.poolId,
      dexHint: "orca",
      success: false,
      error: "price_pipeline_failed",
      rawBufferIndex: idx,
    };
  }

  const pool: DecodedPoolFields = {
    id: lookup.poolId,
    dex: "Orca",
    mint_a: processed.mintA,
    mint_b: processed.mintB,
    price_a_per_b: processed.priceForward,
    fee_bps: feeBps,
    pool_kind: "clmm",
    updated_ms: Date.now(),
    was_swapped: processed.wasSwapped,
    sqrt_price_x64: Number(sqrtPrice),
    sqrt_price_x64_raw: sqrtPrice.toString(),
    liquidity: Number(liquidity),
    liquidity_raw: liquidity.toString(),
    tick_spacing: tickSpacing,
    tick_current_index: processed.wasSwapped
      ? -tickCurrentIndex
      : tickCurrentIndex,
    native_tick_current_index: tickCurrentIndex,
    native_mint_a: tokenMintA,
    native_mint_b: tokenMintB,
    decimals_a: processed.decimalsA,
    decimals_b: processed.decimalsB,
    native_decimals_a: lookup.decimalsA,
    native_decimals_b: lookup.decimalsB,
    token_vault_a: tokenVaultA,
    token_vault_b: tokenVaultB,
  };

  return {
    poolId: lookup.poolId,
    dexHint: "orca",
    success: true,
    pool,
    rawBufferIndex: idx,
  };
}

/**
 * Decode Meteora DLMM (lbPair) account.
 * Uses the @meteora-ag/dlmm Anchor coder if available, otherwise skips.
 */
async function decodeMeteoraDlmm(
  data: Buffer,
  lookup: PoolLookupData
): Promise<DecodedPoolResult> {
  const idx = 0;

  if (lookup.decimalsA == null || lookup.decimalsB == null) {
    return {
      poolId: lookup.poolId,
      dexHint: "meteora",
      success: false,
      skipReason: "decimals_pending",
      rawBufferIndex: idx,
    };
  }

  // Lazy-load Meteora DLMM program for Anchor decoding
  if (!meteoraDlmmProgram) {
    try {
      const mod = await import("@meteora-ag/dlmm");
      const { Connection } = await import("@solana/web3.js");
      // Create a dummy connection (never used for RPC, only for Anchor IDL coder)
      const dummyConn = new Connection("https://api.mainnet-beta.solana.com");
      const createFn =
        (mod as any).default?.create ||
        (mod as any).create ||
        (mod as any).DLMM?.create;
      if (createFn) {
        // We only need the program.coder — create via the static method that accepts connection
        meteoraDlmmProgram = await createFn(dummyConn);
      }
    } catch {
      // If DLMM SDK fails to load, we can't decode these
    }
  }

  let state: any;
  try {
    const coder = meteoraDlmmProgram?.program?.coder;
    if (!coder?.accounts?.decode) {
      return {
        poolId: lookup.poolId,
        dexHint: "meteora",
        success: false,
        error: "no_dlmm_decoder",
        rawBufferIndex: idx,
      };
    }
    state = coder.accounts.decode("lbPair", data);
  } catch {
    return {
      poolId: lookup.poolId,
      dexHint: "meteora",
      success: false,
      error: "sdk_decode_failed",
      rawBufferIndex: idx,
    };
  }

  if (!state) {
    return {
      poolId: lookup.poolId,
      dexHint: "meteora",
      success: false,
      error: "null_state",
      rawBufferIndex: idx,
    };
  }

  const tokenXMint = pubkeyToBase58(
    state.tokenXMint || state.mint_x || state.tokenA
  );
  const tokenYMint = pubkeyToBase58(
    state.tokenYMint || state.mint_y || state.tokenB
  );
  if (!tokenXMint || !tokenYMint) {
    return {
      poolId: lookup.poolId,
      dexHint: "meteora",
      success: false,
      error: "missing_mints",
      rawBufferIndex: idx,
    };
  }

  const activeId = Number(state.activeId ?? state.active_id);
  const binStep = Number(state.binStep ?? state.bin_step);
  if (!Number.isFinite(activeId) || !Number.isFinite(binStep) || binStep <= 0) {
    return {
      poolId: lookup.poolId,
      dexHint: "meteora",
      success: false,
      error: "invalid_bin_params",
      rawBufferIndex: idx,
    };
  }

  const reserveX = pubkeyToBase58(state.reserveX);
  const reserveY = pubkeyToBase58(state.reserveY);

  // Compute fee from on-chain parameters
  let feeBps = lookup.cachedFeeBps ?? 30;
  try {
    const params = state.parameters;
    if (params) {
      const baseFactor = Number(params.baseFactor ?? 0);
      const baseFeePowerFactor = Number(params.baseFeePowerFactor ?? 0);
      const variableFeeControl = Number(params.variableFeeControl ?? 0);
      const volatilityAccumulator = Number(
        state.volatilityAccumulator ??
          state.vParameter?.volatilityAccumulator ??
          0
      );
      if (baseFactor > 0) {
        feeBps = computeMeteoraFee(
          binStep,
          baseFactor,
          baseFeePowerFactor,
          variableFeeControl,
          volatilityAccumulator
        );
      }
    }
  } catch {
    // Use cached/default fee
  }

  // Use mintA/mintB = tokenX/tokenY for pipeline (it handles X/Y orientation internally)
  const processed = processPriceThroughPipeline({
    mintA: tokenXMint,
    mintB: tokenYMint,
    decimalsA: lookup.decimalsA,
    decimalsB: lookup.decimalsB,
    poolId: lookup.poolId,
    dex: "Meteora",
    poolType: "dlmm",
    activeId,
    binStep,
    tokenXMint,
    tokenYMint,
  });

  if (!processed) {
    return {
      poolId: lookup.poolId,
      dexHint: "meteora",
      success: false,
      error: "price_pipeline_failed",
      rawBufferIndex: idx,
    };
  }

  const pool: DecodedPoolFields = {
    id: lookup.poolId,
    dex: "Meteora",
    mint_a: processed.mintA,
    mint_b: processed.mintB,
    price_a_per_b: processed.priceForward,
    fee_bps: feeBps,
    pool_kind: "dlmm",
    updated_ms: Date.now(),
    was_swapped: processed.wasSwapped,
    active_id: activeId,
    bin_step: binStep,
    tick_spacing: binStep, // DLMM uses binStep as tick_spacing equivalent
    tick_current_index: activeId,
    native_tick_current_index: activeId,
    native_mint_a: tokenXMint,
    native_mint_b: tokenYMint,
    decimals_a: processed.decimalsA,
    decimals_b: processed.decimalsB,
    native_decimals_a: lookup.decimalsA,
    native_decimals_b: lookup.decimalsB,
    native_account_a: reserveX || undefined,
    native_account_b: reserveY || undefined,
  };

  return {
    poolId: lookup.poolId,
    dexHint: "meteora",
    success: true,
    pool,
    rawBufferIndex: idx,
  };
}

/**
 * Decode PumpSwap pool account.
 * Price depends on vault balances from lookup data.
 */
async function decodePumpswap(
  data: Buffer,
  lookup: PoolLookupData
): Promise<DecodedPoolResult> {
  const idx = 0;

  if (!matchesDiscriminator(data, DISC_POOL)) {
    return {
      poolId: lookup.poolId,
      dexHint: "pumpswap",
      success: false,
      skipReason: "discriminator_mismatch",
      rawBufferIndex: idx,
    };
  }

  const sdk = await getPumpAmmSdk();
  let decoded: any = null;

  if (sdk?.decodePoolNullable) {
    try {
      decoded = sdk.decodePoolNullable({
        data,
        owner: new PublicKey(lookup.owner),
        executable: false,
        lamports: 0,
      });
    } catch {
      // Fall through to return structural info only
    }
  }

  const mintA = decoded ? pubkeyToBase58(decoded.baseMint) : "";
  const mintB = decoded ? pubkeyToBase58(decoded.quoteMint) : "";
  const vaultA = decoded ? pubkeyToBase58(decoded.poolBaseTokenAccount) : "";
  const vaultB = decoded ? pubkeyToBase58(decoded.poolQuoteTokenAccount) : "";

  if (!mintA || !mintB) {
    return {
      poolId: lookup.poolId,
      dexHint: "pumpswap",
      success: false,
      error: "missing_mints",
      rawBufferIndex: idx,
    };
  }

  const decimalsA = lookup.decimalsA;
  const decimalsB = lookup.decimalsB;
  if (decimalsA == null || decimalsB == null) {
    return {
      poolId: lookup.poolId,
      dexHint: "pumpswap",
      success: false,
      skipReason: "decimals_pending",
      rawBufferIndex: idx,
    };
  }

  // PumpSwap pricing uses vault balances
  const reserveA = lookup.vaultBalanceA ? BigInt(lookup.vaultBalanceA) : null;
  const reserveB = lookup.vaultBalanceB ? BigInt(lookup.vaultBalanceB) : null;

  if (!reserveA || reserveA <= 0n || !reserveB || reserveB <= 0n) {
    // Return structural data — main thread will queue vault fetch
    return {
      poolId: lookup.poolId,
      dexHint: "pumpswap",
      success: true,
      pool: {
        id: lookup.poolId,
        dex: "PumpSwap",
        mint_a: mintA,
        mint_b: mintB,
        price_a_per_b: 0,
        fee_bps: lookup.cachedFeeBps ?? 25,
        pool_kind: "amm",
        updated_ms: Date.now(),
        was_swapped: false,
        native_mint_a: mintA,
        native_mint_b: mintB,
        decimals_a: decimalsA,
        decimals_b: decimalsB,
        native_account_a: vaultA,
        native_account_b: vaultB,
      },
      rawBufferIndex: idx,
    };
  }

  const processed = processPriceThroughPipeline({
    mintA,
    mintB,
    decimalsA,
    decimalsB,
    poolId: lookup.poolId,
    dex: "PumpSwap",
    poolType: "amm",
    reserveA,
    reserveB,
  });

  if (!processed) {
    return {
      poolId: lookup.poolId,
      dexHint: "pumpswap",
      success: false,
      error: "price_pipeline_failed",
      rawBufferIndex: idx,
    };
  }

  const pool: DecodedPoolFields = {
    id: lookup.poolId,
    dex: "PumpSwap",
    mint_a: processed.mintA,
    mint_b: processed.mintB,
    price_a_per_b: processed.priceForward,
    fee_bps: lookup.cachedFeeBps ?? 25,
    pool_kind: "amm",
    updated_ms: Date.now(),
    was_swapped: processed.wasSwapped,
    reserve_a_raw: reserveA.toString(),
    reserve_b_raw: reserveB.toString(),
    native_mint_a: mintA,
    native_mint_b: mintB,
    decimals_a: processed.decimalsA,
    decimals_b: processed.decimalsB,
    native_account_a: vaultA,
    native_account_b: vaultB,
  };

  return {
    poolId: lookup.poolId,
    dexHint: "pumpswap",
    success: true,
    pool,
    rawBufferIndex: idx,
  };
}

/**
 * Decode Meteora Balanced (DAMM) V1 or V2 pool account.
 * V1: Anchor decode ("pool") — vault-balance pricing.
 * V2: Manual offset parsing — sqrtPrice (Q64.64) pricing.
 */
async function decodeMeteoraBalanced(
  data: Buffer,
  lookup: PoolLookupData
): Promise<DecodedPoolResult> {
  const idx = 0;
  const owner = lookup.owner;

  // Determine if V1 or V2 from owner program
  const DAMM_V1 = "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB";
  const DAMM_V2 = "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG";
  const isV2 = owner === DAMM_V2;
  const isV1 = owner === DAMM_V1;

  if (!isV1 && !isV2) {
    return {
      poolId: lookup.poolId,
      dexHint: "meteora_balanced",
      success: false,
      error: "unknown_program",
      rawBufferIndex: idx,
    };
  }

  if (isV2) {
    return decodeMeteoraBalancedV2(data, lookup);
  }
  return decodeMeteoraBalancedV1(data, lookup);
}

/**
 * Decode Meteora DAMM V1 pool account.
 */
async function decodeMeteoraBalancedV1(
  data: Buffer,
  lookup: PoolLookupData
): Promise<DecodedPoolResult> {
  const idx = 0;

  // Try Anchor decode first, then manual offsets
  let mintA = "";
  let mintB = "";
  let vaultA = "";
  let vaultB = "";
  let feeBps = lookup.cachedFeeBps ?? 30;

  // Lazy-load DAMM V1 Anchor program
  if (!meteoraDammV1Program) {
    try {
      const { Program } = await import("@coral-xyz/anchor");
      const ammIdlMod = await import("@meteora-ag/dynamic-amm-sdk");
      const idl =
        (ammIdlMod as any).AmmIdl || (ammIdlMod as any).default?.AmmIdl;
      if (idl && Program) {
        // We need just the coder, not a full program instance
        // AnchorProvider not needed for offline decoding
        meteoraDammV1Program = { coder: (Program as any).coder?.(idl) || null };
      }
    } catch {
      // Manual fallback below
    }
  }

  let sdkDecoded = false;
  if (meteoraDammV1Program?.coder?.accounts?.decode) {
    try {
      const state = meteoraDammV1Program.coder.accounts.decode("pool", data);
      if (state) {
        mintA = pubkeyToBase58(state.tokenAMint);
        mintB = pubkeyToBase58(state.tokenBMint);
        vaultA = pubkeyToBase58(state.aVault);
        vaultB = pubkeyToBase58(state.bVault);
        // Extract fee from state
        if (state.fees?.tradeFeeNumerator && state.fees?.tradeFeeDenominator) {
          const num = Number(state.fees.tradeFeeNumerator);
          const den = Number(state.fees.tradeFeeDenominator);
          if (den > 0) feeBps = Math.round((num / den) * 10000);
        }
        sdkDecoded = true;
      }
    } catch {
      // Fall through to manual offsets
    }
  }

  if (!sdkDecoded) {
    // Manual offset decode: lpMint(8+32=40), tokenAMint(40+32=72), tokenBMint(72+32=104),
    // aVault(104+32=136), bVault(136+32=168)
    if (data.length < 200) {
      return {
        poolId: lookup.poolId,
        dexHint: "meteora_balanced",
        success: false,
        error: "buffer_too_small",
        rawBufferIndex: idx,
      };
    }
    try {
      mintA = new PublicKey(data.subarray(40, 72)).toBase58();
      mintB = new PublicKey(data.subarray(72, 104)).toBase58();
      vaultA = new PublicKey(data.subarray(104, 136)).toBase58();
      vaultB = new PublicKey(data.subarray(136, 168)).toBase58();
    } catch {
      return {
        poolId: lookup.poolId,
        dexHint: "meteora_balanced",
        success: false,
        error: "manual_decode_failed",
        rawBufferIndex: idx,
      };
    }
  }

  if (!mintA || !mintB) {
    return {
      poolId: lookup.poolId,
      dexHint: "meteora_balanced",
      success: false,
      error: "missing_mints",
      rawBufferIndex: idx,
    };
  }

  const decimalsA = lookup.decimalsA;
  const decimalsB = lookup.decimalsB;
  if (decimalsA == null || decimalsB == null) {
    return {
      poolId: lookup.poolId,
      dexHint: "meteora_balanced",
      success: false,
      skipReason: "decimals_pending",
      rawBufferIndex: idx,
    };
  }

  // V1 uses vault balances for pricing
  const reserveA = lookup.vaultBalanceA ? BigInt(lookup.vaultBalanceA) : null;
  const reserveB = lookup.vaultBalanceB ? BigInt(lookup.vaultBalanceB) : null;

  if (!reserveA || reserveA <= 0n || !reserveB || reserveB <= 0n) {
    return {
      poolId: lookup.poolId,
      dexHint: "meteora_balanced",
      success: true,
      pool: {
        id: lookup.poolId,
        dex: "MeteoraBalanced",
        mint_a: mintA,
        mint_b: mintB,
        price_a_per_b: 0,
        fee_bps: feeBps,
        pool_kind: "amm",
        updated_ms: Date.now(),
        was_swapped: false,
        native_mint_a: mintA,
        native_mint_b: mintB,
        decimals_a: decimalsA,
        decimals_b: decimalsB,
        native_account_a: vaultA,
        native_account_b: vaultB,
      },
      rawBufferIndex: idx,
    };
  }

  const processed = processPriceThroughPipeline({
    mintA,
    mintB,
    decimalsA,
    decimalsB,
    poolId: lookup.poolId,
    dex: "MeteoraBalanced",
    poolType: "amm",
    reserveA,
    reserveB,
  });

  if (!processed) {
    return {
      poolId: lookup.poolId,
      dexHint: "meteora_balanced",
      success: false,
      error: "price_pipeline_failed",
      rawBufferIndex: idx,
    };
  }

  const pool: DecodedPoolFields = {
    id: lookup.poolId,
    dex: "MeteoraBalanced",
    mint_a: processed.mintA,
    mint_b: processed.mintB,
    price_a_per_b: processed.priceForward,
    fee_bps: feeBps,
    pool_kind: "amm",
    updated_ms: Date.now(),
    was_swapped: processed.wasSwapped,
    reserve_a_raw: reserveA.toString(),
    reserve_b_raw: reserveB.toString(),
    native_mint_a: mintA,
    native_mint_b: mintB,
    decimals_a: processed.decimalsA,
    decimals_b: processed.decimalsB,
    native_account_a: vaultA,
    native_account_b: vaultB,
  };

  return {
    poolId: lookup.poolId,
    dexHint: "meteora_balanced",
    success: true,
    pool,
    rawBufferIndex: idx,
  };
}

/**
 * Decode Meteora DAMM V2 (CP-AMM) pool account via manual offset parsing.
 */
function decodeMeteoraBalancedV2(
  data: Buffer,
  lookup: PoolLookupData
): DecodedPoolResult {
  const idx = 0;

  if (data.length < 480) {
    return {
      poolId: lookup.poolId,
      dexHint: "meteora_balanced",
      success: false,
      error: "buffer_too_small",
      rawBufferIndex: idx,
    };
  }

  let mintA: string;
  let mintB: string;
  let vaultA: string;
  let vaultB: string;
  let sqrtPrice: bigint;
  let liquidity: bigint;

  try {
    mintA = new PublicKey(
      data.subarray(V2_OFFSET_TOKEN_A_MINT, V2_OFFSET_TOKEN_A_MINT + 32)
    ).toBase58();
    mintB = new PublicKey(
      data.subarray(V2_OFFSET_TOKEN_B_MINT, V2_OFFSET_TOKEN_B_MINT + 32)
    ).toBase58();
    vaultA = new PublicKey(
      data.subarray(V2_OFFSET_TOKEN_A_VAULT, V2_OFFSET_TOKEN_A_VAULT + 32)
    ).toBase58();
    vaultB = new PublicKey(
      data.subarray(V2_OFFSET_TOKEN_B_VAULT, V2_OFFSET_TOKEN_B_VAULT + 32)
    ).toBase58();

    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const sqrtPriceLow = dv.getBigUint64(V2_OFFSET_SQRT_PRICE, true);
    const sqrtPriceHigh = dv.getBigUint64(V2_OFFSET_SQRT_PRICE + 8, true);
    sqrtPrice = sqrtPriceLow + (sqrtPriceHigh << 64n);

    const liquidityLow = dv.getBigUint64(V2_OFFSET_LIQUIDITY, true);
    const liquidityHigh = dv.getBigUint64(V2_OFFSET_LIQUIDITY + 8, true);
    liquidity = liquidityLow + (liquidityHigh << 64n);
  } catch {
    return {
      poolId: lookup.poolId,
      dexHint: "meteora_balanced",
      success: false,
      error: "manual_decode_failed",
      rawBufferIndex: idx,
    };
  }

  if (!mintA || !mintB) {
    return {
      poolId: lookup.poolId,
      dexHint: "meteora_balanced",
      success: false,
      error: "missing_mints",
      rawBufferIndex: idx,
    };
  }

  const decimalsA = lookup.decimalsA;
  const decimalsB = lookup.decimalsB;
  if (decimalsA == null || decimalsB == null) {
    return {
      poolId: lookup.poolId,
      dexHint: "meteora_balanced",
      success: false,
      skipReason: "decimals_pending",
      rawBufferIndex: idx,
    };
  }

  // V2 uses sqrtPrice for pricing (concentrated liquidity formula)
  if (!sqrtPrice || sqrtPrice <= 0n) {
    return {
      poolId: lookup.poolId,
      dexHint: "meteora_balanced",
      success: false,
      error: "invalid_sqrt_price",
      rawBufferIndex: idx,
    };
  }

  const cpAmmPrice = calculateCpAmmPrice(sqrtPrice, decimalsA, decimalsB);
  if (!cpAmmPrice || !Number.isFinite(cpAmmPrice) || cpAmmPrice <= 0) {
    return {
      poolId: lookup.poolId,
      dexHint: "meteora_balanced",
      success: false,
      error: "price_calculation_failed",
      rawBufferIndex: idx,
    };
  }

  const processed = processPriceThroughPipeline({
    mintA,
    mintB,
    decimalsA,
    decimalsB,
    rawPrice: cpAmmPrice,
    poolId: lookup.poolId,
    dex: "MeteoraBalanced",
    poolType: "amm",
  });

  if (!processed) {
    return {
      poolId: lookup.poolId,
      dexHint: "meteora_balanced",
      success: false,
      error: "price_pipeline_failed",
      rawBufferIndex: idx,
    };
  }

  const pool: DecodedPoolFields = {
    id: lookup.poolId,
    dex: "MeteoraBalanced",
    mint_a: processed.mintA,
    mint_b: processed.mintB,
    price_a_per_b: processed.priceForward,
    fee_bps: lookup.cachedFeeBps ?? 30,
    pool_kind: "amm",
    updated_ms: Date.now(),
    was_swapped: processed.wasSwapped,
    sqrt_price_x64: Number(sqrtPrice),
    sqrt_price_x64_raw: sqrtPrice.toString(),
    liquidity: Number(liquidity),
    liquidity_raw: liquidity.toString(),
    native_mint_a: mintA,
    native_mint_b: mintB,
    decimals_a: processed.decimalsA,
    decimals_b: processed.decimalsB,
    native_decimals_a: decimalsA,
    native_decimals_b: decimalsB,
    native_account_a: vaultA,
    native_account_b: vaultB,
  };

  return {
    poolId: lookup.poolId,
    dexHint: "meteora_balanced",
    success: true,
    pool,
    rawBufferIndex: idx,
  };
}

// ── Batch decode entry point ───────────────────────────────────────────────

async function decodeBatch(
  request: DecodeJobRequest
): Promise<PoolDecodeWorkerResponse> {
  const t0 = performance.now();
  const results: DecodedPoolResult[] = [];

  for (let i = 0; i < request.events.length; i++) {
    const event = request.events[i];
    const data = Buffer.from(event.rawBuffer);
    const lookup = event.lookup;
    let result: DecodedPoolResult;

    try {
      switch (lookup.dexHint) {
        case "raydium":
          // Determine CLMM vs AMM V4 from data size and discriminator
          if (data.length === RAYDIUM_AMM_V4_DATA_SIZE) {
            result = await decodeRaydiumAmmV4(data, lookup);
          } else {
            result = await decodeRaydiumClmm(data, lookup);
          }
          break;
        case "raydium-cpmm":
          result = await decodeRaydiumCpmm(data, lookup);
          break;
        case "orca":
          result = await decodeOrca(data, lookup);
          break;
        case "meteora":
          result = await decodeMeteoraDlmm(data, lookup);
          break;
        case "pumpswap":
          result = await decodePumpswap(data, lookup);
          break;
        case "meteora_balanced":
          result = await decodeMeteoraBalanced(data, lookup);
          break;
        default:
          result = {
            poolId: lookup.poolId,
            dexHint: lookup.dexHint,
            success: false,
            error: `unknown_dex_hint: ${lookup.dexHint}`,
            rawBufferIndex: i,
          };
      }
    } catch (err) {
      result = {
        poolId: lookup.poolId,
        dexHint: lookup.dexHint,
        success: false,
        error: err instanceof Error ? err.message : String(err),
        rawBufferIndex: i,
      };
    }

    // Fix up rawBufferIndex to match batch position
    result.rawBufferIndex = i;
    results.push(result);
  }

  return {
    results,
    batchId: request.batchId,
    decodeTimeMs: performance.now() - t0,
    eventsProcessed: request.events.length,
  };
}

// ── Worker handler ─────────────────────────────────────────────────────────

exposeWorkerHandler<PoolDecodeWorkerRequest, PoolDecodeWorkerResponse>(
  async (request) => {
    if (!request) {
      throw new Error("Pool decode worker received empty request");
    }
    switch (request.kind) {
      case "decodeBatch":
        return decodeBatch(request.payload);
      default:
        throw new Error(
          `Unknown pool decode request kind: ${(request as any)?.kind}`
        );
    }
  }
);
