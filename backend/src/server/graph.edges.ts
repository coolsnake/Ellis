import { computePriceForward, computePriceReverse } from './graph.pricing.js';
import type { GraphEdge } from './graph.types.js';
import type { AmmPool, ClmmPool } from './pools/types.js';
import { logger } from '../utils/logger.js';

export type EdgeAllow = {
  raydium?: { amm?: boolean; clmm?: boolean };
  orca?: { amm?: boolean; clmm?: boolean };
  meteora?: { amm?: boolean; clmm?: boolean };
};

const clampPriceInc = (px: number | undefined, min: number, max: number): number | undefined => {
  const v = Number(px);
  if (!Number.isFinite(v) || !(v > 0)) return undefined;
  return Math.min(max, Math.max(min, v));
};

export interface EdgeBuildOptions {
  priceClampMin?: number;
  priceClampMax?: number;
  decimalsMap?: Record<string, number>;
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

/**
 * Create graph edges from a pool
 * 
 * IMPORTANT: The pool's price should already be canonicalized (A-per-1-B for canonical mint order).
 * This function only applies magnitude calibration and decimal rescaling, not orientation changes.
 */
export function edgesFromPoolIncremental(
  p: AmmPool | ClmmPool,
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
  const fwdRaw = Number((p as any)?.price_a_per_b);
  const clampMin = Number.isFinite(options?.priceClampMin) ? Number(options?.priceClampMin) : 1e-12;
  const clampMax = Number.isFinite(options?.priceClampMax) ? Number(options?.priceClampMax) : 1e12;
  const fRaw = clampPriceInc(fwdRaw, clampMin, clampMax);
  
  // Get pool decimals
  const poolDecA = (p as any)?.decimals_a;
  const poolDecB = (p as any)?.decimals_b;
  
  // Get global decimals from map (fallback to pool decimals if not in map)
  const decimalsMap = options?.decimalsMap || {};
  const globalDecA = Number.isFinite(decimalsMap[a]) ? decimalsMap[a] : poolDecA;
  const globalDecB = Number.isFinite(decimalsMap[b]) ? decimalsMap[b] : poolDecB;
  
  // computePriceForward assumes price is already canonicalized - only applies magnitude calibration
  const fwd = computePriceForward(
    a,
    b,
    fRaw,
    poolDecA,
    poolDecB,
    globalDecA,
    globalDecB,
    getUsd,
    undefined,
  );
  
  // Calculate reverse edge with proper decimal rescaling
  const rev = computePriceReverse(
    a,
    b,
    fwd,
    fRaw,
    poolDecA,
    poolDecB,
    globalDecA,
    globalDecB,
    getUsd,
  );
  
  // DIAGNOSTIC: Log suspicious reverse edge prices
  if (rev && fwd && (rev > 100000 || (rev * fwd > 2) || (rev * fwd < 0.5))) {
    try {
      logger.warn('graph.edge.suspicious_reverse', {
        dex,
        pool_id: id.slice(0, 12),
        mint_a: a.slice(0, 8),
        mint_b: b.slice(0, 8),
        fwdRaw,
        fwd,
        rev,
        product: fwd && rev ? (fwd * rev).toFixed(6) : 'N/A',
        decimals_a: (p as any)?.decimals_a,
        decimals_b: (p as any)?.decimals_b,
        usd_a: getUsd(a),
        usd_b: getUsd(b),
        cat: 'graph'
      });
    } catch {}
  }
  
  const kind = (p as any)?.pool_kind || ((p as any)?.sqrt_price_x64_raw != null || typeof (p as any)?.sqrt_price_x64 === 'number' ? 'clmm' : 'amm');

  const forward: GraphEdge = {
    id: id || `${a}->${b}-${dex}`,
    source: a,
    target: b,
    dex,
    pool_id: id || undefined,
    source_account: (p as any)?.account_a,
    target_account: (p as any)?.account_b,
    fee_bps: fee,
    liquidity: liq,
    liquidity_display: liq,
    weight: w,
    price_a_per_b: fwd,
    tvl_usd: (p as any)?.tvl_usd,
    pool_kind: kind as any,
    direction: 'forward',
    pool_liquidity_raw: (p as any)?.pool_liquidity_raw,
  };
  const rid = id ? `${id}-rev` : '';
  const reverse: GraphEdge = {
    id: rid || `${b}->${a}-${dex}`,
    source: b,
    target: a,
    dex,
    pool_id: rid || undefined,
    source_account: (p as any)?.account_b,
    target_account: (p as any)?.account_a,
    fee_bps: fee,
    liquidity: liq,
    liquidity_display: liq,
    weight: w,
    price_a_per_b: rev,
    tvl_usd: (p as any)?.tvl_usd,
    pool_kind: kind as any,
    direction: 'reverse',
    pool_liquidity_raw: (p as any)?.pool_liquidity_raw,
  };
  return [forward, reverse];
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

export function isDexKindAllowed(dex: string, kind: 'amm' | 'clmm', allow: EdgeAllow): boolean {
  const d = String(dex || '').toLowerCase();
  const k = String(kind || 'amm') as 'amm' | 'clmm';
  if (d.includes('raydium')) return (allow.raydium?.[k] !== false);
  if (d.includes('orca')) return (allow.orca?.[k] !== false);
  if (d.includes('meteora')) return (allow.meteora?.[k] !== false);
  return true;
}


