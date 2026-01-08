// Core types for direct execution (multi-hop) across DEXes

export type Dex = 'raydium' | 'orca' | 'meteora' | 'meteora_balanced' | 'pumpswap';
export type Variant = 'amm' | 'clmm' | 'dlmm' | 'damm_v1' | 'damm_v2';

export type DirectHop = {
  dex: Dex;
  variant: Variant;
  poolId: string;
  programId: string;

  inputMint: string;
  outputMint: string;
  inputDecimals: number;
  outputDecimals: number;
  inputTokenProgram: 'spl-token' | 'token-2022';
  outputTokenProgram: 'spl-token' | 'token-2022';

  userSourceAta: string;
  userDestAta: string;

  amountInRaw: bigint;
  minOutRaw: bigint;
  
  // Multihop exact amount tracking
  quotedOutputRaw?: bigint; // Exact output from quote, used for multihop propagation
  useExactAmount?: boolean; // Flag to prevent re-quote adjustments in instruction building

  // Common vaults
  vaultA?: string;
  vaultB?: string;

  // CLMM/DLMM
  tickSpacing?: number;
  sqrtPriceLimitX64?: bigint;
  oracle?: string;
  tickArrayLower?: string;
  tickArrayCenter?: string;
  tickArrayUpper?: string;
  observationId?: string;
  ammConfig?: string;

  // Raydium AMM/Serum
  ammAuthority?: string;
  ammOpenOrders?: string;
  ammTargetOrders?: string;
  serumProgramId?: string;
  market?: string;
  bids?: string;
  asks?: string;
  eventQueue?: string;
  coinVault?: string;
  pcVault?: string;
  vaultSigner?: string;

  // DLMM
  binStep?: number;
  activeId?: number;
  binArrayLower?: string;
  binArrayUpper?: string;
  reserveX?: string;
  reserveY?: string;
  bitmapExtension?: string;  // Meteora DLMM bitmap extension (PDA or program ID)
};

export type ExecutionPlan = {
  path: string[];
  hops: DirectHop[];
  computeUnitPriceMicroLamports?: number;
  traceId?: string;  // Unified trace ID for correlating all logs across the execution lifecycle
  
  // Router-level profitability enforcement (for arb cycles)
  // Instead of encoding profitability in the final hop's minOutRaw, we pass these
  // to the router program which checks final_balance - initial_balance >= minProfit
  isArbCycle?: boolean;           // Whether this is an arb cycle (same start/end token)
  initialInputRaw?: bigint;       // Initial input amount for calculating minProfit
  minProfitBps?: number;          // Minimum profit threshold in basis points
};

export type ChunkedPlan = { txs: Array<{ instructions: any[]; approxSizeBytes: number }>; totalIxs: number; totalBytes: number };

export type VersionInfo = { version: number; timestamp: number };

export type ExecConfig = {
  mode: 'direct' | 'simulate';
  slippageBpsDefault: number;
  computeUnitLimit: number;
  computeUnitPriceMicroLamports: number;
  createAtasInTx: boolean;
  dynamicCompute: boolean;
  maxTxSizeBytes?: number;
};

export type ResolveDirectInput = {
  path: string[];
  hopPoolIds: string[];
  dexes: string[];
  size?: number;
  sizeUsd?: number;
  slippageBps?: number;
  traceId?: string;  // Unified trace ID for correlating all logs across the execution lifecycle
  minProfitBps?: number;  // For arb cycles: minimum profit required (final minOutRaw >= initial input * (1 + minProfitBps/10000))
};


