/**
 * Meteora DLMM price calculation utilities
 * 
 * Meteora DLMM uses a bin-based pricing system:
 * - Formula: priceYperX_native = (1 + binStep/10000)^activeId
 * - This gives Y per X in native token units
 * - To convert to whole units: priceYperX_whole = priceYperX_native * 10^(decY - decX)
 */

/**
 * Calculate Meteora DLMM price from activeId and binStep
 * 
 * @param activeId - Active bin ID (can be negative)
 * @param binStep - Bin step in basis points (e.g., 10 = 0.1%)
 * @param tokenXMint - Token X mint address (from Meteora)
 * @param tokenYMint - Token Y mint address (from Meteora)
 * @param mintA - Our mint A (canonical)
 * @param mintB - Our mint B (canonical)
 * @param decA - Decimals for mint A
 * @param decB - Decimals for mint B
 * @returns Price A-per-1-B in whole token units, or undefined if calculation fails
 */
export function calculateMeteoraPrice(
  activeId: number,
  binStep: number,
  tokenXMint: string,
  tokenYMint: string,
  mintA: string,
  mintB: string,
  decA: number,
  decB: number,
): number | undefined {
  if (!Number.isFinite(activeId) || !Number.isFinite(binStep) || !Number.isFinite(decA) || !Number.isFinite(decB)) {
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
    
    const priceYperX_native = Math.exp(logPrice); // Y per X in native units
    
    // Determine which token is X and which is Y relative to our A/B
    let priceAperB_native: number | undefined;
    
    if (tokenXMint === mintA && tokenYMint === mintB) {
      // X = A, Y = B => priceYperX = B per A (native) => priceAperB = 1 / priceYperX (native)
      priceAperB_native = priceYperX_native > 0 ? (1 / priceYperX_native) : undefined;
    } else if (tokenXMint === mintB && tokenYMint === mintA) {
      // X = B, Y = A => priceYperX = A per B (native) => priceAperB = priceYperX (native)
      priceAperB_native = priceYperX_native;
    } else {
      // Unknown orientation - cannot determine
      return undefined;
    }
    
    if (!priceAperB_native || priceAperB_native <= 0 || !Number.isFinite(priceAperB_native)) {
      return undefined;
    }
    
    // Convert from native units to whole token units
    // priceAperB_whole = priceAperB_native * 10^(decA - decB)
    const decimalScale = Math.pow(10, decA - decB);
    const priceAperB_whole = priceAperB_native * decimalScale;
    
    if (priceAperB_whole > 0 && Number.isFinite(priceAperB_whole)) {
      return priceAperB_whole;
    }
    
    return undefined;
  } catch {
    return undefined;
  }
}

