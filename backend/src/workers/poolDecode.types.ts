/**
 * Types for the worker thread pool decode pipeline.
 *
 * The decode pipeline splits WSS event processing into:
 * 1. Decode phase (worker thread) — pure SDK parsing + price math
 * 2. Apply phase (main thread) — cache mutations + graph scheduling
 *
 * Messages are sent via postMessage; Buffer payloads are transferable (zero-copy).
 */

// ── Lookup data snapshot (main thread → worker) ────────────────────────────

/** Cache snapshot sent alongside raw buffer so the worker can compute prices */
export interface PoolLookupData {
  poolId: string;
  owner: string; // Program owner base58
  dexHint: DexHint;

  // Decimals (null = not yet resolved — worker will skip)
  decimalsA: number | null;
  decimalsB: number | null;

  // Cached pool data for orientation / delta detection
  cachedMintA?: string; // native mint A from pool cache
  cachedMintB?: string; // native mint B from pool cache
  cachedWasSwapped?: boolean;
  cachedFeeBps?: number; // fee_bps from cache (CLMM fees live in ammConfig)

  // Vault balances for AMM-type pools (CPMM, PumpSwap, Meteora Balanced)
  vaultBalanceA?: string; // bigint as string
  vaultBalanceB?: string;
  vaultAddressA?: string;
  vaultAddressB?: string;
}

export type DexHint =
  | "raydium"
  | "raydium-cpmm"
  | "orca"
  | "meteora"
  | "pumpswap"
  | "meteora_balanced";

// ── Batch request (main thread → worker) ────────────────────────────────────

export interface DecodeJobEvent {
  lookup: PoolLookupData;
  /** Raw account data. Transferred zero-copy via postMessage transfer list. */
  rawBuffer: Buffer;
}

export interface DecodeJobRequest {
  events: DecodeJobEvent[];
  batchId: number;
  batchTimestampMs: number;
}

// ── Decoded result (worker → main thread) ───────────────────────────────────

export interface DecodedPoolFields {
  id: string;
  dex: string;
  mint_a: string;
  mint_b: string;
  price_a_per_b: number;
  fee_bps: number;
  pool_kind: "amm" | "clmm" | "dlmm" | "cpmm";
  updated_ms: number;
  was_swapped: boolean;

  // CLMM fields
  sqrt_price_x64?: number;
  sqrt_price_x64_raw?: string;
  liquidity?: number;
  liquidity_raw?: string;
  tick_spacing?: number;
  tick_current_index?: number;
  native_tick_current_index?: number;

  // AMM fields
  reserve_a_raw?: string;
  reserve_b_raw?: string;
  liquidity_base?: number;

  // Orientation
  native_mint_a: string;
  native_mint_b: string;
  decimals_a: number;
  decimals_b: number;
  native_decimals_a?: number;
  native_decimals_b?: number;
  native_reserve_a_raw?: string;
  native_reserve_b_raw?: string;

  // Vault accounts (extracted from on-chain data)
  native_account_a?: string;
  native_account_b?: string;

  // Meteora DLMM
  active_id?: number;
  bin_step?: number;
  bin_array_bitmap_extension?: string;

  // Raydium CLMM execution cache fields
  observation_state?: string;
  amm_config?: string;

  // Orca execution cache fields
  oracle?: string;
  token_vault_a?: string;
  token_vault_b?: string;
}

export interface DecodedPoolResult {
  poolId: string;
  dexHint: DexHint;
  success: boolean;

  /** Decoded pool data (present when success=true) */
  pool?: DecodedPoolFields;

  /** Error message on decode failure */
  error?: string;
  /** Structured skip reason (e.g. 'decimals_pending', 'discriminator_mismatch') */
  skipReason?: string;

  /** Index into original batch (for buffer retrieval on fallback) */
  rawBufferIndex: number;
}

// ── Batch response (worker → main thread) ───────────────────────────────────

export interface DecodeJobResponse {
  results: DecodedPoolResult[];
  batchId: number;
  decodeTimeMs: number;
  eventsProcessed: number;
}

// ── Worker message wrappers (used by WorkerClient<TIn, TOut>) ───────────────

export type PoolDecodeWorkerRequest = {
  kind: "decodeBatch";
  payload: DecodeJobRequest;
};

export type PoolDecodeWorkerResponse = DecodeJobResponse;
