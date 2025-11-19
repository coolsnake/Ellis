/**
 * DEX-Specific Price Calculation Formulas
 * 
 * These functions calculate prices using DEX-specific formulas WITHOUT
 * handling canonicalization or calibration. They just do the math.
 * 
 * Each function returns price in whole token units (not atomic/native units).
 */

import { sqrtPriceX64ToPriceRatio } from './precision.js';
import { logger } from '../../utils/logger.js';

/**
 * AMM Constant Product Formula
 * 
 * For constant product pools (x * y = k):
 * Price A-per-B = reserveA / reserveB (in whole token units)
 * 
 * @param reserveA Reserve of token A (in atomic units or whole, specify via isAtomic)
 * @param reserveB Reserve of token B (in atomic units or whole, specify via isAtomic)
 * @param decimalsA Decimals for token A
 * @param decimalsB Decimals for token B
 * @param isAtomic If true, reserves are in atomic units and need conversion
 * @returns Price A-per-B in whole token units
 */
export function calculateAmmPrice(
  reserveA: number | bigint,
  reserveB: number | bigint,
  decimalsA: number,
  decimalsB: number,
  isAtomic: boolean = true
): number | undefined {
  try {
    const resA = Number(reserveA);
    const resB = Number(reserveB);
    
    if (!Number.isFinite(resA) || !Number.isFinite(resB) || resB === 0) {
      return undefined;
    }

    if (isAtomic) {
      // Reserves are in atomic units, convert to whole units first
      // wholeA = atomicA / 10^decimalsA
      // wholeB = atomicB / 10^decimalsB
      // price = wholeA / wholeB = (atomicA / 10^decimalsA) / (atomicB / 10^decimalsB)
      //       = (atomicA / atomicB) * (10^decimalsB / 10^decimalsA)
      //       = (atomicA / atomicB) * 10^(decimalsB - decimalsA)
      const atomicRatio = resA / resB;
      const decimalAdjustment = Math.pow(10, decimalsB - decimalsA);
      return atomicRatio * decimalAdjustment;
    } else {
      // Reserves already in whole units
      return resA / resB;
    }
  } catch (error) {
    try {
      logger.warn('price.formula.amm.error', {
        error: String(error),
        reserveA: String(reserveA),
        reserveB: String(reserveB),
        cat: 'price.formula'
      });
    } catch {}
    return undefined;
  }
}

/**
 * CLMM sqrt_price_x64 Formula
 * 
 * For concentrated liquidity pools using Uniswap v3 style pricing:
 * - sqrt_price_x64 = sqrt(price) * 2^64
 * - Different DEXes encode this differently (some as B/A, some as A/B)
 * 
 * This function assumes the standard Uniswap v3 convention:
 * sqrt_price_x64 encodes sqrt(tokenB/tokenA) in atomic units
 * 
 * @param sqrtPriceX64 The sqrt price value (as bigint or number)
 * @param decimalsA Decimals for token A
 * @param decimalsB Decimals for token B
 * @param mintA Optional mint A (unused in simplified version)
 * @param mintB Optional mint B (unused in simplified version)
 * @returns Price A-per-B in whole token units
 */
export function calculateClmmPrice(
  sqrtPriceX64: bigint | number,
  decimalsA: number,
  decimalsB: number,
  mintA?: string,
  mintB?: string
): number | undefined {
  try {
    // Convert to bigint if needed
    let sqrtBig: bigint;
    if (typeof sqrtPriceX64 === 'bigint') {
      sqrtBig = sqrtPriceX64;
    } else if (typeof sqrtPriceX64 === 'number') {
      if (!Number.isFinite(sqrtPriceX64) || sqrtPriceX64 <= 0) {
        return undefined;
      }
      sqrtBig = BigInt(Math.floor(sqrtPriceX64));
    } else {
      return undefined;
    }

    if (sqrtBig <= 0n) {
      return undefined;
    }

    // Use high-precision calculation from precision.ts
    const ratio = sqrtPriceX64ToPriceRatio(sqrtBig, decimalsA, decimalsB);
    
    if (!ratio || !ratio.float || ratio.float <= 0 || !Number.isFinite(ratio.float)) {
      return undefined;
    }

    // Return the price directly - NO USD-based corrections
    return ratio.float;
  } catch (error) {
    try {
      logger.warn('price.formula.clmm.error', {
        error: String(error),
        sqrt_price_x64: String(sqrtPriceX64),
        decimalsA,
        decimalsB,
        cat: 'price.formula'
      });
    } catch {}
    return undefined;
  }
}

/**
 * Meteora DLMM Bin-Based Formula
 * 
 * For Meteora's Dynamic Liquidity Market Maker:
 * - Price is determined by active bin ID and bin step
 * - Formula: priceYperX = (1 + binStep/10000)^activeId
 * - tokenX and tokenY are Meteora's internal designations
 * 
 * This function handles the X/Y to A/B mapping and returns A-per-B.
 * 
 * @param activeId Active bin ID (can be negative)
 * @param binStep Bin step in basis points
 * @param tokenXMint Meteora's token X mint address
 * @param tokenYMint Meteora's token Y mint address
 * @param mintA Our token A (the mint we want as numerator)
 * @param mintB Our token B (the mint we want as denominator)
 * @param decimalsA Decimals for token A
 * @param decimalsB Decimals for token B
 * @returns Price A-per-B in whole token units
 */
export function calculateMeteoraPrice(
  activeId: number,
  binStep: number,
  tokenXMint: string,
  tokenYMint: string,
  mintA: string,
  mintB: string,
  decimalsA: number,
  decimalsB: number
): number | undefined {
  if (!Number.isFinite(activeId) || !Number.isFinite(binStep)) {
    return undefined;
  }

  if (!Number.isFinite(decimalsA) || !Number.isFinite(decimalsB)) {
    return undefined;
  }

  try {
    // Clamp activeId to prevent overflow
    const clampedActiveId = Math.max(-100000, Math.min(100000, activeId));
    const BASIS_POINT_MAX = 10000;
    const basePrice = 1 + (binStep / BASIS_POINT_MAX);
    
    // Use log-space to prevent overflow
    const logPrice = clampedActiveId * Math.log(basePrice);
    
    if (Math.abs(logPrice) >= 700) {
      // e^700 ≈ 1e304, unsafe to compute
      return undefined;
    }
    
    // This gives us Y per X in NATIVE (atomic) units
    const priceYperX_native = Math.exp(logPrice);
    
    // Now map X/Y to our A/B orientation
    let priceAperB_native: number | undefined;
    
    if (tokenXMint === mintA && tokenYMint === mintB) {
      // X = A, Y = B
      // priceYperX = B/A (native)
      // We want A/B (native) = 1 / (B/A) = 1 / priceYperX
      priceAperB_native = priceYperX_native > 0 ? (1 / priceYperX_native) : undefined;
    } else if (tokenXMint === mintB && tokenYMint === mintA) {
      // X = B, Y = A
      // priceYperX = A/B (native)
      // We want A/B (native) = priceYperX
      priceAperB_native = priceYperX_native;
    } else {
      // Mints don't match - this shouldn't happen
      try {
        logger.warn('price.formula.meteora.orientation_mismatch', {
          tokenXMint: tokenXMint.slice(0, 8),
          tokenYMint: tokenYMint.slice(0, 8),
          mintA: mintA.slice(0, 8),
          mintB: mintB.slice(0, 8),
          cat: 'price.formula'
        });
      } catch {}
      return undefined;
    }
    
    if (!priceAperB_native || priceAperB_native <= 0 || !Number.isFinite(priceAperB_native)) {
      return undefined;
    }
    
    // Convert from native (atomic) units to whole token units
    // priceAperB_whole = priceAperB_native * 10^(decimalsB - decimalsA)
    const decimalScale = Math.pow(10, decimalsB - decimalsA);
    const priceAperB_whole = priceAperB_native * decimalScale;
    
    if (!Number.isFinite(priceAperB_whole) || priceAperB_whole <= 0) {
      return undefined;
    }

    return priceAperB_whole;
  } catch (error) {
    try {
      logger.warn('price.formula.meteora.error', {
        error: String(error),
        activeId,
        binStep,
        cat: 'price.formula'
      });
    } catch {}
    return undefined;
  }
}

/**
 * Calculate price from reserves (generic AMM)
 * 
 * Helper that handles both BigInt and number reserves,
 * and automatically detects if conversion is needed.
 */
export function priceFromReserves(
  reserveA: bigint | number | string,
  reserveB: bigint | number | string,
  decimalsA: number,
  decimalsB: number
): number | undefined {
  try {
    // Try to parse as BigInt for high precision
    let resA: bigint;
    let resB: bigint;
    
    if (typeof reserveA === 'bigint') {
      resA = reserveA;
    } else if (typeof reserveA === 'string') {
      resA = BigInt(reserveA);
    } else {
      resA = BigInt(Math.floor(reserveA));
    }
    
    if (typeof reserveB === 'bigint') {
      resB = reserveB;
    } else if (typeof reserveB === 'string') {
      resB = BigInt(reserveB);
    } else {
      resB = BigInt(Math.floor(reserveB));
    }
    
    if (resB === 0n) {
      return undefined;
    }

    // Calculate in high precision using BigInt
    // price = (resA / resB) * 10^(decimalsB - decimalsA)
    const decimalDiff = decimalsB - decimalsA;
    const scale = BigInt(Math.pow(10, Math.abs(decimalDiff)));
    
    let price: number;
    if (decimalDiff >= 0) {
      // Multiply: price = (resA * scale) / resB
      const numerator = resA * scale;
      price = Number(numerator) / Number(resB);
    } else {
      // Divide: price = resA / (resB * scale)
      const denominator = resB * scale;
      price = Number(resA) / Number(denominator);
    }
    
    if (!Number.isFinite(price) || price <= 0) {
      return undefined;
    }
    
    return price;
  } catch (error) {
    // Fallback to number calculation
    return calculateAmmPrice(
      Number(reserveA),
      Number(reserveB),
      decimalsA,
      decimalsB,
      true
    );
  }
}

