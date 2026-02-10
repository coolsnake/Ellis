/**
 * Centralized pool account discriminators and subscription filter builders.
 *
 * Provides server-side filters for both WSS (programSubscribe) and gRPC
 * (Yellowstone) program-level subscriptions. Filters reject non-pool accounts
 * at the RPC/gRPC provider before data reaches our process, reducing incoming
 * event volume by 60-80%.
 *
 * Anchor account discriminator = sha256("account:<PascalCaseName>")[0..8]
 */

import crypto from "crypto";
import bs58 from "bs58";

// ── Anchor discriminator computation ────────────────────────────────────────

/**
 * Compute the 8-byte Anchor account discriminator for a given account name.
 * @param accountName PascalCase account name as it appears in the IDL
 */
export function computeAnchorAccountDiscriminator(
  accountName: string
): Buffer {
  const preimage = `account:${accountName}`;
  return Buffer.from(
    crypto.createHash("sha256").update(preimage).digest().subarray(0, 8)
  );
}

// ── Program IDs ─────────────────────────────────────────────────────────────

export const PROGRAM_IDS = {
  RAYDIUM_AMM_V4:
    "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
  RAYDIUM_CLMM:
    "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
  RAYDIUM_CPMM:
    "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
  ORCA_WHIRLPOOL:
    "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
  METEORA_DLMM:
    "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
  METEORA_DAMM_V1:
    "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB",
  METEORA_DAMM_V2:
    "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG",
  PUMPSWAP_BONDING:
    "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  PUMPSWAP_AMM:
    "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
} as const;

// ── Precomputed discriminator buffers (authoritative source) ────────────────
// Cross-reference with existing per-decoder constants:
//   CLMM_POOL_DISCRIMINATOR        → decoders/raydium.ts:51
//   CPMM_POOL_DISCRIMINATOR        → decoders/raydiumCpmm.ts:50
//   WHIRLPOOL_DISCRIMINATOR        → decoders/orca.ts:151
//   PUMPSWAP_POOL_DISCRIMINATOR    → decoders/pumpswap.ts:73

export const DISCRIMINATORS = {
  /** Raydium CLMM PoolState — sha256("account:PoolState")[0..8] */
  RAYDIUM_CLMM_POOL: computeAnchorAccountDiscriminator("PoolState"),
  /** Raydium CPMM PoolState — same discriminator as CLMM (same account name) */
  RAYDIUM_CPMM_POOL: computeAnchorAccountDiscriminator("PoolState"),
  /** Orca Whirlpool — sha256("account:Whirlpool")[0..8] */
  ORCA_WHIRLPOOL: computeAnchorAccountDiscriminator("Whirlpool"),
  /** PumpSwap Pool — sha256("account:Pool")[0..8] */
  PUMPSWAP_POOL: computeAnchorAccountDiscriminator("Pool"),
  /** Meteora DLMM LbPair — sha256("account:LbPair")[0..8] */
  METEORA_DLMM_LB_PAIR: computeAnchorAccountDiscriminator("LbPair"),
  /** Meteora DAMM v1/v2 Pool — sha256("account:Pool")[0..8] (same bytes as PumpSwap, different program) */
  METEORA_DAMM_POOL: computeAnchorAccountDiscriminator("Pool"),
} as const;

/** Raydium AMM v4 is non-Anchor; pool accounts are exactly 752 bytes. */
export const RAYDIUM_AMM_V4_DATA_SIZE = 752;

// ── WSS filter builders (@solana/web3.js programSubscribe) ──────────────────
// Filter types accepted by onProgramAccountChange config:
//   { memcmp: { offset: number; bytes: string } }  — bytes is base58-encoded
//   { dataSize: number }

export type WssMemcmpFilter = { memcmp: { offset: number; bytes: string } };
export type WssDataSizeFilter = { dataSize: number };
export type WssFilter = WssMemcmpFilter | WssDataSizeFilter;

function wssMemcmp(offset: number, discriminator: Buffer): WssMemcmpFilter {
  return { memcmp: { offset, bytes: bs58.encode(discriminator) } };
}

function wssDataSize(size: number): WssDataSizeFilter {
  return { dataSize: size };
}

/** Get WSS subscription filters for a DEX program. Returns [] if no filter available. */
export function getWssFiltersForProgram(programId: string): WssFilter[] {
  switch (programId) {
    case PROGRAM_IDS.RAYDIUM_AMM_V4:
      return [wssDataSize(RAYDIUM_AMM_V4_DATA_SIZE)];
    case PROGRAM_IDS.RAYDIUM_CLMM:
      return [wssMemcmp(0, DISCRIMINATORS.RAYDIUM_CLMM_POOL)];
    case PROGRAM_IDS.RAYDIUM_CPMM:
      return [wssMemcmp(0, DISCRIMINATORS.RAYDIUM_CPMM_POOL)];
    case PROGRAM_IDS.ORCA_WHIRLPOOL:
      return [wssMemcmp(0, DISCRIMINATORS.ORCA_WHIRLPOOL)];
    case PROGRAM_IDS.METEORA_DLMM:
      return [wssMemcmp(0, DISCRIMINATORS.METEORA_DLMM_LB_PAIR)];
    case PROGRAM_IDS.METEORA_DAMM_V1:
    case PROGRAM_IDS.METEORA_DAMM_V2:
      return [wssMemcmp(0, DISCRIMINATORS.METEORA_DAMM_POOL)];
    case PROGRAM_IDS.PUMPSWAP_AMM:
    case PROGRAM_IDS.PUMPSWAP_BONDING:
      return [wssMemcmp(0, DISCRIMINATORS.PUMPSWAP_POOL)];
    default:
      return [];
  }
}

// ── gRPC filter builders (Yellowstone SubscribeRequest) ─────────────────────
// Yellowstone filter types (from @triton-one/yellowstone-grpc):
//   { memcmp: { offset: string; base58: string } }
//   { datasize: string }

export interface GrpcMemcmpFilter {
  memcmp: { offset: string; base58: string };
}
export interface GrpcDataSizeFilter {
  datasize: string;
}
export type GrpcAccountFilter = GrpcMemcmpFilter | GrpcDataSizeFilter;

function grpcMemcmp(
  offset: number,
  discriminator: Buffer
): GrpcMemcmpFilter {
  return {
    memcmp: { offset: String(offset), base58: bs58.encode(discriminator) },
  };
}

function grpcDataSize(size: number): GrpcDataSizeFilter {
  return { datasize: String(size) };
}

/** Get gRPC subscription filters for a DEX program. Returns [] if no filter available. */
export function getGrpcFiltersForProgram(
  programId: string
): GrpcAccountFilter[] {
  switch (programId) {
    case PROGRAM_IDS.RAYDIUM_AMM_V4:
      return [grpcDataSize(RAYDIUM_AMM_V4_DATA_SIZE)];
    case PROGRAM_IDS.RAYDIUM_CLMM:
      return [grpcMemcmp(0, DISCRIMINATORS.RAYDIUM_CLMM_POOL)];
    case PROGRAM_IDS.RAYDIUM_CPMM:
      return [grpcMemcmp(0, DISCRIMINATORS.RAYDIUM_CPMM_POOL)];
    case PROGRAM_IDS.ORCA_WHIRLPOOL:
      return [grpcMemcmp(0, DISCRIMINATORS.ORCA_WHIRLPOOL)];
    case PROGRAM_IDS.METEORA_DLMM:
      return [grpcMemcmp(0, DISCRIMINATORS.METEORA_DLMM_LB_PAIR)];
    case PROGRAM_IDS.METEORA_DAMM_V1:
    case PROGRAM_IDS.METEORA_DAMM_V2:
      return [grpcMemcmp(0, DISCRIMINATORS.METEORA_DAMM_POOL)];
    case PROGRAM_IDS.PUMPSWAP_AMM:
    case PROGRAM_IDS.PUMPSWAP_BONDING:
      return [grpcMemcmp(0, DISCRIMINATORS.PUMPSWAP_POOL)];
    default:
      return [];
  }
}

/** Human-readable name for a program ID (for logging). */
export function programName(programId: string): string {
  for (const [name, id] of Object.entries(PROGRAM_IDS)) {
    if (id === programId)
      return name.toLowerCase().replace(/_/g, "-");
  }
  return programId.slice(0, 8) + "…";
}
