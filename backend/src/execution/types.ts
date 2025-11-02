// Core types for direct execution (multi-hop) across DEXes

export type Dex = 'raydium' | 'orca' | 'meteora';
export type Variant = 'amm' | 'clmm' | 'dlmm';

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
};

export type ExecutionPlan = {
  path: string[];
  hops: DirectHop[];
  computeUnitPriceMicroLamports?: number;
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
};


