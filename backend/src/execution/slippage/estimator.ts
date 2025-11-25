import type { SlippageEstimateInput, SlippageEstimateResult, PoolType } from './types.js';
import { getSlippageConfig, getPoolType as getPoolTypeFromConfig } from './config.js';
import { logger } from '../../utils/logger.js';
import { logCatchError } from '../../utils/errorHandler.js';

/**
 * Estimate slippage based on:
 * 1. Pool fee (guaranteed minimum loss)
 * 2. Price impact from trade size vs liquidity
 * 3. Safety buffer for execution delay
 *
 * Formula: totalSlippage = poolFeeBps + priceImpactBps + safetyBufferBps
 */
export function estimateSlippage(input: SlippageEstimateInput): SlippageEstimateResult {
  const config = getSlippageConfig();
  const poolType = input.poolType || getPoolTypeFromConfig(input.dex, input.variant);

  // 1. Start with pool fee as base
  const poolFeeBps = Math.max(0, input.poolFeeBps || 0);

  // 2. Estimate price impact
  let priceImpactBps = 0;
  let tradeSizeRatio = 0;
  let formula = '';

  if (input.poolLiquidityUsd > 0 && input.tradeSizeUsd > 0) {
    tradeSizeRatio = input.tradeSizeUsd / input.poolLiquidityUsd;

    switch (poolType) {
      case 'amm':
      case 'damm':
        // Constant product: impact ≈ tradeSize / liquidity
        // For xy=k: if you trade x% of one side, price moves ~x%
        priceImpactBps = estimateAmmImpact(tradeSizeRatio, config.impactMultipliers.amm);
        formula = `AMM: ${(tradeSizeRatio * 100).toFixed(3)}% of liquidity × ${config.impactMultipliers.amm}`;
        break;

      case 'clmm':
        // Concentrated liquidity: use active liquidity if available
        const clmmLiquidity = input.concentratedLiquidityUsd || input.poolLiquidityUsd;
        const clmmRatio = input.tradeSizeUsd / clmmLiquidity;
        priceImpactBps = estimateClmmImpact(clmmRatio, input.tickSpacing, config.impactMultipliers.clmm);
        formula = `CLMM: ${(clmmRatio * 100).toFixed(3)}% of active liquidity × ${config.impactMultipliers.clmm}`;
        break;

      case 'dlmm':
        // Discrete bins: estimate bins traversed
        priceImpactBps = estimateDlmmImpact(
          input.tradeSizeUsd,
          input.activeBinLiquidityUsd || input.poolLiquidityUsd * 0.1,
          input.binStep || 10,
          config.impactMultipliers.dlmm
        );
        formula = `DLMM: binStep=${input.binStep || 10}, estimated bin traversal × ${config.impactMultipliers.dlmm}`;
        break;
    }
  } else {
    // No liquidity data - use fallback multiplier on fee
    const fallbackMultiplier = config.noLiquidityMultiplier[poolType];
    priceImpactBps = Math.round(poolFeeBps * (fallbackMultiplier - 1));
    formula = `Fallback: fee × ${fallbackMultiplier} (no liquidity data)`;
  }

  // 3. Add safety buffer
  const safetyBufferBps = config.safetyBufferBps;

  // 4. Calculate total
  let totalBps = poolFeeBps + priceImpactBps + safetyBufferBps;

  // 5. Enforce minimum (at least pool fee + buffer)
  if (config.enforceMinimumAsFee) {
    totalBps = Math.max(totalBps, poolFeeBps + safetyBufferBps);
  }

  // 6. Cap at maximum
  totalBps = Math.min(totalBps, config.maxSlippageBps);

  // Ensure totalBps is an integer
  totalBps = Math.round(totalBps);

  const result: SlippageEstimateResult = {
    poolFeeBps,
    priceImpactBps: Math.round(priceImpactBps),
    safetyBufferBps,
    totalBps,
    breakdown: {
      poolType,
      tradeSizeRatio,
      impactMultiplier: config.impactMultipliers[poolType],
      formula,
    },
  };

  try {
    logger.debug('slippage.estimated', {
      cat: 'tx',
      input: {
        dex: input.dex,
        poolFeeBps: input.poolFeeBps,
        tradeSizeUsd: input.tradeSizeUsd,
        poolLiquidityUsd: input.poolLiquidityUsd,
      },
      result,
    });
  } catch (e) {
    logCatchError('slippage.estimator', e);
  }

  return result;
}

/**
 * AMM (xy=k) price impact estimation
 * Formula: For a trade of size `dx`, price impact ≈ dx / x
 * where x is the reserve of the input token
 *
 * For small trades, this is approximately linear.
 * For larger trades, the actual formula is: 1 - 1/(1 + ratio)
 */
function estimateAmmImpact(tradeSizeRatio: number, multiplier: number): number {
  // Impact in bps = (trade / liquidity) * 10000 * multiplier
  // Using linear approximation which is accurate for trades < 5% of pool
  const impactBps = Math.round(tradeSizeRatio * 10000 * multiplier);
  return impactBps;
}

/**
 * CLMM price impact estimation
 * Concentrated liquidity means impact depends heavily on where liquidity is concentrated.
 * We add extra buffer for tick crossing uncertainty.
 */
function estimateClmmImpact(
  tradeSizeRatio: number,
  tickSpacing?: number,
  multiplier: number = 1.5
): number {
  // Base impact similar to AMM but scaled by multiplier
  let impactBps = Math.round(tradeSizeRatio * 10000 * multiplier);

  // Wider tick spacing = more price jump per tick crossed
  // Add ~tickSpacing/10 bps for potential tick jumps
  if (tickSpacing && tickSpacing > 1) {
    impactBps += Math.round(tickSpacing / 10);
  }

  return impactBps;
}

/**
 * DLMM (Meteora) price impact estimation
 * Discrete bins mean price changes in steps of binStep.
 *
 * Each bin holds some liquidity. When you exhaust a bin,
 * price jumps to the next bin (by binStep bps).
 */
function estimateDlmmImpact(
  tradeSizeUsd: number,
  activeBinLiquidityUsd: number,
  binStep: number,
  multiplier: number = 1.3
): number {
  // Estimate how many bins we'll traverse
  // Rough heuristic: each bin holds ~activeBinLiquidity worth
  const binsTraversed = Math.ceil(tradeSizeUsd / Math.max(1, activeBinLiquidityUsd));

  // Each bin crossed = binStep bps of price change (on average half since we're in the middle)
  // binStep is in bps already (e.g., 10 = 0.1% per bin)
  const binImpactBps = binsTraversed * binStep * 0.5;

  // Apply multiplier for safety
  const impactBps = Math.round(binImpactBps * multiplier);

  return impactBps;
}

/**
 * Get pool fee from cached pool data
 */
export async function getPoolFeeBps(
  dex: string,
  variant: string | undefined,
  poolId: string
): Promise<number> {
  try {
    const strippedId = poolId.replace(/[#-]rev$/, '');
    const dexLower = dex.toLowerCase();

    if (dexLower === 'meteora') {
      const { peekMeteoraPools } = await import('../../server/pools.js');
      const pools = peekMeteoraPools();
      const pool: any = (pools.clmm || []).find((p: any) => String(p?.id || '') === strippedId);
      // DLMM: binStep IS the fee in bps (approximately)
      return Number(pool?.fee_bps || pool?.bin_step || 25);
    }

    if (dexLower === 'meteora_balanced') {
      const { peekMeteoraBalancedPools } = await import('../../server/pools.js');
      const pools = peekMeteoraBalancedPools();
      const pool = (pools.amm || []).find((p: any) => String(p?.id || '') === strippedId);
      return Number(pool?.fee_bps || 10);
    }

    if (dexLower === 'raydium') {
      const { peekRaydiumPools } = await import('../../server/pools.js');
      const pools = peekRaydiumPools();
      const poolList = variant === 'clmm' ? pools.clmm : pools.amm;
      const pool = (poolList || []).find((p: any) => String(p?.id || '') === strippedId);
      return Number(pool?.fee_bps || 25);
    }

    if (dexLower === 'orca') {
      const { peekOrcaPools } = await import('../../server/pools.js');
      const pools = peekOrcaPools();
      const pool = (pools.clmm || []).find((p: any) => String(p?.id || '') === strippedId);
      return Number(pool?.fee_bps || 30);
    }

    if (dexLower === 'pumpswap') {
      const { peekPumpswapPools } = await import('../../server/pools.js');
      const pools = peekPumpswapPools();
      const pool = (pools.amm || []).find((p: any) => String(p?.id || '') === strippedId);
      return Number(pool?.fee_bps || 25);
    }
  } catch (e) {
    logCatchError('slippage.getPoolFeeBps', e);
  }

  return 30; // Default 30 bps if unknown
}

/**
 * Get pool liquidity in USD
 */
export async function getPoolLiquidityUsd(
  dex: string,
  variant: string | undefined,
  poolId: string
): Promise<number> {
  try {
    const strippedId = poolId.replace(/[#-]rev$/, '');
    const dexLower = dex.toLowerCase();

    if (dexLower === 'meteora') {
      const { peekMeteoraPools } = await import('../../server/pools.js');
      const pools = peekMeteoraPools();
      const pool: any = (pools.clmm || []).find((p: any) => String(p?.id || '') === strippedId);
      return Number(pool?.tvl_usd || pool?.liquidity_raw || 0);
    }

    if (dexLower === 'meteora_balanced') {
      const { peekMeteoraBalancedPools } = await import('../../server/pools.js');
      const pools = peekMeteoraBalancedPools();
      const pool: any = (pools.amm || []).find((p: any) => String(p?.id || '') === strippedId);
      return Number(pool?.tvl_usd || pool?.liquidity_raw || 0);
    }

    if (dexLower === 'raydium') {
      const { peekRaydiumPools } = await import('../../server/pools.js');
      const pools = peekRaydiumPools();
      const poolList = variant === 'clmm' ? pools.clmm : pools.amm;
      const pool: any = (poolList || []).find((p: any) => String(p?.id || '') === strippedId);
      return Number(pool?.tvl_usd || pool?.liquidity_raw || 0);
    }

    if (dexLower === 'orca') {
      const { peekOrcaPools } = await import('../../server/pools.js');
      const pools = peekOrcaPools();
      const pool: any = (pools.clmm || []).find((p: any) => String(p?.id || '') === strippedId);
      return Number(pool?.tvl_usd || pool?.liquidity || 0);
    }

    if (dexLower === 'pumpswap') {
      const { peekPumpswapPools } = await import('../../server/pools.js');
      const pools = peekPumpswapPools();
      const pool: any = (pools.amm || []).find((p: any) => String(p?.id || '') === strippedId);
      return Number(pool?.tvl_usd || pool?.liquidity_raw || 0);
    }
  } catch (e) {
    logCatchError('slippage.getPoolLiquidityUsd', e);
  }

  return 0;
}

/**
 * Get trade size in USD given raw amount and mint
 */
export async function getTradeSizeUsd(
  amountRaw: bigint,
  mint: string,
  decimals: number
): Promise<number> {
  try {
    const { getPriceByMint } = await import('../../server/priceStore.js');
    const price = await getPriceByMint(mint);
    if (price?.usdc && price.usdc > 0) {
      const wholeAmount = Number(amountRaw) / Math.pow(10, decimals);
      return wholeAmount * price.usdc;
    }
  } catch (e) {
    logCatchError('slippage.getTradeSizeUsd', e);
  }

  return 0;
}

/**
 * Get DLMM-specific pool info (binStep, activeBinLiquidity)
 */
export async function getDlmmPoolInfo(poolId: string): Promise<{
  binStep: number;
  activeBinLiquidityUsd: number;
} | null> {
  try {
    const strippedId = poolId.replace(/[#-]rev$/, '');
    const { peekMeteoraPools } = await import('../../server/pools.js');
    const pools = peekMeteoraPools();
    const pool: any = (pools.clmm || []).find((p: any) => String(p?.id || '') === strippedId);

    if (pool) {
      const binStep = Number(pool.bin_step || 10);
      const totalLiquidity = Number(pool.tvl_usd || pool.liquidity_raw || 0);
      // Rough estimate: active bin has ~10% of total liquidity
      // This is a heuristic; real liquidity distribution varies
      const activeBinLiquidityUsd = totalLiquidity * 0.1;

      return { binStep, activeBinLiquidityUsd };
    }
  } catch (e) {
    logCatchError('slippage.getDlmmPoolInfo', e);
  }

  return null;
}

/**
 * Get CLMM-specific pool info (tickSpacing, concentrated liquidity)
 */
export async function getClmmPoolInfo(
  dex: string,
  poolId: string
): Promise<{
  tickSpacing: number;
  concentratedLiquidityUsd: number;
} | null> {
  try {
    const strippedId = poolId.replace(/[#-]rev$/, '');
    const dexLower = dex.toLowerCase();

    let pool: any = null;

    if (dexLower === 'orca') {
      const { peekOrcaPools } = await import('../../server/pools.js');
      const pools = peekOrcaPools();
      pool = (pools.clmm || []).find((p: any) => String(p?.id || '') === strippedId);
    } else if (dexLower === 'raydium') {
      const { peekRaydiumPools } = await import('../../server/pools.js');
      const pools = peekRaydiumPools();
      pool = (pools.clmm || []).find((p: any) => String(p?.id || '') === strippedId);
    }

    if (pool) {
      const tickSpacing = Number(pool.tick_spacing || pool.tickSpacing || 1);
      const totalLiquidity = Number(pool.tvl_usd || pool.liquidity || 0);
      // For CLMM, liquidity is concentrated around current tick
      // Estimate ~30-50% of TVL is in active range
      const concentratedLiquidityUsd = totalLiquidity * 0.4;

      return { tickSpacing, concentratedLiquidityUsd };
    }
  } catch (e) {
    logCatchError('slippage.getClmmPoolInfo', e);
  }

  return null;
}

