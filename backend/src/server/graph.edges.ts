import type { GraphEdge } from './graph.types.js';
import type { AmmPool, ClmmPool, CpmmPool } from './pools/types.js';
import { logger } from '../utils/logger.js';

export type EdgeAllow = {
  raydium?: { amm?: boolean; clmm?: boolean; cpmm?: boolean };
  orca?: { amm?: boolean; clmm?: boolean };
  meteora?: { amm?: boolean; clmm?: boolean };
  meteoraBalanced?: { amm?: boolean };
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
      if (kind === 'clmm') {
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
        const logLevel = (kind === 'clmm' || kind === 'cpmm') ? 'info' : 'debug';
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
      // CPMM: Price A-per-B = reserveA / reserveB (adjusted for decimals)
      // Same formula as AMM constant product
      try {
        const reserveA = BigInt(String((p as any)?.reserve_a_raw || (p as any)?.native_reserve_a_raw || 0));
        const reserveB = BigInt(String((p as any)?.reserve_b_raw || (p as any)?.native_reserve_b_raw || 0));
        const decA = Number((p as any)?.decimals_a || (p as any)?.native_decimals_a || 9);
        const decB = Number((p as any)?.decimals_b || (p as any)?.native_decimals_b || 9);
        if (reserveA > 0n && reserveB > 0n) {
          // Price A-per-B = (reserveA / 10^decA) / (reserveB / 10^decB)
          //               = (reserveA / reserveB) * 10^(decB - decA)
          const decimalAdjust = 10 ** (decB - decA);
          fwdRaw = (Number(reserveA) / Number(reserveB)) * decimalAdjust;
        }
      } catch {}
    } else if (kind === 'clmm') {
      // CLMM: derive from sqrt_price_x64
      try {
        const s64 = BigInt(String((p as any)?.sqrt_price_x64 || (p as any)?.sqrt_price_x64_raw || 0));
        if (s64 > 0n) {
          const decA = Number((p as any)?.decimals_a || (p as any)?.native_decimals_a || 9);
          const decB = Number((p as any)?.decimals_b || (p as any)?.native_decimals_b || 9);
          // sqrt_price_x64^2 / 2^128 = price_b_per_a (in raw units)
          // price_a_per_b = 1 / price_b_per_a (adjusted for decimals)
          const two128 = BigInt(2) ** BigInt(128);
          const sqPriceNum = Number(s64 * s64) / Number(two128);
          const decimalAdjust = 10 ** (decA - decB);
          fwdRaw = (1 / sqPriceNum) * decimalAdjust;
        }
      } catch {}
    }
  }
  
  // Trust the pipeline price directly - only clamp for safety
  const fwd = clampPriceInc(fwdRaw, clampMin, clampMax);
  const rev = fwd && fwd > 0 ? 1 / fwd : undefined;
  
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
    native_decimals_a: (p as any)?.native_decimals_a ?? (p as any)?.decimals_a,
    native_decimals_b: (p as any)?.native_decimals_b ?? (p as any)?.decimals_b,
    native_account_a: (p as any)?.native_account_a ?? (p as any)?.account_a,
    native_account_b: (p as any)?.native_account_b ?? (p as any)?.account_b,
    native_reserve_a_raw: (p as any)?.native_reserve_a_raw ?? (p as any)?.reserve_a_raw,
    native_reserve_b_raw: (p as any)?.native_reserve_b_raw ?? (p as any)?.reserve_b_raw,
    fee_bps: fee,
    liquidity: liq,
    liquidity_display: liq,
    weight: w,
    price_a_per_b: fwd,
    tvl_usd: (p as any)?.tvl_usd,
    pool_kind: kind as any,
    direction: 'canonical',
    pool_liquidity_raw: (p as any)?.pool_liquidity_raw,
    was_swapped: (p as any)?.was_swapped, // Preserve swap state
  };
  return [forward];
}

export function edgeChangedSimple(a: GraphEdge, b: GraphEdge): boolean {
  if (a.id !== b.id) return true;
  const liqa = Number(a.liquidity_display ?? a.liquidity ?? 0);
  const liqb = Number(b.liquidity_display ?? b.liquidity ?? 0);
  const pxa = Number(a.price_a_per_b ?? 0);
  const pxb = Number(b.price_a_per_b ?? 0);
  const wa = Number(a.weight ?? 0);
  const wb = Number(b.weight ?? 0);
  const eps = 1e-8;
  if (Math.abs(liqa - liqb) > eps) return true;
  if (Math.abs(pxa - pxb) > eps) return true;
  if (Math.abs(wa - wb) > eps) return true;
  if (Number(a.fee_bps ?? -1) !== Number(b.fee_bps ?? -1)) return true;
  return false;
}

export function isDexKindAllowed(dex: string, kind: 'amm' | 'clmm' | 'cpmm', allow: EdgeAllow): boolean {
  const d = String(dex || '').toLowerCase();
  const k = String(kind || 'amm') as 'amm' | 'clmm' | 'cpmm';
  if (d.includes('raydium')) return (allow.raydium?.[k] !== false);
  if (d.includes('orca')) return (allow.orca?.[k] !== false);
  // Check MeteoraBalanced BEFORE plain Meteora (more specific first)
  if (d.includes('meteorabalanced')) return (allow.meteoraBalanced?.[k] !== false);
  if (d.includes('meteora')) return (allow.meteora?.[k] !== false);
  if (d.includes('pumpswap')) return (allow.pumpswap?.[k] !== false);
  return true;
}


