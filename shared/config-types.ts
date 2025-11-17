// Shared configuration types across frontend and backend (public overlap only)
// These interfaces intentionally include only fields exposed in UI and public APIs.

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export interface SharedSystemConfig {
  jupiterApiUrl?: string;
  targetTickTimeMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  connectionTimeoutMs?: number;
  enableLogging?: boolean;
  logLevel?: LogLevel | string;
  frontendLogLevel?: LogLevel | string;
  wrapAndUnwrapSol?: boolean;
  logCategories?: string[];
  enabledLogCategories?: string[];
  frontendEnabledLogCategories?: string[];
  log?: {
    level?: LogLevel;
    categories?: Record<string, LogLevel>;
    enableCodes?: string[];
    disableCodes?: string[];
    sample?: Record<string, number>;
    rateLimit?: Record<string, { perSec?: number; minIntervalMs?: number }>;
  };
}

export interface SharedFeesConfig {
  baseFee?: number;
  priorityFee?: number;
  maxFee?: number;
  dynamicFees?: boolean;
  feeMultiplier?: number;
  minFee?: number;
  maxFeeMultiplier?: number;
  feeUpdateInterval?: number;
  networkCongestionThreshold?: number;
  jupiterPriorityFee?: number;
  jupiterMaxAccounts?: number;
  jupiterDynamicCompute?: boolean;
  jupiterLegacyTransaction?: boolean;
  jupiterSlippageBps?: number;
  jupiterMaxSlippageBps?: number;
}

export interface ExecEngineConfigPublic {
  mode: 'simulate' | 'direct';
  slippageBpsDefault: number;
  computeUnitLimit: number;
  computeUnitPriceMicroLamports: number;
  createAtasInTx: boolean;
  dynamicCompute: boolean;
  maxTxSizeBytes?: number;
}

export interface ArbDetectorConfigPublic {
  enabled?: boolean;
  min_profit_bps?: number;
  max_profit_bps?: number;
  min_notional_usd?: number;
  max_hops?: number;
  max_idle_ms?: number;
  quote_size_usd?: number;
  debug_emit_subthreshold?: boolean;
  debug_top_n?: number;
  near_miss_enable?: boolean;
  near_miss_epsilon?: number;
  debug_near_miss_failures?: boolean;
  est_priority_fee_per_hop_lamports?: number;
  // Perf / cadence
  filtered_detect_enable?: boolean;
  filtered_node_ratio?: number;
  filtered_expand_hops?: number;
  periodic_full_ms?: number;
  // Path pruning
  max_sol_stable_hops?: number;
  drop_stable_stable_hops?: boolean;
  stable_mints?: string[];
  // Graph edge selection (allow-list). When omitted, all are allowed by default.
  edge_allow?: {
    raydium?: { amm?: boolean; clmm?: boolean };
    orca?: { amm?: boolean; clmm?: boolean };
    meteora?: { amm?: boolean; clmm?: boolean };
  };
}

export interface SystemConfigRequest {
  rpcUrl?: string;
  system?: SharedSystemConfig;
  fees?: SharedFeesConfig;
}

export interface SystemConfigResponse {
  rpcUrl: string;
  system: SharedSystemConfig;
  fees: SharedFeesConfig;
}

export type FeesConfigRequest = SharedFeesConfig;
export interface FeesConfigResponse { fees: SharedFeesConfig }

export type ExecConfigRequest = Partial<ExecEngineConfigPublic>;
export type ExecConfigResponse = ExecEngineConfigPublic;

export type ArbConfigRequest = Partial<ArbDetectorConfigPublic>;
export type ArbConfigResponse = ArbDetectorConfigPublic;

// Shyft GraphQL Configuration (for Raydium, Orca, Meteora)
export interface ShyftConfig {
  apiKey?: string;
  endpoint?: string;
  network?: 'mainnet-beta' | 'devnet';
}

export interface RaydiumGraphQLConfig {
  useGraphQL?: boolean;
  shyftApiKey?: string;
  pageDelayMs?: number;
}

export interface OrcaGraphQLConfig {
  useGraphQL?: boolean;
  shyftApiKey?: string;
  pageDelayMs?: number;
}

export interface MeteoraGraphQLConfig {
  useGraphQL?: boolean;
  shyftApiKey?: string;
  pageDelayMs?: number;
}

