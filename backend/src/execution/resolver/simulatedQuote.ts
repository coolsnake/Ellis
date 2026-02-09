/**
 * Adapters bridging quoteHopOut (atomic BigInt) to swapSimulator (number-based).
 *
 * The swap simulators in server/pools/swapSimulator.ts produce accurate
 * tick-walk (CLMM) and bin-walk (DLMM) outputs that match on-chain math.
 * These adapters convert between the BigInt atomic units used by quoteHopOut
 * and the Number-based units expected by the simulators.
 */

import { getRangeData } from '../../server/pools/rangeCache.js';
import { simulateClmmSwap, simulateDlmmSwap } from '../../server/pools/swapSimulator.js';
import type { ClmmRangeData, DlmmRangeData } from '../../server/pools/rangeCache.js';

/**
 * Quote a CLMM swap (Orca Whirlpool / Raydium CLMM) using tick-walk simulation.
 *
 * @param poolId       Pool address (stripped of #rev suffix)
 * @param amountInRaw  Input amount in atomic units (BigInt)
 * @param sqrtPriceX64 Current sqrtPrice as BigInt (Q64.64 fixed-point)
 * @param decIn        Input token decimals
 * @param decOut       Output token decimals
 * @param feeBps       Fee in basis points
 * @param aToB         true = selling token A for token B (native direction)
 * @param currentTick  Current tick index (optional, derived from sqrtPriceX64 if missing)
 * @param liquidity    Current active liquidity L (optional, from rangeData if missing)
 * @returns Output in atomic units (BigInt), or null if simulation not possible
 */
export function quoteClmmViaSimulator(
  poolId: string,
  amountInRaw: bigint,
  sqrtPriceX64: bigint,
  decIn: number,
  decOut: number,
  feeBps: number,
  aToB: boolean,
  currentTick?: number,
  liquidity?: number,
): bigint | null {
  const rangeData = getRangeData(poolId);
  if (!rangeData || rangeData.kind !== 'clmm') return null;

  const clmm = rangeData as ClmmRangeData;
  if (!clmm.ticks || clmm.ticks.length === 0) return null;

  // Convert sqrtPriceX64 (Q64.64) to float sqrtPrice for the simulator
  // sqrtPrice_float = sqrtPriceX64 / 2^64
  // But the simulator uses 1.0001^(tick/2) convention, so we use currentTick instead
  const tick = currentTick ?? clmm.currentTick;
  const currentSqrtPrice = Math.pow(1.0001, tick / 2);
  const L = liquidity ?? clmm.currentLiquidity;

  if (currentSqrtPrice <= 0 || L <= 0) return null;

  // simulateClmmSwap expects atomic units for input and produces atomic units for output
  // (confirmed by graph.edges.ts which multiplies whole tokens by 10^dec before passing)
  const inputAtomic = Number(amountInRaw);
  if (!Number.isFinite(inputAtomic) || inputAtomic <= 0) return null;

  const outputAtomic = simulateClmmSwap({
    inputAmount: inputAtomic,
    currentSqrtPrice,
    currentLiquidity: L,
    ticks: clmm.ticks,
    currentTick: tick,
    feeBps,
    aToB,
  });

  if (outputAtomic <= 0 || !Number.isFinite(outputAtomic)) return null;

  return BigInt(Math.floor(outputAtomic));
}

/**
 * Quote a DLMM swap (Meteora) using bin-walk simulation.
 *
 * @param poolId       Pool address (stripped of #rev suffix)
 * @param amountInRaw  Input amount in atomic units (BigInt)
 * @param decIn        Input token decimals
 * @param decOut       Output token decimals
 * @param feeBps       Fee in basis points
 * @param binStep      Bin step in basis points
 * @param xToY         true = selling token X for token Y
 * @returns Output in atomic units (BigInt), or null if simulation not possible
 */
export function quoteDlmmViaSimulator(
  poolId: string,
  amountInRaw: bigint,
  decIn: number,
  decOut: number,
  feeBps: number,
  binStep: number,
  xToY: boolean,
): bigint | null {
  const rangeData = getRangeData(poolId);
  if (!rangeData || rangeData.kind !== 'dlmm') return null;

  const dlmm = rangeData as DlmmRangeData;
  if (!dlmm.bins || dlmm.bins.length === 0) return null;

  // simulateDlmmSwap expects whole tokens and produces whole tokens
  const inputWhole = Number(amountInRaw) / Math.pow(10, decIn);
  if (!Number.isFinite(inputWhole) || inputWhole <= 0) return null;

  const outputWhole = simulateDlmmSwap({
    inputAmount: inputWhole,
    activeBinId: dlmm.activeBinId,
    bins: dlmm.bins,
    binStep,
    feeBps,
    xToY,
  });

  if (outputWhole <= 0 || !Number.isFinite(outputWhole)) return null;

  return BigInt(Math.floor(outputWhole * Math.pow(10, decOut)));
}
