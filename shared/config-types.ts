// Shared configuration types across frontend and backend (public overlap only)
// These interfaces intentionally include only fields exposed in UI and public APIs.

export type LogLevel = "error" | "warn" | "info" | "debug";

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
  // Pool subscription mode (WSS vs gRPC, per-account vs program-level)
  poolSubscriptionMode?:
    | "wss"
    | "wss-program"
    | "grpc"
    | "grpc-program"
    | "disabled";
  // gRPC stream configuration
  grpc?: {
    endpoint?: string;
    xToken?: string;
    commitment?: "processed" | "confirmed" | "finalized";
    maxReconnectAttempts?: number;
    reconnectDelayMs?: number;
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
  mode: "simulate" | "direct" | "simulate_then_execute";
  slippageBpsDefault: number;
  computeUnitLimit: number;
  computeUnitPriceMicroLamports: number;
  createAtasInTx: boolean;
  dynamicCompute: boolean;
  maxTxSizeBytes?: number;
  // Dynamic CU limits (use simulation CU + buffer instead of fixed limit)
  dynamicCuLimits?: boolean;
  dynamicCuBuffer?: number;
  // Dynamic priority fees (use background-polled network fees)
  dynamicPriorityFees?: boolean;
  priorityFeeUrgency?: "low" | "medium" | "high" | "critical";
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
export interface FeesConfigResponse {
  fees: SharedFeesConfig;
}

export type ExecConfigRequest = Partial<ExecEngineConfigPublic>;
export type ExecConfigResponse = ExecEngineConfigPublic;

export type ArbConfigRequest = Partial<ArbDetectorConfigPublic>;
export type ArbConfigResponse = ArbDetectorConfigPublic;

// Shyft GraphQL Configuration (for Raydium, Orca, Meteora)
export interface ShyftConfig {
  apiKey?: string;
  endpoint?: string;
  network?: "mainnet-beta" | "devnet";
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

// Trade Sizing Configuration (capacity-based system)
export type PoolTypeAdjustment = "default" | "cautious" | "aggressive";

export interface SizingConfigPublic {
  /** Master toggle for dynamic sizing */
  enabled: boolean;
  /** Minimum trade size in USD (floor) */
  minSizeUsd: number;
  /** Maximum trade size in USD (ceiling) */
  maxSizeUsd: number;
  /** Whether to cap trade size to wallet balance when not using flashloan */
  respectWalletBalance: boolean;
  /** Fraction of break-even capacity to use (0.5 to 0.95) */
  aggressiveness: number;
  /** Maximum acceptable slippage in basis points */
  maxSlippageBps: number;
  /** Per-pool-type capacity adjustment */
  poolTypeAdjustments?: {
    amm?: PoolTypeAdjustment;
    clmm?: PoolTypeAdjustment;
    dlmm?: PoolTypeAdjustment;
  };
}

export const DEFAULT_SIZING_CONFIG_PUBLIC: SizingConfigPublic = {
  enabled: true,
  minSizeUsd: 5,
  maxSizeUsd: 500,
  respectWalletBalance: true,
  aggressiveness: 0.7,
  maxSlippageBps: 500,
  poolTypeAdjustments: {
    amm: "default",
    clmm: "default",
    dlmm: "default",
  },
};

// Pool Subscription Mode (WSS vs gRPC)
export type PoolSubscriptionMode = "wss" | "wss-program" | "grpc" | "disabled";

// gRPC Stream Configuration (Yellowstone/Shyft)
export interface GrpcStreamConfig {
  endpoint?: string; // e.g., "grpc.ams.shyft.to:443"
  xToken?: string; // Shyft x-token for authentication
  commitment?: "processed" | "confirmed" | "finalized";
  maxReconnectAttempts?: number;
  reconnectDelayMs?: number;
}

// ============================================================================
// ALT (Address Lookup Table) Config Types
// ============================================================================

export type DexAltSet = {
  addresses: string[];
  altContents: Record<string, string[]>;
  totalPools: number;
  totalAccounts: number;
};

export type UserPdaAltSet = {
  addresses: string[];
  altContents: Record<string, string[]>;
  totalMints: number;
  totalAccounts: number;
};

export type AltConfig = {
  alts: {
    common?: string;
    flashloan?: string;
    userPdas?: string;
    pools?: string;
    clmm?: string;
    tokens?: string;
  };
  dexAlts?: {
    raydium?: DexAltSet;
    "raydium-amm"?: DexAltSet;
    "raydium-cpmm"?: DexAltSet;
    orca?: DexAltSet;
    meteora?: DexAltSet;
    "meteora-balanced"?: DexAltSet;
    "meteora-damm-v1"?: DexAltSet;
    "meteora-damm-v2"?: DexAltSet;
    pumpswap?: DexAltSet;
  };
  userPdaAlts?: UserPdaAltSet;
  poolToAlt?: Record<string, string>;
  mintToAlt?: Record<string, string>;
  createdAt?: number;
  lastValidated?: number;
  walletPublicKey?: string;
};
