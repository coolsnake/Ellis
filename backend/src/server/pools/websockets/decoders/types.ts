/**
 * Shared types for WebSocket pool decoders
 * 
 * These types define the common interfaces used across all DEX-specific decoders
 */

import type { AmmPool, ClmmPool, PoolsPayload } from '../../types.js';

/**
 * DEX source identifier
 * - Raydium variants: raydium (AMM/CLMM combined), raydium-cpmm
 * - Meteora variants: meteora_dlmm (DLMM), meteora_damm_v1 (Dynamic AMM v1), meteora_damm_v2 (CP-AMM)
 */
export type DexSource = 
  | 'raydium' | 'raydium-cpmm' 
  | 'orca' 
  | 'meteora_dlmm' | 'meteora_damm_v1' | 'meteora_damm_v2' 
  | 'pumpswap';

/**
 * Pool type identifier
 */
export type PoolType = 'amm' | 'clmm' | 'cpmm';

/**
 * Decoded pool result from a WebSocket update
 * This is the common output format all decoders produce
 */
export interface DecodedPool {
  id: string;
  dex: string;
  mint_a: string;
  mint_b: string;
  price_a_per_b: number;
  fee_bps: number;
  updated_ms: number;
  pool_kind: PoolType;
  
  // CLMM-specific fields
  sqrt_price_x64?: number;
  sqrt_price_x64_raw?: string;
  liquidity?: number;
  liquidity_raw?: string;
  tick_spacing?: number;
  tick_current_index?: number;
  native_tick_current_index?: number;
  
  // AMM-specific fields
  reserve_a_raw?: string;
  reserve_b_raw?: string;
  liquidity_base?: number;
  
  // Common enrichments
  decimals_a?: number;
  decimals_b?: number;
  was_swapped?: boolean;
  native_mint_a?: string;
  native_mint_b?: string;
  native_decimals_a?: number;
  native_decimals_b?: number;
  native_account_a?: string;
  native_account_b?: string;
  native_reserve_a_raw?: string;
  native_reserve_b_raw?: string;
  onchain_base_mint?: string;
  onchain_quote_mint?: string;
  onchain_base_vault?: string;
  onchain_quote_vault?: string;
  
  // Vault accounts
  account_a?: string;
  account_b?: string;
  
  // Display/UI fields
  liquidity_display?: number;
  tvl_usd?: number;
  pool_liquidity_raw?: number;
  
  // Pipeline processing flag
  _pipelineProcessed?: boolean;
  
  // Meteora DLMM-specific
  active_id?: number;
  bin_step?: number;
  bin_array_bitmap_extension?: string;
  
  // Raydium CLMM-specific
  observation_state?: string;
  tick_array_lower?: string;
  tick_array_center?: string;
  tick_array_upper?: string;
  
  // Orca-specific
  oracle?: string;
  token_vault_a?: string;
  token_vault_b?: string;
}

/**
 * Pool delta - changes detected from a WebSocket update
 */
export interface PoolDelta {
  amm: AmmPool[];
  clmm: ClmmPool[];
  addedAmm?: number;
  removedAmm?: number;
  addedClmm?: number;
  removedClmm?: number;
}

/**
 * Result of handling a WebSocket update
 */
export interface UpdateResult {
  success: boolean;
  pool?: DecodedPool;
  delta?: PoolDelta;
  error?: string;
  skipped?: boolean;
  skipReason?: string;
}

/**
 * Account info from WebSocket subscription
 */
export interface AccountInfo {
  data: Buffer;
  executable: boolean;
  lamports: number;
  owner: { toBase58(): string } | string;
  rentEpoch?: number;
}

/**
 * Processed price result from price pipeline
 */
export interface ProcessedPriceResult {
  mintA: string;
  mintB: string;
  priceForward: number;
  priceReverse: number;
  wasSwapped: boolean;
  decimalsA: number;
  decimalsB: number;
  amountA?: bigint;
  amountB?: bigint;
  amountAWhole?: number;
  amountBWhole?: number;
}

/**
 * Validation result for decoded pools
 */
export interface ValidationResult {
  valid: boolean;
  reasons: string[];
}

/**
 * Cache interface for pool data
 */
export interface PoolCache {
  data: PoolsPayload | null;
  ts: number;
}

/**
 * Derived account info mapping
 */
export interface DerivedAccountInfo {
  poolId: string;
  accountType: 'vault' | 'reserve' | 'tick_array' | 'oracle' | 'observation';
  vaultSide?: 'A' | 'B';  // For AMM pools: which side of the pair
  otherVault?: string;    // For AMM pools: address of the other vault
}

/**
 * Execution cache fields derived from account data
 */
export interface DerivedCacheFields {
  programId?: string;
  oracle?: string;
  observationState?: string;
  ammConfig?: string;
  vaultA?: string;
  vaultB?: string;
  tickSpacing?: number;
  tickCurrent?: number;
  tickArrays?: {
    lower?: string | string[];
    center?: string;
    upper?: string | string[];
  };
}

/**
 * Context for decoder operations
 */
export interface DecoderContext {
  poolId: string;
  accountData: Buffer;
  owner: string;
  derivedAccountToPool: Map<string, DerivedAccountInfo>;
}

/**
 * Decoder handler function type
 */
export type DecoderHandler = (
  info: AccountInfo,
  poolId: string,
  context?: DecoderContext
) => Promise<UpdateResult>;

/**
 * Decode function type
 */
export type DecodeFunction<T = DecodedPool> = (
  accountData: Buffer,
  poolId: string
) => T | null;


