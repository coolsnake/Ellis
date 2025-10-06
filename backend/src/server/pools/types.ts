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
};

export type PoolsPayload = { amm: AmmPool[]; clmm: ClmmPool[] };


