import type { GraphEdge } from './graph.types.js';
import type { AmmPool, ClmmPool, CpmmPool } from './pools/types.js';
import { logger } from '../utils/logger.js';
import { getRangeData } from './pools/rangeCache.js';
import type { ClmmRangeData, DlmmRangeData } from './pools/rangeCache.js';
import { simulateClmmSwap, simulateDlmmSwap } from './pools/swapSimulator.js';

export type EdgeAllow = {
  raydium?: { amm?: boolean; clmm?: boolean; cpmm?: boolean };
  orca?: { amm?: boolean; clmm?: boolean };
  meteora?: { amm?: boolean; clmm?: boolean; dlmm?: boolean };
  meteoraBalanced?: { amm?: boolean; v1?: boolean; v2?: boolean };
  pumpswap?: { amm?: boolean };
};

const clampPriceInc = (px: number | undefined, min: number, max: number): number | undefined => {
  const v = Number(px);
  if (!Number.isFinite(v) || !(v > 0)) return undefined;
  return Math.min(max, Math.max(min, v));
};

export interface EdgeBuildOptions {
  priceClampMin?: number;
  priceClampMax?: number;
}

function liqDisplayFromPool(pool: any): number | undefined {
  const tvl = Number((pool as any)?.tvl_usd);
  if (Number.isFinite(tvl) && tvl > 0) return tvl;
  const disp = Number((pool as any)?.liquidity_display);
  if (Number.isFinite(disp) && disp > 0) return disp;
  const raw = Number((pool as any)?.pool_liquidity_raw ?? (pool as any)?.liquidity ?? (pool as any)?.liquidity_base);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return undefined;
}

function weightFrom(liq?: number, fee_bps?: number): number {
  const liqv = Number(liq || 0);
  const fee = Number(fee_bps || 1);
  return Math.max(1, liqv) / Math.max(1, fee);
}

const NATIVE_SIZE_FRACTIONS = [0.001, 0.003, 0.01, 0.03, 0.1, 0.3, 0.5];

function parseReserveRaw(raw: any, decimals?: number): number {
  try {
    const d = Number.isFinite(Number(decimals)) ? Number(decimals) : 0;
    const val = BigInt(String(raw || 0));
    const scale = 10 ** Math.max(0, Math.min(18, d));
    return Number(val) / scale;
  } catch {
    return 0;
  }
}

function computeAmmOutput(input: number, reserveIn: number, reserveOut: number, feeBps: number): number {
  if (!(input > 0 && reserveIn > 0 && reserveOut > 0)) return 0;
  const feeMultiplier = 1 - Math.max(0, feeBps) / 10000;
  const inputAfterFee = input * feeMultiplier;
  return (reserveOut * inputAfterFee) / (reserveIn + inputAfterFee);
}

function blendSpotAmmOutput(
  input: number,
  reserveIn: number,
  reserveOut: number,
  feeBps: number,
  spotRate: number,
  curveExponent: number,
): number {
  if (!(input > 0 && reserveIn > 0 && reserveOut > 0 && spotRate > 0)) return 0;
  const ratio = input / (reserveIn + input);
  const weight = Math.min(1, Math.max(0, Math.pow(ratio, curveExponent)));
  const spotOutput = input * spotRate;
  const ammOutput = computeAmmOutput(input, reserveIn, reserveOut, feeBps);
  return spotOutput * (1 - weight) + ammOutput * weight;
}

function buildSlippageCurveSource(
  kind: string,
  reserveIn: number,
  reserveOut: number,
  feeBps: number,
  spotRate: number,
  computedAt?: number,
  sourceLabel: string = 'native_reserve',
): GraphEdge['slippage_curve'] | undefined {
  if (!(reserveIn > 0 && reserveOut > 0 && spotRate > 0)) return undefined;
  const sizes = NATIVE_SIZE_FRACTIONS
    .map((f) => reserveIn * f)
    .filter((s) => Number.isFinite(s) && s > 0)
    .sort((a, b) => a - b);
  if (sizes.length === 0) return undefined;

  const mults: number[] = [];
  for (const size of sizes) {
    let output = 0;
    if (kind === 'amm' || kind === 'cpmm') {
      output = computeAmmOutput(size, reserveIn, reserveOut, feeBps);
    } else if (kind === 'clmm') {
      output = blendSpotAmmOutput(size, reserveIn, reserveOut, feeBps, spotRate, 0.7);
    } else if (kind === 'dlmm') {
      output = blendSpotAmmOutput(size, reserveIn, reserveOut, feeBps, spotRate, 1.5);
    } else {
      output = size * spotRate;
    }
    const mult = output > 0 ? output / (size * spotRate) : 0;
    // Cap at 1.0: slippage can only reduce output, never amplify it.
    // A mult > 1.0 indicates a modelling error (e.g. asymmetric reserves).
    const clampedMult = Number.isFinite(mult) && mult > 0 ? Math.min(mult, 1.0) : 0;
    mults.push(clampedMult);
  }

  return {
    unit: 'source',
    sizes,
    mults,
    computed_at: Number.isFinite(Number(computedAt)) ? Number(computedAt) : Date.now(),
    confidence: 'low',
    source: sourceLabel,
  };
}

function computeVirtualReservesFromClmm(
  sqrtPriceX64Raw: bigint,
  liquidityRaw: bigint,
  decimalsA: number,
  decimalsB: number,
): { reserveA: number; reserveB: number } | undefined {
  try {
    if (sqrtPriceX64Raw <= 0n || liquidityRaw <= 0n) return undefined;
    const sqrtP = Number(sqrtPriceX64Raw) / Number(2n ** 64n);
    if (!(sqrtP > 0)) return undefined;
    const L = Number(liquidityRaw);
    if (!(L > 0)) return undefined;
    const reserveAAtomic = L / sqrtP;
    const reserveBAtomic = L * sqrtP;
    const reserveA = reserveAAtomic / Math.pow(10, Math.max(0, Math.min(18, decimalsA)));
    const reserveB = reserveBAtomic / Math.pow(10, Math.max(0, Math.min(18, decimalsB)));
    if (reserveA > 0 && reserveB > 0) return { reserveA, reserveB };
  } catch {}
  return undefined;
}

/**
 * Compute bounded reserves for a CLMM pool using tick-range boundaries.
 *
 * Unlike computeVirtualReservesFromClmm (which assumes infinite range),
 * this uses the sqrtPrice at the nearest initialized tick boundaries
 * to compute the *actual* reserves in the current tick range.
 *
 * Formula (from Uniswap V3 / concentrated liquidity math):
 *   reserveA_atomic = L × (1/sqrtP - 1/sqrtP_upper)
 *   reserveB_atomic = L × (sqrtP - sqrtP_lower)
 *
 * where sqrtP = sqrt(price_B_atomic / price_A_atomic) in float (NOT Q64).
 *
 * Returns reserves in NATIVE token order (A = native mint_a, B = native mint_b).
 */
function computeBoundedClmmReserves(
  sqrtPriceX64Raw: bigint,
  liquidityRaw: bigint,
  decimalsA: number,
  decimalsB: number,
  sqrtPriceLower: number,
  sqrtPriceUpper: number,
): { reserveA: number; reserveB: number } | undefined {
  try {
    if (sqrtPriceX64Raw <= 0n || liquidityRaw <= 0n) return undefined;
    if (!(sqrtPriceLower > 0) || !(sqrtPriceUpper > sqrtPriceLower)) return undefined;

    const sqrtP = Number(sqrtPriceX64Raw) / Number(2n ** 64n);
    if (!(sqrtP > 0)) return undefined;

    const L = Number(liquidityRaw);
    if (!(L > 0)) return undefined;

    // Clamp sqrtP to the range in case of minor timing mismatches
    const sp = Math.max(sqrtPriceLower, Math.min(sqrtPriceUpper, sqrtP));

    // Token A reserves: how much A can be swapped before hitting upper boundary
    const reserveAAtomic = L * (1 / sp - 1 / sqrtPriceUpper);
    // Token B reserves: how much B can be swapped before hitting lower boundary
    const reserveBAtomic = L * (sp - sqrtPriceLower);

    const reserveA =
      reserveAAtomic / Math.pow(10, Math.max(0, Math.min(18, decimalsA)));
    const reserveB =
      reserveBAtomic / Math.pow(10, Math.max(0, Math.min(18, decimalsB)));

    // Also expose raw-atom strings so callers can set edge reserves without re-computing
    const reserveARaw = Math.floor(Math.max(0, reserveAAtomic));
    const reserveBRaw = Math.floor(Math.max(0, reserveBAtomic));

    if (reserveA > 0 && reserveB > 0) return { reserveA, reserveB, reserveARaw, reserveBRaw };
  } catch {}
  return undefined;
}

function computeHeuristicReservesFromMin(
  minReserve: number,
  priceAperB: number,
): { reserveA: number; reserveB: number } | undefined {
  if (!(minReserve > 0) || !(priceAperB > 0)) return undefined;
  // price_a_per_b = A per 1 B
  if (priceAperB >= 1) {
    // A is larger, assume B is min
    return { reserveA: minReserve * priceAperB, reserveB: minReserve };
  }
  // A is smaller, assume A is min
  return { reserveA: minReserve, reserveB: minReserve / priceAperB };
}

/**
 * Compute the max input in raw atoms for the active tick/bin range (capacity).
 * For CLMM: max tokens of the edge's source that can be swapped before exhausting
 * the current tick range.  For DLMM: same, using active + adjacent bins.
 * Returns the raw-atom string or undefined if unavailable.
 */
function computeActiveRangeCapacityRaw(
  kind: string,
  poolId: string,
  pool: any,
  wasSwapped: boolean,
): string | undefined {
  try {
    const rangeData = getRangeData(poolId);
    if (!rangeData) return undefined;

    if (kind === 'clmm' && rangeData.kind === 'clmm') {
      const clmm = rangeData as ClmmRangeData;
      if (clmm.currentLiquidity <= 0) return undefined;
      const s64 = BigInt(String(pool?.sqrt_price_x64 || pool?.sqrt_price_x64_raw || 0));
      if (s64 <= 0n) return undefined;
      const currentSqrtPrice = Number(s64) / Number(2n ** 64n);
      if (!(currentSqrtPrice > 0)) return undefined;

      const aToB = !wasSwapped; // canonical A→B direction in native terms
      const L = clmm.currentLiquidity;
      let activeCapacityAtomic: number;
      if (aToB) {
        const sqrtPLower = Math.pow(1.0001, clmm.tickLower / 2);
        activeCapacityAtomic = L * Math.abs(1 / sqrtPLower - 1 / currentSqrtPrice);
      } else {
        const sqrtPUpper = Math.pow(1.0001, clmm.tickUpper / 2);
        activeCapacityAtomic = L * Math.abs(sqrtPUpper - currentSqrtPrice);
      }
      if (!(activeCapacityAtomic > 0)) return undefined;
      const cap = Math.floor(activeCapacityAtomic);
      return cap > 0 ? String(cap) : undefined;
    }

    if (kind === 'dlmm' && rangeData.kind === 'dlmm') {
      const dlmm = rangeData as DlmmRangeData;
      if (!dlmm.bins || dlmm.bins.length === 0) return undefined;
      const binStep = Number(pool?.tick_spacing ?? pool?.tickSpacing ?? pool?.bin_step ?? 0);
      if (binStep <= 0) return undefined;

      const xToY = !wasSwapped;
      const activeBin = dlmm.bins.find(b => b.id === dlmm.activeBinId);
      const stepMult = 1 + binStep / 10000;
      let activeCapacity = 0;

      if (xToY) {
        const price = Math.pow(stepMult, dlmm.activeBinId - 8388608);
        activeCapacity = (activeBin?.reserveY ?? 0) / (price > 0 ? price : 1);
        if (activeCapacity <= 0) {
          for (const bin of dlmm.bins.filter(b => b.id <= dlmm.activeBinId)) {
            const p = Math.pow(stepMult, bin.id - 8388608);
            activeCapacity += bin.reserveY / (p > 0 ? p : 1);
          }
        }
      } else {
        const price = Math.pow(stepMult, dlmm.activeBinId - 8388608);
        activeCapacity = (activeBin?.reserveX ?? 0) * (price > 0 ? price : 1);
        if (activeCapacity <= 0) {
          for (const bin of dlmm.bins.filter(b => b.id >= dlmm.activeBinId)) {
            const p = Math.pow(stepMult, bin.id - 8388608);
            activeCapacity += bin.reserveX * (p > 0 ? p : 1);
          }
        }
      }

      if (!(activeCapacity > 0)) return undefined;
      // activeCapacity is in whole (human) tokens; convert to raw atoms
      const decIn = wasSwapped
        ? Number(pool?.native_decimals_b ?? pool?.decimals_b ?? 9)
        : Number(pool?.native_decimals_a ?? pool?.decimals_a ?? 9);
      const scale = Math.pow(10, Math.max(0, Math.min(18, decIn)));
      const cap = Math.floor(activeCapacity * scale);
      return cap > 0 ? String(cap) : undefined;
    }
  } catch {}
  return undefined;
}

/**
 * Build a high-confidence slippage curve using actual tick/bin liquidity data
 * from rangeCache.  Falls back to undefined if tick/bin data is unavailable.
 *
 * For CLMM pools: uses simulateClmmSwap (tick-walk) with real liquidityNet values.
 * For DLMM pools: uses simulateDlmmSwap (bin-walk) with real bin reserves.
 *
 * @param kind      Pool kind: 'clmm' | 'dlmm'
 * @param poolId    Pool address
 * @param feeBps    Fee in basis points
 * @param spotRate  Canonical spot rate (output per input, after fee)
 * @param wasSwapped  Whether canonical token order is inverted relative to native
 * @param pool      Raw pool object (for sqrtPriceX64, liquidity, tickSpacing, binStep, etc.)
 */
function buildSlippageCurveFromSimulation(
  kind: string,
  poolId: string,
  feeBps: number,
  spotRate: number,
  wasSwapped: boolean,
  pool: any,
): GraphEdge['slippage_curve'] | undefined {
  if (spotRate <= 0) return undefined;
  if (kind !== 'clmm' && kind !== 'dlmm') return undefined;

  const rangeData = getRangeData(poolId);
  if (!rangeData) return undefined;

  // ── CLMM tick-walk simulation ──
  if (kind === 'clmm' && rangeData.kind === 'clmm') {
    const clmm = rangeData as ClmmRangeData;
    if (clmm.ticks.length === 0 || clmm.currentLiquidity <= 0) return undefined;

    // sqrtPrice as float
    const s64 = BigInt(String(pool?.sqrt_price_x64 || pool?.sqrt_price_x64_raw || 0));
    if (s64 <= 0n) return undefined;
    const currentSqrtPrice = Number(s64) / Number(2n ** 64n);
    if (!(currentSqrtPrice > 0)) return undefined;

    // For the forward edge (canonical A→B), determine swap direction in native terms.
    // If wasSwapped: canonical A = native B, so the swap is native B→A (aToB = false).
    // If !wasSwapped: canonical A = native A, so the swap is native A→B (aToB = true).
    const aToB = !wasSwapped;

    // Compute active-range capacity to generate proportional test sizes
    const L = clmm.currentLiquidity;
    let activeRangeCapacity: number;
    if (aToB) {
      // A→B: max A consumable before hitting lower tick
      const sqrtPLower = Math.pow(1.0001, clmm.tickLower / 2);
      activeRangeCapacity = L * Math.abs(1 / sqrtPLower - 1 / currentSqrtPrice);
    } else {
      // B→A: max B consumable before hitting upper tick
      const sqrtPUpper = Math.pow(1.0001, clmm.tickUpper / 2);
      activeRangeCapacity = L * Math.abs(sqrtPUpper - currentSqrtPrice);
    }

    // Scale to whole tokens
    const decIn = wasSwapped
      ? Number(pool?.native_decimals_b ?? pool?.decimals_b ?? 9)
      : Number(pool?.native_decimals_a ?? pool?.decimals_a ?? 9);
    const decOut = wasSwapped
      ? Number(pool?.native_decimals_a ?? pool?.decimals_a ?? 9)
      : Number(pool?.native_decimals_b ?? pool?.decimals_b ?? 9);
    activeRangeCapacity = activeRangeCapacity / Math.pow(10, Math.max(0, decIn));

    if (!(activeRangeCapacity > 0)) return undefined;

    const fractions = [0.01, 0.05, 0.1, 0.2, 0.4, 0.6, 0.8, 1.0, 1.5, 2.0, 3.0];
    const sizes: number[] = [];
    const mults: number[] = [];

    for (const f of fractions) {
      const inputWhole = activeRangeCapacity * f;
      if (inputWhole <= 0) continue;

      // Simulate in atomic units
      const inputAtomic = inputWhole * Math.pow(10, decIn);
      const outputAtomic = simulateClmmSwap({
        inputAmount: inputAtomic,
        currentSqrtPrice,
        currentLiquidity: L,
        ticks: clmm.ticks,
        currentTick: clmm.currentTick,
        feeBps,
        aToB,
      });

      const outputWhole = outputAtomic / Math.pow(10, decOut);
      const expectedOutput = inputWhole * spotRate;
      const mult = expectedOutput > 0 ? outputWhole / expectedOutput : 0;
      const clamped = Number.isFinite(mult) && mult > 0 ? Math.min(mult, 1.0) : 0;

      sizes.push(inputWhole);
      mults.push(clamped);
    }

    if (sizes.length === 0) return undefined;

    return {
      unit: 'source',
      sizes,
      mults,
      computed_at: Date.now(),
      confidence: 'high',
      source: 'tick_simulation',
    };
  }

  // ── DLMM bin-walk simulation ──
  if (kind === 'dlmm' && rangeData.kind === 'dlmm') {
    const dlmm = rangeData as DlmmRangeData;
    if (!dlmm.bins || dlmm.bins.length === 0) return undefined;

    const binStep = Number(pool?.tick_spacing ?? pool?.tickSpacing ?? pool?.bin_step ?? 0);
    if (binStep <= 0) return undefined;

    // For forward edge (canonical A→B):
    // If wasSwapped: canonical A = native Y, so swap is Y→X (xToY = false)
    // If !wasSwapped: canonical A = native X, so swap is X→Y (xToY = true)
    const xToY = !wasSwapped;

    // Compute active bin capacity for test size generation
    const activeBin = dlmm.bins.find(b => b.id === dlmm.activeBinId);
    let activeCapacity: number;
    if (xToY) {
      // X→Y: output is Y, capacity limited by Y reserves in active + lower bins
      const stepMult = 1 + binStep / 10000;
      const price = Math.pow(stepMult, dlmm.activeBinId - 8388608);
      activeCapacity = (activeBin?.reserveY ?? 0) / (price > 0 ? price : 1);
    } else {
      // Y→X: output is X, capacity limited by X reserves in active + upper bins
      const stepMult = 1 + binStep / 10000;
      const price = Math.pow(stepMult, dlmm.activeBinId - 8388608);
      activeCapacity = (activeBin?.reserveX ?? 0) * (price > 0 ? price : 1);
    }

    // Fallback: sum capacities from all bins in the swap direction
    if (activeCapacity <= 0) {
      const stepMult = 1 + binStep / 10000;
      if (xToY) {
        for (const bin of dlmm.bins.filter(b => b.id <= dlmm.activeBinId)) {
          const price = Math.pow(stepMult, bin.id - 8388608);
          activeCapacity += bin.reserveY / (price > 0 ? price : 1);
        }
      } else {
        for (const bin of dlmm.bins.filter(b => b.id >= dlmm.activeBinId)) {
          const price = Math.pow(stepMult, bin.id - 8388608);
          activeCapacity += bin.reserveX * (price > 0 ? price : 1);
        }
      }
    }

    if (!(activeCapacity > 0)) return undefined;

    const fractions = [0.01, 0.05, 0.1, 0.2, 0.4, 0.6, 0.8, 1.0, 1.5, 2.0, 3.0];
    const sizes: number[] = [];
    const mults: number[] = [];

    for (const f of fractions) {
      const inputWhole = activeCapacity * f;
      if (inputWhole <= 0) continue;

      const outputWhole = simulateDlmmSwap({
        inputAmount: inputWhole,
        activeBinId: dlmm.activeBinId,
        bins: dlmm.bins,
        binStep,
        feeBps,
        xToY,
      });

      const expectedOutput = inputWhole * spotRate;
      const mult = expectedOutput > 0 ? outputWhole / expectedOutput : 0;
      const clamped = Number.isFinite(mult) && mult > 0 ? Math.min(mult, 1.0) : 0;

      sizes.push(inputWhole);
      mults.push(clamped);
    }

    if (sizes.length === 0) return undefined;

    return {
      unit: 'source',
      sizes,
      mults,
      computed_at: Date.now(),
      confidence: 'high',
      source: 'bin_simulation',
    };
  }

  return undefined;
}

// Note: buildSlippageCurveUsd removed - arb-rs handles sizing via slippage simulation

export interface PoolValidationConfig {
  feeMin?: number;
  feeMax?: number;
  maxPriceDeviation?: number;
  sanityEnabled?: boolean;
}

export function isPoolValidForGraph(
  p: any,
  getUsd: (mint: string) => number | undefined,
  config: PoolValidationConfig
): boolean {
  const { feeMin = 0, feeMax = 10000, maxPriceDeviation = 10, sanityEnabled = true } = config;

  if (!sanityEnabled) return true;

  const fb = Number(p?.fee_bps);
    if (Number.isFinite(fb) && (fb < feeMin || fb > feeMax)) {
    try {
      const kind = String((p as any)?.pool_kind || '');
      if (kind === 'clmm' || kind === 'dlmm') {
        logger.info('graph.sanity.filter.badFees', {
          dex: String((p as any)?.dex || ''),
          kind,
          pool_id: (p as any)?.id?.slice(0, 12),
          fee_bps: fb,
          feeMin,
          feeMax,
          reason: 'badFees',
          cat: 'graph'
        });
      }
    } catch {}
    return false; // 'badFees'
  }

  const kind = String((p as any)?.pool_kind || '');
  const s64 = Number((p as any)?.sqrt_price_x64 || (p as any)?.sqrt_price_x64_raw || 0);
  const price = Number((p as any)?.price_a_per_b);
  const dex = String((p as any)?.dex || '');

  // Allow CLMM pools that can derive price from sqrt even if price_a_per_b is missing
  // Allow CPMM pools that have valid reserves (price can be computed from reserves)
  if (!Number.isFinite(price) || price <= 0) {
    const clmmCanDerive = kind === 'clmm' && s64 > 0;
    
    // CPMM pools can derive price from reserves
    const reserveA = BigInt(String((p as any)?.reserve_a_raw || (p as any)?.native_reserve_a_raw || 0));
    const reserveB = BigInt(String((p as any)?.reserve_b_raw || (p as any)?.native_reserve_b_raw || 0));
    const cpmmCanDerive = kind === 'cpmm' && reserveA > 0n && reserveB > 0n;
    
    if (!clmmCanDerive && !cpmmCanDerive) {
      // Log when we filter out a pool for missing price (use info for CLMM/CPMM to debug)
      try {
        const logLevel = (kind === 'clmm' || kind === 'dlmm' || kind === 'cpmm') ? 'info' : 'debug';
        logger[logLevel]('graph.sanity.filter.price', {
          dex,
          kind,
          pool_id: (p as any)?.id?.slice(0, 12),
          mint_a: (p as any)?.mint_a?.slice(0, 8),
          mint_b: (p as any)?.mint_b?.slice(0, 8),
          price,
          sqrt_price_x64: (p as any)?.sqrt_price_x64,
          sqrt_price_x64_raw: (p as any)?.sqrt_price_x64_raw,
          s64_converted: s64,
          reserve_a_raw: (p as any)?.reserve_a_raw,
          reserve_b_raw: (p as any)?.reserve_b_raw,
          reason: 'nonFinitePrice',
          cat: 'graph'
        });
      } catch {}
      return false; // 'nonFinitePrice'
    } else if (clmmCanDerive) {
      // Log successful CLMM validation with sqrt fallback
      try {
        logger.debug('graph.sanity.filter.clmm.sqrt_fallback', {
          dex,
          pool_id: (p as any)?.id?.slice(0, 12),
          price,
          sqrt_price_x64: (p as any)?.sqrt_price_x64,
          sqrt_price_x64_raw: (p as any)?.sqrt_price_x64_raw,
          s64_converted: s64,
          cat: 'graph'
        });
      } catch {}
    } else if (cpmmCanDerive) {
      // Log successful CPMM validation with reserves fallback
      try {
        logger.debug('graph.sanity.filter.cpmm.reserves_fallback', {
          dex,
          pool_id: (p as any)?.id?.slice(0, 12),
          price,
          reserve_a_raw: String(reserveA),
          reserve_b_raw: String(reserveB),
          cat: 'graph'
        });
      } catch {}
    }
  }

  const aUsd = getUsd(p.mint_a);
  const bUsd = getUsd(p.mint_b);
  
  // Avoid double-applying price deviation sanity if source already sanitized
  // Note: Configuration for avoidDoubleApply is assumed true here or handled by caller config
  const sourceSanitized = (
    // All CLMMs receive orientation/clamp handling in their dedicated blocks
    (kind === 'clmm') ||
    (kind === 'cpmm') || // CPMM also goes through pipeline
    (dex === 'Raydium' && kind === 'amm') // Assuming sanity_applyRaydiumAmm is true
  );
  
  if (!sourceSanitized && Number.isFinite(aUsd as any) && Number.isFinite(bUsd as any) && (aUsd as number) > 0 && (bUsd as number) > 0) {
    // price is A per 1 B, USD ref should be USD(B)/USD(A)
    if (Number.isFinite(price) && price > 0) {
      const ref = (bUsd as number) / (aUsd as number);
      const dev = Math.max(price / ref, ref / price);
      if (dev > maxPriceDeviation) {
        try {
          if (kind === 'clmm') {
            logger.info('graph.sanity.filter.priceOutlier', {
              dex,
              kind,
              pool_id: (p as any)?.id?.slice(0, 12),
              price,
              ref,
              deviation: dev,
              maxDeviation: maxPriceDeviation,
              reason: 'priceOutliers',
              cat: 'graph'
            });
          }
        } catch {}
        return false; // 'priceOutliers'
      }
    }
  }

  return true;
}

/**
 * Create graph edges from a pool
 * 
 * SIMPLIFIED: Trust the pipeline price completely - NO rescaling, NO calibration
 * The pool's price should already be processed through the pipeline.
 */
export function edgesFromPoolIncremental(
  p: AmmPool | ClmmPool | CpmmPool,
  getUsd: (mint: string) => number | undefined,
  options?: EdgeBuildOptions,
): GraphEdge[] {
  const dex = String((p as any)?.dex || '');
  const id = String((p as any)?.id || '');
  const a = String((p as any)?.mint_a || '');
  const b = String((p as any)?.mint_b || '');
  const fee = Number((p as any)?.fee_bps || 0);
  const liq = liqDisplayFromPool(p);
  const w = weightFrom(liq, fee);
  let fwdRaw = Number((p as any)?.price_a_per_b);
  const clampMin = Number.isFinite(options?.priceClampMin) ? Number(options?.priceClampMin) : 1e-12;
  const clampMax = Number.isFinite(options?.priceClampMax) ? Number(options?.priceClampMax) : 1e12;
  
  const kind = (p as any)?.pool_kind || ((p as any)?.sqrt_price_x64_raw != null || typeof (p as any)?.sqrt_price_x64 === 'number' ? 'clmm' : 'amm');
  
  // If price_a_per_b is missing, try to derive from reserves (CPMM) or sqrt_price (CLMM)
  if (!Number.isFinite(fwdRaw) || fwdRaw <= 0) {
    if (kind === 'cpmm') {
      // CPMM: Price A-per-B = reserveB / reserveA (adjusted for decimals)
      // For constant product AMM: to get 1 unit of A, you pay (reserveB/reserveA) units of B
      // This is the same formula as Raydium AMM v4
      try {
        const reserveA = BigInt(String((p as any)?.reserve_a_raw || (p as any)?.native_reserve_a_raw || 0));
        const reserveB = BigInt(String((p as any)?.reserve_b_raw || (p as any)?.native_reserve_b_raw || 0));
        const decA = Number((p as any)?.decimals_a || (p as any)?.native_decimals_a || 9);
        const decB = Number((p as any)?.decimals_b || (p as any)?.native_decimals_b || 9);
        if (reserveA > 0n && reserveB > 0n) {
          // Price A-per-B = reserveB / reserveA * 10^(decA - decB)
          // atomic_ratio = reserveB / reserveA
          // decimal_adjustment = 10^(decA - decB) to convert atomic to whole units
          const atomicRatio = Number(reserveB) / Number(reserveA);
          const decimalAdjust = 10 ** (decA - decB);
          fwdRaw = atomicRatio * decimalAdjust;
        }
      } catch {}
    } else if (kind === 'clmm') {
      // CLMM: derive from sqrt_price_x64
      try {
        const s64 = BigInt(String((p as any)?.sqrt_price_x64 || (p as any)?.sqrt_price_x64_raw || 0));
        if (s64 > 0n) {
          const decA = Number((p as any)?.decimals_a || (p as any)?.native_decimals_a || 9);
          const decB = Number((p as any)?.decimals_b || (p as any)?.native_decimals_b || 9);
          // sqrt_price_x64 = sqrt(tokenB_atomic / tokenA_atomic) * 2^64
          // sqrt_price_x64^2 / 2^128 = tokenB_atomic / tokenA_atomic = price_a_per_b_atomic
          // price_a_per_b_whole = price_a_per_b_atomic * 10^(decA - decB)
          const two128 = BigInt(2) ** BigInt(128);
          const priceAperB_atomic = Number(s64 * s64) / Number(two128);
          const decimalAdjust = 10 ** (decA - decB);
          fwdRaw = priceAperB_atomic * decimalAdjust;
        }
      } catch {}
    }
  }
  
  // Trust the pipeline price directly - only clamp for safety
  const fwd = clampPriceInc(fwdRaw, clampMin, clampMax);
  const rev = fwd && fwd > 0 ? 1 / fwd : undefined;

  const wasSwapped = (p as any)?.was_swapped === true;
  const decA = (p as any)?.decimals_a ?? (p as any)?.native_decimals_a;
  const decB = (p as any)?.decimals_b ?? (p as any)?.native_decimals_b;
  const nativeDecA = (p as any)?.native_decimals_a ?? decA;
  const nativeDecB = (p as any)?.native_decimals_b ?? decB;
  const canonicalReserveA = parseReserveRaw((p as any)?.reserve_a_raw, decA);
  const canonicalReserveB = parseReserveRaw((p as any)?.reserve_b_raw, decB);
  const nativeReserveA = parseReserveRaw((p as any)?.native_reserve_a_raw, nativeDecA);
  const nativeReserveB = parseReserveRaw((p as any)?.native_reserve_b_raw, nativeDecB);
  let reserveA = 0;
  let reserveB = 0;
  let curveSource = '';

  if (canonicalReserveA > 0 && canonicalReserveB > 0) {
    reserveA = canonicalReserveA;
    reserveB = canonicalReserveB;
    curveSource = 'canonical_reserve';
  } else if (nativeReserveA > 0 && nativeReserveB > 0) {
    if (wasSwapped) {
      reserveA = nativeReserveB;
      reserveB = nativeReserveA;
      curveSource = 'native_reserve_swapped';
    } else {
      reserveA = nativeReserveA;
      reserveB = nativeReserveB;
      curveSource = 'native_reserve';
    }
  } else if (kind === 'clmm') {
    // ALWAYS use virtual (unbounded) reserves for the slippage curve.
    // Bounded reserves represent real token amounts in the active tick range,
    // but the constant-product AMM approximation used in the curve builder
    // only works with virtual reserves (which satisfy x*y = L^2).
    // Near tick boundaries, bounded reserves become extremely asymmetric
    // (one side near zero, the other large), causing the AMM formula to
    // produce multipliers >> 1.0 — wildly overestimating output.
    try {
      const s64 = BigInt(String((p as any)?.sqrt_price_x64 || (p as any)?.sqrt_price_x64_raw || 0));
      const Lraw = BigInt(String((p as any)?.liquidity_raw || (p as any)?.liquidity || 0));
      const virt = computeVirtualReservesFromClmm(s64, Lraw, Number(decA || 0), Number(decB || 0));
      if (virt) {
        reserveA = virt.reserveA;
        reserveB = virt.reserveB;
        curveSource = 'virtual_liquidity';
      }
    } catch {}
  } else if (kind === 'dlmm') {
    // Priority 1: active bin reserves from range cache (most accurate)
    const rangeData = getRangeData(id);
    if (rangeData?.kind === 'dlmm' && rangeData.reserveX > 0 && rangeData.reserveY > 0) {
      // Reserves are in native Meteora order (X = tokenX, Y = tokenY).
      // Swap to canonical order if the pool's token order was inverted.
      if (wasSwapped) {
        reserveA = rangeData.reserveY;
        reserveB = rangeData.reserveX;
        curveSource = 'active_bin_swapped';
      } else {
        reserveA = rangeData.reserveX;
        reserveB = rangeData.reserveY;
        curveSource = 'active_bin';
      }
    }
    // Priority 2: fallback to heuristic reserves
    if (reserveA === 0 || reserveB === 0) {
      const minLiquidity = Number((p as any)?.pool_liquidity_raw ?? (p as any)?.liquidity_display ?? 0);
      if (minLiquidity > 0 && fwd && fwd > 0) {
        const heur = computeHeuristicReservesFromMin(minLiquidity, fwd);
        if (heur) {
          reserveA = heur.reserveA;
          reserveB = heur.reserveB;
          curveSource = 'liquidity_min_heuristic';
        }
      }
    }
  }

  const feeMultiplier = 1 - Math.max(0, fee) / 10000;
  const spotRate = fwd && fwd > 0 ? (1 / fwd) * feeMultiplier : 0;
  // Priority chain: tick/bin simulation (high confidence) > reserve-based (low)
  const slippageCurve =
    buildSlippageCurveFromSimulation(kind, id, fee, spotRate, wasSwapped, p) ||
    buildSlippageCurveSource(kind, reserveA, reserveB, fee, spotRate, (p as any)?.updated_ms, curveSource || 'native_reserve');

  // ── For CLMM: compute bounded (active-range) reserves to replace vault reserves ──
  // Vault balances include liquidity across ALL tick ranges and vastly overstate the
  // tradeable depth. Using bounded reserves ensures arb-rs sees realistic slippage
  // when it falls back from curve to the AMM-blend formula.
  let boundedReserveARaw: string | undefined;
  let boundedReserveBRaw: string | undefined;
  if (kind === 'clmm') {
    try {
      const rangeData = getRangeData(id);
      if (rangeData?.kind === 'clmm' && rangeData.currentLiquidity > 0 && rangeData.sqrtPriceLower > 0 && rangeData.sqrtPriceUpper > rangeData.sqrtPriceLower) {
        const s64 = BigInt(String((p as any)?.sqrt_price_x64 || (p as any)?.sqrt_price_x64_raw || 0));
        const Lraw = BigInt(String((p as any)?.liquidity_raw || (p as any)?.liquidity || 0));
        const bounded = computeBoundedClmmReserves(
          s64, Lraw,
          Number(nativeDecA || 0), Number(nativeDecB || 0),
          rangeData.sqrtPriceLower, rangeData.sqrtPriceUpper,
        );
        if (bounded) {
          // bounded reserves are in NATIVE order (A = native_mint_a, B = native_mint_b).
          // Edge reserves are in CANONICAL order (_a = edge source, _b = edge target).
          if (wasSwapped) {
            boundedReserveARaw = String(bounded.reserveBRaw);
            boundedReserveBRaw = String(bounded.reserveARaw);
          } else {
            boundedReserveARaw = String(bounded.reserveARaw);
            boundedReserveBRaw = String(bounded.reserveBRaw);
          }
        }
      }
    } catch {}
  }

  // Validate pool went through pipeline
  const pipelineProcessed = (p as any)?._pipelineProcessed === true;
  if (!pipelineProcessed) {
    try {
      logger.warn('graph.edge.not_processed', {
        dex,
        pool_id: id.slice(0, 12),
        mint_a: a.slice(0, 8),
        mint_b: b.slice(0, 8),
        cat: 'graph'
      });
    } catch {}
  }

  // Capacity in source (edge input) token raw atoms for arb-rs sizing.
  // This is a physical constraint: the max the pool can accept, not a profitability limit.
  // The optimizer (slippage simulation + golden-section search) determines the profitable size.
  //   CLMM/DLMM: active-range capacity (max input before exhausting tick/bin range).
  //   AMM/CPMM:  full source reserve (the pool's actual on-chain balance).
  let capacity_input_raw: string | undefined;
  try {
    if (kind === 'clmm' || kind === 'dlmm') {
      capacity_input_raw = computeActiveRangeCapacityRaw(kind, id, p, wasSwapped);
    }
    // AMM/CPMM (or CLMM/DLMM without range data) → full source reserve as physical cap
    if (!capacity_input_raw) {
      const sourceReserveRaw = wasSwapped
        ? ((p as any)?.native_reserve_b_raw ?? (p as any)?.reserve_b_raw)
        : ((p as any)?.native_reserve_a_raw ?? (p as any)?.reserve_a_raw);
      if (sourceReserveRaw != null && String(sourceReserveRaw).trim() !== '') {
        const big = BigInt(String(sourceReserveRaw));
        if (big > 0n) capacity_input_raw = big.toString();
      }
      if (!capacity_input_raw && reserveA > 0) {
        const decSource = wasSwapped
          ? Number((p as any)?.native_decimals_b ?? (p as any)?.decimals_b ?? 9)
          : Number((p as any)?.native_decimals_a ?? (p as any)?.decimals_a ?? 9);
        if (Number.isFinite(decSource) && decSource >= 0 && decSource <= 18) {
          const scale = 10 ** Math.max(0, decSource);
          const capRaw = Math.floor(reserveA * scale);
          if (capRaw > 0) capacity_input_raw = String(capRaw);
        }
      }
    }
  } catch {
    // ignore
  }

  const forward: GraphEdge = {
    id: id || `${a}->${b}-${dex}`,
    source: a,
    target: b,
    dex,
    pool_id: id || `${a}->${b}-${dex}`,
    source_account: (p as any)?.account_a,
    target_account: (p as any)?.account_b,
    native_mint_a: (p as any)?.native_mint_a ?? a,
    native_mint_b: (p as any)?.native_mint_b ?? b,
    // When was_swapped, native fields are in the pool's on-chain order which is
    // inverted relative to the canonical edge direction (source→target).  Swap
    // reserves and decimals so _a always corresponds to the edge source token.
    // This is critical for arb-rs slippage simulation which assumes _a = input.
    native_decimals_a: wasSwapped
      ? ((p as any)?.native_decimals_b ?? (p as any)?.decimals_b)
      : ((p as any)?.native_decimals_a ?? (p as any)?.decimals_a),
    native_decimals_b: wasSwapped
      ? ((p as any)?.native_decimals_a ?? (p as any)?.decimals_a)
      : ((p as any)?.native_decimals_b ?? (p as any)?.decimals_b),
    native_account_a: (p as any)?.native_account_a ?? (p as any)?.account_a,
    native_account_b: (p as any)?.native_account_b ?? (p as any)?.account_b,
    native_reserve_a_raw: boundedReserveARaw ?? (wasSwapped
      ? ((p as any)?.native_reserve_b_raw ?? (p as any)?.reserve_b_raw)
      : ((p as any)?.native_reserve_a_raw ?? (p as any)?.reserve_a_raw)),
    native_reserve_b_raw: boundedReserveBRaw ?? (wasSwapped
      ? ((p as any)?.native_reserve_a_raw ?? (p as any)?.reserve_a_raw)
      : ((p as any)?.native_reserve_b_raw ?? (p as any)?.reserve_b_raw)),
    fee_bps: fee,
    source_price_usd: getUsd(a),
    target_price_usd: getUsd(b),
    liquidity: liq,
    liquidity_display: liq,
    weight: w,
    price_a_per_b: fwd,
    tvl_usd: (p as any)?.tvl_usd,
    pool_kind: kind as any,
    direction: 'canonical',
    pool_liquidity_raw: (p as any)?.pool_liquidity_raw,
    capacity_input_raw,
    was_swapped: (p as any)?.was_swapped, // Preserve swap state
    slippage_curve: slippageCurve,
  };
  return [forward];
}

export function edgeChangedSimple(a: GraphEdge, b: GraphEdge): boolean {
  if (a.id !== b.id) return true;
  const liqa = Number(a.liquidity_display ?? a.liquidity ?? 0);
  const liqb = Number(b.liquidity_display ?? b.liquidity ?? 0);
  const pxa = Number(a.price_a_per_b ?? 0);
  const pxb = Number(b.price_a_per_b ?? 0);
  const spa = Number(a.source_price_usd ?? 0);
  const spb = Number(b.source_price_usd ?? 0);
  const tpa = Number(a.target_price_usd ?? 0);
  const tpb = Number(b.target_price_usd ?? 0);
  const wa = Number(a.weight ?? 0);
  const wb = Number(b.weight ?? 0);
  const eps = 1e-8;
  if (Math.abs(liqa - liqb) > eps) return true;
  if (Math.abs(pxa - pxb) > eps) return true;
  if (Math.abs(spa - spb) > eps) return true;
  if (Math.abs(tpa - tpb) > eps) return true;
  if (Math.abs(wa - wb) > eps) return true;
  if (Number(a.fee_bps ?? -1) !== Number(b.fee_bps ?? -1)) return true;
  const sca = a.slippage_curve?.computed_at ?? 0;
  const scb = b.slippage_curve?.computed_at ?? 0;
  if (sca !== scb) return true;
  return false;
}

export function isDexKindAllowed(dex: string, kind: 'amm' | 'clmm' | 'dlmm' | 'cpmm', allow: EdgeAllow): boolean {
  const d = String(dex || '').toLowerCase();
  const k = String(kind || 'amm') as 'amm' | 'clmm' | 'dlmm' | 'cpmm';
  if (d.includes('raydium')) return (allow.raydium?.[k] !== false);
  if (d.includes('orca')) return (allow.orca?.[k] !== false);
  // Check MeteoraBalanced BEFORE plain Meteora (more specific first)
  // Support v1/v2 variants separately, with backward compatibility for old 'amm' field
  if (d.includes('meteorabalanced')) {
    // Check for version-specific variants first
    if (d.includes('_v1') || d.includes('-v1')) {
      // If old 'amm' field exists, use it; otherwise use v1 field
      if (allow.meteoraBalanced?.amm !== undefined) {
        return allow.meteoraBalanced.amm !== false;
      }
      return (allow.meteoraBalanced?.v1 !== false);
    }
    if (d.includes('_v2') || d.includes('-v2')) {
      // If old 'amm' field exists, use it; otherwise use v2 field
      if (allow.meteoraBalanced?.amm !== undefined) {
        return allow.meteoraBalanced.amm !== false;
      }
      return (allow.meteoraBalanced?.v2 !== false);
    }
    // Fallback: if no version specified, check old 'amm' field first (backward compatibility)
    if (allow.meteoraBalanced?.amm !== undefined) {
      return allow.meteoraBalanced.amm !== false;
    }
    // If old format not present, check both v1 and v2
    const v1Allowed = allow.meteoraBalanced?.v1 !== false;
    const v2Allowed = allow.meteoraBalanced?.v2 !== false;
    // If both are undefined, allow (default behavior)
    if (allow.meteoraBalanced?.v1 === undefined && allow.meteoraBalanced?.v2 === undefined) {
      return true;
    }
    // Otherwise, allow if at least one version is allowed
    return v1Allowed || v2Allowed;
  }
  if (d.includes('meteora')) {
    if (k === 'dlmm' && allow.meteora?.dlmm === undefined) {
      return allow.meteora?.clmm !== false;
    }
    return (allow.meteora?.[k] !== false);
  }
  if (d.includes('pumpswap')) return (allow.pumpswap?.[k] !== false);
  return true;
}


