import { canonicalOrientation, swapPoolFields } from './canonical.js';
import { logger } from '../../utils/logger.js';

/**
 * Centralized price canonicalization function
 * 
 * This ensures all prices are consistently oriented as A-per-1-B where A and B
 * are in canonical order (determined by canonicalOrientation).
 * 
 * Flow:
 * 1. Calculate raw price using DEX-specific formula (caller's responsibility)
 * 2. Check if mints need canonicalization
 * 3. If swap needed: swap mints and invert price
 * 4. Apply decimal rescaling if needed
 * 5. Return canonical price
 * 
 * @param mintA - Current mint A (may be pre-canonicalization)
 * @param mintB - Current mint B (may be pre-canonicalization)
 * @param rawPrice - Raw price calculated from DEX data (A-per-1-B for current mint order)
 * @param decimalsA - Decimals for mintA
 * @param decimalsB - Decimals for mintB
 * @returns Canonical price (A-per-1-B where A/B are in canonical order), or undefined if invalid
 */
export function canonicalizePrice(
  mintA: string,
  mintB: string,
  rawPrice: number | undefined,
  decimalsA?: number,
  decimalsB?: number,
): { canonicalMintA: string; canonicalMintB: string; canonicalPrice: number | undefined; wasSwapped: boolean } {
  const price = Number(rawPrice);
  
  // Invalid price
  if (!Number.isFinite(price) || price <= 0) {
    return {
      canonicalMintA: mintA,
      canonicalMintB: mintB,
      canonicalPrice: undefined,
      wasSwapped: false,
    };
  }

  // Check if orientation needs to be swapped
  const orientation = canonicalOrientation(mintA, mintB);
  const needsSwap = orientation === 'swap';

  if (needsSwap) {
    // Swap mints and invert price
    const canonicalPrice = 1 / price;
    return {
      canonicalMintA: mintB,
      canonicalMintB: mintA,
      canonicalPrice: Number.isFinite(canonicalPrice) && canonicalPrice > 0 ? canonicalPrice : undefined,
      wasSwapped: true,
    };
  }

  // No swap needed - price is already canonical
  return {
    canonicalMintA: mintA,
    canonicalMintB: mintB,
    canonicalPrice: price,
    wasSwapped: false,
  };
}

/**
 * Canonicalize a pool object's price and mints
 * This is a convenience wrapper that handles the full pool object
 */
export function canonicalizePoolPrice<T extends { mint_a: string; mint_b: string; price_a_per_b?: number; decimals_a?: number; decimals_b?: number }>(
  pool: T
): T {
  const orientation = canonicalOrientation(pool.mint_a, pool.mint_b);
  
  if (orientation === 'swap') {
    return swapPoolFields(pool);
  }
  
  return pool;
}

/**
 * Ensure price is correctly oriented for given mints (canonical or not)
 * This function assumes mints are already in canonical order and ensures price matches
 */
export function ensurePriceOrientation(
  mintA: string,
  mintB: string,
  price: number | undefined,
  expectedOrientation: 'canonical' | 'raw' = 'canonical',
): number | undefined {
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0) return undefined;

  if (expectedOrientation === 'canonical') {
    // Check if mints are in canonical order
    const orientation = canonicalOrientation(mintA, mintB);
    if (orientation === 'swap') {
      // Mints are not canonical, but we expect canonical price
      // This means price might be inverted - we can't fix it without knowing original mints
      // Log warning and return as-is (caller should have canonicalized before this)
      try {
        logger.warn('price.orientation.mismatch', {
          mintA,
          mintB,
          price: p,
          hint: 'Mints not in canonical order but expected canonical price - price may be inverted',
        });
      } catch {}
      return p;
    }
    // Mints are canonical, price should be correct
    return p;
  }

  // Raw orientation - return as-is
  return p;
}

