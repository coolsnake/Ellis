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
  amm_open_orders?: string;        // Raydium open orders account
  amm_target_orders?: string;      // Raydium target orders account
  lp_mint?: string;                // LP token mint
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
};

export type PoolsPayload = { amm: AmmPool[]; clmm: ClmmPool[] };


