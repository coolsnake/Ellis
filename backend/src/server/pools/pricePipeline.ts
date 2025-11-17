/**
 * Centralized Pricing Pipeline - Single Source of Truth
 * 
 * All pool prices flow through this pipeline to ensure consistency.
 * 
 * ARCHITECTURE:
 * 1. DEX-specific normalizers extract raw data (handling varied field names)
 * 2. DEX-specific formulas calculate prices (sqrt, bin, reserves)
 * 3. Centralized pipeline processes prices (canonicalization, calibration)
 * 4. Graph builder uses processed prices for edges
 * 
 * FLOW:
 * Raw DEX Data → Field Mapping → Price Formula → Pipeline → Canonical Pool → Graph Edges
 */

import { canonicalOrientation, swapPoolFields } from './canonical.js';
import { logger } from '../../utils/logger.js';
import { calculateAmmPrice, calculateClmmPrice, calculateMeteoraPrice } from './priceFormulas.js';

/**
 * Raw price input from DEX-specific calculation
 * This represents the price in the DEX's native orientation
 */
export interface RawPriceInput {
  mintA: string;           // Mint A (in DEX's native order, pre-canonical)
  mintB: string;           // Mint B (in DEX's native order, pre-canonical)
  rawPrice?: number;       // Optional: Price A-per-B in whole token units, DEX's native orientation
  decimalsA: number;       // Decimals for mint A
  decimalsB: number;       // Decimals for mint B
  poolId?: string;         // Pool ID for diagnostics
  dex?: string;            // DEX name for diagnostics
  poolType?: 'amm' | 'clmm';

  // Add raw data fields for direct calculation inside pipeline
  sqrtPriceX64?: bigint | number;
  activeId?: number;
  binStep?: number;
  tokenXMint?: string; // For Meteora
  tokenYMint?: string; // For Meteora
  reserveA?: bigint | number;
  reserveB?: bigint | number;
}

/**
 * Processed price output in canonical orientation
 */
export interface ProcessedPrice {
  mintA: string;           // Mint A (canonical order)
  mintB: string;           // Mint B (canonical order)
  priceForward: number;    // Canonical A-per-B (calibrated & rescaled)
  priceReverse: number;    // Canonical B-per-A (inverted & rescaled)
  wasSwapped: boolean;     // True if orientation was changed
  decimalsA: number;       // Decimals for canonical mint A
  decimalsB: number;       // Decimals for canonical mint B
}

/**
 * Options for price processing
 */
export interface PriceProcessingOptions {
  getUsd?: (mint: string) => number | undefined;  // USD price lookup for calibration
  globalDecimals?: Record<string, number>;         // Global decimal map for rescaling
  skipMagnitudeCalibration?: boolean;              // Skip magnitude calibration (for testing)
  diagnostics?: boolean;                           // Enable diagnostic logging
}

/**
 * STEP 1: Canonicalize price orientation
 * 
 * Checks if mints need to be swapped according to quote hierarchy.
 * If swap is needed, inverts the price.
 * 
 * CRITICAL: This should happen BEFORE magnitude calibration
 */
function canonicalizeOrientation(input: RawPriceInput): {
  mintA: string;
  mintB: string;
  decimalsA: number;
  decimalsB: number;
  wasSwapped: boolean;
  price: number;
} {
  const orientation = canonicalOrientation(input.mintA, input.mintB);
  const needsSwap = orientation === 'swap';

  if (needsSwap) {
    // Swap mints and invert price
    const invertedPrice = input.rawPrice! > 0 ? 1 / input.rawPrice! : 0;
    
    return {
      mintA: input.mintB,
      mintB: input.mintA,
      price: invertedPrice,
      decimalsA: input.decimalsB,
      decimalsB: input.decimalsA,
      wasSwapped: true,
    };
  }

  return {
    mintA: input.mintA,
    mintB: input.mintB,
    price: input.rawPrice!,
    decimalsA: input.decimalsA,
    decimalsB: input.decimalsB,
    wasSwapped: false,
  };
}

/**
 * STEP 2: Apply magnitude calibration
 * (Moved from graph.pricing.ts)
 */
function calibrateMagnitude(
  mintA: string,
  mintB: string,
  price: number,
  getUsd?: (mint: string) => number | undefined
): number {
  if (typeof getUsd !== 'function' || !price || price <= 0) {
    return price;
  }

  try {
    const pa = getUsd(mintA);
    const pb = getUsd(mintB);
    if (pa && pb && pa > 0 && pb > 0) {
      const ref = pb / pa;
      const rawDev = Math.max(price / ref, ref / price);

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

      if (bestDev + 1e-12 < rawDev && bestDev <= MAX_APPLIED_DEV) {
        return best;
      }
    }
  } catch {}
  return price;
}


/**
 * CENTRALIZED PRICE PIPELINE
 * 
 * Processes a raw price through the complete pipeline:
 * 1. Canonicalize orientation (swap if needed)
 * 2. Apply magnitude calibration (fix power-of-10 errors)
 * 3. Rescale decimals (pool → global)
 * 4. Calculate reverse edge
 * 
 * @param input Raw price from DEX-specific calculation
 * @param options Processing options (USD lookup, global decimals)
 * @returns Processed price ready for graph edge creation
 */
export function processPriceThroughPipeline(
  input: RawPriceInput,
  options: PriceProcessingOptions = {}
): ProcessedPrice | undefined {
  // STEP 0: Calculate raw price from formula if not provided
  if (input.rawPrice == null || !Number.isFinite(input.rawPrice)) {
    if (input.dex === 'Meteora' && input.poolType === 'clmm' && input.activeId != null && input.binStep != null && input.tokenXMint && input.tokenYMint) {
      input.rawPrice = calculateMeteoraPrice(input.activeId, input.binStep, input.tokenXMint, input.tokenYMint, input.mintA, input.mintB, input.decimalsA, input.decimalsB);
    } else if (input.poolType === 'clmm' && input.sqrtPriceX64) {
      input.rawPrice = calculateClmmPrice(input.sqrtPriceX64, input.decimalsA, input.decimalsB, input.mintA, input.mintB, options.getUsd);
    } else if (input.poolType === 'amm' && input.reserveA != null && input.reserveB != null) {
      input.rawPrice = calculateAmmPrice(input.reserveA, input.reserveB, input.decimalsA, input.decimalsB);
    }
  }

  // Validate input
  if (!input.mintA || !input.mintB || input.mintA === input.mintB) {
    return undefined;
  }

  if (!Number.isFinite(input.rawPrice) || input.rawPrice <= 0) {
    return undefined;
  }

  if (!Number.isFinite(input.decimalsA) || !Number.isFinite(input.decimalsB)) {
    return undefined;
  }

  try {
    // STEP 1: Canonicalize orientation
    const canonical = canonicalizeOrientation(input);
    
    // STEP 2: Calibrate and rescale forward price
    const calibrated = calibrateMagnitude(canonical.mintA, canonical.mintB, canonical.price, options.getUsd);
    
    if (!calibrated || calibrated <= 0 || !Number.isFinite(calibrated)) {
      return undefined;
    }

    const forward = calibrated; // For clarity

    // STEP 3: Calculate reverse price
    const reverse = 1 / forward;
    
    // Diagnostic: Check if forward * reverse ≈ 1
    if (options.diagnostics) {
      const product = forward * reverse;
      if (Math.abs(product - 1) > 0.05) {
        try {
          logger.warn('price.pipeline.product_check', {
            dex: input.dex,
            pool_id: input.poolId?.slice(0, 12),
            mint_a: canonical.mintA.slice(0, 8),
            mint_b: canonical.mintB.slice(0, 8),
            forward,
            reverse,
            product,
            expected: 1,
            deviation_pct: ((product - 1) * 100).toFixed(2),
            was_swapped: canonical.wasSwapped,
            cat: 'price.pipeline'
          });
        } catch {}
      }
    }

    return {
      mintA: canonical.mintA,
      mintB: canonical.mintB,
      priceForward: forward,
      priceReverse: reverse,
      wasSwapped: canonical.wasSwapped,
      decimalsA: canonical.decimalsA,
      decimalsB: canonical.decimalsB,
    };
  } catch (error) {
    try {
      logger.error('price.pipeline.error', {
        error: String(error),
        dex: input.dex,
        pool_id: input.poolId?.slice(0, 12),
        cat: 'price.pipeline'
      });
    } catch {}
    return undefined;
  }
}

/**
 * Batch process multiple prices through the pipeline
 * Useful for normalizers that process many pools at once
 */
export function processPricesBatch(
  inputs: RawPriceInput[],
  options: PriceProcessingOptions = {}
): Map<string, ProcessedPrice> {
  const results = new Map<string, ProcessedPrice>();
  
  for (const input of inputs) {
    const processed = processPriceThroughPipeline(input, options);
    if (processed && input.poolId) {
      results.set(input.poolId, processed);
    }
  }
  
  return results;
}

/**
 * Validate processed price against USD reference
 * Returns deviation multiplier (1.0 = perfect match)
 */
export function validatePriceAgainstUSD(
  processed: ProcessedPrice,
  getUsd: (mint: string) => number | undefined
): { valid: boolean; deviation: number; details?: string } {
  const usdA = getUsd(processed.mintA);
  const usdB = getUsd(processed.mintB);
  
  if (!usdA || !usdB || usdA <= 0 || usdB <= 0) {
    return { valid: true, deviation: 1, details: 'No USD reference available' };
  }

  const expectedRatio = usdB / usdA;
  const deviation = Math.max(
    processed.priceForward / expectedRatio,
    expectedRatio / processed.priceForward
  );

  const valid = deviation <= 100; // Allow up to 100x deviation (might be stale USD prices)

  return {
    valid,
    deviation,
    details: valid 
      ? undefined 
      : `Price deviates ${deviation.toFixed(2)}x from USD reference`
  };
}

