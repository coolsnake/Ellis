/**
 * Token Discovery System Types
 * 
 * Types for the discovery system that fetches top traded tokens from Jupiter,
 * discovers their pools via DexScreener, enriches pool data, and integrates
 * them into the graph.
 */

// ============================================================================
// DexScreener API Types
// ============================================================================

/**
 * DexScreener token info (base or quote)
 */
export interface DexScreenerToken {
  address: string;
  name: string;
  symbol: string;
}

/**
 * DexScreener liquidity info
 */
export interface DexScreenerLiquidity {
  usd: number;
  base: number;
  quote: number;
}

/**
 * DexScreener pool response from /token-pairs/v1/{chainId}/{tokenAddress}
 */
export interface DexScreenerPool {
  chainId: string;
  dexId: string;
  url: string;
  pairAddress: string;
  labels?: string[];
  baseToken: DexScreenerToken;
  quoteToken: DexScreenerToken;
  priceNative?: string;
  priceUsd?: string;
  txns?: Record<string, { buys: number; sells: number }>;
  volume?: Record<string, number>;
  priceChange?: Record<string, number>;
  liquidity?: DexScreenerLiquidity;
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
  info?: {
    imageUrl?: string;
    websites?: Array<{ url: string }>;
    socials?: Array<{ platform: string; handle: string }>;
  };
  boosts?: { active: number };
}

// ============================================================================
// Internal Mapping Types
// ============================================================================

/**
 * Supported DEX identifiers in the internal system
 */
export type InternalDex = 'raydium' | 'orca' | 'meteora' | 'meteora_balanced' | 'pumpswap';

/**
 * Pool kind (type) identifiers
 */
export type PoolKind = 'amm' | 'clmm' | 'dlmm' | 'cpmm';

/**
 * Variant specifier for DEXes with multiple versions (e.g., Meteora DAMM v1/v2)
 */
export type PoolVariant = 'v1' | 'v2';

/**
 * Mapping from DexScreener pool to internal pool type
 */
export interface InternalPoolMapping {
  dex: InternalDex;
  poolKind: PoolKind;
  variant?: PoolVariant;
}

/**
 * Discovered pool with internal mapping attached
 */
export interface DiscoveredPool extends DexScreenerPool {
  mapping: InternalPoolMapping;
}

// ============================================================================
// Discovery Configuration
// ============================================================================

/**
 * Discovery service configuration
 */
export interface DiscoveryConfig {
  /** Whether discovery is enabled */
  enabled: boolean;
  /** Interval between discovery cycles (ms) */
  intervalMs: number;
  
  // Jupiter settings
  /** Jupiter API key for authenticated requests */
  jupiterApiKey: string;
  /** Jupiter category to fetch (toptraded, toporganicscore, toptrending) */
  jupiterCategory: 'toptraded' | 'toporganicscore' | 'toptrending';
  /** Jupiter interval (5m, 1h, 6h, 24h) */
  jupiterInterval: '5m' | '1h' | '6h' | '24h';
  /** Max tokens to fetch from Jupiter */
  jupiterLimit: number;
  
  // DexScreener settings
  /** Delay between DexScreener requests (ms) to respect rate limits */
  dexScreenerDelayMs: number;
  /** Number of tokens to process per batch */
  dexScreenerBatchSize: number;
  
  // Filters
  /** Minimum liquidity in USD to include a pool */
  minLiquidityUsd: number;
  /** Maximum pools to process per token */
  maxPoolsPerToken: number;
  
  // Supported DEXes
  /** List of supported DexScreener dexId values */
  supportedDexIds: string[];
}

// ============================================================================
// Discovery Results
// ============================================================================

/**
 * Statistics from a single discovery cycle
 */
export interface DiscoveryResult {
  /** Number of tokens checked from Jupiter */
  tokensChecked: number;
  /** Number of new tokens (not already tracked) */
  newTokensFound: number;
  /** Total pools discovered from DexScreener */
  poolsDiscovered: number;
  /** Pools that passed filtering (liquidity, supported DEX) */
  poolsFiltered: number;
  /** Pools successfully enriched from DEX sources */
  poolsEnriched: number;
  /** Pools added to the graph */
  poolsAdded: number;
  /** Errors encountered during the cycle */
  errors: string[];
  /** Breakdown by DEX */
  byDex: Record<string, { discovered: number; enriched: number; added: number }>;
  /** Timestamp of cycle completion */
  timestamp: number;
  /** Duration of the cycle (ms) */
  durationMs: number;
}

/**
 * Discovery service status
 */
export interface DiscoveryStatus {
  /** Whether the discovery loop is running */
  running: boolean;
  /** Last cycle result (if any) */
  lastResult?: DiscoveryResult;
  /** Next scheduled run time (ms since epoch) */
  nextRunAt?: number;
  /** Current configuration */
  config: DiscoveryConfig;
}

// ============================================================================
// Enrichment Types
// ============================================================================

/**
 * Options for pool enrichment
 */
export interface EnrichmentOptions {
  /** Retry count for failed enrichment attempts */
  retries?: number;
  /** Backoff delay between retries (ms) */
  backoffMs?: number;
  /** Batch size for enrichment requests */
  batchSize?: number;
  /** Delay between batches (ms) */
  delayMs?: number;
}

/**
 * Result of enrichment for a batch of pools
 */
export interface EnrichmentResult {
  /** Successfully enriched pools by DEX */
  pools: {
    raydium: { amm: any[]; clmm: any[]; cpmm: any[] };
    orca: { clmm: any[] };
    meteora: { clmm: any[] };
    meteora_balanced: { amm: any[] };
    pumpswap: { amm: any[] };
  };
  /** Pool IDs that failed enrichment */
  failed: string[];
  /** Errors during enrichment */
  errors: string[];
}

// ============================================================================
// Jupiter API Types
// ============================================================================

/**
 * Jupiter token from the top tokens API
 */
export interface JupiterTopToken {
  id: string;
  name?: string;
  symbol?: string;
  decimals?: number;
  usdPrice?: number;
  liquidity?: number;
  fdv?: number;
  mcap?: number;
  organicScore?: number;
  organicScoreLabel?: 'high' | 'medium' | 'low';
  isVerified?: boolean;
  tags?: string[];
  stats5m?: JupiterTokenStats;
  stats1h?: JupiterTokenStats;
  stats6h?: JupiterTokenStats;
  stats24h?: JupiterTokenStats;
}

/**
 * Jupiter token statistics for a time period
 */
export interface JupiterTokenStats {
  priceChange?: number;
  volumeChange?: number;
  buyVolume?: number;
  sellVolume?: number;
  numBuys?: number;
  numSells?: number;
  numTraders?: number;
}
