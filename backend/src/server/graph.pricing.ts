import { CONFIG } from '../utils/config.js';

type GetUsd = (mint: string) => number | undefined;
type GetEdgeRate = (a: string, b: string) => number | undefined;

function clamp(px?: number): number | undefined {
  const min = Number.isFinite(Number(((CONFIG as any)?.sanity as any)?.priceClampMin)) ? Number(((CONFIG as any)?.sanity as any)?.priceClampMin) : 1e-12;
  const max = Number.isFinite(Number(((CONFIG as any)?.sanity as any)?.priceClampMax)) ? Number(((CONFIG as any)?.sanity as any)?.priceClampMax) : 1e12;
  const v = Number(px);
  if (!Number.isFinite(v) || !(v > 0)) return undefined;
  if (v < min || v > max) return undefined;
  return v;
}

function rescaleByDecimals(px: number | undefined, poolDecA?: number, poolDecB?: number, globalDecA?: number, globalDecB?: number): number | undefined {
  const p = Number(px);
  if (!Number.isFinite(p) || !(p > 0)) return px;
  const da = Number(poolDecA); const db = Number(poolDecB);
  const ga = Number(globalDecA); const gb = Number(globalDecB);
  if (![da, db, ga, gb].every((x) => Number.isFinite(x))) return px;
  const scalePow = (ga - da) - (gb - db);
  const scaled = p * Math.pow(10, scalePow);
  return (Number.isFinite(scaled) && scaled > 0) ? scaled : px;
}

/**
 * Compute final price with magnitude calibration and decimal rescaling
 * 
 * IMPORTANT: This function assumes the input price is already canonicalized
 * (i.e., mints are in canonical order and price is A-per-1-B for that order).
 * Orientation correction should be handled by canonicalization, not here.
 * 
 * This function handles:
 * - Magnitude calibration (power-of-10 adjustments to fix decimal mismatches)
 * - Decimal rescaling (pool decimals vs global decimals)
 * - Clamping to valid ranges
 * 
 * @param mintA - Mint A (should be canonical)
 * @param mintB - Mint B (should be canonical)
 * @param rawPrice - Price (should already be canonicalized: A-per-1-B)
 * @param poolDecA - Pool's decimals for A
 * @param poolDecB - Pool's decimals for B
 * @param globalDecA - Global decimals for A (for rescaling)
 * @param globalDecB - Global decimals for B (for rescaling)
 * @param getUsd - Optional USD price lookup for magnitude calibration
 * @param getEdgeRate - Optional edge rate lookup (unused, kept for compatibility)
 */
export function computePriceForward(
  mintA: string,
  mintB: string,
  rawPrice: number | undefined,
  poolDecA?: number,
  poolDecB?: number,
  globalDecA?: number,
  globalDecB?: number,
  getUsd?: GetUsd,
  getEdgeRate?: GetEdgeRate,
): number | undefined {
  const raw = Number(rawPrice);
  let price: number | undefined = (Number.isFinite(raw) && raw > 0) ? raw : undefined;

  // Magnitude calibration: fix power-of-10 errors using USD reference
  // This does NOT flip orientation - it only adjusts magnitude
  if (typeof getUsd === 'function' && price && price > 0) {
    try {
      const pa = getUsd(mintA);
      const pb = getUsd(mintB);
      if (pa && pb && (pa as number) > 0 && (pb as number) > 0) {
        const ref = (pb as number) / (pa as number);
        const rawDev = Math.max(price / ref, ref / price);
        
        // Try power-of-10 adjustments (magnitude only, no orientation flip)
        let best = price;
        let bestDev = rawDev;
        const MAX_APPLIED_DEV = 100;
        
        for (let k = -8; k <= 8; k++) {
          const cand = price * Math.pow(10, k);
          if (!(cand > 0) || !Number.isFinite(cand)) continue;
          const dev = Math.max(cand / ref, ref / cand);
          if (dev + 1e-12 < bestDev) {
            bestDev = dev;
            best = cand;
          }
        }
        
        // Only apply if significantly better and within reasonable bounds
        if (bestDev + 1e-12 < rawDev && bestDev <= MAX_APPLIED_DEV) {
          price = best;
        }
      }
    } catch {}
  }

  // Rescale by decimals when available (pool decimals vs global decimals)
  price = rescaleByDecimals(price, poolDecA, poolDecB, globalDecA, globalDecB);
  
  // Clamp to valid range
  return clamp(price);
}

/**
 * Calculate reverse edge price with proper decimal rescaling
 * 
 * When calculating reverse edges, we need to:
 * 1. Invert the canonical price (B-per-1-A = 1 / A-per-1-B)
 * 2. Apply decimal rescaling with swapped decimals (since mints are swapped)
 * 
 * This ensures that if forward price was rescaled by 10^k, reverse is rescaled by 10^(-k)
 * 
 * @param mintA - Original mint A (forward direction source)
 * @param mintB - Original mint B (forward direction target)
 * @param forwardPrice - Forward price (A-per-1-B, already processed)
 * @param rawPrice - Raw canonical price before processing (A-per-1-B)
 * @param poolDecA - Pool decimals for A
 * @param poolDecB - Pool decimals for B
 * @param globalDecA - Global decimals for A
 * @param globalDecB - Global decimals for B
 * @param getUsd - Optional USD price lookup
 */
export function computePriceReverse(
  mintA: string,
  mintB: string,
  forwardPrice: number | undefined,
  rawPrice: number | undefined,
  poolDecA?: number,
  poolDecB?: number,
  globalDecA?: number,
  globalDecB?: number,
  getUsd?: GetUsd,
): number | undefined {
  // If we don't have raw price, fall back to simple inversion (less accurate but better than nothing)
  if (!rawPrice || rawPrice <= 0) {
    return forwardPrice && forwardPrice > 0 ? clamp(1 / forwardPrice) : undefined;
  }
  
  // Calculate reverse with swapped mints and decimals
  const revRaw = 1 / rawPrice;
  return computePriceForward(
    mintB, // Swapped: B is now source
    mintA, // Swapped: A is now target
    revRaw,
    poolDecB, // Swapped decimals
    poolDecA, // Swapped decimals
    globalDecB, // Swapped global decimals
    globalDecA, // Swapped global decimals
    getUsd,
    undefined,
  );
}


