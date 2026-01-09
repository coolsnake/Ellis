/**
 * API Response Types for DEX Pool Fetchers
 * 
 * This file defines strict TypeScript interfaces for all DEX API responses
 * to improve type safety and catch errors at compile time.
 */

// =============================================================================
// RAYDIUM API TYPES
// =============================================================================

/** Mint info as returned by Raydium API */
export interface RaydiumMintInfo {
  address: string;
  decimals: number;
  symbol?: string;
  name?: string;
}

/** Raydium pool response from /pools/info/list or /pools/info/mint */
export interface RaydiumPoolApiResponse {
  id: string;
  mintA: RaydiumMintInfo | string;
  mintB: RaydiumMintInfo | string;
  feeRate?: number;
  tradeFeeRate?: number;
  feeBps?: number;
  tradeFeeBps?: number;
  tvl?: number;
  // Pool type discrimination
  poolType?: 'STANDARD' | 'CLMM' | 'CPMM';
  type?: string;
  // CLMM-specific fields
  sqrtPriceX64?: string;
  sqrtPrice?: string;
  tickSpacing?: number;
  liquidity?: string | number;
  // AMM-specific fields
  reserveA?: string;
  reserveB?: string;
  mintAmountA?: string;
  mintAmountB?: string;
  // Alternative ID fields
  address?: string;
  pool_id?: string;
  ammId?: string;
}

/** Raydium API list response wrapper */
export interface RaydiumApiListResponse {
  data?: {
    data?: RaydiumPoolApiResponse[];
    hasNextPage?: boolean;
  };
}

// =============================================================================
// ORCA API TYPES
// =============================================================================

/** Orca token info */
export interface OrcaTokenInfo {
  mint: string;
  decimals: number;
  symbol?: string;
  name?: string;
}

/** Orca Whirlpool API response */
export interface OrcaPoolApiResponse {
  address: string;
  tokenA?: OrcaTokenInfo;
  tokenB?: OrcaTokenInfo;
  token_a?: OrcaTokenInfo;
  token_b?: OrcaTokenInfo;
  // Mint addresses (alternative format)
  tokenMintA?: string;
  tokenMintB?: string;
  mintA?: string;
  mintB?: string;
  // Decimals (alternative format)
  decimalsA?: number;
  decimalsB?: number;
  tokenDecimalsA?: number;
  tokenDecimalsB?: number;
  // Price data
  sqrtPrice?: string;
  sqrtPriceX64?: string;
  // Pool state
  tickSpacing?: number;
  liquidity?: string | number;
  // Vault accounts
  tokenVaultA?: string;
  tokenVaultB?: string;
  token_vault_a?: string;
  token_vault_b?: string;
  vaultA?: string;
  vaultB?: string;
  // Fee info
  tradingFeeRate?: number;
  tradeFeeRate?: number;
  feeRate?: number;
  fee?: number;
  makerFee?: number;
  takerFee?: number;
  protocolFeeRate?: number;
  protocolFee?: number;
  fee_bps?: number;
  feeBps?: number;
  fee_in_bps?: number;
  // TVL
  tvlUsdc?: number | string;
  tvlUsd?: number | string;
  // Pool type
  type?: string;
  poolType?: string;
  // Balance data
  tokenBalanceA?: string | number;
  tokenBalanceB?: string | number;
  tokenAAmount?: string | number;
  tokenBAmount?: string | number;
  token_a_amount?: string | number;
  token_b_amount?: string | number;
  amountA?: string | number;
  amountB?: string | number;
  baseAmount?: string | number;
  quoteAmount?: string | number;
  // Oracle
  oracle?: string;
  // State object (nested)
  state?: {
    sqrtPriceX64?: string;
    sqrtPrice?: string;
    tickSpacing?: number;
    liquidity?: string | number;
  };
  // ID alternatives
  id?: string;
}

// =============================================================================
// METEORA DLMM API TYPES
// =============================================================================

/** Meteora DLMM token info */
export interface MeteoraTokenInfo {
  mint?: string;
  decimals?: number;
}

/** Meteora DLMM pool API response */
export interface MeteoraPoolApiResponse {
  address: string;
  id?: string;
  poolAddress?: string;
  // Mint addresses (X/Y convention)
  mint_x: string;
  mint_y: string;
  tokenXMint?: string;
  tokenYMint?: string;
  // Token objects
  tokenA?: MeteoraTokenInfo;
  tokenX?: MeteoraTokenInfo;
  tokenB?: MeteoraTokenInfo;
  tokenY?: MeteoraTokenInfo;
  // DLMM specific
  active_id?: number;
  activeId?: number;
  bin_step?: number;
  binStep?: number;
  // Reserve accounts
  reserve_x?: string;
  reserve_y?: string;
  reserveX?: string;
  reserveY?: string;
  // Reserve amounts
  reserve_x_amount?: string | number;
  reserve_y_amount?: string | number;
  tokenBalanceA?: string | number;
  tokenBalanceB?: string | number;
  tokenAAmount?: string | number;
  tokenBAmount?: string | number;
  amountA?: string | number;
  amountB?: string | number;
  baseAmount?: string | number;
  quoteAmount?: string | number;
  // Fee info
  feeRate?: number;
  // TVL
  tvlUsdc?: number | string;
  tvlUsd?: number | string;
  liquidity?: number | string;
  // Decimals (from token objects)
  decimalsA?: number;
  decimalsB?: number;
}

/** Meteora API list response wrapper */
export interface MeteoraApiListResponse {
  pairs?: MeteoraPoolApiResponse[];
  data?: MeteoraPoolApiResponse[];
}

// =============================================================================
// METEORA BALANCED (DAMM) API TYPES
// =============================================================================

/** Meteora Balanced pool API response */
export interface MeteoraBalancedPoolApiResponse {
  pool_address: string;
  address?: string;
  id?: string;
  // Token mints
  token_a_mint: string;
  token_b_mint: string;
  mintA?: string;
  mintB?: string;
  // Vault accounts
  token_a_vault?: string;
  token_b_vault?: string;
  // Token info objects
  tokenA?: MeteoraTokenInfo & { info?: MeteoraTokenInfo };
  tokenB?: MeteoraTokenInfo & { info?: MeteoraTokenInfo };
  mintA_obj?: MeteoraTokenInfo;
  mintB_obj?: MeteoraTokenInfo;
  base?: MeteoraTokenInfo & { info?: MeteoraTokenInfo };
  quote?: MeteoraTokenInfo & { info?: MeteoraTokenInfo };
  // Decimals
  decimalsA?: number;
  decimalsB?: number;
  // Reserves (raw atomic or whole)
  reserveA?: string | number;
  reserveB?: string | number;
  amountA?: string | number;
  amountB?: string | number;
  tokenAmountA?: string | number;
  tokenAmountB?: string | number;
  // Enriched whole amounts (from RPC)
  vault_a_whole?: number;
  vault_b_whole?: number;
  // Fee info (v2 format)
  base_fee?: number;
  dynamic_fee?: number;
  feeRate?: number;
  tradeFeeRate?: number;
  tradeFeeBps?: number;
  feeBps?: number;
  // Price
  price?: number;
  price_a_per_b?: number;
  priceAperB?: number;
  // TVL
  tvl?: number | string;
  tvlUsd?: number | string;
  tvl_usd?: number | string;
  // Pool version (1 or 2)
  pool_version?: number;
}

// =============================================================================
// PUMPSWAP API TYPES
// =============================================================================

/** Pumpswap GraphQL pool response */
export interface PumpswapPoolApiResponse {
  pubkey: string;
  base_mint: string;
  quote_mint: string;
  creator?: string;
  onchain_creator?: string; // On-chain pool creator (extracted from pool account data during enrichment)
  lp_mint?: string;
  lp_supply?: string | number;
  pool_base_token_account?: string;
  pool_quote_token_account?: string;
  pool_base_token_vault?: string;
  pool_quote_token_vault?: string;
  pool_bump?: number;
  index?: number;
  // Enriched from RPC - reserves in atomic units
  base_reserve_raw?: string;
  quote_reserve_raw?: string;
  // Alternate property names used in some API responses
  base_reserve?: string;
  quote_reserve?: string;
  // Whole unit amounts (human-readable)
  base_reserve_whole?: number;
  quote_reserve_whole?: number;
  fee_bps?: number;
  // Derived addresses
  coin_creator_vault_ata?: string;
  coin_creator_vault_authority?: string;
  protocol_fee_recipient?: string;
}

/** Pumpswap GraphQL response wrapper */
export interface PumpswapGraphQLResponse {
  data?: {
    pump_fun_amm_Pool?: PumpswapPoolApiResponse[];
  };
  errors?: Array<{ message: string }>;
}

// =============================================================================
// RAYDIUM CPMM API TYPES
// =============================================================================

/** Raydium CPMM pool API response from Shyft GraphQL */
export interface RaydiumCpmmPoolApiResponse {
  pubkey: string;
  token0Mint: string;
  token1Mint: string;
  token0Vault: string;
  token1Vault: string;
  token0Program?: string;
  token1Program?: string;
  lpMint?: string;
  lpSupply?: string | number;
  ammConfig: string;
  observationKey?: string;
  creator?: string;
  status?: number;
  mintDecimals0?: number;
  mintDecimals1?: number;
  bump?: number;
  openTime?: number | string;
  // Reserve amounts (if provided by API)
  token0Amount?: string | number;
  token1Amount?: string | number;
  // Derived/enriched fields
  reserve0_raw?: string;
  reserve1_raw?: string;
  _updatedAt?: string;
}

/** Raydium CPMM GraphQL response wrapper */
export interface RaydiumCpmmGraphQLResponse {
  data?: {
    Raydium_CPMM_PoolState?: RaydiumCpmmPoolApiResponse[];
  };
  errors?: Array<{ message: string }>;
}

// =============================================================================
// TYPE GUARDS (Runtime Validation)
// =============================================================================

/**
 * Validates if an object is a valid Raydium pool API response
 */
export function isValidRaydiumPool(raw: unknown): raw is RaydiumPoolApiResponse {
  if (typeof raw !== 'object' || raw === null) return false;
  const obj = raw as Record<string, unknown>;
  
  // Must have an ID
  const hasId = typeof obj.id === 'string' || 
                typeof obj.address === 'string' || 
                typeof obj.pool_id === 'string' ||
                typeof obj.ammId === 'string';
  if (!hasId) return false;
  
  // Must have mintA and mintB (either string or object with address)
  const mintA = obj.mintA;
  const mintB = obj.mintB;
  const hasMintA = typeof mintA === 'string' || 
                   (typeof mintA === 'object' && mintA !== null && typeof (mintA as any).address === 'string');
  const hasMintB = typeof mintB === 'string' || 
                   (typeof mintB === 'object' && mintB !== null && typeof (mintB as any).address === 'string');
  
  return hasMintA && hasMintB;
}

/**
 * Validates if an object is a valid Orca pool API response
 */
export function isValidOrcaPool(raw: unknown): raw is OrcaPoolApiResponse {
  if (typeof raw !== 'object' || raw === null) return false;
  const obj = raw as Record<string, unknown>;
  
  // Must have an address/id
  const hasId = typeof obj.address === 'string' || typeof obj.id === 'string';
  if (!hasId) return false;
  
  // Must have token info (various formats)
  const tokenA = obj.tokenA || obj.token_a;
  const tokenB = obj.tokenB || obj.token_b;
  const hasMints = (
    // Object format with mint
    (typeof tokenA === 'object' && tokenA !== null && typeof (tokenA as any).mint === 'string') ||
    // Direct mint fields
    typeof obj.tokenMintA === 'string' ||
    typeof obj.mintA === 'string'
  );
  
  return hasMints;
}

/**
 * Validates if an object is a valid Meteora DLMM pool API response
 */
export function isValidMeteoraPool(raw: unknown): raw is MeteoraPoolApiResponse {
  if (typeof raw !== 'object' || raw === null) return false;
  const obj = raw as Record<string, unknown>;
  
  // Must have an address/id
  const hasId = typeof obj.address === 'string' || 
                typeof obj.id === 'string' ||
                typeof obj.poolAddress === 'string';
  if (!hasId) return false;
  
  // Must have mint_x and mint_y (or token objects)
  const hasMintX = typeof obj.mint_x === 'string' || 
                   typeof obj.tokenXMint === 'string' ||
                   (typeof obj.tokenX === 'object' && obj.tokenX !== null);
  const hasMintY = typeof obj.mint_y === 'string' || 
                   typeof obj.tokenYMint === 'string' ||
                   (typeof obj.tokenY === 'object' && obj.tokenY !== null);
  
  return hasMintX && hasMintY;
}

/**
 * Validates if an object is a valid Meteora Balanced pool API response
 */
export function isValidMeteoraBalancedPool(raw: unknown): raw is MeteoraBalancedPoolApiResponse {
  if (typeof raw !== 'object' || raw === null) return false;
  const obj = raw as Record<string, unknown>;
  
  // Must have an address/id
  const hasId = typeof obj.pool_address === 'string' || 
                typeof obj.address === 'string' ||
                typeof obj.id === 'string';
  if (!hasId) return false;
  
  // Must have token mints
  const hasMintA = typeof obj.token_a_mint === 'string' || typeof obj.mintA === 'string';
  const hasMintB = typeof obj.token_b_mint === 'string' || typeof obj.mintB === 'string';
  
  return hasMintA && hasMintB;
}

/**
 * Validates if an object is a valid Pumpswap pool API response
 */
export function isValidPumpswapPool(raw: unknown): raw is PumpswapPoolApiResponse {
  if (typeof raw !== 'object' || raw === null) return false;
  const obj = raw as Record<string, unknown>;
  
  // Must have pubkey
  if (typeof obj.pubkey !== 'string') return false;
  
  // Must have mints
  if (typeof obj.base_mint !== 'string' || typeof obj.quote_mint !== 'string') return false;
  
  return true;
}

/**
 * Validates if an object is a valid Raydium CPMM pool API response
 */
export function isValidRaydiumCpmmPool(raw: unknown): raw is RaydiumCpmmPoolApiResponse {
  if (typeof raw !== 'object' || raw === null) return false;
  const obj = raw as Record<string, unknown>;
  
  // Must have pubkey
  if (typeof obj.pubkey !== 'string') return false;
  
  // Must have token mints
  if (typeof obj.token0Mint !== 'string' || typeof obj.token1Mint !== 'string') return false;
  
  // Must have vaults
  if (typeof obj.token0Vault !== 'string' || typeof obj.token1Vault !== 'string') return false;
  
  // Must have ammConfig
  if (typeof obj.ammConfig !== 'string') return false;
  
  return true;
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Safely extract mint address from various Raydium mint formats
 */
export function extractRaydiumMint(mint: RaydiumMintInfo | string | undefined): string {
  if (!mint) return '';
  if (typeof mint === 'string') return mint;
  if (typeof mint === 'object' && mint.address) return String(mint.address);
  return '';
}

/**
 * Safely extract decimals from various Raydium mint formats
 */
export function extractRaydiumDecimals(mint: RaydiumMintInfo | string | undefined): number | undefined {
  if (!mint || typeof mint === 'string') return undefined;
  if (typeof mint === 'object' && typeof mint.decimals === 'number') return mint.decimals;
  return undefined;
}

/**
 * Safely extract mint address from Orca token info
 */
export function extractOrcaMint(token: OrcaTokenInfo | undefined): string {
  if (!token) return '';
  if (typeof token.mint === 'string') return token.mint;
  return '';
}

/**
 * Filter and validate an array of raw pool responses
 */
export function filterValidPools<T>(
  pools: unknown[],
  validator: (raw: unknown) => raw is T
): T[] {
  return pools.filter(validator);
}

