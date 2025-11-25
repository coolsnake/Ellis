// Per-DEX slippage configuration and price impact estimation types

export type PoolType = 'amm' | 'clmm' | 'dlmm' | 'damm';

export interface SlippageConfig {
  // Safety buffer added to all estimates (for execution delay, price movement)
  safetyBufferBps: number;

  // Minimum slippage regardless of calculation (never go below pool fee + buffer)
  enforceMinimumAsFee: boolean;

  // Maximum allowed slippage (protection against bad estimates)
  maxSlippageBps: number;

  // Price impact estimation multipliers by pool type
  // Higher = more conservative (account for estimation uncertainty)
  impactMultipliers: Record<PoolType, number>;

  // Fallback multipliers when liquidity data is unavailable
  // Applied to pool fee as: totalSlippage = fee * noLiquidityMultiplier + buffer
  noLiquidityMultiplier: Record<PoolType, number>;
}

export interface SlippageEstimateInput {
  // Pool info
  dex: string;
  variant?: string;
  poolType: PoolType;
  poolFeeBps: number;               // From pool data

  // Liquidity info (for price impact)
  poolLiquidityUsd: number;         // Total pool TVL

  // Trade info
  tradeSizeUsd: number;

  // DLMM-specific
  binStep?: number;                 // Meteora bin step (also = fee in bps)
  activeBinLiquidityUsd?: number;   // Liquidity in active bin

  // CLMM-specific
  tickSpacing?: number;
  concentratedLiquidityUsd?: number; // Liquidity in active range
}

export interface SlippageEstimateResult {
  poolFeeBps: number;
  priceImpactBps: number;
  safetyBufferBps: number;
  totalBps: number;
  breakdown: {
    poolType: PoolType;
    tradeSizeRatio: number;         // trade / liquidity
    impactMultiplier: number;
    formula: string;                // For debugging
  };
}

