import type { GraphEdge } from './graph.types.js';
import type { AmmPool, ClmmPool, CpmmPool } from './pools/types.js';
import { logger } from '../utils/logger.js';
import { getCapacityCurve } from '../execution/capacity/curveCache.js';

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
    if (Number.isFinite(mult) && mult > 0) {
      mults.push(mult);
    } else {
      mults.push(0);
    }
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

function buildSlippageCurveUsd(poolId: string): GraphEdge['slippage_curve'] | undefined {
  try {
    const curve = getCapacityCurve(poolId);
    if (!curve || !curve.curve) return undefined;
    const entries = Array.from(curve.curve.entries())
      .filter(([size, mult]) => Number.isFinite(size) && size > 0 && Number.isFinite(mult))
      .sort((a, b) => a[0] - b[0]);
    if (entries.length === 0) return undefined;
    const sizes = entries.map(([size]) => size);
    const mults = entries.map(([, mult]) => mult);
    return {
      unit: 'usd',
      sizes,
      mults,
      computed_at: curve.computedAt,
      confidence: curve.confidence,
      source: 'capacity_curve',
    };
  } catch {
    return undefined;
  }
}

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

  const feeMultiplier = 1 - Math.max(0, fee) / 10000;
  const spotRate = fwd && fwd > 0 ? (1 / fwd) * feeMultiplier : 0;
  const slippageCurve =
    buildSlippageCurveSource(kind, reserveA, reserveB, fee, spotRate, (p as any)?.updated_ms, curveSource || 'native_reserve') ||
    buildSlippageCurveUsd(id);
  
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
    native_reserve_a_raw: wasSwapped
      ? ((p as any)?.native_reserve_b_raw ?? (p as any)?.reserve_b_raw)
      : ((p as any)?.native_reserve_a_raw ?? (p as any)?.reserve_a_raw),
    native_reserve_b_raw: wasSwapped
      ? ((p as any)?.native_reserve_a_raw ?? (p as any)?.reserve_a_raw)
      : ((p as any)?.native_reserve_b_raw ?? (p as any)?.reserve_b_raw),
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


