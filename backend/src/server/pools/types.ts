export type AmmPool = {
  id: string;
  dex: string;
  mint_a: string;
  mint_b: string;
  fee_bps: number;
  price_a_per_b: number;
  liquidity_base: number;
  updated_ms: number;
  // Optional vault accounts corresponding to mint_a and mint_b
  account_a?: string;
  account_b?: string;
  native_account_a?: string;
  native_account_b?: string;
  native_mint_a?: string;
  native_mint_b?: string;
  native_decimals_a?: number;
  native_decimals_b?: number;
  native_reserve_a_raw?: string;
  native_reserve_b_raw?: string;
  pool_kind?: 'amm';
  amount_a_whole?: number;
  amount_b_whole?: number;
  amounts_are_whole?: boolean;
  tvl_usd?: number;
  // Enrichments when known
  decimals_a?: number;
  decimals_b?: number;
  pool_liquidity_raw?: number; // min(amount_a_whole, amount_b_whole) when available
  liquidity_display?: number;  // prefer pool_liquidity_raw for display when available
  liquidity_base_raw?: string;
  reserve_a_raw?: string;
  reserve_b_raw?: string;
  was_swapped?: boolean;
  price_a_per_b_num?: string;
  price_a_per_b_den?: string;
  price_a_per_b_exact?: string;
  // Raydium AMM-specific: Serum market accounts (required for swaps)
  market_id?: string;              // Serum market address
  market_program_id?: string;      // Serum/OpenBook program ID
  market_bids?: string;            // Serum bids account
  market_asks?: string;            // Serum asks account
  market_event_queue?: string;     // Serum event queue
  market_base_vault?: string;      // Serum base vault
  market_quote_vault?: string;     // Serum quote vault
  market_authority?: string;       // Serum vault signer
  amm_authority?: string;          // Raydium pool authority
  owner?: string;                  // Alternative field name for amm_authority
  amm_open_orders?: string;        // Raydium open orders account
  amm_target_orders?: string;      // Raydium target orders account
  lp_mint?: string;                // LP token mint
  lp_supply?: string;              // LP token supply (for rugpull detection)
  // Rugpull detection flags
  is_rugpulled?: boolean;          // True if LP supply is zero but vaults have tokens
  vault_a_whole?: number;          // Vault A balance in whole tokens (for debugging)
  vault_b_whole?: number;          // Vault B balance in whole tokens (for debugging)
};

export type ClmmPool = {
  id: string;
  dex: string;
  mint_a: string;
  mint_b: string;
  fee_bps: number;
  sqrt_price_x64: number;
  liquidity: number;
  tick_spacing: number;
  updated_ms: number;
  // Optional enrichments for coherence across DEX feeds
  price_a_per_b?: number;
  amount_a?: number;
  amount_b?: number;
  decimals_a?: number;
  decimals_b?: number;
  native_account_a?: string;
  native_account_b?: string;
  native_mint_a?: string;
  native_mint_b?: string;
  native_decimals_a?: number;
  native_decimals_b?: number;
  native_reserve_a_raw?: string;
  native_reserve_b_raw?: string;
  was_swapped?: boolean;
  active_id?: number;
  bin_step?: number;
  // Optional token vault accounts for CLMM pool
  account_a?: string;
  account_b?: string;
  pool_kind?: 'clmm';
  pool_liquidity_raw?: number;
  tvl_usd?: number;
  amount_a_whole?: number;
  amount_b_whole?: number;
  liquidity_display?: number;  // prefer pool_liquidity_raw for display when available
  sqrt_price_x64_raw?: string;
  liquidity_raw?: string;
  price_a_per_b_num?: string;
  price_a_per_b_den?: string;
  price_a_per_b_exact?: string;
  // Execution-critical accounts (cached to avoid RPC calls during instruction building)
  // Meteora DLMM-specific
  bin_array_bitmap_extension?: string;  // PDA for tracking initialized bin arrays
  token_program_a?: 'spl-token' | 'token-2022';
  token_program_b?: 'spl-token' | 'token-2022';
  meteora_bin_hash?: string;
  bin_array_lower?: string;
  bin_array_upper?: string;
  // Raydium CLMM-specific
  observation_state?: string;           // Observation state account (oracle data)
  ex_bitmap?: string;                   // Extended bitmap for tick array tracking
  tick_array_lower?: string;
  tick_array_center?: string;
  tick_array_upper?: string;
  // Orca Whirlpool-specific
  oracle?: string;                      // Oracle account for price observation
  token_vault_a?: string;               // Token vault A (alternative name for account_a)
  token_vault_b?: string;               // Token vault B (alternative name for account_b)
};

export type PoolsPayload = { amm: AmmPool[]; clmm: ClmmPool[] };

/**
 * Lightweight pool summary for early filtering (before detail fetch + RPC enrichment).
 * Contains only the fields needed for universe and min pools filtering.
 */
export type SummaryPool = {
  pubkey: string;
  mint_a: string;
  mint_b: string;
  dex: 'raydium' | 'raydium-clmm' | 'orca' | 'meteora' | 'pumpswap';
  type: 'amm' | 'clmm';
  _updatedAt?: string;
};

/**
 * Aggregated summary results from all DEXes, used for early filtering.
 */
export type DexSummaries = {
  raydiumAmm: SummaryPool[];
  raydiumClmm: SummaryPool[];
  orca: SummaryPool[];
  meteora: SummaryPool[];
  pumpswap: SummaryPool[];
};

/**
 * Survivor pool IDs after early filtering, grouped by DEX.
 */
export type SurvivorPoolIds = {
  raydiumAmm: Set<string>;
  raydiumClmm: Set<string>;
  orca: Set<string>;
  meteora: Set<string>;
  pumpswap: Set<string>;
};

